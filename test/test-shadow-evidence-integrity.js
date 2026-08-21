import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import {
  appendShadowEvidenceHeartbeat,
  evaluateShadowEvidence,
} from "../rollout-evidence.js";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-shadow-evidence-"));
const nowMs = Date.parse("2026-07-02T00:00:00.000Z");

function appendHeartbeat(filePath, minute = 0) {
  return appendShadowEvidenceHeartbeat({
    filePath,
    runId: "integrity-run",
    now: new Date(nowMs + minute * 60_000),
    lifecycles: [],
    cycle: { started_open_positions: 0, started_deployed_amount_sol: 0, observation_failures: [] },
  });
}

function swapAtFinalOpen(filename, swap, action) {
  const originalOpenSync = fs.openSync;
  let swapped = false;
  fs.openSync = function patchedOpenSync(filePath, ...args) {
    if (!swapped && typeof filePath === "string" &&
      filePath.startsWith("/proc/self/fd/") && path.basename(filePath) === filename) {
      swap();
      swapped = true;
    }
    return originalOpenSync.call(fs, filePath, ...args);
  };
  try {
    return { result: action(), swapped };
  } finally {
    fs.openSync = originalOpenSync;
  }
}

function appendWorker({ filePath, runId, atMs }) {
  const worker = new Worker(`
    const { parentPort, workerData } = require("node:worker_threads");
    (async () => {
      try {
        const { appendShadowEvidenceHeartbeat } = await import(workerData.moduleUrl);
        const record = appendShadowEvidenceHeartbeat({
          filePath: workerData.filePath,
          runId: workerData.runId,
          now: new Date(workerData.atMs),
          lifecycles: [],
          cycle: { started_open_positions: 0, started_deployed_amount_sol: 0, observation_failures: [] },
        });
        parentPort.postMessage({ sequence: record.sequence });
      } catch (error) {
        parentPort.postMessage({ error: error.message });
      }
    })();
  `, {
    eval: true,
    workerData: {
      moduleUrl: new URL("../rollout-evidence.js", import.meta.url).href,
      filePath,
      runId,
      atMs,
    },
  });
  return new Promise((resolve, reject) => {
    worker.once("message", (message) => {
      if (message?.error) reject(new Error(message.error));
      else resolve(message);
    });
    worker.once("error", reject);
  });
}

try {
  const normalPath = path.join(tempDir, "normal.jsonl");
  const first = appendHeartbeat(normalPath);
  const second = appendHeartbeat(normalPath, 1);
  assert.equal(first.sequence, 1);
  assert.equal(second.sequence, 2);
  const normalBytes = fs.readFileSync(normalPath);
  const normal = evaluateShadowEvidence({ filePath: normalPath, runId: "integrity-run", now: new Date(nowMs + 60_000) });
  assert.equal(normal.available, true);
  assert.equal(normal.source.record_count, 2);
  assert.equal(normal.source.sha256, crypto.createHash("sha256").update(normalBytes).digest("hex"));

  const auditPath = path.join(tempDir, "audit-fields.jsonl");
  const auditRecord = appendShadowEvidenceHeartbeat({
    filePath: auditPath,
    runId: "audit-run",
    now: new Date(nowMs),
    cycle: { started_open_positions: 1, started_deployed_amount_sol: 0.1, observation_failures: [] },
    lifecycles: [{
      lifecycle_id: "paper:audit",
      run_id: "audit-run",
      deployed_at: new Date(nowMs - 60_000).toISOString(),
      lifecycle_status: "OPEN",
      terminal_state: null,
      amount_sol: 0.1,
      entry: {
        pool: "pool",
        pool_name: "AUDIT/SOL",
        base_mint: "mint",
        strategy: "bid_ask",
        bin_range: { min: 90, max: 100, bins_below: 10, bins_above: 0 },
        fee_tvl_ratio: 0.1,
        fee_timeframe: "30m",
        volatility: 1.2,
        policy_snapshot: { momentum5m: { rsi: 60 } },
      },
      last_observed_at: new Date(nowMs).toISOString(),
      last_observation: {
        active_bin: 99,
        active_price: 1.01,
        active_price_raw: 0.00101,
        in_range: true,
        status: "in_range",
        price_change_pct: -1,
        price_change_source: "bin_step",
        price_scale_warning: "price_scale_mismatch:1000x",
        price_normalization_source: "bin_step",
        bin_distance_to_range: 0,
      },
      valuation: {
        model: "conservative_single_side_sol_proxy",
        version: "shadow-v2",
        last_valued_at: new Date(nowMs).toISOString(),
        price_return_pct: -1,
        conservative_price_return_pct: -0.1,
        range_exposure_pct: 10,
        equity_net_sol: 0.0995,
        projected_net_pnl_sol: -0.0005,
        estimated_round_trip_cost_sol: 0.0004,
        estimated_fee_accrual_sol: 0.00001,
        estimated_fee_increment_sol: 0.000002,
        fee_accrual_interval_minutes: 1,
        fee_timeframe_minutes: 30,
        fee_tvl_ratio_24h_equivalent_pct: 4.8,
        pnl_basis_valid: true,
      },
    }],
  });
  const auditLifecycle = auditRecord.lifecycles[0];
  assert.equal(auditLifecycle.entry.fee_timeframe, "30m");
  assert.equal(auditLifecycle.last_observation.active_price_raw, 0.00101);
  assert.equal(auditLifecycle.last_observation.price_normalization_source, "bin_step");
  assert.equal(auditLifecycle.valuation.version, "shadow-v2");
  assert.equal(auditLifecycle.valuation.fee_timeframe_minutes, 30);
  assert.equal(auditLifecycle.valuation.estimated_fee_increment_sol, 0.000002);

  const hardLinkedNormal = path.join(tempDir, "normal-hardlink.jsonl");
  fs.linkSync(normalPath, hardLinkedNormal);
  const hardLinked = evaluateShadowEvidence({ filePath: normalPath, runId: "integrity-run", now: new Date(nowMs + 60_000) });
  assert.equal(hardLinked.available, false, "hard-linked evidence is insecure and must fail closed");
  assert.equal(hardLinked.reason, "SHADOW_EVIDENCE_NOT_REGULAR_FILE");

  const partialPath = path.join(tempDir, "partial.jsonl");
  fs.writeFileSync(partialPath, '{"incomplete":true}');
  const partial = evaluateShadowEvidence({ filePath: partialPath, now: new Date(nowMs) });
  assert.equal(partial.available, false);
  assert.equal(partial.reason, "SHADOW_EVIDENCE_MALFORMED_OR_PARTIAL");
  assert.throws(() => appendHeartbeat(partialPath), /malformed or partial JSONL/);

  const rollbackPath = path.join(tempDir, "rollback.jsonl");
  appendHeartbeat(rollbackPath);
  const rollbackBefore = fs.readFileSync(rollbackPath);
  const originalWriteSync = fs.writeSync;
  let partialWriteInjected = false;
  fs.writeSync = function patchedWriteSync(descriptor, bytes, offset, length, position) {
    if (!partialWriteInjected) {
      partialWriteInjected = true;
      return originalWriteSync.call(fs, descriptor, bytes, offset, Math.min(17, length), position);
    }
    throw new Error("injected partial write failure");
  };
  try {
    assert.throws(() => appendHeartbeat(rollbackPath, 1), /injected partial write failure/);
  } finally {
    fs.writeSync = originalWriteSync;
  }
  assert.deepEqual(fs.readFileSync(rollbackPath), rollbackBefore, "short-write failure rolls back to the captured original size");
  assert.equal(evaluateShadowEvidence({ filePath: rollbackPath, runId: "integrity-run", now: new Date(nowMs) }).source.record_count, 1);

  const unlinkPath = path.join(tempDir, "unlink-during-write.jsonl");
  appendHeartbeat(unlinkPath);
  const unlinkWriteSync = fs.writeSync;
  let unlinked = false;
  fs.writeSync = function patchedWriteSync(descriptor, bytes, offset, length, position) {
    const written = unlinkWriteSync.call(fs, descriptor, bytes, offset, length, position);
    if (!unlinked) {
      fs.unlinkSync(unlinkPath);
      unlinked = true;
    }
    return written;
  };
  try {
    assert.throws(() => appendHeartbeat(unlinkPath, 1), /unlinked|renamed|replaced/i);
  } finally {
    fs.writeSync = unlinkWriteSync;
  }
  assert.equal(unlinked, true);
  assert.equal(fs.existsSync(unlinkPath), false, "append never reports success for its now-unreachable inode");
  assert.equal(evaluateShadowEvidence({ filePath: unlinkPath, now: new Date(nowMs) }).reason, "SHADOW_EVIDENCE_MISSING");

  const replacementPath = path.join(tempDir, "replace-after-write.jsonl");
  const parkedReplacementPath = path.join(tempDir, "replace-after-write-parked.jsonl");
  appendHeartbeat(replacementPath);
  const replacementBefore = fs.readFileSync(replacementPath);
  const replacementWriteSync = fs.writeSync;
  let replaced = false;
  fs.writeSync = function patchedWriteSync(descriptor, bytes, offset, length, position) {
    const written = replacementWriteSync.call(fs, descriptor, bytes, offset, length, position);
    if (!replaced) {
      fs.renameSync(replacementPath, parkedReplacementPath);
      fs.writeFileSync(replacementPath, "replacement must not receive a heartbeat\n");
      replaced = true;
    }
    return written;
  };
  try {
    assert.throws(() => appendHeartbeat(replacementPath, 1), /replaced|renamed|unlinked/i);
  } finally {
    fs.writeSync = replacementWriteSync;
  }
  assert.equal(replaced, true);
  assert.equal(fs.readFileSync(replacementPath, "utf8"), "replacement must not receive a heartbeat\n");
  assert.deepEqual(fs.readFileSync(parkedReplacementPath), replacementBefore, "renamed original is rolled back before append reports failure");

  const concurrentPath = path.join(tempDir, "concurrent.jsonl");
  const concurrentLock = path.join(tempDir, ".concurrent.jsonl.append.lock");
  fs.writeFileSync(concurrentLock, "test lock");
  const firstWriter = appendWorker({ filePath: concurrentPath, runId: "concurrent-run", atMs: nowMs });
  const secondWriter = appendWorker({ filePath: concurrentPath, runId: "concurrent-run", atMs: nowMs + 60_000 });
  await new Promise((resolve) => setTimeout(resolve, 30));
  fs.unlinkSync(concurrentLock);
  const concurrentResults = await Promise.all([firstWriter, secondWriter]);
  assert.deepEqual(concurrentResults.map((entry) => entry.sequence).sort(), [1, 2]);
  const concurrentRecords = fs.readFileSync(concurrentPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(concurrentRecords.map((record) => record.sequence), [1, 2], "exclusive lock serializes run-chain sequence allocation");

  const finalTarget = path.join(tempDir, "final-target.jsonl");
  const finalLink = path.join(tempDir, "final-link.jsonl");
  fs.writeFileSync(finalTarget, "target must not be touched\n");
  fs.symlinkSync(finalTarget, finalLink);
  const finalSymlink = evaluateShadowEvidence({ filePath: finalLink, now: new Date(nowMs) });
  assert.equal(finalSymlink.available, false);
  assert.equal(finalSymlink.reason, "SHADOW_EVIDENCE_NOT_REGULAR_FILE");
  assert.throws(() => appendHeartbeat(finalLink), /regular file|symlink|secure/i);
  assert.equal(fs.readFileSync(finalTarget, "utf8"), "target must not be touched\n");

  const nonRegularPath = path.join(tempDir, "non-regular-evidence");
  fs.mkdirSync(nonRegularPath);
  const nonRegular = evaluateShadowEvidence({ filePath: nonRegularPath, now: new Date(nowMs) });
  assert.equal(nonRegular.available, false);
  assert.equal(nonRegular.reason, "SHADOW_EVIDENCE_NOT_REGULAR_FILE");
  assert.throws(() => appendHeartbeat(nonRegularPath), /regular file|directory|secure/i);

  const actualAncestor = path.join(tempDir, "actual-ancestor");
  const linkedAncestor = path.join(tempDir, "linked-ancestor");
  const ancestorEvidence = path.join(linkedAncestor, "evidence.jsonl");
  fs.mkdirSync(actualAncestor);
  fs.symlinkSync(actualAncestor, linkedAncestor);
  const ancestorSymlink = evaluateShadowEvidence({ filePath: ancestorEvidence, now: new Date(nowMs) });
  assert.equal(ancestorSymlink.available, false);
  assert.equal(ancestorSymlink.reason, "SHADOW_EVIDENCE_NOT_REGULAR_FILE");
  assert.throws(() => appendHeartbeat(ancestorEvidence), /symlink|secure/i);
  assert.equal(fs.existsSync(path.join(actualAncestor, "evidence.jsonl")), false);

  const readRacePath = path.join(tempDir, "read-race.jsonl");
  appendHeartbeat(readRacePath);
  const evaluatedBytes = fs.readFileSync(readRacePath);
  const expectedHash = crypto.createHash("sha256").update(evaluatedBytes).digest("hex");
  const parkedReadRace = path.join(tempDir, "read-race-parked.jsonl");
  const originalReadFileSync = fs.readFileSync;
  let readRaceSwapped = false;
  fs.readFileSync = function patchedReadFileSync(descriptor, ...args) {
    const bytes = originalReadFileSync.call(fs, descriptor, ...args);
    if (!readRaceSwapped && typeof descriptor === "number") {
      fs.renameSync(readRacePath, parkedReadRace);
      fs.writeFileSync(readRacePath, "replacement bytes must not be authorized\n");
      readRaceSwapped = true;
    }
    return bytes;
  };
  let readRace;
  try {
    readRace = evaluateShadowEvidence({ filePath: readRacePath, runId: "integrity-run", now: new Date(nowMs) });
  } finally {
    fs.readFileSync = originalReadFileSync;
  }
  assert.equal(readRaceSwapped, true);
  assert.equal(readRace.available, true);
  assert.equal(readRace.source.record_count, 1);
  assert.equal(readRace.source.sha256, expectedHash);
  assert.notEqual(readRace.source.sha256, crypto.createHash("sha256").update(fs.readFileSync(readRacePath)).digest("hex"));

  const parentRace = path.join(tempDir, "parent-race");
  const parkedParentRace = path.join(tempDir, "parent-race-parked");
  const redirectParentRace = path.join(tempDir, "parent-race-redirect");
  const parentRaceFilename = "evidence.jsonl";
  fs.mkdirSync(parentRace);
  fs.mkdirSync(redirectParentRace);
  const parentSwap = swapAtFinalOpen(parentRaceFilename, () => {
    fs.renameSync(parentRace, parkedParentRace);
    fs.symlinkSync(redirectParentRace, parentRace);
  }, () => assert.throws(
    () => appendHeartbeat(path.join(parentRace, parentRaceFilename)),
    /symlink|changed|secure/i,
  ));
  assert.equal(parentSwap.swapped, true);
  assert.equal(fs.existsSync(path.join(redirectParentRace, parentRaceFilename)), false);

  const finalRaceParent = path.join(tempDir, "final-race");
  const finalRacePath = path.join(finalRaceParent, "evidence.jsonl");
  const parkedFinalRace = path.join(tempDir, "final-race-parked.jsonl");
  fs.mkdirSync(finalRaceParent);
  appendHeartbeat(finalRacePath);
  const finalSwap = swapAtFinalOpen("evidence.jsonl", () => {
    fs.renameSync(finalRacePath, parkedFinalRace);
    fs.writeFileSync(finalRacePath, "replacement must not receive a heartbeat\n");
  }, () => assert.throws(
    () => appendHeartbeat(finalRacePath, 1),
    /changed|regular file|secure/i,
  ));
  assert.equal(finalSwap.swapped, true);
  assert.equal(fs.readFileSync(finalRacePath, "utf8"), "replacement must not receive a heartbeat\n");

  console.log("shadow evidence integrity tests passed");
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
