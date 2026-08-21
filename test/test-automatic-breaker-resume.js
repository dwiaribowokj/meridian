import assert from "node:assert/strict";
import {
  AUTOMATIC_CIRCUIT_BREAKER_RECOVERY_SOURCE,
  AUTOMATIC_CIRCUIT_BREAKER_RESUME_ELIGIBLE_REASONS,
  applyCircuitBreakerEvent,
  circuitBreakerRecoveryId,
  createCircuitBreakerState,
} from "../circuit-breaker.js";
import { attemptAutomaticCircuitBreakerResume } from "../automatic-breaker-resume.js";

const TRIP_AT = Date.parse("2026-08-13T07:54:50.000Z");
const SETTLED_AT = Date.parse("2026-08-13T07:55:19.000Z");
const RESUME_AT = Date.parse("2026-08-13T07:57:00.000Z");
const lifecycleId = "lp:Position111";
const settlementId = "cleanup:settlement-111";
const settlementEventId = `settlement:${lifecycleId}:${settlementId}:trade_settled`;

function trippedAfterSettlement() {
  let state = createCircuitBreakerState(TRIP_AT - 1);
  state = applyCircuitBreakerEvent(state, {
    type: "trade_settled",
    eventId: settlementEventId,
    deployedSol: 0.2,
    netProfitSol: -0.0001,
    atMs: SETTLED_AT,
  });
  state = applyCircuitBreakerEvent(state, {
    type: "profit_exit",
    eventId: `${settlementEventId}:profit-exit`,
    deployedSol: 0.2,
    netProfitSol: -0.0001,
    atMs: SETTLED_AT,
  });
  state.canaryPeakEquitySol = 1;
  state.canaryCurrentEquitySol = 0.9;
  return state;
}

function settledLifecycle(overrides = {}) {
  return {
    lifecycle_id: lifecycleId,
    position_address: "Position111",
    state: "SETTLED",
    reconciliation_latched: false,
    cost_basis: { ready: true },
    settlement: {
      event_id: "settlement-ledger-event-111",
      outcome_state: "SETTLED",
      reconciled: true,
      // A reconciled retained residue is not an open lifecycle and must not
      // make a dedicated trading wallet permanently require Telegram recovery.
      residual_token_value_lamports: "123",
      metadata: { reconciliation_id: settlementId },
    },
    ...overrides,
  };
}

function dependencies({
  state = trippedAfterSettlement(),
  lifecycles = [settledLifecycle()],
  atMs = RESUME_AT,
  cooldownMs = 60_000,
} = {}) {
  let current = structuredClone(state);
  const events = [];
  const audits = [];
  return {
    events,
    audits,
    current: () => current,
    input: {
      enabled: true,
      dryRun: false,
      effectiveRolloutMode: "canary",
      livePositions: { source: "rpc", total_positions: 0, positions: [] },
      getTrackedPositions: () => [],
      getCircuitBreakerState: async () => structuredClone(current),
      recordCircuitBreakerEvent: async (event) => {
        events.push(event);
        current = applyCircuitBreakerEvent(current, event);
        return structuredClone(current);
      },
      getTradeLedger: () => ({ listLifecycles: () => lifecycles }),
      listPendingCleanupLifecycles: () => [],
      getLiveCanaryDeployGuardStatus: () => ({ held: false }),
      appendAudit: (event) => audits.push(event),
      cooldownMs,
      atMs,
    },
  };
}

const successful = dependencies();
const expectedRecoveryId = circuitBreakerRecoveryId(successful.current());
const resumed = await attemptAutomaticCircuitBreakerResume(successful.input);
assert.equal(resumed.resumed, true);
assert.equal(resumed.recovery_id, expectedRecoveryId);
assert.deepEqual(resumed.prior_reasons, ["PROFIT_EXIT_BELOW_GLOBAL_FLOOR"]);
assert.equal(successful.current().tripped, false);
assert.equal(successful.current().manualResumeRequired, false);
assert.equal(successful.current().resumeSource, AUTOMATIC_CIRCUIT_BREAKER_RECOVERY_SOURCE);
assert.equal(successful.current().resumeSettlementEventId, null);
assert.equal(successful.current().consecutiveNetLosses, 0);
assert.deepEqual(successful.current().rollingLosses, []);
assert.equal(successful.current().canaryPeakEquitySol, 0.9);
assert.equal(successful.current().canaryCurrentEquitySol, 0.9);
assert.equal(successful.audits.length, 1);
assert.equal(successful.events[0].type, "automatic_recovery_resume");

// Every known economic/operational latch can start a fresh epoch once the
// authoritative zero-exposure proof is clean. Mixed recoverable reasons are
// handled together so the user never has to clear a second token-bound latch.
for (const reasons of [
  ...AUTOMATIC_CIRCUIT_BREAKER_RESUME_ELIGIBLE_REASONS.map((reason) => [reason]),
  ["CONSECUTIVE_NET_LOSSES", "ROLLING_24H_LOSS_LIMIT"],
]) {
  const state = trippedAfterSettlement();
  state.reasons = reasons;
  const lane = dependencies({ state });
  const result = await attemptAutomaticCircuitBreakerResume(lane.input);
  assert.equal(result.resumed, true, reasons.join(", "));
  assert.deepEqual(result.prior_reasons, reasons);
}

// Operational recovery does not depend on a newer settlement: a fresh RPC,
// ledger, cleanup, and deploy-guard probe is itself the recovery evidence.
let operationalOnly = createCircuitBreakerState(TRIP_AT);
operationalOnly = applyCircuitBreakerEvent(operationalOnly, {
  type: "operation_failure",
  operation: "transaction",
  atMs: TRIP_AT,
});
operationalOnly = applyCircuitBreakerEvent(operationalOnly, {
  type: "operation_failure",
  operation: "transaction",
  atMs: TRIP_AT + 1,
});
assert.equal(operationalOnly.lastSettledTradeEventId, null);
const operationalLane = dependencies({ state: operationalOnly, lifecycles: [] });
assert.equal((await attemptAutomaticCircuitBreakerResume(operationalLane.input)).resumed, true);

const coolingDown = dependencies({
  atMs: trippedAfterSettlement().trippedAtMs + 59_999,
  cooldownMs: 60_000,
});
const cooldownResult = await attemptAutomaticCircuitBreakerResume(coolingDown.input);
assert.equal(cooldownResult.resumed, false);
assert.equal(cooldownResult.blocked, "AUTOMATIC_RESUME_COOLDOWN");
assert.equal(cooldownResult.retry_after_ms, 1);
assert.equal(coolingDown.events.length, 0);

// Re-delivery after a successful recovery is a no-op because the breaker is
// already ready and the deterministic event id is retained in processed ids.
const repeated = await attemptAutomaticCircuitBreakerResume(successful.input);
assert.equal(repeated.resumed, false);
assert.equal(repeated.blocked, "BREAKER_ALREADY_READY");
assert.equal(successful.events.length, 1);

// The reducer itself rejects a forged recovery identity or source.
const forgedState = trippedAfterSettlement();
const directRejected = applyCircuitBreakerEvent(forgedState, {
  type: "automatic_recovery_resume",
  eventId: "automatic-recovery:forged",
  recoveryId: "trip:forged",
  source: AUTOMATIC_CIRCUIT_BREAKER_RECOVERY_SOURCE,
  atMs: RESUME_AT,
});
assert.equal(directRejected.tripped, true);

const wrongSource = applyCircuitBreakerEvent(forgedState, {
  type: "automatic_recovery_resume",
  eventId: `automatic-recovery:${circuitBreakerRecoveryId(forgedState)}`,
  recoveryId: circuitBreakerRecoveryId(forgedState),
  source: "manual",
  atMs: RESUME_AT,
});
assert.equal(wrongSource.tripped, true);

const integrityState = trippedAfterSettlement();
integrityState.reasons = ["LIFECYCLE_DUPLICATE"];
const integrityDirectRejected = applyCircuitBreakerEvent(integrityState, {
  type: "automatic_recovery_resume",
  eventId: `automatic-recovery:${circuitBreakerRecoveryId(integrityState)}`,
  recoveryId: circuitBreakerRecoveryId(integrityState),
  source: AUTOMATIC_CIRCUIT_BREAKER_RECOVERY_SOURCE,
  atMs: RESUME_AT,
});
assert.equal(integrityDirectRejected.tripped, true);
assert.deepEqual(integrityDirectRejected.reasons, ["LIFECYCLE_DUPLICATE"]);

for (const [name, mutate, expected] of [
  ["non-RPC zero", (input) => { input.livePositions.source = "meteora"; }, "AUTHORITATIVE_ZERO_POSITIONS_REQUIRED"],
  ["tracked position", (input) => { input.getTrackedPositions = () => [{ position: "open" }]; }, "TRACKED_POSITION_STILL_OPEN"],
  ["cleanup pending", (input) => { input.listPendingCleanupLifecycles = () => [{ position: "pending" }]; }, "CLEANUP_PENDING"],
  ["reconciliation latch", (input) => {
    input.getTradeLedger = () => ({ listLifecycles: () => [settledLifecycle({ state: "RECONCILIATION_REQUIRED", reconciliation_latched: true })] });
  }, "LIFECYCLE_RECONCILIATION_PENDING"],
  ["retained guard", (input) => { input.getLiveCanaryDeployGuardStatus = () => ({ held: true }); }, "LIVE_CANARY_DEPLOY_GUARD_RETAINED"],
  ["integrity latch", (input) => {
    const state = trippedAfterSettlement();
    state.reasons = ["LIFECYCLE_DUPLICATE"];
    input.getCircuitBreakerState = async () => state;
  }, "BREAKER_REASON_REQUIRES_OPERATOR"],
  ["mixed recoverable and integrity latch", (input) => {
    const state = trippedAfterSettlement();
    state.reasons = ["CONSECUTIVE_OPERATIONAL_FAILURES", "INVALID_RECONCILIATION_DATA"];
    input.getCircuitBreakerState = async () => state;
  }, "BREAKER_REASON_REQUIRES_OPERATOR"],
]) {
  const blockedCase = dependencies();
  mutate(blockedCase.input);
  const result = await attemptAutomaticCircuitBreakerResume(blockedCase.input);
  assert.equal(result.resumed, false, name);
  assert.equal(result.blocked, expected, name);
  assert.equal(blockedCase.events.length, 0, `${name} must not write breaker state`);
}

console.log("automatic breaker resume tests passed");
