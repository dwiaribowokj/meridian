import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendShadowEvidenceHeartbeat } from "../rollout-evidence.js";
import { SHADOW_ROTATION_STRATEGY_PROFILE } from "../risk-policy.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-rollout-config-"));
process.env.MERIDIAN_USER_CONFIG_FILE = path.join(tmp, "user-config.json");
process.env.MERIDIAN_STATE_FILE = path.join(tmp, "runtime-state.json");
process.env.MERIDIAN_LESSONS_FILE = path.join(tmp, "lessons.json");
process.env.MERIDIAN_SHADOW_EVIDENCE_FILE = path.join(tmp, "shadow-evidence.jsonl");
delete process.env.EMERGENCY_STOP;
fs.writeFileSync(process.env.MERIDIAN_USER_CONFIG_FILE, JSON.stringify({ dryRun: true, rolloutMode: "dry_run" }));
fs.writeFileSync(process.env.MERIDIAN_STATE_FILE, JSON.stringify({ positions: {} }));

const HOUR = 60 * 60_000;
const MINUTE = 60_000;

function settledLifecycle(runId, index, atMs) {
  const principal = 0.2;
  const finalEquity = 0.2004;
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
    cleanup: {
      simulated: true,
      verified: true,
      verified_at: new Date(atMs).toISOString(),
      no_wallet_or_transactions: true,
    },
  };
}

function writeReadyShadowEvidence(filePath, runId, nowMs) {
  for (let sequence = 0; sequence <= 96; sequence += 1) {
    const atMs = nowMs - 24 * HOUR + sequence * 15 * MINUTE;
    appendShadowEvidenceHeartbeat({
      filePath,
      runId,
      strategyProfile: SHADOW_ROTATION_STRATEGY_PROFILE,
      now: new Date(atMs),
      lifecycles: Array.from({ length: 5 }, (_, index) => settledLifecycle(runId, index, atMs)),
      cycle: {
        started_open_positions: 0,
        started_deployed_amount_sol: 0,
        observation_failures: [],
      },
      breaker: {
        tripped: false,
        manualResumeRequired: false,
        lastEventAtMs: atMs,
      },
    });
  }
}

try {
  const {
    config,
    LOCKED_CANARY_LIMITS,
    OPERATOR_LIVE_CANARY_OVERRIDE_CONFIRMATION,
    resolveRolloutSafety,
  } = await import("../config.js");
  const {
    addLesson,
    clearAllLessons,
    evolveThresholds,
    getLessonsForPrompt,
    isLegacyLearningFrozen,
    pinLesson,
    recordPerformance,
    removeLessonsByKeyword,
    unpinLesson,
  } = await import("../lessons.js");

  const nowMs = Date.parse("2026-07-02T00:00:00.000Z");
  const readyShadowPath = path.join(tmp, "ready-shadow-evidence.jsonl");
  writeReadyShadowEvidence(readyShadowPath, "ready-shadow-run", nowMs);
  const authoritativeStatePath = process.env.MERIDIAN_STATE_FILE;
  fs.writeFileSync(authoritativeStatePath, JSON.stringify({
    positions: Object.fromEntries(Array.from({ length: 30 }, (_, index) => [
      `legacy-${index}`,
      { position: `legacy-${index}`, closed: true },
    ])),
  }));

  const forgedArtifactPath = path.join(tmp, "forged-acceptance.json");
  fs.writeFileSync(forgedArtifactPath, JSON.stringify({
    schema_version: 2,
    kind: "rollout_acceptance",
    generated_at: new Date().toISOString(),
    shadow_baseline: { run_id: "forged-run" },
    source_hashes: { shadow_evidence: "forged" },
    canary: { ready: true, gates: { all: { pass: true } } },
  }));
  const forgedArtifact = { valid: true, ready: true, reason: null, file: forgedArtifactPath };

  const configuredDryRunWins = resolveRolloutSafety({
    dryRun: true,
    rolloutMode: "dry_run",
  }, { DRY_RUN: "false" });
  assert.equal(configuredDryRunWins.effectiveDryRun, true);
  assert.equal(configuredDryRunWins.effectiveMode, "dry_run");
  assert.ok(configuredDryRunWins.diagnostics.includes("CONFIG_ENV_DRY_RUN_MISMATCH_DIAGNOSTIC_ONLY"));

  const unsafeEnvironmentCannotEnableLive = resolveRolloutSafety({
    dryRun: undefined,
    rolloutMode: "dry_run",
  }, { DRY_RUN: "false" });
  assert.equal(unsafeEnvironmentCannotEnableLive.effectiveDryRun, true);
  assert.equal(unsafeEnvironmentCannotEnableLive.effectiveMode, "dry_run");

  const forgedArtifactCannotGoLive = resolveRolloutSafety({
    dryRun: false,
    rolloutMode: "canary",
    shadowEvidencePath: readyShadowPath,
    now: new Date(nowMs),
    canaryAcceptance: forgedArtifact,
  }, { DRY_RUN: "false" });
  assert.equal(forgedArtifactCannotGoLive.effectiveDryRun, true);
  assert.equal(forgedArtifactCannotGoLive.effectiveMode, "dry_run");
  assert.ok(forgedArtifactCannotGoLive.diagnostics.includes("CANARY_ACCEPTANCE_ARTIFACT_IGNORED_RECOMPUTED_FROM_SOURCE"));
  assert.equal(forgedArtifactCannotGoLive.acceptance.gates.historical_replay.pass, false);
  assert.equal(forgedArtifactCannotGoLive.acceptance.ready, false);

  // Complete shadow evidence cannot authorize a canary without an
  // independently recomputed 30-lifecycle historical replay source.
  const shadowOnlyCannotGoLive = resolveRolloutSafety({
    dryRun: false,
    rolloutMode: "canary",
    shadowEvidencePath: readyShadowPath,
    now: new Date(nowMs),
  }, { DRY_RUN: "false" });
  assert.equal(shadowOnlyCannotGoLive.effectiveDryRun, true);
  assert.equal(shadowOnlyCannotGoLive.acceptance.gates.historical_replay.pass, false);
  assert.ok(shadowOnlyCannotGoLive.diagnostics.includes("HISTORICAL_REPLAY_SOURCE_REQUIRED"));

  // A forged replay metric is also ignored: only a raw state snapshot is
  // recomputed for startup authorization.
  const forgedReplayMetricCannotGoLive = resolveRolloutSafety({
    dryRun: false,
    rolloutMode: "canary",
    shadowEvidencePath: readyShadowPath,
    now: new Date(nowMs),
    historicalMetrics: {
      kind: "historical_replay_metrics",
      dataset_type: "historical_replay",
      lifecycle_count: 999,
      dry_run_gate: { pass: true },
    },
  }, { DRY_RUN: "false" });
  assert.equal(forgedReplayMetricCannotGoLive.effectiveDryRun, true);
  assert.equal(forgedReplayMetricCannotGoLive.acceptance.gates.historical_replay.pass, false);
  assert.ok(forgedReplayMetricCannotGoLive.diagnostics.includes("HISTORICAL_REPLAY_ARTIFACT_IGNORED_RECOMPUTED_FROM_SOURCE"));

  const rawSourcesAuthorizeCanary = resolveRolloutSafety({
    dryRun: false,
    rolloutMode: "canary",
    historicalReplayStatePath: authoritativeStatePath,
    shadowEvidencePath: readyShadowPath,
    now: new Date(nowMs),
  }, { DRY_RUN: "false" });
  assert.equal(rawSourcesAuthorizeCanary.effectiveDryRun, false);
  assert.equal(rawSourcesAuthorizeCanary.effectiveMode, "canary");
  assert.equal(rawSourcesAuthorizeCanary.acceptance.gates.historical_replay.pass, true);
  assert.equal(rawSourcesAuthorizeCanary.acceptance.gates.heartbeat_coverage.pass, true);
  assert.equal(rawSourcesAuthorizeCanary.acceptance.gates.shadow_lifecycle_count.pass, true);

  const emergencyStoppedCanary = resolveRolloutSafety({
    dryRun: false,
    rolloutMode: "canary",
    historicalReplayStatePath: authoritativeStatePath,
    shadowEvidencePath: readyShadowPath,
    now: new Date(nowMs),
  }, { DRY_RUN: "false", EMERGENCY_STOP: "true" });
  assert.equal(emergencyStoppedCanary.effectiveDryRun, true);
  assert.equal(emergencyStoppedCanary.effectiveMode, "dry_run");
  assert.equal(emergencyStoppedCanary.canaryAllowed, false);
  assert.equal(emergencyStoppedCanary.emergencyStop, true);
  assert.ok(emergencyStoppedCanary.diagnostics.includes("EMERGENCY_STOP_FORCED_DRY_RUN"));

  // Environment can still be observed for compatibility diagnostics, but it
  // cannot alter a canary decision derived from immutable startup inputs.
  const environmentCannotDisableAcceptedCanary = resolveRolloutSafety({
    dryRun: false,
    rolloutMode: "canary",
    historicalReplayStatePath: authoritativeStatePath,
    shadowEvidencePath: readyShadowPath,
    now: new Date(nowMs),
  }, { DRY_RUN: "true" });
  assert.equal(environmentCannotDisableAcceptedCanary.effectiveDryRun, false);
  assert.equal(environmentCannotDisableAcceptedCanary.effectiveMode, "canary");
  assert.ok(environmentCannotDisableAcceptedCanary.diagnostics.includes("CONFIG_ENV_DRY_RUN_MISMATCH_DIAGNOSTIC_ONLY"));

  const missingSourceEvidenceFailsClosed = resolveRolloutSafety({
    dryRun: false,
    rolloutMode: "canary",
    shadowEvidencePath: path.join(tmp, "missing-source.jsonl"),
  }, { DRY_RUN: "false" });
  assert.equal(missingSourceEvidenceFailsClosed.effectiveDryRun, true);
  assert.ok(missingSourceEvidenceFailsClosed.diagnostics.includes("SHADOW_EVIDENCE_MISSING"));

  const invalidOperatorOverrideFailsClosed = resolveRolloutSafety({
    dryRun: false,
    rolloutMode: "canary",
    shadowEvidencePath: path.join(tmp, "missing-source.jsonl"),
    operatorCanaryOverrideConfirmation: "close but not exact",
  }, { DRY_RUN: "false" });
  assert.equal(invalidOperatorOverrideFailsClosed.effectiveDryRun, true);
  assert.equal(invalidOperatorOverrideFailsClosed.operatorOverrideActive, false);
  assert.ok(invalidOperatorOverrideFailsClosed.diagnostics.includes("OPERATOR_CANARY_OVERRIDE_CONFIRMATION_INVALID"));

  const environmentCannotManufactureOperatorOverride = resolveRolloutSafety({
    dryRun: false,
    rolloutMode: "canary",
    shadowEvidencePath: path.join(tmp, "missing-source.jsonl"),
  }, {
    DRY_RUN: "false",
    OPERATOR_LIVE_CANARY_OVERRIDE_CONFIRMATION,
  });
  assert.equal(environmentCannotManufactureOperatorOverride.effectiveDryRun, true);
  assert.equal(environmentCannotManufactureOperatorOverride.operatorOverrideRequested, false);

  const explicitOperatorOverrideAllowsLockedCanary = resolveRolloutSafety({
    dryRun: false,
    rolloutMode: "canary",
    shadowEvidencePath: path.join(tmp, "missing-source.jsonl"),
    operatorCanaryOverrideConfirmation: OPERATOR_LIVE_CANARY_OVERRIDE_CONFIRMATION,
  }, { DRY_RUN: "false" });
  assert.equal(explicitOperatorOverrideAllowsLockedCanary.effectiveDryRun, false);
  assert.equal(explicitOperatorOverrideAllowsLockedCanary.effectiveMode, "canary");
  assert.equal(explicitOperatorOverrideAllowsLockedCanary.canaryAllowed, true);
  assert.equal(explicitOperatorOverrideAllowsLockedCanary.operatorOverrideRequested, true);
  assert.equal(explicitOperatorOverrideAllowsLockedCanary.operatorOverrideActive, true);
  assert.equal(explicitOperatorOverrideAllowsLockedCanary.acceptance.ready, false);
  assert.deepEqual(explicitOperatorOverrideAllowsLockedCanary.canaryLimits, { deployAmountSol: 0.2, maxPositions: 1 });
  assert.ok(explicitOperatorOverrideAllowsLockedCanary.diagnostics.includes("OPERATOR_CANARY_OVERRIDE_ACTIVE_SOURCE_ACCEPTANCE_BYPASSED"));

  const emergencyStopStillBlocksOperatorOverride = resolveRolloutSafety({
    dryRun: false,
    rolloutMode: "canary",
    shadowEvidencePath: path.join(tmp, "missing-source.jsonl"),
    operatorCanaryOverrideConfirmation: OPERATOR_LIVE_CANARY_OVERRIDE_CONFIRMATION,
  }, { DRY_RUN: "false", EMERGENCY_STOP: "true" });
  assert.equal(emergencyStopStillBlocksOperatorOverride.effectiveDryRun, true);
  assert.equal(emergencyStopStillBlocksOperatorOverride.canaryAllowed, false);
  assert.equal(emergencyStopStillBlocksOperatorOverride.operatorOverrideRequested, true);
  assert.equal(emergencyStopStillBlocksOperatorOverride.operatorOverrideActive, false);
  assert.ok(emergencyStopStillBlocksOperatorOverride.diagnostics.includes("EMERGENCY_STOP_FORCED_DRY_RUN"));

  const adaptiveLiveIsNotAuthorized = resolveRolloutSafety({
    dryRun: false,
    rolloutMode: "adaptive",
  }, { DRY_RUN: "false" });
  assert.equal(adaptiveLiveIsNotAuthorized.effectiveDryRun, true);
  assert.ok(adaptiveLiveIsNotAuthorized.diagnostics.includes("UNSUPPORTED_ROLLOUT_MODE:adaptive"));
  assert.ok(adaptiveLiveIsNotAuthorized.diagnostics.includes("FULL_LIVE_ROLLOUT_NOT_AUTHORIZED_FORCED_DRY_RUN"));

  assert.equal(config.rollout.canaryDeployAmountSol, 0.2);
  assert.equal(config.rollout.canaryMaxPositions, 1);
  assert.equal(config.rollout.historicalReplayStateFile, authoritativeStatePath);
  assert.deepEqual(LOCKED_CANARY_LIMITS, { deployAmountSol: 0.2, maxPositions: 1 });
  assert.equal(isLegacyLearningFrozen(), true);

  const performanceResult = await recordPerformance({ position: "frozen-test" });
  assert.deepEqual(performanceResult, {
    recorded: false,
    frozen: true,
    reason: "ROLLOUT_BASELINE_LEARNING_FROZEN",
  });
  const evolutionResult = evolveThresholds([
    { pnl_pct: 10, fee_tvl_ratio: 1, organic_score: 90 },
    { pnl_pct: 10, fee_tvl_ratio: 1, organic_score: 90 },
    { pnl_pct: -10, fee_tvl_ratio: 0.1, organic_score: 60 },
    { pnl_pct: -10, fee_tvl_ratio: 0.1, organic_score: 60 },
    { pnl_pct: 10, fee_tvl_ratio: 1, organic_score: 90 },
  ], { screening: { minFeeActiveTvlRatio: 0.05, minOrganic: 60 } });
  assert.equal(evolutionResult.frozen, true);

  // The freeze blocks automatic recording/evolution/prompt injection, not
  // explicit operator curation of the local lesson corpus.
  const added = addLesson("operator baseline rule", ["manual"], { pinned: false });
  assert.equal(added.added, true);
  assert.equal(pinLesson(added.id).pinned, true);
  assert.equal(unpinLesson(added.id).pinned, false);
  assert.equal(getLessonsForPrompt(), null, "frozen lessons are not prompt-injected");
  assert.equal(removeLessonsByKeyword("baseline"), 1);
  assert.equal(addLesson("another operator rule").added, true);
  assert.equal(clearAllLessons(), 1);
  assert.equal(fs.existsSync(process.env.MERIDIAN_LESSONS_FILE), true);

  console.log("rollout safety tests passed");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
