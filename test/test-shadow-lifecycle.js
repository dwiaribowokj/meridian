import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-shadow-lifecycle-"));
process.chdir(tmp);
fs.mkdirSync("logs", { recursive: true });
process.env.MERIDIAN_STATE_FILE = path.join(tmp, "state.json");

const {
  SHADOW_ROLLOUT_ARCHIVE_CONFIRMATION,
  archiveShadowRolloutRun,
  getOpenPaperPositions,
  getPaperLifecycleMetrics,
  getPaperPosition,
  getShadowRolloutEvidenceSnapshot,
  isShadowBaseMintOnCooldown,
  isShadowPoolOnCooldown,
  trackPaperPosition,
} = await import("../state.js");
const { buildConservativeShadowValuation, runShadowLifecycleCycle } = await import("../shadow-lifecycle.js");

const managementConfig = {
  netExitPolicyEnabled: true,
  estimatedRoundTripCostPct: 1,
  minNetProfitPct: 0.25,
  minNetProfitSol: 0.0005,
  catastrophicStopPct: -5,
  stopLossPct: -0.5,
  takeProfitPct: 2,
  profitProtectTriggerPct: 5,
  profitProtectRetracePctPoints: 1,
  minFeePerTvl24h: 1,
  minAgeBeforeYieldCheck: 9999,
  maxHoldMinutes: 9999,
};
const pnlConfig = { confirmTicks: 2, profitConfirmTicks: 2, stopConfirmTicks: 2 };
const testEpoch = Date.UTC(2026, 0, 1, 0, 0, 0);
const resetPaperState = () => fs.rmSync(process.env.MERIDIAN_STATE_FILE, { force: true });

assert.equal(getShadowRolloutEvidenceSnapshot(), null, "idle management has no rollout run or empty heartbeat source");

const activeBinCalls = [];
const getActiveBin = async ({ pool_address }) => {
  activeBinCalls.push(pool_address);
  return { binId: 100, price: 10 };
};

for (let index = 0; index < 5; index += 1) {
  const deployedAt = testEpoch + index * 10 * 60_000;
  const paperPosition = trackPaperPosition({
    pool: `paper-pool-${index}`,
    pool_name: `PAPER-${index}/SOL`,
    strategy: "bid_ask",
    bin_range: { min: 95, max: 100, bins_below: 5, bins_above: 0 },
    amount_sol: 0.1,
    active_bin: 100,
    bin_step: 100,
    fee_tvl_ratio: 0,
    active_price: 10,
    min_price: 9.5,
    max_price: 10,
    nowMs: deployedAt,
  });

  const first = await runShadowLifecycleCycle({
    getActiveBin,
    managementConfig,
    pnlConfig,
    nowMs: deployedAt + 60_000,
  });
  assert.equal(first.settled, 0, "first stop signal must only begin confirmation");
  assert.equal(first.records[0].exit?.action, "STOP_LOSS");
  assert.equal(first.records[0].confirmation?.count, 1);
  assert.equal(getOpenPaperPositions().length, 1, "unconfirmed paper exit must retain the capacity slot");

  const second = await runShadowLifecycleCycle({
    getActiveBin,
    managementConfig,
    pnlConfig,
    nowMs: deployedAt + 120_000,
  });
  assert.equal(second.settled, 1, "second identical signal must settle locally");

  const settled = getPaperPosition(paperPosition);
  assert.equal(settled.closed, true);
  assert.equal(settled.lifecycle_status, "SETTLED");
  assert.equal(settled.terminal_state, "CLOSED_SETTLED");
  assert.equal(settled.close_action, "STOP_LOSS");
  assert.equal(settled.settlement.initial_principal_sol, 0.1);
  assert.equal(settled.settlement.estimated_round_trip_cost_sol, 0.001);
  assert.equal(settled.settlement.final_equity_sol, 0.099);
  assert.equal(settled.settlement.duration_minutes, 2, "settlement duration must use the injected lifecycle clock");
  assert.equal(settled.settled_at, new Date(deployedAt + 120_000).toISOString());
  assert.equal(settled.reconciliation.simulated, true);
  assert.equal(settled.reconciliation.verified, true);
  assert.equal(settled.cleanup.simulated, true);
  assert.equal(settled.cleanup.verified, true);
  assert.equal(settled.cleanup.no_wallet_or_transactions, true);
  assert.equal(getOpenPaperPositions().length, 0, "settled paper lifecycle must release capacity");
}

const metrics = getPaperLifecycleMetrics();
assert.equal(metrics.completed_lifecycles, 5);
assert.equal(metrics.settled_lifecycles, 5);
assert.equal(metrics.open_positions, 0);
assert.equal(metrics.losses, 5);
assert.equal(metrics.total_estimated_cost_sol, 0.005);
assert.equal(activeBinCalls.length, 10, "only injected read-only active-bin observations may occur");
assert.ok(activeBinCalls.every((pool) => pool.startsWith("paper-pool-")));

const persisted = JSON.parse(fs.readFileSync(process.env.MERIDIAN_STATE_FILE, "utf8"));
assert.equal(persisted.paperLifecycleMetrics.completed_lifecycles, 5);
assert.equal(Object.values(persisted.paperPositions).every((position) => position.terminal_state === "CLOSED_SETTLED"), true);
const evidenceSnapshot = getShadowRolloutEvidenceSnapshot(testEpoch + 60 * 60_000);
assert.ok(evidenceSnapshot.run_id.startsWith("shadow:"));
assert.equal(evidenceSnapshot.lifecycles.length, 5);
assert.equal(evidenceSnapshot.lifecycles.every((position) => position.run_id === evidenceSnapshot.run_id), true);
assert.equal(evidenceSnapshot.lifecycles[0].last_observation.price_change_source, "bin_step");
assert.equal(evidenceSnapshot.lifecycles[0].last_observation.price_normalization_source, "reported_price");
assert.equal(evidenceSnapshot.lifecycles[0].valuation.version, "shadow-v2");
assert.equal(evidenceSnapshot.lifecycles[0].valuation.fee_timeframe_minutes, 1440);
assert.equal(evidenceSnapshot.lifecycles[0].valuation.fee_accrual_interval_minutes, 1);
assert.equal(evidenceSnapshot.lifecycles[0].valuation.range_exposure_pct, 0);

resetPaperState();

const failureStart = testEpoch + 24 * 60 * 60_000;
const failurePosition = trackPaperPosition({
  pool: "failure-gap-pool",
  pool_name: "FAILURE-GAP/SOL",
  strategy: "bid_ask",
  bin_range: { min: 95, max: 100, bins_below: 5, bins_above: 0 },
  amount_sol: 0.1,
  active_bin: 100,
  fee_tvl_ratio: 10,
  active_price: 10,
  min_price: 9.5,
  max_price: 10,
  nowMs: failureStart,
});
let failureReads = 0;
const getFailureGapBin = async () => {
  failureReads += 1;
  if (failureReads === 2) throw new Error("temporary active-bin read failure");
  return { binId: 95, price: 10 };
};

const firstFailureGap = await runShadowLifecycleCycle({
  getActiveBin: getFailureGapBin,
  managementConfig,
  pnlConfig,
  nowMs: failureStart + 24 * 60 * 60_000,
});
assert.equal(firstFailureGap.settled, 0);
assert.equal(firstFailureGap.records[0].exit?.action, "TAKE_PROFIT");
assert.equal(firstFailureGap.records[0].confirmation?.count, 1);
assert.equal(getPaperPosition(failurePosition).pending_peak_confirm_count, 1);

const failedGap = await runShadowLifecycleCycle({
  getActiveBin: getFailureGapBin,
  managementConfig,
  pnlConfig,
  nowMs: failureStart + 24 * 60 * 60_000 + 60_000,
});
assert.equal(failedGap.failed, 1);
let failureState = getPaperPosition(failurePosition);
assert.equal(failureState.pending_exit_action, null);
assert.equal(failureState.pending_exit_count, 0);
assert.equal(failureState.pending_peak_pnl_pct, null);
assert.equal(failureState.pending_peak_confirm_count, 0);
assert.equal(failureState.last_observation_error_at, new Date(failureStart + 24 * 60 * 60_000 + 60_000).toISOString());

const resumedGap = await runShadowLifecycleCycle({
  getActiveBin: getFailureGapBin,
  managementConfig,
  pnlConfig,
  nowMs: failureStart + 24 * 60 * 60_000 + 2 * 60_000,
});
assert.equal(resumedGap.settled, 0, "signals separated by a failed observation must not count as consecutive");
assert.equal(resumedGap.records[0].exit?.action, "TAKE_PROFIT");
assert.equal(resumedGap.records[0].confirmation?.count, 1);
failureState = getPaperPosition(failurePosition);
assert.notEqual(failureState.closed, true);
assert.equal(failureState.pending_peak_confirm_count, 1);

resetPaperState();

const oorStart = testEpoch + 2 * 24 * 60 * 60_000;
const oorPosition = trackPaperPosition({
  pool: "oor-clock-pool",
  pool_name: "OOR-CLOCK/SOL",
  strategy: "bid_ask",
  bin_range: { min: 95, max: 100, bins_below: 5, bins_above: 0 },
  amount_sol: 0.1,
  active_bin: 100,
  fee_tvl_ratio: 0,
  active_price: 10,
  min_price: 9.5,
  max_price: 10,
  nowMs: oorStart,
});
const timingManagementConfig = {
  ...managementConfig,
  catastrophicStopPct: -99,
  stopLossPct: -99,
  minAgeBeforeYieldCheck: 9999,
  outOfRangeWaitMinutes: 20,
  outOfRangeBinsToClose: 10,
};
let outOfRangeBin = 94;
const getOutOfRangeBin = async () => ({ binId: outOfRangeBin, price: 10 });

const initialOor = await runShadowLifecycleCycle({
  getActiveBin: getOutOfRangeBin,
  managementConfig: timingManagementConfig,
  pnlConfig,
  nowMs: oorStart,
});
assert.equal(initialOor.records[0].exit, null);
assert.equal(getPaperPosition(oorPosition).out_of_range_since, new Date(oorStart).toISOString());

const beforeOorBoundary = await runShadowLifecycleCycle({
  getActiveBin: getOutOfRangeBin,
  managementConfig: timingManagementConfig,
  pnlConfig,
  nowMs: oorStart + 19 * 60_000,
});
assert.equal(beforeOorBoundary.records[0].exit, null);

const atOorBoundary = await runShadowLifecycleCycle({
  getActiveBin: getOutOfRangeBin,
  managementConfig: timingManagementConfig,
  pnlConfig,
  nowMs: oorStart + 20 * 60_000,
});
assert.equal(atOorBoundary.records[0].exit, null, "a shallow one-bin breach must not ignore outOfRangeBinsToClose");

outOfRangeBin = 85;
const atOorDepthAndTimeBoundary = await runShadowLifecycleCycle({
  getActiveBin: getOutOfRangeBin,
  managementConfig: timingManagementConfig,
  pnlConfig,
  nowMs: oorStart + 20 * 60_000,
});
assert.equal(atOorDepthAndTimeBoundary.records[0].exit?.action, "OUT_OF_RANGE");

resetPaperState();

const lowYieldStart = testEpoch + 3 * 24 * 60 * 60_000;
const lowYieldPosition = trackPaperPosition({
  pool: "low-yield-clock-pool",
  pool_name: "LOW-YIELD-CLOCK/SOL",
  strategy: "bid_ask",
  bin_range: { min: 95, max: 100, bins_below: 5, bins_above: 0 },
  amount_sol: 0.1,
  active_bin: 100,
  fee_tvl_ratio: 0,
  active_price: 10,
  min_price: 9.5,
  max_price: 10,
  nowMs: lowYieldStart,
});
const lowYieldManagementConfig = {
  ...timingManagementConfig,
  minAgeBeforeYieldCheck: 0,
  minFeePerTvl24h: 1,
  lowYieldSampleSpacingMinutes: 5,
  lowYieldConfirmSamples: 2,
};
const getInRangeBin = async () => ({ binId: 100, price: 10 });

const firstLowYield = await runShadowLifecycleCycle({
  getActiveBin: getInRangeBin,
  managementConfig: lowYieldManagementConfig,
  pnlConfig,
  nowMs: lowYieldStart,
});
assert.equal(firstLowYield.records[0].exit, null);
assert.equal(getPaperPosition(lowYieldPosition).low_yield_confirm_count, 1);
assert.equal(getPaperPosition(lowYieldPosition).low_yield_last_sample_at, new Date(lowYieldStart).toISOString());

const beforeLowYieldSpacing = await runShadowLifecycleCycle({
  getActiveBin: getInRangeBin,
  managementConfig: lowYieldManagementConfig,
  pnlConfig,
  nowMs: lowYieldStart + 4 * 60_000,
});
assert.equal(beforeLowYieldSpacing.records[0].exit, null);
assert.equal(getPaperPosition(lowYieldPosition).low_yield_confirm_count, 1);

const atLowYieldSpacing = await runShadowLifecycleCycle({
  getActiveBin: getInRangeBin,
  managementConfig: lowYieldManagementConfig,
  pnlConfig,
  nowMs: lowYieldStart + 5 * 60_000,
});
assert.equal(atLowYieldSpacing.records[0].exit?.action, "LOW_YIELD");
assert.equal(getPaperPosition(lowYieldPosition).low_yield_confirm_count, 2);
assert.equal(getPaperPosition(lowYieldPosition).low_yield_last_sample_at, new Date(lowYieldStart + 5 * 60_000).toISOString());

resetPaperState();

const invalidConfirmationStart = testEpoch + 4 * 24 * 60 * 60_000;
trackPaperPosition({
  pool: "invalid-confirmation-pool",
  pool_name: "INVALID-CONFIRMATION/SOL",
  strategy: "bid_ask",
  bin_range: { min: 95, max: 100, bins_below: 5, bins_above: 0 },
  amount_sol: 0.1,
  active_bin: 100,
  fee_tvl_ratio: 10,
  active_price: 10,
  min_price: 9.5,
  max_price: 10,
  nowMs: invalidConfirmationStart,
});
const invalidConfirmationConfig = { confirmTicks: Number.NaN, profitConfirmTicks: 0, stopConfirmTicks: -1 };
const getProfitableBin = async () => ({ binId: 95, price: 10 });

const firstInvalidConfirmation = await runShadowLifecycleCycle({
  getActiveBin: getProfitableBin,
  managementConfig,
  pnlConfig: invalidConfirmationConfig,
  nowMs: invalidConfirmationStart + 24 * 60 * 60_000,
});
assert.equal(firstInvalidConfirmation.settled, 0, "invalid confirmation values must retain the safe two-tick default");
assert.equal(firstInvalidConfirmation.records[0].confirmation?.requiredTicks, 2);
assert.equal(firstInvalidConfirmation.records[0].confirmation?.count, 1);
const invalidConfirmationPosition = getOpenPaperPositions()[0];
assert.equal(invalidConfirmationPosition.peak_pnl_pct, 0);
assert.equal(invalidConfirmationPosition.pending_peak_confirm_count, 1);

const secondInvalidConfirmation = await runShadowLifecycleCycle({
  getActiveBin: getProfitableBin,
  managementConfig,
  pnlConfig: invalidConfirmationConfig,
  nowMs: invalidConfirmationStart + 24 * 60 * 60_000 + 60_000,
});
assert.equal(secondInvalidConfirmation.settled, 1);

// A screening-window fee ratio must accrue against that window, while legacy
// positions without metadata retain their historical 24h interpretation.
const feeBasePosition = {
  amount_sol: 0.1,
  deployed_at: new Date(testEpoch).toISOString(),
  active_bin_at_deploy: 100,
  bin_range: { min: 95, max: 100, bins_below: 5, bins_above: 0 },
  fee_tvl_ratio: 10,
};
const feeObservation = {
  last_active_bin: 95,
  price_change_pct: 0,
  price_change_source: "bin_step",
  in_range: true,
};
const legacyDailyFee = buildConservativeShadowValuation(
  feeBasePosition,
  feeObservation,
  { estimatedRoundTripCostPct: 0 },
  testEpoch + 30 * 60_000,
);
const windowFee = buildConservativeShadowValuation(
  { ...feeBasePosition, fee_timeframe: "30m" },
  feeObservation,
  { estimatedRoundTripCostPct: 0 },
  testEpoch + 30 * 60_000,
);
assert.equal(windowFee.fee_timeframe_minutes, 30);
assert.equal(windowFee.fee_tvl_ratio_24h_equivalent_pct, 480);
assert.ok(Math.abs(windowFee.estimated_fee_accrual_sol / legacyDailyFee.estimated_fee_accrual_sol - 48) < 0.001);

const preservedFee = buildConservativeShadowValuation(
  { ...feeBasePosition, fee_timeframe: "30m" },
  {
    ...feeObservation,
    ...windowFee,
    last_active_bin: 101,
    in_range: false,
  },
  { estimatedRoundTripCostPct: 0 },
  testEpoch + 60 * 60_000,
);
assert.equal(
  preservedFee.estimated_fee_accrual_sol,
  windowFee.estimated_fee_accrual_sol,
  "an OOR mark must preserve fees accrued during prior in-range intervals",
);

resetPaperState();
const cooldownStart = testEpoch + 5 * 24 * 60 * 60_000;
trackPaperPosition({
  pool: "cooldown-pool",
  pool_name: "COOLDOWN/SOL",
  base_mint: "cooldown-mint",
  strategy: "bid_ask",
  bin_range: { min: 95, max: 100, bins_below: 5, bins_above: 0 },
  amount_sol: 0.1,
  active_bin: 100,
  fee_tvl_ratio: 0,
  fee_timeframe: "30m",
  active_price: 10,
  min_price: 9.5,
  max_price: 10,
  nowMs: cooldownStart,
});
await runShadowLifecycleCycle({
  getActiveBin,
  managementConfig: {
    ...managementConfig,
    stopLossCooldownHours: 12,
    shadowStopLossCooldownForRun: true,
    badOutcomeCooldownScope: "both",
  },
  pnlConfig,
  nowMs: cooldownStart + 60_000,
});
await runShadowLifecycleCycle({
  getActiveBin,
  managementConfig: {
    ...managementConfig,
    stopLossCooldownHours: 12,
    shadowStopLossCooldownForRun: true,
    badOutcomeCooldownScope: "both",
  },
  pnlConfig,
  nowMs: cooldownStart + 120_000,
});
assert.equal(isShadowPoolOnCooldown("cooldown-pool", cooldownStart + 120_000), true);
assert.equal(isShadowBaseMintOnCooldown("cooldown-mint", cooldownStart + 120_000), true);
assert.equal(
  isShadowPoolOnCooldown("cooldown-pool", cooldownStart + 12 * 60 * 60_000 + 120_001),
  true,
  "stop-loss pool remains blocked for the rest of the shadow evidence epoch",
);
const cooldownRunId = getShadowRolloutEvidenceSnapshot().run_id;
const archivedCooldownRun = archiveShadowRolloutRun({
  expectedRunId: cooldownRunId,
  reason: "test completed run-bound stop-loss cooldown",
  confirmation: SHADOW_ROLLOUT_ARCHIVE_CONFIRMATION,
}, cooldownStart + 13 * 60 * 60_000);
assert.equal(archivedCooldownRun.archived, true);
assert.equal(isShadowPoolOnCooldown("cooldown-pool", cooldownStart + 13 * 60 * 60_000 + 1), false);
assert.equal(isShadowBaseMintOnCooldown("cooldown-mint", cooldownStart + 13 * 60 * 60_000 + 1), false);

console.log("shadow lifecycle tests passed (timeframe fees, fee preservation, run-bound cooldowns, local settlement, and safe confirmations)");
