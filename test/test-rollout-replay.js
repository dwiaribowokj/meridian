import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { repoPath } from "../repo-root.js";
import { appendShadowEvidenceHeartbeat } from "../rollout-evidence.js";
import { SHADOW_ROTATION_STRATEGY_PROFILE } from "../risk-policy.js";
import {
  buildLegacyReplay,
  evaluateHistoricalReplaySource,
  evaluateRolloutAcceptance,
  resolveRuntimeStateFile,
  writeAcceptanceArtifact,
  writeLegacyReplay,
} from "../tools/rollout-safety.js";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-rollout-safety-"));
const runtimeStatePath = path.join(tempDir, "runtime-state.json");
process.env.MERIDIAN_STATE_FILE = runtimeStatePath;
fs.writeFileSync(runtimeStatePath, JSON.stringify({ positions: {} }));
const HOUR = 60 * 60_000;
const MINUTE = 60_000;

function settledLifecycle(runId, index, atMs, principal = 0.2, netPnlSol = 0.0004) {
  const finalEquity = principal + netPnlSol;
  return {
    lifecycle_id: `paper:${index}`,
    run_id: runId,
    deployed_at: new Date(atMs - 15 * MINUTE).toISOString(),
    lifecycle_status: "SETTLED",
    terminal_state: "CLOSED_SETTLED",
    amount_sol: principal,
    settlement: {
      settled_at: new Date(atMs).toISOString(),
      initial_principal_sol: principal,
      final_equity_sol: finalEquity,
      net_pnl_sol: finalEquity - principal,
      estimated_round_trip_cost_sol: 0.001,
    },
    reconciliation: {
      simulated: true,
      verified: true,
      verified_at: new Date(atMs).toISOString(),
      expected_final_equity_sol: finalEquity,
      observed_final_equity_sol: finalEquity,
      error_sol: 0,
    },
    cleanup: { simulated: true, verified: true, verified_at: new Date(atMs).toISOString(), no_wallet_or_transactions: true },
  };
}

function openLifecycle(runId, index, atMs, equity = 0.2, principal = 0.2) {
  return {
    lifecycle_id: `paper:${index}`,
    run_id: runId,
    deployed_at: new Date(atMs - 15 * MINUTE).toISOString(),
    lifecycle_status: "OPEN",
    terminal_state: null,
    amount_sol: principal,
    last_observed_at: new Date(atMs).toISOString(),
    valuation: {
      last_valued_at: new Date(atMs).toISOString(),
      equity_net_sol: equity,
      projected_net_pnl_sol: equity - principal,
      estimated_round_trip_cost_sol: 0.001,
      pnl_basis_valid: true,
    },
  };
}

function appendRun({
  filePath,
  runId,
  startMs,
  heartbeats = 97,
  unresolved = false,
  short = false,
  firstOpenEquity = 0.2,
  failureAt = null,
  rolloutStage,
  deployAmountSol = 0.2,
  settledNetPnlSolByIndex = null,
}) {
  for (let sequence = 0; sequence < heartbeats; sequence += 1) {
    const atMs = startMs + (short ? sequence * 4_000 : sequence * 15 * MINUTE);
    const settledCount = Math.min(5, sequence);
    const lifecycles = Array.from({ length: settledCount }, (_, index) => settledLifecycle(
      runId,
      index,
      atMs,
      deployAmountSol,
      settledNetPnlSolByIndex?.[index] ?? 0.0004,
    ));
    if (settledCount < 5) lifecycles.push(openLifecycle(
      runId,
      settledCount,
      atMs,
      sequence === 0 ? firstOpenEquity : deployAmountSol,
      deployAmountSol,
    ));
    if (unresolved && sequence >= 5) lifecycles.push(openLifecycle(runId, "unresolved", atMs, deployAmountSol, deployAmountSol));
    appendShadowEvidenceHeartbeat({
      filePath,
      runId,
      strategyProfile: SHADOW_ROTATION_STRATEGY_PROFILE,
      now: new Date(atMs),
      rolloutStage,
      lifecycles,
      cycle: {
        started_open_positions: settledCount < 5 || unresolved ? 1 : 0,
        started_deployed_amount_sol: settledCount < 5 || unresolved ? deployAmountSol : 0,
        observation_failures: sequence === failureAt ? [{ lifecycle_id: "paper:0", message: "injected observation failure" }] : [],
      },
      breaker: {
        tripped: false,
        manualResumeRequired: false,
        lastEventAtMs: atMs,
      },
    });
  }
}

function swapParentDuringAnchoredOpen({ parent, parkedParent, filename, write }) {
  const originalOpenSync = fs.openSync;
  let swapped = false;
  fs.openSync = function patchedOpenSync(filePath, ...args) {
    if (!swapped && typeof filePath === "string" &&
      filePath.startsWith("/proc/self/fd/") && path.basename(filePath) === filename) {
      fs.renameSync(parent, parkedParent);
      fs.symlinkSync(repoPath("."), parent);
      swapped = true;
    }
    return originalOpenSync.call(fs, filePath, ...args);
  };
  try {
    return { result: write(), swapped };
  } finally {
    fs.openSync = originalOpenSync;
  }
}

try {
  const positions = Object.fromEntries(Array.from({ length: 30 }, (_, index) => {
    const complete = index < 2;
    return [`legacy-${index}`, {
      position: `legacy-${index}`,
      pool: `pool-${index}`,
      closed: true,
      deployed_at: "2026-07-01T00:00:00.000Z",
      closed_at: "2026-07-01T01:00:00.000Z",
      amount_sol: 0.1,
      ...(complete ? {
        position_sol_deployed: 0.1,
        position_sol_withdrawn: 0.101,
        position_sol_fees: 0.001,
        position_sol_final: 0.101,
        position_sol_pnl: 0.001,
        wallet_sol_roundtrip_delta_after_autoswap: 0.001,
      } : {}),
    }];
  }));
  const replay = buildLegacyReplay({ positions }, {
    source: "fixture-state.json",
    now: "2026-07-02T00:00:00.000Z",
  });
  const authoritativeStatePath = runtimeStatePath;
  fs.writeFileSync(authoritativeStatePath, JSON.stringify({ positions }));
  assert.equal(resolveRuntimeStateFile({ MERIDIAN_STATE_FILE: authoritativeStatePath }), authoritativeStatePath);
  assert.equal(resolveRuntimeStateFile({}), repoPath("state.json"));
  assert.equal(replay.records.length, 30);
  assert.equal(replay.metrics.dry_run_gate.pass, true);
  assert.equal(replay.metrics.data_quality.economics_complete_count, 2);
  assert.equal(replay.metrics.data_quality.usable_for_financial_canary_gates, false);
  assert.ok(replay.records[2].data_quality.flags.includes("MISSING_COMPLETE_SOL_ECONOMICS"));

  const replayOutput = path.join(tempDir, "legacy-replay");
  const writtenReplay = writeLegacyReplay(replay, replayOutput);
  assert.ok(fs.existsSync(writtenReplay.replayPath));
  assert.ok(fs.existsSync(writtenReplay.metricsPath));
  assert.throws(() => writeLegacyReplay(replay, replayOutput), /existing path/i);
  assert.throws(() => writeLegacyReplay(replay, repoPath("unsafe-rollout-output")), /outside the repository/i);

  const sourceSymlink = path.join(tempDir, "historical-state-symlink.json");
  fs.symlinkSync(authoritativeStatePath, sourceSymlink);
  const symlinkSource = evaluateHistoricalReplaySource({ statePath: sourceSymlink, now: new Date("2026-07-02T00:00:00.000Z") });
  assert.equal(symlinkSource.available, false);
  assert.equal(symlinkSource.reason, "HISTORICAL_REPLAY_SOURCE_NOT_REGULAR_FILE");

  const sourceDirectory = path.join(tempDir, "historical-source-directory");
  const sourceDirectoryLink = path.join(tempDir, "historical-source-directory-link");
  fs.mkdirSync(sourceDirectory);
  fs.writeFileSync(path.join(sourceDirectory, "state.json"), JSON.stringify({ positions }));
  fs.symlinkSync(sourceDirectory, sourceDirectoryLink);
  const ancestorSymlinkSource = evaluateHistoricalReplaySource({
    statePath: path.join(sourceDirectoryLink, "state.json"),
    now: new Date("2026-07-02T00:00:00.000Z"),
  });
  assert.equal(ancestorSymlinkSource.available, false);
  assert.equal(ancestorSymlinkSource.reason, "HISTORICAL_REPLAY_SOURCE_NOT_REGULAR_FILE");

  const nowMs = Date.parse("2026-07-02T00:00:00.000Z");
  const evidencePath = path.join(tempDir, "sampled-shadow-evidence.jsonl");
  appendRun({ filePath: evidencePath, runId: "sampled-run", startMs: nowMs - 24 * HOUR });
  const acceptance = evaluateRolloutAcceptance({
    historicalStatePath: authoritativeStatePath,
    // This replay metric remains a diagnostic attachment. The canary gate uses
    // the raw state snapshot above, re-read and hashed during evaluation.
    historicalMetrics: replay.metrics,
    historicalMetricsPath: writtenReplay.metricsPath,
    shadowEvidencePath: evidencePath,
    shadowRunId: "sampled-run",
    now: new Date(nowMs),
  });
  assert.equal(acceptance.dry_run.ready, true, "authoritative historical replay coverage is met");
  assert.equal(acceptance.canary.gates.historical_replay.pass, true);
  assert.equal(acceptance.historical_replay.recomputed_from_source, true);
  assert.equal(acceptance.historical_replay.source.file, authoritativeStatePath);
  assert.equal(acceptance.shadow_baseline.settled_lifecycle_count, 5);
  assert.equal(acceptance.canary.gates.heartbeat_coverage.pass, true);
  assert.equal(acceptance.canary.gates.reconciliation.pass, true);
  assert.equal(acceptance.canary.gates.cleanup.pass, true);
  assert.equal(acceptance.canary.gates.breaker.pass, true);
  assert.equal(acceptance.canary.gates.data_quality.pass, true);
  assert.equal(acceptance.canary.gates.profit_factor.pass, true);
  assert.equal(acceptance.canary.gates.max_single_loss.pass, true);
  assert.equal(acceptance.canary.ready, true, "a complete, sampled source run can pass pure evaluation");

  const lowProfitFactorPath = path.join(tempDir, "low-profit-factor-shadow-evidence.jsonl");
  appendRun({
    filePath: lowProfitFactorPath,
    runId: "low-profit-factor-run",
    startMs: nowMs - 24 * HOUR,
    settledNetPnlSolByIndex: [0.0011, 0.0011, -0.001, -0.001, 0],
  });
  const lowProfitFactorAcceptance = evaluateRolloutAcceptance({
    historicalStatePath: authoritativeStatePath,
    shadowEvidencePath: lowProfitFactorPath,
    shadowRunId: "low-profit-factor-run",
    now: new Date(nowMs),
  });
  assert.equal(lowProfitFactorAcceptance.canary.gates.net_sol.pass, true);
  assert.equal(lowProfitFactorAcceptance.canary.gates.profit_factor.pass, false);
  assert.equal(lowProfitFactorAcceptance.canary.gates.max_single_loss.pass, true);
  assert.equal(lowProfitFactorAcceptance.canary.ready, false);

  const tailLossPath = path.join(tempDir, "tail-loss-shadow-evidence.jsonl");
  appendRun({
    filePath: tailLossPath,
    runId: "tail-loss-run",
    startMs: nowMs - 24 * HOUR,
    settledNetPnlSolByIndex: [0.004, 0.004, -0.006, 0.001, 0.001],
  });
  const tailLossAcceptance = evaluateRolloutAcceptance({
    historicalStatePath: authoritativeStatePath,
    shadowEvidencePath: tailLossPath,
    shadowRunId: "tail-loss-run",
    now: new Date(nowMs),
  });
  assert.equal(tailLossAcceptance.canary.gates.net_sol.pass, true);
  assert.equal(tailLossAcceptance.canary.gates.profit_factor.pass, true);
  assert.equal(tailLossAcceptance.canary.gates.max_single_loss.pass, false);
  assert.equal(tailLossAcceptance.canary.gates.max_single_loss.reason, "MAX_SINGLE_LOSS_EXCEEDED");
  assert.equal(tailLossAcceptance.canary.ready, false);

  const legacyAmountEvidencePath = path.join(tempDir, "legacy-amount-shadow-evidence.jsonl");
  appendRun({
    filePath: legacyAmountEvidencePath,
    runId: "legacy-amount-run",
    startMs: nowMs - 24 * HOUR,
    deployAmountSol: 0.1,
    firstOpenEquity: 0.1,
  });
  const legacyAmountAcceptance = evaluateRolloutAcceptance({
    historicalStatePath: authoritativeStatePath,
    shadowEvidencePath: legacyAmountEvidencePath,
    shadowRunId: "legacy-amount-run",
    now: new Date(nowMs),
  });
  assert.equal(legacyAmountAcceptance.canary.ready, false);
  assert.equal(legacyAmountAcceptance.canary.gates.deployment_amount.pass, false);
  assert.equal(legacyAmountAcceptance.canary.gates.deployment_amount.reason, "CANARY_DEPLOYMENT_AMOUNT_MISMATCH");

  const acceptancePath = path.join(tempDir, "acceptance.json");
  assert.equal(writeAcceptanceArtifact(acceptance, acceptancePath), acceptancePath);
  const artifact = JSON.parse(fs.readFileSync(acceptancePath, "utf8"));
  assert.equal(artifact.shadow_baseline.run_id, "sampled-run");
  assert.equal(typeof artifact.source_hashes.shadow_evidence, "string");
  assert.equal(typeof artifact.source_hashes.historical_replay_source, "string");
  assert.equal(typeof artifact.source_hashes.historical_metrics_diagnostic, "string");
  assert.throws(() => writeAcceptanceArtifact(acceptance, acceptancePath), /overwrite/i);
  assert.throws(() => writeAcceptanceArtifact(acceptance, repoPath("unsafe-acceptance.json")), /outside the repository/i);

  // Lexically external output cannot use a symlinked parent to escape the
  // confinement check and write an artifact into the repository.
  const repositoryLink = path.join(tempDir, "repository-link");
  fs.symlinkSync(repoPath("."), repositoryLink);
  assert.throws(
    () => writeLegacyReplay(replay, path.join(repositoryLink, "replay-through-link")),
    /symlinked ancestors/i,
  );
  assert.throws(
    () => writeAcceptanceArtifact(acceptance, path.join(repositoryLink, "acceptance-through-link.json")),
    /symlinked ancestors/i,
  );

  // Swap the already-validated parent to a repository symlink immediately
  // before the final file open. The artifact must stay with the directory
  // descriptor that was opened before the swap, never at the replacement.
  const acceptanceRaceParent = path.join(tempDir, "acceptance-race-parent");
  const acceptanceRaceParked = path.join(tempDir, "acceptance-race-parent-anchored");
  const acceptanceRaceFilename = "acceptance-race.json";
  const acceptanceRaceRepositoryTarget = repoPath(acceptanceRaceFilename);
  fs.mkdirSync(acceptanceRaceParent);
  assert.equal(fs.existsSync(acceptanceRaceRepositoryTarget), false);
  const acceptanceRace = swapParentDuringAnchoredOpen({
    parent: acceptanceRaceParent,
    parkedParent: acceptanceRaceParked,
    filename: acceptanceRaceFilename,
    write: () => writeAcceptanceArtifact(acceptance, path.join(acceptanceRaceParent, acceptanceRaceFilename)),
  });
  assert.equal(acceptanceRace.swapped, true);
  assert.equal(acceptanceRace.result, path.join(acceptanceRaceParked, acceptanceRaceFilename));
  assert.equal(fs.existsSync(acceptanceRace.result), true);
  assert.equal(fs.existsSync(acceptanceRaceRepositoryTarget), false);
  assert.equal(fs.lstatSync(acceptanceRaceParent).isSymbolicLink(), true);

  const replayRaceDirectory = path.join(tempDir, "replay-race-directory");
  const replayRaceParked = path.join(tempDir, "replay-race-directory-anchored");
  const replayRaceFilename = "legacy-lifecycle-replay.jsonl";
  const replayRaceRepositoryTarget = repoPath(replayRaceFilename);
  assert.equal(fs.existsSync(replayRaceRepositoryTarget), false);
  const replayRace = swapParentDuringAnchoredOpen({
    parent: replayRaceDirectory,
    parkedParent: replayRaceParked,
    filename: replayRaceFilename,
    write: () => writeLegacyReplay(replay, replayRaceDirectory),
  });
  assert.equal(replayRace.swapped, true);
  assert.equal(replayRace.result.directory, replayRaceParked);
  assert.equal(fs.existsSync(replayRace.result.replayPath), true);
  assert.equal(fs.existsSync(replayRace.result.metricsPath), true);
  assert.equal(fs.existsSync(replayRace.result.manifestPath), true);
  assert.equal(fs.existsSync(replayRaceRepositoryTarget), false);
  assert.equal(fs.lstatSync(replayRaceDirectory).isSymbolicLink(), true);

  const idleEvidencePath = path.join(tempDir, "idle-shadow-evidence.jsonl");
  appendRun({ filePath: idleEvidencePath, runId: "four-seconds", startMs: nowMs - 25 * HOUR, heartbeats: 2, short: true });
  const idleAcceptance = evaluateRolloutAcceptance({
    shadowEvidencePath: idleEvidencePath,
    shadowRunId: "four-seconds",
    now: new Date(nowMs),
  });
  assert.equal(idleAcceptance.canary.ready, false);
  assert.equal(idleAcceptance.canary.gates.heartbeat_coverage.pass, false, "idle wall time cannot satisfy observed coverage");

  const unresolvedEvidencePath = path.join(tempDir, "unresolved-shadow-evidence.jsonl");
  appendRun({ filePath: unresolvedEvidencePath, runId: "unresolved-run", startMs: nowMs - 24 * HOUR, unresolved: true });
  const unresolvedAcceptance = evaluateRolloutAcceptance({
    shadowEvidencePath: unresolvedEvidencePath,
    shadowRunId: "unresolved-run",
    now: new Date(nowMs),
  });
  assert.equal(unresolvedAcceptance.canary.ready, false);
  assert.equal(unresolvedAcceptance.canary.gates.unresolved_lifecycles.pass, false);

  const drawdownEvidencePath = path.join(tempDir, "drawdown-shadow-evidence.jsonl");
  appendRun({ filePath: drawdownEvidencePath, runId: "drawdown-run", startMs: nowMs - 24 * HOUR, firstOpenEquity: 0.195 });
  const drawdownAcceptance = evaluateRolloutAcceptance({
    shadowEvidencePath: drawdownEvidencePath,
    shadowRunId: "drawdown-run",
    now: new Date(nowMs),
  });
  assert.equal(drawdownAcceptance.canary.ready, false);
  assert.equal(drawdownAcceptance.canary.gates.drawdown.pass, false, "open mark-to-market exposure contributes to drawdown");

  const failedObservationPath = path.join(tempDir, "failed-observation-evidence.jsonl");
  appendRun({ filePath: failedObservationPath, runId: "failed-observation-run", startMs: nowMs - 24 * HOUR, failureAt: 4 });
  const failedObservationAcceptance = evaluateRolloutAcceptance({
    shadowEvidencePath: failedObservationPath,
    shadowRunId: "failed-observation-run",
    now: new Date(nowMs),
  });
  assert.equal(failedObservationAcceptance.canary.ready, false);
  assert.equal(failedObservationAcceptance.canary.gates.observation_failures.pass, false);

  const wrongStagePath = path.join(tempDir, "wrong-stage-evidence.jsonl");
  appendRun({ filePath: wrongStagePath, runId: "wrong-stage-run", startMs: nowMs - 24 * HOUR, rolloutStage: "canary" });
  const wrongStageAcceptance = evaluateRolloutAcceptance({
    shadowEvidencePath: wrongStagePath,
    shadowRunId: "wrong-stage-run",
    now: new Date(nowMs),
  });
  assert.equal(wrongStageAcceptance.canary.ready, false);
  assert.equal(wrongStageAcceptance.canary.gates.rollout_stage.pass, false);

  const missingAcceptance = evaluateRolloutAcceptance({ now: new Date(nowMs) });
  assert.equal(missingAcceptance.canary.ready, false);

  console.log("rollout replay tests passed");
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
