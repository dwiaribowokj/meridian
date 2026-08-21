import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CONSERVATIVE_FEE_MODEL,
  RISK_POLICY_DEFAULTS,
  SHADOW_ROTATION_POLICY,
  authorizeProjectedExit,
  candidatePolicyFromScreening,
  calculateAdaptiveSizing,
  calculateEntryFeeEconomics,
  calculateProjectedExitMetrics,
  evaluateCandidate,
  evaluatePoolHistory,
  evaluateProjectedExit,
  getGlobalProfitFloorSol,
  getSizingTier,
  rankEligibleCandidates,
} from "../risk-policy.js";
import {
  CIRCUIT_BREAKER_DEFAULTS,
  applyCircuitBreakerEvent,
  createCircuitBreakerController,
  createCircuitBreakerState,
  createMemoryCircuitBreakerStorage,
} from "../circuit-breaker.js";
import {
  createConfiguredBreakerRuntime,
  createFileCircuitBreakerStorage,
  resolveCircuitBreakerPolicy,
} from "../breaker-runtime.js";

const NOW = Date.UTC(2026, 6, 18, 8, 0, 0);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function candidate(overrides = {}) {
  const base = {
    poolAddress: "Pool111",
    pairType: "TOKEN-SOL",
    protocol: "DLMM",
    timeframeMinutes: 30,
    evaluatedAtMs: NOW,
    activeTvlUsd: 100_000,
    volumeUsd: 12_000,
    feeActiveTvlRatioPct: 0.30,
    volatility: 1.2,
    binStep: 100,
    organicScoreBase: 90,
    organicScoreQuote: 95,
    holderCount: 8_000,
    marketCapUsd: 5_000_000,
    tokenAgeHours: 72,
    globalFeesSol: 120,
    smartWalletCount: 1,
    audit: {
      checkedAtMs: NOW,
      botHolderPct: 10,
      top10Pct: 25,
      mintAuthorityDisabled: true,
      freezeAuthorityDisabled: true,
      criticalWarning: false,
      highConcentration: false,
      highSingleOwner: false,
      pvp: false,
      blocklisted: false,
    },
    momentum5m: {
      available: true,
      supertrendDirection: "bullish",
      supertrendBreakUp: false,
      rsi: 55,
    },
    momentum15m: {
      available: true,
      supertrendDirection: "neutral",
      rsi: 50,
    },
    observations: [
      { observedAtMs: NOW - 10 * MINUTE, feeValue: 100, volumeValue: 1_000 },
      { observedAtMs: NOW - 5 * MINUTE, feeValue: 95, volumeValue: 950 },
      { observedAtMs: NOW, feeValue: 90, volumeValue: 900 },
    ],
  };
  return {
    ...base,
    ...overrides,
    audit: { ...base.audit, ...(overrides.audit ?? {}) },
    momentum5m: { ...base.momentum5m, ...(overrides.momentum5m ?? {}) },
    momentum15m: { ...base.momentum15m, ...(overrides.momentum15m ?? {}) },
  };
}

// Exact sizing tiers and rent-aware capacity.
assert.equal(getSizingTier(0.27)?.name, "small");
assert.equal(getSizingTier(0.999)?.name, "small");
assert.equal(getSizingTier(1)?.name, "medium");
assert.equal(getSizingTier(5)?.name, "large");
assert.equal(getSizingTier(0.269), null);

assert.deepEqual(
  RISK_POLICY_DEFAULTS.sizing.tiers.map((tier) => [tier.name, tier.targetEquityPct, tier.maxPositions]),
  [["small", 30, 1], ["medium", 20, 2], ["large", 10, 3]],
);
assert.deepEqual({
  reserve: RISK_POLICY_DEFAULTS.sizing.operationalReserveSol,
  setupFloor: RISK_POLICY_DEFAULTS.sizing.minimumSetupBufferSol,
  setupContingency: RISK_POLICY_DEFAULTS.sizing.setupContingencySol,
  hardMinimum: RISK_POLICY_DEFAULTS.sizing.hardMinimumWalletSol,
}, { reserve: 0.1, setupFloor: 0.065, setupContingency: 0.003, hardMinimum: 0.27 });

const smallSizing = calculateAdaptiveSizing({
  equitySol: 0.5,
  liquidSol: 0.5,
  quotedPositionRentSol: 0.05740608,
  missingAtaRentSol: 0.00203928,
});
assert.equal(smallSizing.eligible, true);
assert.equal(smallSizing.amountSol, 0.15);
assert.equal(smallSizing.setupBufferSol, 0.065);
assert.equal(smallSizing.operationalReserveSol, 0.1);

const rentConstrained = calculateAdaptiveSizing({
  equitySol: 1,
  liquidSol: 0.3,
  quotedPositionRentSol: 0.09,
  missingAtaRentSol: 0.01,
});
assert.equal(rentConstrained.setupBufferSol, 0.103);
assert.equal(rentConstrained.eligible, false);
assert.ok(rentConstrained.reasons.includes("INSUFFICIENT_DEPLOY_CAPACITY"));

const exposureConstrained = calculateAdaptiveSizing({
  equitySol: 0.27,
  liquidSol: 0.27,
  quotedPositionRentSol: 0.05,
  missingAtaRentSol: 0,
});
assert.equal(exposureConstrained.eligible, false);
assert.equal(exposureConstrained.amountSol, 0);

const canarySizing = calculateAdaptiveSizing({
  equitySol: 0.4,
  liquidSol: 0.4,
  quotedPositionRentSol: 0.05,
  missingAtaRentSol: 0,
  canary: true,
});
assert.equal(canarySizing.eligible, true);
assert.equal(canarySizing.amountSol, 0.2);
assert.equal(canarySizing.maximumPositions, 1);

const newBinArray = calculateAdaptiveSizing({
  equitySol: 5,
  liquidSol: 5,
  quotedPositionRentSol: 0.05,
  missingAtaRentSol: 0,
  requiresNewBinArray: true,
});
assert.equal(newBinArray.eligible, false);
assert.ok(newBinArray.reasons.includes("NEW_BIN_ARRAY_REQUIRED"));

// Candidate gates are inclusive where specified and fail closed on missing data.
const boundaryCandidate = candidate({
  activeTvlUsd: 60_000,
  volumeUsd: 4_000,
  feeActiveTvlRatioPct: 0.30,
  volatility: 0.0001,
  binStep: 80,
  organicScoreBase: 80,
  organicScoreQuote: 80,
  holderCount: 5_000,
  marketCapUsd: 1_000_000,
  tokenAgeHours: 24,
  globalFeesSol: 80,
  audit: { botHolderPct: 20, top10Pct: 40 },
});
assert.equal(evaluateCandidate(boundaryCandidate, { nowMs: NOW }).eligible, true);

// Screening may only relax the empirically calibrated admission dimensions.
// Structural market/audit/momentum gates remain supplied by the locked policy.
const calibratedCandidatePolicy = candidatePolicyFromScreening({
  minFeeActiveTvlRatio: 0.04,
  minVolume: 3_500,
  minActiveTvl: 50_000,
  maxTvl: 300_000,
  maxMcap: 12_000_000,
  minOrganic: 75,
  minQuoteOrganic: 80,
  candidateConfirmationCount: 2,
  candidateConfirmationMinSpacingMinutes: 5,
  candidateConfirmationMaxAgeMinutes: 20,
  candidateMinFeeRetentionPct: 75,
  candidateMinVolumeRetentionPct: 75,
}, {
  management: { estimatedRoundTripCostPct: 0.4, maxHoldMinutes: 360 },
  indicators: { entryRsiMin5m: 40, entryRsiMin15m: 35 },
});
assert.ok(Math.abs(calibratedCandidatePolicy.candidate.minimumEconomicFeeActiveTvlRatioPct - 0.2933333333) < 1e-9);
assert.ok(Math.abs(calibratedCandidatePolicy.candidate.minFeeActiveTvlRatioPct - 0.2933333333) < 1e-9);
assert.equal(calibratedCandidatePolicy.candidate.configuredMinFeeActiveTvlRatioPct, 0.04);
assert.equal(calibratedCandidatePolicy.candidate.minVolumeUsd, 3_500);
assert.equal(calibratedCandidatePolicy.candidate.minActiveTvlUsd, 50_000);
assert.equal(calibratedCandidatePolicy.candidate.maxActiveTvlUsd, 300_000);
assert.equal(calibratedCandidatePolicy.candidate.maxMarketCapUsd, 12_000_000);
assert.equal(calibratedCandidatePolicy.candidate.minOrganicScoreBase, 75);
assert.equal(calibratedCandidatePolicy.candidate.minOrganicScoreQuote, 80);
assert.equal(calibratedCandidatePolicy.candidate.requiredObservationCount, 2);
assert.equal(calibratedCandidatePolicy.candidate.maxEvaluationAgeMs, 6 * MINUTE);
assert.equal(calibratedCandidatePolicy.candidate.minRetentionPct, 75);
assert.equal(RISK_POLICY_DEFAULTS.candidate.minFeeActiveTvlRatioPct, 0.30, "defaults remain immutable");
assert.equal(RISK_POLICY_DEFAULTS.candidate.minOrganicScoreBase, 80, "default base-organic gate remains locked");
assert.deepEqual(CONSERVATIVE_FEE_MODEL, {
  feeAccrualHaircutPct: 50,
  minimumFeeParticipationPct: 25,
  minimumRoundTripCostPct: 0.4,
  minimumFeeCoverageRatio: 1.1,
  maximumBreakEvenHoldMinutes: 360,
});

const calibratedCandidate = candidate({
  activeTvlUsd: 300_000,
  volumeUsd: 3_500,
  marketCapUsd: 12_000_000,
  feeActiveTvlRatioPct: 0.30,
  organicScoreBase: 75,
  observations: [
    { observedAtMs: NOW - 5 * MINUTE, feeValue: 100, volumeValue: 1_000 },
    { observedAtMs: NOW, feeValue: 75, volumeValue: 750 },
  ],
});
assert.equal(evaluateCandidate(calibratedCandidate, { nowMs: NOW }, calibratedCandidatePolicy).eligible, true);
const calibratedEconomics = calculateEntryFeeEconomics(calibratedCandidate, calibratedCandidatePolicy);
assert.equal(calibratedEconomics.eligible, true);
assert.ok(Math.abs(calibratedEconomics.projectedCapturedFeePct - 0.45) < 1e-12);
assert.ok(Math.abs(calibratedEconomics.projectedNetFeePct - 0.05) < 1e-12);

const uneconomicEntry = candidate({ feeActiveTvlRatioPct: 0.0969 });
const uneconomicResult = evaluateCandidate(uneconomicEntry, { nowMs: NOW }, calibratedCandidatePolicy);
assert.equal(uneconomicResult.eligible, false);
assert.ok(uneconomicResult.reasons.includes("FEE_ECONOMICS_BELOW_REQUIRED_COVERAGE"));
assert.ok(uneconomicResult.economics.projectedNetFeePct < 0);

const fallingKnifeEntry = candidate({
  momentum5m: { rsi: 36.663 },
  momentum15m: { rsi: 34.262 },
});
const fallingKnifeResult = evaluateCandidate(fallingKnifeEntry, { nowMs: NOW }, calibratedCandidatePolicy);
assert.equal(fallingKnifeResult.eligible, false);
assert.ok(fallingKnifeResult.reasons.includes("FIVE_MINUTE_RSI_BELOW_RECOVERY_MINIMUM"));
assert.ok(fallingKnifeResult.reasons.includes("FIFTEEN_MINUTE_RSI_BELOW_RECOVERY_MINIMUM"));

const cadenceReusableCandidate = candidate({
  activeTvlUsd: 50_000,
  volumeUsd: 3_500,
  marketCapUsd: 12_000_000,
  feeActiveTvlRatioPct: 0.30,
  organicScoreBase: 75,
  observations: [
    { observedAtMs: NOW - 10.5 * MINUTE, feeValue: 100, volumeValue: 1_000 },
    { observedAtMs: NOW - 5.5 * MINUTE, feeValue: 80, volumeValue: 800 },
  ],
});
assert.equal(
  evaluateCandidate(cadenceReusableCandidate, { nowMs: NOW }, calibratedCandidatePolicy).eligible,
  true,
  "confirmed observations remain valid through the next five-minute screening cadence",
);

const unsafeCandidatePolicy = candidatePolicyFromScreening({
  minFeeActiveTvlRatio: 0,
  minVolume: 0,
  minActiveTvl: 0,
  maxTvl: 1_000_000_000,
  maxMcap: 1_000_000_000,
  minOrganic: 1,
  minQuoteOrganic: 1,
  candidateConfirmationCount: 1,
  candidateConfirmationMinSpacingMinutes: 0,
  candidateConfirmationMaxAgeMinutes: 1,
  candidateMinFeeRetentionPct: 0,
  candidateMinVolumeRetentionPct: 0,
});
assert.ok(Math.abs(unsafeCandidatePolicy.candidate.minFeeActiveTvlRatioPct - 0.2933333333) < 1e-9);
assert.equal(unsafeCandidatePolicy.candidate.configuredMinFeeActiveTvlRatioPct, 0.04);
assert.equal(unsafeCandidatePolicy.candidate.minVolumeUsd, 3_500);
assert.equal(unsafeCandidatePolicy.candidate.minActiveTvlUsd, 50_000);
assert.equal(unsafeCandidatePolicy.candidate.maxActiveTvlUsd, 300_000);
assert.equal(unsafeCandidatePolicy.candidate.maxMarketCapUsd, 12_000_000);
assert.equal(unsafeCandidatePolicy.candidate.minOrganicScoreBase, 75);
assert.equal(unsafeCandidatePolicy.candidate.minOrganicScoreQuote, 80);
assert.equal(unsafeCandidatePolicy.candidate.requiredObservationCount, 2);
assert.equal(unsafeCandidatePolicy.candidate.minObservationSpacingMs, 5 * MINUTE);
assert.equal(unsafeCandidatePolicy.candidate.maxEvaluationAgeMs, 6 * MINUTE);
assert.equal(unsafeCandidatePolicy.candidate.maxObservationWindowMs, 15 * MINUTE);
assert.equal(unsafeCandidatePolicy.candidate.minRetentionPct, 75);
const unsafeRsiPolicy = candidatePolicyFromScreening({}, {
  indicators: { entryRsiMin5m: 0, entryRsiMin15m: 0, entryRsiMax5m: 100, entryRsiMax15m: 100 },
});
assert.equal(unsafeRsiPolicy.candidate.minEntryRsi5m, 40);
assert.equal(unsafeRsiPolicy.candidate.minEntryRsi15m, 35);
assert.equal(unsafeRsiPolicy.candidate.maxEntryRsi5m, 75);
assert.equal(unsafeRsiPolicy.candidate.maxEntryRsi15m, 80);

const rejectedCandidate = candidate({
  volatility: 2.5,
  organicScoreQuote: undefined,
  audit: { criticalWarning: undefined },
  momentum5m: { supertrendDirection: "neutral", supertrendBreakUp: false },
});
const rejection = evaluateCandidate(rejectedCandidate, { nowMs: NOW });
assert.equal(rejection.eligible, false);
assert.ok(rejection.reasons.includes("VOLATILITY_OUT_OF_RANGE"));
assert.ok(rejection.reasons.includes("MISSING_OR_INVALID_QUOTE_ORGANIC_SCORE_BELOW_MINIMUM"));
assert.ok(rejection.reasons.includes("CRITICAL_WARNING_OR_UNKNOWN"));
assert.ok(rejection.reasons.includes("FIVE_MINUTE_SUPERTREND_NOT_BULLISH"));

const staleCandidate = candidate({ evaluatedAtMs: NOW - 2 * MINUTE - 1 });
const staleResult = evaluateCandidate(staleCandidate, { nowMs: NOW });
assert.ok(staleResult.reasons.includes("STALE_OR_MISSING_EVALUATION"));
assert.ok(staleResult.reasons.includes("STALE_STABILITY_OBSERVATIONS"));

const unstableCandidate = candidate({
  observations: [
    { observedAtMs: NOW - 10 * MINUTE, feeValue: 100, volumeValue: 1_000 },
    { observedAtMs: NOW - 5 * MINUTE, feeValue: 85, volumeValue: 850 },
    { observedAtMs: NOW, feeValue: 79, volumeValue: 790 },
  ],
});
const unstableResult = evaluateCandidate(unstableCandidate, { nowMs: NOW });
assert.ok(unstableResult.reasons.includes("FEE_RETENTION_BELOW_MINIMUM"));
assert.ok(unstableResult.reasons.includes("VOLUME_RETENTION_BELOW_MINIMUM"));

const recoveredTooLate = candidate({
  observations: [
    { observedAtMs: NOW - 10 * MINUTE, feeValue: 100, volumeValue: 1_000 },
    { observedAtMs: NOW - 5 * MINUTE, feeValue: 70, volumeValue: 700 },
    { observedAtMs: NOW, feeValue: 95, volumeValue: 950 },
  ],
});
assert.equal(evaluateCandidate(recoveredTooLate, { nowMs: NOW }).eligible, false);

const ranked = rankEligibleCandidates([
  candidate({ poolAddress: "PoolC", feeActiveTvlRatioPct: 0.32, volumeUsd: 8_000 }),
  candidate({ poolAddress: "PoolB", feeActiveTvlRatioPct: 0.32, volumeUsd: 15_000 }),
  candidate({ poolAddress: "PoolA", feeActiveTvlRatioPct: 0.30, volumeUsd: 50_000 }),
  candidate({ poolAddress: "Rejected", globalFeesSol: 79 }),
], { nowMs: NOW });
assert.deepEqual(ranked.ranked.map(({ candidate: item }) => item.poolAddress), ["PoolB", "PoolC", "PoolA"]);
assert.deepEqual(ranked.rejected.map(({ candidate: item }) => item.poolAddress), ["Rejected"]);

const rankedAuditTieBreakers = rankEligibleCandidates([
  candidate({ poolAddress: "HigherBots", audit: { botHolderPct: 11 }, smartWalletCount: 5 }),
  candidate({ poolAddress: "LowerBots", audit: { botHolderPct: 9 }, smartWalletCount: 0 }),
], { nowMs: NOW });
assert.equal(rankedAuditTieBreakers.ranked[0].candidate.poolAddress, "LowerBots");

assert.deepEqual({
  takeProfit: RISK_POLICY_DEFAULTS.exit.takeProfitPct,
  stopLoss: RISK_POLICY_DEFAULTS.exit.stopLossPct,
  catastrophic: RISK_POLICY_DEFAULTS.exit.catastrophicStopPct,
  profitProtect: RISK_POLICY_DEFAULTS.exit.profitProtectActivationPct,
  retrace: RISK_POLICY_DEFAULTS.exit.profitProtectRetracePercentagePoints,
}, { takeProfit: 1.25, stopLoss: -1.5, catastrophic: -2.5, profitProtect: 0.8, retrace: 0.3 });
assert.equal(SHADOW_ROTATION_POLICY.takeProfitExecutionBufferPct, 0.75);

// Net-equity exits, global profit floor, confirmations, and risk exceptions.
assert.equal(getGlobalProfitFloorSol(0.1), 0.0005);
assert.equal(getGlobalProfitFloorSol(2), 0.01);

const projected = calculateProjectedExitMetrics({
  deployedSol: 0.1,
  equityBeforeDeploySol: 1,
  projectedEquityAfterExitSol: 1.00125,
});
assert.ok(Math.abs(projected.projectedNetProfitPct - 1.25) < 1e-9);
assert.equal(projected.clearsGlobalProfitFloor, true);

assert.equal(authorizeProjectedExit({
  exitClass: "profit",
  deployedSol: 0.1,
  projectedNetProfitSol: 0.00049,
}).allowed, false);
assert.equal(authorizeProjectedExit({
  exitClass: "risk",
  deployedSol: 0.1,
  projectedNetProfitSol: -0.01,
}).allowed, true);

const takeProfitPending = evaluateProjectedExit({
  deployedSol: 0.1,
  equityBeforeDeploySol: 1,
  projectedEquityAfterExitSol: 1.00125,
  confirmations: { profit: 1 },
});
assert.equal(takeProfitPending.shouldExit, false);
assert.equal(takeProfitPending.pendingReason, "PROFIT_CONFIRMATION_PENDING");

const takeProfit = evaluateProjectedExit({
  deployedSol: 0.1,
  equityBeforeDeploySol: 1,
  projectedEquityAfterExitSol: 1.00125,
  confirmations: { profit: 2 },
});
assert.equal(takeProfit.shouldExit, true);
assert.equal(takeProfit.reason, "TAKE_PROFIT");

const profitProtect = evaluateProjectedExit({
  deployedSol: 0.1,
  equityBeforeDeploySol: 1,
  projectedEquityAfterExitSol: 1.0005,
  peakProjectedNetProfitPct: 0.81,
  confirmations: { profit: 2 },
});
assert.equal(profitProtect.shouldExit, true);
assert.equal(profitProtect.reason, "PROFIT_PROTECT");

const stopPending = evaluateProjectedExit({
  deployedSol: 0.1,
  equityBeforeDeploySol: 1,
  projectedEquityAfterExitSol: 0.9985,
  confirmations: { stopLoss: 2 },
});
assert.equal(stopPending.shouldExit, false);
assert.equal(stopPending.pendingReason, "STOP_LOSS_CONFIRMATION_PENDING");

const catastrophic = evaluateProjectedExit({
  deployedSol: 0.1,
  equityBeforeDeploySol: 1,
  projectedEquityAfterExitSol: 0.9975,
});
assert.equal(catastrophic.shouldExit, true);
assert.equal(catastrophic.reason, "CATASTROPHIC_STOP");

// Pool history: cooldown, range/earning quality, and economics gates.
const historyRecords = [
  { deployedAtMs: NOW - 5 * DAY, closedAtMs: NOW - 5 * DAY, netProfitSol: 0.002, cleanClose: true },
  { deployedAtMs: NOW - 4 * DAY, closedAtMs: NOW - 4 * DAY, netProfitSol: 0.001, cleanClose: true, outOfRange: true },
  { deployedAtMs: NOW - 3 * DAY, closedAtMs: NOW - 3 * DAY, netProfitSol: -0.003, cleanClose: true, zeroEarning: true },
  { deployedAtMs: NOW - 2 * DAY, closedAtMs: NOW - 2 * DAY, netProfitSol: -0.002, cleanClose: true },
  { deployedAtMs: NOW - 25 * HOUR, closedAtMs: NOW - 25 * HOUR, netProfitSol: 0.001, cleanClose: true },
];
const badEconomics = evaluatePoolHistory({ records: historyRecords, nowMs: NOW });
assert.equal(badEconomics.eligible, false);
assert.ok(badEconomics.reasons.includes("POOL_CUMULATIVE_NET_NOT_POSITIVE"));
assert.ok(badEconomics.reasons.includes("POOL_PROFIT_FACTOR_BELOW_MINIMUM"));

const rangeBlocked = evaluatePoolHistory({
  nowMs: NOW,
  records: historyRecords.slice(0, 3).map((record, index) => ({
    ...record,
    outOfRange: index < 2,
    netProfitSol: 0.001,
  })),
});
assert.ok(rangeBlocked.reasons.includes("POOL_RANGE_OR_EARNING_RATE_BLOCKED"));

const cooldown = evaluatePoolHistory({
  nowMs: NOW,
  records: [{
    deployedAtMs: NOW - HOUR,
    closedAtMs: NOW - HOUR,
    netProfitSol: -0.0001,
    cleanClose: true,
  }],
});
assert.ok(cooldown.reasons.includes("NET_LOSS_COOLDOWN_ACTIVE"));
assert.equal(cooldown.cooldownUntilMs, NOW + 23 * HOUR);

// Pure and persistent circuit-breaker behavior.
let breaker = createCircuitBreakerState(NOW);
breaker = applyCircuitBreakerEvent(breaker, {
  type: "trade_settled",
  atMs: NOW,
  netProfitSol: -0.001,
  deployedSol: 0.1,
  equityStartSol: 1,
});
assert.equal(breaker.tripped, false);
breaker = applyCircuitBreakerEvent(breaker, {
  type: "trade_settled",
  atMs: NOW + MINUTE,
  netProfitSol: -0.001,
  deployedSol: 0.1,
  equityStartSol: 1,
});
assert.equal(breaker.tripped, true);
assert.ok(breaker.reasons.includes("CONSECUTIVE_NET_LOSSES"));
assert.equal(breaker.manualResumeRequired, true);

const singleLoss = applyCircuitBreakerEvent(createCircuitBreakerState(NOW), {
  type: "trade_settled",
  atMs: NOW,
  netProfitSol: -0.00201,
  deployedSol: 0.1,
  equityStartSol: 1,
});
assert.ok(singleLoss.reasons.includes("SINGLE_TRADE_LOSS_LIMIT"));

let operations = createCircuitBreakerState(NOW);
operations = applyCircuitBreakerEvent(operations, {
  type: "operation_failure",
  operation: "swap",
  atMs: NOW,
});
operations = applyCircuitBreakerEvent(operations, {
  type: "operation_failure",
  operation: "cleanup",
  atMs: NOW + MINUTE,
});
assert.ok(operations.reasons.includes("CONSECUTIVE_OPERATIONAL_FAILURES"));

let canary = createCircuitBreakerState(NOW);
canary = applyCircuitBreakerEvent(canary, { type: "canary_equity", equitySol: 1, atMs: NOW });
canary = applyCircuitBreakerEvent(canary, { type: "canary_equity", equitySol: 0.97, atMs: NOW + MINUTE });
assert.ok(canary.reasons.includes("CANARY_DRAWDOWN_LIMIT"));

const reconciliation = applyCircuitBreakerEvent(createCircuitBreakerState(NOW), {
  type: "reconciliation_checked",
  errorSol: 0.00010001,
  atMs: NOW,
});
assert.ok(reconciliation.reasons.includes("RESIDUAL_RECONCILIATION_LIMIT"));

const floorViolation = applyCircuitBreakerEvent(createCircuitBreakerState(NOW), {
  type: "profit_exit",
  deployedSol: 0.1,
  netProfitSol: 0.00049,
  atMs: NOW,
});
assert.ok(floorViolation.reasons.includes("PROFIT_EXIT_BELOW_GLOBAL_FLOOR"));

let rollingLoss = createCircuitBreakerState(NOW);
rollingLoss = applyCircuitBreakerEvent(rollingLoss, {
  type: "trade_settled",
  deployedSol: 0.1,
  netProfitSol: -0.0015,
  equityStartSol: 0.1,
  atMs: NOW,
});
assert.equal(rollingLoss.tripped, false);
rollingLoss = applyCircuitBreakerEvent(rollingLoss, {
  type: "trade_settled",
  deployedSol: 0.1,
  netProfitSol: 0,
  equityStartSol: 0.1,
  atMs: NOW + MINUTE,
});
rollingLoss = applyCircuitBreakerEvent(rollingLoss, {
  type: "trade_settled",
  deployedSol: 0.1,
  netProfitSol: -0.0015,
  equityStartSol: 0.1,
  atMs: NOW + 2 * MINUTE,
});
assert.ok(rollingLoss.reasons.includes("ROLLING_24H_LOSS_LIMIT"));

const lifecycle = applyCircuitBreakerEvent(createCircuitBreakerState(NOW), {
  type: "lifecycle_anomaly",
  kind: "duplicate",
  atMs: NOW,
});
assert.ok(lifecycle.reasons.includes("LIFECYCLE_DUPLICATE"));

assert.equal(CIRCUIT_BREAKER_DEFAULTS.maximumConsecutiveNetLosses, 2);
assert.equal(CIRCUIT_BREAKER_DEFAULTS.canaryMaximumDrawdownPct, 3);

const storage = createMemoryCircuitBreakerStorage();
const controller = createCircuitBreakerController({ storage, now: () => NOW });
await controller.record({ type: "basis_invalid", atMs: NOW });
assert.equal(await controller.entryAllowed(), false);

// A second controller proves the state was persisted through the adapter.
const reloadedController = createCircuitBreakerController({ storage, now: () => NOW + MINUTE });
assert.equal((await reloadedController.getState()).tripped, true);
const { manualResume } = reloadedController;
await manualResume(NOW + MINUTE);
assert.equal(await reloadedController.entryAllowed(), true);
assert.equal((await reloadedController.getState()).resumedAtMs, NOW + MINUTE);
assert.equal((await reloadedController.getState()).resumeSource, "manual");

// A generic adapter can reject an optimistic write when another actor owns a
// conflicting latch. The controller must reload that authoritative latch
// rather than retaining the rejected permissive manual-resume candidate.
const authoritativeLatch = createCircuitBreakerState(NOW);
authoritativeLatch.tripped = true;
authoritativeLatch.manualResumeRequired = true;
authoritativeLatch.trippedAtMs = NOW;
authoritativeLatch.reasons = ["CONFLICTING_OWNER_LATCH"];
let conflictLoads = 0;
const conflictStorage = {
  async load() {
    conflictLoads += 1;
    return structuredClone(authoritativeLatch);
  },
  async save() {
    const error = new Error("conflicting circuit-breaker save");
    error.code = "EAGAIN";
    throw error;
  },
};
const conflictController = createCircuitBreakerController({ storage: conflictStorage, now: () => NOW + MINUTE });
await assert.rejects(() => conflictController.manualResume(NOW + MINUTE), /conflicting circuit-breaker save/i);
assert.equal(conflictLoads, 2, "a failed save reloads authoritative storage");
assert.equal(await conflictController.entryAllowed(), false);
assert.equal((await conflictController.getState()).tripped, true);

// Configured breaker policies are translated into the controller's supported
// defaults, persisted in an isolated state file, and remain manually latched.
const configuredPolicy = resolveCircuitBreakerPolicy({
  enabled: true,
  consecutiveLosses: 3,
  singleLossPct: -5,
  dailyLossMinSol: 0.01,
  dailyLossPct: 4,
  canaryDrawdownPct: 10,
  consecutiveOperationalFailures: 3,
});
assert.deepEqual(configuredPolicy.defaults, {
  ...CIRCUIT_BREAKER_DEFAULTS,
  maximumConsecutiveNetLosses: 3,
  singleTradeLossPctExclusive: -5,
  minimumRollingLossLimitSol: 0.01,
  rollingLossLimitEquityPct: 4,
  canaryMaximumDrawdownPct: 10,
  maximumConsecutiveOperationalFailures: 3,
});

const invalidConfiguredPolicy = resolveCircuitBreakerPolicy({
  enabled: "yes",
  consecutiveLosses: Infinity,
  singleLossPct: 0,
  dailyLossMinSol: NaN,
  dailyLossPct: -1,
  canaryDrawdownPct: Infinity,
  consecutiveOperationalFailures: 1.5,
});
assert.equal(invalidConfiguredPolicy.enabled, false);
assert.deepEqual(invalidConfiguredPolicy.defaults, CIRCUIT_BREAKER_DEFAULTS);

const breakerTempDir = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-configured-breaker-"));
try {
  const configuredRuntime = createConfiguredBreakerRuntime({
    storage: createFileCircuitBreakerStorage({ file: path.join(breakerTempDir, "configured.json") }),
    circuitBreaker: {
      enabled: true,
      consecutiveLosses: 3,
      singleLossPct: -5,
      dailyLossMinSol: 0.01,
      dailyLossPct: 4,
      canaryDrawdownPct: 10,
      consecutiveOperationalFailures: 3,
    },
    now: () => NOW,
  });
  for (let index = 0; index < 2; index += 1) {
    await configuredRuntime.record({
      type: "trade_settled",
      eventId: `configured-loss-${index}`,
      atMs: NOW + index * MINUTE,
      netProfitSol: -0.001,
      deployedSol: 0.1,
      equityStartSol: 1,
    });
  }
  assert.equal(await configuredRuntime.entryAllowed(), true);
  await configuredRuntime.record({
    type: "trade_settled",
    eventId: "configured-loss-2",
    atMs: NOW + 2 * MINUTE,
    netProfitSol: -0.001,
    deployedSol: 0.1,
    equityStartSol: 1,
  });
  assert.equal(await configuredRuntime.entryAllowed(), false);
  await configuredRuntime.manualResume(NOW + 3 * MINUTE);
  assert.equal(await configuredRuntime.entryAllowed(), true);

  const drawdownRuntime = createConfiguredBreakerRuntime({
    storage: createFileCircuitBreakerStorage({ file: path.join(breakerTempDir, "drawdown.json") }),
    circuitBreaker: { enabled: true, canaryDrawdownPct: 10 },
    now: () => NOW,
  });
  await drawdownRuntime.record({ type: "canary_equity", equitySol: 1, atMs: NOW });
  await drawdownRuntime.record({ type: "canary_equity", equitySol: 0.91, atMs: NOW + MINUTE });
  assert.equal(await drawdownRuntime.entryAllowed(), true);
  await drawdownRuntime.record({ type: "canary_equity", equitySol: 0.89, atMs: NOW + 2 * MINUTE });
  assert.equal(await drawdownRuntime.entryAllowed(), false);

  const failureRuntime = createConfiguredBreakerRuntime({
    storage: createFileCircuitBreakerStorage({ file: path.join(breakerTempDir, "failure.json") }),
    circuitBreaker: { enabled: true, consecutiveOperationalFailures: 3 },
    now: () => NOW,
  });
  for (let index = 0; index < 2; index += 1) {
    await failureRuntime.record({ type: "operation_failure", operation: "swap", atMs: NOW + index * MINUTE });
  }
  assert.equal(await failureRuntime.entryAllowed(), true);
  await failureRuntime.record({ type: "operation_failure", operation: "swap", atMs: NOW + 2 * MINUTE });
  assert.equal(await failureRuntime.entryAllowed(), false);

  const disabledRuntime = createConfiguredBreakerRuntime({
    storage: createFileCircuitBreakerStorage({ file: path.join(breakerTempDir, "disabled.json") }),
    circuitBreaker: { enabled: false },
    now: () => NOW,
  });
  assert.equal(await disabledRuntime.entryAllowed(), false);
  await disabledRuntime.manualResume(NOW);
  assert.equal(await disabledRuntime.entryAllowed(), false);
} finally {
  fs.rmSync(breakerTempDir, { recursive: true, force: true });
}

console.log("risk policy tests passed");
