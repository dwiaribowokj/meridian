import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-shadow-rotation-"));
const statePath = path.join(tempDir, "state.json");
process.env.MERIDIAN_STATE_FILE = statePath;
process.env.MERIDIAN_USER_CONFIG_FILE = path.join(tempDir, "user-config.json");
fs.writeFileSync(statePath, JSON.stringify({ positions: {}, paperPositions: {}, recentEvents: [] }));
fs.writeFileSync(process.env.MERIDIAN_USER_CONFIG_FILE, JSON.stringify({ dryRun: true, rolloutMode: "dry_run" }));

const {
  candidatePolicyFromScreening,
  calculateEntryFeeEconomics,
  evaluateCandidate,
  evaluateCandidateStability,
  evaluateEntryMomentum,
  isAuthorizedRotationRange,
  minimumBinsBelowForStrategyProfile,
  resolveEntryStrategyProfile,
  resolveShadowRotationRange,
  SHADOW_ROTATION_POLICY,
  SHADOW_ROTATION_STRATEGY_PROFILE,
  YIELD_HOLD_STRATEGY_PROFILE,
} = await import("../risk-policy.js");
const {
  getPaperPosition,
  getShadowRolloutEvidenceSnapshot,
  getTrackedPosition,
  isShadowBaseMintOnCooldown,
  registerExitSignal,
  trackPosition,
  trackPaperPosition,
  updatePnlAndCheckExits,
} = await import("../state.js");
const { runShadowLifecycleCycle } = await import("../shadow-lifecycle.js");
const { appendShadowEvidenceHeartbeat, evaluateShadowEvidence } = await import("../rollout-evidence.js");
const { getPoolFeeWindow } = await import("../tools/screening.js");
const { isStopLossCloseReason } = await import("../pool-memory.js");

const rotation = {
  enabled: true,
  minVolumeUsd: 250,
  minActiveTvlUsd: 400,
  maxActiveTvlUsd: 300_000,
  minMarketCapUsd: 50_000,
  maxMarketCapUsd: 50_000_000,
  minHolderCount: 500,
  minOrganicScoreBase: 70,
  minTokenAgeHours: 1,
  maxTokenAgeHours: 72,
  minGlobalFeesSol: 80,
  maxBotHolderPct: 25,
  maxTop10Pct: 30,
  confirmationCount: 3,
  confirmationSpacingMs: 30_000,
  confirmationWindowMs: 5 * 60_000,
  minRetentionPct: 60,
  maxPriceDrawdownPct: 1.5,
  maxDownsideBinDelta: 2,
  maxPositionActiveTvlPct: 2,
  minEntryRsi15m: 35,
  maxEntryRsi5m: 75,
  maxEntryRsi15m: 80,
  feeParticipationPct: 75,
  estimatedRoundTripCostPct: 0.4,
  minimumProjectedNetFeePct: 0.1,
  maxHoldMinutes: 90,
  maxVolatilityExclusive: 4.5,
  mediumVolatilityMin: 3.5,
  mediumVolatilityBinsBelow: 6,
  mediumVolatilityBinsAbove: 2,
};
assert.equal(SHADOW_ROTATION_STRATEGY_PROFILE, "rotation_live_v1");
assert.equal(SHADOW_ROTATION_POLICY.fundingModel, "single_side_sol");
assert.equal(SHADOW_ROTATION_POLICY.binsBelow, 4);
assert.equal(SHADOW_ROTATION_POLICY.binsAbove, 1);
assert.equal(SHADOW_ROTATION_POLICY.entryExecutableQuoteSlippageBps, 25);
assert.equal(SHADOW_ROTATION_POLICY.normalStopGraceMinutes, 0);
assert.deepEqual(resolveShadowRotationRange(3.49, SHADOW_ROTATION_POLICY), {
  eligible: true,
  regime: "low_volatility",
  volatility: 3.49,
  binsBelow: 4,
  binsAbove: 1,
});
assert.deepEqual(resolveShadowRotationRange(3.5, SHADOW_ROTATION_POLICY), {
  eligible: true,
  regime: "medium_volatility",
  volatility: 3.5,
  binsBelow: 6,
  binsAbove: 2,
});
assert.equal(resolveShadowRotationRange(4.5, SHADOW_ROTATION_POLICY).eligible, false);

const feeWindowCache = new Map();
let feeWindowFetches = 0;
const readMockFeeWindow = async () => ({
  fee_active_tvl_ratio: ++feeWindowFetches === 1 ? 1.2 : 0.4,
});
const firstFeeWindow = await getPoolFeeWindow({
  pool_address: "fee-window-pool",
  timeframe: "30m",
  nowMs: 1_000,
  cacheTtlMs: 10_000,
  cache: feeWindowCache,
  fetchDetail: readMockFeeWindow,
});
const cachedFeeWindow = await getPoolFeeWindow({
  pool_address: "fee-window-pool",
  timeframe: "30m",
  nowMs: 6_000,
  cacheTtlMs: 10_000,
  cache: feeWindowCache,
  fetchDetail: readMockFeeWindow,
});
const refreshedFeeWindow = await getPoolFeeWindow({
  pool_address: "fee-window-pool",
  timeframe: "30m",
  nowMs: 11_000,
  cacheTtlMs: 10_000,
  cache: feeWindowCache,
  fetchDetail: readMockFeeWindow,
});
assert.equal(feeWindowFetches, 2);
assert.deepEqual(cachedFeeWindow, firstFeeWindow, "one API snapshot remains stable inside the cache window");
assert.equal(refreshedFeeWindow.current_fee_tvl_ratio, 0.4);
assert.notEqual(refreshedFeeWindow.current_fee_observed_at, firstFeeWindow.current_fee_observed_at);
assert.equal(await getPoolFeeWindow({
  pool_address: "missing-fee-window-pool",
  timeframe: "30m",
  nowMs: 1_000,
  cache: new Map(),
  fetchDetail: async () => ({ fee_active_tvl_ratio: null }),
}), null, "a missing fee metric cannot be coerced into a false zero-flow thesis signal");
assert.equal(isStopLossCloseReason("Rotation fee thesis failed after 20m"), true);
assert.equal(resolveEntryStrategyProfile({
  effectiveDryRun: false,
  effectiveRolloutMode: "canary",
  rotationEnabled: true,
}), SHADOW_ROTATION_STRATEGY_PROFILE);
assert.equal(resolveEntryStrategyProfile({
  effectiveDryRun: false,
  effectiveRolloutMode: "dry_run",
  rotationEnabled: true,
}), YIELD_HOLD_STRATEGY_PROFILE);
const policy = candidatePolicyFromScreening({
  minFeeActiveTvlRatio: 1.0,
  minVolume: 250,
  minActiveTvl: 400,
  minMcap: 50_000,
  maxMcap: 50_000_000,
  minHolders: 500,
  minOrganic: 70,
  maxBotHoldersPct: 25,
  maxTop10Pct: 30,
  minTokenAgeHours: 1,
  minTokenFeesSol: 80,
  maxVolatility: 4.5,
  candidateConfirmationCount: 3,
  candidateConfirmationMinSpacingMinutes: 0.5,
  candidateConfirmationMaxAgeMinutes: 5,
  candidateMinFeeRetentionPct: 60,
  candidateMinVolumeRetentionPct: 60,
}, {
  strategyProfile: SHADOW_ROTATION_STRATEGY_PROFILE,
  shadowRotation: rotation,
  management: { estimatedRoundTripCostPct: 0.4, maxHoldMinutes: 240 },
  indicators: {},
});

assert.equal(policy.candidate.strategyProfile, SHADOW_ROTATION_STRATEGY_PROFILE);
assert.equal(policy.candidate.minFeeActiveTvlRatioPct, 1.0);
assert.equal(policy.candidate.minEntryRsi15m, 35);
assert.equal(policy.candidate.maxEntryRsi5m, 75);
assert.equal(policy.candidate.minVolumeUsd, 250);
assert.equal(policy.candidate.minActiveTvlUsd, 400);
assert.equal(policy.candidate.minMarketCapUsd, 50_000);
assert.equal(policy.candidate.minHolderCount, 500);
assert.equal(policy.candidate.maxBotHolderPct, 25);
assert.equal(policy.candidate.maxVolatilityExclusive, 4.5);
assert.equal(policy.candidate.maxTokenAgeHours, 72);
assert.equal(policy.candidate.requiredObservationCount, 3);
assert.equal(policy.candidate.minObservationSpacingMs, 30_000);
assert.equal(calculateEntryFeeEconomics({ timeframeMinutes: 30, feeActiveTvlRatioPct: 0.45 }, policy).eligible, true);
assert.equal(calculateEntryFeeEconomics({ timeframeMinutes: 30, feeActiveTvlRatioPct: 0.44 }, policy).eligible, false);

const stability = evaluateCandidateStability([
  { observedAtMs: 0, feeValue: 0.45, volumeValue: 250, priceValue: 1, binStepValue: 100 },
  { observedAtMs: 30_000, feeValue: 0.50, volumeValue: 275, priceValue: 1.004, binStepValue: 100 },
  { observedAtMs: 60_000, feeValue: 0.54, volumeValue: 300, priceValue: 1.006, binStepValue: 100 },
], 60_000, policy);
assert.equal(stability.eligible, true);
assert.equal(stability.feeAccelerationPct, 120);
assert.equal(stability.volumeAccelerationPct, 120);
assert.equal(stability.hotnessScore, 120);

const trendContinuation = {
  momentum5m: {
    available: true,
    supertrendDirection: "bearish",
    supertrendBreakUp: false,
    supertrendBreakDown: false,
    rsi: 37.47,
    close: 0.000382,
    previousClose: 0.0003782,
    lowerBand: 0.0003483,
    upperBand: 0.0004793,
  },
  momentum15m: {
    available: true,
    supertrendDirection: "bearish",
    supertrendBreakUp: false,
    supertrendBreakDown: false,
    rsi: 42.49,
    close: 0.0003686,
    previousClose: 0.0003503,
    lowerBand: 0.0003474,
    upperBand: 0.0006137,
  },
};
assert.equal(evaluateEntryMomentum(trendContinuation, policy).eligible, true);
assert.ok(evaluateEntryMomentum({
  ...trendContinuation,
  momentum5m: { ...trendContinuation.momentum5m, rsi: 75 },
}, policy).reasons.includes("FIVE_MINUTE_RSI_ABOVE_MAXIMUM"));
assert.ok(evaluateEntryMomentum({
  ...trendContinuation,
  momentum15m: { ...trendContinuation.momentum15m, rsi: 34.99 },
}, policy).reasons.includes("FIFTEEN_MINUTE_RSI_BELOW_RECOVERY_MINIMUM"));
const yieldPolicy = candidatePolicyFromScreening({}, { management: {}, indicators: {} });
assert.equal(evaluateEntryMomentum(trendContinuation, yieldPolicy).eligible, false);
const fadingFiveMinuteTrend = evaluateEntryMomentum({
  ...trendContinuation,
  momentum5m: { ...trendContinuation.momentum5m, rsi: 75.6 },
  momentum5m: {
    ...trendContinuation.momentum5m,
    close: trendContinuation.momentum5m.previousClose * 0.99,
  },
}, policy);
assert.equal(fadingFiveMinuteTrend.eligible, false);
assert.ok(fadingFiveMinuteTrend.reasons.includes("ROTATION_5M_TREND_NOT_CONFIRMED"));
assert.ok(evaluateEntryMomentum({
  ...trendContinuation,
  momentum15m: { ...trendContinuation.momentum15m, close: 0.00034 },
}, policy).reasons.includes("ROTATION_15M_TREND_NOT_CONFIRMED"));

const tuckerClassCandidate = {
  strategyProfile: SHADOW_ROTATION_STRATEGY_PROFILE,
  poolAddress: "TuckerPool1111111111111111111111111111111",
  pairType: "TOKEN-SOL",
  protocol: "DLMM",
  timeframeMinutes: 30,
  evaluatedAtMs: 60_000,
  requestedDeployUsd: 14.78,
  activeTvlUsd: 841.47,
  volumeUsd: 515.17,
  feeActiveTvlRatioPct: 1.98,
  volatility: 4.04,
  binStep: 100,
  organicScoreBase: 74.24,
  organicScoreQuote: 99.34,
  holderCount: 1_494,
  marketCapUsd: 97_899,
  tokenAgeHours: 47,
  globalFeesSol: 137,
  smartWalletCount: 0,
  audit: {
    checkedAtMs: 60_000,
    botHolderPct: 23.05,
    top10Pct: 22.24,
    mintAuthorityDisabled: true,
    freezeAuthorityDisabled: true,
    criticalWarning: false,
    highConcentration: false,
    highSingleOwner: false,
    pvp: false,
    blocklisted: false,
  },
  ...trendContinuation,
  observations: [
    { observedAtMs: 0, feeValue: 1.80, volumeValue: 480, priceValue: 1, binStepValue: 100 },
    { observedAtMs: 30_000, feeValue: 1.90, volumeValue: 500, priceValue: 1.004, binStepValue: 100 },
    { observedAtMs: 60_000, feeValue: 1.98, volumeValue: 515.17, priceValue: 1.006, binStepValue: 100 },
  ],
};
const tuckerEvaluation = evaluateCandidate(tuckerClassCandidate, { nowMs: 60_000 }, policy);
assert.equal(tuckerEvaluation.eligible, true, tuckerEvaluation.reasons.join(", "));
assert.ok(tuckerEvaluation.rankingMetrics.positionActiveTvlPct > 1);
assert.ok(tuckerEvaluation.rankingMetrics.positionActiveTvlPct < 2);
assert.ok(evaluateCandidate({ ...tuckerClassCandidate, requestedDeployUsd: 20 }, { nowMs: 60_000 }, policy)
  .reasons.includes("POSITION_ACTIVE_TVL_SHARE_TOO_HIGH"));
assert.ok(evaluateCandidate({ ...tuckerClassCandidate, tokenAgeHours: 311 }, { nowMs: 60_000 }, policy)
  .reasons.includes("TOKEN_TOO_OLD"));
assert.ok(evaluateCandidate({ ...tuckerClassCandidate, feeActiveTvlRatioPct: 0.999 }, { nowMs: 60_000 }, policy)
  .reasons.includes("FEE_ACTIVE_TVL_RATIO_BELOW_MINIMUM"));
assert.equal(
  evaluateCandidate({ ...tuckerClassCandidate, volatility: 4.49 }, { nowMs: 60_000 }, policy).eligible,
  true,
);
assert.ok(evaluateCandidate({ ...tuckerClassCandidate, volatility: 4.5 }, { nowMs: 60_000 }, policy)
  .reasons.includes("VOLATILITY_OUT_OF_RANGE"));
assert.ok(evaluateCandidate({
  ...tuckerClassCandidate,
  audit: { ...tuckerClassCandidate.audit, botHolderPct: 25.01 },
}, { nowMs: 60_000 }, policy).reasons.includes("BOT_HOLDER_CONCENTRATION_TOO_HIGH"));
const priceUnstable = evaluateCandidate({
  ...tuckerClassCandidate,
  observations: [
    { observedAtMs: 0, feeValue: 1.80, volumeValue: 480, priceValue: 1, binStepValue: 100 },
    { observedAtMs: 30_000, feeValue: 1.90, volumeValue: 500, priceValue: 1.002, binStepValue: 100 },
    { observedAtMs: 60_000, feeValue: 1.98, volumeValue: 515.17, priceValue: 0.98, binStepValue: 100 },
  ],
}, { nowMs: 60_000 }, policy);
assert.ok(priceUnstable.reasons.includes("PRICE_DRAWDOWN_ABOVE_MAXIMUM"));
assert.ok(priceUnstable.reasons.includes("DOWNSIDE_BIN_JUMP_ABOVE_MAXIMUM"));

const recentOutcomeCalibration = [
  { name: "lmeow", won: true, expectedEligible: true, fee: 1.2872683639, rsi5m: 72.3201, rsi15m: 45.3271 },
  { name: "MANLET", won: true, expectedEligible: true, fee: 1.6088416769, rsi5m: 45.6108, rsi15m: 42.3803 },
  { name: "TINYTANK", won: true, expectedEligible: true, fee: 3.3548810819, rsi5m: 67.6174, rsi15m: 48.7888 },
  { name: "JLY", won: false, expectedEligible: false, fee: 0.7781745211, rsi5m: 72.8016, rsi15m: 41.8741 },
  // The 1.0 canary floor deliberately admits this historical false-positive;
  // the 24-hour trial measures that frequency/quality trade-off explicitly.
  { name: "Doom", won: false, expectedEligible: true, fee: 1.2495147565, rsi5m: 56.0182, rsi15m: 52.0098 },
  { name: "FROGE", won: false, expectedEligible: false, fee: 0.5043524175, rsi5m: 78.5181, rsi15m: 52.874 },
  { name: "BUTTHOLE", won: false, expectedEligible: false, fee: 0.7247425299, rsi5m: 76.1887, rsi15m: 77.2289 },
  // The relaxed 15m recovery floor admits this historical false-positive;
  // price stability and exit controls remain responsible for containing it.
  { name: "ICM", won: false, expectedEligible: true, fee: 1.9247186271, rsi5m: 58.691, rsi15m: 37.4011 },
];
for (const outcome of recentOutcomeCalibration) {
  const evaluation = evaluateCandidate({
    ...tuckerClassCandidate,
    feeActiveTvlRatioPct: outcome.fee,
    momentum5m: { ...tuckerClassCandidate.momentum5m, rsi: outcome.rsi5m },
    momentum15m: { ...tuckerClassCandidate.momentum15m, rsi: outcome.rsi15m },
  }, { nowMs: 60_000 }, policy);
  assert.equal(
    evaluation.eligible,
    outcome.expectedEligible,
    `${outcome.name} calibration mismatch: ${evaluation.reasons.join(", ")}`,
  );
}

assert.equal(minimumBinsBelowForStrategyProfile({
  effectiveDryRun: true,
  rotationEnabled: true,
  strategyProfile: SHADOW_ROTATION_STRATEGY_PROFILE,
  rotationBinsBelow: 4,
  liveMinimumBinsBelow: 35,
}), 4);
assert.equal(minimumBinsBelowForStrategyProfile({
  effectiveDryRun: false,
  effectiveRolloutMode: "canary",
  rotationEnabled: true,
  strategyProfile: SHADOW_ROTATION_STRATEGY_PROFILE,
  rotationBinsBelow: 4,
  liveMinimumBinsBelow: 35,
}), 4);
assert.equal(minimumBinsBelowForStrategyProfile({
  effectiveDryRun: false,
  effectiveRolloutMode: "dry_run",
  rotationEnabled: true,
  strategyProfile: SHADOW_ROTATION_STRATEGY_PROFILE,
  rotationBinsBelow: 5,
  liveMinimumBinsBelow: 35,
}), 35);

const authorizedLiveRotationRange = {
  effectiveDryRun: false,
  effectiveRolloutMode: "canary",
  rotationEnabled: true,
  strategyProfile: SHADOW_ROTATION_STRATEGY_PROFILE,
  strategy: "spot",
  binsBelow: 4,
  binsAbove: 1,
  volatility: 3,
  rotationStrategy: "spot",
  rotationBinsBelow: 4,
  rotationBinsAbove: 1,
};
assert.equal(isAuthorizedRotationRange(authorizedLiveRotationRange), true);
assert.equal(isAuthorizedRotationRange({ ...authorizedLiveRotationRange, effectiveRolloutMode: "adaptive" }), false);
assert.equal(isAuthorizedRotationRange({ ...authorizedLiveRotationRange, rotationEnabled: false }), false);
assert.equal(isAuthorizedRotationRange({ ...authorizedLiveRotationRange, strategyProfile: YIELD_HOLD_STRATEGY_PROFILE }), false);
assert.equal(isAuthorizedRotationRange({ ...authorizedLiveRotationRange, strategy: "bid_ask" }), false);
assert.equal(isAuthorizedRotationRange({ ...authorizedLiveRotationRange, binsBelow: 5 }), false);
assert.equal(isAuthorizedRotationRange({ ...authorizedLiveRotationRange, binsAbove: 0 }), false);
assert.equal(isAuthorizedRotationRange({
  ...authorizedLiveRotationRange,
  volatility: 3.7,
  binsBelow: 6,
  binsAbove: 2,
  rotationMediumVolatilityMin: 3.5,
  rotationMediumBinsBelow: 6,
  rotationMediumBinsAbove: 2,
  rotationMaxVolatilityExclusive: 4.5,
}), true);
assert.equal(isAuthorizedRotationRange({
  ...authorizedLiveRotationRange,
  binsBelow: 4,
  binsAbove: 0,
  rotationBinsBelow: 4,
  rotationBinsAbove: 0,
}), false, "a config-matching four-bin rotation range is still too narrow");
assert.equal(isAuthorizedRotationRange({
  ...authorizedLiveRotationRange,
  binsBelow: 5,
  binsAbove: 0,
  rotationBinsBelow: 5,
  rotationBinsAbove: 0,
}), true, "the safe 5+0 rollback remains executable");
assert.equal(minimumBinsBelowForStrategyProfile({
  effectiveDryRun: true,
  rotationEnabled: true,
  strategyProfile: YIELD_HOLD_STRATEGY_PROFILE,
  rotationBinsBelow: 5,
  liveMinimumBinsBelow: 35,
}), 35);

const startedAt = Date.UTC(2026, 7, 4, 0, 0, 0);
const baseMint = "RotationToken11111111111111111111111111111";
const paperId = trackPaperPosition({
  pool: "rotation-pool",
  pool_name: "ROTATION-SOL",
  base_mint: baseMint,
  strategy: "spot",
  funding_model: "single_side_sol",
  bin_range: { min: 96, max: 101, bins_below: 4, bins_above: 1 },
  amount_sol: 0.2,
  active_bin: 100,
  active_price: 1,
  min_price: 0.96,
  max_price: 1.01,
  bin_step: 100,
  volatility: 3,
  fee_tvl_ratio: 1.98,
  fee_timeframe: "30m",
  policy_snapshot: {
    strategyProfile: SHADOW_ROTATION_STRATEGY_PROFILE,
    fundingModel: "single_side_sol",
    entryEconomics: calculateEntryFeeEconomics({ timeframeMinutes: 30, feeActiveTvlRatioPct: 1.98 }, policy),
    entryExecutableLiquidity: {
      source: "jupiter_swap_v2_quote",
      baseMint,
      quotedAtMs: startedAt,
      inputSolLamports: "200000000",
      modeledTokenRaw: "123456",
      executableRecoveryLamports: "198000000",
      recoveryBps: 9900,
      roundTripLossBps: 100,
      buy: { routeFound: true, worstOutRaw: "123456", priceImpactBps: 10 },
      sell: { routeFound: true, worstOutRaw: "199000000", worstNetLamports: "198000000", priceImpactBps: 20 },
      rawOrder: { transaction: "must-not-be-persisted" },
    },
    observations: tuckerClassCandidate.observations,
  },
  nowMs: startedAt,
});

assert.throws(() => trackPaperPosition({
  pool: "yield-pool",
  pool_name: "YIELD-SOL",
  base_mint: "YieldToken111111111111111111111111111111",
  strategy: "bid_ask",
  bin_range: { min: 65, max: 100, bins_below: 35, bins_above: 0 },
  amount_sol: 0.1,
  active_bin: 100,
  policy_snapshot: { strategyProfile: YIELD_HOLD_STRATEGY_PROFILE },
  nowMs: startedAt + 1,
}), /cannot accept/);

const managementConfig = {
  strategyProfile: SHADOW_ROTATION_STRATEGY_PROFILE,
  netExitPolicyEnabled: true,
  estimatedRoundTripCostPct: 0.4,
  minNetProfitPct: 0.1,
  minNetProfitSol: 0.00005,
  takeProfitPct: 0.5,
  stopLossPct: -1.25,
  catastrophicStopPct: -2.5,
  normalStopGraceMinutes: 0,
  thesisReviewMinutes: 20,
  thesisMinFeeRetentionPct: 50,
  thesisMaxEarnedFeePct: 0.05,
  maxHoldMinutes: 90,
  outOfRangeBinsToClose: 10,
  outOfRangeWaitMinutes: 20,
  shadowRotationAboveRangeExitMinutes: 5,
  shadowRotationCooldownForRun: true,
  shadowRotationCatastrophicQuarantineHours: 168,
  badOutcomeCooldownEnabled: true,
};

trackPosition({
  position: "live-immediate-stop",
  pool: "live-stop-pool",
  amount_sol: 0.2,
  local_cost_basis_lamports: 200_000_000,
  basis_status: "READY",
  fee_tvl_ratio: 1.2,
  fee_timeframe: "30m",
});
const trackedImmediateStop = getTrackedPosition("live-immediate-stop");
assert.equal(trackedImmediateStop.initial_fee_tvl_ratio, 1.2);
assert.equal(trackedImmediateStop.initial_fee_tvl_24h, null, "a 30m entry is never mislabeled as 24h");
assert.equal(updatePnlAndCheckExits("live-immediate-stop", {
  age_minutes: 1,
  projected_net_pnl_pct: -1.3,
  projected_net_pnl_sol: -0.0026,
  pnl_basis_valid: true,
  pnl_pct_suspicious: false,
  in_range: true,
}, managementConfig).action, "STOP_LOSS", "normal SL is armed immediately and still confirmed by the caller");

trackPosition({
  position: "live-grace-boundary",
  pool: "live-grace-pool",
  amount_sol: 0.2,
  local_cost_basis_lamports: 200_000_000,
  basis_status: "READY",
});
const legacyGraceConfig = { ...managementConfig, normalStopGraceMinutes: 15 };
assert.equal(updatePnlAndCheckExits("live-grace-boundary", {
  age_minutes: 14,
  projected_net_pnl_pct: -1.3,
  projected_net_pnl_sol: -0.0026,
  pnl_basis_valid: true,
  pnl_pct_suspicious: false,
  in_range: true,
}, legacyGraceConfig), null, "an explicitly configured grace still has a tested boundary");
assert.equal(updatePnlAndCheckExits("live-grace-boundary", {
  age_minutes: 14,
  projected_net_pnl_pct: -2.6,
  projected_net_pnl_sol: -0.0052,
  pnl_basis_valid: true,
  pnl_pct_suspicious: false,
  in_range: true,
}, legacyGraceConfig).action, "CATASTROPHIC_STOP", "catastrophic protection remains immediate during any grace");

trackPosition({
  position: "live-fee-thesis",
  pool: "live-thesis-pool",
  amount_sol: 0.2,
  local_cost_basis_lamports: 200_000_000,
  basis_status: "READY",
  fee_tvl_ratio: 1,
  fee_timeframe: "30m",
});
const thesisPositionData = {
  age_minutes: 20,
  projected_net_pnl_pct: -0.2,
  projected_net_pnl_sol: -0.0004,
  pnl_basis_valid: true,
  pnl_pct_suspicious: false,
  in_range: true,
  fee_per_tvl_24h: 176,
  unclaimed_fees_usd: 0,
  collected_fees_usd: 0,
  current_fee_tvl_ratio: 0.49,
  current_fee_observed_at: "2026-08-19T00:00:00.000Z",
};
assert.equal(updatePnlAndCheckExits("live-fee-thesis", {
  ...thesisPositionData,
  current_fee_timeframe: "24h",
}, managementConfig), null, "a mismatched timeframe cannot activate the thesis exit");
const thesisFailure = updatePnlAndCheckExits("live-fee-thesis", {
  ...thesisPositionData,
  current_fee_timeframe: "30m",
}, managementConfig);
assert.equal(thesisFailure.action, "THESIS_FAILURE");
assert.match(thesisFailure.reason, /retained 49\.0%/);
assert.deepEqual(registerExitSignal("live-fee-thesis", thesisFailure.action, 3, thesisFailure.confirmation_key), {
  fire: false,
  action: "THESIS_FAILURE",
  count: 1,
});
assert.equal(registerExitSignal("live-fee-thesis", thesisFailure.action, 3, thesisFailure.confirmation_key).count, 1,
  "the same cached fee observation cannot be counted twice");
assert.equal(registerExitSignal("live-fee-thesis", thesisFailure.action, 3, "fee-window:30m:second").count, 2);
assert.equal(registerExitSignal("live-fee-thesis", thesisFailure.action, 3, "fee-window:30m:third").fire, true);
const getActiveBin = async () => ({ binId: 100, price: 1 });
await runShadowLifecycleCycle({
  getActiveBin,
  managementConfig,
  pnlConfig: { confirmTicks: 2, profitConfirmTicks: 2, stopConfirmTicks: 2 },
  nowMs: startedAt + 60 * 60_000,
});
const settledCycle = await runShadowLifecycleCycle({
  getActiveBin,
  managementConfig,
  pnlConfig: { confirmTicks: 2, profitConfirmTicks: 2, stopConfirmTicks: 2 },
  nowMs: startedAt + 61 * 60_000,
});
assert.equal(settledCycle.settled, 1);
const settled = getPaperPosition(paperId);
assert.equal(settled.close_action, "TAKE_PROFIT");
assert.ok(settled.settlement.net_pnl_sol > 0);
assert.equal(settled.fee_participation_pct, 75);
assert.equal(settled.settlement.cooldown.until_run_end, true);
assert.equal(settled.valuation_model, "conservative_single_side_sol_proxy");
assert.equal(isShadowBaseMintOnCooldown(baseMint, startedAt + 62 * 60_000), true);

const tailMint = "TailRiskToken1111111111111111111111111111";
const tailId = trackPaperPosition({
  pool: "tail-risk-pool",
  pool_name: "TAIL-SOL",
  base_mint: tailMint,
  strategy: "spot",
  funding_model: "single_side_sol",
  bin_range: { min: 96, max: 101, bins_below: 4, bins_above: 1 },
  amount_sol: 0.2,
  active_bin: 100,
  active_price: 1,
  min_price: 0.96,
  max_price: 1.01,
  bin_step: 100,
  volatility: 2,
  fee_tvl_ratio: 0.6,
  fee_timeframe: "30m",
  policy_snapshot: {
    strategyProfile: SHADOW_ROTATION_STRATEGY_PROFILE,
    fundingModel: "single_side_sol",
  },
  nowMs: startedAt + 62 * 60_000,
});
const catastrophicCycle = await runShadowLifecycleCycle({
  getActiveBin: async () => ({ binId: 89, price: 0.896 }),
  managementConfig,
  pnlConfig: { confirmTicks: 2, profitConfirmTicks: 2, stopConfirmTicks: 2 },
  nowMs: startedAt + 62 * 60_000 + 15_000,
});
assert.equal(catastrophicCycle.settled, 1);
const catastrophic = getPaperPosition(tailId);
assert.equal(catastrophic.close_action, "CATASTROPHIC_STOP");
assert.equal(catastrophic.settlement.cooldown.hours, 168);
assert.equal(catastrophic.settlement.cooldown.until_run_end, true);
assert.equal(isShadowBaseMintOnCooldown(tailMint, startedAt + 100 * 60_000), true);

const thesisMint = "ThesisToken11111111111111111111111111111";
const thesisPaperStartedAt = startedAt + 200 * 60_000;
const thesisPaperId = trackPaperPosition({
  pool: "thesis-paper-pool",
  pool_name: "THESIS-SOL",
  base_mint: thesisMint,
  strategy: "spot",
  funding_model: "single_side_sol",
  bin_range: { min: 96, max: 101, bins_below: 4, bins_above: 1 },
  amount_sol: 0.2,
  active_bin: 100,
  active_price: 1,
  min_price: 0.96,
  max_price: 1.01,
  bin_step: 100,
  volatility: 2,
  fee_tvl_ratio: 0.1,
  fee_timeframe: "30m",
  policy_snapshot: {
    strategyProfile: SHADOW_ROTATION_STRATEGY_PROFILE,
    fundingModel: "single_side_sol",
  },
  nowMs: thesisPaperStartedAt,
});
const readCollapsedFeeWindow = async ({ timeframe, nowMs }) => ({
  current_fee_tvl_ratio: 0.04,
  current_fee_timeframe: timeframe,
  current_fee_observed_at: new Date(nowMs).toISOString(),
});
for (let tick = 0; tick < 2; tick += 1) {
  const pendingThesisCycle = await runShadowLifecycleCycle({
    getActiveBin,
    getFeeWindow: readCollapsedFeeWindow,
    managementConfig,
    pnlConfig: { confirmTicks: 2, profitConfirmTicks: 2, stopConfirmTicks: 3 },
    nowMs: thesisPaperStartedAt + 20 * 60_000 + tick * 15_000,
  });
  assert.equal(pendingThesisCycle.settled, 0);
  assert.equal(pendingThesisCycle.records[0].exit.action, "THESIS_FAILURE");
}
const settledThesisCycle = await runShadowLifecycleCycle({
  getActiveBin,
  getFeeWindow: readCollapsedFeeWindow,
  managementConfig,
  pnlConfig: { confirmTicks: 2, profitConfirmTicks: 2, stopConfirmTicks: 3 },
  nowMs: thesisPaperStartedAt + 20 * 60_000 + 30_000,
});
assert.equal(settledThesisCycle.settled, 1);
const settledThesis = getPaperPosition(thesisPaperId);
assert.equal(settledThesis.close_action, "THESIS_FAILURE");
assert.equal(settledThesis.settlement.cooldown.until_run_end, true);
assert.equal(isShadowBaseMintOnCooldown(thesisMint, thesisPaperStartedAt + 21 * 60_000), true);

const snapshot = getShadowRolloutEvidenceSnapshot();
assert.equal(snapshot.strategy_profile, SHADOW_ROTATION_STRATEGY_PROFILE);
assert.equal(snapshot.lifecycles[0].entry.policy_snapshot.observations.length, 3);
assert.equal(snapshot.lifecycles[0].entry.policy_snapshot.observations[2].priceValue, 1.006);
assert.equal(snapshot.lifecycles[0].entry.policy_snapshot.entryExecutableLiquidity.executableRecoveryLamports, "198000000");
assert.equal(Object.hasOwn(snapshot.lifecycles[0].entry.policy_snapshot.entryExecutableLiquidity, "rawOrder"), false);
const evidencePath = path.join(tempDir, "rotation-evidence.jsonl");
appendShadowEvidenceHeartbeat({
  filePath: evidencePath,
  runId: snapshot.run_id,
  rolloutStage: snapshot.rollout_stage,
  strategyProfile: snapshot.strategy_profile,
  now: new Date(startedAt + 62 * 60_000),
  lifecycles: snapshot.lifecycles,
  cycle: { started_open_positions: 0, started_deployed_amount_sol: 0, observation_failures: [] },
  breaker: {
    observed_at: new Date(startedAt + 62 * 60_000),
    tripped: false,
    manualResumeRequired: false,
    lastEventAtMs: startedAt + 62 * 60_000,
  },
});
const acceptance = evaluateShadowEvidence({
  filePath: evidencePath,
  runId: snapshot.run_id,
  now: new Date(startedAt + 62 * 60_000),
});
assert.equal(acceptance.gates.strategy_profile.pass, false);
assert.equal(acceptance.gates.strategy_profile.reason, "STRATEGY_PROFILE_MISMATCH");
assert.equal(acceptance.ready, false);

console.log("shadow rotation tests passed");
