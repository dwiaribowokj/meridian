/**
 * Read-only lifecycle manager for DRY_RUN paper positions.
 *
 * This module deliberately has no wallet, executor, transaction, or signing
 * imports. Its only external dependency is a read-only active-bin function
 * injected by the caller, which keeps the lifecycle deterministic in tests and
 * prevents paper exits from ever reaching an on-chain execution path.
 */

import {
  confirmPaperPeak,
  evaluatePaperPositionExit,
  getOpenPaperPositions,
  getPaperLifecycleMetrics,
  recordPaperObservationFailure,
  registerPaperExitSignal,
  settlePaperPosition,
  updatePaperPositionObservation,
  updatePaperPositionValuation,
} from "./state.js";
import {
  CONSERVATIVE_FEE_MODEL,
  SHADOW_ROTATION_STRATEGY_PROFILE,
} from "./risk-policy.js";

const ENTRY_COST_SHARE = 0.4;
const EXIT_COST_SHARE = 0.6;
const FEE_ACCRUAL_HAIRCUT = CONSERVATIVE_FEE_MODEL.feeAccrualHaircutPct / 100;
const MIN_IN_RANGE_FEE_PARTICIPATION = CONSERVATIVE_FEE_MODEL.minimumFeeParticipationPct / 100;
const FEE_TIMEFRAME_MINUTES = Object.freeze({
  "5m": 5,
  "30m": 30,
  "1h": 60,
  "2h": 120,
  "4h": 240,
  "12h": 720,
  "24h": 24 * 60,
});

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function positive(value, fallback = 0) {
  const number = finite(value);
  return number != null && number > 0 ? number : fallback;
}

function round(value, digits = 9) {
  const number = finite(value);
  if (number == null) return null;
  const factor = 10 ** digits;
  return Math.round(number * factor) / factor;
}

function ageMinutes(deployedAt, nowMs) {
  const deployedMs = Date.parse(deployedAt || "");
  if (!Number.isFinite(deployedMs)) return null;
  return Math.max(0, Math.floor((nowMs - deployedMs) / 60_000));
}

function binFromObservation(observation) {
  return finite(observation?.active_bin ?? observation?.binId);
}

function priceFromObservation(observation) {
  return finite(observation?.active_price ?? observation?.price);
}

function confirmationTicks(value, fallback = 2) {
  const fallbackTicks = Number.isInteger(fallback) && fallback > 0 ? fallback : 2;
  const ticks = finite(value);
  return Number.isInteger(ticks) && ticks > 0 ? ticks : fallbackTicks;
}

function feeTimeframeMinutes(value) {
  const numeric = finite(value);
  if (numeric != null && numeric > 0) return numeric;
  const normalized = String(value || "").trim().toLowerCase();
  // Positions created before fee timeframe metadata was persisted used a
  // documented 24h interpretation. Keep that compatibility path intact.
  return FEE_TIMEFRAME_MINUTES[normalized] ?? FEE_TIMEFRAME_MINUTES["24h"];
}

function shadowCooldownForExit(action, managementConfig = {}, position = {}) {
  const strategyProfile = position?.strategy_profile ?? position?.policy_snapshot?.strategyProfile;
  if (strategyProfile === SHADOW_ROTATION_STRATEGY_PROFILE) {
    const catastrophicQuarantineHours = action === "CATASTROPHIC_STOP"
      ? Math.max(24, finite(managementConfig.shadowRotationCatastrophicQuarantineHours) ?? 168)
      : 0;
    const untilRunEnd = managementConfig.shadowRotationCooldownForRun !== false;
    if (catastrophicQuarantineHours > 0 || untilRunEnd) {
      return {
        hours: catastrophicQuarantineHours,
        untilRunEnd,
        scope: "both",
        reason: catastrophicQuarantineHours > 0
          ? `shadow rotation catastrophic quarantine: ${catastrophicQuarantineHours}h`
          : `shadow rotation token already used this epoch: ${String(action || "exit").toLowerCase()}`,
      };
    }
  }
  if (managementConfig.badOutcomeCooldownEnabled === false) return null;
  let hours = 0;
  let untilRunEnd = false;
  if (action === "STOP_LOSS" || action === "CATASTROPHIC_STOP") {
    hours = Math.max(0, finite(managementConfig.stopLossCooldownHours) ?? 12);
    untilRunEnd = managementConfig.shadowStopLossCooldownForRun !== false;
  } else if (action === "LOW_YIELD") {
    hours = Math.max(0, finite(managementConfig.lowYieldCooldownHours) ?? 4);
  } else if (action === "OUT_OF_RANGE") {
    hours = Math.max(
      0,
      finite(managementConfig.shadowOutOfRangeCooldownHours) ??
        finite(managementConfig.oorCooldownHours) ??
        3,
    );
  }
  if (hours <= 0 && !untilRunEnd) return null;
  const configuredScope = String(managementConfig.badOutcomeCooldownScope || "both").trim().toLowerCase();
  const scope = new Set(["pool", "token", "both"]).has(configuredScope) ? configuredScope : "both";
  return {
    hours,
    untilRunEnd,
    scope,
    reason: `shadow bad outcome: ${String(action || "exit").toLowerCase()}`,
  };
}

function exitConfirmationTicks(action, pnlConfig = {}) {
  const generic = confirmationTicks(pnlConfig?.confirmTicks, 2);
  if (action === "CATASTROPHIC_STOP") return 1;
  if (new Set(["TAKE_PROFIT", "PROFIT_PROTECT"]).has(action)) {
    return confirmationTicks(pnlConfig?.profitConfirmTicks, generic);
  }
  if (action === "STOP_LOSS" || action === "THESIS_FAILURE") {
    return confirmationTicks(pnlConfig?.stopConfirmTicks, generic);
  }
  return generic;
}

/**
 * Build a deliberately conservative SOL mark from an active-bin observation.
 *
 * Yield-hold remains a conservative single-side SOL proxy. Shadow rotation may
 * instead use an explicitly paper-only balanced centered proxy: its mark follows
 * a constant-product sqrt(price ratio) approximation while in range, caps upside
 * at the upper boundary once inventory is modeled as fully SOL, and keeps token
 * downside below the lower boundary. Fees are accrued only while in range. The
 * full configured round-trip cost is deducted on every interim mark.
 */
export function buildConservativeShadowValuation(position, observedPosition, managementConfig = {}, nowMs = Date.now()) {
  const principalSol = Math.max(0, finite(position?.amount_sol) ?? 0);
  const entryBin = finite(position?.active_bin_at_deploy);
  const activeBin = finite(observedPosition?.last_active_bin);
  const entryToCurrentBins = entryBin != null && activeBin != null ? activeBin - entryBin : null;
  const strategyProfile = position?.strategy_profile ?? position?.policy_snapshot?.strategyProfile;
  const fundingModel = position?.funding_model ?? position?.policy_snapshot?.fundingModel ?? "single_side_sol";
  const balancedCentered = strategyProfile === SHADOW_ROTATION_STRATEGY_PROFILE &&
    fundingModel === "balanced_shadow_50_50";
  const configuredDownsideBins = positive(
    position?.bin_range?.bins_below ??
      (entryBin != null && finite(position?.bin_range?.min) != null ? entryBin - finite(position.bin_range.min) : null),
    0,
  );
  const enteredDownsideBins = entryToCurrentBins == null ? null : Math.max(0, -entryToCurrentBins);
  let rangeExposurePct = enteredDownsideBins == null || configuredDownsideBins <= 0
    ? 0
    : Math.min(1, enteredDownsideBins / configuredDownsideBins) * 100;
  const priceReturnPct = finite(observedPosition?.price_change_pct);
  const hasTrustedMark = priceReturnPct != null && observedPosition?.price_change_source != null;

  let conservativePriceReturnPct = 0;
  let grossMarkSol = principalSol;
  if (balancedCentered && hasTrustedMark) {
    const binStep = positive(position?.bin_step, 0);
    const minBin = finite(position?.bin_range?.min);
    const maxBin = finite(position?.bin_range?.max);
    const currentRatio = Math.max(0, 1 + priceReturnPct / 100);
    const stepRatio = binStep > 0 ? 1 + binStep / 10_000 : null;
    const lowerRatio = stepRatio != null && entryBin != null && minBin != null
      ? Math.pow(stepRatio, minBin - entryBin)
      : null;
    const upperRatio = stepRatio != null && entryBin != null && maxBin != null
      ? Math.pow(stepRatio, maxBin - entryBin)
      : null;
    let balancedRatio = Math.sqrt(currentRatio);
    if (activeBin != null && maxBin != null && activeBin > maxBin && upperRatio != null) {
      // Above the centered range, the proxy is fully SOL and no longer gains
      // token-price upside. This is deliberately less optimistic than HODL.
      balancedRatio = Math.sqrt(upperRatio);
    } else if (
      activeBin != null && minBin != null && activeBin < minBin &&
      lowerRatio != null && lowerRatio > 0
    ) {
      // Below the centered range, the proxy is fully token and continues to
      // absorb downside rather than freezing the mark at the lower boundary.
      balancedRatio = Math.sqrt(lowerRatio) * (currentRatio / lowerRatio);
    }
    grossMarkSol = Math.max(0, principalSol * balancedRatio);
    conservativePriceReturnPct = principalSol > 0 ? (grossMarkSol / principalSol - 1) * 100 : 0;
    rangeExposurePct = observedPosition?.in_range === true ? 100 : 0;
  } else {
    // A positive move cannot create artificial upside for an initially SOL-only
    // lower-range position. A negative move is applied only to the portion that
    // would have entered the lower range; this is intentionally pessimistic.
    conservativePriceReturnPct = hasTrustedMark && priceReturnPct < 0
      ? priceReturnPct * (rangeExposurePct / 100)
      : 0;
    grossMarkSol = Math.max(0, principalSol * (1 + conservativePriceReturnPct / 100));
  }

  const feeWindowMinutes = feeTimeframeMinutes(position?.fee_timeframe ?? position?.fee_timeframe_minutes);
  const poolFeeTvlPctPerWindow = Math.max(0, finite(position?.fee_tvl_ratio) ?? 0);
  const poolFeeTvlPct24hEquivalent = poolFeeTvlPctPerWindow * (FEE_TIMEFRAME_MINUTES["24h"] / feeWindowMinutes);
  const inRange = observedPosition?.in_range === true;
  const configuredRotationParticipation = strategyProfile === SHADOW_ROTATION_STRATEGY_PROFILE
    ? finite(position?.policy_snapshot?.entryEconomics?.feeParticipationPct)
    : null;
  const minimumFeeParticipation = configuredRotationParticipation != null
    ? Math.max(MIN_IN_RANGE_FEE_PARTICIPATION, Math.min(0.85, configuredRotationParticipation / 100))
    : MIN_IN_RANGE_FEE_PARTICIPATION;
  const feeParticipation = inRange
    ? balancedCentered
      ? minimumFeeParticipation
      : Math.max(minimumFeeParticipation, rangeExposurePct / 100)
    : 0;
  const priorFeeAccrualSol = Math.max(
    0,
    finite(observedPosition?.estimated_fee_accrual_sol ?? position?.estimated_fee_accrual_sol) ?? 0,
  );
  const deployedAtMs = Date.parse(position?.deployed_at || "");
  const lastValuedAtMs = Date.parse(observedPosition?.last_valued_at || position?.last_valued_at || "");
  const accrualStartMs = Number.isFinite(lastValuedAtMs)
    ? lastValuedAtMs
    : Number.isFinite(deployedAtMs)
      ? deployedAtMs
      : nowMs;
  const feeAccrualIntervalMinutes = Math.max(0, (nowMs - accrualStartMs) / 60_000);
  // On a boundary-crossing interval, count no new fees unless both the prior
  // and current marks were in range. This deliberately undercounts transition
  // time while preserving fees already accrued before an OOR observation.
  const hadPriorValuation = Number.isFinite(lastValuedAtMs);
  const eligibleForIncrement = inRange && (!hadPriorValuation || observedPosition?.earning_liquidity === true);
  const estimatedFeeIncrementSol = eligibleForIncrement
    ? principalSol * (poolFeeTvlPctPerWindow / 100) *
      (feeAccrualIntervalMinutes / feeWindowMinutes) * feeParticipation * FEE_ACCRUAL_HAIRCUT
    : 0;
  const estimatedFeeAccrualSol = priorFeeAccrualSol + estimatedFeeIncrementSol;

  const roundTripCostPct = Math.max(0, finite(managementConfig?.estimatedRoundTripCostPct) ?? 1);
  const estimatedRoundTripCostSol = principalSol * roundTripCostPct / 100;
  const estimatedEntryCostSol = estimatedRoundTripCostSol * ENTRY_COST_SHARE;
  const estimatedExitCostSol = estimatedRoundTripCostSol * EXIT_COST_SHARE;
  const equityNetSol = Math.max(0, grossMarkSol + estimatedFeeAccrualSol - estimatedRoundTripCostSol);
  const projectedNetPnlSol = equityNetSol - principalSol;
  const projectedNetPnlPct = principalSol > 0 ? projectedNetPnlSol / principalSol * 100 : 0;

  return {
    strategy_profile: strategyProfile || null,
    valuation_model: balancedCentered
      ? "balanced_centered_dlmm_proxy"
      : "conservative_single_side_sol_proxy",
    valuation_version: balancedCentered
      ? "shadow-micro-rotation-v2"
      : strategyProfile === SHADOW_ROTATION_STRATEGY_PROFILE
        ? "shadow-rotation-v1"
        : "shadow-v2",
    price_return_pct: round(priceReturnPct, 6),
    conservative_price_return_pct: round(conservativePriceReturnPct, 6),
    range_exposure_pct: round(rangeExposurePct, 6),
    fee_accrual_haircut_pct: FEE_ACCRUAL_HAIRCUT * 100,
    fee_participation_pct: round(feeParticipation * 100, 6),
    fee_timeframe_minutes: round(feeWindowMinutes, 6),
    fee_tvl_ratio_24h_equivalent_pct: round(poolFeeTvlPct24hEquivalent, 6),
    fee_accrual_interval_minutes: round(feeAccrualIntervalMinutes, 6),
    estimated_fee_increment_sol: round(estimatedFeeIncrementSol),
    gross_mark_sol: round(grossMarkSol),
    estimated_fee_accrual_sol: round(estimatedFeeAccrualSol),
    estimated_entry_cost_sol: round(estimatedEntryCostSol),
    estimated_exit_cost_sol: round(estimatedExitCostSol),
    estimated_round_trip_cost_sol: round(estimatedRoundTripCostSol),
    equity_net_sol: round(equityNetSol),
    projected_net_pnl_sol: round(projectedNetPnlSol),
    projected_net_pnl_pct: round(projectedNetPnlPct, 6),
    earning_liquidity: inRange,
    last_valued_at: new Date(nowMs).toISOString(),
    pnl_basis_valid: hasTrustedMark,
  };
}

function paperExitData(position, observedPosition, valuation, feeWindow, nowMs) {
  return {
    active_bin: observedPosition.last_active_bin,
    lower_bin: position.bin_range?.min,
    upper_bin: position.bin_range?.max,
    in_range: observedPosition.in_range,
    age_minutes: ageMinutes(position.deployed_at, nowMs),
    fee_per_tvl_24h: valuation.fee_tvl_ratio_24h_equivalent_pct,
    current_fee_tvl_ratio: feeWindow?.current_fee_tvl_ratio ?? null,
    current_fee_timeframe: feeWindow?.current_fee_timeframe ?? null,
    current_fee_observed_at: feeWindow?.current_fee_observed_at ?? null,
    unclaimed_fees_usd: valuation.estimated_fee_accrual_sol,
    collected_fees_usd: 0,
    earning_liquidity: valuation.earning_liquidity,
    pnl_pct: valuation.projected_net_pnl_pct,
    projected_net_pnl_pct: valuation.projected_net_pnl_pct,
    projected_net_pnl_sol: valuation.projected_net_pnl_sol,
    pnl_basis_valid: valuation.pnl_basis_valid,
    pnl_pct_suspicious: !valuation.pnl_basis_valid,
  };
}

function formatResultLine(position, valuation, exit, confirmation, settled) {
  const pnl = Number(valuation.projected_net_pnl_pct ?? 0).toFixed(2);
  const equity = Number(valuation.equity_net_sol ?? 0).toFixed(6);
  if (settled) return `${position.pool_name || position.pool}: settled ${exit.action} at ◎${equity} (${pnl}%)`;
  if (exit) return `${position.pool_name || position.pool}: ${exit.action} confirmation ${confirmation.count}/${confirmation.requiredTicks} at ◎${equity} (${pnl}%)`;
  return `${position.pool_name || position.pool}: observed ◎${equity} (${pnl}%)`;
}

/**
 * Observe, value, confirm exits, and settle every open paper position once.
 * `getActiveBin` is intentionally injected and must be read-only. No execution
 * dependency is accepted by this API.
 */
export async function runShadowLifecycleCycle({
  getActiveBin,
  getFeeWindow = null,
  managementConfig = {},
  pnlConfig = {},
  nowMs = Date.now(),
  state = {},
} = {}) {
  if (typeof getActiveBin !== "function") {
    throw new Error("runShadowLifecycleCycle requires an injected read-only getActiveBin dependency");
  }
  const cycleNowMs = finite(nowMs) ?? Date.now();

  const deps = {
    getOpenPaperPositions,
    updatePaperPositionObservation,
    updatePaperPositionValuation,
    confirmPaperPeak,
    evaluatePaperPositionExit,
    registerPaperExitSignal,
    settlePaperPosition,
    recordPaperObservationFailure,
    getPaperLifecycleMetrics,
    ...state,
  };
  const positions = deps.getOpenPaperPositions();
  const records = [];
  const startedOpenPositions = positions.length;
  const startedDeployedAmountSol = positions.reduce((total, position) => (
    total + Math.max(0, finite(position?.amount_sol) ?? 0)
  ), 0);
  // Net policy internally uses SOL fields for fee floor/settlement arithmetic.
  const shadowManagementConfig = { ...managementConfig, solMode: true };

  for (const position of positions) {
    try {
      const active = await getActiveBin({ pool_address: position.pool });
      const activeBin = binFromObservation(active);
      if (activeBin == null) throw new Error("active-bin read returned no finite binId");

      const observation = {
        active_bin: activeBin,
        active_price: priceFromObservation(active),
      };
      const observedPosition = deps.updatePaperPositionObservation(position.position, observation, cycleNowMs);
      if (!observedPosition) throw new Error("paper position disappeared before observation could be recorded");

      const valuation = buildConservativeShadowValuation(position, observedPosition, shadowManagementConfig, cycleNowMs);
      const valuedPosition = deps.updatePaperPositionValuation(position.position, valuation, cycleNowMs);
      if (!valuedPosition) throw new Error("paper position disappeared before valuation could be recorded");

      const positionAgeMinutes = ageMinutes(position.deployed_at, cycleNowMs);
      const thesisReviewMinutes = Math.max(1, finite(shadowManagementConfig.thesisReviewMinutes) ?? 20);
      let feeWindow = null;
      if (
        typeof getFeeWindow === "function" &&
        (positionAgeMinutes == null || positionAgeMinutes >= thesisReviewMinutes)
      ) {
        try {
          feeWindow = await getFeeWindow({
            pool_address: position.pool,
            timeframe: position.fee_timeframe,
            nowMs: cycleNowMs,
          });
        } catch {
          feeWindow = null;
        }
      }

      if (valuation.pnl_basis_valid) {
        deps.confirmPaperPeak(position.position, valuation.projected_net_pnl_pct, pnlConfig?.confirmTicks, cycleNowMs);
      }
      const exit = deps.evaluatePaperPositionExit(
        position.position,
        paperExitData(valuedPosition, observedPosition, valuation, feeWindow, cycleNowMs),
        shadowManagementConfig,
        cycleNowMs,
      );
      const requiredTicks = exit ? exitConfirmationTicks(exit.action, pnlConfig) : 0;
      const confirmation = deps.registerPaperExitSignal(
        position.position,
        exit?.action || null,
        requiredTicks || confirmationTicks(pnlConfig?.confirmTicks),
        cycleNowMs,
        exit?.confirmation_key ?? null,
      );
      const settled = exit && confirmation.fire
        ? deps.settlePaperPosition(position.position, {
            action: exit.action,
            reason: exit.reason,
            valuation,
            observation,
            cooldown: shadowCooldownForExit(exit.action, shadowManagementConfig, valuedPosition),
          }, cycleNowMs)
        : null;

      records.push({
        position: position.position,
        pool: position.pool,
        status: settled ? "settled" : "observed",
        valuation,
        exit: exit || null,
        confirmation: exit ? { ...confirmation, requiredTicks } : null,
        settlement: settled?.settlement || null,
        line: formatResultLine(position, valuation, exit, { ...confirmation, requiredTicks }, settled),
      });
    } catch (error) {
      deps.recordPaperObservationFailure(position.position, error.message, cycleNowMs);
      records.push({
        position: position.position,
        pool: position.pool,
        status: "observation_failed",
        error: error.message,
        line: `${position.pool_name || position.pool}: observation failed (${error.message})`,
      });
    }
  }

  const metrics = deps.getPaperLifecycleMetrics();
  return {
    success: true,
    observed: records.filter((record) => record.status === "observed").length,
    settled: records.filter((record) => record.status === "settled").length,
    failed: records.filter((record) => record.status === "observation_failed").length,
    started_open_positions: startedOpenPositions,
    started_deployed_amount_sol: round(startedDeployedAmountSol),
    open_positions: metrics.open_positions,
    metrics,
    records,
    report: records.map((record) => record.line).join("\n"),
  };
}
