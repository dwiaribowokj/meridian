import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "./config.js";
import { repoPath } from "./repo-root.js";
import {
  acquireSecureFileLock,
  atomicReplaceSecureFile,
  assertNoDurabilityUncertaintyMarker,
  assertNoSecureFileLock,
  claimRetainedSecureFileLock,
  readSecureRegularFile,
  repairDurabilityUncertaintyMarker,
  retainSecureFileLock,
  releaseSecureFileLock,
} from "./durable-file.js";
import {
  applyCircuitBreakerEvent,
  CIRCUIT_BREAKER_DEFAULTS,
  createCircuitBreakerController,
  createCircuitBreakerState,
  validatePersistedCircuitBreakerState,
} from "./circuit-breaker.js";

// The repository root is intentionally not a breaker trust boundary: it can
// be group-writable in normal deployments. New state lives directly beneath
// the effective user's home, where the directory chain can be verified before
// state, marker, and lock bytes are accepted.
const LEGACY_FILE = repoPath("circuit-breaker.json");
export function resolveCircuitBreakerRuntimeDirectory(runtimeDirectory = process.env.MERIDIAN_BREAKER_RUNTIME_DIR) {
  if (runtimeDirectory == null || runtimeDirectory === "") {
    return path.join(os.homedir(), ".meridian-breaker-runtime");
  }
  if (typeof runtimeDirectory !== "string" || !path.isAbsolute(runtimeDirectory)) {
    throw new Error("MERIDIAN_BREAKER_RUNTIME_DIR must be an absolute private runtime directory");
  }
  return path.normalize(runtimeDirectory);
}

const FILE = path.join(resolveCircuitBreakerRuntimeDirectory(), "circuit-breaker.json");
const DEFAULT_KEY = "meridian:risk-circuit-breaker";
export const CIRCUIT_BREAKER_DURABILITY_REPAIR_CONFIRMATION = "I CONFIRM BREAKER DURABILITY REPAIR";

function lockNameFor(file) {
  return `.${path.basename(file)}.update.lock`;
}

function repairState(atMs) {
  const repaired = createCircuitBreakerState(atMs);
  repaired.tripped = true;
  repaired.manualResumeRequired = true;
  repaired.trippedAtMs = atMs;
  repaired.reasons = ["DURABILITY_UNCERTAINTY_REPAIRED"];
  return repaired;
}

function isDurabilityRepairState(value) {
  try {
    const state = validatePersistedCircuitBreakerState(value);
    return state.tripped === true && state.manualResumeRequired === true &&
      state.reasons.length === 1 && state.reasons[0] === "DURABILITY_UNCERTAINTY_REPAIRED";
  } catch {
    return false;
  }
}

/**
 * File storage keeps a missing file distinct from a corrupt one. The
 * controller accepts only `undefined` as missing; parse/read/type failures
 * intentionally propagate so deploy entry remains blocked until an operator
 * performs an explicit, out-of-band recovery of the persisted file.
 */
function readCircuitBreakerFile(file, fsImpl, { lockOptions, allowHeldLock = false } = {}) {
  let source;
  let result;
  let readError = null;
  let lock = null;
  try {
    if (!allowHeldLock) {
      // The reader holds the same O_EXCL pathname mutex as writers from before
      // it reads state through the committed marker check. A prior negative
      // check cannot close the race where a writer creates its lock between
      // that check and a permissive state read.
      try {
        lock = acquireSecureFileLock(file, { ...lockOptions, timeoutMs: 0, retryMs: 0 });
      } catch (error) {
        if (error?.code === "EWOULDBLOCK") {
          // This inspection never grants a read: it only preserves the
          // precise unsafe-lock diagnostics (mode, ownership, link attacks)
          // before this invocation rejects the observed contention.
          assertNoSecureFileLock(file, {
            fsImpl,
            label: "Circuit breaker state",
            lockName: lockOptions.lockName,
            requirePrivate: true,
          });
          throw new Error(
            "Circuit breaker state has a retained or in-flight update lock; explicit operator recovery is required",
            { cause: error },
          );
        }
        throw error;
      }
    }
    source = readSecureRegularFile(file, {
      fsImpl,
      label: "Circuit breaker state",
      allowMissing: true,
      requirePrivate: true,
    });
    // A retained committed marker proves this exact state was durably
    // published. Any pending, corrupt, foreign, or mismatched marker remains
    // a fail-closed condition before the bytes can influence entry.
    assertNoDurabilityUncertaintyMarker(file, {
      fsImpl,
      label: "Circuit breaker state",
      expectedValue: source?.bytes,
      requirePrivate: true,
    });
    if (source == null) {
      result = { value: undefined, identity: null };
    } else {
      try {
        result = { value: JSON.parse(source.bytes.toString("utf8")), identity: source.stat };
      } catch (error) {
        throw new Error(`Circuit breaker state is unreadable or corrupt: ${error.message}`, { cause: error });
      }
    }
  } catch (error) {
    readError = error;
  } finally {
    if (lock) {
      try {
        const release = releaseSecureFileLock(lock, lockOptions);
        if (release?.diagnostic) {
          const cleanupError = new Error(
            `Circuit breaker read lock cleanup failed after unlink: ${release.diagnostic.message}`,
            { cause: release.diagnostic },
          );
          cleanupError.cleanupLockState = release.cleanupLockState;
          cleanupError.lockUnlinked = true;
          throw cleanupError;
        }
      } catch (cleanupError) {
        // A read cannot claim a durable state result if its own exclusion
        // cleanup was uncertain. Preserve an earlier state-read fault while
        // still recording the cleanup error for callers that inspect causes.
        if (readError) readError.releaseError ??= cleanupError;
        else readError = cleanupError;
      }
    }
  }
  if (readError) {
    if (/^Circuit breaker state is unreadable or corrupt:/.test(readError.message)) throw readError;
    throw new Error(`Circuit breaker state is unreadable: ${readError.message}`, { cause: readError });
  }
  return result;
}

/**
 * `repairDurabilityUncertainty` is deliberately unavailable unless the
 * embedding operator supplies a repairAuthorizer. The repair itself writes a
 * new tripped state; it never grants entry or bypasses manual resume.
 */
export function createFileCircuitBreakerStorage({
  file = FILE,
  fsImpl = fs,
  repairAuthorizer,
  legacyFile = path.resolve(file) === path.resolve(FILE) ? LEGACY_FILE : null,
  lockTimeoutMs,
  lockRetryMs,
} = {}) {
  const resolvedFile = path.resolve(file);
  const resolvedLegacyFile = legacyFile ? path.resolve(legacyFile) : null;
  const lastReadIdentity = new Map();
  const resolvedLockName = lockNameFor(resolvedFile);
  const operationStatus = new Map();
  const lockOptions = {
    fsImpl,
    label: "Circuit breaker state",
    lockName: resolvedLockName,
    durable: true,
    requirePrivate: true,
    ...(Number.isFinite(lockTimeoutMs) ? { timeoutMs: lockTimeoutMs } : {}),
    ...(Number.isFinite(lockRetryMs) ? { retryMs: lockRetryMs } : {}),
  };
  const legacyAcknowledgementFile = path.join(path.dirname(resolvedFile), ".legacy-breaker-state-acknowledged");

  const legacyStateExists = () => {
    if (!resolvedLegacyFile || resolvedLegacyFile === resolvedFile) return false;
    try {
      fsImpl.lstatSync(resolvedLegacyFile);
      return true;
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
  };
  const hasLegacyAcknowledgement = () => {
    if (!resolvedLegacyFile) return true;
    const source = readSecureRegularFile(legacyAcknowledgementFile, {
      fsImpl,
      label: "Circuit breaker legacy migration acknowledgement",
      allowMissing: true,
      requirePrivate: true,
    });
    if (source == null) return false;
    try {
      const record = JSON.parse(source.bytes.toString("utf8"));
      return record?.version === 1 && record?.legacyFile === resolvedLegacyFile &&
        record?.operation === "operator_safe_latch";
    } catch {
      return false;
    }
  };
  const assertLegacyBoundary = () => {
    if (legacyStateExists() && !hasLegacyAcknowledgement()) {
      const error = new Error(
        "Circuit breaker legacy repository state is retained outside the private runtime boundary; explicit operator durability repair is required",
      );
      error.code = "EUCLEAN";
      throw error;
    }
  };
  const read = ({ allowHeldLock = false, bypassLegacyBoundary = false } = {}) => {
    if (!bypassLegacyBoundary) assertLegacyBoundary();
    return readCircuitBreakerFile(resolvedFile, fsImpl, { lockOptions, allowHeldLock });
  };
  const rawCurrent = () => readSecureRegularFile(resolvedFile, {
    fsImpl,
    label: "Circuit breaker state",
    allowMissing: true,
    requirePrivate: true,
  });
  const writeLegacyAcknowledgement = () => {
    if (!resolvedLegacyFile || !legacyStateExists() || hasLegacyAcknowledgement()) return;
    const value = Buffer.from(JSON.stringify({
      version: 1,
      operation: "operator_safe_latch",
      legacyFile: resolvedLegacyFile,
    }), "utf8");
    atomicReplaceSecureFile(legacyAcknowledgementFile, value, {
      fsImpl,
      label: "Circuit breaker legacy migration acknowledgement",
      durable: true,
      requirePrivate: true,
    });
  };
  const markOperationStatus = (key, status) => operationStatus.set(key, Object.freeze({ ...status }));
  const releaseAfterOperation = (lock, { key, committed, operationError }) => {
    try {
      const release = releaseSecureFileLock(lock, lockOptions);
      if (release?.diagnostic) {
        markOperationStatus(key, {
          committed,
          diagnosticCode: release.diagnosticCode,
          diagnostic: release.diagnostic.message,
          cleanupLockState: release.cleanupLockState,
        });
      } else {
        markOperationStatus(key, {
          committed,
          diagnosticCode: null,
          diagnostic: null,
          cleanupLockState: release?.cleanupLockState ?? "retained_or_unknown",
        });
      }
    } catch (releaseError) {
      const cleanupLockState = releaseError.cleanupLockState ?? (
        releaseError.lockUnlinked === true ? "absent" : "retained_or_unknown"
      );
      if (operationError) {
        // The write failure remains the truthful result; a lock cleanup error
        // must not hide an unresolved marker or failed target fsync.
        operationError.releaseError ??= releaseError;
        markOperationStatus(key, { committed, cleanupError: releaseError.message, cleanupLockState });
        return;
      }
      // The committed state remains truthful.  A close error after successful
      // unlink is a descriptor-cleanup diagnostic, not proof that entry is
      // blocked; callers can re-read the current state when that distinction
      // matters. Errors before or without unlink stay fail-closed.
      releaseError.committed = committed === true;
      releaseError.cleanupLockState = cleanupLockState;
      markOperationStatus(key, { committed, cleanupError: releaseError.message, cleanupLockState });
      throw releaseError;
    }
  };
  const retainClaimedLockAfterFailedRepair = (lock, { key, operationError }) => {
    let cleanupError = null;
    try {
      retainSecureFileLock(lock, { fsImpl });
    } catch (error) {
      cleanupError = error;
      if (operationError) operationError.releaseError ??= error;
    }
    markOperationStatus(key, {
      committed: false,
      ...(cleanupError ? { cleanupError: cleanupError.message } : {}),
      cleanupLockState: "retained_or_unknown",
    });
  };
  const save = (key, value, expectedIdentity) => {
    assertLegacyBoundary();
    const lock = acquireSecureFileLock(resolvedFile, lockOptions);
    let committed = false;
    let operationError = null;
    try {
      const identity = atomicReplaceSecureFile(resolvedFile, Buffer.from(JSON.stringify(value, null, 2)), {
        fsImpl,
        label: "Circuit breaker state",
        durable: true,
        expectedIdentity,
        durabilityMarker: true,
        requirePrivate: true,
      });
      lastReadIdentity.set(key, identity);
      committed = true;
    } catch (error) {
      operationError = error;
      throw error;
    } finally {
      releaseAfterOperation(lock, { key, committed, operationError });
    }
  };
  return {
    async load(key) {
      const loaded = read();
      lastReadIdentity.set(key, loaded.identity);
      return loaded.value;
    },
    async save(key, value) {
      // Generic controller users receive optimistic conflict detection instead
      // of silently overwriting a newer process's latch.  Configured runtime
      // mutations below use `mutate` to serialize the full read/reduce/write.
      save(key, value, lastReadIdentity.get(key));
    },
    async mutate(key, reducer) {
      if (typeof reducer !== "function") throw new TypeError("Circuit breaker mutation requires a reducer");
      assertLegacyBoundary();
      const lock = acquireSecureFileLock(resolvedFile, lockOptions);
      let committed = false;
      let operationError = null;
      try {
        const loaded = read({ allowHeldLock: true });
        const next = reducer(loaded.value);
        const identity = atomicReplaceSecureFile(resolvedFile, Buffer.from(JSON.stringify(next, null, 2)), {
          fsImpl,
          label: "Circuit breaker state",
          durable: true,
          expectedIdentity: loaded.identity,
          durabilityMarker: true,
          requirePrivate: true,
        });
        lastReadIdentity.set(key, identity);
        committed = true;
        return next;
      } catch (error) {
        operationError = error;
        throw error;
      } finally {
        releaseAfterOperation(lock, { key, committed, operationError });
      }
    },
    async repairDurabilityUncertainty(key, { authorization, confirmation, atMs = Date.now() } = {}) {
      if (typeof repairAuthorizer !== "function") {
        throw new Error("Circuit breaker durability repair is not authorized for this storage");
      }
      if (!Number.isFinite(atMs)) throw new TypeError("Circuit breaker repair requires a finite timestamp");
      const authorized = await repairAuthorizer({
        key,
        file: resolvedFile,
        authorization,
        confirmation,
        operation: "repair_durability_uncertainty",
      });
      if (authorized !== true) throw new Error("Circuit breaker durability repair is not authorized");

      let lock;
      let claimedRetainedLock = false;
      try {
        lock = acquireSecureFileLock(resolvedFile, lockOptions);
      } catch (error) {
        if (error?.code !== "EWOULDBLOCK") throw error;
        // Normal reads and mutations never take a held lock. Only this
        // already-authorized repair may claim a stale, provenance-bearing
        // lock, and it holds that same pathname throughout the repair.
        lock = claimRetainedSecureFileLock(resolvedFile, lockOptions);
        claimedRetainedLock = true;
      }
      let committed = false;
      let safeLatchCommitted = false;
      let operationError = null;
      try {
        // A repeated authorized repair does not rewrite timestamps, state, or
        // markers once the exact already-repaired durable latch is present.
        const current = rawCurrent();
        let currentValue = null;
        try { currentValue = current == null ? null : JSON.parse(current.bytes.toString("utf8")); } catch {}
        let alreadyRepaired = false;
        if (current && isDurabilityRepairState(currentValue)) {
          try {
            assertNoDurabilityUncertaintyMarker(resolvedFile, {
              fsImpl,
              label: "Circuit breaker state",
              expectedValue: current.bytes,
              requirePrivate: true,
            });
            alreadyRepaired = true;
          } catch {
            alreadyRepaired = false;
          }
        }
        if (alreadyRepaired) {
          safeLatchCommitted = true;
          writeLegacyAcknowledgement();
          lastReadIdentity.set(key, current.stat);
          committed = true;
          return currentValue;
        }
        // Repair is intentionally a new manual latch, never a resume. An
        // operator must perform the ordinary, separately audited resume after
        // this function has restored a known durable state.
        const repaired = repairState(atMs);
        const identity = repairDurabilityUncertaintyMarker(
          resolvedFile,
          Buffer.from(JSON.stringify(repaired, null, 2)),
          { fsImpl, label: "Circuit breaker state", durable: true, requirePrivate: true },
        );
        safeLatchCommitted = true;
        writeLegacyAcknowledgement();
        lastReadIdentity.set(key, identity);
        committed = true;
        return repaired;
      } catch (error) {
        operationError = error;
        throw error;
      } finally {
        if (claimedRetainedLock && !safeLatchCommitted) {
          retainClaimedLockAfterFailedRepair(lock, { key, operationError });
        } else {
          releaseAfterOperation(lock, { key, committed, operationError });
        }
      }
    },
    getLastOperationStatus(key) {
      return operationStatus.get(key) ?? null;
    },
  };
}

let runtimeRepairOperatorCapability = null;

/**
 * The process entrypoint registers one opaque object that never reaches model
 * providers or tool schemas. The exact confirmation phrase remains a second,
 * human-visible authorization factor at the operator boundary.
 */
export function registerCircuitBreakerRepairOperatorCapability(capability) {
  if ((typeof capability !== "object" && typeof capability !== "function") || capability == null) {
    throw new TypeError("Circuit breaker repair capability must be an opaque object");
  }
  if (runtimeRepairOperatorCapability && runtimeRepairOperatorCapability !== capability) {
    throw new Error("Circuit breaker repair capability is already registered");
  }
  runtimeRepairOperatorCapability = capability;
}

const storage = createFileCircuitBreakerStorage({
  repairAuthorizer: ({ authorization, confirmation, operation }) => (
    runtimeRepairOperatorCapability != null &&
    authorization === runtimeRepairOperatorCapability &&
    confirmation === CIRCUIT_BREAKER_DURABILITY_REPAIR_CONFIRMATION &&
    operation === "repair_durability_uncertainty"
  ),
});

function positiveIntegerOrDefault(value, fallback) {
  return Number.isInteger(value) && value >= 1 ? value : fallback;
}

function nonNegativeFiniteOrDefault(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function negativeFiniteOrDefault(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) && value < 0 ? value : fallback;
}

/**
 * Translate only the configuration fields represented by the controller.
 * Unsupported controller options retain their audited policy defaults rather
 * than accepting arbitrary runtime configuration values.
 */
export function resolveCircuitBreakerPolicy(circuitBreaker = {}) {
  return Object.freeze({
    // A disabled policy is not a permission bypass. The runtime keeps entry
    // closed until a valid enabled policy is loaded on a later process start.
    enabled: circuitBreaker?.enabled === true,
    defaults: Object.freeze({
      ...CIRCUIT_BREAKER_DEFAULTS,
      maximumConsecutiveNetLosses: positiveIntegerOrDefault(
        circuitBreaker?.consecutiveLosses,
        CIRCUIT_BREAKER_DEFAULTS.maximumConsecutiveNetLosses,
      ),
      singleTradeLossPctExclusive: negativeFiniteOrDefault(
        circuitBreaker?.singleLossPct,
        CIRCUIT_BREAKER_DEFAULTS.singleTradeLossPctExclusive,
      ),
      minimumRollingLossLimitSol: nonNegativeFiniteOrDefault(
        circuitBreaker?.dailyLossMinSol,
        CIRCUIT_BREAKER_DEFAULTS.minimumRollingLossLimitSol,
      ),
      rollingLossLimitEquityPct: nonNegativeFiniteOrDefault(
        circuitBreaker?.dailyLossPct,
        CIRCUIT_BREAKER_DEFAULTS.rollingLossLimitEquityPct,
      ),
      canaryMaximumDrawdownPct: nonNegativeFiniteOrDefault(
        circuitBreaker?.canaryDrawdownPct,
        CIRCUIT_BREAKER_DEFAULTS.canaryMaximumDrawdownPct,
      ),
      maximumConsecutiveOperationalFailures: positiveIntegerOrDefault(
        circuitBreaker?.consecutiveOperationalFailures,
        CIRCUIT_BREAKER_DEFAULTS.maximumConsecutiveOperationalFailures,
      ),
    }),
  });
}

/**
 * The controller persists state, but callers can arrive concurrently from a
 * close, swap, and cleanup continuation. Serialize runtime mutations so a
 * later write never drops an earlier trip or manual-resume requirement.
 */
export function createSerializedBreakerRuntime({
  controller: breakerController,
  enabled = true,
} = {}) {
  if (!breakerController) throw new TypeError("controller is required");
  let tail = Promise.resolve();
  const enqueue = (operation) => {
    const next = tail.then(operation, operation);
    tail = next.catch(() => {});
    return next;
  };
  return {
    getState: () => enqueue(() => breakerController.getState()),
    entryAllowed: () => enqueue(async () => {
      // Load first even when disabled so unreadable/corrupt state continues to
      // fail closed rather than being silently masked by configuration.
      const controllerAllowsEntry = await breakerController.entryAllowed();
      return enabled === true && controllerAllowsEntry;
    }),
    record: (event) => enqueue(() => breakerController.record(event)),
    manualResume: (atMs = Date.now()) => enqueue(() => breakerController.manualResume(atMs)),
    repairDurabilityUncertainty: (options = {}) => enqueue(() => {
      if (typeof breakerController.repairDurabilityUncertainty !== "function") {
        throw new Error("Circuit breaker durability repair is unavailable for this runtime");
      }
      return breakerController.repairDurabilityUncertainty(options);
    }),
  };
}

function createSerializedFileBreakerController({ storage, key, defaults, riskPolicy, now = Date.now }) {
  const loadCurrent = async () => {
    const loaded = await storage.load(key);
    return loaded === undefined
      ? createCircuitBreakerState(now())
      : validatePersistedCircuitBreakerState(loaded);
  };
  const record = async (event) => storage.mutate(key, (loaded) => {
    const current = loaded === undefined
      ? createCircuitBreakerState(now())
      : validatePersistedCircuitBreakerState(loaded);
    return applyCircuitBreakerEvent(current, event, defaults, riskPolicy);
  });
  return {
    getState: loadCurrent,
    record,
    manualResume: (atMs = now()) => record({ type: "manual_resume", atMs }),
    repairDurabilityUncertainty: (options = {}) => storage.repairDurabilityUncertainty(key, options),
    async entryAllowed() {
      const current = await loadCurrent();
      return !current.tripped && !current.manualResumeRequired;
    },
  };
}

export function createConfiguredBreakerRuntime({
  storage: runtimeStorage,
  circuitBreaker = config.circuitBreaker,
  key = DEFAULT_KEY,
  riskPolicy,
  now,
} = {}) {
  const policy = resolveCircuitBreakerPolicy(circuitBreaker);
  const breakerController = typeof runtimeStorage?.mutate === "function"
    ? createSerializedFileBreakerController({
      storage: runtimeStorage,
      key,
      defaults: policy.defaults,
      riskPolicy,
      now,
    })
    : createCircuitBreakerController({
      storage: runtimeStorage,
      key,
      defaults: policy.defaults,
      riskPolicy,
      now,
    });
  return createSerializedBreakerRuntime({ controller: breakerController, enabled: policy.enabled });
}

const runtime = createConfiguredBreakerRuntime({ storage });

export const getCircuitBreakerState = () => runtime.getState();
export const circuitBreakerEntryAllowed = () => runtime.entryAllowed();
export const recordCircuitBreakerEvent = (event) => runtime.record(event);
export const manuallyResumeCircuitBreaker = (atMs = Date.now()) => runtime.manualResume(atMs);
export const getCircuitBreakerPersistenceStatus = () => storage.getLastOperationStatus(DEFAULT_KEY);
export const repairCircuitBreakerDurability = ({
  confirmation,
  operatorCapability,
  atMs = Date.now(),
} = {}) => runtime.repairDurabilityUncertainty({
  confirmation,
  authorization: operatorCapability,
  atMs,
});
