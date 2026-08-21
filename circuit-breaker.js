import { RISK_POLICY_DEFAULTS, getGlobalProfitFloorSol } from "./risk-policy.js";

const HOUR_MS = 60 * 60_000;

export const AUTOMATIC_CIRCUIT_BREAKER_RESUME_SOURCE = "authoritative_settlement_zero_exposure";
export const AUTOMATIC_CIRCUIT_BREAKER_RECOVERY_SOURCE = "authoritative_zero_exposure_recovery";
export const AUTOMATIC_CIRCUIT_BREAKER_RESUME_ELIGIBLE_REASONS = Object.freeze([
  "PROFIT_EXIT_BELOW_GLOBAL_FLOOR",
  "CONSECUTIVE_NET_LOSSES",
  "SINGLE_TRADE_LOSS_LIMIT",
  "ROLLING_24H_LOSS_LIMIT",
  "CANARY_DRAWDOWN_LIMIT",
  "CONSECUTIVE_OPERATIONAL_FAILURES",
]);

const AUTOMATIC_CIRCUIT_BREAKER_RESUME_ELIGIBLE_REASON_SET = new Set(
  AUTOMATIC_CIRCUIT_BREAKER_RESUME_ELIGIBLE_REASONS,
);

export const CIRCUIT_BREAKER_DEFAULTS = Object.freeze({
  maximumConsecutiveNetLosses: 2,
  singleTradeLossPctExclusive: -2,
  rollingLossWindowMs: 24 * HOUR_MS,
  minimumRollingLossLimitSol: 0.003,
  rollingLossLimitEquityPct: 1.5,
  canaryMaximumDrawdownPct: 3,
  maximumReconciliationErrorSol: 0.0001,
  maximumConsecutiveOperationalFailures: 2,
  maximumRememberedEventIds: 512,
});

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function isStateObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function isNullableFiniteNumber(value) {
  return value == null || isFiniteNumber(value);
}

function isNullableEventId(value) {
  return value == null || (typeof value === "string" && value.length > 0 && value.length <= 512);
}

export function settlementCircuitBreakerEventId(lifecycleId, settlementId, type) {
  const lifecycle = String(lifecycleId || "").trim();
  const settlement = String(settlementId || "").trim();
  const eventType = String(type || "").trim();
  if (!lifecycle || !settlement || !eventType) return null;
  const eventId = `settlement:${lifecycle}:${settlement}:${eventType}`;
  return eventId.length <= 512 ? eventId : null;
}

function invalidPersistedState(message) {
  return new Error(`Circuit breaker persisted state is corrupt: ${message}`);
}

/**
 * Validate a persisted state before it is allowed to influence entry. This is
 * deliberately stricter than the reducer's defensive normalization: a
 * malformed persisted state must not be mistaken for an untripped breaker.
 */
export function validatePersistedCircuitBreakerState(input) {
  if (!isStateObject(input)) throw invalidPersistedState("expected a non-array object");
  if (input.version !== 1) throw invalidPersistedState("unsupported or missing version");
  if (typeof input.tripped !== "boolean" || typeof input.manualResumeRequired !== "boolean") {
    throw invalidPersistedState("trip and manual-resume flags must be booleans");
  }
  if (input.tripped && input.manualResumeRequired !== true) {
    throw invalidPersistedState("a tripped breaker must require explicit manual resume");
  }
  if (!isNullableFiniteNumber(input.trippedAtMs) || !isNullableFiniteNumber(input.canaryPeakEquitySol) ||
      !isNullableFiniteNumber(input.canaryCurrentEquitySol) || !isNullableFiniteNumber(input.resumedAtMs) ||
      !isFiniteNumber(input.lastEventAtMs)) {
    throw invalidPersistedState("timestamps and equity values are malformed");
  }
  if ((input.canaryPeakEquitySol != null && input.canaryPeakEquitySol < 0) ||
      (input.canaryCurrentEquitySol != null && input.canaryCurrentEquitySol < 0)) {
    throw invalidPersistedState("equity values cannot be negative");
  }
  if (!isNonNegativeInteger(input.consecutiveNetLosses) ||
      !isNonNegativeInteger(input.consecutiveOperationalFailures)) {
    throw invalidPersistedState("loss and operational-failure counters must be non-negative integers");
  }
  if (!Array.isArray(input.reasons) || !input.reasons.every((reason) => typeof reason === "string")) {
    throw invalidPersistedState("reasons must be a string array");
  }
  if (!Array.isArray(input.rollingLosses) || !input.rollingLosses.every((loss) => (
    isFiniteNumber(loss?.atMs) && isFiniteNumber(loss?.lossSol) && loss.lossSol > 0
  ))) {
    throw invalidPersistedState("rolling losses are malformed");
  }
  if (!Array.isArray(input.processedEventIds) || !input.processedEventIds.every((eventId) => (
    typeof eventId === "string" && eventId.length > 0 && eventId.length <= 512
  ))) {
    throw invalidPersistedState("processed event ids are malformed");
  }
  // These fields were added without changing the version so existing durable
  // version-1 latches remain readable. Once any new event is reduced, sanitize
  // writes the complete shape back to storage.
  if (input.lastSettledTradeEventId !== undefined && !isNullableEventId(input.lastSettledTradeEventId)) {
    throw invalidPersistedState("last settled trade event id is malformed");
  }
  if (input.lastSettledTradeAtMs !== undefined && !isNullableFiniteNumber(input.lastSettledTradeAtMs)) {
    throw invalidPersistedState("last settled trade timestamp is malformed");
  }
  const hasLastSettledId = typeof input.lastSettledTradeEventId === "string";
  const hasLastSettledTimestamp = isFiniteNumber(input.lastSettledTradeAtMs);
  if (hasLastSettledId !== hasLastSettledTimestamp) {
    throw invalidPersistedState("last settled trade identity and timestamp must be present together");
  }
  if (input.resumeSource !== undefined && ![
    null,
    "manual",
    AUTOMATIC_CIRCUIT_BREAKER_RESUME_SOURCE,
    AUTOMATIC_CIRCUIT_BREAKER_RECOVERY_SOURCE,
  ].includes(input.resumeSource)) {
    throw invalidPersistedState("resume source is malformed");
  }
  if (input.resumeSettlementEventId !== undefined && !isNullableEventId(input.resumeSettlementEventId)) {
    throw invalidPersistedState("resume settlement event id is malformed");
  }
  if (input.resumeSource === AUTOMATIC_CIRCUIT_BREAKER_RESUME_SOURCE &&
      typeof input.resumeSettlementEventId !== "string") {
    throw invalidPersistedState("automatic resume must identify its settlement event");
  }
  if (input.resumeSource !== undefined && input.resumeSource !== AUTOMATIC_CIRCUIT_BREAKER_RESUME_SOURCE &&
      input.resumeSettlementEventId != null) {
    throw invalidPersistedState("only automatic resume may identify a settlement event");
  }
  if (input.automaticResumeSettlementEventIds !== undefined &&
      (!Array.isArray(input.automaticResumeSettlementEventIds) ||
       !input.automaticResumeSettlementEventIds.every((eventId) => (
         typeof eventId === "string" && eventId.length > 0 && eventId.length <= 512
       )))) {
    throw invalidPersistedState("automatic resume settlement ids are malformed");
  }
  return clone(input);
}

export function createCircuitBreakerState(nowMs = Date.now()) {
  return {
    version: 1,
    tripped: false,
    manualResumeRequired: false,
    trippedAtMs: null,
    reasons: [],
    consecutiveNetLosses: 0,
    rollingLosses: [],
    canaryPeakEquitySol: null,
    canaryCurrentEquitySol: null,
    consecutiveOperationalFailures: 0,
    processedEventIds: [],
    lastEventAtMs: nowMs,
    resumedAtMs: null,
    resumeSource: null,
    resumeSettlementEventId: null,
    lastSettledTradeEventId: null,
    lastSettledTradeAtMs: null,
    automaticResumeSettlementEventIds: [],
  };
}

function sanitizeState(input, nowMs) {
  const state = createCircuitBreakerState(nowMs);
  if (!input || typeof input !== "object") return state;
  state.tripped = input.tripped === true;
  state.manualResumeRequired = input.manualResumeRequired === true || state.tripped;
  state.trippedAtMs = isFiniteNumber(input.trippedAtMs) ? input.trippedAtMs : null;
  state.reasons = Array.isArray(input.reasons)
    ? input.reasons.filter((reason) => typeof reason === "string")
    : [];
  state.consecutiveNetLosses = Number.isInteger(input.consecutiveNetLosses)
    ? Math.max(0, input.consecutiveNetLosses)
    : 0;
  state.rollingLosses = Array.isArray(input.rollingLosses)
    ? input.rollingLosses.filter((loss) => (
      isFiniteNumber(loss?.atMs) && isFiniteNumber(loss?.lossSol) && loss.lossSol > 0
    ))
    : [];
  state.canaryPeakEquitySol = isFiniteNumber(input.canaryPeakEquitySol)
    ? input.canaryPeakEquitySol
    : null;
  state.canaryCurrentEquitySol = isFiniteNumber(input.canaryCurrentEquitySol)
    ? input.canaryCurrentEquitySol
    : null;
  state.consecutiveOperationalFailures = Number.isInteger(input.consecutiveOperationalFailures)
    ? Math.max(0, input.consecutiveOperationalFailures)
    : 0;
  state.processedEventIds = Array.isArray(input.processedEventIds)
    ? [...new Set(input.processedEventIds
      .filter((eventId) => typeof eventId === "string" && eventId.length > 0 && eventId.length <= 512))]
      .slice(-CIRCUIT_BREAKER_DEFAULTS.maximumRememberedEventIds)
    : [];
  state.lastEventAtMs = isFiniteNumber(input.lastEventAtMs) ? input.lastEventAtMs : nowMs;
  state.resumedAtMs = isFiniteNumber(input.resumedAtMs) ? input.resumedAtMs : null;
  state.resumeSource = [
    "manual",
    AUTOMATIC_CIRCUIT_BREAKER_RESUME_SOURCE,
    AUTOMATIC_CIRCUIT_BREAKER_RECOVERY_SOURCE,
  ].includes(input.resumeSource)
    ? input.resumeSource
    : null;
  // Legacy version-1 states do not carry this optional field. Normalize both
  // a missing value and explicit null to the complete persisted shape instead
  // of leaking `undefined` (which JSON.stringify would silently omit again).
  state.resumeSettlementEventId = typeof input.resumeSettlementEventId === "string"
    ? input.resumeSettlementEventId
    : null;
  state.lastSettledTradeEventId = typeof input.lastSettledTradeEventId === "string"
    ? input.lastSettledTradeEventId
    : null;
  state.lastSettledTradeAtMs = isFiniteNumber(input.lastSettledTradeAtMs)
    ? input.lastSettledTradeAtMs
    : null;
  state.automaticResumeSettlementEventIds = Array.isArray(input.automaticResumeSettlementEventIds)
    ? [...new Set(input.automaticResumeSettlementEventIds
      .filter((eventId) => typeof eventId === "string" && eventId.length > 0 && eventId.length <= 512))]
      .slice(-CIRCUIT_BREAKER_DEFAULTS.maximumRememberedEventIds)
    : [];
  return state;
}

function trip(state, reason, atMs) {
  state.tripped = true;
  state.manualResumeRequired = true;
  state.trippedAtMs ??= atMs;
  if (!state.reasons.includes(reason)) state.reasons.push(reason);
}

function pruneRollingLosses(state, atMs, defaults) {
  state.rollingLosses = state.rollingLosses.filter((loss) => (
    loss.atMs <= atMs && atMs - loss.atMs <= defaults.rollingLossWindowMs
  ));
}

function stableEventId(event) {
  const value = event?.eventId ?? event?.event_id ?? null;
  return typeof value === "string" && value.length > 0 && value.length <= 512 ? value : null;
}

function rememberEventId(state, eventId, defaults) {
  if (!eventId) return;
  state.processedEventIds = [...state.processedEventIds, eventId]
    .slice(-Math.max(1, defaults.maximumRememberedEventIds || CIRCUIT_BREAKER_DEFAULTS.maximumRememberedEventIds));
}

export function circuitBreakerRecoveryId(state) {
  if (!isFiniteNumber(state?.trippedAtMs) || !Array.isArray(state?.reasons) || state.reasons.length === 0) {
    return null;
  }
  const reasons = [...new Set(state.reasons.filter((reason) => typeof reason === "string" && reason))]
    .sort();
  if (reasons.length === 0) return null;
  const recoveryId = `trip:${Math.trunc(state.trippedAtMs)}:${reasons.join("+")}`;
  return recoveryId.length <= 512 ? recoveryId : null;
}

/**
 * Pure circuit-breaker reducer. A manual resume always remains available. Two
 * automatic paths are recognized: the legacy settlement-bound latch clear and
 * a clean-boundary recovery epoch. The latter accepts only known recoverable
 * economic/operational reasons and a deterministic identity for the active
 * trip; integrity and reconciliation latches cannot use it.
 */
export function applyCircuitBreakerEvent(
  currentState,
  event,
  defaults = CIRCUIT_BREAKER_DEFAULTS,
  riskPolicy = RISK_POLICY_DEFAULTS,
) {
  const atMs = isFiniteNumber(event?.atMs) ? event.atMs : Date.now();
  const state = sanitizeState(clone(currentState), atMs);
  const eventId = stableEventId(event);
  // Delivery retries must be a no-op, including after a manual resume. Keeping
  // these ids through manual resume prevents an old settlement delivery from
  // reapplying losses and silently defeating that explicit operator action.
  if (event?.type !== "manual_resume" && eventId && state.processedEventIds.includes(eventId)) {
    return state;
  }
  state.lastEventAtMs = atMs;
  pruneRollingLosses(state, atMs, defaults);

  if (event?.type === "manual_resume") {
    const resumed = createCircuitBreakerState(atMs);
    resumed.resumedAtMs = atMs;
    resumed.resumeSource = "manual";
    resumed.processedEventIds = state.processedEventIds;
    resumed.automaticResumeSettlementEventIds = state.automaticResumeSettlementEventIds;
    return resumed;
  }

  if (event?.type === "automatic_resume") {
    const settlementEventId = typeof event?.settlementEventId === "string"
      ? event.settlementEventId
      : null;
    const eligible = state.tripped === true && state.manualResumeRequired === true &&
      state.reasons.length === 1 &&
      AUTOMATIC_CIRCUIT_BREAKER_RESUME_ELIGIBLE_REASON_SET.has(state.reasons[0]) &&
      event.source === AUTOMATIC_CIRCUIT_BREAKER_RESUME_SOURCE &&
      eventId != null && settlementEventId != null &&
      state.lastSettledTradeEventId === settlementEventId &&
      state.processedEventIds.includes(settlementEventId) &&
      !state.automaticResumeSettlementEventIds.includes(settlementEventId) &&
      isFiniteNumber(state.trippedAtMs) && isFiniteNumber(state.lastSettledTradeAtMs) &&
      state.lastSettledTradeAtMs >= state.trippedAtMs;
    if (!eligible) return state;

    // Unlike an explicit operator reset, automation clears only the latch.
    // Loss history, equity peak/current values, and operational counters must
    // survive so repeated small misses can still trip aggregate risk limits.
    state.tripped = false;
    state.manualResumeRequired = false;
    state.trippedAtMs = null;
    state.reasons = [];
    state.resumedAtMs = atMs;
    state.resumeSource = AUTOMATIC_CIRCUIT_BREAKER_RESUME_SOURCE;
    state.resumeSettlementEventId = settlementEventId;
    state.automaticResumeSettlementEventIds = [
      ...state.automaticResumeSettlementEventIds,
      settlementEventId,
    ].slice(-Math.max(1, defaults.maximumRememberedEventIds || CIRCUIT_BREAKER_DEFAULTS.maximumRememberedEventIds));
    rememberEventId(state, eventId, defaults);
    return state;
  }

  if (event?.type === "automatic_recovery_resume") {
    const recoveryId = typeof event?.recoveryId === "string" ? event.recoveryId : null;
    const expectedRecoveryId = circuitBreakerRecoveryId(state);
    const reasonsRecoverable = state.reasons.length > 0 &&
      state.reasons.every((reason) => AUTOMATIC_CIRCUIT_BREAKER_RESUME_ELIGIBLE_REASON_SET.has(reason));
    const eligible = state.tripped === true && state.manualResumeRequired === true &&
      reasonsRecoverable &&
      event.source === AUTOMATIC_CIRCUIT_BREAKER_RECOVERY_SOURCE &&
      eventId != null && recoveryId != null && recoveryId === expectedRecoveryId &&
      !state.processedEventIds.includes(eventId) &&
      isFiniteNumber(state.trippedAtMs) && atMs >= state.trippedAtMs &&
      (event.equitySol == null || (isFiniteNumber(event.equitySol) && event.equitySol >= 0));
    if (!eligible) return state;

    // The operator designated this wallet for continuous LP use. A verified
    // zero-exposure recovery starts a fresh economic epoch so an intentional
    // wallet withdrawal or an already-recovered provider outage cannot leave
    // the next cycle permanently latched. Processed event identities remain so
    // historical settlement deliveries can never be counted twice.
    const resumed = createCircuitBreakerState(atMs);
    resumed.resumedAtMs = atMs;
    resumed.resumeSource = AUTOMATIC_CIRCUIT_BREAKER_RECOVERY_SOURCE;
    resumed.processedEventIds = state.processedEventIds;
    resumed.automaticResumeSettlementEventIds = state.automaticResumeSettlementEventIds;
    if (isFiniteNumber(event.equitySol)) {
      resumed.canaryPeakEquitySol = event.equitySol;
      resumed.canaryCurrentEquitySol = event.equitySol;
    }
    rememberEventId(resumed, eventId, defaults);
    return resumed;
  }

  switch (event?.type) {
    case "trade_settled": {
      if (!isFiniteNumber(event.netProfitSol) || !isFiniteNumber(event.deployedSol) || event.deployedSol <= 0) {
        trip(state, "INVALID_SETTLED_TRADE_DATA", atMs);
        break;
      }
      if (eventId) {
        state.lastSettledTradeEventId = eventId;
        state.lastSettledTradeAtMs = atMs;
      }
      if (event.netProfitSol < 0) {
        state.consecutiveNetLosses += 1;
        state.rollingLosses.push({ atMs, lossSol: Math.abs(event.netProfitSol) });
      } else {
        state.consecutiveNetLosses = 0;
      }
      if (state.consecutiveNetLosses >= defaults.maximumConsecutiveNetLosses) {
        trip(state, "CONSECUTIVE_NET_LOSSES", atMs);
      }
      const lossPct = (event.netProfitSol / event.deployedSol) * 100;
      if (lossPct < defaults.singleTradeLossPctExclusive) {
        trip(state, "SINGLE_TRADE_LOSS_LIMIT", atMs);
      }
      const equityStartSol = isFiniteNumber(event.equityStartSol) && event.equityStartSol >= 0
        ? event.equityStartSol
        : 0;
      const rollingLossLimitSol = Math.max(
        defaults.minimumRollingLossLimitSol,
        equityStartSol * (defaults.rollingLossLimitEquityPct / 100),
      );
      const rollingLossSol = state.rollingLosses.reduce((sum, loss) => sum + loss.lossSol, 0);
      if (rollingLossSol >= rollingLossLimitSol) trip(state, "ROLLING_24H_LOSS_LIMIT", atMs);
      break;
    }

    case "canary_equity": {
      if (!isFiniteNumber(event.equitySol) || event.equitySol < 0) {
        trip(state, "INVALID_CANARY_EQUITY", atMs);
        break;
      }
      state.canaryCurrentEquitySol = event.equitySol;
      state.canaryPeakEquitySol = Math.max(state.canaryPeakEquitySol ?? event.equitySol, event.equitySol);
      const drawdownPct = state.canaryPeakEquitySol > 0
        ? ((state.canaryPeakEquitySol - event.equitySol) / state.canaryPeakEquitySol) * 100
        : 0;
      if (drawdownPct >= defaults.canaryMaximumDrawdownPct) {
        trip(state, "CANARY_DRAWDOWN_LIMIT", atMs);
      }
      break;
    }

    case "basis_invalid":
      trip(state, "INVALID_COST_BASIS", atMs);
      break;

    case "reconciliation_checked":
      if (!isFiniteNumber(event.errorSol)) {
        trip(state, "INVALID_RECONCILIATION_DATA", atMs);
      } else if (Math.abs(event.errorSol) > defaults.maximumReconciliationErrorSol) {
        trip(state, "RESIDUAL_RECONCILIATION_LIMIT", atMs);
      }
      break;

    case "profit_exit": {
      const floor = getGlobalProfitFloorSol(event.deployedSol, riskPolicy);
      if (floor == null || !isFiniteNumber(event.netProfitSol)) {
        trip(state, "INVALID_PROFIT_EXIT_DATA", atMs);
      } else if (event.netProfitSol < floor) {
        trip(state, "PROFIT_EXIT_BELOW_GLOBAL_FLOOR", atMs);
      }
      break;
    }

    case "lifecycle_anomaly":
      if (event.kind === "partial" || event.kind === "duplicate") {
        trip(state, `LIFECYCLE_${event.kind.toUpperCase()}`, atMs);
      }
      break;

    case "operation_failure":
      if (["transaction", "swap", "cleanup"].includes(event.operation)) {
        state.consecutiveOperationalFailures += 1;
        if (state.consecutiveOperationalFailures >= defaults.maximumConsecutiveOperationalFailures) {
          trip(state, "CONSECUTIVE_OPERATIONAL_FAILURES", atMs);
        }
      }
      break;

    case "operation_success":
      if (["transaction", "swap", "cleanup"].includes(event.operation)) {
        state.consecutiveOperationalFailures = 0;
      }
      break;

    default:
      break;
  }

  rememberEventId(state, eventId, defaults);
  return state;
}

/** Minimal in-memory adapter useful for tests and dry runs. */
export function createMemoryCircuitBreakerStorage(initialEntries = {}) {
  const entries = new Map(Object.entries(clone(initialEntries) ?? {}));
  return {
    async load(key) {
      // `undefined` is the only storage-level representation of a missing
      // state. `null` is persisted data and must fail closed as corrupt.
      return entries.has(key) ? clone(entries.get(key)) : undefined;
    },
    async save(key, value) {
      entries.set(key, clone(value));
    },
  };
}

/**
 * Persistent controller using an injected { load(key), save(key, value) }
 * adapter. A JSON-file adapter can be supplied by runtime without coupling
 * this policy module to a specific path or filesystem implementation.
 *
 * Recovery policy: only an absent state (`storage.load()` returning
 * `undefined`) initializes a fresh untripped state. A malformed, unreadable,
 * or non-object existing state rejects every operation and therefore blocks
 * entry. `manualResume` is the unconditional operator API that clears an
 * intact latched state; the reducer's automatic event remains settlement-bound
 * and cannot repair or replace corrupt persisted data.
 */
export function createCircuitBreakerController({
  storage,
  key = "meridian:risk-circuit-breaker",
  defaults = CIRCUIT_BREAKER_DEFAULTS,
  riskPolicy = RISK_POLICY_DEFAULTS,
  now = Date.now,
}) {
  if (typeof storage?.load !== "function" || typeof storage?.save !== "function") {
    throw new TypeError("storage must implement async load(key) and save(key, state)");
  }
  let state = null;

  async function loadAuthoritativeState({ requirePersisted = false } = {}) {
    const loaded = await storage.load(key);
    if (loaded === undefined) {
      if (requirePersisted) {
        throw new Error("Circuit breaker state disappeared after a successful save");
      }
      return createCircuitBreakerState(now());
    }
    return validatePersistedCircuitBreakerState(loaded);
  }

  async function record(event) {
    // State can be changed by another controller or process between any two
    // calls.  Always reduce from storage rather than a permissive cache; file
    // storage adds CAS/lock serialization around this read-reduce-write.
    const current = await loadAuthoritativeState();
    state = current;
    const next = applyCircuitBreakerEvent(current, event, defaults, riskPolicy);
    try {
      await storage.save(key, next);
    } catch (error) {
      // A rejected optimistic save can mean another writer preserved or
      // introduced a latch. Reload it before exposing this controller again;
      // retaining `next` here could turn a failed manual-resume into entry.
      try {
        state = await loadAuthoritativeState();
      } catch {
        state = null;
      }
      throw error;
    }
    try {
      // Storage is authoritative even after its save resolves. This also keeps
      // adapters with compare-and-swap semantics from leaving a stale cache.
      state = await loadAuthoritativeState({ requirePersisted: true });
    } catch (error) {
      state = null;
      throw error;
    }
    return clone(state);
  }

  return {
    async getState() {
      // The persisted latch is authoritative.  In particular, a controller
      // that previously observed an untripped state must see another
      // controller's durable trip before it reports state to a caller.
      state = await loadAuthoritativeState();
      return clone(state);
    },
    record,
    async manualResume(atMs = now()) {
      return record({ type: "manual_resume", atMs });
    },
    async entryAllowed() {
      // Entry is a safety decision, not a cache lookup.  Refresh on every
      // call so a persisted trip in another process cannot be bypassed.
      const current = await loadAuthoritativeState();
      state = current;
      return !current.tripped && !current.manualResumeRequired;
    },
  };
}
