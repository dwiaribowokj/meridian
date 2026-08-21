import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  createCircuitBreakerController,
  createCircuitBreakerState,
} from "../circuit-breaker.js";
import {
  createConfiguredBreakerRuntime,
  createFileCircuitBreakerStorage,
  resolveCircuitBreakerRuntimeDirectory,
} from "../breaker-runtime.js";
import {
  acquireSecureFileLock,
  atomicReplaceSecureFile,
  durableContentDigest,
  durabilityUncertaintyMarkerPath,
  releaseSecureFileLock,
} from "../durable-file.js";
import { classifyRelayDeployResult } from "../tools/relay-deploy-result.js";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-runtime-integrity-"));
const breakerFile = path.join(tempDir, "circuit-breaker.json");
const NOW = Date.parse("2026-07-22T00:00:00.000Z");

function shortWriteFs(maximumBytes = 4) {
  return Object.assign(Object.create(fs), {
    writeSync(descriptor, buffer, offset, length, position) {
      return fs.writeSync(descriptor, buffer, offset, Math.min(length, maximumBytes), position);
    },
  });
}

function failStateFsyncOnceFs(stateFile) {
  const stateDescriptors = new Set();
  let failed = false;
  const basename = path.basename(stateFile);
  return Object.assign(Object.create(fs), {
    openSync(candidate, ...args) {
      const descriptor = fs.openSync(candidate, ...args);
      if (String(candidate) === stateFile || String(candidate).endsWith(`/${basename}`)) {
        stateDescriptors.add(descriptor);
      }
      return descriptor;
    },
    closeSync(descriptor) {
      stateDescriptors.delete(descriptor);
      return fs.closeSync(descriptor);
    },
    fsyncSync(descriptor) {
      if (!failed && stateDescriptors.has(descriptor)) {
        failed = true;
        const error = new Error("injected breaker state fsync failure");
        error.code = "EIO";
        throw error;
      }
      return fs.fsyncSync(descriptor);
    },
  });
}

function failPostCommitLockCleanupFsyncFs(stateFile) {
  const lockName = `.${path.basename(stateFile)}.update.lock`;
  let lockUnlinked = false;
  return Object.assign(Object.create(fs), {
    unlinkSync(candidate, ...args) {
      const result = fs.unlinkSync(candidate, ...args);
      if (String(candidate) === lockName || String(candidate).endsWith(`/${lockName}`)) {
        lockUnlinked = true;
      }
      return result;
    },
    fsyncSync(descriptor) {
      if (lockUnlinked) {
        const error = new Error("injected persistent post-commit lock cleanup fsync failure");
        error.code = "EIO";
        throw error;
      }
      return fs.fsyncSync(descriptor);
    },
  });
}

function failPostCommitLockIntegrityFs(stateFile) {
  const lockName = `.${path.basename(stateFile)}.update.lock`;
  const lockDescriptors = new Set();
  const lockFstats = new Map();
  return Object.assign(Object.create(fs), {
    openSync(candidate, ...args) {
      const descriptor = fs.openSync(candidate, ...args);
      if (String(candidate) === lockName || String(candidate).endsWith(`/${lockName}`)) {
        lockDescriptors.add(descriptor);
      }
      return descriptor;
    },
    fstatSync(descriptor) {
      if (lockDescriptors.has(descriptor)) {
        const count = (lockFstats.get(descriptor) ?? 0) + 1;
        lockFstats.set(descriptor, count);
        // acquire verifies twice; the release integrity check is third.
        if (count >= 3) {
          const error = new Error("injected post-commit lock integrity failure");
          error.code = "EIO";
          throw error;
        }
      }
      return fs.fstatSync(descriptor);
    },
  });
}

function failPostCommitLockCloseFs(stateFile) {
  const lockName = `.${path.basename(stateFile)}.update.lock`;
  const lockDescriptors = new Set();
  return Object.assign(Object.create(fs), {
    openSync(candidate, ...args) {
      const descriptor = fs.openSync(candidate, ...args);
      if (String(candidate) === lockName || String(candidate).endsWith(`/${lockName}`)) {
        lockDescriptors.add(descriptor);
      }
      return descriptor;
    },
    closeSync(descriptor) {
      if (lockDescriptors.has(descriptor)) {
        const error = new Error("injected post-commit lock close failure");
        error.code = "EIO";
        throw error;
      }
      return fs.closeSync(descriptor);
    },
  });
}

function failPostCommitLockUnlinkFs(stateFile) {
  const lockName = `.${path.basename(stateFile)}.update.lock`;
  return Object.assign(Object.create(fs), {
    unlinkSync(candidate, ...args) {
      if (String(candidate) === lockName || String(candidate).endsWith(`/${lockName}`)) {
        const error = new Error("injected post-commit retained lock unlink failure");
        error.code = "EIO";
        throw error;
      }
      return fs.unlinkSync(candidate, ...args);
    },
  });
}

function withUnexpectedOwner(fsImpl, target) {
  const identity = fs.statSync(target);
  return Object.assign(Object.create(fsImpl), {
    fstatSync(descriptor) {
      const stat = fsImpl.fstatSync(descriptor);
      if (stat.dev === identity.dev && stat.ino === identity.ino) {
        const forged = Object.create(Object.getPrototypeOf(stat));
        Object.assign(forged, stat, { uid: process.geteuid() + 1 });
        return forged;
      }
      return stat;
    },
  });
}

function writeCommittedState(file, value) {
  return writeCommittedBytes(file, Buffer.from(JSON.stringify(value)));
}

function writeCommittedBytes(file, bytes) {
  fs.writeFileSync(file, bytes, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  const marker = durabilityUncertaintyMarkerPath(file);
  fs.writeFileSync(marker, JSON.stringify({
    version: 1,
    phase: "committed",
    stateDigest: durableContentDigest(bytes),
  }), { mode: 0o600 });
  fs.chmodSync(marker, 0o600);
}

function currentProcessStartToken() {
  const stat = fs.readFileSync(`/proc/${process.pid}/stat`, "utf8");
  const close = stat.lastIndexOf(")");
  const fields = close === -1 ? [] : stat.slice(close + 2).trim().split(/\s+/);
  assert.match(fields[19] || "", /^\d+$/, "test host must provide the process start token used by lock provenance");
  return fields[19];
}

function procStatWithStartToken(token) {
  return `1 (meridian) S ${Array.from({ length: 18 }, () => "0").join(" ")} ${token}`;
}

function retainedLockRecord(file, {
  ownerPid = process.pid,
  ownerStartToken = currentProcessStartToken(),
  nonce = "d".repeat(64),
} = {}) {
  return {
    version: 1,
    type: "meridian-secure-file-lock",
    resourceDigest: durableContentDigest(file),
    ownerPid,
    ownerStartToken,
    nonce,
    operation: "update",
  };
}

function writeRetainedLock(file, record = retainedLockRecord(file)) {
  const lockPath = path.join(path.dirname(file), `.${path.basename(file)}.update.lock`);
  fs.writeFileSync(lockPath, JSON.stringify(record), { mode: 0o600 });
  fs.chmodSync(lockPath, 0o600);
  return lockPath;
}

function withProcessOwnerRead(pid, readOwner) {
  return Object.assign(Object.create(fs), {
    readFileSync(candidate, ...args) {
      if (String(candidate) === `/proc/${pid}/stat`) return readOwner();
      return fs.readFileSync(candidate, ...args);
    },
  });
}

function authorizedRepairStorage(file, fsImpl = fs) {
  return createFileCircuitBreakerStorage({
    file,
    fsImpl,
    lockTimeoutMs: 0,
    repairAuthorizer: ({ authorization, operation }) => (
      authorization === "local-operator-capability" && operation === "repair_durability_uncertainty"
    ),
  });
}

function runConcurrentBreakerWriter(file, eventId, atMs) {
  const moduleUrl = pathToFileURL(path.resolve("breaker-runtime.js")).href;
  const source = [
    `import { createConfiguredBreakerRuntime, createFileCircuitBreakerStorage } from ${JSON.stringify(moduleUrl)};`,
    `const runtime = createConfiguredBreakerRuntime({ storage: createFileCircuitBreakerStorage({ file: ${JSON.stringify(file)} }), circuitBreaker: { enabled: true, consecutiveOperationalFailures: 2 }, now: () => ${atMs} });`,
    `await runtime.record({ type: "operation_failure", operation: "swap", eventId: ${JSON.stringify(eventId)}, atMs: ${atMs} });`,
  ].join("\n");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", source], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`concurrent breaker writer exited ${code}: ${stderr}`));
    });
  });
}

function runRetainedLockWriter(file, atMs) {
  const moduleUrl = pathToFileURL(path.resolve("breaker-runtime.js")).href;
  const controllerUrl = pathToFileURL(path.resolve("circuit-breaker.js")).href;
  const source = [
    `import assert from "node:assert/strict";`,
    `import fs from "node:fs";`,
    `import path from "node:path";`,
    `import { createCircuitBreakerController } from ${JSON.stringify(controllerUrl)};`,
    `import { createFileCircuitBreakerStorage } from ${JSON.stringify(moduleUrl)};`,
    `const file = ${JSON.stringify(file)};`,
    `const seed = createCircuitBreakerController({ storage: createFileCircuitBreakerStorage({ file }), now: () => ${atMs} });`,
    `await seed.record({ type: "basis_invalid", atMs: ${atMs} });`,
    `const lockName = \`.\${path.basename(file)}.update.lock\`;`,
    `const retainedLockFs = Object.assign(Object.create(fs), { unlinkSync(candidate, ...args) { if (String(candidate).endsWith(\`/\${lockName}\`)) { const error = new Error("injected retained lock unlink failure"); error.code = "EIO"; throw error; } return fs.unlinkSync(candidate, ...args); } });`,
    `const failedResume = createCircuitBreakerController({ storage: createFileCircuitBreakerStorage({ file, fsImpl: retainedLockFs }), now: () => ${atMs + 1} });`,
    `await assert.rejects(() => failedResume.manualResume(${atMs + 1}), /retained lock unlink failure/);`,
    `assert.equal(fs.existsSync(path.join(path.dirname(file), lockName)), true);`,
  ].join("\n");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", source], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`retained lock writer exited ${code}: ${stderr}`));
    });
  });
}

function runRelativeRuntimeDirectoryFixture() {
  const moduleUrl = pathToFileURL(path.resolve("breaker-runtime.js")).href;
  const source = [
    `import assert from "node:assert/strict";`,
    `await assert.rejects(import(${JSON.stringify(moduleUrl)}), /must be an absolute private runtime directory/i);`,
  ].join("\n");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", source], {
      env: { ...process.env, MERIDIAN_BREAKER_RUNTIME_DIR: "." },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`relative runtime directory fixture exited ${code}: ${stderr}`));
    });
  });
}

function runDefaultOperatorRepairFixture(runtimeDirectory) {
  const moduleUrl = pathToFileURL(path.resolve("breaker-runtime.js")).href;
  const source = [
    `import assert from "node:assert/strict";`,
    `import fs from "node:fs";`,
    `import path from "node:path";`,
    `import { CIRCUIT_BREAKER_DURABILITY_REPAIR_CONFIRMATION, registerCircuitBreakerRepairOperatorCapability, repairCircuitBreakerDurability } from ${JSON.stringify(moduleUrl)};`,
    `const capability = Object.freeze({});`,
    `registerCircuitBreakerRepairOperatorCapability(capability);`,
    `await assert.rejects(() => repairCircuitBreakerDurability({ confirmation: CIRCUIT_BREAKER_DURABILITY_REPAIR_CONFIRMATION, operatorCapability: Object.freeze({}), atMs: 1 }), /not authorized/i);`,
    `const first = await repairCircuitBreakerDurability({ confirmation: CIRCUIT_BREAKER_DURABILITY_REPAIR_CONFIRMATION, operatorCapability: capability, atMs: 1 });`,
    `const file = path.join(${JSON.stringify(runtimeDirectory)}, "circuit-breaker.json");`,
    `const bytes = fs.readFileSync(file);`,
    `const second = await repairCircuitBreakerDurability({ confirmation: CIRCUIT_BREAKER_DURABILITY_REPAIR_CONFIRMATION, operatorCapability: capability, atMs: 2 });`,
    `assert.equal(first.tripped, true);`,
    `assert.equal(first.manualResumeRequired, true);`,
    `assert.deepEqual(second, first);`,
    `assert.deepEqual(fs.readFileSync(file), bytes);`,
  ].join("\n");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", source], {
      env: { ...process.env, MERIDIAN_BREAKER_RUNTIME_DIR: runtimeDirectory },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`default operator repair fixture exited ${code}: ${stderr}`));
    });
  });
}

try {
  await runDefaultOperatorRepairFixture(path.join(tempDir, "default-operator-runtime"));
  assert.throws(() => resolveCircuitBreakerRuntimeDirectory("."), /must be an absolute private runtime directory/i);
  await runRelativeRuntimeDirectoryFixture();

  // Only an absent file initializes a fresh state. The initial read does not
  // write anything, so this test never touches a production breaker file.
  const missing = createCircuitBreakerController({
    storage: createFileCircuitBreakerStorage({ file: breakerFile }),
    now: () => NOW,
  });
  assert.equal(await missing.entryAllowed(), true);
  assert.equal(fs.existsSync(breakerFile), false);

  // Existing state without a committed marker is never accepted after the
  // durable protocol is introduced. Initial absence remains distinct.
  const unmarkedState = createCircuitBreakerState(NOW);
  fs.writeFileSync(breakerFile, JSON.stringify(unmarkedState), { mode: 0o600 });
  fs.chmodSync(breakerFile, 0o600);
  const missingMarker = createCircuitBreakerController({
    storage: createFileCircuitBreakerStorage({ file: breakerFile }),
    now: () => NOW,
  });
  await assert.rejects(() => missingMarker.entryAllowed(), /missing its committed durability marker/i);

  // Invalid JSON and a valid-JSON non-object both reject entry. Neither path
  // may normalize to an untripped state or enable manual resume implicitly.
  fs.rmSync(breakerFile, { force: true });
  writeCommittedBytes(breakerFile, Buffer.from("{ not json"));
  const unreadable = createCircuitBreakerController({
    storage: createFileCircuitBreakerStorage({ file: breakerFile }),
    now: () => NOW,
  });
  await assert.rejects(() => unreadable.entryAllowed(), /unreadable or corrupt/i);

  writeCommittedState(breakerFile, []);
  const nonObject = createCircuitBreakerController({
    storage: createFileCircuitBreakerStorage({ file: breakerFile }),
    now: () => NOW,
  });
  await assert.rejects(() => nonObject.entryAllowed(), /persisted state is corrupt/i);
  await assert.rejects(() => nonObject.manualResume(), /persisted state is corrupt/i);

  // A valid latch remains blocked until the explicit manual-resume action.
  fs.rmSync(breakerFile, { force: true });
  fs.rmSync(durabilityUncertaintyMarkerPath(breakerFile), { force: true });
  const initialLatchStorage = createFileCircuitBreakerStorage({ file: breakerFile });
  const initialLatchWriter = createCircuitBreakerController({ storage: initialLatchStorage, now: () => NOW });
  await initialLatchWriter.record({ type: "basis_invalid", atMs: NOW });
  const latched = createCircuitBreakerController({
    storage: createFileCircuitBreakerStorage({ file: breakerFile }),
    now: () => NOW + 1,
  });
  assert.equal(await latched.entryAllowed(), false);
  await latched.manualResume(NOW + 1);
  assert.equal(await latched.entryAllowed(), true);

  // File-backed breaker input is descriptor-safe: neither a direct symlink
  // nor a hardlinked state file can be treated as a valid persisted latch.
  const hostileState = path.join(tempDir, "hostile-breaker-state.json");
  fs.writeFileSync(hostileState, JSON.stringify(createCircuitBreakerState(NOW)));
  const symlinkState = path.join(tempDir, "symlink-breaker-state.json");
  fs.symlinkSync(hostileState, symlinkState);
  const symlinked = createCircuitBreakerController({
    storage: createFileCircuitBreakerStorage({ file: symlinkState }),
    now: () => NOW,
  });
  await assert.rejects(() => symlinked.entryAllowed(), /unreadable/i);
  const hardlinkedState = path.join(tempDir, "hardlinked-breaker-state.json");
  fs.linkSync(hostileState, hardlinkedState);
  const hardlinked = createCircuitBreakerController({
    storage: createFileCircuitBreakerStorage({ file: hardlinkedState }),
    now: () => NOW,
  });
  await assert.rejects(() => hardlinked.entryAllowed(), /unreadable/i);

  // The full-write loop survives a deliberately short write adapter.  A
  // restart reads the complete, durably replaced latch rather than a partial
  // JSON object.  A hostile legacy fixed `.tmp` name is never followed.
  const shortWriteFile = path.join(tempDir, "short-write-breaker.json");
  const shortWrite = createCircuitBreakerController({
    storage: createFileCircuitBreakerStorage({ file: shortWriteFile, fsImpl: shortWriteFs() }),
    now: () => NOW,
  });
  await shortWrite.record({ type: "basis_invalid", atMs: NOW });
  const legacyTmpTarget = path.join(tempDir, "legacy-tmp-target");
  fs.writeFileSync(legacyTmpTarget, "do-not-touch");
  fs.symlinkSync(legacyTmpTarget, `${shortWriteFile}.tmp`);
  await shortWrite.manualResume(NOW + 1);
  assert.equal(fs.readFileSync(legacyTmpTarget, "utf8"), "do-not-touch");
  const restartedShortWrite = createCircuitBreakerController({
    storage: createFileCircuitBreakerStorage({ file: shortWriteFile }),
    now: () => NOW + 2,
  });
  assert.equal(await restartedShortWrite.entryAllowed(), true);

  // A failed state fsync after a manual-resume rewrite previously left valid
  // untripped JSON behind. The durable poison marker now blocks both the
  // current controller and a restart. Repair must be separately authorized
  // and publish a fresh fail-closed latch rather than resuming this state.
  const poisonedFile = path.join(tempDir, "poisoned-breaker.json");
  const seeded = createCircuitBreakerController({
    storage: createFileCircuitBreakerStorage({ file: poisonedFile }),
    now: () => NOW + 3,
  });
  await seeded.manualResume(NOW + 3);
  const failingResume = createCircuitBreakerController({
    storage: createFileCircuitBreakerStorage({
      file: poisonedFile,
      fsImpl: failStateFsyncOnceFs(poisonedFile),
    }),
    now: () => NOW + 4,
  });
  await assert.rejects(() => failingResume.manualResume(NOW + 4), /injected breaker state fsync failure/i);
  assert.equal(JSON.parse(fs.readFileSync(poisonedFile, "utf8")).tripped, false,
    "the regression fixture leaves valid, permissive-looking JSON bytes");
  const poisonMarker = durabilityUncertaintyMarkerPath(poisonedFile);
  assert.equal(fs.existsSync(poisonMarker), true, "failed state durability leaves a persistent poison marker");
  await assert.rejects(() => failingResume.entryAllowed(), /durability-uncertainty marker/i);
  const restartedPoisoned = createCircuitBreakerController({
    storage: createFileCircuitBreakerStorage({ file: poisonedFile }),
    now: () => NOW + 5,
  });
  await assert.rejects(() => restartedPoisoned.entryAllowed(), /durability-uncertainty marker/i);
  await assert.rejects(() => restartedPoisoned.manualResume(NOW + 5), /durability-uncertainty marker/i);

  const unauthorizedRepairStorage = createFileCircuitBreakerStorage({ file: poisonedFile });
  await assert.rejects(
    () => unauthorizedRepairStorage.repairDurabilityUncertainty("meridian:risk-circuit-breaker"),
    /not authorized/i,
  );
  let repairAuthorizationCalls = 0;
  const poisonedRepairStorage = createFileCircuitBreakerStorage({
    file: poisonedFile,
    repairAuthorizer: ({ authorization, operation }) => {
      repairAuthorizationCalls += 1;
      return authorization === "local-operator-capability" && operation === "repair_durability_uncertainty";
    },
  });
  await assert.rejects(
    () => poisonedRepairStorage.repairDurabilityUncertainty("meridian:risk-circuit-breaker", {
      authorization: "wrong-capability",
      atMs: NOW + 5,
    }),
    /not authorized/i,
  );
  const repaired = await poisonedRepairStorage.repairDurabilityUncertainty("meridian:risk-circuit-breaker", {
    authorization: "local-operator-capability",
    atMs: NOW + 5,
  });
  assert.equal(repairAuthorizationCalls, 2);
  assert.equal(repaired.tripped, true);
  assert.equal(repaired.manualResumeRequired, true);
  assert.deepEqual(repaired.reasons, ["DURABILITY_UNCERTAINTY_REPAIRED"]);
  const repairedBytes = fs.readFileSync(poisonedFile);
  const repeatedRepair = await poisonedRepairStorage.repairDurabilityUncertainty("meridian:risk-circuit-breaker", {
    authorization: "local-operator-capability",
    atMs: NOW + 999,
  });
  assert.deepEqual(repeatedRepair, repaired, "repeated repair must preserve the original repaired latch");
  assert.deepEqual(fs.readFileSync(poisonedFile), repairedBytes, "repeated repair must be byte-idempotent");
  const repairedController = createCircuitBreakerController({
    storage: createFileCircuitBreakerStorage({ file: poisonedFile }),
    now: () => NOW + 5,
  });
  assert.equal(await repairedController.entryAllowed(), false, "repair must not reopen entry");
  await repairedController.manualResume(NOW + 5);
  assert.equal(await repairedController.entryAllowed(), true, "resume remains a separate explicit action");

  // An authorized repair may safely replace missing or corrupt marker evidence,
  // but always publishes the same tripped/manual-resume latch first.
  for (const markerFailure of ["missing", "corrupt", "mismatched"]) {
    const repairFile = path.join(tempDir, `${markerFailure}-marker-repair-breaker.json`);
    const seed = createCircuitBreakerController({
      storage: createFileCircuitBreakerStorage({ file: repairFile }),
      now: () => NOW + 6,
    });
    await seed.record({ type: "basis_invalid", atMs: NOW + 6 });
    const marker = durabilityUncertaintyMarkerPath(repairFile);
    if (markerFailure === "missing") fs.rmSync(marker);
    else if (markerFailure === "corrupt") {
      fs.writeFileSync(marker, "not-json", { mode: 0o600 });
      fs.chmodSync(marker, 0o600);
    } else {
      fs.writeFileSync(marker, JSON.stringify({
        version: 1,
        phase: "committed",
        stateDigest: "0".repeat(64),
      }), { mode: 0o600 });
      fs.chmodSync(marker, 0o600);
    }
    const repairStorage = createFileCircuitBreakerStorage({
      file: repairFile,
      repairAuthorizer: ({ authorization, confirmation, operation }) => (
        authorization === "local-operator-capability" &&
        confirmation === "exact-confirmation" &&
        operation === "repair_durability_uncertainty"
      ),
    });
    await assert.rejects(
      () => repairStorage.repairDurabilityUncertainty("meridian:risk-circuit-breaker", {
        authorization: "local-operator-capability",
        confirmation: "wrong-confirmation",
        atMs: NOW + 7,
      }),
      /not authorized/i,
    );
    const first = await repairStorage.repairDurabilityUncertainty("meridian:risk-circuit-breaker", {
      authorization: "local-operator-capability",
      confirmation: "exact-confirmation",
      atMs: NOW + 7,
    });
    const firstBytes = fs.readFileSync(repairFile);
    const second = await repairStorage.repairDurabilityUncertainty("meridian:risk-circuit-breaker", {
      authorization: "local-operator-capability",
      confirmation: "exact-confirmation",
      atMs: NOW + 70,
    });
    assert.deepEqual(second, first);
    assert.deepEqual(fs.readFileSync(repairFile), firstBytes);
    const repairedMarkerController = createCircuitBreakerController({
      storage: createFileCircuitBreakerStorage({ file: repairFile }),
      now: () => NOW + 8,
    });
    assert.equal(await repairedMarkerController.entryAllowed(), false);
    await repairedMarkerController.manualResume(NOW + 8);
    assert.equal(await repairedMarkerController.entryAllowed(), true);
  }

  // Existing default-path state is never silently ignored when the runtime
  // moves to a private directory. It blocks until an authorized repair writes
  // a new private latch and durable migration acknowledgement, without
  // discarding or trusting the legacy bytes.
  const privateMigrationFile = path.join(tempDir, "private-runtime-breaker.json");
  const legacyMigrationFile = path.join(tempDir, "legacy-repository-breaker.json");
  const legacyBytes = Buffer.from("legacy-state-must-remain");
  fs.writeFileSync(legacyMigrationFile, legacyBytes, { mode: 0o644 });
  const migrationStorage = createFileCircuitBreakerStorage({
    file: privateMigrationFile,
    legacyFile: legacyMigrationFile,
    repairAuthorizer: ({ authorization }) => authorization === "local-operator-capability",
  });
  await assert.rejects(
    () => createCircuitBreakerController({ storage: migrationStorage, now: () => NOW + 8 }).entryAllowed(),
    /legacy repository state.*operator durability repair/i,
  );
  const migrated = await migrationStorage.repairDurabilityUncertainty("meridian:risk-circuit-breaker", {
    authorization: "local-operator-capability",
    atMs: NOW + 8,
  });
  assert.equal(migrated.tripped, true);
  const migratedBytes = fs.readFileSync(privateMigrationFile);
  const migrationAcknowledgement = path.join(tempDir, ".legacy-breaker-state-acknowledged");
  const acknowledgementBytes = fs.readFileSync(migrationAcknowledgement);
  const repeatedMigration = await migrationStorage.repairDurabilityUncertainty("meridian:risk-circuit-breaker", {
    authorization: "local-operator-capability",
    atMs: NOW + 80,
  });
  assert.deepEqual(repeatedMigration, migrated);
  assert.deepEqual(fs.readFileSync(privateMigrationFile), migratedBytes);
  assert.deepEqual(fs.readFileSync(migrationAcknowledgement), acknowledgementBytes);
  assert.deepEqual(fs.readFileSync(legacyMigrationFile), legacyBytes, "legacy state must be preserved, never discarded");
  const migratedController = createCircuitBreakerController({
    storage: createFileCircuitBreakerStorage({ file: privateMigrationFile, legacyFile: legacyMigrationFile }),
    now: () => NOW + 8,
  });
  assert.equal(await migratedController.entryAllowed(), false);

  const cleanMarkerFile = path.join(tempDir, "clean-marker-breaker.json");
  const cleanMarkerController = createCircuitBreakerController({
    storage: createFileCircuitBreakerStorage({ file: cleanMarkerFile }),
    now: () => NOW + 6,
  });
  await cleanMarkerController.record({ type: "basis_invalid", atMs: NOW + 6 });
  await cleanMarkerController.manualResume(NOW + 7);
  assert.equal(fs.existsSync(durabilityUncertaintyMarkerPath(cleanMarkerFile)), true,
    "a fully synced write retains a state-bound committed marker");
  const restartedCleanMarker = createCircuitBreakerController({
    storage: createFileCircuitBreakerStorage({ file: cleanMarkerFile }),
    now: () => NOW + 8,
  });
  assert.equal(await restartedCleanMarker.entryAllowed(), true);

  // Protocol evidence is mandatory after the first write. A deleted marker,
  // forged digest marker under a writable directory, or private-file mode/
  // ownership violation all fail closed before state can affect entry.
  const deletedMarkerFile = path.join(tempDir, "deleted-marker-breaker.json");
  const deletedMarkerSeed = createCircuitBreakerController({
    storage: createFileCircuitBreakerStorage({ file: deletedMarkerFile }),
    now: () => NOW + 8,
  });
  await deletedMarkerSeed.record({ type: "basis_invalid", atMs: NOW + 8 });
  fs.rmSync(durabilityUncertaintyMarkerPath(deletedMarkerFile));
  await assert.rejects(
    () => createCircuitBreakerController({
      storage: createFileCircuitBreakerStorage({ file: deletedMarkerFile }),
      now: () => NOW + 8,
    }).entryAllowed(),
    /missing its committed durability marker/i,
  );

  const unsafeDirectory = fs.mkdtempSync(path.join(tempDir, "unsafe-breaker-directory-"));
  const unsafeDirectoryFile = path.join(unsafeDirectory, "breaker.json");
  writeCommittedState(unsafeDirectoryFile, createCircuitBreakerState(NOW));
  fs.chmodSync(unsafeDirectory, 0o777);
  await assert.rejects(
    () => createCircuitBreakerController({
      storage: createFileCircuitBreakerStorage({ file: unsafeDirectoryFile }),
      now: () => NOW,
    }).entryAllowed(),
    /permissions|private mutation boundary/i,
  );
  fs.chmodSync(unsafeDirectory, 0o700);

  const insecureStateFile = path.join(tempDir, "insecure-state-mode-breaker.json");
  writeCommittedState(insecureStateFile, createCircuitBreakerState(NOW));
  fs.chmodSync(insecureStateFile, 0o640);
  await assert.rejects(
    () => createCircuitBreakerController({
      storage: createFileCircuitBreakerStorage({ file: insecureStateFile }),
      now: () => NOW,
    }).entryAllowed(),
    /permissions/i,
  );

  const insecureMarkerFile = path.join(tempDir, "insecure-marker-mode-breaker.json");
  writeCommittedState(insecureMarkerFile, createCircuitBreakerState(NOW));
  fs.chmodSync(durabilityUncertaintyMarkerPath(insecureMarkerFile), 0o640);
  await assert.rejects(
    () => createCircuitBreakerController({
      storage: createFileCircuitBreakerStorage({ file: insecureMarkerFile }),
      now: () => NOW,
    }).entryAllowed(),
    /permissions/i,
  );

  const ownershipFile = path.join(tempDir, "unexpected-owner-breaker.json");
  writeCommittedState(ownershipFile, createCircuitBreakerState(NOW));
  await assert.rejects(
    () => createCircuitBreakerController({
      storage: createFileCircuitBreakerStorage({
        file: ownershipFile,
        fsImpl: withUnexpectedOwner(fs, ownershipFile),
      }),
      now: () => NOW,
    }).entryAllowed(),
    /owned by the effective user/i,
  );

  const markerOwnershipFile = path.join(tempDir, "unexpected-marker-owner-breaker.json");
  writeCommittedState(markerOwnershipFile, createCircuitBreakerState(NOW));
  await assert.rejects(
    () => createCircuitBreakerController({
      storage: createFileCircuitBreakerStorage({
        file: markerOwnershipFile,
        fsImpl: withUnexpectedOwner(fs, durabilityUncertaintyMarkerPath(markerOwnershipFile)),
      }),
      now: () => NOW,
    }).entryAllowed(),
    /owned by the effective user/i,
  );

  const directoryOwnership = fs.mkdtempSync(path.join(tempDir, "unexpected-directory-owner-"));
  const directoryOwnershipFile = path.join(directoryOwnership, "breaker.json");
  writeCommittedState(directoryOwnershipFile, createCircuitBreakerState(NOW));
  await assert.rejects(
    () => createCircuitBreakerController({
      storage: createFileCircuitBreakerStorage({
        file: directoryOwnershipFile,
        fsImpl: withUnexpectedOwner(fs, directoryOwnership),
      }),
      now: () => NOW,
    }).entryAllowed(),
    /owned by the effective user/i,
  );

  // Regression: the reader now acquires the same mutex before reading state
  // and its committed marker. A writer lock created at that acquisition point
  // (the old check-then-read window) must make entry reject rather than return
  // the previously persisted permissive state.
  const readWindowRaceFile = path.join(tempDir, "read-window-race-breaker.json");
  const readWindowSeed = createCircuitBreakerController({
    storage: createFileCircuitBreakerStorage({ file: readWindowRaceFile }),
    now: () => NOW + 8,
  });
  await readWindowSeed.manualResume(NOW + 8);
  const readWindowLockPath = path.join(tempDir, `.${path.basename(readWindowRaceFile)}.update.lock`);
  let writerLockInjected = false;
  let injectedWriterLock = null;
  const writerRaceFs = Object.assign(Object.create(fs), {
    openSync(candidate, flags, ...args) {
      const isReaderMutexAttempt = String(candidate).endsWith(`/${path.basename(readWindowLockPath)}`) &&
        (flags & fs.constants.O_CREAT) !== 0 && (flags & fs.constants.O_EXCL) !== 0;
      if (!writerLockInjected && isReaderMutexAttempt) {
        injectedWriterLock = acquireSecureFileLock(readWindowRaceFile, {
          label: "Circuit breaker state",
          requirePrivate: true,
        });
        writerLockInjected = true;
      }
      return fs.openSync(candidate, flags, ...args);
    },
  });
  await assert.rejects(
    () => createCircuitBreakerController({
      storage: createFileCircuitBreakerStorage({ file: readWindowRaceFile, fsImpl: writerRaceFs }),
      now: () => NOW + 9,
    }).entryAllowed(),
    /retained or in-flight update lock/i,
  );
  assert.equal(writerLockInjected, true);
  assert.equal(fs.existsSync(readWindowLockPath), true, "the racing writer lock remains the fail-closed result");
  releaseSecureFileLock(injectedWriterLock, { label: "Circuit breaker state", requirePrivate: true });

  // A retained or foreign update lock denies all reads, writes, and entries in
  // both the current and restarted process. The mutation itself still uses the
  // lock while held, so a normal seed above continues to work.
  const retainedLockFile = path.join(tempDir, "retained-lock-breaker.json");
  const retainedLockSeed = createCircuitBreakerController({
    storage: createFileCircuitBreakerStorage({ file: retainedLockFile }),
    now: () => NOW + 8,
  });
  await retainedLockSeed.record({ type: "basis_invalid", atMs: NOW + 8 });
  const retainedLockPath = path.join(tempDir, `.${path.basename(retainedLockFile)}.update.lock`);
  fs.writeFileSync(retainedLockPath, "retained", { mode: 0o600 });
  fs.chmodSync(retainedLockPath, 0o600);
  const retainedLockStorage = createFileCircuitBreakerStorage({
    file: retainedLockFile,
    lockTimeoutMs: 0,
  });
  const retainedLockRuntime = createConfiguredBreakerRuntime({
    storage: retainedLockStorage,
    circuitBreaker: { enabled: true },
    now: () => NOW + 9,
  });
  await assert.rejects(() => retainedLockRuntime.getState(), /retained or in-flight update lock/i);
  await assert.rejects(() => retainedLockRuntime.entryAllowed(), /retained or in-flight update lock/i);
  await assert.rejects(
    () => retainedLockRuntime.record({ type: "basis_invalid", atMs: NOW + 9 }),
    /Timed out waiting.*lock/i,
  );
  const restartedRetainedLock = createConfiguredBreakerRuntime({
    storage: createFileCircuitBreakerStorage({ file: retainedLockFile, lockTimeoutMs: 0 }),
    circuitBreaker: { enabled: true },
    now: () => NOW + 10,
  });
  await assert.rejects(() => restartedRetainedLock.entryAllowed(), /retained or in-flight update lock/i);
  fs.rmSync(retainedLockPath);

  // The repair command can reconcile a lock retained by a dead writer, but it
  // first proves the lock's private descriptor provenance and never reopens
  // entry. The child leaves a real runtime-created lock behind before exit.
  const repairableRetainedLockFile = path.join(tempDir, "repairable-retained-lock-breaker.json");
  await runRetainedLockWriter(repairableRetainedLockFile, NOW + 9);
  const repairableRetainedLockPath = path.join(tempDir, `.${path.basename(repairableRetainedLockFile)}.update.lock`);
  const repairableRetainedStorage = createFileCircuitBreakerStorage({
    file: repairableRetainedLockFile,
    lockTimeoutMs: 0,
    repairAuthorizer: ({ authorization, confirmation, operation }) => (
      authorization === "local-operator-capability" &&
      confirmation === "exact-confirmation" &&
      operation === "repair_durability_uncertainty"
    ),
  });
  await assert.rejects(
    () => repairableRetainedStorage.repairDurabilityUncertainty("meridian:risk-circuit-breaker", {
      authorization: "wrong-capability",
      confirmation: "exact-confirmation",
      atMs: NOW + 10,
    }),
    /not authorized/i,
  );
  const retainedRepair = await repairableRetainedStorage.repairDurabilityUncertainty("meridian:risk-circuit-breaker", {
    authorization: "local-operator-capability",
    confirmation: "exact-confirmation",
    atMs: NOW + 10,
  });
  assert.equal(fs.existsSync(repairableRetainedLockPath), false, "authorized repair releases the proven stale lock");
  assert.equal(retainedRepair.tripped, true);
  assert.equal(retainedRepair.manualResumeRequired, true);
  assert.deepEqual(retainedRepair.reasons, ["DURABILITY_UNCERTAINTY_REPAIRED"]);
  assert.equal(await createCircuitBreakerController({
    storage: createFileCircuitBreakerStorage({ file: repairableRetainedLockFile }),
    now: () => NOW + 11,
  }).entryAllowed(), false, "stale-lock repair remains a manual latch");
  const retainedRepairBytes = fs.readFileSync(repairableRetainedLockFile);
  const repeatedRetainedRepair = await repairableRetainedStorage.repairDurabilityUncertainty("meridian:risk-circuit-breaker", {
    authorization: "local-operator-capability",
    confirmation: "exact-confirmation",
    atMs: NOW + 99,
  });
  assert.deepEqual(repeatedRetainedRepair, retainedRepair);
  assert.deepEqual(fs.readFileSync(repairableRetainedLockFile), retainedRepairBytes,
    "repeated stale-lock repair remains byte-idempotent");

  // A lock retained after cleanup in this still-running process has no active
  // nonce and is recoverable by an authorized repair. This is distinct from a
  // currently active same-process lock, which remains non-stealable below.
  const sameProcessRetainedFile = path.join(tempDir, "same-process-retained-lock-breaker.json");
  writeCommittedState(sameProcessRetainedFile, createCircuitBreakerState(NOW + 10));
  const sameProcessRetainedLockPath = writeRetainedLock(sameProcessRetainedFile, retainedLockRecord(sameProcessRetainedFile, {
    nonce: "e".repeat(64),
  }));
  const sameProcessRetainedStorage = authorizedRepairStorage(sameProcessRetainedFile);
  const sameProcessRepaired = await sameProcessRetainedStorage.repairDurabilityUncertainty("meridian:risk-circuit-breaker", {
    authorization: "local-operator-capability",
    atMs: NOW + 11,
  });
  assert.equal(fs.existsSync(sameProcessRetainedLockPath), false, "inactive same-process retained lock is reclaimed");
  assert.equal(sameProcessRepaired.manualResumeRequired, true);
  assert.equal(await createCircuitBreakerController({
    storage: createFileCircuitBreakerStorage({ file: sameProcessRetainedFile }),
    now: () => NOW + 11,
  }).entryAllowed(), false);

  // Foreign ownership has a tri-state proof: a matching valid token is live,
  // ENOENT is definitely dead, and malformed or unreadable /proc data remains
  // unverifiable. The injected filesystem must govern these process reads.
  const foreignOwnerPid = 987_654;
  const foreignOwnerToken = "54321";
  const liveForeignFile = path.join(tempDir, "live-foreign-retained-lock-breaker.json");
  writeCommittedState(liveForeignFile, createCircuitBreakerState(NOW + 11));
  const liveForeignLockPath = writeRetainedLock(liveForeignFile, retainedLockRecord(liveForeignFile, {
    ownerPid: foreignOwnerPid,
    ownerStartToken: foreignOwnerToken,
    nonce: "f".repeat(64),
  }));
  await assert.rejects(
    () => authorizedRepairStorage(liveForeignFile, withProcessOwnerRead(
      foreignOwnerPid,
      () => procStatWithStartToken(foreignOwnerToken),
    )).repairDurabilityUncertainty("meridian:risk-circuit-breaker", {
      authorization: "local-operator-capability",
      atMs: NOW + 12,
    }),
    /actively held by process/i,
  );
  assert.equal(fs.existsSync(liveForeignLockPath), true, "live foreign owner remains protected");
  fs.rmSync(liveForeignLockPath);

  const deadForeignFile = path.join(tempDir, "dead-foreign-retained-lock-breaker.json");
  writeCommittedState(deadForeignFile, createCircuitBreakerState(NOW + 12));
  const deadForeignLockPath = writeRetainedLock(deadForeignFile, retainedLockRecord(deadForeignFile, {
    ownerPid: foreignOwnerPid,
    ownerStartToken: foreignOwnerToken,
    nonce: "1".repeat(64),
  }));
  const definitelyMissing = () => {
    const error = new Error("injected missing process");
    error.code = "ENOENT";
    throw error;
  };
  await authorizedRepairStorage(deadForeignFile, withProcessOwnerRead(foreignOwnerPid, definitelyMissing))
    .repairDurabilityUncertainty("meridian:risk-circuit-breaker", {
      authorization: "local-operator-capability",
      atMs: NOW + 13,
    });
  assert.equal(fs.existsSync(deadForeignLockPath), false, "definitely dead foreign owner is recoverable");

  for (const [name, readOwner] of [
    ["malformed", () => "not a proc stat"],
    ["unverifiable", () => { const error = new Error("injected proc read failure"); error.code = "EACCES"; throw error; }],
  ]) {
    const file = path.join(tempDir, `${name}-foreign-retained-lock-breaker.json`);
    writeCommittedState(file, createCircuitBreakerState(NOW + 13));
    const lockPath = writeRetainedLock(file, retainedLockRecord(file, {
      ownerPid: foreignOwnerPid,
      ownerStartToken: foreignOwnerToken,
      nonce: name === "malformed" ? "2".repeat(64) : "3".repeat(64),
    }));
    await assert.rejects(
      () => authorizedRepairStorage(file, withProcessOwnerRead(foreignOwnerPid, readOwner))
        .repairDurabilityUncertainty("meridian:risk-circuit-breaker", {
          authorization: "local-operator-capability",
          atMs: NOW + 14,
        }),
      /owner cannot be proven inactive/i,
    );
    assert.equal(fs.existsSync(lockPath), true, `${name} process provenance remains fail-closed`);
    fs.rmSync(lockPath);
  }

  // A claimed lock differs from a freshly acquired lock: any repair fault
  // before a known durable safe latch must retain it, keep ordinary entry
  // blocked, and allow a later authorized repair to claim the inactive nonce.
  for (const repairFailure of ["raw-current-read", "marker-write"]) {
    const file = path.join(tempDir, `${repairFailure}-claimed-repair-breaker.json`);
    writeCommittedState(file, createCircuitBreakerState(NOW + 14));
    const lockPath = writeRetainedLock(file, retainedLockRecord(file, {
      nonce: repairFailure === "raw-current-read" ? "4".repeat(64) : "5".repeat(64),
    }));
    const markerPath = durabilityUncertaintyMarkerPath(file);
    const stateDescriptors = new Set();
    const markerDescriptors = new Set();
    let injected = false;
    const failureFs = Object.assign(Object.create(fs), {
      openSync(candidate, ...args) {
        const descriptor = fs.openSync(candidate, ...args);
        if (String(candidate).endsWith(`/${path.basename(file)}`)) stateDescriptors.add(descriptor);
        if (String(candidate).endsWith(`/${path.basename(markerPath)}`)) markerDescriptors.add(descriptor);
        return descriptor;
      },
      readSync(descriptor, ...args) {
        if (repairFailure === "raw-current-read" && !injected && stateDescriptors.has(descriptor)) {
          injected = true;
          const error = new Error("injected raw current read failure");
          error.code = "EIO";
          throw error;
        }
        return fs.readSync(descriptor, ...args);
      },
      writeSync(descriptor, ...args) {
        if (repairFailure === "marker-write" && !injected && markerDescriptors.has(descriptor)) {
          injected = true;
          const error = new Error("injected repair marker write failure");
          error.code = "EIO";
          throw error;
        }
        return fs.writeSync(descriptor, ...args);
      },
    });
    const failingClaimRepair = authorizedRepairStorage(file, failureFs);
    await assert.rejects(
      () => failingClaimRepair.repairDurabilityUncertainty("meridian:risk-circuit-breaker", {
        authorization: "local-operator-capability",
        atMs: NOW + 15,
      }),
      repairFailure === "raw-current-read" ? /injected raw current read failure/i : /injected repair marker write failure/i,
    );
    assert.equal(injected, true);
    assert.equal(fs.existsSync(lockPath), true, `${repairFailure} retains the claimed fail-closed lock`);
    assert.deepEqual(failingClaimRepair.getLastOperationStatus("meridian:risk-circuit-breaker"), {
      committed: false,
      cleanupLockState: "retained_or_unknown",
    });
    await assert.rejects(
      () => createCircuitBreakerController({
        storage: createFileCircuitBreakerStorage({ file, lockTimeoutMs: 0 }),
        now: () => NOW + 15,
      }).entryAllowed(),
      /retained or in-flight update lock/i,
    );
    const retryRepair = authorizedRepairStorage(file);
    const recovered = await retryRepair.repairDurabilityUncertainty("meridian:risk-circuit-breaker", {
      authorization: "local-operator-capability",
      atMs: NOW + 16,
    });
    const recoveredBytes = fs.readFileSync(file);
    const repeated = await retryRepair.repairDurabilityUncertainty("meridian:risk-circuit-breaker", {
      authorization: "local-operator-capability",
      atMs: NOW + 17,
    });
    assert.equal(fs.existsSync(lockPath), false, `${repairFailure} retry releases only after safe latch commit`);
    assert.deepEqual(repeated, recovered);
    assert.deepEqual(fs.readFileSync(file), recoveredBytes, `${repairFailure} retry remains byte-idempotent`);
    assert.equal(await createCircuitBreakerController({
      storage: createFileCircuitBreakerStorage({ file }),
      now: () => NOW + 17,
    }).entryAllowed(), false);
  }

  // An active owner is never stolen, and an unbound/foreign lock is never
  // treated as proof that a repair may proceed.
  const activeLockFile = path.join(tempDir, "active-retained-lock-breaker.json");
  const activeSeed = createCircuitBreakerController({
    storage: createFileCircuitBreakerStorage({ file: activeLockFile }),
    now: () => NOW + 11,
  });
  await activeSeed.record({ type: "basis_invalid", atMs: NOW + 11 });
  const activeLock = acquireSecureFileLock(activeLockFile, {
    label: "Circuit breaker state",
    requirePrivate: true,
  });
  const activeRepairStorage = createFileCircuitBreakerStorage({
    file: activeLockFile,
    lockTimeoutMs: 0,
    repairAuthorizer: ({ authorization }) => authorization === "local-operator-capability",
  });
  await assert.rejects(
    () => activeRepairStorage.repairDurabilityUncertainty("meridian:risk-circuit-breaker", {
      authorization: "local-operator-capability",
      atMs: NOW + 12,
    }),
    /actively held/i,
  );
  assert.equal(fs.existsSync(path.join(tempDir, `.${path.basename(activeLockFile)}.update.lock`)), true);
  releaseSecureFileLock(activeLock, { label: "Circuit breaker state", requirePrivate: true });

  const foreignLockFile = path.join(tempDir, "foreign-retained-lock-breaker.json");
  const foreignSeed = createCircuitBreakerController({
    storage: createFileCircuitBreakerStorage({ file: foreignLockFile }),
    now: () => NOW + 12,
  });
  await foreignSeed.record({ type: "basis_invalid", atMs: NOW + 12 });
  const foreignLockPath = path.join(tempDir, `.${path.basename(foreignLockFile)}.update.lock`);
  fs.writeFileSync(foreignLockPath, JSON.stringify({
    version: 1,
    type: "meridian-secure-file-lock",
    resourceDigest: durableContentDigest(path.join(tempDir, "other-breaker.json")),
    ownerPid: 999_999,
    ownerStartToken: "1",
    nonce: "a".repeat(64),
    operation: "update",
  }), { mode: 0o600 });
  fs.chmodSync(foreignLockPath, 0o600);
  const foreignRepairStorage = createFileCircuitBreakerStorage({
    file: foreignLockFile,
    lockTimeoutMs: 0,
    repairAuthorizer: ({ authorization }) => authorization === "local-operator-capability",
  });
  await assert.rejects(
    () => foreignRepairStorage.repairDurabilityUncertainty("meridian:risk-circuit-breaker", {
      authorization: "local-operator-capability",
      atMs: NOW + 13,
    }),
    /unprovable or belongs to a different resource/i,
  );
  assert.equal(fs.existsSync(foreignLockPath), true);
  fs.rmSync(foreignLockPath);

  const changedLockFile = path.join(tempDir, "changed-retained-lock-breaker.json");
  const changedSeed = createCircuitBreakerController({
    storage: createFileCircuitBreakerStorage({ file: changedLockFile }),
    now: () => NOW + 13,
  });
  await changedSeed.record({ type: "basis_invalid", atMs: NOW + 13 });
  const changedLockPath = path.join(tempDir, `.${path.basename(changedLockFile)}.update.lock`);
  const staleLockRecord = {
    version: 1,
    type: "meridian-secure-file-lock",
    resourceDigest: durableContentDigest(changedLockFile),
    ownerPid: 999_999,
    ownerStartToken: "1",
    nonce: "b".repeat(64),
    operation: "update",
  };
  fs.writeFileSync(changedLockPath, JSON.stringify(staleLockRecord), { mode: 0o600 });
  fs.chmodSync(changedLockPath, 0o600);
  const lockDescriptors = new Set();
  let lockFstatCalls = 0;
  const changedLockFs = Object.assign(Object.create(fs), {
    openSync(candidate, ...args) {
      const descriptor = fs.openSync(candidate, ...args);
      if (String(candidate).endsWith(`/${path.basename(changedLockPath)}`)) lockDescriptors.add(descriptor);
      return descriptor;
    },
    fstatSync(descriptor) {
      const stat = fs.fstatSync(descriptor);
      if (lockDescriptors.has(descriptor)) {
        lockFstatCalls += 1;
        if (lockFstatCalls === 4) {
          fs.writeFileSync(changedLockPath, JSON.stringify({ ...staleLockRecord, nonce: "c".repeat(64) }));
        }
      }
      return stat;
    },
  });
  const changedRepairStorage = createFileCircuitBreakerStorage({
    file: changedLockFile,
    fsImpl: changedLockFs,
    lockTimeoutMs: 0,
    repairAuthorizer: ({ authorization }) => authorization === "local-operator-capability",
  });
  await assert.rejects(
    () => changedRepairStorage.repairDurabilityUncertainty("meridian:risk-circuit-breaker", {
      authorization: "local-operator-capability",
      atMs: NOW + 14,
    }),
    /content changed before write/i,
  );
  assert.equal(fs.existsSync(changedLockPath), true, "a changed retained lock is not claimed");
  fs.rmSync(changedLockPath);

  const insecureLockFile = path.join(tempDir, "insecure-lock-mode-breaker.json");
  const insecureLockSeed = createCircuitBreakerController({
    storage: createFileCircuitBreakerStorage({ file: insecureLockFile }),
    now: () => NOW + 8,
  });
  await insecureLockSeed.record({ type: "basis_invalid", atMs: NOW + 8 });
  const insecureLockPath = path.join(tempDir, `.${path.basename(insecureLockFile)}.update.lock`);
  fs.writeFileSync(insecureLockPath, "foreign", { mode: 0o640 });
  fs.chmodSync(insecureLockPath, 0o640);
  await assert.rejects(
    () => createCircuitBreakerController({
      storage: createFileCircuitBreakerStorage({ file: insecureLockFile }),
      now: () => NOW + 8,
    }).entryAllowed(),
    /permissions/i,
  );
  const ownershipLockFile = path.join(tempDir, "unexpected-lock-owner-breaker.json");
  const ownershipLockSeed = createCircuitBreakerController({
    storage: createFileCircuitBreakerStorage({ file: ownershipLockFile }),
    now: () => NOW + 8,
  });
  await ownershipLockSeed.record({ type: "basis_invalid", atMs: NOW + 8 });
  const ownershipLockPath = path.join(tempDir, `.${path.basename(ownershipLockFile)}.update.lock`);
  fs.writeFileSync(ownershipLockPath, "foreign", { mode: 0o600 });
  fs.chmodSync(ownershipLockPath, 0o600);
  await assert.rejects(
    () => createCircuitBreakerController({
      storage: createFileCircuitBreakerStorage({
        file: ownershipLockFile,
        fsImpl: withUnexpectedOwner(fs, ownershipLockPath),
      }),
      now: () => NOW + 8,
    }).entryAllowed(),
    /owned by the effective user/i,
  );
  fs.rmSync(ownershipLockPath);
  fs.rmSync(insecureLockPath);

  // Reader-lock cleanup faults cannot turn the bytes read under that mutex
  // into a permission. Even after the lock pathname was successfully removed,
  // the current read fails closed and a fresh normal reader can classify the
  // actual lock state and committed latch correctly.
  const readCleanupFailureFile = path.join(tempDir, "read-lock-cleanup-breaker.json");
  const readCleanupSeed = createCircuitBreakerController({
    storage: createFileCircuitBreakerStorage({ file: readCleanupFailureFile }),
    now: () => NOW + 8,
  });
  await readCleanupSeed.manualResume(NOW + 8);
  const readCleanupStorage = createFileCircuitBreakerStorage({
    file: readCleanupFailureFile,
    fsImpl: failPostCommitLockCleanupFsyncFs(readCleanupFailureFile),
  });
  await assert.rejects(
    () => createCircuitBreakerController({ storage: readCleanupStorage, now: () => NOW + 9 }).entryAllowed(),
    /read lock cleanup failed after unlink/i,
  );
  assert.equal(fs.existsSync(path.join(tempDir, `.${path.basename(readCleanupFailureFile)}.update.lock`)), false);
  assert.equal(await createCircuitBreakerController({
    storage: createFileCircuitBreakerStorage({ file: readCleanupFailureFile }),
    now: () => NOW + 9,
  }).entryAllowed(), true);

  // A directory fsync failure while releasing the lock occurs only after the
  // target and its committed marker are durable. It must not make a completed
  // manual resume reject while both current and restarted readers allow it.
  const cleanupFailureFile = path.join(tempDir, "post-commit-cleanup-breaker.json");
  const cleanupSeed = createCircuitBreakerController({
    storage: createFileCircuitBreakerStorage({ file: cleanupFailureFile }),
    now: () => NOW + 8,
  });
  await cleanupSeed.record({ type: "basis_invalid", atMs: NOW + 8 });
  const cleanupFailureStorage = createFileCircuitBreakerStorage({
    file: cleanupFailureFile,
    fsImpl: failPostCommitLockCleanupFsyncFs(cleanupFailureFile),
  });
  // Save directly so this fixture targets the committed mutation-lock cleanup
  // fault rather than the independently fail-closed reader-lock cleanup path.
  await cleanupFailureStorage.save("meridian:risk-circuit-breaker", createCircuitBreakerState(NOW + 9));
  assert.deepEqual(cleanupFailureStorage.getLastOperationStatus("meridian:risk-circuit-breaker"), {
    committed: true,
    diagnosticCode: "LOCK_DIRECTORY_FSYNC_AFTER_UNLINK",
    diagnostic: "injected persistent post-commit lock cleanup fsync failure",
    cleanupLockState: "absent",
  });
  assert.equal(await createCircuitBreakerController({
    storage: createFileCircuitBreakerStorage({ file: cleanupFailureFile }),
    now: () => NOW + 10,
  }).entryAllowed(), true);
  const restartedCleanupFailure = createCircuitBreakerController({
    storage: createFileCircuitBreakerStorage({ file: cleanupFailureFile }),
    now: () => NOW + 10,
  });
  assert.equal(await restartedCleanupFailure.entryAllowed(), true);

  // Unlink, integrity, and close faults are not the safe post-unlink
  // directory-fsync diagnostic. Each is surfaced with committed=true. Where a
  // lock remains, current and restarted reads are also fail-closed.
  const cleanupFailureCases = [
    { name: "unlink", fsImpl: failPostCommitLockUnlinkFs },
    { name: "integrity", fsImpl: failPostCommitLockIntegrityFs },
    { name: "close", fsImpl: failPostCommitLockCloseFs },
  ];
  for (const cleanupCase of cleanupFailureCases) {
    const file = path.join(tempDir, `post-commit-${cleanupCase.name}-breaker.json`);
    const seed = createCircuitBreakerController({
      storage: createFileCircuitBreakerStorage({ file }),
      now: () => NOW + 10,
    });
    await seed.record({ type: "basis_invalid", atMs: NOW + 10 });
    const cleanupStorage = createFileCircuitBreakerStorage({ file, fsImpl: cleanupCase.fsImpl(file) });
    await assert.rejects(
      () => cleanupStorage.save("meridian:risk-circuit-breaker", createCircuitBreakerState(NOW + 11)),
      (error) => error?.committed === true && new RegExp(`post-commit.*${cleanupCase.name}`).test(error.message),
    );
    const lockPath = path.join(tempDir, `.${path.basename(file)}.update.lock`);
    const controller = createCircuitBreakerController({ storage: cleanupStorage, now: () => NOW + 12 });
    if (cleanupCase.name === "close") {
      assert.equal(fs.existsSync(lockPath), false, "a surfaced close fault follows successful unlink");
      assert.deepEqual(cleanupStorage.getLastOperationStatus("meridian:risk-circuit-breaker"), {
        committed: true,
        cleanupError: "injected post-commit lock close failure",
        cleanupLockState: "absent",
      });
      await assert.rejects(
        () => controller.entryAllowed(),
        /post-commit lock close failure/i,
      );
      assert.equal(await createCircuitBreakerController({
        storage: createFileCircuitBreakerStorage({ file }),
        now: () => NOW + 12,
      }).entryAllowed(), true);
    } else {
      assert.equal(fs.existsSync(lockPath), true, "hazardous cleanup retains the lock");
      assert.deepEqual(cleanupStorage.getLastOperationStatus("meridian:risk-circuit-breaker"), {
        committed: true,
        cleanupError: cleanupCase.name === "unlink"
          ? "injected post-commit retained lock unlink failure"
          : "injected post-commit lock integrity failure",
        cleanupLockState: "retained_or_unknown",
      });
      await assert.rejects(() => controller.entryAllowed(), /retained or in-flight update lock|lock integrity failure/i);
      await assert.rejects(
        () => createCircuitBreakerController({
          storage: createFileCircuitBreakerStorage({ file }),
          now: () => NOW + 12,
        }).entryAllowed(),
        /retained or in-flight update lock/i,
      );
      fs.rmSync(lockPath);
    }
  }

  // Generic controllers must also refresh their authoritative adapter state:
  // controller A first observes permission, controller B persists a trip, and
  // then A must deny entry without being recreated.
  const sharedControllerFile = path.join(tempDir, "shared-controller-breaker.json");
  const firstController = createCircuitBreakerController({
    storage: createFileCircuitBreakerStorage({ file: sharedControllerFile }),
    now: () => NOW + 9,
  });
  const secondController = createCircuitBreakerController({
    storage: createFileCircuitBreakerStorage({ file: sharedControllerFile }),
    now: () => NOW + 10,
  });
  assert.equal(await firstController.entryAllowed(), true);
  await secondController.record({ type: "basis_invalid", atMs: NOW + 10 });
  assert.equal((await firstController.getState()).tripped, true);
  assert.equal(await firstController.entryAllowed(), false);

  // Generic controllers use save rather than the configured mutation path.
  // A manual resume that loaded before a different process persisted a trip
  // must reject on the content-bound CAS token and preserve that newer latch.
  const staleResumeFile = path.join(tempDir, "stale-manual-resume-breaker.json");
  const staleRepairStorage = createFileCircuitBreakerStorage({
    file: staleResumeFile,
    repairAuthorizer: ({ authorization }) => authorization === "local-operator-capability",
  });
  await staleRepairStorage.repairDurabilityUncertainty("meridian:risk-circuit-breaker", {
    authorization: "local-operator-capability",
    atMs: NOW + 10,
  });
  const delayedFileStorage = createFileCircuitBreakerStorage({ file: staleResumeFile });
  const competingFileStorage = createFileCircuitBreakerStorage({ file: staleResumeFile });
  let saveStarted;
  const saveEntered = new Promise((resolve) => { saveStarted = resolve; });
  let releaseStaleSave;
  const staleSaveReleased = new Promise((resolve) => { releaseStaleSave = resolve; });
  const delayedStorage = {
    load: (key) => delayedFileStorage.load(key),
    async save(key, value) {
      saveStarted();
      await staleSaveReleased;
      return delayedFileStorage.save(key, value);
    },
  };
  const staleResumeController = createCircuitBreakerController({
    storage: delayedStorage,
    now: () => NOW + 11,
  });
  const competingController = createCircuitBreakerController({
    storage: competingFileStorage,
    now: () => NOW + 12,
  });
  const staleResume = staleResumeController.manualResume(NOW + 11);
  await saveEntered;
  await competingController.record({ type: "basis_invalid", atMs: NOW + 12 });
  releaseStaleSave();
  await assert.rejects(() => staleResume, /changed before write|content changed/i);
  assert.equal(await staleResumeController.entryAllowed(), false);
  const restartedStaleResume = createCircuitBreakerController({
    storage: createFileCircuitBreakerStorage({ file: staleResumeFile }),
    now: () => NOW + 13,
  });
  assert.equal((await restartedStaleResume.getState()).tripped, true);
  assert.equal(await restartedStaleResume.entryAllowed(), false);

  // Successful marker transactions never unlink the marker pathname. If an
  // old cleanup implementation tried to remove it, this adapter would swap a
  // foreign replacement into that pathname and expose its deletion.
  const markerRaceFile = path.join(tempDir, "marker-replacement-race-breaker.json");
  const markerRacePath = durabilityUncertaintyMarkerPath(markerRaceFile);
  const foreignMarker = path.join(tempDir, "foreign-marker-replacement");
  fs.writeFileSync(foreignMarker, "foreign marker must survive");
  let markerCleanupAttempts = 0;
  const markerReplacementFs = Object.assign(Object.create(fs), {
    unlinkSync(candidate, ...args) {
      if (String(candidate) === markerRacePath || String(candidate).endsWith(`/${path.basename(markerRacePath)}`)) {
        markerCleanupAttempts += 1;
        fs.renameSync(foreignMarker, markerRacePath);
      }
      return fs.unlinkSync(candidate, ...args);
    },
  });
  const markerRaceController = createCircuitBreakerController({
    storage: createFileCircuitBreakerStorage({ file: markerRaceFile, fsImpl: markerReplacementFs }),
    now: () => NOW + 13,
  });
  await markerRaceController.record({ type: "basis_invalid", atMs: NOW + 13 });
  assert.equal(markerCleanupAttempts, 0, "marker cleanup must not unlink a pathname");
  assert.equal(fs.readFileSync(foreignMarker, "utf8"), "foreign marker must survive");
  const restartedMarkerRace = createCircuitBreakerController({
    storage: createFileCircuitBreakerStorage({ file: markerRaceFile }),
    now: () => NOW + 14,
  });
  assert.equal(await restartedMarkerRace.entryAllowed(), false);

  // The destination can change after an old implementation's final identity
  // check but before rename. A verified in-place write must instead detect the
  // descriptor/path mismatch and leave the replacement untouched.
  const racedFile = path.join(tempDir, "raced-breaker.json");
  const racedReplacement = path.join(tempDir, "raced-breaker-replacement.json");
  fs.writeFileSync(racedFile, "original");
  fs.writeFileSync(racedReplacement, "replacement-owner");
  let targetSnapshots = 0;
  let raceInjected = false;
  const racingFs = Object.assign(Object.create(fs), {
    lstatSync(candidate, ...args) {
      const stat = fs.lstatSync(candidate, ...args);
      if (String(candidate) === racedFile || String(candidate).endsWith(`/${path.basename(racedFile)}`)) {
        targetSnapshots += 1;
        if (targetSnapshots === 3) {
          fs.renameSync(racedReplacement, racedFile);
          raceInjected = true;
        }
      }
      return stat;
    },
  });
  assert.throws(() => atomicReplaceSecureFile(racedFile, Buffer.from("new-state"), {
    fsImpl: racingFs,
    label: "Raced breaker state",
    durable: false,
  }), (error) => error?.code === "EAGAIN");
  assert.equal(raceInjected, true);
  assert.equal(fs.readFileSync(racedFile, "utf8"), "replacement-owner");

  // Competing processes each load, reduce, and persist through one durable
  // lock.  Neither process can lose the other operational failure; the
  // resulting trip persists across a fresh runtime and only manual resume
  // clears it.
  const concurrentFile = path.join(tempDir, "concurrent-breaker.json");
  await Promise.all([
    runConcurrentBreakerWriter(concurrentFile, "concurrent-failure-a", NOW + 10),
    runConcurrentBreakerWriter(concurrentFile, "concurrent-failure-b", NOW + 20),
  ]);
  const concurrent = createConfiguredBreakerRuntime({
    storage: createFileCircuitBreakerStorage({ file: concurrentFile }),
    circuitBreaker: { enabled: true, consecutiveOperationalFailures: 2 },
    now: () => NOW + 30,
  });
  const concurrentState = await concurrent.getState();
  assert.equal(concurrentState.consecutiveOperationalFailures, 2);
  assert.equal(concurrentState.tripped, true);
  assert.equal(concurrentState.manualResumeRequired, true);
  assert.equal(await concurrent.entryAllowed(), false);
  await concurrent.manualResume(NOW + 40);
  const restartedConcurrent = createConfiguredBreakerRuntime({
    storage: createFileCircuitBreakerStorage({ file: concurrentFile }),
    circuitBreaker: { enabled: true, consecutiveOperationalFailures: 2 },
    now: () => NOW + 50,
  });
  assert.equal(await restartedConcurrent.entryAllowed(), true);

  const unverifiedRelay = classifyRelayDeployResult({
    submission: {
      signatures: ["signature-a", "signature-a"],
      result: { txHashes: ["signature-b"] },
    },
    verifiedPositionAddress: null,
  });
  assert.equal(unverifiedRelay.success, false);
  assert.equal(unverifiedRelay.reconciliation_required, true);
  assert.equal(unverifiedRelay.position, null);
  assert.deepEqual(unverifiedRelay.txs, ["signature-a", "signature-b"]);
  assert.match(unverifiedRelay.error, /no verified position address/i);

  const verifiedRelay = classifyRelayDeployResult({
    submission: { result: { signature: "signature-c" } },
    verifiedPositionAddress: "  Position111  ",
  });
  assert.equal(verifiedRelay.success, true);
  assert.equal(verifiedRelay.reconciliation_required, false);
  assert.equal(verifiedRelay.position, "Position111");
  assert.deepEqual(verifiedRelay.txs, ["signature-c"]);

  console.log("runtime integrity tests passed");
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
