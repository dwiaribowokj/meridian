import fs from "fs";
import path from "path";
import { REPO_ROOT, repoPath } from "./repo-root.js";
import { getScreeningDefaultsForTimeframe, normalizeTimeframe, scaleScreeningToTimeframe, TIMEFRAME_SCREENING_SCALES } from "./screening-scales.js";
import { DEFAULT_SHADOW_EVIDENCE_THRESHOLDS } from "./rollout-evidence.js";
import {
  resolveEntryStrategyProfile,
  SHADOW_ROTATION_POLICY,
} from "./risk-policy.js";
import {
  evaluateHistoricalReplaySource,
  evaluateRolloutAcceptance,
  LOCKED_CANARY,
  resolveRuntimeStateFile,
} from "./tools/rollout-safety.js";

export { REPO_ROOT, repoPath, getScreeningDefaultsForTimeframe, normalizeTimeframe, scaleScreeningToTimeframe, TIMEFRAME_SCREENING_SCALES };

const USER_CONFIG_PATH = process.env.MERIDIAN_USER_CONFIG_FILE || repoPath("user-config.json");
const DEFAULT_HIVEMIND_URL = "https://api.agentmeridian.xyz";
const DEFAULT_AGENT_MERIDIAN_API_URL = "https://api.agentmeridian.xyz/api";
const DEFAULT_AGENT_MERIDIAN_PUBLIC_KEY = "bWVyaWRpYW4taXMtdGhlLWJlc3QtYWdlbnRz";
const DEFAULT_HIVEMIND_API_KEY = DEFAULT_AGENT_MERIDIAN_PUBLIC_KEY;

const u = fs.existsSync(USER_CONFIG_PATH)
  ? JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"))
  : {};
export const MIN_SAFE_BINS_BELOW = 35;

function numericConfig(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function circuitBreakerNumber(value) {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !value.trim()) return null;
  return numericConfig(value);
}

function nonNegativeFiniteConfig(value, fallback) {
  const n = circuitBreakerNumber(value);
  return n != null && n >= 0 ? n : fallback;
}

function positiveIntegerConfig(value, fallback) {
  const n = circuitBreakerNumber(value);
  return n != null && Number.isInteger(n) && n >= 1 ? n : fallback;
}

function negativeFiniteConfig(value, fallback) {
  const n = circuitBreakerNumber(value);
  return n != null && n < 0 ? n : fallback;
}

const legacyBinsBelow = numericConfig(u.binsBelow);
const configuredMinBinsBelow = numericConfig(u.minBinsBelow) ?? MIN_SAFE_BINS_BELOW;
const configuredMaxBinsBelow = numericConfig(u.maxBinsBelow)
  ?? (legacyBinsBelow != null ? Math.max(legacyBinsBelow, configuredMinBinsBelow) : 69);
const configuredDefaultBinsBelow = numericConfig(u.defaultBinsBelow) ?? legacyBinsBelow ?? configuredMaxBinsBelow;
const strategyMinBinsBelow = Math.max(MIN_SAFE_BINS_BELOW, Math.round(configuredMinBinsBelow));
const strategyMaxBinsBelow = Math.max(strategyMinBinsBelow, Math.round(configuredMaxBinsBelow));
const strategyDefaultBinsBelow = Math.max(
  strategyMinBinsBelow,
  Math.min(strategyMaxBinsBelow, Math.round(configuredDefaultBinsBelow)),
);

// Apply wallet/RPC from user-config if not already in env
if (u.rpcUrl)    process.env.RPC_URL            ||= u.rpcUrl;
if (u.heliusBaseUrl) process.env.HELIUS_BASE_URL ||= u.heliusBaseUrl;
if (u.heliusApiKey) process.env.HELIUS_API_KEY ||= u.heliusApiKey;
if (u.walletKey) process.env.WALLET_PRIVATE_KEY ||= u.walletKey;
if (u.llmModel)  process.env.LLM_MODEL          ||= u.llmModel;
if (u.llmBaseUrl) process.env.LLM_BASE_URL      ||= u.llmBaseUrl;
if (u.llmApiKey)  process.env.LLM_API_KEY       ||= u.llmApiKey;
if (u.publicApiKey) process.env.PUBLIC_API_KEY ||= u.publicApiKey;
if (u.agentMeridianApiUrl) process.env.AGENT_MERIDIAN_API_URL ||= u.agentMeridianApiUrl;
if (u.telegramChatId) process.env.TELEGRAM_CHAT_ID ||= String(u.telegramChatId);

const indicatorUserConfig = u.chartIndicators ?? {};

// Optional standalone GMGN config file (mirrors user-config layering)
const GMGN_CONFIG_PATH = repoPath("gmgn-config.json");
const gmgnUserConfig = fs.existsSync(GMGN_CONFIG_PATH)
  ? JSON.parse(fs.readFileSync(GMGN_CONFIG_PATH, "utf8"))
  : {};
if (gmgnUserConfig.apiKey || u.gmgnApiKey) {
  process.env.GMGN_API_KEY ||= gmgnUserConfig.apiKey || u.gmgnApiKey;
}

function nonEmptyString(...values) {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

const ROLLOUT_MODES = new Set(["dry_run", "canary"]);
export const OPERATOR_LIVE_CANARY_OVERRIDE_CONFIRMATION = "I AUTHORIZE LIVE CANARY 0.20 SOL";
export const LOCKED_CANARY_LIMITS = Object.freeze({
  deployAmountSol: LOCKED_CANARY.deployAmountSol,
  maxPositions: LOCKED_CANARY.maxPositions,
});
export const LOCKED_ROLLOUT_BASELINE = Object.freeze({
  multiLayerEnabled: false,
  darwinEnabled: false,
  hiveMindEnabled: false,
  rebalanceEnabled: false,
  compoundEnabled: false,
  adaptiveSizingEnabled: true,
});

function lockedBaselineForMode(mode) {
  // There are no permissive rollout stages. Both supported stages run the
  // same baseline; only the accepted canary may submit a live position.
  return Object.freeze({
    locked: mode === "dry_run" || mode === "canary",
    ...LOCKED_ROLLOUT_BASELINE,
  });
}

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function strictBoolean(value) {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return null;
}

function normalizeRolloutMode(value) {
  const mode = nonEmptyString(value)?.toLowerCase();
  return ROLLOUT_MODES.has(mode) ? mode : null;
}

function readAcceptanceArtifactDiagnostic(fileValue) {
  const requestedPath = nonEmptyString(fileValue);
  if (!requestedPath) {
    return { present: false, reason: "NO_ACCEPTANCE_ARTIFACT", file: null };
  }

  const file = path.isAbsolute(requestedPath) ? requestedPath : repoPath(requestedPath);
  if (!fs.existsSync(file)) {
    return { present: false, reason: "ACCEPTANCE_ARTIFACT_MISSING", file };
  }

  try {
    const artifact = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      present: true,
      file,
      run_id: artifact?.shadow_baseline?.run_id ?? null,
      source_hashes: artifact?.source_hashes ?? null,
      generated_at: artifact?.generated_at ?? null,
      // Deliberately no `ready` field: this data is diagnostic only.
      reason: "ACCEPTANCE_ARTIFACT_DIAGNOSTIC_ONLY",
    };
  } catch {
    return { present: false, reason: "ACCEPTANCE_ARTIFACT_UNREADABLE", file };
  }
}

function canaryGateReasons(acceptance) {
  const reasons = Object.values(acceptance?.canary?.gates || {})
    .filter((gate) => gate?.pass !== true)
    .map((gate) => gate?.reason)
    .filter(Boolean);
  return [...new Set(reasons.length ? reasons : ["CANARY_SOURCE_EVIDENCE_NOT_READY"])];
}

/**
 * Resolve the immutable startup authority. Environment is diagnostic and
 * compatibility-only: it must never authorize or disable a rollout stage.
 * Live execution normally requires accepted source evidence. An explicit,
 * exact operator confirmation in the user config may override only that
 * readiness decision; all canary boundaries remain locked independently.
 */
export function resolveRolloutSafety({
  dryRun,
  rolloutMode,
  operatorCanaryOverrideConfirmation = null,
  historicalReplayStatePath = null,
  shadowEvidencePath = null,
  shadowRunId = null,
  acceptanceThresholds = {},
  now = new Date(),
  // Kept only to expose attempts to pass a precomputed artifact to this pure
  // resolver. It is never consulted for authorization.
  canaryAcceptance = null,
  // A replay metric is also not an authorization input. The startup source is
  // a raw state snapshot, recomputed below.
  historicalMetrics = null,
} = {}, environment = process.env) {
  const configuredDryRun = strictBoolean(dryRun);
  const environmentDryRun = strictBoolean(environment?.DRY_RUN);
  // This is a boot-only one-way latch. Unlike DRY_RUN, it is intentionally an
  // authority input, but only the exact environment spelling can force safe
  // mode; false, absent, and alternate values never authorize execution.
  const emergencyStop = environment?.EMERGENCY_STOP === "true";
  const rawMode = nonEmptyString(rolloutMode)?.toLowerCase() ?? "dry_run";
  const requestedMode = normalizeRolloutMode(rawMode);
  const diagnostics = [];

  if (!requestedMode) diagnostics.push(`UNSUPPORTED_ROLLOUT_MODE:${rawMode}`);
  if (configuredDryRun == null) diagnostics.push("CONFIG_DRY_RUN_NOT_EXPLICIT_SAFE");
  if (environmentDryRun == null) diagnostics.push("ENV_DRY_RUN_NOT_EXPLICIT");
  if (configuredDryRun != null && environmentDryRun != null && configuredDryRun !== environmentDryRun) {
    diagnostics.push("CONFIG_ENV_DRY_RUN_MISMATCH_DIAGNOSTIC_ONLY");
  }

  const acceptance = evaluateRolloutAcceptance({
    historicalStatePath: historicalReplayStatePath,
    shadowEvidencePath,
    shadowRunId,
    thresholds: acceptanceThresholds,
    now,
  });
  const gateReasons = canaryGateReasons(acceptance);
  const sourceAcceptance = {
    valid: acceptance.canary.ready === true,
    ready: acceptance.canary.ready === true,
    reason: acceptance.canary.ready ? null : gateReasons[0],
    run_id: acceptance.shadow_baseline.run_id ?? shadowRunId ?? null,
    source: {
      shadow: acceptance.source_evidence ?? { file: shadowEvidencePath, sha256: null, record_count: 0 },
      historical: acceptance.historical_replay.source,
    },
    gates: acceptance.canary.gates,
  };
  if (canaryAcceptance) diagnostics.push("CANARY_ACCEPTANCE_ARTIFACT_IGNORED_RECOMPUTED_FROM_SOURCE");
  if (historicalMetrics) diagnostics.push("HISTORICAL_REPLAY_ARTIFACT_IGNORED_RECOMPUTED_FROM_SOURCE");

  const canaryRequested = requestedMode === "canary" && configuredDryRun === false;
  const suppliedOverrideConfirmation = nonEmptyString(operatorCanaryOverrideConfirmation);
  const operatorOverrideConfirmed = suppliedOverrideConfirmation === OPERATOR_LIVE_CANARY_OVERRIDE_CONFIRMATION;
  const operatorOverrideRequested = canaryRequested && operatorOverrideConfirmed;
  const operatorOverrideActive = !emergencyStop && operatorOverrideRequested && sourceAcceptance.ready !== true;
  const canaryAllowed = !emergencyStop && canaryRequested && (
    sourceAcceptance.ready === true || operatorOverrideConfirmed
  );

  if (suppliedOverrideConfirmation && !operatorOverrideConfirmed) {
    diagnostics.push("OPERATOR_CANARY_OVERRIDE_CONFIRMATION_INVALID");
  }
  if (operatorOverrideActive) {
    diagnostics.push("OPERATOR_CANARY_OVERRIDE_ACTIVE_SOURCE_ACCEPTANCE_BYPASSED");
    diagnostics.push(...gateReasons.map((reason) => `OVERRIDDEN_SOURCE_GATE:${reason}`));
  } else if (operatorOverrideConfirmed && !canaryRequested) {
    diagnostics.push("OPERATOR_CANARY_OVERRIDE_IGNORED_CANARY_NOT_REQUESTED");
  }

  if (requestedMode === "canary" && configuredDryRun !== false) {
    diagnostics.push("CANARY_REQUIRES_CONFIG_DRY_RUN_FALSE");
  }
  if (canaryRequested && !sourceAcceptance.ready && !operatorOverrideConfirmed) {
    diagnostics.push(...gateReasons);
  }
  if (configuredDryRun === false && requestedMode !== "canary") {
    diagnostics.push("FULL_LIVE_ROLLOUT_NOT_AUTHORIZED_FORCED_DRY_RUN");
  }
  if (emergencyStop) diagnostics.push("EMERGENCY_STOP_FORCED_DRY_RUN");

  return Object.freeze({
    requestedMode: requestedMode ?? "dry_run",
    effectiveMode: canaryAllowed ? "canary" : "dry_run",
    effectiveDryRun: !canaryAllowed,
    learningFrozen: true,
    canaryAllowed,
    emergencyStop,
    operatorOverrideRequested,
    operatorOverrideActive,
    canaryLimits: LOCKED_CANARY_LIMITS,
    diagnostics: Object.freeze(diagnostics),
    acceptance: Object.freeze(sourceAcceptance),
  });
}

// Startup authorization reads only the evidence location emitted by the normal
// management cadence. A config or environment path override would recreate an
// artifact-style authorization channel, so it is deliberately ignored here.
const configuredShadowEvidenceFile = repoPath("shadow-rollout-evidence.jsonl");
const configuredShadowRunId = null;
// Historical replay must inspect the same raw state file as the runtime
// registry: MERIDIAN_STATE_FILE when explicitly configured, otherwise the
// repository state.json. Replay artifacts remain diagnostic only.
const configuredHistoricalReplayStateFile = resolveRuntimeStateFile();
const configuredAcceptanceArtifact = readAcceptanceArtifactDiagnostic(
  nonEmptyString(u.rolloutAcceptanceFile, process.env.ROLLOUT_ACCEPTANCE_FILE),
);
const rolloutSafety = resolveRolloutSafety({
  dryRun: u.dryRun,
  rolloutMode: u.rolloutMode,
  operatorCanaryOverrideConfirmation: u.operatorLiveCanaryOverrideConfirmation,
  historicalReplayStatePath: configuredHistoricalReplayStateFile,
  shadowEvidencePath: configuredShadowEvidenceFile,
  shadowRunId: configuredShadowRunId,
  acceptanceThresholds: {
    maxHeartbeatGapMinutes: u.rolloutMaxHeartbeatGapMinutes ?? DEFAULT_SHADOW_EVIDENCE_THRESHOLDS.maxHeartbeatGapMinutes,
  },
});
// This is the runtime authority for rollout behavior. It intentionally never
// aliases config.rollout: config is an operator-facing diagnostic surface and
// must not become an authorization input if a caller mutates it.
const effectiveRolloutState = deepFreeze({
  mode: rolloutSafety.effectiveMode,
  requestedMode: rolloutSafety.requestedMode,
  dryRun: rolloutSafety.effectiveDryRun,
  learningFrozen: rolloutSafety.learningFrozen,
  canaryAllowed: rolloutSafety.canaryAllowed,
  emergencyStop: rolloutSafety.emergencyStop,
  operatorOverrideRequested: rolloutSafety.operatorOverrideRequested,
  operatorOverrideActive: rolloutSafety.operatorOverrideActive,
  canaryLimits: LOCKED_CANARY_LIMITS,
  baseline: lockedBaselineForMode(rolloutSafety.effectiveMode),
  historicalReplayStateFile: configuredHistoricalReplayStateFile,
  shadowEvidenceFile: configuredShadowEvidenceFile,
});
const rolloutDiagnostics = deepFreeze({
  requestedMode: rolloutSafety.requestedMode,
  emergencyStop: rolloutSafety.emergencyStop,
  operatorOverrideRequested: rolloutSafety.operatorOverrideRequested,
  operatorOverrideActive: rolloutSafety.operatorOverrideActive,
  diagnostics: [...rolloutSafety.diagnostics],
  acceptance: rolloutSafety.acceptance,
});
const activeCanary = effectiveRolloutState.mode === "canary";
const lockedRolloutBaseline = effectiveRolloutState.baseline;
const shadowRotationRequested = strictBoolean(u.shadowRotationEnabled) === true;
// A source-accepted live canary is always bound to the same versioned rotation
// profile as its shadow evidence. In dry-run, the operator still explicitly
// opts into that profile through shadowRotationEnabled.
const shadowRotationActive = activeCanary || (
  effectiveRolloutState.mode === "dry_run" &&
  effectiveRolloutState.dryRun === true &&
  shadowRotationRequested
);
const activeStrategyProfile = resolveEntryStrategyProfile({
  effectiveDryRun: effectiveRolloutState.dryRun,
  effectiveRolloutMode: effectiveRolloutState.mode,
  rotationEnabled: shadowRotationActive,
});

function boundedShadowRotationNumber(value, fallback, minimum, maximum) {
  const number = numericConfig(value);
  if (number == null) return fallback;
  return Math.min(maximum, Math.max(minimum, number));
}

const shadowRotationConfig = deepFreeze({
  requestedEnabled: shadowRotationRequested,
  enabled: shadowRotationActive,
  strategyProfile: activeStrategyProfile,
  strategy: "spot",
  fundingModel: SHADOW_ROTATION_POLICY.fundingModel,
  binsBelow: Math.round(boundedShadowRotationNumber(
    u.shadowRotationBinsBelow,
    SHADOW_ROTATION_POLICY.binsBelow,
    4,
    MIN_SAFE_BINS_BELOW,
  )),
  binsAbove: Math.round(boundedShadowRotationNumber(
    u.shadowRotationBinsAbove,
    SHADOW_ROTATION_POLICY.binsAbove,
    0,
    15,
  )),
  minPoolTvlUsd: boundedShadowRotationNumber(
    u.shadowRotationMinTvl,
    SHADOW_ROTATION_POLICY.minPoolTvlUsd,
    250,
    10_000,
  ),
  minActiveTvlUsd: boundedShadowRotationNumber(
    u.shadowRotationMinActiveTvl,
    SHADOW_ROTATION_POLICY.minActiveTvlUsd,
    250,
    10_000,
  ),
  maxActiveTvlUsd: boundedShadowRotationNumber(
    u.shadowRotationMaxTvl,
    SHADOW_ROTATION_POLICY.maxActiveTvlUsd,
    10_000,
    300_000,
  ),
  minFeeActiveTvlRatioPct: boundedShadowRotationNumber(
    u.shadowRotationMinFeeActiveTvlRatio,
    SHADOW_ROTATION_POLICY.minFeeActiveTvlRatioPct,
    0.30,
    1.50,
  ),
  minVolumeUsd: boundedShadowRotationNumber(
    u.shadowRotationMinVolume,
    SHADOW_ROTATION_POLICY.minVolumeUsd,
    100,
    4_000,
  ),
  minMarketCapUsd: boundedShadowRotationNumber(
    u.shadowRotationMinMcap,
    SHADOW_ROTATION_POLICY.minMarketCapUsd,
    25_000,
    1_000_000,
  ),
  maxMarketCapUsd: boundedShadowRotationNumber(
    u.shadowRotationMaxMcap,
    SHADOW_ROTATION_POLICY.maxMarketCapUsd,
    1_000_000,
    50_000_000,
  ),
  minHolderCount: Math.round(boundedShadowRotationNumber(
    u.shadowRotationMinHolders,
    SHADOW_ROTATION_POLICY.minHolderCount,
    250,
    5_000,
  )),
  minOrganicScoreBase: boundedShadowRotationNumber(
    u.shadowRotationMinOrganic,
    SHADOW_ROTATION_POLICY.minOrganicScoreBase,
    65,
    80,
  ),
  minTokenAgeHours: boundedShadowRotationNumber(
    u.shadowRotationMinTokenAgeHours,
    SHADOW_ROTATION_POLICY.minTokenAgeHours,
    0.5,
    24,
  ),
  maxTokenAgeHours: boundedShadowRotationNumber(
    u.shadowRotationMaxTokenAgeHours,
    SHADOW_ROTATION_POLICY.maxTokenAgeHours,
    24,
    168,
  ),
  minGlobalFeesSol: boundedShadowRotationNumber(
    u.shadowRotationMinTokenFeesSol,
    SHADOW_ROTATION_POLICY.minGlobalFeesSol,
    50,
    500,
  ),
  maxBotHolderPct: boundedShadowRotationNumber(
    u.shadowRotationMaxBotHoldersPct,
    SHADOW_ROTATION_POLICY.maxBotHolderPct,
    20,
    25,
  ),
  maxTop10Pct: boundedShadowRotationNumber(
    u.shadowRotationMaxTop10Pct,
    SHADOW_ROTATION_POLICY.maxTop10Pct,
    20,
    40,
  ),
  maxVolatilityExclusive: boundedShadowRotationNumber(
    u.shadowRotationMaxVolatility,
    SHADOW_ROTATION_POLICY.maxVolatilityExclusive,
    2.5,
    7.5,
  ),
  confirmationCount: Math.round(boundedShadowRotationNumber(
    u.shadowRotationConfirmationCount,
    SHADOW_ROTATION_POLICY.confirmationCount,
    2,
    3,
  )),
  confirmationSpacingMs: Math.round(boundedShadowRotationNumber(
    u.shadowRotationConfirmationSpacingSeconds,
    SHADOW_ROTATION_POLICY.confirmationSpacingMs / 1000,
    15,
    120,
  ) * 1000),
  confirmationWindowMs: Math.round(boundedShadowRotationNumber(
    u.shadowRotationConfirmationMaxAgeMinutes,
    SHADOW_ROTATION_POLICY.confirmationWindowMs / 60_000,
    2,
    15,
  ) * 60_000),
  minRetentionPct: boundedShadowRotationNumber(
    u.shadowRotationMinRetentionPct,
    SHADOW_ROTATION_POLICY.minRetentionPct,
    50,
    80,
  ),
  maxPriceDrawdownPct: boundedShadowRotationNumber(
    u.shadowRotationMaxPriceDrawdownPct,
    SHADOW_ROTATION_POLICY.maxPriceDrawdownPct,
    0.5,
    3,
  ),
  maxDownsideBinDelta: boundedShadowRotationNumber(
    u.shadowRotationMaxDownsideBins,
    SHADOW_ROTATION_POLICY.maxDownsideBinDelta,
    1,
    5,
  ),
  monitorIntervalSeconds: Math.round(boundedShadowRotationNumber(
    u.shadowRotationMonitorIntervalSeconds,
    SHADOW_ROTATION_POLICY.monitorIntervalSeconds,
    10,
    30,
  )),
  catastrophicQuarantineHours: Math.round(boundedShadowRotationNumber(
    u.shadowRotationCatastrophicQuarantineHours,
    SHADOW_ROTATION_POLICY.catastrophicQuarantineHours,
    24,
    336,
  )),
  maxPositionActiveTvlPct: boundedShadowRotationNumber(
    u.shadowRotationMaxPositionActiveTvlPct,
    SHADOW_ROTATION_POLICY.maxPositionActiveTvlPct,
    0.25,
    2,
  ),
  minEntryRsi5m: boundedShadowRotationNumber(
    u.shadowRotationMinEntryRsi5m,
    SHADOW_ROTATION_POLICY.minEntryRsi5m,
    SHADOW_ROTATION_POLICY.minEntryRsi5m,
    50,
  ),
  minEntryRsi15m: boundedShadowRotationNumber(
    u.shadowRotationMinEntryRsi15m,
    SHADOW_ROTATION_POLICY.minEntryRsi15m,
    SHADOW_ROTATION_POLICY.minEntryRsi15m,
    50,
  ),
  maxEntryRsi5m: boundedShadowRotationNumber(
    u.shadowRotationMaxEntryRsi5m,
    SHADOW_ROTATION_POLICY.maxEntryRsi5m,
    75,
    85,
  ),
  maxEntryRsi15m: boundedShadowRotationNumber(
    u.shadowRotationMaxEntryRsi15m,
    SHADOW_ROTATION_POLICY.maxEntryRsi15m,
    80,
    85,
  ),
  feeParticipationPct: boundedShadowRotationNumber(
    u.shadowRotationFeeParticipationPct,
    SHADOW_ROTATION_POLICY.feeParticipationPct,
    50,
    85,
  ),
  estimatedRoundTripCostPct: boundedShadowRotationNumber(
    u.shadowRotationEstimatedRoundTripCostPct,
    SHADOW_ROTATION_POLICY.estimatedRoundTripCostPct,
    SHADOW_ROTATION_POLICY.estimatedRoundTripCostPct,
    2,
  ),
  takeProfitExecutionBufferPct: boundedShadowRotationNumber(
    u.shadowRotationTakeProfitExecutionBufferPct,
    SHADOW_ROTATION_POLICY.takeProfitExecutionBufferPct,
    SHADOW_ROTATION_POLICY.takeProfitExecutionBufferPct,
    2,
  ),
  minimumProjectedNetFeePct: boundedShadowRotationNumber(
    u.shadowRotationMinNetProfitPct,
    SHADOW_ROTATION_POLICY.minimumProjectedNetFeePct,
    0.01,
    0.25,
  ),
  minNetProfitSol: boundedShadowRotationNumber(
    u.shadowRotationMinNetProfitSol,
    0.00005,
    0.00001,
    0.001,
  ),
  maxHoldMinutes: Math.round(boundedShadowRotationNumber(
    u.shadowRotationMaxHoldMinutes,
    SHADOW_ROTATION_POLICY.maxHoldMinutes,
    60,
    360,
  )),
  takeProfitPct: boundedShadowRotationNumber(
    u.shadowRotationTakeProfitPct,
    SHADOW_ROTATION_POLICY.takeProfitPct,
    SHADOW_ROTATION_POLICY.minimumProjectedNetFeePct,
    0.50,
  ),
  stopLossPct: boundedShadowRotationNumber(
    u.shadowRotationStopLossPct,
    SHADOW_ROTATION_POLICY.stopLossPct,
    -2,
    -0.25,
  ),
  catastrophicStopPct: boundedShadowRotationNumber(
    u.shadowRotationCatastrophicStopPct,
    SHADOW_ROTATION_POLICY.catastrophicStopPct,
    -3,
    -0.50,
  ),
  normalStopGraceMinutes: Math.round(boundedShadowRotationNumber(
    u.shadowRotationNormalStopGraceMinutes,
    SHADOW_ROTATION_POLICY.normalStopGraceMinutes,
    0,
    60,
  )),
  thesisReviewMinutes: Math.round(boundedShadowRotationNumber(
    u.shadowRotationThesisReviewMinutes,
    20,
    5,
    90,
  )),
  aboveRangeExitMinutes: Math.round(boundedShadowRotationNumber(
    u.shadowRotationAboveRangeExitMinutes,
    SHADOW_ROTATION_POLICY.aboveRangeExitMinutes,
    5,
    60,
  )),
  cooldownForRun: u.shadowRotationCooldownForRun !== false,
});

export function isRolloutBaselineLocked() {
  return effectiveRolloutState.baseline.locked === true;
}

export function isEffectiveDryRun() {
  return effectiveRolloutState.dryRun === true;
}

export function enforceEffectiveRolloutEnvironment() {
  process.env.DRY_RUN = isEffectiveDryRun() ? "true" : "false";
}

/**
 * Fail-closed raw historical-replay coverage signal. This always recomputes
 * from the runtime state source; it never trusts a replay artifact or a
 * process-local ready flag.
 */
export function getHistoricalReplayCoverageGate({
  statePath = configuredHistoricalReplayStateFile,
  now = new Date(),
} = {}) {
  try {
    const evaluation = evaluateHistoricalReplaySource({ statePath, now });
    const gate = evaluation?.metrics?.dry_run_gate;
    const pass = evaluation?.available === true && gate?.pass === true;
    return Object.freeze({
      pass,
      actual: Number.isSafeInteger(gate?.actual) && gate.actual >= 0 ? gate.actual : 0,
      required: Number.isSafeInteger(gate?.required) && gate.required >= 0 ? gate.required : 30,
      reason: pass ? "HISTORICAL_REPLAY_COVERAGE_MET" : gate?.reason || evaluation?.reason || "HISTORICAL_REPLAY_SOURCE_REQUIRED",
      source: Object.freeze({ ...(evaluation?.source || { file: statePath ?? null, sha256: null, bytes: 0, modified_at: null }) }),
    });
  } catch {
    return Object.freeze({
      pass: false,
      actual: 0,
      required: 30,
      reason: "HISTORICAL_REPLAY_SOURCE_UNREADABLE",
      source: Object.freeze({ file: statePath ?? null, sha256: null, bytes: 0, modified_at: null }),
    });
  }
}

/**
 * Runtime authorization for creating a new paper lifecycle. Existing paper
 * positions are managed independently and are never blocked by this gate.
 */
export function getPaperDeploymentGate({
  now = new Date(),
} = {}) {
  // Do not read config.rollout or accept a caller-provided coverage result.
  // This must remain a fresh evaluation of the private effective baseline and
  // the raw runtime state file selected during startup.
  const shadowStage = effectiveRolloutState.mode === "dry_run" && effectiveRolloutState.dryRun === true;
  const coverage = getHistoricalReplayCoverageGate({
    statePath: effectiveRolloutState.historicalReplayStateFile,
    now,
  });
  const pass = !shadowStage || coverage.pass === true;
  return Object.freeze({
    pass,
    applied: shadowStage,
    reason: pass ? null : coverage.reason || "HISTORICAL_REPLAY_COVERAGE_BELOW_MINIMUM",
    historicalReplayCoverage: coverage,
  });
}
const historicalReplayCoverage = getHistoricalReplayCoverageGate({
  statePath: configuredHistoricalReplayStateFile,
});

// This is deliberately an assignment, not ||=. envcrypt loads .env before
// config, and a stale DRY_RUN=false must never turn a configured dry run live.
enforceEffectiveRolloutEnvironment();
if (rolloutSafety.diagnostics.length > 0) {
  console.warn(
    `[rollout-safety] ${rolloutSafety.diagnostics.join("; ")}. ` +
    `Effective mode=${rolloutSafety.effectiveMode}; environment mirror DRY_RUN=${process.env.DRY_RUN}.`,
  );
}

function normalizeMultiLayerLayers(userConfig = {}) {
  const configuredLayers = Array.isArray(userConfig.multiLayerLayers)
    ? userConfig.multiLayerLayers
    : [
        {
          strategy: userConfig.multiLayerPrimaryStrategy ?? "bid_ask",
          pct: userConfig.multiLayerPrimaryPct ?? 70,
        },
        {
          strategy: userConfig.multiLayerSecondaryStrategy ?? "spot",
          pct: userConfig.multiLayerSecondaryPct ?? 30,
        },
      ];
  return configuredLayers
    .map((layer) => ({
      strategy: String(layer?.strategy || "").trim(),
      pct: Number(layer?.pct),
    }))
    .filter((layer) => layer.strategy && Number.isFinite(layer.pct) && layer.pct > 0);
}

function normalizeStringList(value) {
  return Array.isArray(value)
    ? value.map((entry) => String(entry || "").trim()).filter(Boolean)
    : [];
}

function normalizeRegimeHighVolAction(value, fallback = "deploy") {
  const normalized = String(value ?? fallback).trim().toLowerCase();
  return normalized === "skip" || normalized === "deploy" ? normalized : fallback;
}

export const config = {
  // ─── Risk Limits ─────────────────────────
  risk: {
    maxPositions:    activeCanary ? rolloutSafety.canaryLimits.maxPositions : (u.maxPositions    ?? 3),
    maxDeployAmount: activeCanary ? rolloutSafety.canaryLimits.deployAmountSol : (u.maxDeployAmount ?? 50),
    hardMinWalletEquitySol: Number(u.hardMinWalletEquitySol ?? u.minSolToOpen ?? 0.27),
    operationalReserveSol: Number(u.operationalReserveSol ?? u.gasReserve ?? 0.10),
    minimumSetupBufferSol: Number(u.minimumSetupBufferSol ?? 0.065),
    executionContingencySol: Number(u.executionContingencySol ?? 0.003),
  },

  // ─── Pool Screening Thresholds ───────────
  screening: {
    excludeHighSupplyConcentration: u.excludeHighSupplyConcentration ?? true,
    minFeeActiveTvlRatio: shadowRotationActive
      ? shadowRotationConfig.minFeeActiveTvlRatioPct
      : (u.minFeeActiveTvlRatio ?? 0.05),
    minTvl:            shadowRotationActive ? shadowRotationConfig.minPoolTvlUsd : (u.minTvl ?? 10_000),
    minActiveTvl:      shadowRotationActive ? shadowRotationConfig.minActiveTvlUsd : (u.minActiveTvl ?? u.minTvl ?? 10_000),
    maxTvl:            shadowRotationActive ? shadowRotationConfig.maxActiveTvlUsd : (u.maxTvl !== undefined ? u.maxTvl : 150_000),
    minVolume:         shadowRotationActive ? shadowRotationConfig.minVolumeUsd : (u.minVolume ?? 500),
    maxVolatility:     shadowRotationActive ? shadowRotationConfig.maxVolatilityExclusive : (u.maxVolatility ?? null),
    minOrganic:        shadowRotationActive ? shadowRotationConfig.minOrganicScoreBase : (u.minOrganic ?? 60),
    minQuoteOrganic:   u.minQuoteOrganic   ?? 60,
    minHolders:        shadowRotationActive ? shadowRotationConfig.minHolderCount : (u.minHolders ?? 500),
    minMcap:           shadowRotationActive ? shadowRotationConfig.minMarketCapUsd : (u.minMcap ?? 150_000),
    maxMcap: shadowRotationActive ? shadowRotationConfig.maxMarketCapUsd : (u.maxMcap ?? 10_000_000),
    minBinStep:        u.minBinStep        ?? 80,
    maxBinStep:        u.maxBinStep        ?? 125,
    timeframe:         u.timeframe         ?? "5m",
    category:          u.category          ?? "trending",
    minTokenFeesSol:   shadowRotationActive ? shadowRotationConfig.minGlobalFeesSol : (u.minTokenFeesSol ?? 30),  // global fees paid (priority+jito tips). below = bundled/scam
    useDiscordSignals: u.useDiscordSignals ?? false,
    discordSignalMode: u.discordSignalMode ?? "merge", // merge | only
    avoidPvpSymbols:   u.avoidPvpSymbols   ?? true, // detect exact-symbol rivals with real active pools
    blockPvpSymbols:   u.blockPvpSymbols   ?? false, // keep only the deterministic canonical pool for a PVP symbol
    maxBotHoldersPct:  shadowRotationActive ? shadowRotationConfig.maxBotHolderPct : (u.maxBotHoldersPct ?? 30),  // max bot holder addresses % (Jupiter audit)
    maxTop10Pct:       shadowRotationActive ? shadowRotationConfig.maxTop10Pct : (u.maxTop10Pct ?? 60),  // max top 10 holders concentration
    loneCandidateMinDegen: u.loneCandidateMinDegen ?? 50, // degen score that lets a SOLO candidate deploy without a narrative
    allowedLaunchpads: u.allowedLaunchpads ?? [],  // allow-list launchpads, [] = no allow-list
    blockedLaunchpads:  u.blockedLaunchpads  ?? [],  // e.g. ["letsbonk.fun", "pump.fun"]
    minTokenAgeHours:   shadowRotationActive ? shadowRotationConfig.minTokenAgeHours : (u.minTokenAgeHours ?? null), // null = no minimum
    maxTokenAgeHours: shadowRotationActive ? shadowRotationConfig.maxTokenAgeHours : (u.maxTokenAgeHours ?? null), // null = no maximum
    extraSearchSymbols: normalizeStringList(u.extraSearchSymbols),
    extraSearchLimitPerSymbol: Number(u.extraSearchLimitPerSymbol ?? 6),
    extraSearchOnlySolPools: u.extraSearchOnlySolPools ?? true,
    candidateConfirmationEnabled: u.candidateConfirmationEnabled ?? true,
    candidateConfirmationCount: shadowRotationActive ? shadowRotationConfig.confirmationCount : Math.max(1, Number(u.candidateConfirmationCount ?? 2)),
    candidateConfirmationMaxAgeMinutes: shadowRotationActive ? shadowRotationConfig.confirmationWindowMs / 60_000 : Math.max(1, Number(u.candidateConfirmationMaxAgeMinutes ?? 15)),
    candidateConfirmationMinSpacingMinutes: shadowRotationActive ? shadowRotationConfig.confirmationSpacingMs / 60_000 : Math.max(0, Number(u.candidateConfirmationMinSpacingMinutes ?? 2)),
    candidateMinFeeRetentionPct: shadowRotationActive ? shadowRotationConfig.minRetentionPct : Math.max(0, Number(u.candidateMinFeeRetentionPct ?? 70)),
    candidateMinVolumeRetentionPct: shadowRotationActive ? shadowRotationConfig.minRetentionPct : Math.max(0, Number(u.candidateMinVolumeRetentionPct ?? 70)),
    candidatePriceStabilityEnabled: shadowRotationActive,
    candidateMaxPriceDrawdownPct: shadowRotationActive ? shadowRotationConfig.maxPriceDrawdownPct : null,
    candidateMaxDownsideBinDelta: shadowRotationActive ? shadowRotationConfig.maxDownsideBinDelta : null,
    requireDisabledMintAuthority: u.requireDisabledMintAuthority ?? true,
    requireDisabledFreezeAuthority: u.requireDisabledFreezeAuthority ?? true,
    deploySnapshotMaxAgeMinutes: Math.max(1, Number(u.deploySnapshotMaxAgeMinutes ?? 2)),
    poolHistoryWindowDays: Math.max(1, Number(u.poolHistoryWindowDays ?? 30)),
    poolHistoryLossCooldownHours: Math.max(1, Number(u.poolHistoryLossCooldownHours ?? 24)),
    poolHistoryBlockDays: Math.max(1, Number(u.poolHistoryBlockDays ?? 7)),
    poolHistoryMinOorSamples: Math.max(1, Number(u.poolHistoryMinOorSamples ?? 3)),
    poolHistoryMaxOorRatePct: Math.max(0, Number(u.poolHistoryMaxOorRatePct ?? 60)),
    poolHistoryMinEvSamples: Math.max(1, Number(u.poolHistoryMinEvSamples ?? 5)),
    poolHistoryMinProfitFactor: Math.max(0, Number(u.poolHistoryMinProfitFactor ?? 1)),
  },

  // ─── Position Management ────────────────
  management: {
    strategyProfile: activeStrategyProfile,
    minClaimAmount:        u.minClaimAmount        ?? 5,
    outOfRangeBinsToClose: u.outOfRangeBinsToClose ?? 10,
    outOfRangeWaitMinutes: u.outOfRangeWaitMinutes ?? 30,
    oorCooldownTriggerCount: u.oorCooldownTriggerCount ?? 3,
    oorCooldownHours:       u.oorCooldownHours       ?? 12,
    repeatDeployCooldownEnabled: u.repeatDeployCooldownEnabled ?? true,
    repeatDeployCooldownTriggerCount: u.repeatDeployCooldownTriggerCount ?? 3,
    repeatDeployCooldownHours: u.repeatDeployCooldownHours ?? 12,
    repeatDeployCooldownScope: u.repeatDeployCooldownScope ?? "token", // pool | token | both
    repeatDeployCooldownMinFeeEarnedPct: u.repeatDeployCooldownMinFeeEarnedPct ?? u.repeatDeployCooldownMinFeeYieldPct ?? 0,
    badOutcomeCooldownEnabled: u.badOutcomeCooldownEnabled ?? true,
    badOutcomeCooldownScope: u.badOutcomeCooldownScope ?? "both", // pool | token | both
    lowYieldCooldownHours: u.lowYieldCooldownHours ?? 4,
    stopLossCooldownHours: u.stopLossCooldownHours ?? 12,
    shadowStopLossCooldownForRun: u.shadowStopLossCooldownForRun ?? true,
    shadowOutOfRangeCooldownHours: Math.max(0, Number(u.shadowOutOfRangeCooldownHours ?? 3)),
    minVolumeToRebalance:  u.minVolumeToRebalance  ?? 1000,
    // These switches are intentionally not user-configurable during the
    // locked shadow/canary baseline. No rebalance or fee reinvestment path may
    // activate before a later rollout explicitly introduces one.
    rebalanceEnabled:      lockedRolloutBaseline.rebalanceEnabled,
    compoundEnabled:       lockedRolloutBaseline.compoundEnabled,
    stopLossPct: shadowRotationActive
      ? shadowRotationConfig.stopLossPct
      : (u.stopLossPct ?? u.emergencyPriceDropPct ?? -50),
    takeProfitPct: shadowRotationActive
      ? shadowRotationConfig.takeProfitPct
      : (u.takeProfitPct ?? u.takeProfitFeePct ?? 5),
    takeProfitExecutionBufferPct: shadowRotationActive
      ? shadowRotationConfig.takeProfitExecutionBufferPct
      : Math.max(0, Number(u.takeProfitExecutionBufferPct ?? 0)),
    costAwareTakeProfitEnabled: u.costAwareTakeProfitEnabled ?? true,
    estimatedRoundTripCostPct: shadowRotationActive
      ? shadowRotationConfig.estimatedRoundTripCostPct
      : Math.max(0, Number(u.estimatedRoundTripCostPct ?? 1.0)),
    minNetProfitPct: shadowRotationActive
      ? shadowRotationConfig.minimumProjectedNetFeePct
      : Math.max(0, Number(u.minNetProfitPct ?? 0.25)),
    minNetProfitSol: shadowRotationActive
      ? shadowRotationConfig.minNetProfitSol
      : Math.max(0, Number(u.minNetProfitSol ?? 0.0005)),
    catastrophicStopPct: shadowRotationActive
      ? shadowRotationConfig.catastrophicStopPct
      : Number(u.catastrophicStopPct ?? -2.5),
    normalStopGraceMinutes: shadowRotationActive
      ? shadowRotationConfig.normalStopGraceMinutes
      : Math.max(0, Number(u.normalStopGraceMinutes ?? 0)),
    thesisReviewMinutes: shadowRotationActive
      ? shadowRotationConfig.thesisReviewMinutes
      : Math.max(1, Number(u.thesisReviewMinutes ?? 20)),
    thesisMinFeeRetentionPct: Math.max(0, Math.min(100, Number(u.thesisMinFeeRetentionPct ?? 50))),
    thesisMaxEarnedFeePct: Math.max(0, Number(u.thesisMaxEarnedFeePct ?? 0.05)),
    poolMemoryMaxNetPnlDiffPct: Math.max(0, Number(u.poolMemoryMaxNetPnlDiffPct ?? 3)),
    minFeePerTvl24h:       u.minFeePerTvl24h       ?? 7,
    minAgeBeforeYieldCheck: u.minAgeBeforeYieldCheck ?? 60, // minutes before low yield can trigger close
    lowYieldConfirmSamples: Math.max(1, Number(u.lowYieldConfirmSamples ?? 3)),
    lowYieldSampleSpacingMinutes: Math.max(1, Number(u.lowYieldSampleSpacingMinutes ?? 5)),
    lowYieldMaxCumulativeFeePct: Math.max(0, Number(u.lowYieldMaxCumulativeFeePct ?? 0.15)),
    maxHoldMinutes: shadowRotationActive
      ? shadowRotationConfig.maxHoldMinutes
      : Math.max(1, Number(u.maxHoldMinutes ?? 360)),
    shadowRotationAboveRangeExitMinutes: shadowRotationConfig.aboveRangeExitMinutes,
    shadowRotationCooldownForRun: shadowRotationConfig.cooldownForRun,
    shadowRotationCatastrophicQuarantineHours: shadowRotationConfig.catastrophicQuarantineHours,
    netExitPolicyEnabled: u.netExitPolicyEnabled ?? true,
    deadPositionCheck1Minutes: u.deadPositionCheck1Minutes ?? 90,
    deadPositionCheck1MaxPeakPct: u.deadPositionCheck1MaxPeakPct ?? 0.5,
    deadPositionCheck1MaxCurrentPct: u.deadPositionCheck1MaxCurrentPct ?? u.deadPositionCheck1MaxPeakPct ?? 0.5,
    deadPositionCheck1MaxFeePerTvl24h: u.deadPositionCheck1MaxFeePerTvl24h ?? u.minFeePerTvl24h ?? 3,
    deadPositionCheck2Minutes: u.deadPositionCheck2Minutes ?? 120,
    deadPositionCheck2MaxPeakPct: u.deadPositionCheck2MaxPeakPct ?? 0.8,
    minSolToOpen:          u.minSolToOpen          ?? 0.55,
    deployAmountSol:       activeCanary ? rolloutSafety.canaryLimits.deployAmountSol : (u.deployAmountSol ?? 0.5),
    gasReserve:            u.gasReserve            ?? 0.2,
    positionSizePct:       u.positionSizePct       ?? 0.35,
    // Trailing take-profit
    trailingTakeProfit:    u.trailingTakeProfit    ?? true,
    trailingTriggerPct:    u.trailingTriggerPct    ?? 3,    // activate trailing at X% PnL
    trailingDropPct:       u.trailingDropPct       ?? 1.5,  // close when drops X% from peak
    // Dynamic stop-loss / profit protection. Keeps the base SL early, then raises the
    // effective stop once a confirmed peak proves the position has room to lock profit.
    dynamicStopLossEnabled: u.dynamicStopLossEnabled ?? false,
    dynamicStopBasePct:     u.dynamicStopBasePct     ?? u.stopLossPct ?? u.emergencyPriceDropPct ?? -50,
    breakevenTriggerPct:    u.breakevenTriggerPct    ?? 1.0,
    breakevenStopPct:       u.breakevenStopPct       ?? 0.5,
    profitProtectTriggerPct: u.profitProtectTriggerPct ?? 2.0,
    profitProtectStopPct:    u.profitProtectStopPct ?? 1.0,
    profitProtectRetracePctPoints: Math.max(0, Number(u.profitProtectRetracePctPoints ?? 0.3)),
    retraceCloseTriggerPct:  u.retraceCloseTriggerPct ?? 1.5,
    retraceClosePct:         u.retraceClosePct ?? 50,
    dynamicStopMinAgeMinutes: u.dynamicStopMinAgeMinutes ?? 10,
    microProfitProtectEnabled: u.microProfitProtectEnabled ?? true,
    microProfitPeakTriggerPct: u.microProfitPeakTriggerPct ?? 0.5,
    microProfitRetracePct:     u.microProfitRetracePct     ?? 45,
    microProfitMinCurrentPct:  u.microProfitMinCurrentPct  ?? 0.05,
    microProfitMinAgeMinutes:  u.microProfitMinAgeMinutes  ?? 8,
    profitStallCloseEnabled:   u.profitStallCloseEnabled   ?? true,
    profitStallMinPeakPct:     u.profitStallMinPeakPct     ?? 0.55,
    profitStallMinCurrentPct:  u.profitStallMinCurrentPct  ?? 0.35,
    profitStallMinutes:        u.profitStallMinutes        ?? 6,
    profitStallMaxFeePerTvl24h: u.profitStallMaxFeePerTvl24h ?? u.minFeePerTvl24h ?? 3,
    peakDecayCloseEnabled:     u.peakDecayCloseEnabled     ?? true,
    peakDecayMinPeakPct:       u.peakDecayMinPeakPct       ?? 0.4,
    peakDecayMinDropPct:       u.peakDecayMinDropPct       ?? 0.25,
    peakDecayMinCurrentPct:    u.peakDecayMinCurrentPct    ?? 0.02,
    peakDecayMinutes:          u.peakDecayMinutes          ?? 12,
    peakDecayMaxFeePerTvl24h:  u.peakDecayMaxFeePerTvl24h  ?? u.minFeePerTvl24h ?? 3,
    pnlSanityMaxDiffPct:   u.pnlSanityMaxDiffPct   ?? 5,    // max allowed diff between reported and derived pnl % before ignoring a tick
    pnlNewPositionOutlierMinutes: u.pnlNewPositionOutlierMinutes ?? 10,
    pnlNewPositionOutlierMaxPct:  u.pnlNewPositionOutlierMaxPct  ?? 5,
    pnlOutlierMaxPct:            u.pnlOutlierMaxPct            ?? 20,
    pnlDivergenceGateMinPct:      u.pnlDivergenceGateMinPct      ?? 3,
    // SOL mode — positions, PnL, and balances reported in SOL instead of USD
    solMode:               u.solMode               ?? false,
    periodicClaimEnabled:  u.periodicClaimEnabled  ?? false,
  },

  // ─── Strategy Mapping ───────────────────
  strategy: {
    strategy:     u.strategy     ?? "bid_ask",
    minBinsBelow: strategyMinBinsBelow,
    maxBinsBelow: strategyMaxBinsBelow,
    defaultBinsBelow: strategyDefaultBinsBelow,
    upperBufferBins: Math.max(0, Number(u.upperBufferBins ?? 0)),
    upperBufferDryRunOnly: u.upperBufferDryRunOnly ?? true,
    multiLayerEnabled: lockedRolloutBaseline.multiLayerEnabled,
    multiLayerMode: u.multiLayerMode ?? "same_position",
    multiLayerLayers: normalizeMultiLayerLayers(u),
    multiLayerPrimaryStrategy: u.multiLayerPrimaryStrategy ?? "bid_ask",
    multiLayerSecondaryStrategy: u.multiLayerSecondaryStrategy ?? "spot",
    multiLayerPrimaryPct: Number(u.multiLayerPrimaryPct ?? 70),
    multiLayerSecondaryPct: Number(u.multiLayerSecondaryPct ?? 30),
    multiLayerMinLayerSol: Number(u.multiLayerMinLayerSol ?? u.multiLayerMinSecondarySol ?? 0.05),
    multiLayerMinSecondarySol: Number(u.multiLayerMinSecondarySol ?? u.multiLayerMinLayerSol ?? 0.05),
    multiLayerMinDeploySol: Number(u.multiLayerMinDeploySol ?? 0.3),
    regimeStrategyEnabled: u.regimeStrategyEnabled ?? false,
    regimeOverrideExplicitStrategy: u.regimeOverrideExplicitStrategy ?? true,
    regimeLowVolMax: Number(u.regimeLowVolMax ?? 1),
    regimeHighVolMin: Number(u.regimeHighVolMin ?? 2),
    regimeLowVolStrategy: u.regimeLowVolStrategy ?? "spot",
    regimeMidVolStrategy: u.regimeMidVolStrategy ?? u.strategy ?? "bid_ask",
    regimeHighVolStrategy: u.regimeHighVolStrategy ?? "bid_ask",
    regimeHighVolAction: shadowRotationActive ? "deploy" : normalizeRegimeHighVolAction(u.regimeHighVolAction),
  },

  shadowRotation: shadowRotationConfig,

  // ─── Scheduling ─────────────────────────
  schedule: {
    managementIntervalMin:       u.managementIntervalMin       ?? 10,
    screeningIntervalMin:        shadowRotationActive ? 1 : (u.screeningIntervalMin ?? 30),
    healthCheckIntervalMin:      u.healthCheckIntervalMin      ?? 60,
    pnlPollIntervalSec:          u.pnlPollIntervalSec          ?? 30,
    pnlPollTriggerCooldownSec:   u.pnlPollTriggerCooldownSec   ?? Math.max(60, (u.managementIntervalMin ?? 10) * 60),
    memoryLogIntervalMin:        u.memoryLogIntervalMin        ?? 5,
  },

  // ─── LLM Settings ──────────────────────
  llm: {
    temperature: u.temperature ?? 0.373,
    maxTokens:   u.maxTokens   ?? 4096,
    maxSteps:    u.maxSteps    ?? 20,
    managementModel: u.managementModel ?? process.env.LLM_MODEL ?? "openrouter/healer-alpha",
    screeningModel:  u.screeningModel  ?? process.env.LLM_MODEL ?? "openrouter/hunter-alpha",
    generalModel:    u.generalModel    ?? process.env.LLM_MODEL ?? "openrouter/healer-alpha",
  },

  // ─── Darwinian Signal Weighting ───────
  darwin: {
    enabled:        lockedRolloutBaseline.darwinEnabled,
    windowDays:     u.darwinWindowDays  ?? 60,
    recalcEvery:    u.darwinRecalcEvery ?? 5,    // recalc every N closes
    boostFactor:    u.darwinBoost       ?? 1.05,
    decayFactor:    u.darwinDecay       ?? 0.95,
    weightFloor:    u.darwinFloor       ?? 0.3,
    weightCeiling:  u.darwinCeiling     ?? 2.5,
    minSamples:     u.darwinMinSamples  ?? 10,
  },

  rollout: {
    // `mode` is the effective stage, while `requestedMode` preserves the
    // operator request for diagnostics. Only an accepted canary can be live.
    mode: effectiveRolloutState.mode,
    requestedMode: effectiveRolloutState.requestedMode,
    dryRun: effectiveRolloutState.dryRun,
    emergencyStop: effectiveRolloutState.emergencyStop,
    operatorOverrideActive: effectiveRolloutState.operatorOverrideActive,
    learningFrozen: effectiveRolloutState.learningFrozen,
    strategyProfile: activeStrategyProfile,
    safety: rolloutDiagnostics,
    // Locked rollout: a live stage can only ever be the 0.20 SOL / one
    // position canary. User-config values cannot enlarge this stage.
    canaryDeployAmountSol: effectiveRolloutState.canaryLimits.deployAmountSol,
    canaryMaxPositions: effectiveRolloutState.canaryLimits.maxPositions,
    shadowInitialEquitySol: Math.max(0.27, Number(u.shadowInitialEquitySol ?? 0.3)),
    shadowEvidenceFile: effectiveRolloutState.shadowEvidenceFile,
    historicalReplayStateFile: effectiveRolloutState.historicalReplayStateFile,
    shadowRunId: rolloutDiagnostics.acceptance.run_id,
    acceptanceArtifact: configuredAcceptanceArtifact,
    baseline: lockedRolloutBaseline,
    // This startup snapshot is diagnostic. Entry paths call
    // getPaperDeploymentGate() to recompute it from raw state at runtime.
    historicalReplayCoverage,
  },

  sizing: {
    enabled: lockedRolloutBaseline.adaptiveSizingEnabled,
    tiers: [
      { name: "small", minEquity: 0.27, maxEquity: 1, targetPct: 0.30, minPerPosition: 0.10, maxPerPosition: 0.20, maxPositions: 1, maxExposurePct: 0.35 },
      { name: "medium", minEquity: 1, maxEquity: 5, targetPct: 0.20, minPerPosition: 0.20, maxPerPosition: 0.75, maxPositions: 2, maxExposurePct: 0.40 },
      { name: "large", minEquity: 5, maxEquity: null, targetPct: 0.10, minPerPosition: 0.50, maxPerPosition: 2.00, maxPositions: 3, maxExposurePct: 0.30 },
    ],
  },

  ledger: {
    enabled: u.ledgerEnabled ?? true,
    path: nonEmptyString(u.ledgerPath, "trade-ledger.jsonl"),
    reconcileToleranceLamports: Math.max(0, Number(u.ledgerReconcileToleranceLamports ?? 10_000)),
    structuralResidualLamports: Math.max(0, Number(u.ledgerStructuralResidualLamports ?? 100_000)),
  },

  cleanup: {
    enabled: u.cleanupEnabled ?? true,
    minSwapNetLamports: Math.max(0, Number(u.cleanupMinSwapNetLamports ?? 100_000)),
    maxNetworkFeeLamports: Math.max(0, Number(u.cleanupMaxNetworkFeeLamports ?? 100_000)),
    maxPriceImpactPct: Math.max(0, Number(u.cleanupMaxPriceImpactPct ?? 5)),
    burnCapPerMintLamports: Math.max(0, Number(u.cleanupBurnCapPerMintLamports ?? 500_000)),
    burnCapPerSweepLamports: Math.max(0, Number(u.cleanupBurnCapPerSweepLamports ?? 2_000_000)),
    minRentRecoveryLamports: Math.max(0, Number(u.cleanupMinRentRecoveryLamports ?? 1_000_000)),
    maxBatchFeeLamports: Math.max(0, Number(u.cleanupMaxBatchFeeLamports ?? 20_000)),
    maxBurnClosePerBatch: 10,
    maxCloseOnlyPerBatch: 20,
    maxSerializedBytes: 1_100,
  },

  circuitBreaker: {
    enabled: strictBoolean(u.circuitBreakerEnabled) ?? true,
    automaticResume: strictBoolean(u.circuitAutomaticResume) ?? true,
    automaticResumeCooldownMs: Math.max(0, Number(u.circuitAutomaticResumeCooldownSeconds ?? 60)) * 1000,
    consecutiveLosses: positiveIntegerConfig(u.circuitConsecutiveLosses, 2),
    singleLossPct: negativeFiniteConfig(u.circuitSingleLossPct, -2),
    dailyLossMinSol: nonNegativeFiniteConfig(u.circuitDailyLossMinSol, 0.003),
    dailyLossPct: nonNegativeFiniteConfig(u.circuitDailyLossPct, 1.5),
    canaryDrawdownPct: nonNegativeFiniteConfig(u.circuitCanaryDrawdownPct, 3),
    consecutiveOperationalFailures: positiveIntegerConfig(u.circuitConsecutiveOperationalFailures, 2),
  },

  // ─── Common Token Mints ────────────────
  tokens: {
    SOL:  "So11111111111111111111111111111111111111112",
    USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  },

  helius: {
    baseUrl: nonEmptyString(u.heliusBaseUrl, process.env.HELIUS_BASE_URL, "https://api.helius.xyz"),
    apiKey: nonEmptyString(u.heliusApiKey, process.env.HELIUS_API_KEY, ""),
  },

  // ─── HiveMind ─────────────────────────
  hiveMind: {
    enabled: lockedRolloutBaseline.hiveMindEnabled,
    url: nonEmptyString(u.hiveMindUrl, DEFAULT_HIVEMIND_URL),
    apiKey: nonEmptyString(u.hiveMindApiKey, process.env.HIVEMIND_API_KEY, DEFAULT_HIVEMIND_API_KEY),
    agentId: u.agentId ?? null,
    pullMode: u.hiveMindPullMode ?? "auto",
  },

  api: {
    url: nonEmptyString(u.agentMeridianApiUrl, process.env.AGENT_MERIDIAN_API_URL, DEFAULT_AGENT_MERIDIAN_API_URL),
    publicApiKey: nonEmptyString(u.publicApiKey, process.env.PUBLIC_API_KEY, DEFAULT_AGENT_MERIDIAN_PUBLIC_KEY),
    lpAgentRelayEnabled: u.lpAgentRelayEnabled ?? false,
  },

  // ─── PnL fetcher / poller (public infra: RPC + Meteora deposits + Jupiter) ──
  pnl: {
    // Live position value comes from on-chain reads on this RPC.
    // Defaults to the public pump.helius endpoint so the aggressive poller
    // never burns the main RPC_URL or the LPAgent sponsor budget.
    rpcUrl: nonEmptyString(u.pnlRpcUrl, process.env.PNL_RPC_URL, "https://pump.helius-rpc.com"),
    source: nonEmptyString(u.pnlSource, "rpc"), // rpc | meteora (fallback-only)
    pollIntervalSec: Number(u.pnlPollIntervalSec ?? 3),
    depositCacheTtlSec: Number(u.pnlDepositCacheTtlSec ?? 300),
    // Consecutive confirming polls required before a peak is raised or an exit fires.
    // At a 3s poll cadence, 2 ticks ≈ 3-6s — filters single-tick noise without the
    // old fixed 15s setTimeout recheck.
    confirmTicks: Number(u.pnlConfirmTicks ?? 2),
    profitConfirmTicks: Number(u.pnlProfitConfirmTicks ?? 2),
    stopConfirmTicks: Number(u.pnlStopConfirmTicks ?? 3),
  },

  // ─── Opportunity poller (catches strong pools between screening cycles) ──
  opportunity: {
    enabled: u.opportunityPollEnabled ?? true,
    pollIntervalSec: Number(u.opportunityPollIntervalSec ?? 45),
    limit: Number(u.opportunityPollLimit ?? 10),
    // Pre-gate: only trigger the full deploy decision when the best candidate's
    // Degen Score (0..100) clears this bar — avoids running screening every 45s.
    minScore: Number(u.opportunityMinScore ?? 40),
    // A smart wallet (from the agentmeridian server) sitting on the pool LOWERS the
    // effective minScore by this much — a strong signal nudges a borderline pool through.
    smartWalletScoreBonus: Number(u.opportunitySmartWalletBonus ?? 20),
    // Degen Score targets (each sub-score saturates at its target). Tune to calibrate.
    // Inputs are normalized to a fixed 30m reference window, so these are timeframe-independent.
    targetVolRatio: Number(u.degenTargetVolRatio ?? 20),     // (30m) volume/active_tvl for full trading sub-score
    targetLpCount: Number(u.degenTargetLpCount ?? 40),       // (30m) unique_lps + positions_created for full LP sub-score
    targetFeeRatio: Number(u.degenTargetFeeRatio ?? 0.20),   // (30m) fee/active_tvl for full fee sub-score (tune per timeframe; fees don't normalize as cleanly as volume)
    // active_tvl ($) for full liquidity sub-score. NOT timeframe-scaled. Set near your
    // active-TVL floor (≈ minTvl) so it acts as a dust floor, not a stretch goal — the
    // screening minTvl filter already removes tiny pools.
    targetLiquidity: Number(u.degenTargetLiquidity ?? 20000),
  },

  // ─── GMGN (fee source for minTokenFeesSol gate) ──────────────
  gmgn: {
    apiKey: nonEmptyString(gmgnUserConfig.apiKey, u.gmgnApiKey, process.env.GMGN_API_KEY),
    baseUrl: nonEmptyString(gmgnUserConfig.baseUrl, u.gmgnBaseUrl, "https://openapi.gmgn.ai"),
    requestDelayMs: Number(gmgnUserConfig.requestDelayMs ?? u.gmgnRequestDelayMs ?? 2500),
    maxRetries: Number(gmgnUserConfig.maxRetries ?? u.gmgnMaxRetries ?? 2),
    // gmgn = use GMGN total_fee for global_fees_sol; jupiter = legacy Jupiter fees
    feeSource: nonEmptyString(gmgnUserConfig.feeSource, u.gmgnFeeSource, "gmgn"),
  },

  jupiter: {
    // Internal Jupiter Ultra settings; override by env only, do not expose in user-config.
    apiKey: process.env.JUPITER_API_KEY ?? "",
    referralAccount:
      process.env.JUPITER_REFERRAL_ACCOUNT ??
      "BKxig64GWjTTpBXi15jcM2mhUgR63NMVXo8iYDHTT8Jh",
    referralFeeBps: Number(
      process.env.JUPITER_REFERRAL_FEE_BPS ?? 50,
    ),
  },

  indicators: {
    enabled: indicatorUserConfig.enabled ?? false,
    entryPreset: indicatorUserConfig.entryPreset ?? "supertrend_break",
    exitPreset: indicatorUserConfig.exitPreset ?? "supertrend_break",
    rsiLength: indicatorUserConfig.rsiLength ?? 2,
    intervals: Array.isArray(indicatorUserConfig.intervals)
      ? indicatorUserConfig.intervals
      : ["5_MINUTE"],
    candles: indicatorUserConfig.candles ?? 298,
    rsiOversold: indicatorUserConfig.rsiOversold ?? 30,
    rsiOverbought: indicatorUserConfig.rsiOverbought ?? 80,
    entryRsiMin5m: Number(indicatorUserConfig.entryRsiMin5m ?? 40),
    entryRsiMin15m: Number(indicatorUserConfig.entryRsiMin15m ?? 35),
    entryRsiMax5m: Number(indicatorUserConfig.entryRsiMax5m ?? 75),
    entryRsiMax15m: Number(indicatorUserConfig.entryRsiMax15m ?? 80),
    entryRejectAboveUpperBand: indicatorUserConfig.entryRejectAboveUpperBand ?? true,
    requireAllIntervals: indicatorUserConfig.requireAllIntervals ?? false,
    hardFilter: indicatorUserConfig.hardFilter ?? false,
  },
};

function lockBaselineProperty(target, key, value) {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: false,
    writable: false,
  });
}

function lockConfigContainer(runtimeConfig, key) {
  Object.defineProperty(runtimeConfig, key, {
    value: runtimeConfig[key],
    enumerable: true,
    configurable: false,
    writable: false,
  });
}

function enforceLockedRolloutBaseline(runtimeConfig) {
  if (!isRolloutBaselineLocked()) return;
  const baseline = effectiveRolloutState.baseline;
  lockBaselineProperty(runtimeConfig.strategy, "multiLayerEnabled", baseline.multiLayerEnabled);
  lockBaselineProperty(runtimeConfig.darwin, "enabled", baseline.darwinEnabled);
  lockBaselineProperty(runtimeConfig.hiveMind, "enabled", baseline.hiveMindEnabled);
  lockBaselineProperty(runtimeConfig.management, "rebalanceEnabled", baseline.rebalanceEnabled);
  lockBaselineProperty(runtimeConfig.management, "compoundEnabled", baseline.compoundEnabled);
  lockBaselineProperty(runtimeConfig.sizing, "enabled", baseline.adaptiveSizingEnabled);
  // Preserve mutation of unrelated fields inside these objects, but prevent a
  // caller from replacing a whole container to discard its locked leaf.
  for (const key of ["strategy", "management", "darwin", "hiveMind", "sizing", "rollout", "shadowRotation"]) {
    lockConfigContainer(runtimeConfig, key);
  }
  Object.freeze(runtimeConfig.rollout);
  Object.freeze(runtimeConfig.shadowRotation);
}

enforceLockedRolloutBaseline(config);

/**
 * Compute the optimal deploy amount for a given wallet balance.
 * The legacy/manual path may scale position size with wallet growth only when
 * the rollout baseline explicitly allows compounding. Adaptive sizing for the
 * deterministic entry path remains independently enabled.
 *
 * Formula: clamp(deployable × positionSizePct, floor=deployAmountSol, ceil=maxDeployAmount)
 *
 * Examples (defaults: gasReserve=0.2, positionSizePct=0.35, floor=0.5):
 *   0.8 SOL wallet → 0.6 SOL deploy  (floor)
 *   2.0 SOL wallet → 0.63 SOL deploy
 *   3.0 SOL wallet → 0.98 SOL deploy
 *   4.0 SOL wallet → 1.33 SOL deploy
 */
export function computeDeployAmount(walletSol) {
  const reserve  = config.management.gasReserve      ?? 0.2;
  const pct      = config.management.positionSizePct ?? 0.35;
  const floor    = config.management.deployAmountSol;
  const ceil     = config.risk.maxDeployAmount;
  const deployable = Math.max(0, walletSol - reserve);
  const dynamic    = config.management.compoundEnabled === true ? deployable * pct : floor;
  const result     = Math.min(ceil, Math.max(floor, dynamic));
  return parseFloat(result.toFixed(2));
}

/**
 * Reload user-config.json and apply updated screening thresholds to the
 * in-memory config object. Called after threshold evolution so the next
 * agent cycle uses the evolved values without a restart.
 */
export function reloadScreeningThresholds() {
  try {
    if (!fs.existsSync(USER_CONFIG_PATH)) return;
    const fresh = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
    const s = config.screening;
    if (fresh.minFeeActiveTvlRatio != null && !config.shadowRotation.enabled) s.minFeeActiveTvlRatio = fresh.minFeeActiveTvlRatio;
    if (fresh.minTokenFeesSol  != null) s.minTokenFeesSol  = fresh.minTokenFeesSol;
    if (fresh.maxTop10Pct      != null) s.maxTop10Pct      = fresh.maxTop10Pct;
    if (fresh.useDiscordSignals !== undefined) s.useDiscordSignals = fresh.useDiscordSignals;
    if (fresh.discordSignalMode != null) s.discordSignalMode = fresh.discordSignalMode;
    if (fresh.excludeHighSupplyConcentration !== undefined) s.excludeHighSupplyConcentration = fresh.excludeHighSupplyConcentration;
    if (fresh.minOrganic     != null) s.minOrganic     = fresh.minOrganic;
    if (fresh.minQuoteOrganic != null) s.minQuoteOrganic = fresh.minQuoteOrganic;
    if (fresh.minHolders     != null) s.minHolders     = fresh.minHolders;
    if (fresh.minMcap        != null) s.minMcap        = fresh.minMcap;
    if (fresh.maxMcap        != null && !config.shadowRotation.enabled) s.maxMcap = fresh.maxMcap;
    if (fresh.minTvl         != null) s.minTvl         = fresh.minTvl;
    if (fresh.minActiveTvl   != null) s.minActiveTvl   = fresh.minActiveTvl;
    if (fresh.maxTvl         !== undefined) s.maxTvl   = fresh.maxTvl;
    if (fresh.minVolume      != null && !config.shadowRotation.enabled) s.minVolume = fresh.minVolume;
    if (fresh.maxVolatility  !== undefined && !config.shadowRotation.enabled) s.maxVolatility = fresh.maxVolatility;
    if (fresh.minBinStep     != null) s.minBinStep     = fresh.minBinStep;
    if (fresh.maxBinStep     != null) s.maxBinStep     = fresh.maxBinStep;
    if (fresh.timeframe         != null) s.timeframe         = fresh.timeframe;
    if (fresh.category          != null) s.category          = fresh.category;
    if (fresh.minTokenAgeHours  !== undefined) s.minTokenAgeHours = fresh.minTokenAgeHours;
    if (fresh.maxTokenAgeHours  !== undefined) s.maxTokenAgeHours = fresh.maxTokenAgeHours;
    if (fresh.avoidPvpSymbols   !== undefined) s.avoidPvpSymbols = fresh.avoidPvpSymbols;
    if (fresh.blockPvpSymbols   !== undefined) s.blockPvpSymbols = fresh.blockPvpSymbols;
    if (fresh.maxBotHoldersPct  != null) s.maxBotHoldersPct = fresh.maxBotHoldersPct;
    if (fresh.allowedLaunchpads !== undefined) s.allowedLaunchpads = fresh.allowedLaunchpads;
    if (fresh.blockedLaunchpads !== undefined) s.blockedLaunchpads = fresh.blockedLaunchpads;
    if (fresh.extraSearchSymbols !== undefined) s.extraSearchSymbols = normalizeStringList(fresh.extraSearchSymbols);
    if (fresh.extraSearchLimitPerSymbol != null) s.extraSearchLimitPerSymbol = Number(fresh.extraSearchLimitPerSymbol);
    if (fresh.extraSearchOnlySolPools !== undefined) s.extraSearchOnlySolPools = fresh.extraSearchOnlySolPools;
    if (fresh.candidateConfirmationEnabled !== undefined) s.candidateConfirmationEnabled = fresh.candidateConfirmationEnabled;
    if (fresh.candidateConfirmationCount != null) s.candidateConfirmationCount = Math.max(1, Number(fresh.candidateConfirmationCount));
    if (fresh.candidateConfirmationMaxAgeMinutes != null) s.candidateConfirmationMaxAgeMinutes = Math.max(1, Number(fresh.candidateConfirmationMaxAgeMinutes));
    if (fresh.candidateConfirmationMinSpacingMinutes != null) s.candidateConfirmationMinSpacingMinutes = Math.max(0, Number(fresh.candidateConfirmationMinSpacingMinutes));
    if (fresh.candidateMinFeeRetentionPct != null) s.candidateMinFeeRetentionPct = Math.max(0, Number(fresh.candidateMinFeeRetentionPct));
    if (fresh.candidateMinVolumeRetentionPct != null) s.candidateMinVolumeRetentionPct = Math.max(0, Number(fresh.candidateMinVolumeRetentionPct));
    if (config.shadowRotation.enabled) {
      s.minFeeActiveTvlRatio = config.shadowRotation.minFeeActiveTvlRatioPct;
      s.minTvl = config.shadowRotation.minPoolTvlUsd;
      s.minActiveTvl = config.shadowRotation.minActiveTvlUsd;
      s.maxTvl = config.shadowRotation.maxActiveTvlUsd;
      s.minVolume = config.shadowRotation.minVolumeUsd;
      s.minOrganic = config.shadowRotation.minOrganicScoreBase;
      s.minHolders = config.shadowRotation.minHolderCount;
      s.minMcap = config.shadowRotation.minMarketCapUsd;
      s.maxVolatility = config.shadowRotation.maxVolatilityExclusive;
      s.maxMcap = config.shadowRotation.maxMarketCapUsd;
      s.minTokenFeesSol = config.shadowRotation.minGlobalFeesSol;
      s.maxBotHoldersPct = config.shadowRotation.maxBotHolderPct;
      s.maxTop10Pct = config.shadowRotation.maxTop10Pct;
      s.minTokenAgeHours = config.shadowRotation.minTokenAgeHours;
      s.candidateConfirmationCount = config.shadowRotation.confirmationCount;
      s.candidateConfirmationMaxAgeMinutes = config.shadowRotation.confirmationWindowMs / 60_000;
      s.candidateConfirmationMinSpacingMinutes = config.shadowRotation.confirmationSpacingMs / 60_000;
      s.candidateMinFeeRetentionPct = config.shadowRotation.minRetentionPct;
      s.candidateMinVolumeRetentionPct = config.shadowRotation.minRetentionPct;
      config.strategy.regimeHighVolAction = "deploy";
    }
    const minBinsBelow = numericConfig(fresh.minBinsBelow) ?? config.strategy.minBinsBelow;
    const maxBinsBelow = numericConfig(fresh.maxBinsBelow) ?? numericConfig(fresh.binsBelow) ?? config.strategy.maxBinsBelow;
    const defaultBinsBelow = numericConfig(fresh.defaultBinsBelow) ?? numericConfig(fresh.binsBelow) ?? config.strategy.defaultBinsBelow ?? maxBinsBelow;
    config.strategy.minBinsBelow = Math.max(MIN_SAFE_BINS_BELOW, Math.round(minBinsBelow));
    config.strategy.maxBinsBelow = Math.max(config.strategy.minBinsBelow, Math.round(maxBinsBelow));
    config.strategy.defaultBinsBelow = Math.max(
      config.strategy.minBinsBelow,
      Math.min(config.strategy.maxBinsBelow, Math.round(defaultBinsBelow)),
    );
    if (!isRolloutBaselineLocked() && fresh.multiLayerEnabled !== undefined) {
      config.strategy.multiLayerEnabled = fresh.multiLayerEnabled;
    }
    if (fresh.multiLayerMode != null) config.strategy.multiLayerMode = fresh.multiLayerMode;
    if (fresh.multiLayerPrimaryStrategy != null) config.strategy.multiLayerPrimaryStrategy = fresh.multiLayerPrimaryStrategy;
    if (fresh.multiLayerSecondaryStrategy != null) config.strategy.multiLayerSecondaryStrategy = fresh.multiLayerSecondaryStrategy;
    if (fresh.multiLayerPrimaryPct != null) config.strategy.multiLayerPrimaryPct = Number(fresh.multiLayerPrimaryPct);
    if (fresh.multiLayerSecondaryPct != null) config.strategy.multiLayerSecondaryPct = Number(fresh.multiLayerSecondaryPct);
    if (
      fresh.multiLayerLayers !== undefined ||
      fresh.multiLayerPrimaryStrategy != null ||
      fresh.multiLayerSecondaryStrategy != null ||
      fresh.multiLayerPrimaryPct != null ||
      fresh.multiLayerSecondaryPct != null
    ) {
      config.strategy.multiLayerLayers = normalizeMultiLayerLayers(fresh);
    }
    if (fresh.multiLayerMinLayerSol != null) config.strategy.multiLayerMinLayerSol = Number(fresh.multiLayerMinLayerSol);
    if (fresh.multiLayerMinSecondarySol != null) config.strategy.multiLayerMinSecondarySol = Number(fresh.multiLayerMinSecondarySol);
    if (fresh.multiLayerMinDeploySol != null) config.strategy.multiLayerMinDeploySol = Number(fresh.multiLayerMinDeploySol);
    if (fresh.regimeStrategyEnabled !== undefined) config.strategy.regimeStrategyEnabled = fresh.regimeStrategyEnabled;
    if (fresh.regimeOverrideExplicitStrategy !== undefined) config.strategy.regimeOverrideExplicitStrategy = fresh.regimeOverrideExplicitStrategy;
    if (fresh.regimeLowVolMax != null) config.strategy.regimeLowVolMax = Number(fresh.regimeLowVolMax);
    if (fresh.regimeHighVolMin != null) config.strategy.regimeHighVolMin = Number(fresh.regimeHighVolMin);
    if (fresh.regimeLowVolStrategy != null) config.strategy.regimeLowVolStrategy = fresh.regimeLowVolStrategy;
    if (fresh.regimeMidVolStrategy != null) config.strategy.regimeMidVolStrategy = fresh.regimeMidVolStrategy;
    if (fresh.regimeHighVolStrategy != null) config.strategy.regimeHighVolStrategy = fresh.regimeHighVolStrategy;
    if (fresh.regimeHighVolAction != null) {
      config.strategy.regimeHighVolAction = normalizeRegimeHighVolAction(
        fresh.regimeHighVolAction,
        config.strategy.regimeHighVolAction,
      );
    }
    // Rotation is a shadow-only profile with its own bounded volatility cap.
    // A legacy regime action must not reintroduce the lower yield-hold cutoff
    // after the profile-specific screening values were restored above.
    if (config.shadowRotation.enabled) config.strategy.regimeHighVolAction = "deploy";
  } catch { /* ignore */ }
}
