import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Connection } from "@solana/web3.js";
import { BorshInstructionCoder } from "@coral-xyz/anchor";
import { IDL as DLMM_IDL } from "@meteora-ag/dlmm";
import bs58 from "bs58";
import { config } from "./config.js";
import { repoPath } from "./repo-root.js";
import {
  acquireSecureFileLock,
  appendOpenedRegularFile,
  closeSecureRegularFile,
  createSecureExclusiveFile,
  openSecureRegularFileForAppend,
  openSecureRegularFileForRead,
  readSecureRegularFile,
  releaseSecureFileLock,
  removeOpenedRegularFile,
  verifyOpenedRegularFile,
  writeOpenedRegularFile,
} from "./durable-file.js";
import {
  LIFECYCLE_STATES,
  TradeLedger,
} from "./trade-ledger.js";
import { updatePositionAccounting } from "./state.js";
import { log } from "./logger.js";

let connection = null;
let ledger = null;

const LIFECYCLE_OPERATION_KINDS = new Set(["deploy", "claim", "close", "cleanup"]);
const LIFECYCLE_OPERATION_PHASES = new Set(["deploy", "claim", "close", "swap", "cleanup"]);
const activeLifecycleOperations = new WeakSet();
const lifecycleOperationDetails = new WeakMap();
const DLMM_PROGRAM_ID = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";
const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
const LEGACY_TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const ASSOCIATED_TOKEN_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const NATIVE_SOL_MINT = String(config.tokens?.SOL || "So11111111111111111111111111111111111111112");
const ALLOWED_DEPLOY_OUTER_PROGRAMS = new Set([
  DLMM_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  "ComputeBudget111111111111111111111111111111",
  LEGACY_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
]);
const DLMM_LIQUIDITY_INSTRUCTIONS = new Set([
  "add_liquidity_by_strategy",
  "add_liquidity_by_strategy2",
]);
const DLMM_SETUP_INSTRUCTIONS = new Set(["initialize_position", "initialize_position2"]);
const dlmmInstructionCoder = new BorshInstructionCoder(DLMM_IDL);
const DLMM_LIQUIDITY_ACCOUNT_ROLES = Object.freeze([
  "position",
  "lb_pair",
  "user_token_x",
  "user_token_y",
  "reserve_x",
  "reserve_y",
  "token_x_mint",
  "token_y_mint",
  "sender",
  "token_x_program",
  "token_y_program",
]);

// Meteora's native-SOL path can leave a tiny, transaction-local WSOL residue
// after applying its liquidity math. The temporary account is then closed and
// that residue returns to the wallet. Keep the configured allowance bounded by
// a hard 0.0001 SOL ceiling; it is evidence tolerance, never deploy sizing.
const HARD_NATIVE_SOL_STRUCTURAL_RESIDUAL_LAMPORTS = 100_000n;

function nativeSolStructuralResidualLimitLamports() {
  const configured = Number(config.ledger?.structuralResidualLamports ?? Number(HARD_NATIVE_SOL_STRUCTURAL_RESIDUAL_LAMPORTS));
  if (!Number.isSafeInteger(configured) || configured < 0) return HARD_NATIVE_SOL_STRUCTURAL_RESIDUAL_LAMPORTS;
  return BigInt(Math.min(configured, Number(HARD_NATIVE_SOL_STRUCTURAL_RESIDUAL_LAMPORTS)));
}

export class LifecycleOperationLeaseError extends Error {
  constructor(message, { code = "LIFECYCLE_OPERATION_LEASE_HELD", cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "LifecycleOperationLeaseError";
    this.code = code;
  }
}

function lifecycleOperationDirectory(store, directory) {
  if (directory) return path.resolve(directory);
  if (!store?.filePath) throw new TypeError("A ledger store with filePath is required for lifecycle operations");
  return path.join(path.dirname(store.filePath), ".meridian-lifecycle-operations");
}

function normalizeLifecycleOperationKind(operation) {
  const normalized = String(operation || "").trim().toLowerCase();
  if (!LIFECYCLE_OPERATION_KINDS.has(normalized)) {
    throw new TypeError(`Unsupported lifecycle operation: ${operation}`);
  }
  return normalized;
}

function lifecycleOperationPhaseAllowed(operation, phase) {
  if (operation === "close") return phase === "claim" || phase === "close";
  if (operation === "cleanup") return phase === "swap" || phase === "cleanup";
  return phase === operation;
}

function normalizeLifecycleOperationResource({ position, operationKey } = {}) {
  const explicit = String(operationKey || "").trim();
  const normalizedPosition = String(position || "").trim();
  const resource = explicit || normalizedPosition;
  if (!resource) throw new TypeError("A lifecycle operation requires position or operationKey");
  if (/\r|\n/.test(resource)) throw new TypeError("Lifecycle operation resource cannot contain line breaks");
  return resource;
}

function lifecycleOperationStem(operation, resource) {
  const digest = crypto.createHash("sha256").update(`${operation}:${resource}`).digest("hex");
  return `${operation}-${digest}`;
}

function lifecycleOperationFiles({ operation, position = null, operationKey = null, store, directory } = {}) {
  const kind = normalizeLifecycleOperationKind(operation);
  const resource = normalizeLifecycleOperationResource({ position, operationKey });
  const dir = lifecycleOperationDirectory(store, directory);
  const stem = lifecycleOperationStem(kind, resource);
  return {
    operation: kind,
    resource,
    leaseFile: path.join(dir, `${stem}.lease`),
    checkpointFile: path.join(dir, `${stem}.jsonl`),
    poisonFile: path.join(dir, `${stem}.jsonl.poison`),
  };
}

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function isNonEmptySingleLineString(value) {
  return typeof value === "string" && value.trim().length > 0 && !/\r|\n/.test(value);
}

function isCanonicalTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value;
}

function isNonNegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function normalizeLifecycleRetentionReason(reason) {
  const normalized = String(reason || "explicit reconciliation required")
    .replace(/[\r\n]+/g, " ")
    .trim()
    .slice(0, 1_000);
  if (!normalized) throw new TypeError("Lifecycle retention reason must be a non-empty single-line string");
  return normalized;
}

function validateLifecycleOperationLease(lease, { operation = null, resource = null } = {}) {
  if (!isPlainObject(lease)) throw new TypeError("lifecycle operation lease must be an object");
  assertExactJournalKeys(lease, ["operation", "operation_id", "resource", "position", "acquired_at", "pid"]);
  if (!LIFECYCLE_OPERATION_KINDS.has(lease.operation)) throw new TypeError("lifecycle operation lease operation is invalid");
  if (!isNonEmptySingleLineString(lease.operation_id)) throw new TypeError("lifecycle operation lease operation_id is invalid");
  if (!isNonEmptySingleLineString(lease.resource)) throw new TypeError("lifecycle operation lease resource is invalid");
  if (lease.position !== null && !isNonEmptySingleLineString(lease.position)) {
    throw new TypeError("lifecycle operation lease position is invalid");
  }
  if (!isCanonicalTimestamp(lease.acquired_at)) throw new TypeError("lifecycle operation lease acquired_at is invalid");
  if (!Number.isSafeInteger(lease.pid) || lease.pid < 1) throw new TypeError("lifecycle operation lease pid is invalid");
  if (operation != null && lease.operation !== operation) throw new TypeError("lifecycle operation lease operation does not match expected operation");
  if (resource != null && lease.resource !== resource) throw new TypeError("lifecycle operation lease resource does not match expected resource");
  return lease;
}

function readOpenedLifecycleOperationLease(opened, { fsImpl = fs, operation = null, resource = null } = {}) {
  verifyOpenedRegularFile(opened, { fsImpl, label: "Lifecycle operation lease" });
  let lease;
  try {
    lease = JSON.parse(fsImpl.readFileSync(opened.descriptor).toString("utf8"));
  } catch (error) {
    throw new TypeError(`Lifecycle operation lease is unreadable or corrupt: ${error.message}`, { cause: error });
  }
  verifyOpenedRegularFile(opened, { fsImpl, label: "Lifecycle operation lease" });
  return validateLifecycleOperationLease(lease, { operation, resource });
}

function sameLifecycleOperationLease(left, right) {
  return left?.operation === right?.operation &&
    left?.operation_id === right?.operation_id &&
    left?.resource === right?.resource &&
    left?.position === right?.position &&
    left?.acquired_at === right?.acquired_at &&
    left?.pid === right?.pid;
}

/**
 * removeOpenedRegularFile can report a parent-directory fsync error after its
 * unlink reached the kernel. Re-create the same O_EXCL poison record before
 * reporting that failed removal so an uncertain release never opens deploys.
 */
function ensureLifecycleOperationLeaseRetained(leaseFile, expectedLease, {
  fsImpl = fs,
  durable = true,
} = {}) {
  const validateExisting = () => {
    const source = readSecureRegularFile(leaseFile, {
      fsImpl,
      label: "Lifecycle operation lease",
      allowMissing: true,
    });
    if (source == null) return false;
    let actual;
    try {
      actual = JSON.parse(source.bytes.toString("utf8"));
    } catch (error) {
      throw new TypeError(`Lifecycle operation lease is unreadable or corrupt: ${error.message}`, { cause: error });
    }
    validateLifecycleOperationLease(actual, {
      operation: expectedLease.operation,
      resource: expectedLease.resource,
    });
    if (!sameLifecycleOperationLease(actual, expectedLease)) {
      throw new TypeError("Lifecycle operation lease identity changed while restoring a failed removal");
    }
    return true;
  };

  if (validateExisting()) return { retained: true, restored: false };
  let replacement = null;
  try {
    try {
      replacement = createSecureExclusiveFile(leaseFile, {
        fsImpl,
        label: "Lifecycle operation lease",
      });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (validateExisting()) return { retained: true, restored: false };
      throw error;
    }
    writeOpenedRegularFile(replacement, Buffer.from(JSON.stringify(expectedLease), "utf8"), {
      fsImpl,
      label: "Lifecycle operation lease",
      durable,
    });
  } finally {
    if (replacement) closeSecureRegularFile(replacement, { fsImpl });
  }
  if (!validateExisting()) throw new Error("Lifecycle operation lease disappeared while restoring failed removal");
  return { retained: true, restored: true };
}

function assertExactJournalKeys(event, keys) {
  const actual = Object.keys(event).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`unexpected fields for lifecycle journal ${event.type || "record"}`);
  }
}

function validateLifecycleJournalEvent(event, { operation = null, resource = null } = {}) {
  if (!isPlainObject(event)) throw new TypeError("lifecycle journal record must be an object");
  if (event.type === "signature_checkpoint") {
    assertExactJournalKeys(event, [
      "type", "operation", "operation_id", "resource", "position", "phase", "signature", "checkpointed_at", "metadata",
    ]);
    if (!LIFECYCLE_OPERATION_KINDS.has(event.operation)) throw new TypeError("checkpoint operation is invalid");
    if (!isNonEmptySingleLineString(event.operation_id)) throw new TypeError("checkpoint operation_id is invalid");
    if (!isNonEmptySingleLineString(event.resource)) throw new TypeError("checkpoint resource is invalid");
    if (!isNonEmptySingleLineString(event.position)) throw new TypeError("checkpoint position is invalid");
    if (!LIFECYCLE_OPERATION_PHASES.has(event.phase)) throw new TypeError("checkpoint phase is invalid");
    if (!lifecycleOperationPhaseAllowed(event.operation, event.phase)) {
      throw new TypeError("checkpoint phase does not match operation");
    }
    if (!isNonEmptySingleLineString(event.signature)) throw new TypeError("checkpoint signature is invalid");
    if (!isCanonicalTimestamp(event.checkpointed_at)) throw new TypeError("checkpoint timestamp is invalid");
    if (!isPlainObject(event.metadata)) throw new TypeError("checkpoint metadata is invalid");
  } else if (event.type === "operation_completed") {
    assertExactJournalKeys(event, [
      "type", "operation", "operation_id", "resource", "position", "phase", "expected_transactions", "position_absent", "completed_at",
    ]);
    if (!LIFECYCLE_OPERATION_KINDS.has(event.operation)) throw new TypeError("completed operation is invalid");
    if (!isNonEmptySingleLineString(event.operation_id)) throw new TypeError("completed operation_id is invalid");
    if (!isNonEmptySingleLineString(event.resource)) throw new TypeError("completed resource is invalid");
    if (!isNonEmptySingleLineString(event.position)) throw new TypeError("completed position is invalid");
    if (!LIFECYCLE_OPERATION_PHASES.has(event.phase)) throw new TypeError("completed phase is invalid");
    if (!Array.isArray(event.expected_transactions) || event.expected_transactions.length === 0) {
      throw new TypeError("completed expected_transactions must be a non-empty array");
    }
    const expected = new Set();
    for (const transaction of event.expected_transactions) {
      if (!isPlainObject(transaction)) throw new TypeError("completed expected transaction is invalid");
      assertExactJournalKeys(transaction, ["phase", "signature"]);
      if (!LIFECYCLE_OPERATION_PHASES.has(transaction.phase)) throw new TypeError("completed expected transaction phase is invalid");
      if (!isNonEmptySingleLineString(transaction.signature)) throw new TypeError("completed expected transaction signature is invalid");
      const key = `${transaction.phase}\u0000${transaction.signature}`;
      if (expected.has(key)) throw new TypeError("completed expected_transactions contains a duplicate receipt");
      expected.add(key);
    }
    const phaseAllowed = (phase) => lifecycleOperationPhaseAllowed(event.operation, phase);
    if (!phaseAllowed(event.phase) || event.expected_transactions.some((transaction) => !phaseAllowed(transaction.phase))) {
      throw new TypeError("completed phase does not match operation");
    }
    if (event.phase === "claim" && event.expected_transactions.some((transaction) => transaction.phase !== "claim")) {
      throw new TypeError("claim completion cannot include a non-claim receipt");
    }
    if (event.operation === "cleanup" && event.phase !== "cleanup") {
      throw new TypeError("cleanup operation completion phase is invalid");
    }
    if (event.phase === "claim" && event.position_absent !== null) {
      throw new TypeError("claim completion cannot assert position absence");
    }
    if (event.operation === "claim" && event.phase !== "claim") {
      throw new TypeError("claim operation completion phase is invalid");
    }
    if (event.operation === "close" && event.phase === "close") {
      if (event.position_absent !== true) throw new TypeError("terminal close completion requires authoritative position absence");
      if (!event.expected_transactions.some((transaction) => transaction.phase === "close")) {
        throw new TypeError("terminal close completion requires a close receipt");
      }
    }
    if (event.operation !== "close" && event.position_absent !== null) {
      throw new TypeError("non-close completion cannot assert position absence");
    }
    if (!isCanonicalTimestamp(event.completed_at)) throw new TypeError("completed timestamp is invalid");
  } else if (event.type === "operation_finalized") {
    assertExactJournalKeys(event, [
      "type", "operation", "operation_id", "resource", "position", "finalized_at",
    ]);
    if (!LIFECYCLE_OPERATION_KINDS.has(event.operation)) throw new TypeError("finalized operation is invalid");
    if (!isNonEmptySingleLineString(event.operation_id)) throw new TypeError("finalized operation_id is invalid");
    if (!isNonEmptySingleLineString(event.resource)) throw new TypeError("finalized resource is invalid");
    if (!isNonEmptySingleLineString(event.position)) {
      throw new TypeError("finalized position is invalid");
    }
    if (!isCanonicalTimestamp(event.finalized_at)) throw new TypeError("finalized timestamp is invalid");
  } else if (event.type === "guard_retained") {
    assertExactJournalKeys(event, [
      "type", "operation", "operation_id", "resource", "position", "retention_id", "reason", "retained_at",
    ]);
    if (event.operation !== "deploy") throw new TypeError("guard retention operation is invalid");
    if (!isNonEmptySingleLineString(event.operation_id)) throw new TypeError("guard retention operation_id is invalid");
    if (!isNonEmptySingleLineString(event.resource)) throw new TypeError("guard retention resource is invalid");
    if (event.position !== null) throw new TypeError("guard retention position must be null");
    if (!isNonEmptySingleLineString(event.retention_id)) throw new TypeError("guard retention id is invalid");
    if (!isNonEmptySingleLineString(event.reason)) throw new TypeError("guard retention reason is invalid");
    if (!isCanonicalTimestamp(event.retained_at)) throw new TypeError("guard retention timestamp is invalid");
  } else if (event.type === "guard_reconciliation_resolved") {
    assertExactJournalKeys(event, [
      "type", "operation", "operation_id", "resource", "position", "retention_id", "reconciliation_id", "outcome",
      "observation_source", "observed_at", "live_position_count", "journal_event_count", "resolved_at",
    ]);
    if (event.operation !== "deploy") throw new TypeError("guard reconciliation operation is invalid");
    if (!isNonEmptySingleLineString(event.operation_id)) throw new TypeError("guard reconciliation operation_id is invalid");
    if (!isNonEmptySingleLineString(event.resource)) throw new TypeError("guard reconciliation resource is invalid");
    if (event.position !== null) throw new TypeError("guard reconciliation position must be null");
    if (!isNonEmptySingleLineString(event.retention_id)) throw new TypeError("guard reconciliation retention id is invalid");
    if (!isNonEmptySingleLineString(event.reconciliation_id)) throw new TypeError("guard reconciliation id is invalid");
    if (event.outcome !== "no_live_canary_positions") throw new TypeError("guard reconciliation outcome is invalid");
    if (!isNonEmptySingleLineString(event.observation_source)) throw new TypeError("guard reconciliation observation source is invalid");
    if (!isCanonicalTimestamp(event.observed_at)) throw new TypeError("guard reconciliation observation timestamp is invalid");
    if (event.live_position_count !== 0) throw new TypeError("guard reconciliation requires zero live positions");
    if (!isNonNegativeSafeInteger(event.journal_event_count)) throw new TypeError("guard reconciliation journal count is invalid");
    if (!isCanonicalTimestamp(event.resolved_at)) throw new TypeError("guard reconciliation timestamp is invalid");
  } else {
    throw new TypeError("lifecycle journal record type is invalid");
  }
  if (operation != null && event.operation !== operation) {
    throw new TypeError("lifecycle journal operation does not match its lease");
  }
  if (resource != null && event.resource !== resource) {
    throw new TypeError("lifecycle journal resource does not match its lease");
  }
  return event;
}

function lifecycleOperationPoisonFile(checkpointFile) {
  return `${checkpointFile}.poison`;
}

function validateLifecycleOperationPoison(poison, { operation = null, resource = null } = {}) {
  if (!isPlainObject(poison)) throw new TypeError("lifecycle operation poison record must be an object");
  assertExactJournalKeys(poison, ["operation", "operation_id", "resource", "position", "poisoned_at", "reason"]);
  if (!LIFECYCLE_OPERATION_KINDS.has(poison.operation)) throw new TypeError("lifecycle operation poison operation is invalid");
  if (!isNonEmptySingleLineString(poison.operation_id)) throw new TypeError("lifecycle operation poison operation_id is invalid");
  if (!isNonEmptySingleLineString(poison.resource)) throw new TypeError("lifecycle operation poison resource is invalid");
  if (poison.position !== null && !isNonEmptySingleLineString(poison.position)) {
    throw new TypeError("lifecycle operation poison position is invalid");
  }
  if (!isCanonicalTimestamp(poison.poisoned_at)) throw new TypeError("lifecycle operation poison timestamp is invalid");
  if (!isNonEmptySingleLineString(poison.reason)) throw new TypeError("lifecycle operation poison reason is invalid");
  if (operation != null && poison.operation !== operation) throw new TypeError("lifecycle operation poison does not match its lease");
  if (resource != null && poison.resource !== resource) throw new TypeError("lifecycle operation poison does not match its lease");
  return poison;
}

function assertLifecycleOperationJournalNotPoisoned(checkpointFile, fsImpl = fs, context = {}) {
  const poisonFile = lifecycleOperationPoisonFile(checkpointFile);
  const source = readSecureRegularFile(poisonFile, {
    fsImpl,
    label: "Lifecycle operation journal poison",
    allowMissing: true,
  });
  if (source == null) return;
  let poison;
  try {
    poison = validateLifecycleOperationPoison(JSON.parse(source.bytes.toString("utf8")), context);
  } catch (error) {
    throw new LifecycleOperationLeaseError(
      `Lifecycle operation journal is permanently fail-closed: ${error.message}`,
      { code: "LIFECYCLE_OPERATION_POISONED", cause: error },
    );
  }
  throw new LifecycleOperationLeaseError(
    `Lifecycle operation ${poison.operation_id} is permanently fail-closed after an ownership race.`,
    { code: "LIFECYCLE_OPERATION_POISONED" },
  );
}

function operationJournalState(events, operationId) {
  const current = events.filter((event) => event.operation_id === operationId);
  const ordinary = current.filter((event) => !["guard_retained", "guard_reconciliation_resolved"].includes(event.type));
  const positions = [...new Set(ordinary.map((event) => event.position).filter((position) => position != null))];
  if (positions.length > 1) {
    throw new Error(`Lifecycle operation journal has conflicting positions for ${operationId}`);
  }
  return {
    events: current,
    finalized: ordinary.some((event) => event.type === "operation_finalized"),
    position: positions[0] || null,
  };
}

/** Validate the complete append-only lifecycle stream, not only each row. */
function validateLifecycleJournalStream(events) {
  const states = new Map();
  let journalKind = null;
  const stateFor = (event) => {
    let state = states.get(event.operation_id);
    if (!state) {
      state = {
        operation: event.operation,
        resource: event.resource,
        kind: null,
        position: null,
        checkpoints: new Set(),
        checkpointPhases: new Set(),
        completions: new Map(),
        finalized: false,
        guardRetention: null,
        guardResolved: false,
      };
      states.set(event.operation_id, state);
    }
    return state;
  };

  for (const event of events) {
    const isGuard = event.type === "guard_retained" || event.type === "guard_reconciliation_resolved";
    if (journalKind == null) journalKind = isGuard ? "guard" : "ordinary";
    if (journalKind !== (isGuard ? "guard" : "ordinary")) {
      throw new Error("Lifecycle operation journal cannot mix guard and ordinary operation records");
    }

    const state = stateFor(event);
    if (state.operation !== event.operation || state.resource !== event.resource) {
      throw new Error(`Lifecycle operation journal has conflicting operation identity for ${event.operation_id}`);
    }
    if (state.kind == null) state.kind = isGuard ? "guard" : "ordinary";
    if (state.kind !== (isGuard ? "guard" : "ordinary")) {
      throw new Error(`Lifecycle operation journal mixes guard and ordinary records for ${event.operation_id}`);
    }

    if (isGuard) {
      if (event.type === "guard_retained") {
        if (state.guardRetention || state.guardResolved) {
          throw new Error(`Lifecycle guard journal has multiple retention records for ${event.operation_id}`);
        }
        state.guardRetention = event;
      } else {
        if (!state.guardRetention || state.guardResolved || event.retention_id !== state.guardRetention.retention_id) {
          throw new Error(`Lifecycle guard journal has an invalid reconciliation sequence for ${event.operation_id}`);
        }
        state.guardResolved = true;
      }
      continue;
    }

    if (state.finalized) {
      throw new Error(`Lifecycle operation journal has records after finalization for ${event.operation_id}`);
    }
    if (!isNonEmptySingleLineString(event.position)) {
      throw new Error(`Lifecycle operation journal has an unbound position for ${event.operation_id}`);
    }
    if (state.position == null) state.position = event.position;
    if (state.position !== event.position) {
      throw new Error(`Lifecycle operation journal has conflicting positions for ${event.operation_id}`);
    }

    if (event.type === "signature_checkpoint") {
      if (state.completions.has(event.phase) ||
          (state.operation === "close" && state.completions.has("close")) ||
          (state.operation === "cleanup" && state.completions.has("cleanup"))) {
        throw new Error(`Lifecycle operation journal has a checkpoint after completion for ${event.operation_id}:${event.phase}`);
      }
      const key = `${event.phase}\u0000${event.signature}`;
      if (state.checkpoints.has(key)) {
        throw new Error(`Lifecycle operation journal has duplicate checkpoint evidence for ${event.operation_id}:${event.phase}`);
      }
      state.checkpoints.add(key);
      state.checkpointPhases.add(event.phase);
      continue;
    }

    if (event.type === "operation_completed") {
      if (state.completions.has(event.phase) ||
          (state.operation === "close" && state.completions.has("close")) ||
          (state.operation === "cleanup" && state.completions.has("cleanup"))) {
        throw new Error(`Lifecycle operation journal has multiple completion records for ${event.operation_id}:${event.phase}`);
      }
      if (state.operation === "close" && event.phase === "claim" && state.checkpointPhases.has("close")) {
        throw new Error(`Lifecycle operation journal completes a close claim after close evidence for ${event.operation_id}`);
      }
      const expected = new Set(event.expected_transactions.map((transaction) => `${transaction.phase}\u0000${transaction.signature}`));
      if (expected.size !== state.checkpoints.size || [...expected].some((key) => !state.checkpoints.has(key))) {
        throw new Error(`Lifecycle operation completion does not match its durable checkpoint set for ${event.operation_id}:${event.phase}`);
      }
      state.completions.set(event.phase, event);
      continue;
    }

    if (event.type === "operation_finalized") {
      const requiredPhase = state.operation === "close"
        ? "close"
        : state.operation === "claim"
          ? "claim"
          : state.operation === "cleanup"
            ? "cleanup"
            : null;
      if (requiredPhase != null && !state.completions.has(requiredPhase)) {
        throw new Error(`Lifecycle operation finalization lacks ${requiredPhase} completion evidence for ${event.operation_id}`);
      }
      state.finalized = true;
      continue;
    }

    throw new Error(`Lifecycle operation journal has unexpected ordinary record ${event.type}`);
  }
  return states;
}

function readJsonLines(file, fsImpl = fs, context = {}) {
  assertLifecycleOperationJournalNotPoisoned(file, fsImpl, context);
  const source = readSecureRegularFile(file, {
    fsImpl,
    label: "Lifecycle operation journal",
    allowMissing: true,
  });
  if (source == null) return [];
  const text = source.bytes.toString("utf8");
  if (text.length > 0 && !text.endsWith("\n")) {
    throw new Error(`Invalid lifecycle operation journal at ${file}: final record is not newline terminated`);
  }
  const rows = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      rows.push(validateLifecycleJournalEvent(JSON.parse(line), context));
    } catch (error) {
      throw new Error(`Invalid lifecycle operation journal at ${file}:${index + 1}: ${error.message}`, { cause: error });
    }
  }
  validateLifecycleJournalStream(rows);
  return rows;
}

function appendDurableJsonLine(file, value, {
  fsImpl = fs,
  durable = true,
  beforeAppend = null,
  afterAppend = null,
} = {}) {
  let opened = null;
  try {
    opened = openSecureRegularFileForAppend(file, {
      fsImpl,
      label: "Lifecycle operation journal",
    });
    if (beforeAppend) beforeAppend(opened);
    appendOpenedRegularFile(opened, Buffer.from(`${JSON.stringify(value)}\n`, "utf8"), {
      fsImpl,
      label: "Lifecycle operation journal",
      durable,
    });
    if (afterAppend) afterAppend(opened);
  } finally {
    if (opened) closeSecureRegularFile(opened, { fsImpl });
  }
}

function assertLifecycleLeaseOwnership(handle, details) {
  try {
    verifyOpenedRegularFile(details.leaseFileHandle, {
      fsImpl: details.fsImpl,
      label: "Lifecycle operation lease",
    });
  } catch (error) {
    throw new LifecycleOperationLeaseError(
      "Lifecycle operation lease ownership changed; refusing to continue it.",
      { code: "LIFECYCLE_OPERATION_LEASE_OWNERSHIP_LOST", cause: error },
    );
  }
}

function lifecycleOperationJournalLockName(checkpointFile) {
  return `.${path.basename(checkpointFile)}.mutation.lock`;
}

/**
 * Serialize every read/validate/append/remove operation for one lifecycle
 * resource.  This lock is deliberately retained if an append discovers that
 * its lease was replaced after durable journal bytes were written: no later
 * API caller can recover that ambiguous stream as success.
 */
function withLifecycleOperationJournalMutation(checkpointFile, {
  fsImpl = fs,
  durable = true,
} = {}, run) {
  let lock = null;
  let retainLock = false;
  try {
    lock = acquireSecureFileLock(checkpointFile, {
      fsImpl,
      label: "Lifecycle operation journal mutation",
      lockName: lifecycleOperationJournalLockName(checkpointFile),
      durable,
    });
  } catch (error) {
    throw new LifecycleOperationLeaseError(
      `Could not serialize lifecycle operation journal mutation: ${error.message}`,
      { code: error?.code === "EWOULDBLOCK" ? "LIFECYCLE_OPERATION_JOURNAL_LOCK_HELD" : "LIFECYCLE_OPERATION_JOURNAL_LOCK_UNAVAILABLE", cause: error },
    );
  }
  try {
    return run({ retainMutationLock: () => { retainLock = true; } });
  } finally {
    if (lock) {
      if (retainLock) closeSecureRegularFile(lock, { fsImpl });
      else releaseSecureFileLock(lock, {
        fsImpl,
        label: "Lifecycle operation journal mutation",
        durable,
      });
    }
  }
}

function persistLifecycleOperationPoison(checkpointFile, {
  operation,
  operation_id,
  resource,
  position,
  reason,
  now = () => new Date(),
}, {
  fsImpl = fs,
  durable = true,
} = {}) {
  const poisonFile = lifecycleOperationPoisonFile(checkpointFile);
  const poison = {
    operation,
    operation_id,
    resource,
    position,
    poisoned_at: new Date(now()).toISOString(),
    reason: normalizeLifecycleRetentionReason(reason),
  };
  const existing = readSecureRegularFile(poisonFile, {
    fsImpl,
    label: "Lifecycle operation journal poison",
    allowMissing: true,
  });
  if (existing != null) {
    validateLifecycleOperationPoison(JSON.parse(existing.bytes.toString("utf8")), { operation, resource });
    return;
  }
  let opened = null;
  try {
    try {
      opened = createSecureExclusiveFile(poisonFile, {
        fsImpl,
        label: "Lifecycle operation journal poison",
      });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const concurrent = readSecureRegularFile(poisonFile, {
        fsImpl,
        label: "Lifecycle operation journal poison",
      });
      validateLifecycleOperationPoison(JSON.parse(concurrent.bytes.toString("utf8")), { operation, resource });
      return;
    }
    writeOpenedRegularFile(opened, Buffer.from(JSON.stringify(poison), "utf8"), {
      fsImpl,
      label: "Lifecycle operation journal poison",
      durable,
    });
  } finally {
    if (opened) closeSecureRegularFile(opened, { fsImpl });
  }
}

function appendLifecycleOperationJournalEvent(handle, details, mutation, event) {
  appendDurableJsonLine(handle.checkpoint_file, event, {
    fsImpl: details.fsImpl,
    durable: details.durable,
    beforeAppend: (opened) => {
      verifyOpenedRegularFile(opened, { fsImpl: details.fsImpl, label: "Lifecycle operation journal" });
      assertLifecycleLeaseOwnership(handle, details);
      verifyOpenedRegularFile(opened, { fsImpl: details.fsImpl, label: "Lifecycle operation journal" });
    },
    afterAppend: (opened) => {
      try {
        verifyOpenedRegularFile(opened, { fsImpl: details.fsImpl, label: "Lifecycle operation journal" });
        assertLifecycleLeaseOwnership(handle, details);
        verifyOpenedRegularFile(opened, { fsImpl: details.fsImpl, label: "Lifecycle operation journal" });
      } catch (error) {
        mutation.retainMutationLock();
        details.mutationLockPoisoned = true;
        try {
          persistLifecycleOperationPoison(handle.checkpoint_file, {
            operation: handle.operation,
            operation_id: handle.operation_id,
            resource: handle.resource,
            position: event.position,
            reason: `lease ownership changed after durable ${event.type} append`,
          }, details);
        } catch (poisonError) {
          error.message = `${error.message}; durable journal mutation lock was retained but poison evidence failed: ${poisonError.message}`;
        }
        throw error;
      }
    },
  });
}

function boundLifecycleOperationPosition(events, operationId) {
  return operationJournalState(events, operationId).position;
}

function assertLifecycleOperationPosition(handle, events, position) {
  const boundPosition = boundLifecycleOperationPosition(events, handle.operation_id);
  if (handle.position !== null && position !== handle.position) {
    throw new LifecycleOperationLeaseError(
      `Lifecycle ${handle.operation} operation position does not match its leased position.`,
      { code: "LIFECYCLE_OPERATION_POSITION_MISMATCH" },
    );
  }
  if (boundPosition != null && position !== boundPosition) {
    throw new LifecycleOperationLeaseError(
      `Lifecycle ${handle.operation} operation position conflicts with its durable position binding.`,
      { code: "LIFECYCLE_OPERATION_POSITION_MISMATCH" },
    );
  }
  return position;
}

function pendingOperationCheckpoints(events, operationId = null) {
  const completed = new Set(events
    .filter((event) => event?.type === "operation_finalized" && typeof event.operation_id === "string")
    .map((event) => event.operation_id));
  const seen = new Set();
  return events
    .filter((event) => event?.type === "signature_checkpoint")
    .filter((event) => operationId == null || event.operation_id === operationId)
    .filter((event) => !completed.has(event.operation_id))
    .filter((event) => {
      const key = `${event.operation_id}\u0000${event.phase}\u0000${event.signature}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function operationCompletions(events, operationId = null) {
  const completed = events
    .filter((event) => event?.type === "operation_completed")
    .filter((event) => operationId == null || event.operation_id === operationId);
  const phases = new Set();
  for (const event of completed) {
    if (phases.has(event.phase)) {
      throw new Error(`Lifecycle operation journal has multiple completion records for ${event.operation_id}:${event.phase}`);
    }
    phases.add(event.phase);
  }
  return completed;
}

function normalizeCompletionTransactions(transactions, handle) {
  if (!Array.isArray(transactions) || transactions.length === 0) {
    throw new TypeError("Lifecycle operation completion requires a non-empty expected transaction set");
  }
  const normalized = [];
  const seen = new Set();
  for (const transaction of transactions) {
    if (!isPlainObject(transaction)) throw new TypeError("Expected lifecycle transaction must be an object");
    assertExactJournalKeys(transaction, ["phase", "signature"]);
    const phase = String(transaction.phase || "").trim();
    const signature = String(transaction.signature || "").trim();
    const phaseAllowed = lifecycleOperationPhaseAllowed(handle.operation, phase);
    if (!phaseAllowed) throw new LifecycleOperationLeaseError(
      `Completion phase ${phase} does not match ${handle.operation} operation.`,
      { code: "LIFECYCLE_OPERATION_PHASE_MISMATCH" },
    );
    if (!isNonEmptySingleLineString(signature)) throw new TypeError("Expected lifecycle transaction signature is invalid");
    const key = `${phase}\u0000${signature}`;
    if (seen.has(key)) throw new TypeError("Expected lifecycle transaction set contains a duplicate receipt");
    seen.add(key);
    normalized.push({ phase, signature });
  }
  return normalized;
}

/**
 * Acquire a durable, non-stealable operation lease. O_EXCL is intentional:
 * an abandoned lease remains a fail-closed manual-recovery condition instead
 * of allowing a later process to submit a second transaction.
 */
export function acquireLifecycleOperation({
  operation,
  position = null,
  operationKey = null,
  operationId = null,
  store = getTradeLedger(),
  directory = null,
  fsImpl = fs,
  now = () => new Date(),
  durable = true,
} = {}) {
  const kind = normalizeLifecycleOperationKind(operation);
  const resource = normalizeLifecycleOperationResource({ position, operationKey });
  const normalizedPosition = position == null ? null : String(position).trim();
  if (normalizedPosition != null && !isNonEmptySingleLineString(normalizedPosition)) {
    throw new TypeError("Lifecycle operation position must be a non-empty single-line identifier when provided");
  }
  // Claim, close, and cleanup resources are always positions, including the executor's
  // operationKey-only call path. Deploy alone can begin resource-scoped before
  // the chain has revealed its new position address.
  const leasePosition = normalizedPosition ?? (kind === "deploy" ? null : resource);
  const files = lifecycleOperationFiles({ operation: kind, position, operationKey, store, directory });
  let leaseFileHandle = null;
  try {
    return withLifecycleOperationJournalMutation(files.checkpointFile, { fsImpl, durable }, () => {
    try {
      try {
        leaseFileHandle = createSecureExclusiveFile(files.leaseFile, {
          fsImpl,
          label: "Lifecycle operation lease",
        });
      } catch (error) {
        if (error?.code === "EEXIST") {
          throw new LifecycleOperationLeaseError(
            `Lifecycle ${kind} operation is already leased for ${resource}; refusing concurrent or stale-lease takeover.`,
            { cause: error },
          );
        }
        throw new LifecycleOperationLeaseError(
          `Could not acquire lifecycle ${kind} lease for ${resource}: ${error.message}`,
          { code: "LIFECYCLE_OPERATION_LEASE_UNAVAILABLE", cause: error },
        );
      }

      const events = readJsonLines(files.checkpointFile, fsImpl, {
        operation: kind,
        resource,
      });
      const existing = pendingOperationCheckpoints(events);
      const resumableIds = [...new Set(existing.map((event) => event.operation_id).filter(Boolean))];
      if (operationId == null && resumableIds.length > 1) {
        throw new LifecycleOperationLeaseError(
          `Multiple unfinished ${kind} operations exist for ${resource}; manual reconciliation is required.`,
          { code: "LIFECYCLE_OPERATION_AMBIGUOUS" },
        );
      }
      const hasExplicitOperationId = operationId != null;
      const resolvedOperationId = hasExplicitOperationId
        ? String(operationId).trim()
        : String(resumableIds[0] || crypto.randomUUID()).trim();
      if (!resolvedOperationId || /\r|\n/.test(resolvedOperationId)) {
        throw new TypeError("operationId must be a non-empty single-line identifier");
      }
      const prior = operationJournalState(events, resolvedOperationId);
      if (hasExplicitOperationId && prior.finalized) {
        throw new LifecycleOperationLeaseError(
          `Lifecycle operationId ${resolvedOperationId} is already finalized and cannot be reacquired.`,
          { code: "LIFECYCLE_OPERATION_ID_FINALIZED" },
        );
      }
      if (hasExplicitOperationId && resumableIds.some((existingId) => existingId !== resolvedOperationId)) {
        throw new LifecycleOperationLeaseError(
          `Unfinished ${kind} operation for ${resource} has a different operationId; manual reconciliation is required.`,
          { code: "LIFECYCLE_OPERATION_ID_MISMATCH" },
        );
      }
      if (leasePosition !== null && prior.position !== null && prior.position !== leasePosition) {
        throw new LifecycleOperationLeaseError(
          `Lifecycle ${kind} operation position conflicts with its durable position binding.`,
          { code: "LIFECYCLE_OPERATION_POSITION_MISMATCH" },
        );
      }
      const lease = {
        operation: kind,
        operation_id: resolvedOperationId,
        resource,
        position: leasePosition,
        acquired_at: new Date(now()).toISOString(),
        pid: process.pid,
      };
      writeOpenedRegularFile(leaseFileHandle, Buffer.from(JSON.stringify(lease), "utf8"), {
        fsImpl,
        label: "Lifecycle operation lease",
        durable,
      });
      const handle = Object.freeze({
        operation: kind,
        operation_id: resolvedOperationId,
        resource,
        position: lease.position,
        lease_file: files.leaseFile,
        checkpoint_file: files.checkpointFile,
        poison_file: files.poisonFile,
      });
      activeLifecycleOperations.add(handle);
      lifecycleOperationDetails.set(handle, {
        fsImpl,
        durable,
        leaseFileHandle,
        released: false,
        finalized: false,
        retainLease: false,
        retainReason: null,
        mutationLockPoisoned: false,
      });
      leaseFileHandle = null; // retained in the capability details until release.
      return handle;
    } catch (error) {
      if (leaseFileHandle) {
        try { removeOpenedRegularFile(leaseFileHandle, { fsImpl, label: "Lifecycle operation lease", durable }); } catch { /* preserve the acquisition failure */ }
        try { closeSecureRegularFile(leaseFileHandle, { fsImpl }); } catch { /* preserve the acquisition failure */ }
      }
      throw error;
    }
    });
  } catch (error) {
    if (error instanceof LifecycleOperationLeaseError && error.code === "LIFECYCLE_OPERATION_JOURNAL_LOCK_UNAVAILABLE") {
      throw new LifecycleOperationLeaseError(
        `Could not acquire lifecycle ${kind} lease for ${resource}: ${error.message}`,
        { code: "LIFECYCLE_OPERATION_LEASE_UNAVAILABLE", cause: error },
      );
    }
    throw error;
  }
}

/** Reject JSON-shaped or otherwise forged operation contexts. */
export function assertLifecycleOperation(handle, { operation = null } = {}) {
  if (!handle || typeof handle !== "object" || !activeLifecycleOperations.has(handle)) {
    throw new LifecycleOperationLeaseError(
      "A live lifecycle operation requires an in-process durable operation capability.",
      { code: "LIFECYCLE_OPERATION_CAPABILITY_REQUIRED" },
    );
  }
  if (operation != null && handle.operation !== operation) {
    throw new LifecycleOperationLeaseError(
      `Lifecycle operation capability is for ${handle.operation}, not ${operation}.`,
      { code: "LIFECYCLE_OPERATION_CAPABILITY_MISMATCH" },
    );
  }
  const details = lifecycleOperationDetails.get(handle);
  if (!details || details.released) {
    throw new LifecycleOperationLeaseError("Lifecycle operation lease is no longer active.", {
      code: "LIFECYCLE_OPERATION_LEASE_INACTIVE",
    });
  }
  return handle;
}

/** Persist a confirmed signature before any later RPC/SDK step can run. */
export function checkpointLifecycleOperationSignature(handle, {
  position,
  phase,
  signature,
  metadata = {},
  now = () => new Date(),
} = {}) {
  assertLifecycleOperation(handle);
  const normalizedPhase = String(phase || "").trim();
  const normalizedSignature = String(signature || "").trim();
  const normalizedPosition = String(position || "").trim();
  if (!LIFECYCLE_OPERATION_PHASES.has(normalizedPhase)) throw new TypeError(`Unsupported checkpoint phase: ${phase}`);
  if (!isNonEmptySingleLineString(normalizedPosition)) {
    throw new TypeError("A signature checkpoint requires a non-empty single-line position");
  }
  if (!isNonEmptySingleLineString(normalizedSignature)) {
    throw new TypeError("A signature checkpoint requires a non-empty single-line signature");
  }
  const phaseAllowed = lifecycleOperationPhaseAllowed(handle.operation, normalizedPhase);
  if (!phaseAllowed) {
    throw new LifecycleOperationLeaseError(
      `Checkpoint phase ${normalizedPhase} does not match ${handle.operation} operation.`,
      { code: "LIFECYCLE_OPERATION_PHASE_MISMATCH" },
    );
  }
  const details = lifecycleOperationDetails.get(handle);
  return withLifecycleOperationJournalMutation(handle.checkpoint_file, details, (mutation) => {
    assertLifecycleLeaseOwnership(handle, details);
    const events = readJsonLines(handle.checkpoint_file, details.fsImpl, {
      operation: handle.operation,
      resource: handle.resource,
    });
    assertLifecycleLeaseOwnership(handle, details);
    assertLifecycleOperationPosition(handle, events, normalizedPosition);
    const existing = pendingOperationCheckpoints(events, handle.operation_id)
      .find((event) => event.phase === normalizedPhase && event.signature === normalizedSignature);
    if (existing) return { checkpoint: existing, already_checkpointed: true };
    const checkpoint = {
      type: "signature_checkpoint",
      operation: handle.operation,
      operation_id: handle.operation_id,
      resource: handle.resource,
      position: normalizedPosition,
      phase: normalizedPhase,
      signature: normalizedSignature,
      checkpointed_at: new Date(now()).toISOString(),
      metadata: isPlainObject(metadata) ? metadata : {},
    };
    try {
      appendLifecycleOperationJournalEvent(handle, details, mutation, checkpoint);
    } catch (error) {
      if (error instanceof LifecycleOperationLeaseError && error.code === "LIFECYCLE_OPERATION_LEASE_OWNERSHIP_LOST") {
        throw error;
      }
      // This function is invoked only after sendAndConfirmTransaction resolved.
      // Losing the durable checkpoint would make a retry indistinguishable from
      // a second submission, so retain the O_EXCL lease on disk even when the
      // journal itself is unavailable or torn.
      retainLifecycleOperationLease(handle, {
        reason: `confirmed ${normalizedPhase} receipt could not be durably checkpointed: ${error.message}`,
      });
      throw new LifecycleOperationLeaseError(
        "Confirmed transaction receipt could not be durably checkpointed; lifecycle lease was retained for explicit reconciliation.",
        { code: "LIFECYCLE_OPERATION_CHECKPOINT_PERSISTENCE_FAILED", cause: error },
      );
    }
    return { checkpoint, already_checkpointed: false };
  });
}

export function getPendingLifecycleOperationCheckpoints(handle) {
  assertLifecycleOperation(handle);
  const details = lifecycleOperationDetails.get(handle);
  return pendingOperationCheckpoints(readJsonLines(handle.checkpoint_file, details.fsImpl, {
    operation: handle.operation,
    resource: handle.resource,
  }), handle.operation_id)
    .map((event) => ({
      operation: event.operation,
      operation_id: event.operation_id,
      position: event.position,
      phase: event.phase,
      signature: event.signature,
      metadata: event.metadata || {},
    }));
}

/**
 * Return the exact durable evidence used by recovery. A checkpoint is merely
 * a confirmed receipt; it is not a completed claim or terminal close.
 */
export function getLifecycleOperationRecoveryEvidence(handle) {
  assertLifecycleOperation(handle);
  const details = lifecycleOperationDetails.get(handle);
  const events = readJsonLines(handle.checkpoint_file, details.fsImpl, {
    operation: handle.operation,
    resource: handle.resource,
  });
  return {
    checkpoints: pendingOperationCheckpoints(events, handle.operation_id)
      .map((event) => ({
        operation: event.operation,
        operation_id: event.operation_id,
        position: event.position,
        phase: event.phase,
        signature: event.signature,
        metadata: event.metadata || {},
      })),
    completions: operationCompletions(events, handle.operation_id)
      .map((event) => ({
        operation: event.operation,
        operation_id: event.operation_id,
        position: event.position,
        phase: event.phase,
        expected_transactions: event.expected_transactions.map((transaction) => ({ ...transaction })),
        position_absent: event.position_absent,
        completed_at: event.completed_at,
      })),
  };
}

/**
 * Persist a completion marker only after every transaction the SDK produced
 * has confirmed and (for close) a fresh authoritative absence check passed.
 */
export function completeLifecycleOperation(handle, {
  position,
  phase,
  expectedTransactions,
  positionAbsent = null,
  now = () => new Date(),
} = {}) {
  assertLifecycleOperation(handle);
  const details = lifecycleOperationDetails.get(handle);
  const normalizedPosition = String(position || "").trim();
  const normalizedPhase = String(phase || "").trim();
  if (!isNonEmptySingleLineString(normalizedPosition)) throw new TypeError("Lifecycle completion requires a non-empty position");
  const phaseAllowed = lifecycleOperationPhaseAllowed(handle.operation, normalizedPhase);
  if (!phaseAllowed) throw new LifecycleOperationLeaseError(
    `Completion phase ${normalizedPhase} does not match ${handle.operation} operation.`,
    { code: "LIFECYCLE_OPERATION_PHASE_MISMATCH" },
  );
  const expectedTransactionsNormalized = normalizeCompletionTransactions(expectedTransactions, handle);
  if (normalizedPhase === "claim" && positionAbsent !== null) {
    throw new TypeError("Claim completion cannot assert position absence");
  }
  if (normalizedPhase === "claim" && expectedTransactionsNormalized.some((transaction) => transaction.phase !== "claim")) {
    throw new TypeError("Claim completion cannot include a non-claim receipt");
  }
  if (handle.operation === "cleanup" && normalizedPhase !== "cleanup") {
    throw new TypeError("Cleanup operation completion phase must be cleanup");
  }
  if (handle.operation === "close" && normalizedPhase === "close") {
    if (positionAbsent !== true) {
      throw new TypeError("Terminal close completion requires a fresh authoritative position-absence check");
    }
    if (!expectedTransactionsNormalized.some((transaction) => transaction.phase === "close")) {
      throw new TypeError("Terminal close completion requires a close receipt");
    }
  } else if (positionAbsent !== null) {
    throw new TypeError("Only a terminal close completion may assert position absence");
  }
  return withLifecycleOperationJournalMutation(handle.checkpoint_file, details, (mutation) => {
    assertLifecycleLeaseOwnership(handle, details);
    const events = readJsonLines(handle.checkpoint_file, details.fsImpl, {
      operation: handle.operation,
      resource: handle.resource,
    });
    assertLifecycleLeaseOwnership(handle, details);
    assertLifecycleOperationPosition(handle, events, normalizedPosition);
    const existing = operationCompletions(events, handle.operation_id)
      .find((event) => event.phase === normalizedPhase);
    if (existing) {
      const existingText = JSON.stringify(existing.expected_transactions);
      if (existingText !== JSON.stringify(expectedTransactionsNormalized) || existing.position_absent !== positionAbsent) {
        throw new LifecycleOperationLeaseError(
          "Lifecycle operation already has conflicting completion evidence.",
          { code: "LIFECYCLE_OPERATION_COMPLETION_CONFLICT" },
        );
      }
      return { completion: existing, already_completed: true };
    }

    const checkpointKeys = new Set(pendingOperationCheckpoints(events, handle.operation_id)
      .map((event) => `${event.phase}\u0000${event.signature}`));
    const expectedKeys = new Set(expectedTransactionsNormalized.map((transaction) => `${transaction.phase}\u0000${transaction.signature}`));
    if (checkpointKeys.size !== expectedKeys.size || [...expectedKeys].some((key) => !checkpointKeys.has(key))) {
      throw new LifecycleOperationLeaseError(
        "Lifecycle completion requires durable checkpoints for the entire expected transaction set.",
        { code: "LIFECYCLE_OPERATION_COMPLETION_RECEIPTS_INCOMPLETE" },
      );
    }
    const completion = {
      type: "operation_completed",
      operation: handle.operation,
      operation_id: handle.operation_id,
      resource: handle.resource,
      position: normalizedPosition,
      phase: normalizedPhase,
      expected_transactions: expectedTransactionsNormalized,
      position_absent: positionAbsent,
      completed_at: new Date(now()).toISOString(),
    };
    try {
      appendLifecycleOperationJournalEvent(handle, details, mutation, completion);
    } catch (error) {
      if (error instanceof LifecycleOperationLeaseError && error.code === "LIFECYCLE_OPERATION_LEASE_OWNERSHIP_LOST") {
        throw error;
      }
      retainLifecycleOperationLease(handle, {
        reason: `operation completion could not be durably persisted: ${error.message}`,
      });
      throw new LifecycleOperationLeaseError(
        "Lifecycle operation completion could not be durably persisted; lifecycle lease was retained for explicit reconciliation.",
        { code: "LIFECYCLE_OPERATION_COMPLETION_PERSISTENCE_FAILED", cause: error },
      );
    }
    return { completion, already_completed: false };
  });
}

/**
 * Retaining the existing O_EXCL lease is the fail-closed poison record. It
 * remains durable even when the journal write that discovered the problem
 * failed, and is intentionally cleared only by explicit reconciliation.
 */
export function retainLifecycleOperationLease(handle, { reason = "explicit reconciliation required" } = {}) {
  assertLifecycleOperation(handle);
  const details = lifecycleOperationDetails.get(handle);
  details.retainLease = true;
  details.retainReason = normalizeLifecycleRetentionReason(reason);
  return { retained: true, reason: details.retainReason, lease_file: handle.lease_file };
}

/**
 * Record why a global deploy guard was retained. This record is deliberately
 * append-only and is the durable evidence a later operator reconciliation
 * must find before it can remove the O_EXCL guard after a restart.
 */
export function recordLifecycleOperationGuardRetention(handle, {
  reason = "explicit reconciliation required",
  now = () => new Date(),
} = {}) {
  assertLifecycleOperation(handle, { operation: "deploy" });
  const details = lifecycleOperationDetails.get(handle);
  if (handle.position !== null) {
    throw new LifecycleOperationLeaseError(
      "Only a resource-scoped deploy guard without a position may be recorded as retained.",
      { code: "LIFECYCLE_OPERATION_GUARD_SCOPE_INVALID" },
    );
  }
  const normalizedReason = normalizeLifecycleRetentionReason(reason);
  return withLifecycleOperationJournalMutation(handle.checkpoint_file, details, (mutation) => {
    assertLifecycleLeaseOwnership(handle, details);
    const events = readJsonLines(handle.checkpoint_file, details.fsImpl, {
      operation: handle.operation,
      resource: handle.resource,
    });
    assertLifecycleLeaseOwnership(handle, details);
    const existing = events.filter((event) => event.type === "guard_retained" && event.operation_id === handle.operation_id);
    if (existing.length > 1 || events.some((event) => event.operation_id === handle.operation_id && event.type !== "guard_retained")) {
      throw new LifecycleOperationLeaseError(
        "Global deploy guard journal is ambiguous; retaining its lease without releasing it.",
        { code: "LIFECYCLE_OPERATION_GUARD_JOURNAL_AMBIGUOUS" },
      );
    }
    if (existing.length === 1) {
      if (existing[0].reason !== normalizedReason) {
        throw new LifecycleOperationLeaseError(
          "Global deploy guard already has conflicting retention evidence.",
          { code: "LIFECYCLE_OPERATION_GUARD_RETENTION_CONFLICT" },
        );
      }
      return { retention: existing[0], already_recorded: true };
    }
    const retention = {
      type: "guard_retained",
      operation: handle.operation,
      operation_id: handle.operation_id,
      resource: handle.resource,
      position: null,
      retention_id: crypto.randomUUID(),
      reason: normalizedReason,
      retained_at: new Date(now()).toISOString(),
    };
    try {
      appendLifecycleOperationJournalEvent(handle, details, mutation, retention);
    } catch (error) {
      if (error instanceof LifecycleOperationLeaseError && error.code === "LIFECYCLE_OPERATION_LEASE_OWNERSHIP_LOST") {
        throw error;
      }
      retainLifecycleOperationLease(handle, {
        reason: `global deploy guard retention evidence could not be durably checkpointed: ${error.message}`,
      });
      throw new LifecycleOperationLeaseError(
        "Global deploy guard retention evidence could not be durably persisted; lifecycle lease was retained for explicit reconciliation.",
        { code: "LIFECYCLE_OPERATION_GUARD_RETENTION_PERSISTENCE_FAILED", cause: error },
      );
    }
    return { retention, already_recorded: false };
  });
}

function lifecycleOperationLeaseIdentity({ operation, position = null, operationKey = null, store, directory } = {}) {
  const files = lifecycleOperationFiles({ operation, position, operationKey, store, directory });
  return {
    ...files,
    position: position == null ? null : String(position).trim(),
  };
}

/**
 * Read a held lease through a descriptor-safe path. This is status-only: a
 * caller must still use reconcileRetainedLifecycleOperationLease to perform
 * the verified, audited removal.
 */
export function getRetainedLifecycleOperationLeaseStatus({
  operation,
  position = null,
  operationKey = null,
  store = getTradeLedger(),
  directory = null,
  fsImpl = fs,
} = {}) {
  const identity = lifecycleOperationLeaseIdentity({ operation, position, operationKey, store, directory });
  let opened = null;
  try {
    opened = openSecureRegularFileForRead(identity.leaseFile, {
      fsImpl,
      label: "Lifecycle operation lease",
    });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        held: false,
        operation: identity.operation,
        resource: identity.resource,
        lease_file: identity.leaseFile,
        checkpoint_file: identity.checkpointFile,
      };
    }
    throw new LifecycleOperationLeaseError(
      `Could not inspect lifecycle ${identity.operation} lease for ${identity.resource}: ${error.message}`,
      { code: "LIFECYCLE_OPERATION_LEASE_INSPECTION_FAILED", cause: error },
    );
  }
  try {
    const lease = readOpenedLifecycleOperationLease(opened, {
      fsImpl,
      operation: identity.operation,
      resource: identity.resource,
    });
    const events = readJsonLines(identity.checkpointFile, fsImpl, {
      operation: identity.operation,
      resource: identity.resource,
    });
    return {
      held: true,
      operation: identity.operation,
      resource: identity.resource,
      lease_file: identity.leaseFile,
      checkpoint_file: identity.checkpointFile,
      lease: { ...lease },
      journal_event_count: events.length,
      guard_retention_count: events.filter((event) => event.type === "guard_retained" && event.operation_id === lease.operation_id).length,
      guard_resolution_count: events.filter((event) => event.type === "guard_reconciliation_resolved" && event.operation_id === lease.operation_id).length,
    };
  } catch (error) {
    if (error instanceof LifecycleOperationLeaseError) throw error;
    throw new LifecycleOperationLeaseError(
      `Could not validate lifecycle ${identity.operation} lease evidence for ${identity.resource}: ${error.message}`,
      { code: "LIFECYCLE_OPERATION_LEASE_EVIDENCE_INVALID", cause: error },
    );
  } finally {
    closeSecureRegularFile(opened, { fsImpl });
  }
}

/**
 * Release an abandoned ordinary operation lease only after the caller proves
 * from a fresh authoritative chain observation that no transaction was
 * submitted after the lease was acquired. This is deliberately narrower than
 * guard reconciliation: any journal row or ambiguous/new signature keeps the
 * lease fail-closed.
 */
export async function reconcileUnsubmittedLifecycleOperationLease({
  operation,
  position,
  operationId,
  store = getTradeLedger(),
  directory = null,
  fsImpl = fs,
  durable = true,
  now = () => new Date(),
  verifyOutcome,
} = {}) {
  const identity = lifecycleOperationLeaseIdentity({ operation, position, store, directory });
  const expectedOperationId = String(operationId || "").trim();
  if (!isNonEmptySingleLineString(expectedOperationId) || typeof verifyOutcome !== "function") {
    throw new TypeError("Unsubmitted lifecycle reconciliation requires an exact operation id and authoritative verifier");
  }
  let opened = null;
  try {
    opened = openSecureRegularFileForRead(identity.leaseFile, { fsImpl, label: "Lifecycle operation lease" });
    const lease = readOpenedLifecycleOperationLease(opened, {
      fsImpl,
      operation: identity.operation,
      resource: identity.resource,
    });
    if (lease.operation_id !== expectedOperationId || lease.position !== identity.position) {
      throw new LifecycleOperationLeaseError("Retained lifecycle operation identity does not match reconciliation request.", {
        code: "LIFECYCLE_OPERATION_IDENTITY_MISMATCH",
      });
    }
    const events = readJsonLines(identity.checkpointFile, fsImpl, {
      operation: identity.operation,
      resource: identity.resource,
    });
    if (events.length !== 0) {
      throw new LifecycleOperationLeaseError("Retained lifecycle operation has journal evidence; refusing unsubmitted release.", {
        code: "LIFECYCLE_OPERATION_UNSUBMITTED_EVIDENCE_AMBIGUOUS",
      });
    }
    const outcome = await verifyOutcome(Object.freeze({ ...lease }));
    if (!isPlainObject(outcome)) throw new TypeError("Authoritative unsubmitted-operation outcome must be an object");
    assertExactJournalKeys(outcome, ["outcome", "observation_source", "observed_at", "position_exists", "signatures_after_lease"]);
    if (outcome.outcome !== "no_submitted_operation" || outcome.position_exists !== true ||
        !isCanonicalTimestamp(outcome.observed_at) || !isNonEmptySingleLineString(outcome.observation_source) ||
        !Array.isArray(outcome.signatures_after_lease) || outcome.signatures_after_lease.length !== 0) {
      throw new LifecycleOperationLeaseError("Fresh authoritative chain evidence does not prove an unsubmitted lifecycle operation.", {
        code: "LIFECYCLE_OPERATION_UNSUBMITTED_OUTCOME_UNRESOLVED",
      });
    }
    if (Date.parse(outcome.observed_at) < Date.parse(lease.acquired_at)) {
      throw new LifecycleOperationLeaseError("Unsubmitted-operation observation predates the retained lease.", {
        code: "LIFECYCLE_OPERATION_UNSUBMITTED_OUTCOME_STALE",
      });
    }
    return withLifecycleOperationJournalMutation(identity.checkpointFile, { fsImpl, durable }, () => {
      verifyOpenedRegularFile(opened, { fsImpl, label: "Lifecycle operation lease" });
      const latestEvents = readJsonLines(identity.checkpointFile, fsImpl, {
        operation: identity.operation,
        resource: identity.resource,
      });
      if (latestEvents.length !== 0) {
        throw new LifecycleOperationLeaseError("Lifecycle journal changed before unsubmitted release.", {
          code: "LIFECYCLE_OPERATION_UNSUBMITTED_EVIDENCE_AMBIGUOUS",
        });
      }
      removeOpenedRegularFile(opened, { fsImpl, label: "Lifecycle operation lease", durable });
      return {
        released: true,
        operation: lease.operation,
        operation_id: lease.operation_id,
        position: lease.position,
        outcome: outcome.outcome,
        observation_source: outcome.observation_source,
        observed_at: outcome.observed_at,
        reconciled_at: new Date(now()).toISOString(),
      };
    });
  } finally {
    if (opened) closeSecureRegularFile(opened, { fsImpl });
  }
}

function normalizeGuardReconciliationOutcome(outcome) {
  if (!isPlainObject(outcome)) throw new TypeError("Global deploy guard reconciliation requires an authoritative outcome object");
  assertExactJournalKeys(outcome, ["outcome", "observation_source", "observed_at", "live_position_count"]);
  if (outcome.outcome !== "no_live_canary_positions") {
    throw new TypeError("Global deploy guard reconciliation outcome is unresolved");
  }
  if (!isNonEmptySingleLineString(outcome.observation_source)) {
    throw new TypeError("Global deploy guard reconciliation observation source is invalid");
  }
  if (!isCanonicalTimestamp(outcome.observed_at)) {
    throw new TypeError("Global deploy guard reconciliation observation timestamp is invalid");
  }
  if (outcome.live_position_count !== 0) {
    throw new TypeError("Global deploy guard reconciliation requires zero live positions");
  }
  return outcome;
}

function guardReconciliationEvidence(events, operationId) {
  if (events.some((event) => !["guard_retained", "guard_reconciliation_resolved"].includes(event.type))) {
    throw new LifecycleOperationLeaseError(
      "Global deploy guard journal contains non-guard lifecycle evidence; outcome is ambiguous and the guard remains retained.",
      { code: "LIFECYCLE_OPERATION_GUARD_JOURNAL_AMBIGUOUS" },
    );
  }
  const current = events.filter((event) => event.operation_id === operationId);
  const retentions = current.filter((event) => event.type === "guard_retained");
  if (retentions.length !== 1) {
    throw new LifecycleOperationLeaseError(
      "Global deploy guard has no unique durable retention record; refusing to release it.",
      { code: "LIFECYCLE_OPERATION_GUARD_RETENTION_EVIDENCE_REQUIRED" },
    );
  }
  const retention = retentions[0];
  const resolutions = current.filter((event) => event.type === "guard_reconciliation_resolved");
  if (resolutions.some((event) => event.retention_id !== retention.retention_id)) {
    throw new LifecycleOperationLeaseError(
      "Global deploy guard journal has conflicting retention identities; refusing to release it.",
      { code: "LIFECYCLE_OPERATION_GUARD_JOURNAL_AMBIGUOUS" },
    );
  }
  return { retention, resolutions };
}

/**
 * Reconcile a previously retained, resource-scoped deploy guard. The caller
 * supplies a fresh authoritative outcome and a durable pre-release action
 * (the breaker reconciliation event). This function never uses pathname
 * unlink: it keeps the verified lease descriptor open until the audit event
 * is durable and removeOpenedRegularFile verifies the same inode again.
 */
export async function reconcileRetainedLifecycleOperationLease({
  operation,
  position = null,
  operationKey = null,
  operationId,
  store = getTradeLedger(),
  directory = null,
  fsImpl = fs,
  durable = true,
  now = () => new Date(),
  verifyOutcome,
  persistBeforeRelease,
} = {}) {
  const identity = lifecycleOperationLeaseIdentity({ operation, position, operationKey, store, directory });
  const expectedOperationId = String(operationId || "").trim();
  if (!isNonEmptySingleLineString(expectedOperationId)) {
    throw new LifecycleOperationLeaseError(
      "An exact retained lifecycle operation id is required for reconciliation.",
      { code: "LIFECYCLE_OPERATION_GUARD_IDENTITY_REQUIRED" },
    );
  }
  if (typeof verifyOutcome !== "function" || typeof persistBeforeRelease !== "function") {
    throw new TypeError("Retained lifecycle guard reconciliation requires authoritative outcome and durable pre-release boundaries");
  }

  let opened = null;
  try {
    try {
      opened = openSecureRegularFileForRead(identity.leaseFile, {
        fsImpl,
        label: "Lifecycle operation lease",
      });
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw new LifecycleOperationLeaseError(
          "The retained lifecycle guard is no longer present; refusing a stale reconciliation request.",
          { code: "LIFECYCLE_OPERATION_GUARD_STALE_OR_MISSING", cause: error },
        );
      }
      throw new LifecycleOperationLeaseError(
        `Could not open retained lifecycle guard: ${error.message}`,
        { code: "LIFECYCLE_OPERATION_GUARD_INSPECTION_FAILED", cause: error },
      );
    }

    let lease;
    let events;
    try {
      lease = readOpenedLifecycleOperationLease(opened, {
        fsImpl,
        operation: identity.operation,
        resource: identity.resource,
      });
      if (lease.position !== identity.position || lease.operation_id !== expectedOperationId) {
        throw new LifecycleOperationLeaseError(
          "Retained lifecycle guard identity does not match this explicit reconciliation request.",
          { code: "LIFECYCLE_OPERATION_GUARD_IDENTITY_MISMATCH" },
        );
      }
      events = readJsonLines(identity.checkpointFile, fsImpl, {
        operation: identity.operation,
        resource: identity.resource,
      });
    } catch (error) {
      if (error instanceof LifecycleOperationLeaseError) throw error;
      throw new LifecycleOperationLeaseError(
        `Retained lifecycle guard journal is invalid: ${error.message}`,
        { code: "LIFECYCLE_OPERATION_GUARD_JOURNAL_INVALID", cause: error },
      );
    }
    const evidence = guardReconciliationEvidence(events, lease.operation_id);

    let outcome;
    try {
      outcome = normalizeGuardReconciliationOutcome(await verifyOutcome({
        lease: Object.freeze({ ...lease }),
        retention: Object.freeze({ ...evidence.retention }),
        journal_event_count: events.length,
      }));
    } catch (error) {
      if (error instanceof LifecycleOperationLeaseError) throw error;
      throw new LifecycleOperationLeaseError(
        `Fresh authoritative global deploy guard outcome is unresolved: ${error.message}`,
        { code: "LIFECYCLE_OPERATION_GUARD_OUTCOME_UNRESOLVED", cause: error },
      );
    }

    try {
      await persistBeforeRelease({
        lease: Object.freeze({ ...lease }),
        retention: Object.freeze({ ...evidence.retention }),
        outcome: Object.freeze({ ...outcome }),
      });
    } catch (error) {
      throw new LifecycleOperationLeaseError(
        `Could not durably record global deploy guard reconciliation in the breaker: ${error.message}`,
        { code: "LIFECYCLE_OPERATION_GUARD_BREAKER_PERSISTENCE_FAILED", cause: error },
      );
    }

    return withLifecycleOperationJournalMutation(identity.checkpointFile, { fsImpl, durable }, (mutation) => {
      verifyOpenedRegularFile(opened, { fsImpl, label: "Lifecycle operation lease" });
      const latestEvents = readJsonLines(identity.checkpointFile, fsImpl, {
        operation: identity.operation,
        resource: identity.resource,
      });
      const latestEvidence = guardReconciliationEvidence(latestEvents, lease.operation_id);
      if (latestEvidence.retention.retention_id !== evidence.retention.retention_id || latestEvidence.resolutions.length > 0) {
        throw new LifecycleOperationLeaseError(
          "Global deploy guard reconciliation evidence changed before its durable release boundary.",
          { code: "LIFECYCLE_OPERATION_GUARD_JOURNAL_AMBIGUOUS" },
        );
      }
      verifyOpenedRegularFile(opened, { fsImpl, label: "Lifecycle operation lease" });
      const resolution = {
        type: "guard_reconciliation_resolved",
        operation: lease.operation,
        operation_id: lease.operation_id,
        resource: lease.resource,
        position: null,
        retention_id: latestEvidence.retention.retention_id,
        reconciliation_id: crypto.randomUUID(),
        outcome: outcome.outcome,
        observation_source: outcome.observation_source,
        observed_at: outcome.observed_at,
        live_position_count: outcome.live_position_count,
        journal_event_count: latestEvents.length,
        resolved_at: new Date(now()).toISOString(),
      };
      try {
        appendDurableJsonLine(identity.checkpointFile, resolution, {
          fsImpl,
          durable,
          beforeAppend: (journal) => {
            verifyOpenedRegularFile(journal, { fsImpl, label: "Lifecycle operation journal" });
            verifyOpenedRegularFile(opened, { fsImpl, label: "Lifecycle operation lease" });
            verifyOpenedRegularFile(journal, { fsImpl, label: "Lifecycle operation journal" });
          },
          afterAppend: (journal) => {
            try {
              verifyOpenedRegularFile(journal, { fsImpl, label: "Lifecycle operation journal" });
              verifyOpenedRegularFile(opened, { fsImpl, label: "Lifecycle operation lease" });
              verifyOpenedRegularFile(journal, { fsImpl, label: "Lifecycle operation journal" });
            } catch (error) {
              mutation.retainMutationLock();
              try {
                persistLifecycleOperationPoison(identity.checkpointFile, {
                  operation: lease.operation,
                  operation_id: lease.operation_id,
                  resource: lease.resource,
                  position: null,
                  reason: "lease ownership changed after durable guard reconciliation append",
                }, { fsImpl, durable });
              } catch (poisonError) {
                error.message = `${error.message}; durable journal mutation lock was retained but poison evidence failed: ${poisonError.message}`;
              }
              throw error;
            }
          },
        });
      } catch (error) {
        throw new LifecycleOperationLeaseError(
          `Could not durably append global deploy guard reconciliation evidence: ${error.message}`,
          { code: "LIFECYCLE_OPERATION_GUARD_RECONCILIATION_PERSISTENCE_FAILED", cause: error },
        );
      }

      try {
        removeOpenedRegularFile(opened, {
          fsImpl,
          label: "Lifecycle operation lease",
          durable,
        });
      } catch (error) {
        let retentionRecoveryError = null;
        try {
          ensureLifecycleOperationLeaseRetained(identity.leaseFile, lease, { fsImpl, durable });
        } catch (restoreError) {
          retentionRecoveryError = restoreError;
        }
        throw new LifecycleOperationLeaseError(
          retentionRecoveryError
            ? `Could not securely remove the reconciled global deploy guard: ${error.message}; could not prove its retained lease was restored: ${retentionRecoveryError.message}`
            : `Could not securely remove the reconciled global deploy guard; it remains retained: ${error.message}`,
          { code: "LIFECYCLE_OPERATION_GUARD_SECURE_REMOVE_FAILED", cause: error },
        );
      }
      return {
        released: true,
        operation: lease.operation,
        operation_id: lease.operation_id,
        resource: lease.resource,
        retention: latestEvidence.retention,
        resolution,
      };
    });
  } finally {
    if (opened) closeSecureRegularFile(opened, { fsImpl });
  }
}

/** Mark a fully finalized operation complete after its receipts are durable. */
export function finalizeLifecycleOperation(handle, { position = null, now = () => new Date() } = {}) {
  assertLifecycleOperation(handle);
  const details = lifecycleOperationDetails.get(handle);
  if (details.finalized) return { finalized: false, already_finalized: true };
  const suppliedPosition = position == null ? null : String(position).trim();
  if (suppliedPosition !== null && !isNonEmptySingleLineString(suppliedPosition)) {
    throw new TypeError("Lifecycle finalization position must be a non-empty single-line identifier when provided");
  }
  return withLifecycleOperationJournalMutation(handle.checkpoint_file, details, (mutation) => {
    assertLifecycleLeaseOwnership(handle, details);
    const events = readJsonLines(handle.checkpoint_file, details.fsImpl, {
      operation: handle.operation,
      resource: handle.resource,
    });
    assertLifecycleLeaseOwnership(handle, details);
    const current = operationJournalState(events, handle.operation_id);
    if (current.finalized) {
      details.finalized = true;
      return { finalized: false, already_finalized: true };
    }
    if (handle.operation === "deploy" && handle.position === null && current.position === null) {
      throw new LifecycleOperationLeaseError(
        "A resource-scoped deploy must durably bind its first verified position before finalization.",
        { code: "LIFECYCLE_OPERATION_POSITION_REQUIRED" },
      );
    }
    const finalizedPosition = suppliedPosition ?? handle.position ?? current.position;
    if (!isNonEmptySingleLineString(finalizedPosition)) {
      throw new LifecycleOperationLeaseError(
        "Lifecycle finalization requires a position bound to the lease or durable operation evidence.",
        { code: "LIFECYCLE_OPERATION_POSITION_REQUIRED" },
      );
    }
    assertLifecycleOperationPosition(handle, events, finalizedPosition);
    if (["claim", "close", "cleanup"].includes(handle.operation)) {
      const requiredPhase = handle.operation === "close"
        ? "close"
        : handle.operation === "claim"
          ? "claim"
          : "cleanup";
      const completion = operationCompletions(events, handle.operation_id)
        .find((event) => event.phase === requiredPhase);
      if (!completion) {
        throw new LifecycleOperationLeaseError(
          `Cannot finalize ${handle.operation} operation without durable ${requiredPhase} completion evidence.`,
          { code: "LIFECYCLE_OPERATION_COMPLETION_REQUIRED" },
        );
      }
    }
    const finalization = {
      type: "operation_finalized",
      operation: handle.operation,
      operation_id: handle.operation_id,
      resource: handle.resource,
      position: finalizedPosition,
      finalized_at: new Date(now()).toISOString(),
    };
    try {
      appendLifecycleOperationJournalEvent(handle, details, mutation, finalization);
    } catch (error) {
      if (error instanceof LifecycleOperationLeaseError && error.code === "LIFECYCLE_OPERATION_LEASE_OWNERSHIP_LOST") {
        throw error;
      }
      retainLifecycleOperationLease(handle, {
        reason: `operation finalization could not be durably persisted: ${error.message}`,
      });
      throw new LifecycleOperationLeaseError(
        "Lifecycle operation finalization could not be durably persisted; lifecycle lease was retained for explicit reconciliation.",
        { code: "LIFECYCLE_OPERATION_FINALIZATION_PERSISTENCE_FAILED", cause: error },
      );
    }
    // Retain the compact final marker. It lets a later operation distinguish a
    // completed prior operation from an unfinished checkpoint without deleting
    // evidence during a crash-sensitive finalization step.
    details.finalized = true;
    return { finalized: true };
  });
}

export function releaseLifecycleOperation(handle) {
  assertLifecycleOperation(handle);
  const details = lifecycleOperationDetails.get(handle);
  if (!details.leaseFileHandle) {
    throw new LifecycleOperationLeaseError("Lifecycle operation lease ownership changed; refusing to remove it.", {
      code: "LIFECYCLE_OPERATION_LEASE_OWNERSHIP_LOST",
    });
  }
  if (details.mutationLockPoisoned) {
    // A post-append ownership race left the durable mutation lock in place.
    // Closing this stale descriptor cannot reopen that permanently blocked
    // journal, and avoids masking the original ownership-loss error in a
    // withLifecycleOperation finally path.
    try { closeSecureRegularFile(details.leaseFileHandle, { fsImpl: details.fsImpl }); } finally {
      details.leaseFileHandle = null;
      details.released = true;
    }
    return { released: false, retained: true, reason: "journal ownership race permanently fail-closed" };
  }
  return withLifecycleOperationJournalMutation(handle.checkpoint_file, details, () => {
    if (details.retainLease) {
      // Close only our descriptor. The path remains present as the durable
      // poisoned/retained lease that blocks all later acquisition after restart.
      try {
        assertLifecycleLeaseOwnership(handle, details);
        details.released = true;
        return { released: false, retained: true, reason: details.retainReason };
      } finally {
        try { closeSecureRegularFile(details.leaseFileHandle, { fsImpl: details.fsImpl }); } finally { details.leaseFileHandle = null; }
      }
    }
    try {
      assertLifecycleLeaseOwnership(handle, details);
      removeOpenedRegularFile(details.leaseFileHandle, {
        fsImpl: details.fsImpl,
        label: "Lifecycle operation lease",
        durable: details.durable,
      });
      details.released = true;
    } catch (error) {
      throw new LifecycleOperationLeaseError("Lifecycle operation lease ownership changed; refusing to remove it.", {
        code: "LIFECYCLE_OPERATION_LEASE_OWNERSHIP_LOST",
        cause: error,
      });
    } finally {
      try { closeSecureRegularFile(details.leaseFileHandle, { fsImpl: details.fsImpl }); } finally { details.leaseFileHandle = null; }
    }
  });
}

export async function withLifecycleOperation(options, run) {
  if (typeof run !== "function") throw new TypeError("withLifecycleOperation requires a run function");
  const handle = acquireLifecycleOperation(options);
  try {
    return await run(handle);
  } finally {
    releaseLifecycleOperation(handle);
  }
}

function getConnection() {
  if (!connection) connection = new Connection(process.env.RPC_URL || config.pnl.rpcUrl, "confirmed");
  return connection;
}

export function getTradeLedger() {
  if (!ledger) {
    const configured = config.ledger?.path || "trade-ledger.jsonl";
    const filePath = configured.startsWith("/") ? configured : repoPath(configured);
    ledger = new TradeLedger({ filePath });
  }
  return ledger;
}

export function lifecycleIdForPosition(position) {
  return `lp:${String(position)}`;
}

function canonicalLedgerIdentifier(value, field) {
  const normalized = String(value ?? "").trim();
  if (!normalized || /[\r\n]/.test(normalized)) throw new TypeError(`${field} must be a non-empty single-line identifier`);
  return normalized;
}

function lamportBigInt(value, field) {
  if (typeof value === "bigint") {
    if (value < 0n) throw new RangeError(`${field} cannot be negative`);
    return value;
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === "string" && /^(0|[1-9]\d*)$/.test(value)) return BigInt(value);
  throw new TypeError(`${field} must be a non-negative safe integer, bigint, or canonical integer string`);
}

function rpcAccountKeyString(value, field) {
  const candidate = value?.pubkey ?? value;
  const rendered = candidate?.toBase58?.() ?? candidate?.toString?.() ?? (typeof candidate === "string" ? candidate : null);
  if (typeof rendered !== "string" || !rendered.trim() || rendered === "[object Object]") {
    throw new TypeError(`${field} must be a non-empty account key`);
  }
  return rendered;
}

function strictAccountKeys(transaction) {
  const message = transaction?.transaction?.message;
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    throw new TypeError("Confirmed transaction must include a message object");
  }
  const staticKeys = message.staticAccountKeys ?? message.accountKeys;
  if (!Array.isArray(staticKeys) || staticKeys.length === 0) {
    throw new TypeError("Confirmed transaction must include a non-empty account-key array");
  }
  const loaded = transaction?.meta?.loadedAddresses;
  if (loaded != null && (!isPlainObject(loaded) ||
    (loaded.writable != null && !Array.isArray(loaded.writable)) ||
    (loaded.readonly != null && !Array.isArray(loaded.readonly)))) {
    throw new TypeError("Confirmed transaction loaded addresses must be arrays when present");
  }
  const keys = [
    ...staticKeys,
    ...(loaded?.writable || []),
    ...(loaded?.readonly || []),
  ].map((key, index) => rpcAccountKeyString(key, `transaction account key ${index}`));
  if (new Set(keys).size !== keys.length) {
    throw new Error("Confirmed transaction has duplicate effective static/loaded account keys");
  }
  return keys;
}

function strictLamportBalances(meta, keys) {
  if (!Array.isArray(meta.preBalances) || !Array.isArray(meta.postBalances)) {
    throw new TypeError("Confirmed transaction preBalances and postBalances must be arrays");
  }
  if (meta.preBalances.length !== meta.postBalances.length || meta.preBalances.length !== keys.length) {
    throw new Error("Confirmed transaction account-key and pre/post balance arrays must have matching lengths");
  }
  return {
    pre: meta.preBalances.map((value, index) => lamportBigInt(value, `meta.preBalances[${index}]`)),
    post: meta.postBalances.map((value, index) => lamportBigInt(value, `meta.postBalances[${index}]`)),
  };
}

function strictTokenBalances(meta, field, keys) {
  if (!Object.hasOwn(meta, field)) return [];
  const entries = meta[field];
  if (!Array.isArray(entries)) throw new TypeError(`Confirmed transaction ${field} must be an array when present`);
  const seen = new Set();
  return entries.map((entry, index) => {
    if (!isPlainObject(entry)) throw new TypeError(`Confirmed transaction ${field}[${index}] must be an object`);
    if (typeof entry.owner !== "string" || !entry.owner.trim()) {
      throw new TypeError(`Confirmed transaction ${field}[${index}].owner must be a non-empty string`);
    }
    if (!Number.isSafeInteger(entry.accountIndex) || entry.accountIndex < 0 || entry.accountIndex >= keys.length) {
      throw new TypeError(`Confirmed transaction ${field}[${index}].accountIndex must reference an account key`);
    }
    if (typeof entry.mint !== "string" || !entry.mint.trim()) {
      throw new TypeError(`Confirmed transaction ${field}[${index}].mint must be a non-empty string`);
    }
    if (!isPlainObject(entry.uiTokenAmount) || !Object.hasOwn(entry.uiTokenAmount, "amount")) {
      throw new TypeError(`Confirmed transaction ${field}[${index}].uiTokenAmount.amount is required`);
    }
    const rawAmount = lamportBigInt(entry.uiTokenAmount.amount, `${field}[${index}].uiTokenAmount.amount`);
    const key = `${entry.accountIndex}:${entry.mint}`;
    if (seen.has(key)) throw new Error(`Confirmed transaction ${field} has duplicate token balance ${key}`);
    seen.add(key);
    return {
      owner: entry.owner,
      accountIndex: entry.accountIndex,
      mint: entry.mint,
      rawAmount,
    };
  });
}

function tokenRawByIndex(entries, walletAddress) {
  const map = new Map();
  for (const entry of entries) {
    if (entry?.owner !== walletAddress) continue;
    const key = `${entry.accountIndex}:${entry.mint}`;
    map.set(key, {
      accountIndex: entry.accountIndex,
      mint: entry.mint,
      rawAmount: entry.rawAmount,
    });
  }
  return map;
}

function canonicalDeployAccount(value, field) {
  const account = rpcAccountKeyString(value, field);
  if (account !== String(value?.toString?.() ?? value)) {
    throw new TypeError(`${field} must be a canonical account key`);
  }
  return account;
}

function instructionBytes(data, field) {
  if (Buffer.isBuffer(data) || data instanceof Uint8Array) return Buffer.from(data);
  if (typeof data !== "string" || !data) throw new TypeError(`${field} must be a non-empty base58 instruction payload`);
  try {
    return Buffer.from(bs58.decode(data));
  } catch (error) {
    throw new TypeError(`${field} must be a valid base58 instruction payload: ${error.message}`);
  }
}

function instructionAccountIndexes(instruction, keys, field) {
  const indexes = instruction?.accountKeyIndexes ?? instruction?.accounts;
  if (!Array.isArray(indexes)) throw new TypeError(`${field} must include account key indexes`);
  return indexes.map((index, accountIndex) => {
    if (!Number.isSafeInteger(index) || index < 0 || index >= keys.length) {
      throw new TypeError(`${field}.accounts[${accountIndex}] must reference an effective account key`);
    }
    return index;
  });
}

/**
 * Normalizes only RPC instruction shapes whose program/account/data fields can
 * be independently checked. Parsed-only DLMM instructions are rejected: a
 * parsed label is not an instruction discriminator or amount proof.
 */
function strictConfirmedInstructions(transaction, keys) {
  const message = transaction?.transaction?.message;
  const instructions = message?.compiledInstructions ?? message?.instructions;
  if (!Array.isArray(instructions)) {
    throw new TypeError("Confirmed transaction must include compiled or parsed instructions");
  }
  return instructions.map((instruction, index) => {
    const field = `transaction instruction ${index}`;
    if (!isPlainObject(instruction)) throw new TypeError(`${field} must be an object`);
    if (Number.isSafeInteger(instruction.programIdIndex)) {
      if (instruction.programIdIndex < 0 || instruction.programIdIndex >= keys.length) {
        throw new TypeError(`${field}.programIdIndex must reference an effective account key`);
      }
      return {
        index,
        program_id: keys[instruction.programIdIndex],
        accounts: instructionAccountIndexes(instruction, keys, field).map((accountIndex) => keys[accountIndex]),
        account_indexes: instructionAccountIndexes(instruction, keys, field),
        data: instructionBytes(instruction.data, `${field}.data`),
      };
    }
    // Some RPC adapters preserve parsed program/account values.  They can be
    // used only when raw base58 data is still present; otherwise no Anchor
    // discriminator or u64 amount is available to validate the claim.
    if (instruction.programId != null) {
      const programId = canonicalDeployAccount(instruction.programId, `${field}.programId`);
      if (!Array.isArray(instruction.accounts)) {
        throw new TypeError(`${field}.accounts must be present for parsed instruction validation`);
      }
      const accounts = instruction.accounts.map((account, accountIndex) => {
        if (Number.isSafeInteger(account)) {
          if (account < 0 || account >= keys.length) throw new TypeError(`${field}.accounts[${accountIndex}] is out of range`);
          return keys[account];
        }
        return canonicalDeployAccount(account?.pubkey ?? account, `${field}.accounts[${accountIndex}]`);
      });
      return {
        index,
        program_id: programId,
        accounts,
        account_indexes: null,
        data: instructionBytes(instruction.data, `${field}.data`),
      };
    }
    throw new TypeError(`${field} has neither a valid compiled nor parsed program shape`);
  });
}

function tokenBalanceByAccount(meta, field, keys) {
  const balances = meta?.[field];
  if (!Array.isArray(balances)) throw new TypeError(`Confirmed transaction ${field} must be an array for deploy receipt evidence`);
  const byKey = new Map();
  for (const [index, entry] of balances.entries()) {
    if (!isPlainObject(entry)) throw new TypeError(`${field}[${index}] must be an object`);
    if (!Number.isSafeInteger(entry.accountIndex) || entry.accountIndex < 0 || entry.accountIndex >= keys.length) {
      throw new TypeError(`${field}[${index}].accountIndex must reference an effective account key`);
    }
    const mint = canonicalDeployAccount(entry.mint, `${field}[${index}].mint`);
    if (!isPlainObject(entry.uiTokenAmount) || !Object.hasOwn(entry.uiTokenAmount, "amount")) {
      throw new TypeError(`${field}[${index}].uiTokenAmount.amount is required`);
    }
    const key = `${entry.accountIndex}:${mint}`;
    if (byKey.has(key)) throw new Error(`Confirmed transaction ${field} has duplicate token balance ${key}`);
    byKey.set(key, {
      account_index: entry.accountIndex,
      account: keys[entry.accountIndex],
      mint,
      owner: typeof entry.owner === "string" ? entry.owner : null,
      amount: lamportBigInt(entry.uiTokenAmount.amount, `${field}[${index}].uiTokenAmount.amount`),
    });
  }
  return byKey;
}

function tokenDeltaForAccount(preBalances, postBalances, account, mint, label) {
  const key = [...preBalances.keys(), ...postBalances.keys()]
    .find((candidate) => {
      const row = postBalances.get(candidate) || preBalances.get(candidate);
      return row?.account === account && row?.mint === mint;
    });
  if (!key) throw new Error(`Deploy receipt is missing ${label} SPL balance evidence`);
  const pre = preBalances.get(key)?.amount ?? 0n;
  const post = postBalances.get(key)?.amount ?? 0n;
  return post - pre;
}

function tokenDeltaForAccountOrNull(preBalances, postBalances, account, mint) {
  const key = [...preBalances.keys(), ...postBalances.keys()]
    .find((candidate) => {
      const row = postBalances.get(candidate) || preBalances.get(candidate);
      return row?.account === account && row?.mint === mint;
    });
  if (!key) return null;
  return (postBalances.get(key)?.amount ?? 0n) - (preBalances.get(key)?.amount ?? 0n);
}

function systemTransfersFromWallet(instructions, walletAddress) {
  const transfers = [];
  for (const instruction of instructions) {
    if (instruction.program_id !== SYSTEM_PROGRAM_ID) continue;
    // SystemProgram::Transfer has u32 discriminator 2 and u64 lamports.
    if (instruction.data.length < 12 || instruction.data.readUInt32LE(0) !== 2) {
      throw new Error("Deploy receipt contains an unsupported direct SystemProgram action");
    }
    if (instruction.accounts.length < 2) throw new Error("System transfer has insufficient account roles");
    if (instruction.accounts[0] !== walletAddress) continue;
    transfers.push({
      instruction_index: instruction.index,
      source: instruction.accounts[0],
      destination: instruction.accounts[1],
      amount: instruction.data.readBigUInt64LE(4),
    });
  }
  return transfers;
}

function assertAtomicNativeSolWrapLifecycle({ instructions, walletAddress, userTokenY, amountY, liquidityInstructionIndex }) {
  const transfers = systemTransfersFromWallet(instructions, walletAddress);
  if (transfers.length !== 1 || transfers[0].destination !== userTokenY || transfers[0].amount !== amountY) {
    throw new Error("Deploy receipt does not prove one exact wallet-to-WSOL funding transfer");
  }
  const associatedAccountCreates = instructions.filter((instruction) => (
    instruction.program_id === ASSOCIATED_TOKEN_PROGRAM_ID && instruction.accounts[1] === userTokenY
  ));
  if (associatedAccountCreates.length !== 1 ||
      associatedAccountCreates[0].accounts[0] !== walletAddress ||
      associatedAccountCreates[0].accounts[2] !== walletAddress ||
      associatedAccountCreates[0].accounts[3] !== NATIVE_SOL_MINT ||
      associatedAccountCreates[0].accounts[5] !== LEGACY_TOKEN_PROGRAM_ID) {
    throw new Error("Deploy receipt does not prove creation of the wallet's native-SOL token account");
  }
  const syncNativeActions = instructions.filter((instruction) => (
    instruction.program_id === LEGACY_TOKEN_PROGRAM_ID &&
    instruction.data.length === 1 && instruction.data[0] === 17 &&
    instruction.accounts[0] === userTokenY
  ));
  if (syncNativeActions.length !== 1) {
    throw new Error("Deploy receipt does not prove one SyncNative action for the funded WSOL account");
  }
  const closeActions = instructions.filter((instruction) => (
    instruction.program_id === LEGACY_TOKEN_PROGRAM_ID &&
    instruction.data.length === 1 && instruction.data[0] === 9 &&
    instruction.accounts[0] === userTokenY
  ));
  if (closeActions.length !== 1 || closeActions[0].accounts[1] !== walletAddress || closeActions[0].accounts[2] !== walletAddress) {
    throw new Error("Deploy receipt does not prove atomic closure of the funded WSOL account back to the wallet");
  }
  const userTokenYActions = instructions.filter((instruction) => (
    instruction.program_id === LEGACY_TOKEN_PROGRAM_ID && instruction.accounts.includes(userTokenY)
  ));
  if (userTokenYActions.length !== 2 ||
      !userTokenYActions.includes(syncNativeActions[0]) || !userTokenYActions.includes(closeActions[0])) {
    throw new Error("Deploy receipt contains an unrelated outer token action for the funded WSOL account");
  }
  if (!(associatedAccountCreates[0].index < transfers[0].instruction_index &&
      transfers[0].instruction_index < syncNativeActions[0].index &&
      syncNativeActions[0].index < liquidityInstructionIndex &&
      liquidityInstructionIndex < closeActions[0].index)) {
    throw new Error("Deploy receipt WSOL create/fund/sync/liquidity/close actions are not in canonical order");
  }
}

function assertNoUnrelatedDeployDebits({ instructions, walletAddress, userTokenY, amountY, preTokenBalances, postTokenBalances }) {
  let allowedWrappedSolTransfers = 0;
  for (const transfer of systemTransfersFromWallet(instructions, walletAddress)) {
    if (transfer.destination !== userTokenY || transfer.amount !== amountY || ++allowedWrappedSolTransfers > 1) {
      throw new Error("Deploy receipt contains an unrelated or ambiguous native SOL transfer");
    }
  }
  for (const row of new Map([...preTokenBalances, ...postTokenBalances]).values()) {
    const pre = preTokenBalances.get(`${row.account_index}:${row.mint}`)?.amount ?? 0n;
    const post = postTokenBalances.get(`${row.account_index}:${row.mint}`)?.amount ?? 0n;
    if (row.owner === walletAddress && post !== pre && (row.account !== userTokenY || row.mint !== NATIVE_SOL_MINT)) {
      throw new Error("Deploy receipt contains an unrelated wallet token debit or credit");
    }
  }
}

function assertSetupHasNoWalletTokenOrDirectSolDebit({ instructions, walletAddress, preTokenBalances, postTokenBalances }) {
  for (const instruction of instructions) {
    if (instruction.program_id !== SYSTEM_PROGRAM_ID) continue;
    if (instruction.data.length < 12 || instruction.data.readUInt32LE(0) !== 2 || instruction.accounts[0] === walletAddress) {
      throw new Error("Meteora setup receipt contains an unsupported direct SystemProgram action");
    }
  }
  for (const row of new Map([...preTokenBalances, ...postTokenBalances]).values()) {
    if (row.owner !== walletAddress) continue;
    const pre = preTokenBalances.get(`${row.account_index}:${row.mint}`)?.amount ?? 0n;
    const post = postTokenBalances.get(`${row.account_index}:${row.mint}`)?.amount ?? 0n;
    if (post < pre) throw new Error("Meteora setup receipt contains an unrelated wallet token debit");
  }
}

// Account order differs between the two installed Meteora liquidity
// instructions (notably `sender`: Strategy=11, Strategy2=9). Resolve every
// economically relevant account role from the exact decoded instruction's
// installed IDL rather than sharing a positional Strategy2 assumption.
function liquidityAccountRolesForInstruction(decodedName) {
  if (!DLMM_LIQUIDITY_INSTRUCTIONS.has(decodedName)) {
    throw new Error(`Unsupported Meteora liquidity instruction ${decodedName}`);
  }
  const matchingInstructions = (DLMM_IDL.instructions || [])
    .filter((instruction) => instruction?.name === decodedName);
  if (matchingInstructions.length !== 1 || !Array.isArray(matchingInstructions[0].accounts)) {
    throw new Error(`Meteora IDL lacks an unambiguous account schema for ${decodedName}`);
  }
  const accounts = matchingInstructions[0].accounts;
  const roles = {};
  for (const role of DLMM_LIQUIDITY_ACCOUNT_ROLES) {
    const indexes = accounts
      .map((account, index) => account?.name === role ? index : -1)
      .filter((index) => index >= 0);
    if (indexes.length !== 1) {
      throw new Error(`Meteora IDL account role ${role} is missing or ambiguous for ${decodedName}`);
    }
    roles[role] = indexes[0];
  }
  if (new Set(Object.values(roles)).size !== DLMM_LIQUIDITY_ACCOUNT_ROLES.length) {
    throw new Error(`Meteora IDL account roles are ambiguous for ${decodedName}`);
  }
  return roles;
}

function decodeDlmmDeployReceipt(transaction, { position, pool, walletAddress }) {
  const keys = strictAccountKeys(transaction);
  const instructions = strictConfirmedInstructions(transaction, keys);
  if (instructions.some((instruction) => !ALLOWED_DEPLOY_OUTER_PROGRAMS.has(instruction.program_id))) {
    throw new Error("Deploy receipt contains an unknown outer program action");
  }
  const canonicalPosition = canonicalLedgerIdentifier(position, "Deploy receipt position");
  const canonicalPool = canonicalLedgerIdentifier(pool, "Deploy receipt pool");
  const dlmmInstructions = instructions.filter((instruction) => instruction.program_id === DLMM_PROGRAM_ID)
    .map((instruction) => {
      const decoded = dlmmInstructionCoder.decode(instruction.data);
      if (!decoded) throw new Error("Deploy receipt contains an unrecognized Meteora DLMM instruction discriminator");
      return { ...instruction, decoded };
    });
  if (dlmmInstructions.length === 0) throw new Error("Deploy receipt contains no Meteora DLMM instruction");

  const liquidityActions = dlmmInstructions.filter((instruction) => DLMM_LIQUIDITY_INSTRUCTIONS.has(instruction.decoded.name));
  const setupActions = dlmmInstructions.filter((instruction) => DLMM_SETUP_INSTRUCTIONS.has(instruction.decoded.name));
  if (dlmmInstructions.length !== liquidityActions.length + setupActions.length) {
    throw new Error("Deploy receipt contains a mixed or unsupported Meteora DLMM action");
  }

  const assertSetupRoles = (instruction) => {
    if (instruction.accounts.length < 4 || instruction.accounts[1] !== canonicalPosition || instruction.accounts[2] !== canonicalPool || instruction.accounts[0] !== walletAddress || instruction.accounts[3] !== walletAddress) {
      throw new Error("Meteora position setup instruction is not bound to the expected position, pool, and wallet roles");
    }
  };
  for (const instruction of setupActions) assertSetupRoles(instruction);

  if (liquidityActions.length === 0) {
    if (setupActions.length !== 1) throw new Error("Setup receipt must contain exactly one expected Meteora position setup action");
    const preTokenBalances = tokenBalanceByAccount(transaction.meta, "preTokenBalances", keys);
    const postTokenBalances = tokenBalanceByAccount(transaction.meta, "postTokenBalances", keys);
    assertSetupHasNoWalletTokenOrDirectSolDebit({
      instructions,
      walletAddress,
      preTokenBalances,
      postTokenBalances,
    });
    return {
      kind: "setup",
      instruction: setupActions[0].decoded.name,
      position: canonicalPosition,
      pool: canonicalPool,
      deposit_lamports: "0",
    };
  }
  if (liquidityActions.length !== 1) {
    throw new Error("Liquidity receipt must contain exactly one position-bound Meteora liquidity action");
  }
  const action = liquidityActions[0];
  const parameter = action.decoded.data?.liquidity_parameter;
  const amountX = parameter?.amount_x;
  const amountY = parameter?.amount_y;
  if (amountX == null || amountY == null) throw new Error("Decoded Meteora liquidity instruction lacks exact amount_x/amount_y fields");
  const x = BigInt(amountX.toString());
  const y = BigInt(amountY.toString());
  if (x !== 0n || y <= 0n) throw new Error("Deploy receipt is not an exact single-side SOL/token-Y liquidity action");
  const roles = liquidityAccountRolesForInstruction(action.decoded.name);
  const highestRoleIndex = Math.max(...Object.values(roles));
  if (action.accounts.length <= highestRoleIndex ||
      action.accounts[roles.position] !== canonicalPosition ||
      action.accounts[roles.lb_pair] !== canonicalPool ||
      action.accounts[roles.token_y_mint] !== NATIVE_SOL_MINT ||
      action.accounts[roles.sender] !== walletAddress ||
      action.accounts[roles.token_y_program] !== LEGACY_TOKEN_PROGRAM_ID) {
    throw new Error("Meteora liquidity instruction is not bound to expected position, lbPair, token-Y mint, and sender roles");
  }
  const userTokenY = action.accounts[roles.user_token_y];
  const reserveY = action.accounts[roles.reserve_y];
  const preTokenBalances = tokenBalanceByAccount(transaction.meta, "preTokenBalances", keys);
  const postTokenBalances = tokenBalanceByAccount(transaction.meta, "postTokenBalances", keys);
  const userYDelta = tokenDeltaForAccountOrNull(preTokenBalances, postTokenBalances, userTokenY, NATIVE_SOL_MINT);
  const reserveYDelta = tokenDeltaForAccount(preTokenBalances, postTokenBalances, reserveY, NATIVE_SOL_MINT, "pool reserve-Y");
  let depositLamports = y;
  let fundingModel = "persistent_wsol_spl_delta";
  let structuralResidualLamports = 0n;
  if (userYDelta === -y && reserveYDelta === y) {
    // Existing WSOL account: exact pre/post SPL deltas establish both sides.
  } else if (userYDelta == null) {
    // Standard single-sided SOL deployment creates, funds, syncs, consumes and
    // closes a WSOL account atomically. Such a transaction-local account is
    // intentionally absent from both RPC token-balance snapshots, so prove
    // the user leg from its exact outer instruction lifecycle instead.
    assertAtomicNativeSolWrapLifecycle({
      instructions,
      walletAddress,
      userTokenY,
      amountY: y,
      liquidityInstructionIndex: action.index,
    });
    if (reserveYDelta <= 0n || reserveYDelta > y) {
      throw new Error("Atomic native-SOL deploy does not prove a positive reserve-Y liquidity delta within its funded amount");
    }
    structuralResidualLamports = y - reserveYDelta;
    if (structuralResidualLamports > nativeSolStructuralResidualLimitLamports()) {
      throw new Error("Atomic native-SOL deploy leaves an excessive unexplained WSOL structural residual");
    }
    // The position-bound transaction consumes the funded amount and proves
    // any bounded residue was atomically returned to the same wallet. Record
    // the exact funded basis; the residue remains explicit audit evidence.
    depositLamports = y;
    fundingModel = "atomic_native_sol_wrap";
  } else {
    throw new Error("Meteora liquidity instruction amount is not proven by exact user-token and pool-reserve SPL deltas");
  }
  assertNoUnrelatedDeployDebits({
    instructions,
    walletAddress,
    userTokenY,
    amountY: y,
    preTokenBalances,
    postTokenBalances,
  });
  return {
    kind: "liquidity",
    instruction: action.decoded.name,
    position: canonicalPosition,
    pool: canonicalPool,
    user_token_y: userTokenY,
    reserve_y: reserveY,
    token_y_mint: NATIVE_SOL_MINT,
    requested_amount_y_lamports: y.toString(),
    reserve_y_delta_lamports: reserveYDelta.toString(),
    deposit_lamports: depositLamports.toString(),
    structural_residual_lamports: structuralResidualLamports.toString(),
    funding_model: fundingModel,
  };
}

function validateInspectedLedgerReceipt(details, signature) {
  if (!isPlainObject(details)) {
    throw new TypeError(`Inspected transaction ${signature} must return an object`);
  }
  if (details.executionStatus !== "succeeded" && details.executionStatus !== "failed") {
    throw new TypeError(`Inspected transaction ${signature} must include executionStatus exactly \"succeeded\" or \"failed\"`);
  }
  const bigintFields = [
    ["walletDeltaLamports", true],
    ["txFeeLamports", false],
    ["rentCreatedLamports", false],
    ["rentReclaimedLamports", false],
  ];
  for (const [field, allowNegative] of bigintFields) {
    if (typeof details[field] !== "bigint") {
      throw new TypeError(`Inspected transaction ${signature}.${field} must be a bigint`);
    }
    if (!allowNegative && details[field] < 0n) {
      throw new RangeError(`Inspected transaction ${signature}.${field} cannot be negative`);
    }
  }
  for (const field of ["tokenDeltas", "tokenAccountEvidence"]) {
    if (!Array.isArray(details[field])) {
      throw new TypeError(`Inspected transaction ${signature}.${field} must be an array`);
    }
    if (details[field].some((row) => !isPlainObject(row))) {
      throw new TypeError(`Inspected transaction ${signature}.${field} must contain object rows`);
    }
  }
  if (details.slot != null && !isNonNegativeSafeInteger(details.slot)) {
    throw new TypeError(`Inspected transaction ${signature}.slot must be a non-negative safe integer or null`);
  }
  if (details.executionStatus === "failed" && (
    details.rentCreatedLamports !== 0n ||
    details.rentReclaimedLamports !== 0n ||
    details.tokenDeltas.length !== 0 ||
    details.tokenAccountEvidence.length !== 0
  )) {
    throw new Error(`Failed inspected transaction ${signature} may contain only fee and liquid-wallet evidence`);
  }
  return details;
}

export async function inspectLedgerTransaction(signature, {
  walletAddress,
  ownedAccounts = [],
  connection: rpc = getConnection(),
  deployContext = null,
} = {}) {
  const tx = await rpc.getTransaction(signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  if (!tx?.meta || typeof tx.meta !== "object" || Array.isArray(tx.meta)) {
    throw new Error(`Confirmed transaction ${signature} is unavailable from RPC or has structurally invalid metadata`);
  }
  if (!Object.hasOwn(tx.meta, "err") || tx.meta.err === undefined) {
    throw new Error(`Confirmed transaction ${signature} is missing an own meta.err execution classification`);
  }
  if (!Object.hasOwn(tx.meta, "fee")) {
    throw new Error(`Confirmed transaction ${signature} is missing an own meta.fee`);
  }
  const keys = strictAccountKeys(tx);
  const walletIndex = keys.indexOf(walletAddress);
  if (walletIndex < 0) throw new Error(`Wallet ${walletAddress} not found in transaction ${signature}`);
  const balances = strictLamportBalances(tx.meta, keys);
  const preTokens = strictTokenBalances(tx.meta, "preTokenBalances", keys);
  const postTokens = strictTokenBalances(tx.meta, "postTokenBalances", keys);
  const walletDelta = balances.post[walletIndex] - balances.pre[walletIndex];
  // A missing classification is not equivalent to success. RPC receipts are
  // successful only when their own meta.err field is exactly null.
  const executionStatus = tx.meta.err === null ? "succeeded" : "failed";
  const txFeeLamports = lamportBigInt(tx.meta.fee, "meta.fee");

  // A confirmed signature can still have failed on chain. Its wallet balance
  // and charged fee remain auditable, but it cannot establish token ownership,
  // rent economics, or cleanup provenance.
  if (executionStatus === "failed") {
    return {
      signature,
      executionStatus,
      walletDeltaLamports: walletDelta,
      txFeeLamports,
      rentCreatedLamports: 0n,
      rentReclaimedLamports: 0n,
      tokenDeltas: [],
      tokenAccountEvidence: [],
      slot: tx.slot,
      deployReceiptEvidence: null,
    };
  }

  let rentCreated = 0n;
  let rentReclaimed = 0n;
  const owned = new Set(ownedAccounts.filter(Boolean));

  const preTokenMap = tokenRawByIndex(preTokens, walletAddress);
  const postTokenMap = tokenRawByIndex(postTokens, walletAddress);
  const tokenDeltas = [];
  const tokenAccountEvidence = [];
  for (const key of new Set([...preTokenMap.keys(), ...postTokenMap.keys()])) {
    const observation = postTokenMap.get(key) || preTokenMap.get(key);
    const accountIndex = observation.accountIndex;
    const mint = observation.mint;
    const pre = preTokenMap.get(key)?.rawAmount || 0n;
    const post = postTokenMap.get(key)?.rawAmount || 0n;
    const delta = post - pre;
    const account = keys[accountIndex] || null;
    if (delta !== 0n) tokenDeltas.push({ mint, account: keys[accountIndex] || null, raw_amount: delta.toString() });
    // The normalized ledger token_deltas schema intentionally contains only
    // delta amounts. Persist this richer confirmed observation in metadata so
    // cleanup can prove a zero opening balance and exact current ownership.
    if (account) {
      tokenAccountEvidence.push({
        account,
        mint,
        pre_raw_amount: pre.toString(),
        post_raw_amount: post.toString(),
        raw_amount: delta.toString(),
      });
    }
    if (keys[accountIndex]) owned.add(keys[accountIndex]);
  }

  for (const account of owned) {
    const index = keys.indexOf(account);
    if (index < 0) continue;
    const pre = balances.pre[index];
    const post = balances.post[index];
    // Lamport balances, unlike SPL balance rows, include an already-existing
    // zero-token account. A zero lamport pre-balance therefore proves this
    // transaction created/funded the owned account.
    if (pre === 0n && post > 0n) rentCreated += post;
    if (pre > 0n && post === 0n) rentReclaimed += pre;
  }

  let deployReceiptEvidence = null;
  if (deployContext != null) {
    try {
      deployReceiptEvidence = decodeDlmmDeployReceipt(tx, {
        position: deployContext.position,
        pool: deployContext.pool,
        walletAddress,
      });
    } catch (error) {
      // Preserve the confirmed receipt with zero attributed deposit so a
      // matching generic wallet debit cannot disappear or become liquidity.
      // The finalizer sees this invalid evidence and latches reconciliation.
      deployReceiptEvidence = {
        kind: "invalid",
        position: String(deployContext.position ?? ""),
        pool: String(deployContext.pool ?? ""),
        reason: String(error.message || error).replace(/[\r\n]+/g, " ").slice(0, 500),
      };
    }
  }
  return {
    signature,
    executionStatus,
    walletDeltaLamports: walletDelta,
    txFeeLamports,
    rentCreatedLamports: rentCreated,
    rentReclaimedLamports: rentReclaimed,
    tokenDeltas,
    tokenAccountEvidence,
    slot: tx.slot,
    deployReceiptEvidence,
  };
}

function normalizeLayers(amountLamports, layers = []) {
  if (!Array.isArray(layers) || layers.length === 0) {
    return [{ layer_id: "single", expected_deposit_lamports: String(amountLamports) }];
  }
  const normalized = layers.map((layer, index) => {
    const layerId = canonicalLedgerIdentifier(
      layer?.layer_id ?? `${String(layer?.strategy || "layer")}_${index + 1}`,
      `layers[${index}].layer_id`,
    );
    const explicitLamports = layer?.expected_deposit_lamports;
    const expectedDepositLamports = explicitLamports != null
      ? lamportBigInt(explicitLamports, `layers[${index}].expected_deposit_lamports`)
      : (() => {
          const amount = Number(layer?.amount_y);
          if (!Number.isFinite(amount) || amount < 0) {
            throw new TypeError(`layers[${index}].amount_y must be a non-negative finite SOL amount`);
          }
          const lamports = Math.round(amount * 1e9);
          if (!Number.isSafeInteger(lamports)) {
            throw new RangeError(`layers[${index}].amount_y cannot be represented as a safe lamport integer`);
          }
          return BigInt(lamports);
        })();
    return {
      layer_id: layerId,
      expected_deposit_lamports: expectedDepositLamports.toString(),
    };
  });
  if (new Set(normalized.map((layer) => layer.layer_id)).size !== normalized.length) {
    throw new Error("Deploy lifecycle expected layer identifiers must be unique");
  }
  const sum = normalized.reduce((total, item) => total + BigInt(item.expected_deposit_lamports), 0n);
  const expected = BigInt(amountLamports);
  if (sum !== expected && normalized.length > 0) {
    throw new Error(`Deploy lifecycle expected layer amounts (${sum}) must exactly equal requested amount (${expected})`);
  }
  return normalized;
}

function normalizeDeployReceiptSignatures(txs) {
  if (!Array.isArray(txs) || txs.length === 0) {
    throw new TypeError("Deploy lifecycle requires a non-empty array of receipt signatures");
  }
  const signatures = [];
  const seen = new Set();
  for (const value of txs) {
    const signature = canonicalLedgerIdentifier(value, "Deploy lifecycle receipt signature");
    if (seen.has(signature)) throw new Error(`Deploy lifecycle receipt signatures must be unique: ${signature}`);
    seen.add(signature);
    signatures.push(signature);
  }
  return signatures;
}

function unknownDeployReceiptProvenance(signatures, reason) {
  return {
    complete: false,
    reason,
    mappings: signatures.map((signature) => ({ signature, kind: "unmapped", layer_id: null })),
  };
}

/**
 * A deploy receipt is attributed only when the producer identifies it as a
 * liquidity or setup transaction. This deliberately does not infer layers
 * from transaction order: wide-range deploys create accounts before adding
 * any liquidity.
 */
function normalizeDeployReceiptProvenance(receiptProvenance, signatures, expectedLayers) {
  if (!Array.isArray(receiptProvenance)) {
    return unknownDeployReceiptProvenance(signatures, "No explicit deploy receipt provenance was supplied");
  }
  const knownLayers = new Set(expectedLayers.map((layer) => layer.layer_id));
  const bySignature = new Map();
  try {
    for (const [index, mapping] of receiptProvenance.entries()) {
      if (!isPlainObject(mapping)) throw new TypeError(`receiptProvenance[${index}] must be an object`);
      const keys = Object.keys(mapping).sort();
      const expectedKeys = ["kind", "layer_id", "signature"];
      if (keys.length !== expectedKeys.length || keys.some((key, keyIndex) => key !== expectedKeys[keyIndex])) {
        throw new TypeError(`receiptProvenance[${index}] must contain only signature, kind, and layer_id`);
      }
      const signature = canonicalLedgerIdentifier(mapping.signature, `receiptProvenance[${index}].signature`);
      if (!signatures.includes(signature) || bySignature.has(signature)) {
        throw new Error(`receiptProvenance[${index}] must map one submitted receipt exactly once`);
      }
      if (mapping.kind !== "liquidity" && mapping.kind !== "setup") {
        throw new TypeError(`receiptProvenance[${index}].kind must be liquidity or setup`);
      }
      if (mapping.kind === "liquidity") {
        const layerId = canonicalLedgerIdentifier(mapping.layer_id, `receiptProvenance[${index}].layer_id`);
        if (!knownLayers.has(layerId)) throw new Error(`receiptProvenance[${index}] references unknown layer ${layerId}`);
        bySignature.set(signature, { signature, kind: "liquidity", layer_id: layerId });
      } else {
        if (mapping.layer_id !== null) throw new TypeError(`receiptProvenance[${index}].layer_id must be null for setup receipts`);
        bySignature.set(signature, { signature, kind: "setup", layer_id: null });
      }
    }
    if (bySignature.size !== signatures.length) {
      throw new Error("Deploy receipt provenance does not cover every submitted receipt");
    }
  } catch (error) {
    return unknownDeployReceiptProvenance(signatures, error.message);
  }
  return {
    complete: true,
    reason: null,
    mappings: signatures.map((signature) => bySignature.get(signature)),
  };
}

function immutableDeployRequest({ position, pool, expectedLamports, expectedLayers, receiptProvenance }) {
  return {
    position_address: position,
    pool_address: pool,
    expected_deposit_lamports: String(expectedLamports),
    expected_layers: expectedLayers.map((layer) => ({ ...layer })),
    receipt_provenance: receiptProvenance.mappings.map((mapping) => ({ ...mapping })),
  };
}

function sameJsonValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertDeployRequestMatchesLifecycle(lifecycle, immutable) {
  const recorded = lifecycle?.metadata?.deploy_immutable;
  if (!recorded || !sameJsonValue(recorded, immutable)) {
    throw new Error(`Deploy lifecycle ${lifecycle?.lifecycle_id || immutable.position_address} immutable request/provenance does not match this retry`);
  }
}

function receiptDepositLamports(details, provenance, { position, pool } = {}) {
  if (details.executionStatus !== "succeeded") return 0n;
  const evidence = details.deployReceiptEvidence;
  if (!isPlainObject(evidence) || evidence.kind === "invalid") {
    throw new Error(evidence?.reason || "Deploy receipt lacks independently decoded Meteora position-bound evidence");
  }
  if (evidence.position !== position || evidence.pool !== pool) {
    throw new Error("Deploy receipt evidence is bound to a different position or Meteora lbPair");
  }
  if (provenance.kind === "unmapped") {
    return 0n;
  }
  if (provenance.kind === "setup") {
    if (evidence.kind !== "setup" || evidence.deposit_lamports !== "0") {
      throw new Error("Setup receipt must prove a position setup action and contributes zero liquidity basis");
    }
    return 0n;
  }
  if (provenance.kind !== "liquidity" || evidence.kind !== "liquidity") {
    throw new Error("Deploy receipt producer mapping and independently decoded action disagree");
  }
  return lamportBigInt(evidence.deposit_lamports, "deployReceiptEvidence.deposit_lamports");
}

export async function recordDeployLifecycle({
  position,
  pool,
  amountSol,
  layers = [],
  txs = [],
  receiptProvenance,
  walletAddress,
  metadata = {},
  inspectTransaction = inspectLedgerTransaction,
  store = getTradeLedger(),
  ledgerEnabled = config.ledger?.enabled,
  updatePosition = updatePositionAccounting,
  allowActivation = true,
}) {
  if (!ledgerEnabled || !position || !Array.isArray(txs) || txs.length === 0) return null;
  const canonicalPosition = canonicalLedgerIdentifier(position, "Deploy lifecycle position");
  const canonicalPool = canonicalLedgerIdentifier(pool, "Deploy lifecycle pool");
  const normalizedAmountSol = Number(amountSol);
  if (!Number.isFinite(normalizedAmountSol) || normalizedAmountSol <= 0) {
    throw new TypeError("Deploy lifecycle accounting requires a positive finite amountSol");
  }
  const lifecycleId = lifecycleIdForPosition(canonicalPosition);
  const expectedLamports = Math.round(normalizedAmountSol * 1e9);
  if (!Number.isSafeInteger(expectedLamports) || expectedLamports <= 0) {
    throw new RangeError("Deploy lifecycle amountSol cannot be represented as a positive safe lamport integer");
  }
  const expectedLayers = normalizeLayers(expectedLamports, layers);
  const signatures = normalizeDeployReceiptSignatures(txs);
  const normalizedProvenance = normalizeDeployReceiptProvenance(receiptProvenance, signatures, expectedLayers);
  const immutable = immutableDeployRequest({
    position: canonicalPosition,
    pool: canonicalPool,
    expectedLamports,
    expectedLayers,
    receiptProvenance: normalizedProvenance,
  });
  let lifecycle = store.getLifecycle(lifecycleId);
  // The lifecycle_created event is the durable boundary for deploy retry
  // identity. BASIS_PENDING retries are bound just as tightly as terminal
  // ACTIVE/RECONCILIATION_REQUIRED retries, so a crash cannot reopen the
  // request with a different pool, amount, layer order, or receipt mapping.
  if (lifecycle) assertDeployRequestMatchesLifecycle(lifecycle, immutable);
  if (lifecycle?.state === LIFECYCLE_STATES.ACTIVE) {
    for (const signature of signatures) {
      const recorded = store.findTransaction?.(lifecycleId, signature);
      if (!recorded || recorded.phase !== "deploy") {
        throw new Error(`Active deploy lifecycle ${lifecycleId} cannot accept a new or differently attributed receipt ${signature}`);
      }
    }
    return lifecycle;
  }
  if (lifecycle?.state === LIFECYCLE_STATES.RECONCILIATION_REQUIRED) {
    for (const signature of signatures) {
      const recorded = store.findTransaction?.(lifecycleId, signature);
      if (!recorded || recorded.phase !== "deploy") {
        throw new Error(`Reconciliation-required deploy lifecycle ${lifecycleId} cannot accept a new or differently attributed receipt ${signature}`);
      }
    }
    return lifecycle;
  }
  if (!lifecycle) {
    store.createLifecycle({
      lifecycle_id: lifecycleId,
      position_address: canonicalPosition,
      pool_address: canonicalPool,
      expected_deposit_lamports: expectedLamports,
      expected_layers: expectedLayers,
      // Historical deposits are not stored in a Meteora position account.
      // Receipt-bound decoded SPL reserve deltas are the authoritative basis;
      // no fake repeat AccountInfo amount read is required for activation.
      required_stable_basis_reads: 0,
      // Receipt-derived deposits match the immutable layer plan exactly.
      layer_tolerance_lamports: 0,
      observation_tolerance_lamports: 0,
      metadata: {
        ...metadata,
        deploy_immutable: immutable,
      },
    });
    store.transitionLifecycle(lifecycleId, LIFECYCLE_STATES.BASIS_PENDING, { reason: "deploy transactions confirmed" });
    lifecycle = store.getLifecycle(lifecycleId);
  }

  const requireReconciliation = (reason) => {
    const current = store.getLifecycle(lifecycleId);
    if (current && current.state !== LIFECYCLE_STATES.RECONCILIATION_REQUIRED) {
      store.transitionLifecycle(lifecycleId, LIFECYCLE_STATES.RECONCILIATION_REQUIRED, { reason });
    }
    updatePosition(canonicalPosition, {
      basis_status: "INVALID",
      ledger_status: "RECONCILIATION_REQUIRED",
      local_cost_basis_lamports: null,
    });
    return store.getLifecycle(lifecycleId);
  };

  let totalFees = 0n;
  let totalRent = 0n;
  let failedReceiptRecorded = false;
  let invalidReceiptEvidence = null;
  try {
    for (let index = 0; index < signatures.length; index++) {
      const signature = signatures[index];
      const provenance = normalizedProvenance.mappings[index];
      const alreadyRecorded = store.findTransaction?.(lifecycleId, signature);
      if (alreadyRecorded) {
        if (alreadyRecorded.phase !== "deploy") {
          throw new Error(`Deploy signature ${signature} is already attributed to ${alreadyRecorded.phase}`);
        }
        if (alreadyRecorded.layer_id !== provenance.layer_id ||
          !sameJsonValue(alreadyRecorded.metadata?.deploy_receipt_provenance, provenance)) {
          throw new Error(`Deploy signature ${signature} has conflicting immutable receipt provenance`);
        }
        totalFees += BigInt(alreadyRecorded.amounts.tx_fee_lamports);
        totalRent += BigInt(alreadyRecorded.amounts.rent_created_lamports);
        failedReceiptRecorded ||= alreadyRecorded.execution_status === "failed";
        continue;
      }
      const details = validateInspectedLedgerReceipt(await inspectTransaction(signature, {
        walletAddress,
        ownedAccounts: [canonicalPosition],
        deployContext: {
          position: canonicalPosition,
          pool: canonicalPool,
        },
      }), signature);
      const executionStatus = details.executionStatus;
      totalFees += details.txFeeLamports;
      totalRent += details.rentCreatedLamports;
      let deposit = 0n;
      let receiptEvidenceError = null;
      try {
        deposit = receiptDepositLamports(details, provenance, {
          position: canonicalPosition,
          pool: canonicalPool,
        });
      } catch (error) {
        receiptEvidenceError = String(error.message || error);
        invalidReceiptEvidence ||= receiptEvidenceError;
      }
      try {
        store.recordTransaction({
          lifecycle_id: lifecycleId,
          signature,
          phase: "deploy",
          layer_id: provenance.layer_id,
          execution_status: executionStatus,
          amounts: {
            deposit_lamports: deposit,
            liquid_wallet_delta_lamports: details.walletDeltaLamports,
            tx_fee_lamports: details.txFeeLamports,
            rent_created_lamports: executionStatus === "succeeded" ? details.rentCreatedLamports : 0n,
          },
          token_deltas: executionStatus === "succeeded" ? details.tokenDeltas : [],
          metadata: {
            slot: details.slot,
            tx_index: index,
            deploy_receipt_provenance: provenance,
            deploy_receipt_evidence: executionStatus === "succeeded" ? details.deployReceiptEvidence : null,
            ...(receiptEvidenceError ? { deploy_receipt_evidence_error: receiptEvidenceError } : {}),
            token_account_evidence: executionStatus === "succeeded" ? details.tokenAccountEvidence : [],
          },
        });
      } catch (error) {
        const concurrentlyRecorded = store.findTransaction?.(lifecycleId, signature);
        if (!concurrentlyRecorded || concurrentlyRecorded.phase !== "deploy") throw error;
      }
      failedReceiptRecorded ||= executionStatus === "failed";
    }
  } catch (error) {
    requireReconciliation(`Deploy receipt inspection/accounting failed: ${error.message}`);
    throw error;
  }

  if (failedReceiptRecorded) {
    return requireReconciliation("One or more confirmed deploy receipts failed on chain");
  }
  if (invalidReceiptEvidence) {
    return requireReconciliation(`Deploy receipt evidence is invalid or ambiguous: ${invalidReceiptEvidence}`);
  }
  if (!normalizedProvenance.complete) {
    return requireReconciliation(`Deploy receipt provenance is incomplete or ambiguous: ${normalizedProvenance.reason}`);
  }
  if (allowActivation !== true) {
    return requireReconciliation("Deploy result requires reconciliation; authoritative receipt records remain non-active");
  }

  lifecycle = store.getLifecycle(lifecycleId);
  if (!lifecycle.cost_basis.all_layers_complete || !lifecycle.cost_basis.total_complete) {
    return requireReconciliation(`Receipt-derived deploy economics are incomplete: ${lifecycle.cost_basis.reason_codes.join(", ")}`);
  }

  lifecycle = store.getLifecycle(lifecycleId);
  if (!lifecycle.cost_basis.ready || lifecycle.cost_basis.usable_basis_lamports !== immutable.expected_deposit_lamports) {
    return requireReconciliation(lifecycle.cost_basis.reason_codes.join(", "));
  }
  try {
    store.transitionLifecycle(lifecycleId, LIFECYCLE_STATES.ACTIVE, { reason: "complete position-bound decoded DLMM receipt basis" });
    updatePosition(position, {
      lifecycle_id: lifecycleId,
      basis_status: "READY",
      ledger_status: "ACTIVE",
      local_cost_basis_lamports: lifecycle.cost_basis.usable_basis_lamports,
      transaction_signatures: signatures,
      deploy_tx_fees_lamports: Number(totalFees),
      rent_created_lamports: Number(totalRent),
    });
    return store.getLifecycle(lifecycleId);
  } catch (error) {
    return requireReconciliation(`Deploy receipt-basis activation failed: ${error.message}`);
  }
}

/**
 * Re-inspect one previously latched successful deploy receipt and, only when
 * the current decoder proves exact immutable position/pool/layer economics,
 * append a corrected interpretation plus an explicit latch-clear event. The
 * original event remains untouched for audit/replay provenance.
 */
export async function reconcileDeployLifecycle({
  position,
  signature,
  walletAddress,
  baseMint = null,
  reconciliationId = `deploy-receipt:${crypto.randomUUID()}`,
  inspectTransaction = inspectLedgerTransaction,
  store = getTradeLedger(),
  ledgerEnabled = config.ledger?.enabled,
  updatePosition = updatePositionAccounting,
}) {
  if (!ledgerEnabled) throw new Error("Deploy receipt reconciliation requires the authoritative trade ledger");
  const canonicalPosition = canonicalLedgerIdentifier(position, "Deploy reconciliation position");
  const canonicalSignature = canonicalLedgerIdentifier(signature, "Deploy reconciliation signature");
  const canonicalReconciliationId = canonicalLedgerIdentifier(reconciliationId, "Deploy reconciliation id");
  const canonicalWallet = canonicalLedgerIdentifier(walletAddress, "Deploy reconciliation wallet");
  const lifecycleId = lifecycleIdForPosition(canonicalPosition);
  let lifecycle = store.getLifecycle(lifecycleId);
  if (!lifecycle || lifecycle.position_address !== canonicalPosition ||
      lifecycle.state !== LIFECYCLE_STATES.RECONCILIATION_REQUIRED || !lifecycle.reconciliation_latched) {
    throw new Error(`Deploy reconciliation requires the exact latched lifecycle ${lifecycleId}`);
  }
  const immutable = lifecycle.metadata?.deploy_immutable;
  if (!immutable || immutable.position_address !== canonicalPosition || immutable.pool_address !== lifecycle.pool_address) {
    throw new Error(`Deploy lifecycle ${lifecycleId} lacks immutable position/pool receipt provenance`);
  }
  const provenance = immutable.receipt_provenance?.find((item) => item?.signature === canonicalSignature);
  if (!provenance || provenance.kind !== "liquidity" || !provenance.layer_id) {
    throw new Error(`Deploy reconciliation signature is not one immutable liquidity receipt for ${lifecycleId}`);
  }
  const originalEvent = store.readEvents({ lifecycle_id: lifecycleId }).find((event) => (
    event.event_type === "transaction_recorded" && event.signature === canonicalSignature
  ));
  if (!originalEvent || originalEvent.phase !== "deploy" || originalEvent.execution_status !== "succeeded") {
    throw new Error(`Deploy reconciliation could not find the original successful receipt ${canonicalSignature}`);
  }
  if (store.readEvents({ lifecycle_id: lifecycleId }).some((event) => (
    event.event_type === "transaction_reconciled" && event.signature === canonicalSignature
  ))) {
    throw new Error(`Deploy receipt ${canonicalSignature} is already reconciled`);
  }
  const details = validateInspectedLedgerReceipt(await inspectTransaction(canonicalSignature, {
    walletAddress: canonicalWallet,
    ownedAccounts: [canonicalPosition],
    deployContext: { position: canonicalPosition, pool: lifecycle.pool_address },
  }), canonicalSignature);
  if (details.executionStatus !== "succeeded") {
    throw new Error(`Deploy reconciliation receipt ${canonicalSignature} did not succeed on chain`);
  }
  const deposit = receiptDepositLamports(details, provenance, {
    position: canonicalPosition,
    pool: lifecycle.pool_address,
  });
  store.reconcileTransaction({
    lifecycle_id: lifecycleId,
    signature: canonicalSignature,
    reconciliation_id: canonicalReconciliationId,
    original_event_id: originalEvent.event_id,
    amounts: {
      deposit_lamports: deposit,
      liquid_wallet_delta_lamports: details.walletDeltaLamports,
      tx_fee_lamports: details.txFeeLamports,
      rent_created_lamports: details.rentCreatedLamports,
      rent_reclaimed_lamports: details.rentReclaimedLamports,
    },
    token_deltas: details.tokenDeltas,
    metadata: {
      slot: details.slot,
      original_event_id: originalEvent.event_id,
      deploy_receipt_provenance: provenance,
      deploy_receipt_evidence: details.deployReceiptEvidence,
      token_account_evidence: details.tokenAccountEvidence,
    },
  });
  lifecycle = store.getLifecycle(lifecycleId);
  if (!lifecycle.cost_basis.ready) {
    throw new Error(`Reconciled receipt economics remain incomplete for ${lifecycleId}: ${lifecycle.cost_basis.reason_codes.join(", ")}`);
  }
  store.clearReconciliationLatch(lifecycleId, {
    reconciliation_id: canonicalReconciliationId,
    reason: "confirmed on-chain atomic native-SOL deploy receipt re-decoded with position-bound evidence",
  });
  store.transitionLifecycle(lifecycleId, LIFECYCLE_STATES.ACTIVE, {
    reason: "explicit deploy receipt reconciliation established exact cost basis",
  });
  lifecycle = store.getLifecycle(lifecycleId);
  updatePosition(canonicalPosition, {
    lifecycle_id: lifecycleId,
    ...(baseMint ? { base_mint: canonicalLedgerIdentifier(baseMint, "Deploy reconciliation base mint") } : {}),
    basis_status: "READY",
    ledger_status: "ACTIVE",
    local_cost_basis_lamports: lifecycle.cost_basis.usable_basis_lamports,
    transaction_signatures: lifecycle.signatures,
    deploy_tx_fees_lamports: Number(lifecycle.amounts.tx_fee_lamports),
    rent_created_lamports: Number(lifecycle.amounts.rent_created_lamports),
  });
  return lifecycle;
}

export async function beginCloseLifecycle(position, reason = "close requested") {
  if (!config.ledger?.enabled || !position) return null;
  const store = getTradeLedger();
  const lifecycleId = lifecycleIdForPosition(position);
  const lifecycle = store.getLifecycle(lifecycleId);
  if (!lifecycle) return null;
  if (lifecycle.reconciliation_latched) {
    // A close may still recover funds, but it must not erase or step around a
    // prior reconciliation requirement. The append-only latch is cleared only
    // by an explicit future reconciliation event.
    updatePositionAccounting(position, { ledger_status: "RECONCILIATION_REQUIRED" });
    return lifecycle;
  }
  if ([LIFECYCLE_STATES.ACTIVE, LIFECYCLE_STATES.BASIS_PENDING].includes(lifecycle.state)) {
    store.transitionLifecycle(lifecycleId, LIFECYCLE_STATES.CLOSING, { reason });
  }
  updatePositionAccounting(position, { ledger_status: "CLOSING" });
  return store.getLifecycle(lifecycleId);
}

/**
 * A live claim is only safe when its receipt can be attributed to one
 * existing lifecycle. Unlike a close, a claim does not change the lifecycle
 * state: its token residue remains economically unresolved until scoped
 * cleanup reconciliation.
 */
export function requireLifecycleAttribution(position, {
  store = getTradeLedger(),
  ledgerEnabled = config.ledger?.enabled,
} = {}) {
  if (!ledgerEnabled) {
    return { pass: false, reason: "Authoritative lifecycle ledger is required for a live claim." };
  }
  if (!position) {
    return { pass: false, reason: "A position is required for lifecycle attribution." };
  }
  const lifecycleId = lifecycleIdForPosition(position);
  const lifecycle = store.getLifecycle(lifecycleId);
  if (!lifecycle) {
    return {
      pass: false,
      reason: `No authoritative lifecycle exists for position ${position}; live claim is blocked.`,
    };
  }
  if (lifecycle.state !== LIFECYCLE_STATES.ACTIVE) {
    return {
      pass: false,
      reason: `Lifecycle ${lifecycleId} is ${lifecycle.state}; live claim requires ACTIVE lifecycle attribution.`,
    };
  }
  return { pass: true, lifecycle, lifecycle_id: lifecycleId };
}

export async function recordLifecycleTransactions({
  position,
  walletAddress,
  transactions = [],
  inspectTransaction = inspectLedgerTransaction,
  store = getTradeLedger(),
  ledgerEnabled = config.ledger?.enabled,
}) {
  if (!ledgerEnabled || !position) return null;
  const lifecycleId = lifecycleIdForPosition(position);
  if (!store.getLifecycle(lifecycleId)) return null;
  const failures = [];
  for (const item of transactions) {
    const phase = item?.phase || "other";
    if (!item?.signature) continue;
    const initiallyRecorded = store.findTransaction?.(lifecycleId, item.signature);
    if (initiallyRecorded) {
      if (initiallyRecorded.phase !== phase) {
        failures.push({ signature: item.signature, message: `Signature is already attributed to ${initiallyRecorded.phase}, not ${phase}` });
      }
      continue;
    }
    try {
      const details = validateInspectedLedgerReceipt(await inspectTransaction(item.signature, {
        walletAddress,
        ownedAccounts: [position, ...(item.ownedAccounts || [])],
      }), item.signature);
      const executionStatus = details.executionStatus;
      const positiveEconomicInflow = executionStatus === "succeeded"
        ? details.walletDeltaLamports + details.txFeeLamports
          + details.rentCreatedLamports - details.rentReclaimedLamports
        : 0n;
      store.recordTransaction({
        lifecycle_id: lifecycleId,
        signature: item.signature,
        phase,
        execution_status: executionStatus,
        amounts: {
          withdrawal_lamports: positiveEconomicInflow > 0n ? positiveEconomicInflow : 0n,
          liquid_wallet_delta_lamports: details.walletDeltaLamports,
          tx_fee_lamports: details.txFeeLamports,
          rent_created_lamports: executionStatus === "succeeded" ? details.rentCreatedLamports : 0n,
          rent_reclaimed_lamports: executionStatus === "succeeded" ? details.rentReclaimedLamports : 0n,
        },
        token_deltas: executionStatus === "succeeded" ? details.tokenDeltas : [],
        // Account ownership hints are not cleanup provenance. Only the confirmed
        // pre/post raw balance evidence below can establish attributable residue.
        metadata: {
          slot: details.slot,
          owned_accounts: [...new Set([position, ...(item.ownedAccounts || [])].filter(Boolean).map(String))],
          token_account_evidence: executionStatus === "succeeded" ? details.tokenAccountEvidence : [],
        },
      });
    } catch (error) {
      // Inspection is asynchronous. Another process may append the exact
      // receipt while this caller is waiting for RPC; re-read under the
      // ledger's append serialization and treat that exact phase as success.
      const concurrentlyRecorded = store.findTransaction?.(lifecycleId, item.signature);
      if (!concurrentlyRecorded || concurrentlyRecorded.phase !== phase) {
        failures.push({ signature: item.signature, message: error.message });
      }
    }
  }
  if (failures.length > 0) {
    const error = new Error(`Could not inspect lifecycle receipts: ${failures.map((failure) => `${failure.signature} (${failure.message})`).join(", ")}`);
    error.unrecorded_signatures = failures.map((failure) => failure.signature);
    error.receipt_failures = failures;
    throw error;
  }
  return store.getLifecycle(lifecycleId);
}

/**
 * Append an already-confirmed manual token-to-SOL swap to one cleanup-pending
 * lifecycle only when the receipt proves the exact lifecycle source debit,
 * no other wallet token debit, and strict post-close ordering. This is an
 * explicit reconciliation path; it never submits or signs a transaction.
 */
export async function reconcileConfirmedManualCleanupSwap({
  position,
  signature,
  sourceTokenAccount,
  mint,
  tokenProgram,
  expectedRawAmount,
  walletAddress,
  inspectTransaction = inspectLedgerTransaction,
  store = getTradeLedger(),
  ledgerEnabled = config.ledger?.enabled,
} = {}) {
  if (!ledgerEnabled) throw new Error("Authoritative lifecycle ledger is required for manual cleanup reconciliation");
  const canonicalPosition = canonicalLedgerIdentifier(position, "Manual cleanup position");
  const canonicalSignature = canonicalLedgerIdentifier(signature, "Manual cleanup signature");
  const canonicalSource = canonicalLedgerIdentifier(sourceTokenAccount, "Manual cleanup source account");
  const canonicalMint = canonicalLedgerIdentifier(mint, "Manual cleanup mint");
  const canonicalProgram = canonicalLedgerIdentifier(tokenProgram, "Manual cleanup token program");
  const canonicalWallet = canonicalLedgerIdentifier(walletAddress, "Manual cleanup wallet");
  const expectedRaw = lamportBigInt(expectedRawAmount, "Manual cleanup expected raw amount");
  if (expectedRaw === 0n) throw new Error("Manual cleanup expected raw amount must be positive");
  if (![LEGACY_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].includes(canonicalProgram)) {
    throw new Error("Manual cleanup source token program is unsupported");
  }
  const lifecycleId = lifecycleIdForPosition(canonicalPosition);
  let lifecycle = store.getLifecycle(lifecycleId);
  if (!lifecycle || lifecycle.state !== LIFECYCLE_STATES.CLEANUP_PENDING || lifecycle.reconciliation_latched) {
    throw new Error(`Manual cleanup reconciliation requires an unlatched CLEANUP_PENDING lifecycle: ${lifecycleId}`);
  }
  const existing = store.findTransaction?.(lifecycleId, canonicalSignature);
  if (existing) {
    if (existing.phase !== "swap") throw new Error(`Manual cleanup signature is already attributed to ${existing.phase}`);
    return lifecycle;
  }
  const closeEvents = store.readEvents({ lifecycle_id: lifecycleId })
    .filter((event) => event.event_type === "transaction_recorded" && event.phase === "close" && event.execution_status === "succeeded");
  if (closeEvents.length === 0) throw new Error("Manual cleanup reconciliation requires a successful close receipt");
  const lastCloseSlot = Math.max(...closeEvents.map((event) => Number(event.metadata?.slot)).filter(Number.isSafeInteger));
  if (!Number.isSafeInteger(lastCloseSlot)) throw new Error("Close receipt lacks an authoritative slot for manual swap ordering");

  const details = validateInspectedLedgerReceipt(await inspectTransaction(canonicalSignature, {
    walletAddress: canonicalWallet,
    ownedAccounts: [canonicalPosition, canonicalSource],
  }), canonicalSignature);
  if (details.executionStatus !== "succeeded" || !Number.isSafeInteger(details.slot) || details.slot <= lastCloseSlot) {
    throw new Error("Manual cleanup swap did not succeed strictly after the lifecycle close");
  }
  const sourceEvidence = details.tokenAccountEvidence.filter((row) =>
    String(row.account || "") === canonicalSource && String(row.mint || "") === canonicalMint);
  if (sourceEvidence.length !== 1 ||
      String(sourceEvidence[0].pre_raw_amount) !== expectedRaw.toString() ||
      String(sourceEvidence[0].post_raw_amount) !== "0" ||
      String(sourceEvidence[0].raw_amount) !== `-${expectedRaw}`) {
    throw new Error("Manual cleanup receipt does not prove the exact source pre/post debit to zero");
  }
  const walletDebits = details.tokenAccountEvidence.filter((row) =>
    BigInt(String(row.post_raw_amount)) < BigInt(String(row.pre_raw_amount)));
  if (walletDebits.length !== 1 || walletDebits[0] !== sourceEvidence[0]) {
    throw new Error("Manual cleanup receipt contains an unrelated wallet token debit");
  }
  const closeEvidence = closeEvents.flatMap((event) => event.metadata?.token_account_evidence || [])
    .filter((row) => String(row.account || "") === canonicalSource && String(row.mint || "") === canonicalMint);
  if (!closeEvidence.some((row) => String(row.pre_raw_amount) === "0" && String(row.post_raw_amount) === expectedRaw.toString())) {
    throw new Error("Manual cleanup source is not exactly attributable to the confirmed close receipt");
  }

  const positiveEconomicInflow = details.walletDeltaLamports + details.txFeeLamports
    + details.rentCreatedLamports - details.rentReclaimedLamports;
  store.recordTransaction({
    lifecycle_id: lifecycleId,
    signature: canonicalSignature,
    phase: "swap",
    execution_status: "succeeded",
    amounts: {
      withdrawal_lamports: positiveEconomicInflow > 0n ? positiveEconomicInflow : 0n,
      liquid_wallet_delta_lamports: details.walletDeltaLamports,
      tx_fee_lamports: details.txFeeLamports,
      rent_created_lamports: details.rentCreatedLamports,
      rent_reclaimed_lamports: details.rentReclaimedLamports,
    },
    token_deltas: details.tokenDeltas,
    metadata: {
      slot: details.slot,
      owned_accounts: [canonicalPosition, canonicalSource],
      token_account_evidence: details.tokenAccountEvidence,
      reconciliation_source: "confirmed_manual_cleanup_swap",
      token_program: canonicalProgram,
    },
  });
  lifecycle = store.getLifecycle(lifecycleId);
  return lifecycle;
}

function normalizedReceiptRows(rows = [], fields = []) {
  return rows
    .map((row) => Object.fromEntries(fields.map((field) => [
      field,
      row?.[field] == null ? null : String(row[field]),
    ])))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

/**
 * Correct the economic interpretation of one successful close receipt after
 * a decoder/accounting fix. The on-chain facts are re-inspected and must match
 * every original receipt field; only withdrawal_lamports may change. The
 * original journal row remains intact and the replacement is append-only.
 */
export async function reconcileCloseLifecycleReceiptEconomics({
  position,
  signature,
  walletAddress,
  reconciliationId,
  inspectTransaction = inspectLedgerTransaction,
  store = getTradeLedger(),
  ledgerEnabled = config.ledger?.enabled,
} = {}) {
  if (!ledgerEnabled) throw new Error("Close receipt reconciliation requires the authoritative trade ledger");
  const canonicalPosition = canonicalLedgerIdentifier(position, "Close reconciliation position");
  const canonicalSignature = canonicalLedgerIdentifier(signature, "Close reconciliation signature");
  const canonicalWallet = canonicalLedgerIdentifier(walletAddress, "Close reconciliation wallet");
  const canonicalReconciliationId = canonicalLedgerIdentifier(reconciliationId, "Close reconciliation id");
  const lifecycleId = lifecycleIdForPosition(canonicalPosition);
  const latchReason = `close receipt economics correction ${canonicalReconciliationId}`;
  let lifecycle = store.getLifecycle(lifecycleId);
  if (!lifecycle || lifecycle.position_address !== canonicalPosition) {
    throw new Error(`Close reconciliation requires the exact lifecycle ${lifecycleId}`);
  }
  const events = store.readEvents({ lifecycle_id: lifecycleId });
  const originalEvent = events.find((event) => (
    event.event_type === "transaction_recorded" && event.signature === canonicalSignature
  ));
  if (!originalEvent || originalEvent.phase !== "close" || originalEvent.execution_status !== "succeeded") {
    throw new Error(`Close reconciliation could not find the original successful close receipt ${canonicalSignature}`);
  }
  const existingCorrection = events.find((event) => (
    event.event_type === "transaction_reconciled" && event.signature === canonicalSignature
  ));
  if (existingCorrection && existingCorrection.reconciliation_id !== canonicalReconciliationId) {
    throw new Error(`Close receipt ${canonicalSignature} was reconciled by a different reconciliation id`);
  }

  const correctionAlreadyApplied = () => {
    const corrected = store.findTransaction?.(lifecycleId, canonicalSignature);
    return corrected?.reconciliation_id === canonicalReconciliationId;
  };
  const transitionCleanupPending = () => {
    store.transitionLifecycle(lifecycleId, LIFECYCLE_STATES.CLEANUP_PENDING, {
      reason: "close receipt economics reconciled; scoped token cleanup remains pending",
    });
    return store.getLifecycle(lifecycleId);
  };
  const clearOwnedLatch = () => {
    lifecycle = store.getLifecycle(lifecycleId);
    const latestLatch = [...(lifecycle?.reconciliation_history || [])].reverse()
      .find((entry) => entry.type === "latched");
    if (lifecycle?.state !== LIFECYCLE_STATES.RECONCILIATION_REQUIRED ||
        !lifecycle.reconciliation_latched || latestLatch?.reason !== latchReason) {
      throw new Error(`Close reconciliation does not own the active latch for ${lifecycleId}`);
    }
    store.clearReconciliationLatch(lifecycleId, {
      reconciliation_id: canonicalReconciliationId,
      reason: "confirmed close receipt economics corrected with rent-created included in gross withdrawal",
    });
    return transitionCleanupPending();
  };

  if (existingCorrection) {
    if (!correctionAlreadyApplied()) throw new Error(`Close receipt correction is not visible in ${lifecycleId}`);
    if (lifecycle.state === LIFECYCLE_STATES.CLEANUP_PENDING && !lifecycle.reconciliation_latched) return lifecycle;
    if (lifecycle.state === LIFECYCLE_STATES.RECONCILIATION_REQUIRED && !lifecycle.reconciliation_latched) {
      return transitionCleanupPending();
    }
    return clearOwnedLatch();
  }

  const latestLatch = [...(lifecycle.reconciliation_history || [])].reverse()
    .find((entry) => entry.type === "latched");
  const resumableOwnedLatch = lifecycle.state === LIFECYCLE_STATES.RECONCILIATION_REQUIRED &&
    lifecycle.reconciliation_latched && latestLatch?.reason === latchReason;
  if (!(lifecycle.state === LIFECYCLE_STATES.CLEANUP_PENDING && !lifecycle.reconciliation_latched) && !resumableOwnedLatch) {
    throw new Error(`Close reconciliation requires unlatched CLEANUP_PENDING or its own recovery latch: ${lifecycleId}`);
  }

  const ownedAccounts = [...new Set([
    canonicalPosition,
    ...(Array.isArray(originalEvent.metadata?.owned_accounts) ? originalEvent.metadata.owned_accounts : []),
  ].filter(Boolean).map(String))];
  const details = validateInspectedLedgerReceipt(await inspectTransaction(canonicalSignature, {
    walletAddress: canonicalWallet,
    ownedAccounts,
  }), canonicalSignature);
  if (details.executionStatus !== "succeeded") {
    throw new Error(`Close reconciliation receipt ${canonicalSignature} did not succeed on chain`);
  }
  for (const [field, inspected] of [
    ["liquid_wallet_delta_lamports", details.walletDeltaLamports],
    ["tx_fee_lamports", details.txFeeLamports],
    ["rent_created_lamports", details.rentCreatedLamports],
    ["rent_reclaimed_lamports", details.rentReclaimedLamports],
  ]) {
    if (BigInt(originalEvent.amounts[field]) !== inspected) {
      throw new Error(`Close reconciliation receipt ${canonicalSignature} changed authoritative ${field}`);
    }
  }
  if (!Number.isSafeInteger(originalEvent.metadata?.slot) || originalEvent.metadata.slot !== details.slot) {
    throw new Error(`Close reconciliation receipt ${canonicalSignature} changed authoritative slot`);
  }
  const originalTokenDeltas = normalizedReceiptRows(originalEvent.token_deltas, ["account", "mint", "raw_amount"]);
  const inspectedTokenDeltas = normalizedReceiptRows(details.tokenDeltas, ["account", "mint", "raw_amount"]);
  if (JSON.stringify(originalTokenDeltas) !== JSON.stringify(inspectedTokenDeltas)) {
    throw new Error(`Close reconciliation receipt ${canonicalSignature} changed authoritative token deltas`);
  }
  const originalEvidence = normalizedReceiptRows(originalEvent.metadata?.token_account_evidence, [
    "account", "mint", "pre_raw_amount", "post_raw_amount", "raw_amount",
  ]);
  const inspectedEvidence = normalizedReceiptRows(details.tokenAccountEvidence, [
    "account", "mint", "pre_raw_amount", "post_raw_amount", "raw_amount",
  ]);
  if (JSON.stringify(originalEvidence) !== JSON.stringify(inspectedEvidence)) {
    throw new Error(`Close reconciliation receipt ${canonicalSignature} changed authoritative token-account evidence`);
  }

  const economicInflow = details.walletDeltaLamports + details.txFeeLamports
    + details.rentCreatedLamports - details.rentReclaimedLamports;
  const correctedWithdrawal = economicInflow > 0n ? economicInflow : 0n;
  if (!resumableOwnedLatch) {
    store.transitionLifecycle(lifecycleId, LIFECYCLE_STATES.RECONCILIATION_REQUIRED, { reason: latchReason });
  }
  store.reconcileTransaction({
    lifecycle_id: lifecycleId,
    signature: canonicalSignature,
    reconciliation_id: canonicalReconciliationId,
    original_event_id: originalEvent.event_id,
    amounts: {
      ...originalEvent.amounts,
      withdrawal_lamports: correctedWithdrawal,
    },
    token_deltas: details.tokenDeltas,
    metadata: {
      ...originalEvent.metadata,
      original_event_id: originalEvent.event_id,
      token_account_evidence: details.tokenAccountEvidence,
      reconciliation_source: "confirmed_close_receipt_economics",
      withdrawal_formula: "wallet_delta + tx_fee + rent_created - rent_reclaimed",
    },
  });
  if (!correctionAlreadyApplied()) {
    throw new Error(`Close receipt correction was not durably reduced for ${lifecycleId}`);
  }
  return clearOwnedLatch();
}

export function markCleanupPending(position) {
  if (!config.ledger?.enabled || !position) return null;
  const store = getTradeLedger();
  const lifecycleId = lifecycleIdForPosition(position);
  const lifecycle = store.getLifecycle(lifecycleId);
  if (!lifecycle) return null;
  if (lifecycle.reconciliation_latched) {
    updatePositionAccounting(position, { ledger_status: "RECONCILIATION_REQUIRED" });
    return lifecycle;
  }
  if (lifecycle.state === LIFECYCLE_STATES.CLOSING) {
    store.transitionLifecycle(lifecycleId, LIFECYCLE_STATES.CLEANUP_PENDING, { reason: "position closed; token cleanup pending" });
  }
  updatePositionAccounting(position, { ledger_status: "CLEANUP_PENDING" });
  return store.getLifecycle(lifecycleId);
}

const CLEANUP_EXECUTION_CHECKPOINT_SOURCE = "cleanup-execution-checkpoint";

function withCleanupExecutionCheckpointLock(store, run) {
  if (!store?.filePath || !store?.fsImpl) {
    throw new TypeError("Cleanup checkpoint deduplication requires a durable TradeLedger store");
  }
  let lock = null;
  try {
    lock = acquireSecureFileLock(store.filePath, {
      fsImpl: store.fsImpl,
      label: "Cleanup execution checkpoint",
      lockName: `.${path.basename(store.filePath)}.cleanup-checkpoint.lock`,
      durable: store.durable !== false,
    });
    return run();
  } finally {
    if (lock) {
      releaseSecureFileLock(lock, {
        fsImpl: store.fsImpl,
        label: "Cleanup execution checkpoint",
        durable: store.durable !== false,
      });
    }
  }
}

function normalizeCleanupCheckpointTransactions(transactions = []) {
  const bySignature = new Map();
  for (const item of transactions) {
    const signature = String(item?.signature || "").trim();
    if (!signature) continue;
    bySignature.set(signature, {
      signature,
      phase: item.phase || "cleanup",
      ownedAccounts: [...new Set((item.ownedAccounts || []).filter(Boolean).map(String))],
    });
  }
  return [...bySignature.values()];
}

/**
 * Persist submitted cleanup signatures before their RPC inspection. If the
 * process dies after a confirmed cleanup transaction, the next explicit
 * reconciliation can replay these exact signatures instead of submitting a
 * second cleanup transaction.
 */
export function checkpointCleanupExecution(position, {
  cleanupExecutionId,
  transactions = [],
  store = getTradeLedger(),
  ledgerEnabled = config.ledger?.enabled,
} = {}) {
  if (!ledgerEnabled || !position) return null;
  const lifecycleId = lifecycleIdForPosition(position);
  const normalized = normalizeCleanupCheckpointTransactions(transactions);
  if (normalized.length === 0) return store.getLifecycle(lifecycleId);
  const executionId = String(cleanupExecutionId || "").trim();
  if (!executionId) throw new TypeError("cleanupExecutionId is required for cleanup checkpointing");
  return withCleanupExecutionCheckpointLock(store, () => {
    const lifecycle = store.getLifecycle(lifecycleId);
    if (!lifecycle || lifecycle.state === LIFECYCLE_STATES.SETTLED) return lifecycle;
    const existingTransactions = store.readEvents({ lifecycle_id: lifecycleId })
      .filter((event) => event.event_type === "valuation_recorded" && event.source === CLEANUP_EXECUTION_CHECKPOINT_SOURCE)
      .flatMap((event) => event.metadata?.cleanup_transactions || []);
    const existingSignatures = new Set(existingTransactions.map((item) => item?.signature).filter(Boolean));
    const newTransactions = normalized.filter((item) => !existingSignatures.has(item.signature));
    if (newTransactions.length === 0) return lifecycle;
    store.recordValuation({
      lifecycle_id: lifecycleId,
      source: CLEANUP_EXECUTION_CHECKPOINT_SOURCE,
      residual_token_value_lamports: lifecycle.residual_token_value_lamports,
      reclaimable_rent_lamports: lifecycle.reclaimable_rent_lamports,
      metadata: {
        cleanup_execution_id: executionId,
        cleanup_transactions: newTransactions,
      },
    });
    return store.getLifecycle(lifecycleId);
  });
}

export function getCheckpointedCleanupTransactions(position, { store = getTradeLedger() } = {}) {
  const lifecycleId = lifecycleIdForPosition(position);
  const lifecycle = store.getLifecycle(lifecycleId);
  if (!lifecycle) return [];
  const transactions = store.readEvents({ lifecycle_id: lifecycleId })
    .filter((event) => event.event_type === "valuation_recorded" && event.source === CLEANUP_EXECUTION_CHECKPOINT_SOURCE)
    .flatMap((event) => event.metadata?.cleanup_transactions || []);
  return normalizeCleanupCheckpointTransactions(transactions)
    .filter((item) => !lifecycle.signatures.includes(item.signature));
}

function canonicalLamports(value, field) {
  const text = String(value ?? "");
  if (!/^\d+$/.test(text)) throw new TypeError(`${field} must be a non-negative integer lamport string`);
  return BigInt(text).toString();
}

/**
 * Settlement is deliberately stricter than a ledger arithmetic check. A
 * matching equation is not enough when the remaining token accounts have not
 * been scanned across both token programs or their economic value is unknown.
 */
export function validateTerminalEconomics(terminalEconomics, {
  residualTokenValueLamports,
  reclaimableRentLamports,
} = {}) {
  if (!terminalEconomics || typeof terminalEconomics !== "object") {
    return { valid: false, reason: "TERMINAL_ECONOMICS_EVIDENCE_REQUIRED" };
  }
  if (terminalEconomics.source !== "economic_cleanup_reconciliation") {
    return { valid: false, reason: "UNRECOGNIZED_TERMINAL_ECONOMICS_SOURCE" };
  }
  if (!Number.isFinite(Date.parse(terminalEconomics.snapshot_at))) {
    return { valid: false, reason: "TERMINAL_ECONOMICS_SNAPSHOT_TIMESTAMP_REQUIRED" };
  }
  const scannedPrograms = new Set((terminalEconomics.scanned_programs || []).map(String));
  if (!scannedPrograms.has("token") || !scannedPrograms.has("token2022")) {
    return { valid: false, reason: "BOTH_TOKEN_PROGRAMS_MUST_BE_SCANNED" };
  }
  if (terminalEconomics.economic_complete !== true) {
    return { valid: false, reason: "TERMINAL_ECONOMICS_INCOMPLETE" };
  }
  if (!new Set(["completed", "not_required"]).has(terminalEconomics.execution_state)) {
    return { valid: false, reason: "CLEANUP_EXECUTION_STATE_NOT_TERMINAL" };
  }
  try {
    if (canonicalLamports(terminalEconomics.residual_token_value_lamports, "terminal residual") !==
      canonicalLamports(residualTokenValueLamports, "residualTokenValueLamports")) {
      return { valid: false, reason: "TERMINAL_RESIDUAL_VALUE_MISMATCH" };
    }
    if (canonicalLamports(terminalEconomics.reclaimable_rent_lamports, "terminal reclaimable rent") !==
      canonicalLamports(reclaimableRentLamports, "reclaimableRentLamports")) {
      return { valid: false, reason: "TERMINAL_RECLAIMABLE_RENT_MISMATCH" };
    }
  } catch (error) {
    return { valid: false, reason: error.message };
  }
  return { valid: true };
}

export function getCloseLifecycleReason(position, { store = getTradeLedger() } = {}) {
  const lifecycleId = lifecycleIdForPosition(position);
  const events = store.readEvents({ lifecycle_id: lifecycleId });
  const closing = [...events].reverse().find((event) =>
    event.event_type === "state_transition" && event.to_state === LIFECYCLE_STATES.CLOSING);
  return closing?.reason || null;
}

/**
 * Finalize a lifecycle only after the cleanup runtime supplied a fresh,
 * two-program economic snapshot. The supplied reconciliation id makes a
 * retry after a network/process interruption append no duplicate valuation or
 * settlement event.
 */
export function finalizeLifecycleWithStore({
  store = getTradeLedger(),
  position,
  residualTokenValueLamports = 0,
  reclaimableRentLamports = 0,
  terminalEconomics,
  reconciliationId = null,
  metadata = {},
  toleranceLamports = config.ledger.reconcileToleranceLamports,
  updateAccounting = updatePositionAccounting,
  ledgerEnabled = config.ledger?.enabled,
} = {}) {
  if (!ledgerEnabled || !position) return null;
  const lifecycleId = lifecycleIdForPosition(position);
  const lifecycle = store.getLifecycle(lifecycleId);
  if (!lifecycle) return null;
  if (lifecycle.state === LIFECYCLE_STATES.SETTLED) {
    return {
      lifecycle,
      settlement: lifecycle.settlement || null,
      finalized: false,
      already_settled: true,
    };
  }
  if (lifecycle.reconciliation_latched) {
    return {
      lifecycle,
      settlement: lifecycle.settlement || null,
      finalized: false,
      blocked: "RECONCILIATION_LATCHED",
    };
  }
  if (!lifecycle.cost_basis.ready) {
    return {
      lifecycle,
      settlement: null,
      finalized: false,
      blocked: "COST_BASIS_NOT_READY",
    };
  }
  const evidence = validateTerminalEconomics(terminalEconomics, {
    residualTokenValueLamports,
    reclaimableRentLamports,
  });
  if (!evidence.valid) {
    return {
      lifecycle,
      settlement: null,
      finalized: false,
      blocked: evidence.reason,
    };
  }
  const idempotencyKey = reconciliationId || terminalEconomics.reconciliation_id || null;
  if (idempotencyKey && lifecycle.settlement?.metadata?.reconciliation_id === idempotencyKey) {
    return {
      lifecycle,
      settlement: lifecycle.settlement,
      finalized: false,
      already_reconciled: true,
    };
  }

  const reconciliationMetadata = {
    ...metadata,
    reconciliation_id: idempotencyKey,
    terminal_economics: terminalEconomics,
  };
  store.recordValuation({
    lifecycle_id: lifecycleId,
    source: "economic-cleanup-reconciliation",
    residual_token_value_lamports: residualTokenValueLamports,
    reclaimable_rent_lamports: reclaimableRentLamports,
    metadata: reconciliationMetadata,
  });
  const settlement = store.finalizeSettlement({
    lifecycle_id: lifecycleId,
    residual_token_value_lamports: residualTokenValueLamports,
    reclaimable_rent_lamports: reclaimableRentLamports,
    tolerance_lamports: toleranceLamports,
    metadata: reconciliationMetadata,
  });
  const updated = store.getLifecycle(lifecycleId);
  updateAccounting(position, {
    ledger_status: settlement.outcome_state,
    reconciliation_error_lamports: Number(settlement.reconciliation_error_lamports),
    equity_net_lamports: Number(settlement.wallet_equity_net_lamports),
  });
  if (settlement.outcome_state !== LIFECYCLE_STATES.SETTLED) {
    log("ledger_warn", `Lifecycle ${lifecycleId} requires reconciliation: ${settlement.reconciliation_error_lamports} lamports`);
  }
  return {
    lifecycle: updated,
    settlement,
    finalized: true,
    ...(settlement.outcome_state !== LIFECYCLE_STATES.SETTLED
      ? { blocked: "RECONCILIATION_REQUIRED" }
      : {}),
  };
}

export function finalizeLifecycle(position, options = {}) {
  return finalizeLifecycleWithStore({ position, ...options });
}
