import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { repoPath } from "./repo-root.js";
import {
  acquireSecureFileLock,
  appendOpenedRegularFile,
  closeSecureRegularFile,
  openSecureRegularFileForAppend,
  readSecureRegularFile,
  releaseSecureFileLock,
} from "./durable-file.js";

export const LEDGER_SCHEMA_VERSION = 1;
export const DEFAULT_TRADE_LEDGER_FILE = repoPath("trade-ledger.jsonl");

export const LIFECYCLE_STATES = Object.freeze({
  PENDING_DEPLOY: "PENDING_DEPLOY",
  BASIS_PENDING: "BASIS_PENDING",
  ACTIVE: "ACTIVE",
  CLOSING: "CLOSING",
  CLEANUP_PENDING: "CLEANUP_PENDING",
  SETTLED: "SETTLED",
  RECONCILIATION_REQUIRED: "RECONCILIATION_REQUIRED",
});

export const LEDGER_EVENT_TYPES = Object.freeze({
  LIFECYCLE_CREATED: "lifecycle_created",
  STATE_TRANSITION: "state_transition",
  TRANSACTION_RECORDED: "transaction_recorded",
  BASIS_OBSERVED: "basis_observed",
  VALUATION_RECORDED: "valuation_recorded",
  SETTLEMENT_FINALIZED: "settlement_finalized",
  RECONCILIATION_CLEARED: "reconciliation_cleared",
  TRANSACTION_RECONCILED: "transaction_reconciled",
});

const ALL_STATES = new Set(Object.values(LIFECYCLE_STATES));
const ALL_EVENT_TYPES = new Set(Object.values(LEDGER_EVENT_TYPES));
const CONFIRMED_COMMITMENTS = new Set(["confirmed", "finalized"]);
const TRANSACTION_PHASES = new Set(["deploy", "hold", "close", "claim", "swap", "cleanup", "other"]);
const APPEND_TIMESTAMP_FACTORY = Symbol("tradeLedgerAppendTimestampFactory");

const ALLOWED_TRANSITIONS = Object.freeze({
  [LIFECYCLE_STATES.PENDING_DEPLOY]: new Set([
    LIFECYCLE_STATES.BASIS_PENDING,
    LIFECYCLE_STATES.CLOSING,
    LIFECYCLE_STATES.RECONCILIATION_REQUIRED,
  ]),
  [LIFECYCLE_STATES.BASIS_PENDING]: new Set([
    LIFECYCLE_STATES.ACTIVE,
    LIFECYCLE_STATES.CLOSING,
    LIFECYCLE_STATES.RECONCILIATION_REQUIRED,
  ]),
  [LIFECYCLE_STATES.ACTIVE]: new Set([
    LIFECYCLE_STATES.CLOSING,
    LIFECYCLE_STATES.RECONCILIATION_REQUIRED,
  ]),
  [LIFECYCLE_STATES.CLOSING]: new Set([
    LIFECYCLE_STATES.CLEANUP_PENDING,
    LIFECYCLE_STATES.RECONCILIATION_REQUIRED,
  ]),
  [LIFECYCLE_STATES.CLEANUP_PENDING]: new Set([
    LIFECYCLE_STATES.RECONCILIATION_REQUIRED,
  ]),
  [LIFECYCLE_STATES.RECONCILIATION_REQUIRED]: new Set([
    LIFECYCLE_STATES.ACTIVE,
    LIFECYCLE_STATES.CLOSING,
    LIFECYCLE_STATES.CLEANUP_PENDING,
  ]),
  [LIFECYCLE_STATES.SETTLED]: new Set(),
});

// Transaction receipts are durable facts about one lifecycle operation, not
// generic annotations. Keep close/cleanup recovery possible after an explicit
// reconciliation latch, but never let an operation begin before deployment
// has entered its basis-confirmation phase.
const ALLOWED_TRANSACTION_STATES = Object.freeze({
  deploy: new Set([LIFECYCLE_STATES.BASIS_PENDING]),
  hold: new Set([LIFECYCLE_STATES.ACTIVE]),
  close: new Set([LIFECYCLE_STATES.CLOSING, LIFECYCLE_STATES.RECONCILIATION_REQUIRED]),
  claim: new Set([
    LIFECYCLE_STATES.ACTIVE,
    LIFECYCLE_STATES.CLOSING,
    LIFECYCLE_STATES.RECONCILIATION_REQUIRED,
  ]),
  swap: new Set([LIFECYCLE_STATES.CLEANUP_PENDING, LIFECYCLE_STATES.RECONCILIATION_REQUIRED]),
  cleanup: new Set([LIFECYCLE_STATES.CLEANUP_PENDING, LIFECYCLE_STATES.RECONCILIATION_REQUIRED]),
  other: new Set([
    LIFECYCLE_STATES.BASIS_PENDING,
    LIFECYCLE_STATES.ACTIVE,
    LIFECYCLE_STATES.CLOSING,
    LIFECYCLE_STATES.CLEANUP_PENDING,
    LIFECYCLE_STATES.RECONCILIATION_REQUIRED,
  ]),
});

const AMOUNT_FIELDS = Object.freeze([
  "deposit_lamports",
  "withdrawal_lamports",
  "claimed_fee_lamports",
  "liquid_wallet_delta_lamports",
  "tx_fee_lamports",
  "swap_cost_lamports",
  "rent_created_lamports",
  "rent_reclaimed_lamports",
]);

const NONNEGATIVE_AMOUNT_FIELDS = new Set(AMOUNT_FIELDS.filter((field) => field !== "liquid_wallet_delta_lamports"));
const INTEGER_PATTERN = /^-?(0|[1-9]\d*)$/;

function integerBigInt(value, field, { allowNegative = false } = {}) {
  let parsed;
  if (typeof value === "bigint") {
    parsed = value;
  } else if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new TypeError(`${field} must be a safe integer, bigint, or canonical integer string`);
    }
    parsed = BigInt(value);
  } else if (typeof value === "string" && INTEGER_PATTERN.test(value)) {
    parsed = BigInt(value);
  } else {
    throw new TypeError(`${field} must be an integer lamport/raw amount`);
  }

  if (!allowNegative && parsed < 0n) {
    throw new RangeError(`${field} cannot be negative`);
  }
  return parsed;
}

function integerString(value, field, options) {
  return integerBigInt(value, field, options).toString();
}

function absolute(value) {
  return value < 0n ? -value : value;
}

function normalizeTimestamp(value, field = "occurred_at") {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError(`${field} must be a valid timestamp`);
  return date.toISOString();
}

function normalizeIdentifier(value, field) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new TypeError(`${field} is required`);
  if (/[\r\n]/.test(normalized)) throw new TypeError(`${field} cannot contain line breaks`);
  return normalized;
}

function jsonSafe(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item));
}

function normalizeExpectedLayers(expectedLayers, expectedDepositLamports) {
  const layers = Array.isArray(expectedLayers) && expectedLayers.length
    ? expectedLayers
    : [{ layer_id: "single", expected_deposit_lamports: expectedDepositLamports }];
  const seen = new Set();
  const normalized = layers.map((layer, index) => {
    const layerId = normalizeIdentifier(layer?.layer_id ?? `layer_${index + 1}`, `expected_layers[${index}].layer_id`);
    if (seen.has(layerId)) throw new Error(`Duplicate expected layer_id: ${layerId}`);
    seen.add(layerId);
    return {
      layer_id: layerId,
      expected_deposit_lamports: integerString(
        layer?.expected_deposit_lamports,
        `expected_layers[${index}].expected_deposit_lamports`,
      ),
    };
  });
  const sum = normalized.reduce((total, layer) => total + BigInt(layer.expected_deposit_lamports), 0n);
  if (sum !== BigInt(expectedDepositLamports)) {
    throw new Error(`Expected layer deposits (${sum}) must equal expected_deposit_lamports (${expectedDepositLamports})`);
  }
  return normalized;
}

function normalizeAmounts(amounts = {}) {
  const normalized = {};
  for (const field of AMOUNT_FIELDS) {
    normalized[field] = integerString(amounts[field] ?? 0, `amounts.${field}`, {
      allowNegative: !NONNEGATIVE_AMOUNT_FIELDS.has(field),
    });
  }
  return normalized;
}

function normalizeTokenDeltas(tokenDeltas = []) {
  if (!Array.isArray(tokenDeltas)) throw new TypeError("token_deltas must be an array");
  return tokenDeltas.map((delta, index) => ({
    mint: normalizeIdentifier(delta?.mint, `token_deltas[${index}].mint`),
    account: delta?.account == null ? null : normalizeIdentifier(delta.account, `token_deltas[${index}].account`),
    raw_amount: integerString(delta?.raw_amount, `token_deltas[${index}].raw_amount`, { allowNegative: true }),
  }));
}

function makeBaseEvent({ eventType, lifecycleId, occurredAt, eventId, now, idFactory }) {
  const event = {
    schema_version: LEDGER_SCHEMA_VERSION,
    event_id: normalizeIdentifier(eventId ?? idFactory(), "event_id"),
    event_type: eventType,
    lifecycle_id: normalizeIdentifier(lifecycleId, "lifecycle_id"),
    // For implicit timestamps, call now() only after #append owns the durable
    // append lease. Object spread copies this enumerable symbol but JSON and
    // the exact persisted schema do not expose it.
    occurred_at: occurredAt == null ? null : normalizeTimestamp(occurredAt),
  };
  Object.defineProperty(event, APPEND_TIMESTAMP_FACTORY, {
    value: occurredAt == null ? now : null,
    enumerable: true,
  });
  return event;
}

function isPlainObject(value) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(value, keys, field) {
  if (!isPlainObject(value)) throw new Error(`${field} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${field} has missing or unexpected fields`);
  }
}

function assertCanonicalIdentifier(value, field, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== "string") throw new TypeError(`${field} must be a string identifier`);
  const normalized = normalizeIdentifier(value, field);
  if (normalized !== value) throw new TypeError(`${field} must be a canonical identifier`);
  return value;
}

function assertCanonicalTimestamp(value, field = "occurred_at") {
  if (typeof value !== "string") throw new TypeError(`${field} must be a canonical ISO timestamp`);
  const normalized = normalizeTimestamp(value, field);
  if (normalized !== value) throw new TypeError(`${field} must be a canonical ISO timestamp`);
  return value;
}

function assertCanonicalIntegerString(value, field, { allowNegative = false, positive = false } = {}) {
  if (typeof value !== "string") throw new TypeError(`${field} must be a canonical integer string`);
  const normalized = integerString(value, field, { allowNegative });
  if (normalized !== value) throw new TypeError(`${field} must be a canonical integer string`);
  if (positive && BigInt(value) <= 0n) throw new RangeError(`${field} must be greater than zero`);
  return value;
}

function assertMetadata(value, field = "metadata") {
  // Metadata may evolve independently, but the event envelope must still
  // carry one JSON object rather than an omitted, scalar, or executable value.
  if (!isPlainObject(value)) throw new TypeError(`${field} must be a JSON object`);
  const isJsonValue = (item) => {
    if (item === null || typeof item === "string" || typeof item === "boolean") return true;
    if (typeof item === "number") return Number.isFinite(item);
    if (Array.isArray(item)) return item.every(isJsonValue);
    return isPlainObject(item) && Object.values(item).every(isJsonValue);
  };
  if (!isJsonValue(value)) {
    throw new TypeError(`${field} must contain only JSON values`);
  }
  return value;
}

function assertReason(value, field = "reason") {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > 500 || value.trim() !== value) {
    throw new TypeError(`${field} must be a trimmed string of at most 500 characters or null`);
  }
  return value;
}

function validateBaseEvent(event) {
  if (!isPlainObject(event)) throw new Error("Trade-ledger event must be an object");
  if (event?.schema_version !== LEDGER_SCHEMA_VERSION) {
    throw new Error(`Unsupported trade-ledger schema_version: ${event?.schema_version}`);
  }
  assertCanonicalIdentifier(event.event_id, "event_id");
  assertCanonicalIdentifier(event.lifecycle_id, "lifecycle_id");
  assertCanonicalTimestamp(event.occurred_at);
  if (!ALL_EVENT_TYPES.has(event.event_type)) throw new Error(`Unknown ledger event_type: ${event.event_type}`);
  return event;
}

function validateExpectedLayers(event) {
  if (!Array.isArray(event.expected_layers) || event.expected_layers.length === 0) {
    throw new Error("expected_layers must be a non-empty array");
  }
  const seen = new Set();
  let total = 0n;
  for (const [index, layer] of event.expected_layers.entries()) {
    assertExactKeys(layer, ["layer_id", "expected_deposit_lamports"], `expected_layers[${index}]`);
    const layerId = assertCanonicalIdentifier(layer.layer_id, `expected_layers[${index}].layer_id`);
    if (seen.has(layerId)) throw new Error(`Duplicate expected layer_id: ${layerId}`);
    seen.add(layerId);
    total += BigInt(assertCanonicalIntegerString(
      layer.expected_deposit_lamports,
      `expected_layers[${index}].expected_deposit_lamports`,
    ));
  }
  if (total !== BigInt(event.expected_deposit_lamports)) {
    throw new Error("expected_layers total must equal expected_deposit_lamports");
  }
}

function validateAmounts(amounts, field = "amounts") {
  assertExactKeys(amounts, AMOUNT_FIELDS, field);
  for (const amountField of AMOUNT_FIELDS) {
    assertCanonicalIntegerString(amounts[amountField], `${field}.${amountField}`, {
      allowNegative: !NONNEGATIVE_AMOUNT_FIELDS.has(amountField),
    });
  }
}

function validateTokenDeltas(tokenDeltas) {
  if (!Array.isArray(tokenDeltas)) throw new TypeError("token_deltas must be an array");
  for (const [index, delta] of tokenDeltas.entries()) {
    assertExactKeys(delta, ["mint", "account", "raw_amount"], `token_deltas[${index}]`);
    assertCanonicalIdentifier(delta.mint, `token_deltas[${index}].mint`);
    assertCanonicalIdentifier(delta.account, `token_deltas[${index}].account`, { nullable: true });
    assertCanonicalIntegerString(delta.raw_amount, `token_deltas[${index}].raw_amount`, { allowNegative: true });
  }
}

function validateTokenAccountEvidence(metadata) {
  if (!Object.hasOwn(metadata, "token_account_evidence")) return null;
  const evidenceRows = metadata.token_account_evidence;
  if (!Array.isArray(evidenceRows)) {
    throw new TypeError("metadata.token_account_evidence must be an array");
  }
  for (const [index, evidence] of evidenceRows.entries()) {
    assertExactKeys(evidence, [
      "account", "mint", "pre_raw_amount", "post_raw_amount", "raw_amount",
    ], `metadata.token_account_evidence[${index}]`);
    assertCanonicalIdentifier(evidence.account, `metadata.token_account_evidence[${index}].account`);
    assertCanonicalIdentifier(evidence.mint, `metadata.token_account_evidence[${index}].mint`);
    const pre = BigInt(assertCanonicalIntegerString(
      evidence.pre_raw_amount,
      `metadata.token_account_evidence[${index}].pre_raw_amount`,
    ));
    const post = BigInt(assertCanonicalIntegerString(
      evidence.post_raw_amount,
      `metadata.token_account_evidence[${index}].post_raw_amount`,
    ));
    const delta = BigInt(assertCanonicalIntegerString(
      evidence.raw_amount,
      `metadata.token_account_evidence[${index}].raw_amount`,
      { allowNegative: true },
    ));
    if (delta !== post - pre) {
      throw new Error(`metadata.token_account_evidence[${index}].raw_amount must equal post_raw_amount minus pre_raw_amount`);
    }
  }
  return evidenceRows;
}

function validateLifecycleCreatedEvent(event) {
  assertExactKeys(event, [
    "schema_version", "event_id", "event_type", "lifecycle_id", "occurred_at",
    "position_address", "pool_address", "expected_deposit_lamports", "expected_layers",
    "required_stable_basis_reads", "layer_tolerance_lamports", "observation_tolerance_lamports",
    "external_tolerance_lamports", "metadata",
  ], "lifecycle_created event");
  assertCanonicalIdentifier(event.position_address, "position_address", { nullable: true });
  assertCanonicalIdentifier(event.pool_address, "pool_address");
  assertCanonicalIntegerString(event.expected_deposit_lamports, "expected_deposit_lamports", { positive: true });
  validateExpectedLayers(event);
  if (!Number.isInteger(event.required_stable_basis_reads) || event.required_stable_basis_reads < 0) {
    throw new TypeError("required_stable_basis_reads must be a non-negative integer");
  }
  assertCanonicalIntegerString(event.layer_tolerance_lamports, "layer_tolerance_lamports");
  assertCanonicalIntegerString(event.observation_tolerance_lamports, "observation_tolerance_lamports");
  assertCanonicalIntegerString(event.external_tolerance_lamports, "external_tolerance_lamports");
  assertMetadata(event.metadata);
}

function validateStateTransitionEvent(event) {
  assertExactKeys(event, [
    "schema_version", "event_id", "event_type", "lifecycle_id", "occurred_at",
    "from_state", "to_state", "reason",
  ], "state_transition event");
  if (!ALL_STATES.has(event.from_state) || !ALL_STATES.has(event.to_state) ||
      !ALLOWED_TRANSITIONS[event.from_state]?.has(event.to_state)) {
    throw new Error(`Invalid lifecycle state transition: ${event.from_state} -> ${event.to_state}`);
  }
  assertReason(event.reason);
}

function validateTransactionEvent(event) {
  assertExactKeys(event, [
    "schema_version", "event_id", "event_type", "lifecycle_id", "occurred_at",
    "signature", "phase", "layer_id", "commitment", "execution_status", "amounts", "token_deltas", "metadata",
  ], "transaction_recorded event");
  assertCanonicalIdentifier(event.signature, "signature");
  if (!TRANSACTION_PHASES.has(event.phase)) throw new Error(`Unknown transaction phase: ${event.phase}`);
  assertCanonicalIdentifier(event.layer_id, "layer_id", { nullable: true });
  if (!CONFIRMED_COMMITMENTS.has(event.commitment)) {
    throw new Error("transaction commitment must be confirmed or finalized");
  }
  if (!new Set(["succeeded", "failed"]).has(event.execution_status)) {
    throw new Error(`Unknown execution_status: ${event.execution_status}`);
  }
  validateAmounts(event.amounts);
  validateTokenDeltas(event.token_deltas);
  assertMetadata(event.metadata);
  const tokenAccountEvidence = validateTokenAccountEvidence(event.metadata);
  if (event.phase === "deploy" && BigInt(event.amounts.deposit_lamports) > 0n && event.layer_id === null) {
    throw new Error("A successful deploy deposit requires layer_id");
  }
  if (event.execution_status === "failed") {
    if (event.token_deltas.length !== 0) {
      throw new Error("Failed transaction cannot record token_deltas");
    }
    if (tokenAccountEvidence !== null && tokenAccountEvidence.length !== 0) {
      throw new Error("Failed transaction cannot record token_account_evidence");
    }
    for (const field of [
      "deposit_lamports", "withdrawal_lamports", "claimed_fee_lamports", "swap_cost_lamports",
      "rent_created_lamports", "rent_reclaimed_lamports",
    ]) {
      if (BigInt(event.amounts[field]) !== 0n) {
        throw new Error(`Failed transaction cannot record ${field}`);
      }
    }
  }
}

function assertTransactionPhaseAllowed(phase, state, lifecycleId) {
  if (!ALLOWED_TRANSACTION_STATES[phase]?.has(state)) {
    throw new Error(`Transaction phase ${phase} is not permitted while lifecycle ${lifecycleId} is ${state}`);
  }
}

function validateBasisObservationEvent(event) {
  assertExactKeys(event, [
    "schema_version", "event_id", "event_type", "lifecycle_id", "occurred_at",
    "source", "commitment", "deposit_lamports", "metadata",
  ], "basis_observed event");
  if (!new Set(["rpc", "external"]).has(event.source)) {
    throw new Error(`Unknown basis observation source: ${event.source}`);
  }
  if (!CONFIRMED_COMMITMENTS.has(event.commitment)) {
    throw new Error("basis observation commitment must be confirmed or finalized");
  }
  assertCanonicalIntegerString(event.deposit_lamports, "deposit_lamports");
  assertMetadata(event.metadata);
}

function validateValuationEvent(event) {
  assertExactKeys(event, [
    "schema_version", "event_id", "event_type", "lifecycle_id", "occurred_at",
    "source", "residual_token_value_lamports", "reclaimable_rent_lamports", "metadata",
  ], "valuation_recorded event");
  assertCanonicalIdentifier(event.source, "source");
  assertCanonicalIntegerString(event.residual_token_value_lamports, "residual_token_value_lamports");
  assertCanonicalIntegerString(event.reclaimable_rent_lamports, "reclaimable_rent_lamports");
  assertMetadata(event.metadata);
}

function validateSettlementEvent(event) {
  assertExactKeys(event, [
    "schema_version", "event_id", "event_type", "lifecycle_id", "occurred_at",
    "from_state", "outcome_state", "residual_token_value_lamports", "reclaimable_rent_lamports",
    "tolerance_lamports", "wallet_equity_net_lamports", "component_equity_net_lamports",
    "reconciliation_error_lamports", "reconciliation_error_abs_lamports", "reconciled", "metadata",
  ], "settlement_finalized event");
  if (![LIFECYCLE_STATES.CLOSING, LIFECYCLE_STATES.CLEANUP_PENDING, LIFECYCLE_STATES.RECONCILIATION_REQUIRED].includes(event.from_state)) {
    throw new Error(`Invalid settlement from_state: ${event.from_state}`);
  }
  if (![LIFECYCLE_STATES.SETTLED, LIFECYCLE_STATES.RECONCILIATION_REQUIRED].includes(event.outcome_state)) {
    throw new Error(`Invalid settlement outcome_state: ${event.outcome_state}`);
  }
  assertCanonicalIntegerString(event.residual_token_value_lamports, "residual_token_value_lamports");
  assertCanonicalIntegerString(event.reclaimable_rent_lamports, "reclaimable_rent_lamports");
  assertCanonicalIntegerString(event.tolerance_lamports, "tolerance_lamports");
  assertCanonicalIntegerString(event.wallet_equity_net_lamports, "wallet_equity_net_lamports", { allowNegative: true });
  assertCanonicalIntegerString(event.component_equity_net_lamports, "component_equity_net_lamports", { allowNegative: true });
  assertCanonicalIntegerString(event.reconciliation_error_lamports, "reconciliation_error_lamports", { allowNegative: true });
  assertCanonicalIntegerString(event.reconciliation_error_abs_lamports, "reconciliation_error_abs_lamports");
  if (typeof event.reconciled !== "boolean") throw new TypeError("reconciled must be a boolean");
  assertMetadata(event.metadata);
}

function validateReconciliationClearedEvent(event) {
  assertExactKeys(event, [
    "schema_version", "event_id", "event_type", "lifecycle_id", "occurred_at",
    "reconciliation_id", "reason",
  ], "reconciliation_cleared event");
  assertCanonicalIdentifier(event.reconciliation_id, "reconciliation_id");
  assertReason(event.reason);
}

function validateTransactionReconciledEvent(event) {
  assertExactKeys(event, [
    "schema_version", "event_id", "event_type", "lifecycle_id", "occurred_at",
    "signature", "reconciliation_id", "original_event_id", "amounts", "token_deltas", "metadata",
  ], "transaction_reconciled event");
  assertCanonicalIdentifier(event.signature, "signature");
  assertCanonicalIdentifier(event.reconciliation_id, "reconciliation_id");
  assertCanonicalIdentifier(event.original_event_id, "original_event_id");
  validateAmounts(event.amounts);
  validateTokenDeltas(event.token_deltas);
  assertMetadata(event.metadata);
  validateTokenAccountEvidence(event.metadata);
}

/** Validate the complete persisted schema without adding defaults or coercions. */
function validateLedgerEvent(event) {
  validateBaseEvent(event);
  switch (event.event_type) {
    case LEDGER_EVENT_TYPES.LIFECYCLE_CREATED:
      validateLifecycleCreatedEvent(event);
      break;
    case LEDGER_EVENT_TYPES.STATE_TRANSITION:
      validateStateTransitionEvent(event);
      break;
    case LEDGER_EVENT_TYPES.TRANSACTION_RECORDED:
      validateTransactionEvent(event);
      break;
    case LEDGER_EVENT_TYPES.BASIS_OBSERVED:
      validateBasisObservationEvent(event);
      break;
    case LEDGER_EVENT_TYPES.VALUATION_RECORDED:
      validateValuationEvent(event);
      break;
    case LEDGER_EVENT_TYPES.SETTLEMENT_FINALIZED:
      validateSettlementEvent(event);
      break;
    case LEDGER_EVENT_TYPES.RECONCILIATION_CLEARED:
      validateReconciliationClearedEvent(event);
      break;
    case LEDGER_EVENT_TYPES.TRANSACTION_RECONCILED:
      validateTransactionReconciledEvent(event);
      break;
    default:
      throw new Error(`Unknown ledger event_type: ${event.event_type}`);
  }
  return event;
}

function zeroAmounts() {
  return Object.fromEntries(AMOUNT_FIELDS.map((field) => [field, 0n]));
}

function addTransactionAmounts(totals, amounts) {
  for (const field of AMOUNT_FIELDS) totals[field] += BigInt(amounts[field]);
}

function amountsToStrings(amounts) {
  return Object.fromEntries(AMOUNT_FIELDS.map((field) => [field, amounts[field].toString()]));
}

/**
 * Gross LP result before execution fees, swap loss, and rent economics.
 * Withdrawal values must be recorded before swap execution loss; swap loss is
 * recorded separately in swap_cost_lamports.
 */
export function calculateGrossPositionPnlLamports({
  deposit_lamports = 0,
  withdrawal_lamports = 0,
  claimed_fee_lamports = 0,
  residual_token_value_lamports = 0,
} = {}) {
  return integerBigInt(withdrawal_lamports, "withdrawal_lamports")
    + integerBigInt(claimed_fee_lamports, "claimed_fee_lamports")
    + integerBigInt(residual_token_value_lamports, "residual_token_value_lamports")
    - integerBigInt(deposit_lamports, "deposit_lamports");
}

/** Component-derived net result used to reconcile the authoritative wallet delta. */
export function calculateComponentEquityNetLamports({
  deposit_lamports = 0,
  withdrawal_lamports = 0,
  claimed_fee_lamports = 0,
  residual_token_value_lamports = 0,
  tx_fee_lamports = 0,
  swap_cost_lamports = 0,
  rent_created_lamports = 0,
  rent_reclaimed_lamports = 0,
  reclaimable_rent_lamports = 0,
} = {}) {
  return calculateGrossPositionPnlLamports({
    deposit_lamports,
    withdrawal_lamports,
    claimed_fee_lamports,
    residual_token_value_lamports,
  })
    - integerBigInt(tx_fee_lamports, "tx_fee_lamports")
    - integerBigInt(swap_cost_lamports, "swap_cost_lamports")
    - integerBigInt(rent_created_lamports, "rent_created_lamports")
    + integerBigInt(rent_reclaimed_lamports, "rent_reclaimed_lamports")
    + integerBigInt(reclaimable_rent_lamports, "reclaimable_rent_lamports");
}

/** Wallet-equity result: liquid delta plus marked residue and recoverable rent. */
export function calculateRealizedEquityNetLamports({
  liquid_wallet_delta_lamports = 0,
  residual_token_value_lamports = 0,
  reclaimable_rent_lamports = 0,
} = {}) {
  return integerBigInt(liquid_wallet_delta_lamports, "liquid_wallet_delta_lamports", { allowNegative: true })
    + integerBigInt(residual_token_value_lamports, "residual_token_value_lamports")
    + integerBigInt(reclaimable_rent_lamports, "reclaimable_rent_lamports");
}

/** Pre-transaction estimate using the same economic component model as settlement. */
export function calculateProjectedEquityNetLamports({
  deployed_lamports = 0,
  projected_withdrawal_lamports = 0,
  projected_claim_lamports = 0,
  projected_residual_token_value_lamports = 0,
  projected_tx_cost_lamports = 0,
  projected_swap_cost_lamports = 0,
  projected_cleanup_cost_lamports = 0,
  rent_created_lamports = 0,
  projected_rent_reclaimed_lamports = 0,
} = {}) {
  return calculateComponentEquityNetLamports({
    deposit_lamports: deployed_lamports,
    withdrawal_lamports: projected_withdrawal_lamports,
    claimed_fee_lamports: projected_claim_lamports,
    residual_token_value_lamports: projected_residual_token_value_lamports,
    tx_fee_lamports: integerBigInt(projected_tx_cost_lamports, "projected_tx_cost_lamports")
      + integerBigInt(projected_cleanup_cost_lamports, "projected_cleanup_cost_lamports"),
    swap_cost_lamports: projected_swap_cost_lamports,
    rent_created_lamports,
    rent_reclaimed_lamports: projected_rent_reclaimed_lamports,
  });
}

export function reconcileLedgerAmounts(amounts, {
  residual_token_value_lamports = 0,
  reclaimable_rent_lamports = 0,
  tolerance_lamports = 10_000,
} = {}) {
  const residual = integerBigInt(residual_token_value_lamports, "residual_token_value_lamports");
  const reclaimableRent = integerBigInt(reclaimable_rent_lamports, "reclaimable_rent_lamports");
  const tolerance = integerBigInt(tolerance_lamports, "tolerance_lamports");
  const walletNet = calculateRealizedEquityNetLamports({
    liquid_wallet_delta_lamports: amounts?.liquid_wallet_delta_lamports ?? 0,
    residual_token_value_lamports: residual,
    reclaimable_rent_lamports: reclaimableRent,
  });
  const componentNet = calculateComponentEquityNetLamports({
    ...amounts,
    residual_token_value_lamports: residual,
    reclaimable_rent_lamports: reclaimableRent,
  });
  const error = walletNet - componentNet;
  return {
    wallet_equity_net_lamports: walletNet.toString(),
    component_equity_net_lamports: componentNet.toString(),
    reconciliation_error_lamports: error.toString(),
    reconciliation_error_abs_lamports: absolute(error).toString(),
    tolerance_lamports: tolerance.toString(),
    reconciled: absolute(error) <= tolerance,
  };
}

/**
 * Receipt-proven deposits are the only historical cost basis available for a
 * DLMM position.  A position account can prove its current shape, but it does
 * not store historical deposited SOL, so observations are optional validation
 * only and must never manufacture an otherwise missing basis.
 */
export function evaluateCostBasisReadiness({
  expected_deposit_lamports,
  expected_layers,
  deposit_transactions = [],
  basis_observations = [],
  required_stable_reads = 2,
  layer_tolerance_lamports = 1,
  observation_tolerance_lamports = 1,
  external_tolerance_lamports = 1,
} = {}) {
  const expected = integerBigInt(expected_deposit_lamports, "expected_deposit_lamports");
  const layers = normalizeExpectedLayers(expected_layers, expected.toString());
  const layerTolerance = integerBigInt(layer_tolerance_lamports, "layer_tolerance_lamports");
  const observationTolerance = integerBigInt(observation_tolerance_lamports, "observation_tolerance_lamports");
  const externalTolerance = integerBigInt(external_tolerance_lamports, "external_tolerance_lamports");
  if (!Number.isInteger(required_stable_reads) || required_stable_reads < 0) {
    throw new RangeError("required_stable_reads must be a non-negative integer");
  }

  const confirmedByLayer = new Map(layers.map((layer) => [layer.layer_id, 0n]));
  let confirmedTotal = 0n;
  for (const tx of deposit_transactions) {
    if (!CONFIRMED_COMMITMENTS.has(tx?.commitment ?? "confirmed")) continue;
    if ((tx?.execution_status ?? "succeeded") !== "succeeded") continue;
    const amount = integerBigInt(
      tx?.deposit_lamports ?? tx?.amounts?.deposit_lamports ?? 0,
      "deposit_transactions.deposit_lamports",
    );
    if (amount === 0n) continue;
    const layerId = normalizeIdentifier(tx?.layer_id, "deposit_transactions.layer_id");
    confirmedTotal += amount;
    confirmedByLayer.set(layerId, (confirmedByLayer.get(layerId) ?? 0n) + amount);
  }

  const layerStatus = layers.map((layer) => {
    const confirmed = confirmedByLayer.get(layer.layer_id) ?? 0n;
    const layerExpected = BigInt(layer.expected_deposit_lamports);
    return {
      layer_id: layer.layer_id,
      expected_deposit_lamports: layerExpected.toString(),
      confirmed_deposit_lamports: confirmed.toString(),
      complete: absolute(confirmed - layerExpected) <= layerTolerance,
    };
  });
  const allLayersComplete = layerStatus.every((layer) => layer.complete);
  const totalComplete = absolute(confirmedTotal - expected) <= layerTolerance;

  const rpcObservations = basis_observations.filter((observation) => (
    observation?.source === "rpc" && CONFIRMED_COMMITMENTS.has(observation?.commitment ?? "confirmed")
  ));
  let stableRpcReads = 0;
  for (let index = rpcObservations.length - 1; index >= 0; index--) {
    const observed = integerBigInt(rpcObservations[index]?.deposit_lamports, "basis_observations.deposit_lamports");
    if (absolute(observed - confirmedTotal) > observationTolerance) break;
    stableRpcReads++;
  }
  const rpcStable = required_stable_reads === 0 || stableRpcReads >= required_stable_reads;
  const ready = expected > 0n && allLayersComplete && totalComplete && rpcStable;

  const externalObservations = basis_observations.filter((observation) => observation?.source === "external");
  const latestExternal = externalObservations.at(-1) ?? null;
  const latestExternalBasis = latestExternal
    ? integerBigInt(latestExternal.deposit_lamports, "basis_observations.deposit_lamports")
    : null;
  const externalAccepted = latestExternalBasis != null
    && ready
    && absolute(latestExternalBasis - confirmedTotal) <= externalTolerance;

  const reasonCodes = [];
  if (expected <= 0n) reasonCodes.push("EXPECTED_BASIS_MISSING");
  if (!allLayersComplete) reasonCodes.push("EXPECTED_LAYERS_INCOMPLETE");
  if (!totalComplete) reasonCodes.push("LOCAL_BASIS_TOTAL_MISMATCH");
  if (!rpcStable) reasonCodes.push("RPC_BASIS_NOT_STABLE");

  return {
    ready,
    source: ready ? "position_bound_confirmed_receipts" : null,
    usable_basis_lamports: ready ? confirmedTotal.toString() : null,
    local_confirmed_basis_lamports: confirmedTotal.toString(),
    expected_deposit_lamports: expected.toString(),
    all_layers_complete: allLayersComplete,
    total_complete: totalComplete,
    stable_rpc_reads: stableRpcReads,
    required_stable_reads,
    layer_status: layerStatus,
    external: {
      observed_basis_lamports: latestExternalBasis?.toString() ?? null,
      accepted: externalAccepted,
      reason: latestExternalBasis == null
        ? "not_observed"
        : externalAccepted
          ? "matches_complete_local_basis"
          : ready
            ? "does_not_match_complete_local_basis"
            : "local_basis_not_ready",
    },
    reason_codes: reasonCodes,
  };
}

export function calculateGuardedPnl({
  cost_basis,
  current_position_value_lamports = 0,
  realized_withdrawal_lamports = 0,
  claimed_fee_lamports = 0,
} = {}) {
  if (!cost_basis?.ready || cost_basis.usable_basis_lamports == null) {
    return {
      ready: false,
      basis_lamports: null,
      pnl_lamports: null,
      pnl_bps: null,
      reason_codes: cost_basis?.reason_codes ?? ["COST_BASIS_NOT_READY"],
    };
  }
  const basis = integerBigInt(cost_basis.usable_basis_lamports, "cost_basis.usable_basis_lamports");
  const proceeds = integerBigInt(current_position_value_lamports, "current_position_value_lamports")
    + integerBigInt(realized_withdrawal_lamports, "realized_withdrawal_lamports")
    + integerBigInt(claimed_fee_lamports, "claimed_fee_lamports");
  const pnl = proceeds - basis;
  return {
    ready: true,
    basis_lamports: basis.toString(),
    pnl_lamports: pnl.toString(),
    pnl_bps: basis > 0n ? ((pnl * 10_000n) / basis).toString() : null,
    reason_codes: [],
  };
}

function assertSettlementMatchesAggregate(event, totals) {
  const expected = reconcileLedgerAmounts(amountsToStrings(totals), {
    residual_token_value_lamports: event.residual_token_value_lamports,
    reclaimable_rent_lamports: event.reclaimable_rent_lamports,
    tolerance_lamports: event.tolerance_lamports,
  });
  for (const field of [
    "wallet_equity_net_lamports",
    "component_equity_net_lamports",
    "reconciliation_error_lamports",
    "reconciliation_error_abs_lamports",
    "tolerance_lamports",
    "reconciled",
  ]) {
    if (event[field] !== expected[field]) {
      throw new Error(`Settlement ${field} does not match lifecycle aggregate`);
    }
  }
  const expectedOutcome = expected.reconciled
    ? LIFECYCLE_STATES.SETTLED
    : LIFECYCLE_STATES.RECONCILIATION_REQUIRED;
  if (event.outcome_state !== expectedOutcome) {
    throw new Error(`Settlement outcome_state does not match reconciliation result`);
  }
}

function evaluateLifecycleCostBasis(created, transactions, observations) {
  return evaluateCostBasisReadiness({
    expected_deposit_lamports: created.expected_deposit_lamports,
    expected_layers: created.expected_layers,
    deposit_transactions: transactions
      .filter((transaction) => transaction.phase === "deploy")
      .map((transaction) => ({
        layer_id: transaction.layer_id,
        commitment: transaction.commitment,
        execution_status: transaction.execution_status,
        deposit_lamports: transaction.amounts.deposit_lamports,
      })),
    basis_observations: observations,
    required_stable_reads: created.required_stable_basis_reads,
    layer_tolerance_lamports: created.layer_tolerance_lamports,
    observation_tolerance_lamports: created.observation_tolerance_lamports,
    external_tolerance_lamports: created.external_tolerance_lamports,
  });
}

export function aggregateLedgerEvents(events, lifecycleId = null) {
  const selected = lifecycleId == null
    ? events
    : events.filter((event) => event.lifecycle_id === lifecycleId);
  if (!selected.length) return null;

  let created = null;
  let state = null;
  let latestValuation = null;
  let latestSettlement = null;
  const transactions = [];
  const transactionIndexesBySignature = new Map();
  const observations = [];
  const totals = zeroAmounts();
  const tokenRawDeltas = new Map();
  const signatures = new Set();
  const eventIds = new Set();
  let reconciliationLatched = false;
  const reconciliationHistory = [];
  let lastOccurredAt = null;

  for (const rawEvent of selected) {
    const event = validateLedgerEvent(rawEvent);
    if (eventIds.has(event.event_id)) throw new Error(`Duplicate event_id in lifecycle: ${event.event_id}`);
    eventIds.add(event.event_id);
    if (created && event.lifecycle_id !== created.lifecycle_id) {
      throw new Error("aggregateLedgerEvents requires events from exactly one lifecycle");
    }
    if (lastOccurredAt != null && event.occurred_at < lastOccurredAt) {
      throw new Error(`Invalid replay chronology for ${event.lifecycle_id}: ${event.occurred_at} precedes ${lastOccurredAt}`);
    }
    lastOccurredAt = event.occurred_at;
    if (created && state === LIFECYCLE_STATES.SETTLED) {
      throw new Error(`Lifecycle ${event.lifecycle_id} has an event after settlement`);
    }
    switch (event.event_type) {
      case LEDGER_EVENT_TYPES.LIFECYCLE_CREATED:
        if (created) throw new Error(`Duplicate lifecycle_created event for ${event.lifecycle_id}`);
        created = event;
        state = LIFECYCLE_STATES.PENDING_DEPLOY;
        break;
      case LEDGER_EVENT_TYPES.STATE_TRANSITION:
        if (!created) throw new Error(`Lifecycle ${event.lifecycle_id} has events before lifecycle_created`);
        if (event.from_state !== state) {
          throw new Error(`Invalid replay transition for ${event.lifecycle_id}: expected ${state}, got ${event.from_state}`);
        }
        if (reconciliationLatched && event.to_state !== LIFECYCLE_STATES.RECONCILIATION_REQUIRED) {
          throw new Error(`Lifecycle ${event.lifecycle_id} has an unresolved reconciliation latch`);
        }
        if (event.to_state === LIFECYCLE_STATES.ACTIVE && !evaluateLifecycleCostBasis(created, transactions, observations).ready) {
          throw new Error(`Cannot activate ${event.lifecycle_id}: cost basis not ready`);
        }
        state = event.to_state;
        if (event.to_state === LIFECYCLE_STATES.RECONCILIATION_REQUIRED) {
          reconciliationLatched = true;
          reconciliationHistory.push({
            type: "latched",
            occurred_at: event.occurred_at,
            reason: event.reason ?? null,
            event_id: event.event_id,
          });
        }
        break;
      case LEDGER_EVENT_TYPES.TRANSACTION_RECORDED:
        if (!created) throw new Error(`Lifecycle ${event.lifecycle_id} has events before lifecycle_created`);
        assertTransactionPhaseAllowed(event.phase, state, event.lifecycle_id);
        if (signatures.has(event.signature)) throw new Error(`Duplicate transaction signature in lifecycle: ${event.signature}`);
        signatures.add(event.signature);
        transactionIndexesBySignature.set(event.signature, transactions.length);
        transactions.push(event);
        addTransactionAmounts(totals, event.amounts);
        for (const delta of event.token_deltas) {
          tokenRawDeltas.set(delta.mint, (tokenRawDeltas.get(delta.mint) ?? 0n) + BigInt(delta.raw_amount));
        }
        break;
      case LEDGER_EVENT_TYPES.TRANSACTION_RECONCILED: {
        if (!created) throw new Error(`Lifecycle ${event.lifecycle_id} has events before lifecycle_created`);
        if (state !== LIFECYCLE_STATES.RECONCILIATION_REQUIRED || !reconciliationLatched) {
          throw new Error(`Transaction reconciliation requires a latched RECONCILIATION_REQUIRED lifecycle for ${event.lifecycle_id}`);
        }
        const transactionIndex = transactionIndexesBySignature.get(event.signature);
        if (transactionIndex == null) {
          throw new Error(`Transaction reconciliation references an unknown signature for ${event.lifecycle_id}: ${event.signature}`);
        }
        const original = transactions[transactionIndex];
        if (original.event_id !== event.original_event_id ||
            !new Set(["deploy", "close"]).has(original.phase) ||
            original.execution_status !== "succeeded") {
          throw new Error(`Transaction reconciliation does not bind the original successful deploy/close receipt for ${event.lifecycle_id}`);
        }
        for (const field of AMOUNT_FIELDS) totals[field] -= BigInt(original.amounts[field]);
        for (const delta of original.token_deltas) {
          tokenRawDeltas.set(delta.mint, (tokenRawDeltas.get(delta.mint) ?? 0n) - BigInt(delta.raw_amount));
        }
        const replacement = {
          ...original,
          amounts: event.amounts,
          token_deltas: event.token_deltas,
          metadata: event.metadata,
          reconciliation_id: event.reconciliation_id,
          reconciled_at: event.occurred_at,
        };
        transactions[transactionIndex] = replacement;
        addTransactionAmounts(totals, replacement.amounts);
        for (const delta of replacement.token_deltas) {
          tokenRawDeltas.set(delta.mint, (tokenRawDeltas.get(delta.mint) ?? 0n) + BigInt(delta.raw_amount));
        }
        break;
      }
      case LEDGER_EVENT_TYPES.BASIS_OBSERVED:
        if (!created) throw new Error(`Lifecycle ${event.lifecycle_id} has events before lifecycle_created`);
        observations.push(event);
        break;
      case LEDGER_EVENT_TYPES.VALUATION_RECORDED:
        if (!created) throw new Error(`Lifecycle ${event.lifecycle_id} has events before lifecycle_created`);
        latestValuation = event;
        break;
      case LEDGER_EVENT_TYPES.SETTLEMENT_FINALIZED:
        if (!created) throw new Error(`Lifecycle ${event.lifecycle_id} has events before lifecycle_created`);
        if (event.from_state !== state) {
          throw new Error(`Invalid settlement state for ${event.lifecycle_id}: expected ${state}, got ${event.from_state}`);
        }
        if (reconciliationLatched) {
          throw new Error(`Cannot settle ${event.lifecycle_id} while reconciliation is latched`);
        }
        assertSettlementMatchesAggregate(event, totals);
        latestSettlement = event;
        state = event.outcome_state;
        if (event.outcome_state === LIFECYCLE_STATES.RECONCILIATION_REQUIRED) {
          reconciliationLatched = true;
          reconciliationHistory.push({
            type: "latched",
            occurred_at: event.occurred_at,
            reason: "settlement reconciliation failed",
            event_id: event.event_id,
          });
        }
        break;
      case LEDGER_EVENT_TYPES.RECONCILIATION_CLEARED:
        if (!created) throw new Error(`Lifecycle ${event.lifecycle_id} has events before lifecycle_created`);
        if (!reconciliationLatched) {
          throw new Error(`Reconciliation clear without an active latch for ${event.lifecycle_id}`);
        }
        if (state !== LIFECYCLE_STATES.RECONCILIATION_REQUIRED) {
          throw new Error(`Reconciliation clear requires RECONCILIATION_REQUIRED state for ${event.lifecycle_id}`);
        }
        reconciliationLatched = false;
        reconciliationHistory.push({
          type: "cleared",
          occurred_at: event.occurred_at,
          reason: event.reason ?? null,
          reconciliation_id: event.reconciliation_id,
          event_id: event.event_id,
        });
        break;
      default:
        throw new Error(`Unsupported event type: ${event.event_type}`);
    }
  }

  if (!created) throw new Error("Lifecycle is missing lifecycle_created event");
  const residual = latestSettlement?.residual_token_value_lamports
    ?? latestValuation?.residual_token_value_lamports
    ?? "0";
  const reclaimableRent = latestSettlement?.reclaimable_rent_lamports
    ?? latestValuation?.reclaimable_rent_lamports
    ?? "0";
  const amountStrings = amountsToStrings(totals);
  const reconciliation = reconcileLedgerAmounts(amountStrings, {
    residual_token_value_lamports: residual,
    reclaimable_rent_lamports: reclaimableRent,
    tolerance_lamports: latestSettlement?.tolerance_lamports ?? 10_000,
  });
  const costBasis = evaluateLifecycleCostBasis(created, transactions, observations);
  const grossPnl = calculateGrossPositionPnlLamports({
    ...amountStrings,
    residual_token_value_lamports: residual,
  });

  return {
    schema_version: LEDGER_SCHEMA_VERSION,
    lifecycle_id: created.lifecycle_id,
    position_address: created.position_address,
    pool_address: created.pool_address,
    state,
    reconciliation_latched: reconciliationLatched,
    reconciliation_history: reconciliationHistory,
    created_at: created.occurred_at,
    event_count: selected.length,
    transaction_count: transactions.length,
    signatures: [...signatures],
    amounts: amountStrings,
    token_raw_deltas: Object.fromEntries([...tokenRawDeltas].map(([mint, amount]) => [mint, amount.toString()])),
    residual_token_value_lamports: String(residual),
    reclaimable_rent_lamports: String(reclaimableRent),
    gross_position_pnl_lamports: grossPnl.toString(),
    wallet_equity_net_lamports: reconciliation.wallet_equity_net_lamports,
    component_equity_net_lamports: reconciliation.component_equity_net_lamports,
    reconciliation,
    cost_basis: costBasis,
    latest_valuation: latestValuation,
    settlement: latestSettlement,
    metadata: created.metadata ?? {},
  };
}

function parseTradeLedgerEvents(bytes, filePath) {
  const text = Buffer.from(bytes).toString("utf8");
  // A syntactically valid final object without its delimiter can be a torn
  // append.  Treat it as corrupt rather than permitting a later append to
  // make a truncated journal look complete.
  if (text.length > 0 && !text.endsWith("\n")) {
    throw new Error(`Invalid trade ledger JSONL at ${filePath}: final record is not newline terminated`);
  }
  const events = [];
  const eventIds = new Set();
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      const event = validateLedgerEvent(JSON.parse(line));
      if (eventIds.has(event.event_id)) throw new Error(`Duplicate event_id: ${event.event_id}`);
      eventIds.add(event.event_id);
      events.push(event);
    } catch (error) {
      throw new Error(`Invalid trade ledger JSONL at ${filePath}:${index + 1}: ${error.message}`, { cause: error });
    }
  }
  return events;
}

function validateLedgerEventStream(events) {
  const signatures = new Set();
  const lifecycleEvents = new Map();
  for (const event of events) {
    validateLedgerEvent(event);
    const bucket = lifecycleEvents.get(event.lifecycle_id) || [];
    bucket.push(event);
    lifecycleEvents.set(event.lifecycle_id, bucket);
    if (event.event_type === LEDGER_EVENT_TYPES.TRANSACTION_RECORDED) {
      if (signatures.has(event.signature)) {
        throw new Error(`Duplicate transaction signature in ledger: ${event.signature}`);
      }
      signatures.add(event.signature);
    }
  }
  // Index once, then replay each lifecycle's compact bucket. Filtering the
  // complete stream once per lifecycle made a full validation quadratic while
  // the global append lease was held.
  for (const [lifecycleId, eventsForLifecycle] of lifecycleEvents) {
    aggregateLedgerEvents(eventsForLifecycle, lifecycleId);
  }
  return events;
}

export function readTradeLedgerEvents(filePath = DEFAULT_TRADE_LEDGER_FILE, { fsImpl = fs } = {}) {
  const source = readSecureRegularFile(filePath, {
    fsImpl,
    label: "Trade ledger",
    allowMissing: true,
  });
  if (source == null) return [];
  const events = parseTradeLedgerEvents(source.bytes, filePath);
  try {
    return validateLedgerEventStream(events);
  } catch (error) {
    throw new Error(`Invalid trade ledger replay at ${filePath}: ${error.message}`, { cause: error });
  }
}

export class TradeLedger {
  constructor({
    filePath = DEFAULT_TRADE_LEDGER_FILE,
    now = () => new Date(),
    idFactory = () => crypto.randomUUID(),
    durable = true,
    fsImpl = fs,
  } = {}) {
    this.filePath = path.resolve(filePath);
    this.now = now;
    this.idFactory = idFactory;
    this.durable = durable;
    this.fsImpl = fsImpl;
  }

  readEvents({ lifecycle_id = null } = {}) {
    const events = readTradeLedgerEvents(this.filePath, { fsImpl: this.fsImpl });
    return lifecycle_id == null ? events : events.filter((event) => event.lifecycle_id === lifecycle_id);
  }

  getLifecycle(lifecycleId) {
    return aggregateLedgerEvents(this.readEvents({ lifecycle_id: lifecycleId }), lifecycleId);
  }

  findTransaction(lifecycleId, signature) {
    const normalizedLifecycle = normalizeIdentifier(lifecycleId, "lifecycle_id");
    const normalizedSignature = normalizeIdentifier(signature, "signature");
    const lifecycle = this.getLifecycle(normalizedLifecycle);
    if (!lifecycle || !lifecycle.signatures.includes(normalizedSignature)) return null;
    const events = this.readEvents({ lifecycle_id: normalizedLifecycle });
    const original = events.find((event) =>
      event.event_type === LEDGER_EVENT_TYPES.TRANSACTION_RECORDED && event.signature === normalizedSignature,
    );
    if (!original) return null;
    const reconciled = [...events].reverse().find((event) =>
      event.event_type === LEDGER_EVENT_TYPES.TRANSACTION_RECONCILED && event.signature === normalizedSignature,
    );
    return reconciled
      ? {
          ...original,
          amounts: reconciled.amounts,
          token_deltas: reconciled.token_deltas,
          metadata: reconciled.metadata,
          reconciliation_id: reconciled.reconciliation_id,
          reconciled_at: reconciled.occurred_at,
        }
      : original;
  }

  listLifecycles() {
    const events = this.readEvents();
    const ids = [...new Set(events.map((event) => event.lifecycle_id))];
    return ids.map((id) => aggregateLedgerEvents(events, id));
  }

  createLifecycle({
    lifecycle_id,
    position_address = null,
    pool_address,
    expected_deposit_lamports,
    expected_layers = null,
    required_stable_basis_reads = 0,
    layer_tolerance_lamports = 1,
    observation_tolerance_lamports = 1,
    external_tolerance_lamports = 1,
    occurred_at,
    metadata = {},
  }) {
    const lifecycleId = normalizeIdentifier(lifecycle_id, "lifecycle_id");
    if (this.getLifecycle(lifecycleId)) throw new Error(`Lifecycle already exists: ${lifecycleId}`);
    const expected = integerString(expected_deposit_lamports, "expected_deposit_lamports");
    if (BigInt(expected) <= 0n) throw new RangeError("expected_deposit_lamports must be greater than zero");
    if (!Number.isInteger(required_stable_basis_reads) || required_stable_basis_reads < 0) {
      throw new RangeError("required_stable_basis_reads must be a non-negative integer");
    }
    const event = {
      ...makeBaseEvent({
        eventType: LEDGER_EVENT_TYPES.LIFECYCLE_CREATED,
        lifecycleId,
        occurredAt: occurred_at,
        now: this.now,
        idFactory: this.idFactory,
      }),
      position_address: position_address == null ? null : normalizeIdentifier(position_address, "position_address"),
      pool_address: normalizeIdentifier(pool_address, "pool_address"),
      expected_deposit_lamports: expected,
      expected_layers: normalizeExpectedLayers(expected_layers, expected),
      required_stable_basis_reads,
      layer_tolerance_lamports: integerString(layer_tolerance_lamports, "layer_tolerance_lamports"),
      observation_tolerance_lamports: integerString(observation_tolerance_lamports, "observation_tolerance_lamports"),
      external_tolerance_lamports: integerString(external_tolerance_lamports, "external_tolerance_lamports"),
      metadata: jsonSafe(metadata) ?? {},
    };
    this.#append(event);
    return event;
  }

  transitionLifecycle(lifecycleId, toState, { reason = null, occurred_at } = {}) {
    if (!ALL_STATES.has(toState)) throw new Error(`Unknown lifecycle state: ${toState}`);
    const lifecycle = this.#requireLifecycle(lifecycleId);
    if (!ALLOWED_TRANSITIONS[lifecycle.state]?.has(toState)) {
      throw new Error(`Invalid lifecycle transition: ${lifecycle.state} -> ${toState}`);
    }
    if (lifecycle.reconciliation_latched && toState !== LIFECYCLE_STATES.RECONCILIATION_REQUIRED) {
      throw new Error(`Lifecycle ${lifecycleId} has an unresolved reconciliation latch; explicit reconciliation is required before transition`);
    }
    if (toState === LIFECYCLE_STATES.ACTIVE && !lifecycle.cost_basis.ready) {
      throw new Error(`Cannot activate ${lifecycleId}: cost basis not ready (${lifecycle.cost_basis.reason_codes.join(", ")})`);
    }
    const event = {
      ...makeBaseEvent({
        eventType: LEDGER_EVENT_TYPES.STATE_TRANSITION,
        lifecycleId,
        occurredAt: occurred_at,
        now: this.now,
        idFactory: this.idFactory,
      }),
      from_state: lifecycle.state,
      to_state: toState,
      reason: reason == null ? null : String(reason).trim().slice(0, 500),
    };
    this.#append(event);
    return event;
  }

  recordTransaction({
    lifecycle_id,
    signature,
    phase,
    layer_id = null,
    commitment = "confirmed",
    execution_status = "succeeded",
    amounts = {},
    token_deltas = [],
    occurred_at,
    metadata = {},
  }) {
    const lifecycle = this.#requireMutableLifecycle(lifecycle_id);
    if (!TRANSACTION_PHASES.has(phase)) throw new Error(`Unknown transaction phase: ${phase}`);
    assertTransactionPhaseAllowed(phase, lifecycle.state, lifecycle.lifecycle_id);
    if (!CONFIRMED_COMMITMENTS.has(commitment)) {
      throw new Error("Only confirmed or finalized transactions may enter the authoritative ledger");
    }
    if (!new Set(["succeeded", "failed"]).has(execution_status)) {
      throw new Error(`Unknown execution_status: ${execution_status}`);
    }
    const normalizedAmounts = normalizeAmounts(amounts);
    const normalizedLayerId = layer_id == null ? null : normalizeIdentifier(layer_id, "layer_id");
    if (phase === "deploy" && BigInt(normalizedAmounts.deposit_lamports) > 0n && !normalizedLayerId) {
      throw new Error("A successful deploy deposit requires layer_id");
    }
    if (execution_status === "failed") {
      for (const field of [
        "deposit_lamports",
        "withdrawal_lamports",
        "claimed_fee_lamports",
        "swap_cost_lamports",
        "rent_created_lamports",
        "rent_reclaimed_lamports",
      ]) {
        if (BigInt(normalizedAmounts[field]) !== 0n) {
          throw new Error(`Failed transaction cannot record ${field}; only wallet delta and tx fee are allowed`);
        }
      }
    }
    const normalizedTokenDeltas = normalizeTokenDeltas(token_deltas);
    if (execution_status === "failed" && normalizedTokenDeltas.length !== 0) {
      throw new Error("Failed transaction cannot record token_deltas");
    }
    const normalizedSignature = normalizeIdentifier(signature, "signature");
    if (lifecycle.signatures.includes(normalizedSignature)) {
      throw new Error(`Duplicate transaction signature in lifecycle: ${normalizedSignature}`);
    }
    const event = {
      ...makeBaseEvent({
        eventType: LEDGER_EVENT_TYPES.TRANSACTION_RECORDED,
        lifecycleId: lifecycle_id,
        occurredAt: occurred_at,
        now: this.now,
        idFactory: this.idFactory,
      }),
      signature: normalizedSignature,
      phase,
      layer_id: normalizedLayerId,
      commitment,
      execution_status,
      amounts: normalizedAmounts,
      token_deltas: normalizedTokenDeltas,
      metadata: jsonSafe(metadata) ?? {},
    };
    this.#append(event);
    return event;
  }

  recordBasisObservation({
    lifecycle_id,
    source,
    deposit_lamports,
    commitment = "confirmed",
    occurred_at,
    metadata = {},
  }) {
    this.#requireMutableLifecycle(lifecycle_id);
    if (!new Set(["rpc", "external"]).has(source)) throw new Error(`Unknown basis observation source: ${source}`);
    if (source === "rpc" && !CONFIRMED_COMMITMENTS.has(commitment)) {
      throw new Error("RPC basis observations must be confirmed or finalized");
    }
    const event = {
      ...makeBaseEvent({
        eventType: LEDGER_EVENT_TYPES.BASIS_OBSERVED,
        lifecycleId: lifecycle_id,
        occurredAt: occurred_at,
        now: this.now,
        idFactory: this.idFactory,
      }),
      source,
      commitment,
      deposit_lamports: integerString(deposit_lamports, "deposit_lamports"),
      metadata: jsonSafe(metadata) ?? {},
    };
    this.#append(event);
    return event;
  }

  reconcileTransaction({
    lifecycle_id,
    signature,
    reconciliation_id,
    original_event_id,
    amounts,
    token_deltas = [],
    occurred_at,
    metadata = {},
  }) {
    const lifecycle = this.#requireLifecycle(lifecycle_id);
    if (lifecycle.state !== LIFECYCLE_STATES.RECONCILIATION_REQUIRED || !lifecycle.reconciliation_latched) {
      throw new Error(`Transaction reconciliation requires a latched RECONCILIATION_REQUIRED lifecycle: ${lifecycle_id}`);
    }
    const event = {
      ...makeBaseEvent({
        eventType: LEDGER_EVENT_TYPES.TRANSACTION_RECONCILED,
        lifecycleId: lifecycle_id,
        occurredAt: occurred_at,
        now: this.now,
        idFactory: this.idFactory,
      }),
      signature: normalizeIdentifier(signature, "signature"),
      reconciliation_id: normalizeIdentifier(reconciliation_id, "reconciliation_id"),
      original_event_id: normalizeIdentifier(original_event_id, "original_event_id"),
      amounts: normalizeAmounts(amounts),
      token_deltas: normalizeTokenDeltas(token_deltas),
      metadata: jsonSafe(metadata) ?? {},
    };
    this.#append(event);
    return event;
  }

  recordValuation({
    lifecycle_id,
    residual_token_value_lamports = 0,
    reclaimable_rent_lamports = 0,
    source,
    occurred_at,
    metadata = {},
  }) {
    this.#requireMutableLifecycle(lifecycle_id);
    const event = {
      ...makeBaseEvent({
        eventType: LEDGER_EVENT_TYPES.VALUATION_RECORDED,
        lifecycleId: lifecycle_id,
        occurredAt: occurred_at,
        now: this.now,
        idFactory: this.idFactory,
      }),
      source: normalizeIdentifier(source, "source"),
      residual_token_value_lamports: integerString(residual_token_value_lamports, "residual_token_value_lamports"),
      reclaimable_rent_lamports: integerString(reclaimable_rent_lamports, "reclaimable_rent_lamports"),
      metadata: jsonSafe(metadata) ?? {},
    };
    this.#append(event);
    return event;
  }

  finalizeSettlement({
    lifecycle_id,
    residual_token_value_lamports = null,
    reclaimable_rent_lamports = null,
    tolerance_lamports = 10_000,
    occurred_at,
    metadata = {},
  }) {
    const lifecycle = this.#requireLifecycle(lifecycle_id);
    if (![LIFECYCLE_STATES.CLOSING, LIFECYCLE_STATES.CLEANUP_PENDING, LIFECYCLE_STATES.RECONCILIATION_REQUIRED].includes(lifecycle.state)) {
      throw new Error(`Cannot finalize settlement from lifecycle state ${lifecycle.state}`);
    }
    if (lifecycle.reconciliation_latched) {
      throw new Error(`Cannot finalize settlement for ${lifecycle_id}: explicit reconciliation must clear the existing latch first`);
    }
    const residual = residual_token_value_lamports == null
      ? lifecycle.residual_token_value_lamports
      : integerString(residual_token_value_lamports, "residual_token_value_lamports");
    const reclaimableRent = reclaimable_rent_lamports == null
      ? lifecycle.reclaimable_rent_lamports
      : integerString(reclaimable_rent_lamports, "reclaimable_rent_lamports");
    const reconciliation = reconcileLedgerAmounts(lifecycle.amounts, {
      residual_token_value_lamports: residual,
      reclaimable_rent_lamports: reclaimableRent,
      tolerance_lamports,
    });
    const outcomeState = reconciliation.reconciled
      ? LIFECYCLE_STATES.SETTLED
      : LIFECYCLE_STATES.RECONCILIATION_REQUIRED;
    const event = {
      ...makeBaseEvent({
        eventType: LEDGER_EVENT_TYPES.SETTLEMENT_FINALIZED,
        lifecycleId: lifecycle_id,
        occurredAt: occurred_at,
        now: this.now,
        idFactory: this.idFactory,
      }),
      from_state: lifecycle.state,
      outcome_state: outcomeState,
      residual_token_value_lamports: String(residual),
      reclaimable_rent_lamports: String(reclaimableRent),
      tolerance_lamports: reconciliation.tolerance_lamports,
      ...reconciliation,
      metadata: jsonSafe(metadata) ?? {},
    };
    this.#append(event);
    return event;
  }

  assertCostBasisReady(lifecycleId) {
    const lifecycle = this.#requireLifecycle(lifecycleId);
    if (!lifecycle.cost_basis.ready) {
      throw new Error(`Cost basis not ready for ${lifecycleId}: ${lifecycle.cost_basis.reason_codes.join(", ")}`);
    }
    return lifecycle.cost_basis.usable_basis_lamports;
  }

  /**
   * Only an explicit future reconciliation may clear a historical latch. The
   * prior latch remains in the append-only reconciliation_history; this never
   * silently converts a recovered close into an unqualified success.
   */
  clearReconciliationLatch(lifecycleId, {
    reconciliation_id,
    reason = null,
    occurred_at,
  } = {}) {
    const lifecycle = this.#requireLifecycle(lifecycleId);
    if (!lifecycle.reconciliation_latched) {
      throw new Error(`Lifecycle has no reconciliation latch to clear: ${lifecycleId}`);
    }
    const event = {
      ...makeBaseEvent({
        eventType: LEDGER_EVENT_TYPES.RECONCILIATION_CLEARED,
        lifecycleId,
        occurredAt: occurred_at,
        now: this.now,
        idFactory: this.idFactory,
      }),
      reconciliation_id: normalizeIdentifier(reconciliation_id, "reconciliation_id"),
      reason: reason == null ? null : String(reason).trim().slice(0, 500),
    };
    this.#append(event);
    return event;
  }

  #requireLifecycle(lifecycleId) {
    const lifecycle = this.getLifecycle(normalizeIdentifier(lifecycleId, "lifecycle_id"));
    if (!lifecycle) throw new Error(`Unknown lifecycle: ${lifecycleId}`);
    return lifecycle;
  }

  #requireMutableLifecycle(lifecycleId) {
    const lifecycle = this.#requireLifecycle(lifecycleId);
    if (lifecycle.state === LIFECYCLE_STATES.SETTLED) {
      throw new Error(`Lifecycle is already settled: ${lifecycleId}`);
    }
    return lifecycle;
  }

  #append(event) {
    // The lock covers the complete read/validate/append sequence across
    // processes.  A lock is never stolen after a crash, which deliberately
    // leaves a manual-recovery condition instead of risking duplicate receipts.
    let lock = null;
    let opened = null;
    try {
      lock = acquireSecureFileLock(this.filePath, {
        fsImpl: this.fsImpl,
        label: "Trade ledger append",
        lockName: `.${path.basename(this.filePath)}.append.lock`,
        durable: this.durable,
      });
    } catch (error) {
      if (error?.code === "EWOULDBLOCK") {
        const leaseError = new Error(`Trade ledger append lease is unavailable: ${this.filePath}`);
        leaseError.code = "TRADE_LEDGER_APPEND_LEASE_HELD";
        throw leaseError;
      }
      throw error;
    }
    try {
      opened = openSecureRegularFileForAppend(this.filePath, {
        fsImpl: this.fsImpl,
        label: "Trade ledger",
      });
      const events = parseTradeLedgerEvents(this.fsImpl.readFileSync(opened.descriptor), this.filePath);
      const timestampFactory = event[APPEND_TIMESTAMP_FACTORY];
      const implicitTimestamp = typeof timestampFactory === "function";
      delete event[APPEND_TIMESTAMP_FACTORY];
      if (implicitTimestamp) {
        event.occurred_at = normalizeTimestamp(timestampFactory());
      }
      const latestLifecycleTimestamp = events.reduce((latest, existing) => (
        existing.lifecycle_id === event.lifecycle_id && (latest == null || existing.occurred_at > latest)
          ? existing.occurred_at
          : latest
      ), null);
      if (latestLifecycleTimestamp != null && event.occurred_at < latestLifecycleTimestamp) {
        if (!implicitTimestamp) {
          throw new Error(
            `Explicit occurred_at ${event.occurred_at} precedes existing lifecycle chronology ${latestLifecycleTimestamp}`,
          );
        }
        // A locally generated timestamp is assigned only after the append
        // lease is held. Floor that implicit clock skew to append order, but
        // never rewrite caller-supplied historical evidence.
        event.occurred_at = latestLifecycleTimestamp;
      }
      validateLedgerEvent(event);
      if (events.some((existing) => existing.event_id === event.event_id)) {
        throw new Error(`Duplicate event_id: ${event.event_id}`);
      }
      if (event.event_type === LEDGER_EVENT_TYPES.LIFECYCLE_CREATED && events.some((existing) =>
        existing.event_type === LEDGER_EVENT_TYPES.LIFECYCLE_CREATED && existing.lifecycle_id === event.lifecycle_id,
      )) {
        throw new Error(`Lifecycle already exists: ${event.lifecycle_id}`);
      }
      if (event.event_type === LEDGER_EVENT_TYPES.TRANSACTION_RECORDED && events.some((existing) =>
        existing.event_type === LEDGER_EVENT_TYPES.TRANSACTION_RECORDED && existing.signature === event.signature,
      )) {
        throw new Error(`Duplicate transaction signature in ledger: ${event.signature}`);
      }
      if (event.event_type === LEDGER_EVENT_TYPES.TRANSACTION_RECONCILED && events.some((existing) =>
        existing.event_type === LEDGER_EVENT_TYPES.TRANSACTION_RECONCILED && existing.signature === event.signature,
      )) {
        throw new Error(`Transaction signature is already reconciled in ledger: ${event.signature}`);
      }
      if (event.event_type !== LEDGER_EVENT_TYPES.LIFECYCLE_CREATED) {
        const current = aggregateLedgerEvents(events, event.lifecycle_id);
        if (!current) throw new Error(`Unknown lifecycle: ${event.lifecycle_id}`);
        if (current.state === LIFECYCLE_STATES.SETTLED) {
          throw new Error(`Lifecycle is already settled: ${event.lifecycle_id}`);
        }
        if (event.event_type === LEDGER_EVENT_TYPES.STATE_TRANSITION) {
          if (current.state !== event.from_state || !ALLOWED_TRANSITIONS[current.state]?.has(event.to_state)) {
            throw new Error(`Concurrent lifecycle state changed before transition: ${event.lifecycle_id}`);
          }
          if (event.to_state === LIFECYCLE_STATES.ACTIVE && !current.cost_basis.ready) {
            throw new Error(`Cannot activate ${event.lifecycle_id}: cost basis not ready`);
          }
          if (current.reconciliation_latched && event.to_state !== LIFECYCLE_STATES.RECONCILIATION_REQUIRED) {
            throw new Error(`Concurrent lifecycle reconciliation latch blocks transition: ${event.lifecycle_id}`);
          }
        }
        if (event.event_type === LEDGER_EVENT_TYPES.SETTLEMENT_FINALIZED && current.state !== event.from_state) {
          throw new Error(`Concurrent lifecycle state changed before settlement: ${event.lifecycle_id}`);
        }
        if (event.event_type === LEDGER_EVENT_TYPES.SETTLEMENT_FINALIZED && current.reconciliation_latched) {
          throw new Error(`Concurrent lifecycle reconciliation latch blocks settlement: ${event.lifecycle_id}`);
        }
        if (event.event_type === LEDGER_EVENT_TYPES.RECONCILIATION_CLEARED && !current.reconciliation_latched) {
          throw new Error(`Concurrent lifecycle has no reconciliation latch to clear: ${event.lifecycle_id}`);
        }
      }
      validateLedgerEventStream([...events, event]);
      appendOpenedRegularFile(opened, Buffer.from(`${JSON.stringify(event)}\n`, "utf8"), {
        fsImpl: this.fsImpl,
        label: "Trade ledger",
        durable: this.durable,
      });
    } finally {
      if (opened) closeSecureRegularFile(opened, { fsImpl: this.fsImpl });
      if (lock) releaseSecureFileLock(lock, { fsImpl: this.fsImpl, label: "Trade ledger append", durable: this.durable });
    }
  }
}
