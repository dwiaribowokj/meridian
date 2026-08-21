import {
  AUTOMATIC_CIRCUIT_BREAKER_RESUME_ELIGIBLE_REASONS,
  AUTOMATIC_CIRCUIT_BREAKER_RECOVERY_SOURCE,
  circuitBreakerRecoveryId,
} from "./circuit-breaker.js";

// Known economic and operational latches may reopen after an authoritative
// clean-boundary probe. Integrity, durability, and reconciliation uncertainty
// remain operator-owned because their underlying transaction state is unknown.
export const AUTOMATIC_RESUME_ELIGIBLE_BREAKER_REASONS =
  AUTOMATIC_CIRCUIT_BREAKER_RESUME_ELIGIBLE_REASONS;

const AUTOMATIC_RESUME_ELIGIBLE_REASON_SET = new Set(
  AUTOMATIC_RESUME_ELIGIBLE_BREAKER_REASONS,
);

function blocked(reason, extra = {}) {
  return { resumed: false, blocked: reason, ...extra };
}

function exactAuthoritativeZeroPositionObservation(livePositions) {
  return livePositions?.error == null && livePositions?.source === "rpc" &&
    Array.isArray(livePositions.positions) && livePositions.positions.length === 0 &&
    livePositions.total_positions === 0;
}

/**
 * Attempt one bounded automatic resume. This function submits no transaction:
 * it only records an auditable breaker event after every exposure and durable
 * lifecycle boundary has independently reported a safe state.
 */
export async function attemptAutomaticCircuitBreakerResume({
  enabled = true,
  dryRun = false,
  effectiveRolloutMode = "canary",
  livePositions,
  getTrackedPositions,
  getCircuitBreakerState,
  recordCircuitBreakerEvent,
  getTradeLedger,
  listPendingCleanupLifecycles,
  getLiveCanaryDeployGuardStatus,
  appendAudit = null,
  cooldownMs = 60_000,
  atMs = Date.now(),
} = {}) {
  if (enabled !== true) return blocked("AUTOMATIC_RESUME_DISABLED", { skipped: true });
  if (dryRun === true || effectiveRolloutMode !== "canary") {
    return blocked("NOT_EFFECTIVE_LIVE_CANARY", { skipped: true });
  }
  // Validate the fresh RPC result before reading or mutating any breaker state.
  if (!exactAuthoritativeZeroPositionObservation(livePositions)) {
    return blocked("AUTHORITATIVE_ZERO_POSITIONS_REQUIRED");
  }

  let breaker;
  try {
    breaker = await getCircuitBreakerState();
  } catch (error) {
    return blocked("BREAKER_DURABILITY_UNCERTAIN", { error: error.message });
  }
  if (breaker?.tripped !== true && breaker?.manualResumeRequired !== true) {
    return blocked("BREAKER_ALREADY_READY", { skipped: true });
  }
  const breakerReasons = Array.isArray(breaker?.reasons) ? breaker.reasons : [];
  if (breakerReasons.length === 0 || !breakerReasons.every((reason) => AUTOMATIC_RESUME_ELIGIBLE_REASON_SET.has(reason))) {
    return blocked("BREAKER_REASON_REQUIRES_OPERATOR", { reasons: breakerReasons });
  }
  const trippedAtMs = Number(breaker?.trippedAtMs);
  if (!Number.isFinite(trippedAtMs)) return blocked("BREAKER_TRIP_IDENTITY_UNAVAILABLE");
  const configuredCooldownMs = Number(cooldownMs);
  const recoveryCooldownMs = Number.isFinite(configuredCooldownMs)
    ? Math.max(0, configuredCooldownMs)
    : 60_000;
  const elapsedMs = atMs - trippedAtMs;
  if (!Number.isFinite(elapsedMs) || elapsedMs < recoveryCooldownMs) {
    return blocked("AUTOMATIC_RESUME_COOLDOWN", {
      retry_after_ms: Math.max(0, recoveryCooldownMs - Math.max(0, elapsedMs || 0)),
    });
  }

  let tracked;
  try {
    tracked = getTrackedPositions(true);
  } catch (error) {
    return blocked("TRACKED_POSITION_STATE_UNAVAILABLE", { error: error.message });
  }
  if (!Array.isArray(tracked) || tracked.length !== 0) {
    return blocked("TRACKED_POSITION_STILL_OPEN");
  }

  let store;
  let lifecycles;
  let pendingCleanup;
  try {
    store = getTradeLedger();
    lifecycles = store.listLifecycles();
    pendingCleanup = listPendingCleanupLifecycles({ store });
  } catch (error) {
    return blocked("LIFECYCLE_STATE_UNAVAILABLE", { error: error.message });
  }
  if (!Array.isArray(lifecycles) || !Array.isArray(pendingCleanup)) {
    return blocked("LIFECYCLE_STATE_MALFORMED");
  }
  if (pendingCleanup.length !== 0) return blocked("CLEANUP_PENDING");
  if (lifecycles.some((lifecycle) => lifecycle?.state !== "SETTLED" || lifecycle?.reconciliation_latched === true)) {
    return blocked("LIFECYCLE_RECONCILIATION_PENDING");
  }

  let guard;
  try {
    guard = getLiveCanaryDeployGuardStatus();
  } catch (error) {
    return blocked("LIVE_CANARY_DEPLOY_GUARD_UNAVAILABLE", { error: error.message });
  }
  if (guard?.held !== false) {
    return blocked(guard?.held === true ? "LIVE_CANARY_DEPLOY_GUARD_RETAINED" : "LIVE_CANARY_DEPLOY_GUARD_UNAVAILABLE", {
      error: guard?.error || null,
    });
  }

  const recoveryId = circuitBreakerRecoveryId(breaker);
  if (!recoveryId) return blocked("BREAKER_TRIP_IDENTITY_UNAVAILABLE");

  const event = {
    type: "automatic_recovery_resume",
    eventId: `automatic-recovery:${recoveryId}`,
    recoveryId,
    source: AUTOMATIC_CIRCUIT_BREAKER_RECOVERY_SOURCE,
    equitySol: Number.isFinite(breaker?.canaryCurrentEquitySol)
      ? breaker.canaryCurrentEquitySol
      : null,
    atMs,
  };
  let resumedState;
  try {
    resumedState = await recordCircuitBreakerEvent(event);
  } catch (error) {
    return blocked("AUTOMATIC_RESUME_PERSISTENCE_FAILED", {
      persistenceError: true,
      error: error.message,
      recovery_id: recoveryId,
    });
  }
  if (resumedState?.tripped === true || resumedState?.manualResumeRequired === true ||
      resumedState?.resumeSource !== AUTOMATIC_CIRCUIT_BREAKER_RECOVERY_SOURCE) {
    return blocked("AUTOMATIC_RESUME_REDUCER_REFUSED", { recovery_id: recoveryId });
  }

  let auditDiagnostic = null;
  if (typeof appendAudit === "function") {
    try {
      appendAudit({
        type: "resume",
        actor: "RISK_AUTOMATION",
        position: null,
        summary: "Circuit breaker automatically resumed",
        reason: `Authoritative zero-exposure recovery for ${breakerReasons.join(", ")}`,
        metrics: {
          recovery_id: recoveryId,
          prior_reasons: breakerReasons,
          resume_source: AUTOMATIC_CIRCUIT_BREAKER_RECOVERY_SOURCE,
        },
      });
    } catch (error) {
      // The durable breaker state already carries source + settlement id. The
      // supplementary human-readable audit failure must not undo that truth.
      auditDiagnostic = error.message;
    }
  }
  return {
    resumed: true,
    recovery_id: recoveryId,
    prior_reasons: breakerReasons,
    source: AUTOMATIC_CIRCUIT_BREAKER_RECOVERY_SOURCE,
    breaker: resumedState,
    ...(auditDiagnostic ? { auditDiagnostic } : {}),
  };
}
