const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

export const YIELD_HOLD_STRATEGY_PROFILE = "yield_hold_v1";
export const LEGACY_SHADOW_ROTATION_STRATEGY_PROFILE = "rotation_v1";
// Versioned separately from the earlier paper-only balanced proxy. This
// profile is intentionally executable by the locked live canary: it uses the
// same single-side SOL funding and lower range in shadow and on chain.
export const SHADOW_ROTATION_STRATEGY_PROFILE = "rotation_live_v1";

export const SHADOW_ROTATION_POLICY = deepFreeze({
  strategyProfile: SHADOW_ROTATION_STRATEGY_PROFILE,
  strategy: "spot",
  fundingModel: "single_side_sol",
  binsBelow: 4,
  binsAbove: 1,
  minPoolTvlUsd: 400,
  minActiveTvlUsd: 400,
  maxActiveTvlUsd: 300_000,
  minFeeActiveTvlRatioPct: 1.0,
  minVolumeUsd: 250,
  minMarketCapUsd: 50_000,
  maxMarketCapUsd: 50_000_000,
  minHolderCount: 500,
  minOrganicScoreBase: 70,
  minTokenAgeHours: 1,
  maxTokenAgeHours: 72,
  minGlobalFeesSol: 80,
  maxBotHolderPct: 25,
  maxTop10Pct: 30,
  // The 24-hour live canary admits a little more of the observed trending-pool
  // distribution while the three-snapshot price/bin stability gates remain
  // authoritative.
  maxVolatilityExclusive: 7.5,
  confirmationCount: 3,
  confirmationSpacingMs: 30_000,
  confirmationWindowMs: 5 * MINUTE_MS,
  minRetentionPct: 60,
  requirePriceStability: true,
  maxPriceDrawdownPct: 1.5,
  maxDownsideBinDelta: 2,
  monitorIntervalSeconds: 15,
  catastrophicQuarantineHours: 168,
  maxEvaluationAgeMs: 2 * MINUTE_MS,
  maxPositionActiveTvlPct: 2,
  minEntryRsi5m: 35,
  minEntryRsi15m: 40,
  maxEntryRsi5m: 75,
  maxEntryRsi15m: 80,
  feeParticipationPct: 75,
  estimatedRoundTripCostPct: 0.4,
  // Live settlement reconciliation showed that a spot-valued projected close
  // can overstate realized equity by enough to turn the former 0.50% TP into a
  // small settled loss. Keep the economic target separate from this execution
  // uncertainty reserve: the active gate is 0.50% + 0.75pp = 1.25%.
  takeProfitExecutionBufferPct: 0.75,
  minimumProjectedNetFeePct: 0.10,
  maxHoldMinutes: 90,
  takeProfitPct: 0.50,
  stopLossPct: -1,
  catastrophicStopPct: -1.5,
  // Consecutive PnL ticks already provide the noise guard. Delaying the normal
  // stop as well would leave fresh positions protected only by the wider
  // catastrophic threshold during their highest-risk opening minutes.
  normalStopGraceMinutes: 0,
  aboveRangeExitMinutes: 5,
});

/**
 * Return the projected-PnL gate used by both live and paper net-exit paths.
 * The execution buffer is deliberately additive: it reserves uncertainty that
 * is not represented by the spot-valued close projection or its minimal
 * transaction-cost estimate.
 */
export function resolveEffectiveTakeProfitPct(managementConfig = {}) {
  const configuredValue = Number(managementConfig.takeProfitPct ?? 1.25);
  const configured = Number.isFinite(configuredValue) ? configuredValue : 1.25;
  const estimatedCostValue = Number(managementConfig.estimatedRoundTripCostPct ?? 1.0);
  const estimatedCost = Number.isFinite(estimatedCostValue) ? Math.max(0, estimatedCostValue) : 1.0;
  const minimumProfitValue = Number(managementConfig.minNetProfitPct ?? 0.25);
  const minimumProfit = Number.isFinite(minimumProfitValue) ? Math.max(0, minimumProfitValue) : 0.25;
  const costFloor = managementConfig.costAwareTakeProfitEnabled === false
    ? configured
    : Math.max(configured, estimatedCost + minimumProfit);
  const bufferValue = Number(managementConfig.takeProfitExecutionBufferPct ?? 0);
  const executionBuffer = Number.isFinite(bufferValue) ? Math.max(0, bufferValue) : 0;
  return costFloor + executionBuffer;
}

export function resolveEntryStrategyProfile({
  effectiveDryRun = false,
  effectiveRolloutMode = effectiveDryRun === true ? "dry_run" : null,
  rotationEnabled = false,
} = {}) {
  const rotationStageAuthorized = effectiveDryRun === true || effectiveRolloutMode === "canary";
  return rotationStageAuthorized && rotationEnabled === true
    ? SHADOW_ROTATION_STRATEGY_PROFILE
    : YIELD_HOLD_STRATEGY_PROFILE;
}

export function minimumBinsBelowForStrategyProfile({
  effectiveDryRun = false,
  effectiveRolloutMode = effectiveDryRun === true ? "dry_run" : null,
  rotationEnabled = false,
  strategyProfile = null,
  rotationBinsBelow = SHADOW_ROTATION_POLICY.binsBelow,
  liveMinimumBinsBelow = 35,
} = {}) {
  const liveMinimum = Math.max(35, Math.round(Number(liveMinimumBinsBelow) || 35));
  const rotationStageAuthorized = effectiveDryRun === true || effectiveRolloutMode === "canary";
  if (
    rotationStageAuthorized !== true ||
    rotationEnabled !== true ||
    strategyProfile !== SHADOW_ROTATION_STRATEGY_PROFILE
  ) {
    return liveMinimum;
  }
  const requested = Math.round(Number(rotationBinsBelow));
  return Number.isFinite(requested)
    ? Math.max(SHADOW_ROTATION_POLICY.binsBelow, Math.min(liveMinimum, requested))
    : SHADOW_ROTATION_POLICY.binsBelow;
}

/**
 * Match the complete versioned rotation contract. The narrow 4+1 range is an
 * exception to the generic live lower-range floor, so callers must prove the
 * active rollout stage, profile, strategy, and both range sides together.
 */
export function isAuthorizedRotationRange({
  effectiveDryRun = false,
  effectiveRolloutMode = effectiveDryRun === true ? "dry_run" : null,
  rotationEnabled = false,
  strategyProfile = null,
  strategy = null,
  binsBelow = null,
  binsAbove = null,
  rotationStrategy = SHADOW_ROTATION_POLICY.strategy,
  rotationBinsBelow = SHADOW_ROTATION_POLICY.binsBelow,
  rotationBinsAbove = SHADOW_ROTATION_POLICY.binsAbove,
} = {}) {
  const rotationStageAuthorized = effectiveDryRun === true || effectiveRolloutMode === "canary";
  const requestedBelow = Number(binsBelow);
  const requestedAbove = Number(binsAbove);
  const requiredBelow = Number(rotationBinsBelow);
  const requiredAbove = Number(rotationBinsAbove);
  const minimumRotationBelow = SHADOW_ROTATION_POLICY.binsBelow;
  const minimumRotationTotal = SHADOW_ROTATION_POLICY.binsBelow + SHADOW_ROTATION_POLICY.binsAbove;
  return rotationStageAuthorized === true &&
    rotationEnabled === true &&
    strategyProfile === SHADOW_ROTATION_STRATEGY_PROFILE &&
    String(strategy || "").trim() === String(rotationStrategy || "").trim() &&
    Number.isInteger(requestedBelow) &&
    Number.isInteger(requestedAbove) &&
    Number.isInteger(requiredBelow) &&
    Number.isInteger(requiredAbove) &&
    requestedBelow >= minimumRotationBelow &&
    requestedAbove >= 0 &&
    requestedBelow + requestedAbove >= minimumRotationTotal &&
    requestedBelow === requiredBelow &&
    requestedAbove === requiredAbove;
}

// Keep entry admission aligned with the conservative paper valuation. These
// are model assumptions, not optimistic tuning knobs: shadow accrues only half
// the advertised pool fee and assumes at least one quarter of the position is
// earning while in range. Admission therefore has to prove that modeled fees
// can repay the full round trip inside the bounded holding horizon.
export const CONSERVATIVE_FEE_MODEL = deepFreeze({
  feeAccrualHaircutPct: 50,
  minimumFeeParticipationPct: 25,
  minimumRoundTripCostPct: 0.4,
  minimumFeeCoverageRatio: 1.10,
  maximumBreakEvenHoldMinutes: 360,
});

export const RISK_POLICY_DEFAULTS = deepFreeze({
  sizing: {
    hardMinimumWalletSol: 0.27,
    operationalReserveSol: 0.10,
    minimumSetupBufferSol: 0.065,
    setupContingencySol: 0.003,
    amountStepSol: 0.01,
    canaryAmountSol: 0.20,
    canaryMaxPositions: 1,
    tiers: [
      {
        name: "small",
        minEquitySol: 0.27,
        maxEquitySolExclusive: 1,
        targetEquityPct: 30,
        minPositionSol: 0.10,
        maxPositionSol: 0.20,
        maxPositions: 1,
        maxTotalExposurePct: 35,
      },
      {
        name: "medium",
        minEquitySol: 1,
        maxEquitySolExclusive: 5,
        targetEquityPct: 20,
        minPositionSol: 0.20,
        maxPositionSol: 0.75,
        maxPositions: 2,
        maxTotalExposurePct: 40,
      },
      {
        name: "large",
        minEquitySol: 5,
        maxEquitySolExclusive: null,
        targetEquityPct: 10,
        minPositionSol: 0.50,
        maxPositionSol: 2.00,
        maxPositions: 3,
        maxTotalExposurePct: 30,
      },
    ],
  },
  candidate: {
    pairType: "TOKEN-SOL",
    protocol: "DLMM",
    timeframeMinutes: 30,
    minActiveTvlUsd: 60_000,
    maxActiveTvlUsd: 150_000,
    minVolumeUsd: 4_000,
    minFeeActiveTvlRatioPct: 0.30,
    minVolatilityExclusive: 0,
    maxVolatilityExclusive: 2.5,
    minBinStep: 80,
    maxBinStep: 125,
    minOrganicScoreBase: 80,
    minOrganicScoreQuote: 80,
    minHolderCount: 5_000,
    minMarketCapUsd: 1_000_000,
    maxMarketCapUsd: 10_000_000,
    minTokenAgeHours: 24,
    maxTokenAgeHours: null,
    minGlobalFeesSol: 80,
    maxBotHolderPct: 20,
    maxTop10Pct: 40,
    minEntryRsi5m: 40,
    minEntryRsi15m: 35,
    maxEntryRsi5m: 75,
    maxEntryRsi15m: 80,
    feeAccrualHaircutPct: CONSERVATIVE_FEE_MODEL.feeAccrualHaircutPct,
    minimumFeeParticipationPct: CONSERVATIVE_FEE_MODEL.minimumFeeParticipationPct,
    estimatedRoundTripCostPct: CONSERVATIVE_FEE_MODEL.minimumRoundTripCostPct,
    minimumFeeCoverageRatio: CONSERVATIVE_FEE_MODEL.minimumFeeCoverageRatio,
    minimumProjectedNetFeePct:
      CONSERVATIVE_FEE_MODEL.minimumRoundTripCostPct *
      (CONSERVATIVE_FEE_MODEL.minimumFeeCoverageRatio - 1),
    maxEconomicHoldMinutes: CONSERVATIVE_FEE_MODEL.maximumBreakEvenHoldMinutes,
    requiredObservationCount: 3,
    minObservationSpacingMs: 5 * MINUTE_MS,
    maxObservationWindowMs: 20 * MINUTE_MS,
    minRetentionPct: 80,
    requirePriceStability: false,
    maxPriceDrawdownPct: null,
    maxDownsideBinDelta: null,
    maxEvaluationAgeMs: 2 * MINUTE_MS,
  },
  exit: {
    minimumAbsoluteProfitSol: 0.0005,
    minimumProfitPct: 0.50,
    takeProfitPct: 1.25,
    stopLossPct: -1.50,
    catastrophicStopPct: -2.50,
    profitProtectActivationPct: 0.80,
    profitProtectRetracePercentagePoints: 0.30,
    profitConfirmations: 2,
    stopLossConfirmations: 3,
    catastrophicStopConfirmations: 1,
  },
  poolHistory: {
    lossCooldownMs: DAY_MS,
    rollingWindowMs: 30 * DAY_MS,
    minimumDeploymentsForQualityGate: 3,
    maxOutOfRangeOrZeroEarningRatePct: 60,
    minimumCleanClosesForEconomicsGate: 5,
    minimumCumulativeNetSolExclusive: 0,
    minimumProfitFactor: 1,
  },
});

function boundedConfiguredNumber(value, fallback, { min = -Infinity, max = Infinity } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

/**
 * Build the narrow, operator-configurable portion of the entry policy.
 *
 * Yield-hold structural protections stay locked in RISK_POLICY_DEFAULTS. The
 * effective dry-run-only rotation profile has a separate, bounded micro-pool
 * overlay so it can test small/high-fee markets without silently weakening the
 * live or yield-hold financial safety boundary.
 */
export function candidatePolicyFromScreening(screening = {}, runtime = {}, policy = RISK_POLICY_DEFAULTS) {
  // Backwards compatibility for callers that historically supplied a custom
  // policy as the second argument.
  if (runtime?.candidate && runtime?.sizing && runtime?.exit) {
    policy = runtime;
    runtime = {};
  }
  const base = policy.candidate;
  const management = runtime?.management ?? runtime ?? {};
  const indicators = runtime?.indicators ?? {};
  const shadowRotation = runtime?.shadowRotation ?? {};
  const strategyProfile = runtime?.strategyProfile === SHADOW_ROTATION_STRATEGY_PROFILE && shadowRotation.enabled === true
    ? SHADOW_ROTATION_STRATEGY_PROFILE
    : YIELD_HOLD_STRATEGY_PROFILE;
  const rotationProfileActive = strategyProfile === SHADOW_ROTATION_STRATEGY_PROFILE;
  const requiredObservationCount = Math.max(
    2,
    Math.floor(boundedConfiguredNumber(
      rotationProfileActive ? shadowRotation.confirmationCount : screening.candidateConfirmationCount,
      rotationProfileActive ? SHADOW_ROTATION_POLICY.confirmationCount : base.requiredObservationCount,
      { min: 2, max: 10 },
    )),
  );
  const minObservationSpacingMs = rotationProfileActive
    ? boundedConfiguredNumber(
        shadowRotation.confirmationSpacingMs,
        SHADOW_ROTATION_POLICY.confirmationSpacingMs,
        { min: 15_000, max: 2 * MINUTE_MS },
      )
    : Math.max(
        5 * MINUTE_MS,
        boundedConfiguredNumber(screening.candidateConfirmationMinSpacingMinutes, base.minObservationSpacingMs / MINUTE_MS, { min: 5, max: 60 }) * MINUTE_MS,
      );
  const requestedWindowMs = rotationProfileActive
    ? boundedConfiguredNumber(
        shadowRotation.confirmationWindowMs,
        SHADOW_ROTATION_POLICY.confirmationWindowMs,
        { min: 2 * MINUTE_MS, max: 15 * MINUTE_MS },
      )
    : boundedConfiguredNumber(
        screening.candidateConfirmationMaxAgeMinutes,
        base.maxObservationWindowMs / MINUTE_MS,
        { min: 15, max: 120 },
      ) * MINUTE_MS;

  const estimatedRoundTripCostPct = boundedConfiguredNumber(
    rotationProfileActive
      ? shadowRotation.estimatedRoundTripCostPct
      : management.estimatedRoundTripCostPct,
    base.estimatedRoundTripCostPct,
    { min: CONSERVATIVE_FEE_MODEL.minimumRoundTripCostPct, max: 5 },
  );
  const maxEconomicHoldMinutes = boundedConfiguredNumber(
    rotationProfileActive ? shadowRotation.maxHoldMinutes : management.maxHoldMinutes,
    rotationProfileActive ? SHADOW_ROTATION_POLICY.maxHoldMinutes : base.maxEconomicHoldMinutes,
    { min: 30, max: CONSERVATIVE_FEE_MODEL.maximumBreakEvenHoldMinutes },
  );
  const minimumFeeParticipationPct = rotationProfileActive
    ? boundedConfiguredNumber(
        shadowRotation.feeParticipationPct,
        SHADOW_ROTATION_POLICY.feeParticipationPct,
        { min: 50, max: 85 },
      )
    : base.minimumFeeParticipationPct;
  const minimumProjectedNetFeePct = rotationProfileActive
    ? boundedConfiguredNumber(
        shadowRotation.minimumProjectedNetFeePct,
        SHADOW_ROTATION_POLICY.minimumProjectedNetFeePct,
        { min: 0.01, max: 0.25 },
      )
    : base.minimumProjectedNetFeePct;
  const minimumFeeCoverageRatio = estimatedRoundTripCostPct > 0
    ? (estimatedRoundTripCostPct + minimumProjectedNetFeePct) / estimatedRoundTripCostPct
    : base.minimumFeeCoverageRatio;
  const minEntryRsi5m = boundedConfiguredNumber(
    rotationProfileActive ? shadowRotation.minEntryRsi5m : indicators.entryRsiMin5m,
    rotationProfileActive ? SHADOW_ROTATION_POLICY.minEntryRsi5m : base.minEntryRsi5m,
    { min: rotationProfileActive ? SHADOW_ROTATION_POLICY.minEntryRsi5m : base.minEntryRsi5m, max: base.maxEntryRsi5m - 1 },
  );
  const minEntryRsi15m = boundedConfiguredNumber(
    rotationProfileActive ? shadowRotation.minEntryRsi15m : indicators.entryRsiMin15m,
    rotationProfileActive ? SHADOW_ROTATION_POLICY.minEntryRsi15m : base.minEntryRsi15m,
    { min: rotationProfileActive ? SHADOW_ROTATION_POLICY.minEntryRsi15m : base.minEntryRsi15m, max: base.maxEntryRsi15m - 1 },
  );
  const maxEntryRsi5m = boundedConfiguredNumber(
    rotationProfileActive ? shadowRotation.maxEntryRsi5m : indicators.entryRsiMax5m,
    rotationProfileActive ? SHADOW_ROTATION_POLICY.maxEntryRsi5m : base.maxEntryRsi5m,
    { min: minEntryRsi5m + 1, max: rotationProfileActive ? 85 : base.maxEntryRsi5m },
  );
  const maxEntryRsi15m = boundedConfiguredNumber(
    rotationProfileActive ? shadowRotation.maxEntryRsi15m : indicators.entryRsiMax15m,
    rotationProfileActive ? SHADOW_ROTATION_POLICY.maxEntryRsi15m : base.maxEntryRsi15m,
    { min: minEntryRsi15m + 1, max: rotationProfileActive ? 85 : base.maxEntryRsi15m },
  );
  const economicWindows = maxEconomicHoldMinutes / base.timeframeMinutes;
  const conservativeCaptureFraction =
    (minimumFeeParticipationPct / 100) * (base.feeAccrualHaircutPct / 100);
  const minimumEconomicFeeActiveTvlRatioPct =
    (estimatedRoundTripCostPct + minimumProjectedNetFeePct) /
    (economicWindows * conservativeCaptureFraction);
  const configuredMinFeeActiveTvlRatioPct = boundedConfiguredNumber(
    screening.minFeeActiveTvlRatio,
    rotationProfileActive
      ? SHADOW_ROTATION_POLICY.minFeeActiveTvlRatioPct
      : base.minFeeActiveTvlRatioPct,
    { min: rotationProfileActive ? 0.10 : 0.04, max: 5 },
  );

  return {
    ...policy,
    candidate: {
      ...base,
      // A configured discovery threshold may be lower for diagnostics, but the
      // authoritative admission policy can never go below modeled cost coverage.
      configuredMinFeeActiveTvlRatioPct,
      minimumEconomicFeeActiveTvlRatioPct,
      minFeeActiveTvlRatioPct: Math.max(
        configuredMinFeeActiveTvlRatioPct,
        minimumEconomicFeeActiveTvlRatioPct,
      ),
      estimatedRoundTripCostPct,
      strategyProfile,
      maxEconomicHoldMinutes,
      minimumFeeParticipationPct,
      minimumProjectedNetFeePct,
      minimumFeeCoverageRatio,
      minEntryRsi5m,
      minEntryRsi15m,
      maxEntryRsi5m,
      maxEntryRsi15m,
      minVolumeUsd: boundedConfiguredNumber(
        rotationProfileActive ? shadowRotation.minVolumeUsd : screening.minVolume,
        rotationProfileActive ? SHADOW_ROTATION_POLICY.minVolumeUsd : base.minVolumeUsd,
        { min: rotationProfileActive ? 100 : 3_500, max: base.minVolumeUsd },
      ),
      minActiveTvlUsd: boundedConfiguredNumber(
        rotationProfileActive ? shadowRotation.minActiveTvlUsd : screening.minActiveTvl,
        rotationProfileActive ? SHADOW_ROTATION_POLICY.minActiveTvlUsd : base.minActiveTvlUsd,
        { min: rotationProfileActive ? 250 : 50_000, max: base.minActiveTvlUsd },
      ),
      // Larger established pools reduce execution impact for the same locked
      // 0.1 SOL rollout exposure. Fee efficiency remains independently gated,
      // so widening this ceiling does not admit low-yield pools by itself.
      maxActiveTvlUsd: boundedConfiguredNumber(
        rotationProfileActive ? shadowRotation.maxActiveTvlUsd : screening.maxTvl,
        rotationProfileActive ? SHADOW_ROTATION_POLICY.maxActiveTvlUsd : base.maxActiveTvlUsd,
        { min: rotationProfileActive ? 10_000 : base.maxActiveTvlUsd, max: 300_000 },
      ),
      minMarketCapUsd: boundedConfiguredNumber(
        rotationProfileActive ? shadowRotation.minMarketCapUsd : screening.minMcap,
        rotationProfileActive ? SHADOW_ROTATION_POLICY.minMarketCapUsd : base.minMarketCapUsd,
        { min: rotationProfileActive ? 25_000 : base.minMarketCapUsd, max: base.minMarketCapUsd },
      ),
      maxMarketCapUsd: boundedConfiguredNumber(
        rotationProfileActive ? shadowRotation.maxMarketCapUsd : screening.maxMcap,
        rotationProfileActive ? SHADOW_ROTATION_POLICY.maxMarketCapUsd : base.maxMarketCapUsd,
        { min: base.maxMarketCapUsd, max: rotationProfileActive ? SHADOW_ROTATION_POLICY.maxMarketCapUsd : 12_000_000 },
      ),
      maxVolatilityExclusive: rotationProfileActive
        ? boundedConfiguredNumber(
            shadowRotation.maxVolatilityExclusive ?? screening.maxVolatility,
            SHADOW_ROTATION_POLICY.maxVolatilityExclusive,
            { min: base.maxVolatilityExclusive, max: 7.5 },
          )
        : base.maxVolatilityExclusive,
      minOrganicScoreBase: boundedConfiguredNumber(
        rotationProfileActive ? shadowRotation.minOrganicScoreBase : screening.minOrganic,
        rotationProfileActive ? SHADOW_ROTATION_POLICY.minOrganicScoreBase : base.minOrganicScoreBase,
        { min: rotationProfileActive ? 65 : 75, max: base.minOrganicScoreBase },
      ),
      // Quote quality remains at least the original 80 threshold. The base
      // asset is the only organic-score dimension eligible for calibration.
      minOrganicScoreQuote: boundedConfiguredNumber(
        screening.minQuoteOrganic,
        base.minOrganicScoreQuote,
        { min: base.minOrganicScoreQuote, max: 100 },
      ),
      minHolderCount: boundedConfiguredNumber(
        rotationProfileActive ? shadowRotation.minHolderCount : screening.minHolders,
        rotationProfileActive ? SHADOW_ROTATION_POLICY.minHolderCount : base.minHolderCount,
        { min: rotationProfileActive ? 250 : base.minHolderCount, max: base.minHolderCount },
      ),
      minTokenAgeHours: boundedConfiguredNumber(
        rotationProfileActive ? shadowRotation.minTokenAgeHours : screening.minTokenAgeHours,
        rotationProfileActive ? SHADOW_ROTATION_POLICY.minTokenAgeHours : base.minTokenAgeHours,
        { min: rotationProfileActive ? 0.5 : base.minTokenAgeHours, max: base.minTokenAgeHours },
      ),
      maxTokenAgeHours: rotationProfileActive
        ? boundedConfiguredNumber(
            shadowRotation.maxTokenAgeHours,
            SHADOW_ROTATION_POLICY.maxTokenAgeHours,
            { min: 24, max: 168 },
          )
        : (screening.maxTokenAgeHours != null && screening.maxTokenAgeHours !== "" && isFiniteNumber(Number(screening.maxTokenAgeHours))
            ? Math.max(base.minTokenAgeHours, Number(screening.maxTokenAgeHours))
            : base.maxTokenAgeHours),
      minGlobalFeesSol: boundedConfiguredNumber(
        rotationProfileActive ? shadowRotation.minGlobalFeesSol : screening.minTokenFeesSol,
        rotationProfileActive ? SHADOW_ROTATION_POLICY.minGlobalFeesSol : base.minGlobalFeesSol,
        { min: rotationProfileActive ? 50 : base.minGlobalFeesSol, max: base.minGlobalFeesSol },
      ),
      maxBotHolderPct: boundedConfiguredNumber(
        rotationProfileActive ? shadowRotation.maxBotHolderPct : screening.maxBotHoldersPct,
        rotationProfileActive ? SHADOW_ROTATION_POLICY.maxBotHolderPct : base.maxBotHolderPct,
        { min: base.maxBotHolderPct, max: rotationProfileActive ? 25 : base.maxBotHolderPct },
      ),
      maxTop10Pct: boundedConfiguredNumber(
        rotationProfileActive ? shadowRotation.maxTop10Pct : screening.maxTop10Pct,
        rotationProfileActive ? SHADOW_ROTATION_POLICY.maxTop10Pct : base.maxTop10Pct,
        { min: rotationProfileActive ? 20 : base.maxTop10Pct, max: base.maxTop10Pct },
      ),
      maxPositionActiveTvlPct: rotationProfileActive
        ? boundedConfiguredNumber(
            shadowRotation.maxPositionActiveTvlPct,
            SHADOW_ROTATION_POLICY.maxPositionActiveTvlPct,
            { min: 0.25, max: 2 },
          )
        : null,
      requiredObservationCount,
      minObservationSpacingMs,
      maxObservationWindowMs: Math.max(
        requestedWindowMs,
        requiredObservationCount * minObservationSpacingMs,
      ),
      // A ready observation must remain usable until the next configured
      // screening cadence. Fresh deploy preflight still re-fetches and
      // revalidates live economics, audit, and momentum before dispatch.
      maxEvaluationAgeMs: Math.max(
        rotationProfileActive ? SHADOW_ROTATION_POLICY.maxEvaluationAgeMs : base.maxEvaluationAgeMs,
        minObservationSpacingMs + MINUTE_MS,
      ),
      minRetentionPct: boundedConfiguredNumber(
        rotationProfileActive
          ? shadowRotation.minRetentionPct
          : Math.min(
              Number(screening.candidateMinFeeRetentionPct),
              Number(screening.candidateMinVolumeRetentionPct),
            ),
        rotationProfileActive ? SHADOW_ROTATION_POLICY.minRetentionPct : base.minRetentionPct,
        { min: rotationProfileActive ? 50 : 75, max: base.minRetentionPct },
      ),
      requirePriceStability: rotationProfileActive,
      maxPriceDrawdownPct: rotationProfileActive
        ? boundedConfiguredNumber(
            shadowRotation.maxPriceDrawdownPct,
            SHADOW_ROTATION_POLICY.maxPriceDrawdownPct,
            { min: 0.5, max: 3 },
          )
        : base.maxPriceDrawdownPct,
      maxDownsideBinDelta: rotationProfileActive
        ? boundedConfiguredNumber(
            shadowRotation.maxDownsideBinDelta,
            SHADOW_ROTATION_POLICY.maxDownsideBinDelta,
            { min: 1, max: 5 },
          )
        : base.maxDownsideBinDelta,
    },
  };
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonNegativeFinite(value) {
  return isFiniteNumber(value) && value >= 0;
}

function meetsMinimum(value, minimum) {
  return value + 1e-12 >= minimum;
}

function meetsMaximum(value, maximum) {
  return value - 1e-12 <= maximum;
}

function roundDown(value, step) {
  if (!isFiniteNumber(value) || !isFiniteNumber(step) || step <= 0) return null;
  const decimals = Math.max(0, String(step).split(".")[1]?.length ?? 0);
  const units = Math.floor((value + 1e-12) / step);
  return Number((units * step).toFixed(decimals));
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function getSizingTier(equitySol, policy = RISK_POLICY_DEFAULTS) {
  if (!isFiniteNumber(equitySol)) return null;
  return policy.sizing.tiers.find((tier) => (
    equitySol >= tier.minEquitySol
    && (tier.maxEquitySolExclusive == null || equitySol < tier.maxEquitySolExclusive)
  )) ?? null;
}

/**
 * Calculate a deploy amount without reading wallet or runtime state itself.
 * All SOL values are decimal SOL, never lamports.
 */
export function calculateAdaptiveSizing({
  equitySol,
  liquidSol,
  quotedPositionRentSol,
  missingAtaRentSol,
  currentExposureSol = 0,
  openPositionCount = 0,
  requiresNewBinArray = false,
  canary = false,
}, policy = RISK_POLICY_DEFAULTS) {
  const reasons = [];
  const sizing = policy.sizing;

  if (!isNonNegativeFinite(equitySol)) reasons.push("INVALID_EQUITY");
  if (!isNonNegativeFinite(liquidSol)) reasons.push("INVALID_LIQUID_BALANCE");
  if (!isNonNegativeFinite(quotedPositionRentSol)) reasons.push("INVALID_POSITION_RENT_QUOTE");
  if (!isNonNegativeFinite(missingAtaRentSol)) reasons.push("INVALID_MISSING_ATA_RENT");
  if (!isNonNegativeFinite(currentExposureSol)) reasons.push("INVALID_CURRENT_EXPOSURE");
  if (!Number.isInteger(openPositionCount) || openPositionCount < 0) reasons.push("INVALID_OPEN_POSITION_COUNT");
  if (reasons.length > 0) return { eligible: false, amountSol: 0, reasons };

  const tier = getSizingTier(equitySol, policy);
  if (equitySol < sizing.hardMinimumWalletSol || !tier) {
    reasons.push("EQUITY_BELOW_HARD_MINIMUM");
  }
  if (requiresNewBinArray) reasons.push("NEW_BIN_ARRAY_REQUIRED");

  const setupBufferSol = Math.max(
    sizing.minimumSetupBufferSol,
    quotedPositionRentSol + missingAtaRentSol + sizing.setupContingencySol,
  );
  const availableLiquidSol = Math.max(
    0,
    liquidSol - sizing.operationalReserveSol - setupBufferSol,
  );

  if (!tier || reasons.length > 0) {
    return {
      eligible: false,
      amountSol: 0,
      reasons,
      tier: tier?.name ?? null,
      setupBufferSol,
      availableLiquidSol,
    };
  }

  const maximumPositions = canary ? sizing.canaryMaxPositions : tier.maxPositions;
  if (openPositionCount >= maximumPositions) reasons.push("MAX_POSITIONS_REACHED");

  const targetAmountSol = canary
    ? sizing.canaryAmountSol
    : clamp(
      equitySol * (tier.targetEquityPct / 100),
      tier.minPositionSol,
      tier.maxPositionSol,
    );

  // Canary is an explicit fixed-size override. Normal tier exposure limits still
  // apply outside canary mode.
  const maximumExposureSol = canary
    ? sizing.canaryAmountSol
    : equitySol * (tier.maxTotalExposurePct / 100);
  const exposureRemainingSol = Math.max(0, maximumExposureSol - currentExposureSol);
  const capacitySol = Math.min(targetAmountSol, exposureRemainingSol, availableLiquidSol);
  const amountSol = roundDown(capacitySol, sizing.amountStepSol);
  const minimumAmountSol = canary ? sizing.canaryAmountSol : tier.minPositionSol;

  if (amountSol < minimumAmountSol) reasons.push("INSUFFICIENT_DEPLOY_CAPACITY");

  return {
    eligible: reasons.length === 0,
    amountSol: reasons.length === 0 ? amountSol : 0,
    reasons,
    tier: tier.name,
    canary,
    targetAmountSol,
    maximumPositions,
    maximumExposureSol,
    exposureRemainingSol,
    operationalReserveSol: sizing.operationalReserveSol,
    setupBufferSol,
    availableLiquidSol,
  };
}

function addRequiredNumberGate(reasons, value, code, predicate) {
  if (!isFiniteNumber(value)) {
    reasons.push(`MISSING_OR_INVALID_${code}`);
  } else if (!predicate(value)) {
    reasons.push(code);
  }
}

/**
 * Project conservative fee capture over the admission horizon. Candidate fee
 * ratio and modeled cost are both percentages of principal, so this remains
 * valid across wallet sizes and the locked 0.20 SOL canary.
 */
export function calculateEntryFeeEconomics(candidate, policy = RISK_POLICY_DEFAULTS) {
  const value = candidate ?? {};
  const defaults = policy?.candidate ?? {};
  const timeframeMinutes = value.timeframeMinutes;
  const feeActiveTvlRatioPct = value.feeActiveTvlRatioPct;
  const maxHoldMinutes = defaults.maxEconomicHoldMinutes;
  const feeParticipationPct = defaults.minimumFeeParticipationPct;
  const feeAccrualHaircutPct = defaults.feeAccrualHaircutPct;
  const estimatedRoundTripCostPct = defaults.estimatedRoundTripCostPct;
  const minimumFeeCoverageRatio = defaults.minimumFeeCoverageRatio;
  const minimumProjectedNetFeePct = isFiniteNumber(defaults.minimumProjectedNetFeePct)
    ? defaults.minimumProjectedNetFeePct
    : estimatedRoundTripCostPct * (minimumFeeCoverageRatio - 1);
  const inputsValid = [
    timeframeMinutes,
    feeActiveTvlRatioPct,
    maxHoldMinutes,
    feeParticipationPct,
    feeAccrualHaircutPct,
    estimatedRoundTripCostPct,
    minimumFeeCoverageRatio,
    minimumProjectedNetFeePct,
  ].every(isFiniteNumber)
    && timeframeMinutes > 0
    && feeActiveTvlRatioPct >= 0
    && maxHoldMinutes > 0
    && feeParticipationPct > 0
    && feeAccrualHaircutPct > 0
    && estimatedRoundTripCostPct >= 0
    && minimumFeeCoverageRatio > 0;

  if (!inputsValid) {
    return {
      eligible: false,
      reason: "INVALID_ENTRY_ECONOMICS",
      timeframeMinutes: isFiniteNumber(timeframeMinutes) ? timeframeMinutes : null,
      feeActiveTvlRatioPct: isFiniteNumber(feeActiveTvlRatioPct) ? feeActiveTvlRatioPct : null,
      requiredFeeActiveTvlRatioPct: null,
      projectedCapturedFeePct: null,
      projectedNetFeePct: null,
    };
  }

  const windows = maxHoldMinutes / timeframeMinutes;
  const captureFraction = (feeParticipationPct / 100) * (feeAccrualHaircutPct / 100);
  const projectedCapturedFeePct = feeActiveTvlRatioPct * windows * captureFraction;
  const projectedNetFeePct = projectedCapturedFeePct - estimatedRoundTripCostPct;
  const requiredCapturedFeePct = estimatedRoundTripCostPct + minimumProjectedNetFeePct;
  const requiredFeeActiveTvlRatioPct = requiredCapturedFeePct / (windows * captureFraction);
  const eligible = meetsMinimum(projectedCapturedFeePct, requiredCapturedFeePct);

  return {
    eligible,
    reason: eligible ? null : "FEE_ECONOMICS_BELOW_REQUIRED_COVERAGE",
    timeframeMinutes,
    maxHoldMinutes,
    windows,
    feeActiveTvlRatioPct,
    feeParticipationPct,
    feeAccrualHaircutPct,
    estimatedRoundTripCostPct,
    minimumFeeCoverageRatio,
    minimumProjectedNetFeePct,
    requiredCapturedFeePct,
    requiredFeeActiveTvlRatioPct,
    projectedCapturedFeePct,
    projectedNetFeePct,
    feeCoverageRatio: estimatedRoundTripCostPct > 0
      ? projectedCapturedFeePct / estimatedRoundTripCostPct
      : Number.POSITIVE_INFINITY,
  };
}

function getObservationValue(observation, primary, fallback) {
  const value = observation?.[primary] ?? observation?.[fallback];
  return isFiniteNumber(value) ? value : null;
}

/**
 * Measure downside price instability across ordered candidate snapshots.
 *
 * DLMM discovery does not consistently expose an active-bin id, but it does
 * expose pool price and bin step. Converting each consecutive price ratio to
 * bin units gives the same downside-jump signal without adding an RPC call to
 * every discovery candidate.
 */
export function evaluatePriceStabilityObservations(observations, {
  required = false,
  maxPriceDrawdownPct = null,
  maxDownsideBinDelta = null,
} = {}) {
  if (!required) {
    return {
      eligible: true,
      reasons: [],
      maxObservedDrawdownPct: null,
      maxObservedDownsideBinDelta: null,
    };
  }

  if (!Array.isArray(observations) || observations.length < 2) {
    return {
      eligible: false,
      reasons: ["INSUFFICIENT_PRICE_STABILITY_OBSERVATIONS"],
      maxObservedDrawdownPct: null,
      maxObservedDownsideBinDelta: null,
    };
  }

  const normalized = observations.map((observation) => ({
    price: getObservationValue(observation, "priceValue", "price"),
    binStep: getObservationValue(observation, "binStepValue", "binStep"),
  }));
  if (normalized.some((observation) => (
    observation.price == null || observation.price <= 0 ||
    observation.binStep == null || observation.binStep <= 0
  ))) {
    return {
      eligible: false,
      reasons: ["INVALID_PRICE_STABILITY_DATA"],
      maxObservedDrawdownPct: null,
      maxObservedDownsideBinDelta: null,
    };
  }

  let peakPrice = normalized[0].price;
  let maxObservedDrawdownPct = 0;
  let maxObservedDownsideBinDelta = 0;
  for (let index = 1; index < normalized.length; index += 1) {
    const previous = normalized[index - 1];
    const current = normalized[index];
    peakPrice = Math.max(peakPrice, current.price);
    maxObservedDrawdownPct = Math.max(
      maxObservedDrawdownPct,
      ((peakPrice - current.price) / peakPrice) * 100,
    );

    const stepRatio = 1 + current.binStep / 10_000;
    const priceRatio = current.price / previous.price;
    const binDelta = Math.log(priceRatio) / Math.log(stepRatio);
    if (Number.isFinite(binDelta)) {
      maxObservedDownsideBinDelta = Math.max(maxObservedDownsideBinDelta, -binDelta, 0);
    }
  }

  const reasons = [];
  if (
    isFiniteNumber(maxPriceDrawdownPct) &&
    maxObservedDrawdownPct >= maxPriceDrawdownPct
  ) {
    reasons.push("PRICE_DRAWDOWN_ABOVE_MAXIMUM");
  }
  if (
    isFiniteNumber(maxDownsideBinDelta) &&
    maxObservedDownsideBinDelta >= maxDownsideBinDelta
  ) {
    reasons.push("DOWNSIDE_BIN_JUMP_ABOVE_MAXIMUM");
  }

  return {
    eligible: reasons.length === 0,
    reasons,
    maxObservedDrawdownPct,
    maxObservedDownsideBinDelta,
  };
}

export function evaluateCandidateStability(observations, evaluatedAtMs, policy = RISK_POLICY_DEFAULTS) {
  const defaults = policy.candidate;
  if (!Array.isArray(observations) || observations.length < defaults.requiredObservationCount) {
    return { eligible: false, reasons: ["INSUFFICIENT_STABILITY_OBSERVATIONS"] };
  }

  const sorted = observations
    .filter((item) => isFiniteNumber(item?.observedAtMs))
    .sort((a, b) => a.observedAtMs - b.observedAtMs)
    .slice(-defaults.requiredObservationCount);

  if (sorted.length < defaults.requiredObservationCount) {
    return { eligible: false, reasons: ["INVALID_STABILITY_OBSERVATION_TIME"] };
  }

  const reasons = [];
  const first = sorted[0];
  const last = sorted.at(-1);
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index].observedAtMs - sorted[index - 1].observedAtMs < defaults.minObservationSpacingMs) {
      reasons.push("STABILITY_OBSERVATIONS_TOO_CLOSE");
      break;
    }
  }
  if (last.observedAtMs - first.observedAtMs > defaults.maxObservationWindowMs) {
    reasons.push("STABILITY_OBSERVATION_WINDOW_TOO_LONG");
  }
  if (
    !isFiniteNumber(evaluatedAtMs)
    || last.observedAtMs > evaluatedAtMs
    || evaluatedAtMs - last.observedAtMs > defaults.maxEvaluationAgeMs
  ) {
    reasons.push("STALE_STABILITY_OBSERVATIONS");
  }

  const feeValues = sorted.map((item) => getObservationValue(item, "feeValue", "fee"));
  const volumeValues = sorted.map((item) => getObservationValue(item, "volumeValue", "volume"));
  const firstFee = feeValues[0];
  const firstVolume = volumeValues[0];
  if (firstFee == null || firstFee <= 0 || feeValues.some((item) => item == null || item < 0)) {
    reasons.push("INVALID_FEE_RETENTION_DATA");
  }
  if (firstVolume == null || firstVolume <= 0 || volumeValues.some((item) => item == null || item < 0)) {
    reasons.push("INVALID_VOLUME_RETENTION_DATA");
  }

  // Use the weakest reading, not only the latest reading, so a transient
  // collapse cannot be hidden by a last-minute recovery.
  const feeRetentionPct = firstFee > 0 && feeValues.every((item) => item != null)
    ? (Math.min(...feeValues) / firstFee) * 100
    : null;
  const volumeRetentionPct = firstVolume > 0 && volumeValues.every((item) => item != null)
    ? (Math.min(...volumeValues) / firstVolume) * 100
    : null;
  const minimumRetentionPct = feeRetentionPct == null || volumeRetentionPct == null
    ? null
    : Math.min(feeRetentionPct, volumeRetentionPct);
  const latestFee = feeValues.at(-1);
  const latestVolume = volumeValues.at(-1);
  const feeAccelerationPct = firstFee > 0 && latestFee != null
    ? (latestFee / firstFee) * 100
    : null;
  const volumeAccelerationPct = firstVolume > 0 && latestVolume != null
    ? (latestVolume / firstVolume) * 100
    : null;
  const hotnessScore = feeAccelerationPct == null || volumeAccelerationPct == null
    ? null
    : (feeAccelerationPct + volumeAccelerationPct) / 2;

  if (feeRetentionPct != null && !meetsMinimum(feeRetentionPct, defaults.minRetentionPct)) {
    reasons.push("FEE_RETENTION_BELOW_MINIMUM");
  }
  if (volumeRetentionPct != null && !meetsMinimum(volumeRetentionPct, defaults.minRetentionPct)) {
    reasons.push("VOLUME_RETENTION_BELOW_MINIMUM");
  }

  const priceStability = evaluatePriceStabilityObservations(sorted, {
    required: defaults.requirePriceStability === true,
    maxPriceDrawdownPct: defaults.maxPriceDrawdownPct,
    maxDownsideBinDelta: defaults.maxDownsideBinDelta,
  });
  reasons.push(...priceStability.reasons);

  return {
    eligible: reasons.length === 0,
    reasons,
    observationCount: sorted.length,
    firstObservedAtMs: first.observedAtMs,
    lastObservedAtMs: last.observedAtMs,
    feeRetentionPct,
    volumeRetentionPct,
    minimumRetentionPct,
    feeAccelerationPct,
    volumeAccelerationPct,
    hotnessScore,
    priceStability,
  };
}

export function evaluateEntryMomentum(candidate, policy = RISK_POLICY_DEFAULTS) {
  const value = candidate ?? {};
  const defaults = policy.candidate;
  const reasons = [];
  const momentum5m = value.momentum5m ?? {};
  const momentum15m = value.momentum15m ?? {};
  const rotationTrend = defaults.strategyProfile === SHADOW_ROTATION_STRATEGY_PROFILE;

  if (momentum5m.available !== true) reasons.push("MISSING_5M_MOMENTUM");
  if (momentum15m.available !== true) reasons.push("MISSING_15M_MOMENTUM");

  if (rotationTrend) {
    const fiveMinuteTrendConfirmed =
      momentum5m.supertrendBreakDown !== true &&
      isFiniteNumber(momentum5m.close) &&
      isFiniteNumber(momentum5m.previousClose) &&
      isFiniteNumber(momentum5m.lowerBand) &&
      meetsMinimum(momentum5m.close, momentum5m.previousClose) &&
      meetsMinimum(momentum5m.close, momentum5m.lowerBand) &&
      !(isFiniteNumber(momentum5m.upperBand) && momentum5m.close > momentum5m.upperBand);
    const fifteenMinuteTrendConfirmed =
      momentum15m.supertrendBreakDown !== true &&
      isFiniteNumber(momentum15m.close) &&
      isFiniteNumber(momentum15m.previousClose) &&
      isFiniteNumber(momentum15m.lowerBand) &&
      meetsMinimum(momentum15m.close, momentum15m.previousClose) &&
      meetsMinimum(momentum15m.close, momentum15m.lowerBand) &&
      !(isFiniteNumber(momentum15m.upperBand) && momentum15m.close > momentum15m.upperBand);
    if (momentum5m.available === true && !fiveMinuteTrendConfirmed) {
      reasons.push("ROTATION_5M_TREND_NOT_CONFIRMED");
    }
    if (momentum15m.available === true && !fifteenMinuteTrendConfirmed) {
      reasons.push("ROTATION_15M_TREND_NOT_CONFIRMED");
    }
  } else {
    if (
      momentum5m.available === true &&
      momentum5m.supertrendDirection !== "bullish" &&
      momentum5m.supertrendBreakUp !== true
    ) {
      reasons.push("FIVE_MINUTE_SUPERTREND_NOT_BULLISH");
    }
    if (momentum15m.available === true && momentum15m.supertrendDirection === "bearish") {
      reasons.push("FIFTEEN_MINUTE_SUPERTREND_BEARISH");
    }
  }

  if (!isFiniteNumber(momentum5m.rsi)) {
    reasons.push("MISSING_5M_RSI");
  } else {
    if (momentum5m.rsi < defaults.minEntryRsi5m) reasons.push("FIVE_MINUTE_RSI_BELOW_RECOVERY_MINIMUM");
    if (momentum5m.rsi >= defaults.maxEntryRsi5m) reasons.push("FIVE_MINUTE_RSI_ABOVE_MAXIMUM");
  }
  if (!isFiniteNumber(momentum15m.rsi)) {
    reasons.push("MISSING_15M_RSI");
  } else {
    if (momentum15m.rsi < defaults.minEntryRsi15m) reasons.push("FIFTEEN_MINUTE_RSI_BELOW_RECOVERY_MINIMUM");
    if (momentum15m.rsi >= defaults.maxEntryRsi15m) reasons.push("FIFTEEN_MINUTE_RSI_ABOVE_MAXIMUM");
  }

  return {
    eligible: reasons.length === 0,
    reasons,
    mode: rotationTrend ? "rotation_trend_continuation" : "yield_hold_bullish_confirmation",
  };
}

/**
 * Fail-closed deterministic entry gate. Candidate values use the units named
 * in each field; feeActiveTvlRatioPct is already a percentage (0.15 = 0.15%).
 */
export function evaluateCandidate(candidate, {
  nowMs = Date.now(),
} = {}, policy = RISK_POLICY_DEFAULTS) {
  const value = candidate ?? {};
  const defaults = policy.candidate;
  const reasons = [];

  if (value.pairType !== defaults.pairType) reasons.push("PAIR_NOT_TOKEN_SOL");
  if (value.protocol !== defaults.protocol) reasons.push("PROTOCOL_NOT_DLMM");
  if (value.timeframeMinutes !== defaults.timeframeMinutes) reasons.push("WRONG_METRIC_TIMEFRAME");
  if (typeof value.poolAddress !== "string" || value.poolAddress.length === 0) {
    reasons.push("MISSING_POOL_ADDRESS");
  }

  if (
    !isFiniteNumber(value.evaluatedAtMs)
    || value.evaluatedAtMs > nowMs
    || nowMs - value.evaluatedAtMs > defaults.maxEvaluationAgeMs
  ) {
    reasons.push("STALE_OR_MISSING_EVALUATION");
  }

  addRequiredNumberGate(reasons, value.activeTvlUsd, "ACTIVE_TVL_OUT_OF_RANGE", (number) => (
    number >= defaults.minActiveTvlUsd && number <= defaults.maxActiveTvlUsd
  ));
  const requestedDeployUsd = isFiniteNumber(value.requestedDeployUsd) ? value.requestedDeployUsd : null;
  const positionActiveTvlPct = requestedDeployUsd != null && isFiniteNumber(value.activeTvlUsd) && value.activeTvlUsd > 0
    ? requestedDeployUsd / value.activeTvlUsd * 100
    : null;
  if (defaults.strategyProfile === SHADOW_ROTATION_STRATEGY_PROFILE) {
    if (requestedDeployUsd == null || requestedDeployUsd <= 0) {
      reasons.push("MISSING_ROTATION_DEPLOY_NOTIONAL");
    } else if (!isFiniteNumber(defaults.maxPositionActiveTvlPct) || positionActiveTvlPct > defaults.maxPositionActiveTvlPct) {
      reasons.push("POSITION_ACTIVE_TVL_SHARE_TOO_HIGH");
    }
  }
  addRequiredNumberGate(reasons, value.volumeUsd, "VOLUME_BELOW_MINIMUM", (number) => (
    number >= defaults.minVolumeUsd
  ));
  addRequiredNumberGate(
    reasons,
    value.feeActiveTvlRatioPct,
    "FEE_ACTIVE_TVL_RATIO_BELOW_MINIMUM",
    (number) => number >= defaults.minFeeActiveTvlRatioPct,
  );
  addRequiredNumberGate(reasons, value.volatility, "VOLATILITY_OUT_OF_RANGE", (number) => (
    number > defaults.minVolatilityExclusive && number < defaults.maxVolatilityExclusive
  ));
  addRequiredNumberGate(reasons, value.binStep, "BIN_STEP_OUT_OF_RANGE", (number) => (
    number >= defaults.minBinStep && number <= defaults.maxBinStep
  ));
  addRequiredNumberGate(reasons, value.organicScoreBase, "BASE_ORGANIC_SCORE_BELOW_MINIMUM", (number) => (
    number >= defaults.minOrganicScoreBase
  ));
  addRequiredNumberGate(reasons, value.organicScoreQuote, "QUOTE_ORGANIC_SCORE_BELOW_MINIMUM", (number) => (
    number >= defaults.minOrganicScoreQuote
  ));
  addRequiredNumberGate(reasons, value.holderCount, "HOLDER_COUNT_BELOW_MINIMUM", (number) => (
    number >= defaults.minHolderCount
  ));
  addRequiredNumberGate(reasons, value.marketCapUsd, "MARKET_CAP_OUT_OF_RANGE", (number) => (
    number >= defaults.minMarketCapUsd && number <= defaults.maxMarketCapUsd
  ));
  addRequiredNumberGate(reasons, value.tokenAgeHours, "TOKEN_TOO_YOUNG", (number) => (
    number >= defaults.minTokenAgeHours
  ));
  if (isFiniteNumber(defaults.maxTokenAgeHours)) {
    addRequiredNumberGate(reasons, value.tokenAgeHours, "TOKEN_TOO_OLD", (number) => (
      number <= defaults.maxTokenAgeHours
    ));
  }
  addRequiredNumberGate(reasons, value.globalFeesSol, "GLOBAL_FEES_BELOW_MINIMUM", (number) => (
    number >= defaults.minGlobalFeesSol
  ));
  addRequiredNumberGate(reasons, value.smartWalletCount, "SMART_WALLET_COUNT_INVALID", (number) => (
    Number.isInteger(number) && number >= 0
  ));

  const audit = value.audit ?? {};
  if (
    !isFiniteNumber(audit.checkedAtMs)
    || audit.checkedAtMs > nowMs
    || nowMs - audit.checkedAtMs > defaults.maxEvaluationAgeMs
  ) {
    reasons.push("STALE_OR_MISSING_AUDIT");
  }
  addRequiredNumberGate(reasons, audit.botHolderPct, "BOT_HOLDER_CONCENTRATION_TOO_HIGH", (number) => (
    number <= defaults.maxBotHolderPct
  ));
  addRequiredNumberGate(reasons, audit.top10Pct, "TOP10_CONCENTRATION_TOO_HIGH", (number) => (
    number <= defaults.maxTop10Pct
  ));
  if (audit.mintAuthorityDisabled !== true) reasons.push("MINT_AUTHORITY_NOT_DISABLED");
  if (audit.freezeAuthorityDisabled !== true) reasons.push("FREEZE_AUTHORITY_NOT_DISABLED");
  if (audit.criticalWarning !== false) reasons.push("CRITICAL_WARNING_OR_UNKNOWN");
  if (audit.highConcentration !== false) reasons.push("HIGH_CONCENTRATION_OR_UNKNOWN");
  if (audit.highSingleOwner !== false) reasons.push("HIGH_SINGLE_OWNER_OR_UNKNOWN");
  if (audit.pvp !== false) reasons.push("PVP_OR_UNKNOWN");
  if (audit.blocklisted !== false) reasons.push("BLOCKLISTED_OR_UNKNOWN");

  const momentum = evaluateEntryMomentum(value, policy);
  reasons.push(...momentum.reasons);

  const economics = calculateEntryFeeEconomics(value, policy);
  if (!economics.eligible) reasons.push(economics.reason);

  const stability = evaluateCandidateStability(value.observations, value.evaluatedAtMs, policy);
  reasons.push(...stability.reasons);

  return {
    eligible: reasons.length === 0,
    reasons: [...new Set(reasons)],
    stability,
    economics,
    momentum,
    rankingMetrics: {
      feeActiveTvlRatioPct: value.feeActiveTvlRatioPct,
      projectedNetFeePct: economics.projectedNetFeePct,
      volumeToActiveTvlRatio: isFiniteNumber(value.volumeUsd) && value.activeTvlUsd > 0
        ? value.volumeUsd / value.activeTvlUsd
        : null,
      minimumRetentionPct: stability.minimumRetentionPct,
      hotnessScore: stability.hotnessScore,
      positionActiveTvlPct,
      botHolderPct: audit.botHolderPct,
      top10Pct: audit.top10Pct,
      smartWalletCount: value.smartWalletCount,
    },
  };
}

function descending(left, right) {
  return right - left;
}

function ascending(left, right) {
  return left - right;
}

function comparePoolAddress(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/** Rank only hard-passed candidates; rejected candidates are returned separately. */
export function rankEligibleCandidates(candidates, options = {}, policy = RISK_POLICY_DEFAULTS) {
  if (!Array.isArray(candidates)) return { ranked: [], rejected: [] };
  const evaluated = candidates.map((candidate) => ({
    candidate,
    evaluation: evaluateCandidate(candidate, options, policy),
  }));
  const ranked = evaluated
    .filter(({ evaluation }) => evaluation.eligible)
    .sort((left, right) => {
      const a = left.evaluation.rankingMetrics;
      const b = right.evaluation.rankingMetrics;
      return descending(a.feeActiveTvlRatioPct, b.feeActiveTvlRatioPct)
        || descending(a.projectedNetFeePct, b.projectedNetFeePct)
        || descending(a.volumeToActiveTvlRatio, b.volumeToActiveTvlRatio)
        || descending(a.hotnessScore, b.hotnessScore)
        || descending(a.minimumRetentionPct, b.minimumRetentionPct)
        || ascending(a.positionActiveTvlPct, b.positionActiveTvlPct)
        || ascending(a.botHolderPct, b.botHolderPct)
        || ascending(a.top10Pct, b.top10Pct)
        || descending(a.smartWalletCount, b.smartWalletCount)
        || comparePoolAddress(left.candidate.poolAddress, right.candidate.poolAddress);
    });
  return {
    ranked,
    rejected: evaluated.filter(({ evaluation }) => !evaluation.eligible),
  };
}

export function selectDeterministicCandidate(candidates, options = {}, policy = RISK_POLICY_DEFAULTS) {
  const result = rankEligibleCandidates(candidates, options, policy);
  return {
    selected: result.ranked[0] ?? null,
    ...result,
  };
}

export function getGlobalProfitFloorSol(deployedSol, policy = RISK_POLICY_DEFAULTS) {
  if (!isFiniteNumber(deployedSol) || deployedSol <= 0) return null;
  return Math.max(
    policy.exit.minimumAbsoluteProfitSol,
    deployedSol * (policy.exit.minimumProfitPct / 100),
  );
}

export function calculateProjectedExitMetrics({
  deployedSol,
  equityBeforeDeploySol,
  projectedEquityAfterExitSol,
}, policy = RISK_POLICY_DEFAULTS) {
  if (!isFiniteNumber(deployedSol) || deployedSol <= 0) {
    throw new TypeError("deployedSol must be a positive finite number");
  }
  if (!isFiniteNumber(equityBeforeDeploySol) || !isFiniteNumber(projectedEquityAfterExitSol)) {
    throw new TypeError("equityBeforeDeploySol and projectedEquityAfterExitSol must be finite numbers");
  }
  const projectedNetProfitSol = projectedEquityAfterExitSol - equityBeforeDeploySol;
  const projectedNetProfitPct = (projectedNetProfitSol / deployedSol) * 100;
  const globalProfitFloorSol = getGlobalProfitFloorSol(deployedSol, policy);
  return {
    deployedSol,
    equityBeforeDeploySol,
    projectedEquityAfterExitSol,
    projectedNetProfitSol,
    projectedNetProfitPct,
    globalProfitFloorSol,
    clearsGlobalProfitFloor: meetsMinimum(projectedNetProfitSol, globalProfitFloorSol),
  };
}

/** Profit exits require the floor; risk/operational exits may cut a loss. */
export function authorizeProjectedExit({
  exitClass,
  deployedSol,
  projectedNetProfitSol,
}, policy = RISK_POLICY_DEFAULTS) {
  if (!isFiniteNumber(deployedSol) || deployedSol <= 0 || !isFiniteNumber(projectedNetProfitSol)) {
    return { allowed: false, reason: "INVALID_PROJECTED_EXIT_DATA" };
  }
  if (exitClass !== "profit" && exitClass !== "risk" && exitClass !== "operational") {
    return { allowed: false, reason: "INVALID_EXIT_CLASS" };
  }
  const globalProfitFloorSol = getGlobalProfitFloorSol(deployedSol, policy);
  if (exitClass === "profit" && !meetsMinimum(projectedNetProfitSol, globalProfitFloorSol)) {
    return { allowed: false, reason: "GLOBAL_PROFIT_FLOOR_NOT_MET", globalProfitFloorSol };
  }
  return { allowed: true, reason: null, globalProfitFloorSol };
}

export function evaluateProjectedExit({
  deployedSol,
  equityBeforeDeploySol,
  projectedEquityAfterExitSol,
  peakProjectedNetProfitPct = null,
  confirmations = {},
}, policy = RISK_POLICY_DEFAULTS) {
  const metrics = calculateProjectedExitMetrics({
    deployedSol,
    equityBeforeDeploySol,
    projectedEquityAfterExitSol,
  }, policy);
  const defaults = policy.exit;
  const currentPct = metrics.projectedNetProfitPct;

  if (meetsMaximum(currentPct, defaults.catastrophicStopPct)) {
    return {
      shouldExit: true,
      reason: "CATASTROPHIC_STOP",
      exitClass: "risk",
      requiredConfirmations: defaults.catastrophicStopConfirmations,
      metrics,
    };
  }

  if (meetsMaximum(currentPct, defaults.stopLossPct)) {
    const received = Math.max(0, Number(confirmations.stopLoss) || 0);
    return {
      shouldExit: received >= defaults.stopLossConfirmations,
      pendingReason: received < defaults.stopLossConfirmations ? "STOP_LOSS_CONFIRMATION_PENDING" : null,
      reason: received >= defaults.stopLossConfirmations ? "STOP_LOSS" : null,
      exitClass: "risk",
      requiredConfirmations: defaults.stopLossConfirmations,
      receivedConfirmations: received,
      metrics,
    };
  }

  const profitConfirmations = Math.max(0, Number(confirmations.profit) || 0);
  const profitConfirmed = profitConfirmations >= defaults.profitConfirmations;
  if (meetsMinimum(currentPct, defaults.takeProfitPct) && metrics.clearsGlobalProfitFloor) {
    return {
      shouldExit: profitConfirmed,
      pendingReason: profitConfirmed ? null : "PROFIT_CONFIRMATION_PENDING",
      reason: profitConfirmed ? "TAKE_PROFIT" : null,
      exitClass: "profit",
      requiredConfirmations: defaults.profitConfirmations,
      receivedConfirmations: profitConfirmations,
      metrics,
    };
  }

  const peakPct = isFiniteNumber(peakProjectedNetProfitPct) ? peakProjectedNetProfitPct : null;
  const retracePercentagePoints = peakPct == null ? null : peakPct - currentPct;
  if (
    peakPct != null
    && meetsMinimum(peakPct, defaults.profitProtectActivationPct)
    && meetsMinimum(retracePercentagePoints, defaults.profitProtectRetracePercentagePoints)
    && metrics.clearsGlobalProfitFloor
  ) {
    return {
      shouldExit: profitConfirmed,
      pendingReason: profitConfirmed ? null : "PROFIT_CONFIRMATION_PENDING",
      reason: profitConfirmed ? "PROFIT_PROTECT" : null,
      exitClass: "profit",
      retracePercentagePoints,
      requiredConfirmations: defaults.profitConfirmations,
      receivedConfirmations: profitConfirmations,
      metrics,
    };
  }

  return {
    shouldExit: false,
    reason: null,
    exitClass: null,
    metrics,
  };
}

function recordTime(record) {
  if (isFiniteNumber(record?.closedAtMs)) return record.closedAtMs;
  if (isFiniteNumber(record?.deployedAtMs)) return record.deployedAtMs;
  return null;
}

export function calculateProfitFactor(records) {
  let grossProfitSol = 0;
  let grossLossSol = 0;
  for (const record of records ?? []) {
    if (!isFiniteNumber(record?.netProfitSol)) continue;
    if (record.netProfitSol > 0) grossProfitSol += record.netProfitSol;
    if (record.netProfitSol < 0) grossLossSol += Math.abs(record.netProfitSol);
  }
  if (grossLossSol === 0) return grossProfitSol > 0 ? Number.POSITIVE_INFINITY : 0;
  return grossProfitSol / grossLossSol;
}

/** Evaluate a single pool/mint's history. Records outside 30 days are ignored. */
export function evaluatePoolHistory({
  records,
  nowMs = Date.now(),
} = {}, policy = RISK_POLICY_DEFAULTS) {
  const defaults = policy.poolHistory;
  const validRecords = Array.isArray(records)
    ? records.filter((record) => {
      const time = recordTime(record);
      return time != null && time <= nowMs && nowMs - time <= defaults.rollingWindowMs;
    })
    : [];
  const reasons = [];

  const latestLoss = validRecords
    .filter((record) => isFiniteNumber(record.netProfitSol) && record.netProfitSol < 0)
    .sort((a, b) => recordTime(b) - recordTime(a))[0] ?? null;
  const cooldownUntilMs = latestLoss == null ? null : recordTime(latestLoss) + defaults.lossCooldownMs;
  if (cooldownUntilMs != null && nowMs < cooldownUntilMs) reasons.push("NET_LOSS_COOLDOWN_ACTIVE");

  const deployments = validRecords.filter((record) => isFiniteNumber(record.deployedAtMs));
  const poorRangeOrEarningCount = deployments.filter((record) => (
    record.outOfRange === true || record.zeroEarning === true
  )).length;
  const outOfRangeOrZeroEarningRatePct = deployments.length === 0
    ? 0
    : (poorRangeOrEarningCount / deployments.length) * 100;
  if (
    deployments.length >= defaults.minimumDeploymentsForQualityGate
    && outOfRangeOrZeroEarningRatePct >= defaults.maxOutOfRangeOrZeroEarningRatePct
  ) {
    reasons.push("POOL_RANGE_OR_EARNING_RATE_BLOCKED");
  }

  const cleanCloses = validRecords.filter((record) => (
    record.cleanClose === true && isFiniteNumber(record.netProfitSol)
  ));
  const cumulativeNetSol = cleanCloses.reduce((sum, record) => sum + record.netProfitSol, 0);
  const profitFactor = calculateProfitFactor(cleanCloses);
  if (cleanCloses.length >= defaults.minimumCleanClosesForEconomicsGate) {
    if (cumulativeNetSol <= defaults.minimumCumulativeNetSolExclusive) {
      reasons.push("POOL_CUMULATIVE_NET_NOT_POSITIVE");
    }
    if (profitFactor < defaults.minimumProfitFactor) {
      reasons.push("POOL_PROFIT_FACTOR_BELOW_MINIMUM");
    }
  }

  return {
    eligible: reasons.length === 0,
    reasons,
    cooldownUntilMs,
    metrics: {
      rollingRecordCount: validRecords.length,
      deploymentCount: deployments.length,
      poorRangeOrEarningCount,
      outOfRangeOrZeroEarningRatePct,
      cleanCloseCount: cleanCloses.length,
      cumulativeNetSol,
      profitFactor,
    },
  };
}

export const RISK_POLICY_TIME = deepFreeze({ MINUTE_MS, HOUR_MS, DAY_MS });
