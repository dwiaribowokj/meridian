/**
 * Append-only, run-scoped evidence for the local shadow lifecycle.
 *
 * This intentionally contains no wallet addresses, signatures, transaction
 * data, or executor imports.  It records the paper lifecycle observations
 * emitted on the normal management cadence so rollout acceptance can be
 * recomputed from primary source records rather than an operator-produced
 * summary artifact.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { YIELD_HOLD_STRATEGY_PROFILE } from "./risk-policy.js";

export const SHADOW_EVIDENCE_SCHEMA_VERSION = 1;
export const SHADOW_EVIDENCE_KIND = "shadow_rollout_heartbeat";
export const SHADOW_ROLLOUT_STAGE = "shadow_baseline";
export const DEFAULT_SHADOW_EVIDENCE_THRESHOLDS = Object.freeze({
  minDryRunHours: 24,
  minCompletedShadowLifecycles: 5,
  minNetSol: 0.000001,
  minProfitFactor: 1.2,
  maxSingleLossPct: 2.5,
  maxDrawdownSol: 0.003,
  maxHeartbeatGapMinutes: 15,
  maxConcurrentPositions: 1,
  maxDeployedAmountSol: 0.2,
  requiredDeployAmountSol: 0.2,
});

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function nonNegative(value) {
  const number = finite(value);
  return number != null && number >= 0 ? number : null;
}

function timestamp(value) {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function iso(value) {
  const ms = value instanceof Date ? value.getTime() : typeof value === "number" ? value : timestamp(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function digest(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function sha256File(filePath) {
  if (!filePath) return null;
  try {
    return sha256Bytes(readSecureShadowEvidence(filePath).bytes);
  } catch {
    return null;
  }
}

function sha256Bytes(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function parseJsonLines(bytes) {
  const text = Buffer.from(bytes).toString("utf8");
  const records = text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      try { return JSON.parse(line); } catch { return { __invalid_json: true }; }
    });
  // JSONL is only append-safe when every non-empty record is newline
  // terminated. A valid JSON object without its final newline may be a torn
  // append, so it must fail closed rather than becoming evidence.
  if (text.length > 0 && !text.endsWith("\n")) {
    records.push({ __invalid_json: true, __partial_jsonl: true });
  }
  return records;
}

function descriptorPath(descriptor, name = null) {
  const base = `/proc/self/fd/${descriptor}`;
  return name == null ? base : path.join(base, name);
}

function closeDescriptor(descriptor) {
  if (descriptor != null) fs.closeSync(descriptor);
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function evidenceError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requireSecureDescriptorSupport() {
  const { O_APPEND, O_CREAT, O_DIRECTORY, O_EXCL, O_NOFOLLOW } = fs.constants;
  if (process.platform !== "linux" || ![O_APPEND, O_CREAT, O_DIRECTORY, O_EXCL, O_NOFOLLOW].every(Number.isInteger)) {
    throw evidenceError("Secure shadow evidence handling requires Linux O_DIRECTORY, O_NOFOLLOW, and O_APPEND support", "ENOTSUP");
  }
  try {
    fs.accessSync("/proc/self/fd", fs.constants.R_OK | fs.constants.X_OK);
  } catch (error) {
    throw evidenceError(`Secure shadow evidence handling requires accessible /proc/self/fd: ${error.message}`, "ENOTSUP");
  }
}

function pathComponents(resolved) {
  const parsed = path.parse(resolved);
  const relative = path.relative(parsed.root, resolved);
  return relative && relative !== "." ? relative.split(path.sep).filter(Boolean) : [];
}

function assertNoSymlinkedAncestors(file, label) {
  const parsed = path.parse(file);
  let probe = parsed.root;
  for (const component of pathComponents(file).slice(0, -1)) {
    probe = path.join(probe, component);
    let stat;
    try {
      stat = fs.lstatSync(probe);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw evidenceError(`${label} rejects symlinked ancestors: ${probe}`, "ELOOP");
    }
    if (!stat.isDirectory()) {
      throw evidenceError(`${label} ancestor is not a directory: ${probe}`, "ENOTDIR");
    }
  }
}

function snapshotRegularEvidenceFile(file, label, { allowMissing = false } = {}) {
  assertNoSymlinkedAncestors(file, label);
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if (allowMissing && error?.code === "ENOENT") return null;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw evidenceError(`${label} must be a regular file without symlinks`, "ELOOP");
  }
  return { dev: stat.dev, ino: stat.ino, nlink: stat.nlink };
}

/**
 * Walk a directory path with O_NOFOLLOW at every component. Node does not
 * expose openat(), so /proc/self/fd/<n>/child provides the Linux descriptor
 * anchor without returning to an attacker-controlled pathname.
 */
function openSecureDirectory(resolved, label, { createMissing = false } = {}) {
  requireSecureDescriptorSupport();
  const directory = path.resolve(resolved);
  const parsed = path.parse(directory);
  const flags = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
  let descriptor = null;
  try {
    descriptor = fs.openSync(parsed.root, flags);
    for (const component of pathComponents(directory)) {
      const childPath = descriptorPath(descriptor, component);
      let child = null;
      try {
        child = fs.openSync(childPath, flags);
      } catch (error) {
        if (!createMissing || error?.code !== "ENOENT") throw error;
        try {
          fs.mkdirSync(childPath, { mode: 0o700 });
        } catch (mkdirError) {
          if (mkdirError?.code !== "EEXIST") throw mkdirError;
        }
        child = fs.openSync(childPath, flags);
      }
      closeDescriptor(descriptor);
      descriptor = child;
      if (!fs.fstatSync(descriptor).isDirectory()) {
        throw evidenceError(`${label} ancestor is not a directory`, "ENOTDIR");
      }
    }
    return descriptor;
  } catch (error) {
    closeDescriptor(descriptor);
    const wrapped = evidenceError(`Could not establish secure shadow evidence directory: ${error.message}`, error?.code);
    throw wrapped;
  }
}

function verifyOpenedRegularEvidenceFile(file, descriptor, expectedIdentity, label, { requireSingleLink = true } = {}) {
  const opened = fs.fstatSync(descriptor);
  if (!opened.isFile()) {
    throw evidenceError(`${label} descriptor is not a regular file`, "ELOOP");
  }
  if (requireSingleLink && opened.nlink !== 1) {
    throw evidenceError(`${label} descriptor is unlinked or has unexpected hard links`, "EAGAIN");
  }
  let currentIdentity;
  try {
    currentIdentity = snapshotRegularEvidenceFile(file, label);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw evidenceError(`${label} path was unlinked or renamed during append`, "EAGAIN");
    }
    throw error;
  }
  if (!sameFileIdentity(opened, currentIdentity) ||
    (expectedIdentity && !sameFileIdentity(opened, expectedIdentity))) {
    throw evidenceError(`${label} path changed (replaced or renamed) during append`, "EAGAIN");
  }
  if (requireSingleLink && currentIdentity.nlink !== 1) {
    throw evidenceError(`${label} path has unexpected hard links`, "EAGAIN");
  }
  return opened;
}

function readSecureShadowEvidence(filePath) {
  const file = path.resolve(filePath);
  const label = "Shadow evidence";
  const expectedIdentity = snapshotRegularEvidenceFile(file, label);
  let parentDescriptor = null;
  let descriptor = null;
  try {
    parentDescriptor = openSecureDirectory(path.dirname(file), label);
    const flags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | (fs.constants.O_NONBLOCK ?? 0);
    descriptor = fs.openSync(descriptorPath(parentDescriptor, path.basename(file)), flags);
    const stat = verifyOpenedRegularEvidenceFile(file, descriptor, expectedIdentity, label);
    // Validation, parsing, and hashing use this descriptor's bytes only. A
    // later replacement of the pathname cannot change the evaluated source.
    const bytes = fs.readFileSync(descriptor);
    return { bytes, stat };
  } finally {
    closeDescriptor(descriptor);
    closeDescriptor(parentDescriptor);
  }
}

function openSecureShadowEvidenceForAppend(filePath) {
  const file = path.resolve(filePath);
  const label = "Shadow evidence";
  const expectedIdentity = snapshotRegularEvidenceFile(file, label, { allowMissing: true });
  let parentDescriptor = null;
  let descriptor = null;
  try {
    parentDescriptor = openSecureDirectory(path.dirname(file), label, { createMissing: true });
    const flags = fs.constants.O_RDWR | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW | (fs.constants.O_NONBLOCK ?? 0);
    if (expectedIdentity) {
      descriptor = fs.openSync(descriptorPath(parentDescriptor, path.basename(file)), flags);
    } else {
      try {
        descriptor = fs.openSync(
          descriptorPath(parentDescriptor, path.basename(file)),
          flags | fs.constants.O_CREAT | fs.constants.O_EXCL,
          0o600,
        );
      } catch (error) {
        if (error?.code === "EEXIST") {
          throw evidenceError("Shadow evidence appeared during secure creation", "EAGAIN");
        }
        throw error;
      }
    }
    verifyOpenedRegularEvidenceFile(file, descriptor, expectedIdentity, label);
    return { file, descriptor, parentDescriptor, expectedIdentity };
  } catch (error) {
    closeDescriptor(descriptor);
    closeDescriptor(parentDescriptor);
    throw error;
  }
}

function appendDescriptorBytes(descriptor, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const written = fs.writeSync(descriptor, bytes, offset, bytes.length - offset, null);
    if (!written) throw evidenceError("Could not append shadow evidence", "EIO");
    offset += written;
  }
}

const APPEND_LOCK_TIMEOUT_MS = 10_000;
const APPEND_LOCK_RETRY_MS = 5;

function pauseSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function acquireAppendLock(file) {
  const label = "Shadow evidence append lock";
  const lockName = `.${path.basename(file)}.append.lock`;
  const deadline = Date.now() + APPEND_LOCK_TIMEOUT_MS;
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW;
  while (true) {
    let parentDescriptor = null;
    let descriptor = null;
    try {
      parentDescriptor = openSecureDirectory(path.dirname(file), label, { createMissing: true });
      descriptor = fs.openSync(descriptorPath(parentDescriptor, lockName), flags, 0o600);
      return { parentDescriptor, descriptor, lockName };
    } catch (error) {
      closeDescriptor(descriptor);
      closeDescriptor(parentDescriptor);
      if (error?.code !== "EEXIST") throw error;
      if (Date.now() >= deadline) {
        throw evidenceError("Timed out waiting for another shadow evidence append", "EWOULDBLOCK");
      }
      pauseSync(APPEND_LOCK_RETRY_MS);
    }
  }
}

function verifyAppendLock(lock) {
  const opened = fs.fstatSync(lock.descriptor);
  if (!opened.isFile() || opened.nlink !== 1) {
    throw evidenceError("Shadow evidence append lock was lost", "EAGAIN");
  }
  const current = fs.lstatSync(descriptorPath(lock.parentDescriptor, lock.lockName));
  if (current.isSymbolicLink() || !current.isFile() || !sameFileIdentity(opened, current) || current.nlink !== 1) {
    throw evidenceError("Shadow evidence append lock was replaced", "EAGAIN");
  }
}

function releaseAppendLock(lock) {
  if (!lock) return;
  try {
    const opened = fs.fstatSync(lock.descriptor);
    const lockPath = descriptorPath(lock.parentDescriptor, lock.lockName);
    const current = fs.lstatSync(lockPath);
    if (sameFileIdentity(opened, current)) fs.unlinkSync(lockPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  } finally {
    closeDescriptor(lock.descriptor);
    closeDescriptor(lock.parentDescriptor);
  }
}

function restoreDescriptorSize(descriptor, originalSize) {
  try {
    fs.ftruncateSync(descriptor, originalSize);
    fs.fsyncSync(descriptor);
    return true;
  } catch {
    return false;
  }
}

function appendDurably(opened, bytes) {
  const original = verifyOpenedRegularEvidenceFile(opened.file, opened.descriptor, opened.expectedIdentity, "Shadow evidence");
  const originalSize = original.size;
  try {
    appendDescriptorBytes(opened.descriptor, bytes);
    fs.fsyncSync(opened.descriptor);
    // Verify the named path and link count after the durable write. This
    // rejects an append to an inode that an attacker unlinked, renamed, or
    // replaced while its descriptor remained open.
    verifyOpenedRegularEvidenceFile(opened.file, opened.descriptor, opened.expectedIdentity, "Shadow evidence");
    fs.fsyncSync(opened.parentDescriptor);
    // Cover a replacement that races the first post-write verification or the
    // directory fsync itself before reporting success.
    verifyOpenedRegularEvidenceFile(opened.file, opened.descriptor, opened.expectedIdentity, "Shadow evidence");
  } catch (error) {
    const currentSize = fs.fstatSync(opened.descriptor).size;
    if (currentSize > originalSize && !restoreDescriptorSize(opened.descriptor, originalSize)) {
      error.message = `${error.message}; shadow evidence append rollback failed (the unterminated record remains fail-closed)`;
    }
    throw error;
  }
}

function unavailableShadowEvidence(reason, filePath, runId, thresholds, source = null) {
  return {
    available: false,
    reason,
    run_id: runId,
    source: source || { file: filePath, sha256: null, record_count: 0 },
    thresholds,
    gates: {},
    ready: false,
  };
}

function shadowEvidenceFailureReason(error) {
  if (error?.code === "ENOENT") return "SHADOW_EVIDENCE_MISSING";
  if (["ELOOP", "ENOTDIR", "EISDIR", "EAGAIN"].includes(error?.code)) return "SHADOW_EVIDENCE_NOT_REGULAR_FILE";
  return "SHADOW_EVIDENCE_UNREADABLE";
}

function round(value, digits = 9) {
  const number = finite(value);
  if (number == null) return null;
  const scale = 10 ** digits;
  return Math.round(number * scale) / scale;
}

function optionalRound(value, digits = 9) {
  if (value == null || (typeof value === "string" && !value.trim())) return null;
  return round(value, digits);
}

function compactLifecycle(value) {
  const settlement = value?.settlement && typeof value.settlement === "object" ? {
    settled_at: iso(value.settlement.settled_at),
    action: typeof value.settlement.action === "string" ? value.settlement.action : null,
    initial_principal_sol: optionalRound(value.settlement.initial_principal_sol),
    final_equity_sol: optionalRound(value.settlement.final_equity_sol),
    net_pnl_sol: optionalRound(value.settlement.net_pnl_sol),
    estimated_fee_accrual_sol: optionalRound(value.settlement.estimated_fee_accrual_sol),
    estimated_round_trip_cost_sol: optionalRound(value.settlement.estimated_round_trip_cost_sol),
  } : null;
  const valuation = value?.valuation && typeof value.valuation === "object" ? {
    model: typeof value.valuation.model === "string" ? value.valuation.model : null,
    version: typeof value.valuation.version === "string" ? value.valuation.version : null,
    last_valued_at: iso(value.valuation.last_valued_at),
    price_return_pct: optionalRound(value.valuation.price_return_pct, 6),
    conservative_price_return_pct: optionalRound(value.valuation.conservative_price_return_pct, 6),
    range_exposure_pct: optionalRound(value.valuation.range_exposure_pct, 6),
    equity_net_sol: optionalRound(value.valuation.equity_net_sol),
    projected_net_pnl_sol: optionalRound(value.valuation.projected_net_pnl_sol),
    estimated_round_trip_cost_sol: optionalRound(value.valuation.estimated_round_trip_cost_sol),
    estimated_fee_accrual_sol: optionalRound(value.valuation.estimated_fee_accrual_sol),
    estimated_fee_increment_sol: optionalRound(value.valuation.estimated_fee_increment_sol),
    fee_accrual_interval_minutes: optionalRound(value.valuation.fee_accrual_interval_minutes, 6),
    fee_timeframe_minutes: optionalRound(value.valuation.fee_timeframe_minutes, 6),
    fee_participation_pct: optionalRound(value.valuation.fee_participation_pct, 6),
    fee_tvl_ratio_24h_equivalent_pct: optionalRound(value.valuation.fee_tvl_ratio_24h_equivalent_pct, 6),
    pnl_basis_valid: value.valuation.pnl_basis_valid === true,
  } : null;
  const entry = value?.entry && typeof value.entry === "object" ? {
    pool: typeof value.entry.pool === "string" ? value.entry.pool : null,
    pool_name: typeof value.entry.pool_name === "string" ? value.entry.pool_name : null,
    base_mint: typeof value.entry.base_mint === "string" ? value.entry.base_mint : null,
    strategy: typeof value.entry.strategy === "string" ? value.entry.strategy : null,
    bin_range: value.entry.bin_range && typeof value.entry.bin_range === "object" ? {
      min: optionalRound(value.entry.bin_range.min, 0),
      max: optionalRound(value.entry.bin_range.max, 0),
      bins_below: optionalRound(value.entry.bin_range.bins_below, 0),
      bins_above: optionalRound(value.entry.bin_range.bins_above, 0),
    } : null,
    fee_tvl_ratio: optionalRound(value.entry.fee_tvl_ratio, 6),
    fee_timeframe: typeof value.entry.fee_timeframe === "string" ? value.entry.fee_timeframe : null,
    volatility: optionalRound(value.entry.volatility, 6),
    policy_snapshot: value.entry.policy_snapshot && typeof value.entry.policy_snapshot === "object"
      ? value.entry.policy_snapshot
      : null,
  } : null;
  const lastObservation = value?.last_observation && typeof value.last_observation === "object" ? {
    active_bin: optionalRound(value.last_observation.active_bin, 0),
    active_price: optionalRound(value.last_observation.active_price, 12),
    active_price_raw: optionalRound(value.last_observation.active_price_raw, 12),
    in_range: value.last_observation.in_range === true ? true : value.last_observation.in_range === false ? false : null,
    status: typeof value.last_observation.status === "string" ? value.last_observation.status : null,
    price_change_pct: optionalRound(value.last_observation.price_change_pct, 6),
    price_change_source: typeof value.last_observation.price_change_source === "string" ? value.last_observation.price_change_source : null,
    price_scale_warning: typeof value.last_observation.price_scale_warning === "string" ? value.last_observation.price_scale_warning : null,
    price_normalization_source: typeof value.last_observation.price_normalization_source === "string" ? value.last_observation.price_normalization_source : null,
    bin_distance_to_range: optionalRound(value.last_observation.bin_distance_to_range, 0),
  } : null;
  return {
    lifecycle_id: typeof value?.lifecycle_id === "string" ? value.lifecycle_id : null,
    // Never fill this from the enclosing heartbeat: each lifecycle must carry
    // its own persisted run correlation.
    run_id: typeof value?.run_id === "string" && value.run_id ? value.run_id : null,
    deployed_at: iso(value?.deployed_at),
    lifecycle_status: typeof value?.lifecycle_status === "string" ? value.lifecycle_status : null,
    terminal_state: typeof value?.terminal_state === "string" ? value.terminal_state : null,
    amount_sol: optionalRound(value?.amount_sol),
    entry,
    last_observed_at: iso(value?.last_observed_at),
    last_observation_error_at: iso(value?.last_observation_error_at),
    last_observation: lastObservation,
    valuation,
    settlement,
    reconciliation: value?.reconciliation && typeof value.reconciliation === "object" ? {
      simulated: value.reconciliation.simulated === true,
      verified: value.reconciliation.verified === true,
      verified_at: iso(value.reconciliation.verified_at),
      expected_final_equity_sol: round(value.reconciliation.expected_final_equity_sol),
      observed_final_equity_sol: round(value.reconciliation.observed_final_equity_sol),
      error_sol: round(value.reconciliation.error_sol),
    } : null,
    cleanup: value?.cleanup && typeof value.cleanup === "object" ? {
      simulated: value.cleanup.simulated === true,
      verified: value.cleanup.verified === true,
      verified_at: iso(value.cleanup.verified_at),
      no_wallet_or_transactions: value.cleanup.no_wallet_or_transactions === true,
    } : null,
  };
}

function financials(lifecycles) {
  let netSol = 0;
  let openExposureSol = 0;
  let markedOpenEquitySol = 0;
  let settledEquitySol = 0;
  let complete = lifecycles.length > 0;
  for (const lifecycle of lifecycles) {
    const principal = nonNegative(lifecycle.amount_sol);
    if (principal == null) {
      complete = false;
      continue;
    }
    if (lifecycle.lifecycle_status === "SETTLED" && lifecycle.terminal_state === "CLOSED_SETTLED") {
      const finalEquity = nonNegative(lifecycle.settlement?.final_equity_sol);
      const settlementNet = finite(lifecycle.settlement?.net_pnl_sol);
      const settlementPrincipal = nonNegative(lifecycle.settlement?.initial_principal_sol);
      if (finalEquity == null || settlementNet == null || settlementPrincipal == null ||
        Math.abs(settlementPrincipal - principal) > 1e-8 || Math.abs((finalEquity - principal) - settlementNet) > 1e-8) {
        complete = false;
        continue;
      }
      netSol += settlementNet;
      settledEquitySol += finalEquity;
      continue;
    }
    const equity = nonNegative(lifecycle.valuation?.equity_net_sol);
    const projectedNet = finite(lifecycle.valuation?.projected_net_pnl_sol);
    if (equity == null || projectedNet == null || lifecycle.valuation?.pnl_basis_valid !== true || Math.abs((equity - principal) - projectedNet) > 1e-8) {
      complete = false;
      continue;
    }
    netSol += projectedNet;
    openExposureSol += principal;
    markedOpenEquitySol += equity;
  }
  return {
    complete,
    mark_to_market_net_sol: round(netSol),
    open_exposure_sol: round(openExposureSol),
    marked_open_equity_sol: round(markedOpenEquitySol),
    settled_equity_sol: round(settledEquitySol),
  };
}

function previousForRun(records, runId) {
  const matching = records.filter((record) => record?.kind === SHADOW_EVIDENCE_KIND && record?.run_id === runId);
  return matching.length ? matching.at(-1) : null;
}

/**
 * Append exactly one observation heartbeat after a shadow management cycle.
 * The caller supplies local paper state and a breaker observation; this module
 * never reads a wallet, makes an RPC call, or invokes a transaction path.
 */
export function appendShadowEvidenceHeartbeat({
  filePath,
  runId,
  rolloutStage = SHADOW_ROLLOUT_STAGE,
  strategyProfile = YIELD_HOLD_STRATEGY_PROFILE,
  now = new Date(),
  lifecycles = [],
  cycle = {},
  breaker = null,
} = {}) {
  if (!filePath) throw new Error("Shadow evidence requires an explicit file path");
  if (typeof runId !== "string" || !runId.trim()) throw new Error("Shadow evidence requires a stable run_id");
  const observedAt = iso(now);
  if (!observedAt) throw new Error("Shadow evidence requires a valid observation time");
  const file = path.resolve(filePath);
  const appendLock = acquireAppendLock(file);
  let opened = null;
  try {
    opened = openSecureShadowEvidenceForAppend(file);
    // The prior chain state and the appended heartbeat share one O_APPEND
    // descriptor, so a pathname replacement cannot splice two different
    // evidence files into one continuity decision.
    const records = parseJsonLines(fs.readFileSync(opened.descriptor));
    if (records.some((record) => record?.__invalid_json)) {
      throw evidenceError("Shadow evidence contains malformed or partial JSONL; refusing to append", "EBADMSG");
    }
    const previous = previousForRun(records, runId);
    const previousAt = iso(previous?.observed_at);
    const previousMs = timestamp(previousAt);
    const observedMs = timestamp(observedAt);
    const compact = Array.isArray(lifecycles) ? lifecycles.map((lifecycle) => compactLifecycle(lifecycle)) : [];
    const failures = Array.isArray(cycle.observation_failures)
      ? cycle.observation_failures.map((failure) => ({
          lifecycle_id: typeof failure?.lifecycle_id === "string" ? failure.lifecycle_id : null,
          message: typeof failure?.message === "string" ? failure.message.slice(0, 240) : "unknown observation failure",
        }))
      : [];
    const concurrent = Math.max(0, Math.floor(finite(cycle.started_open_positions) ?? compact.filter((lifecycle) => lifecycle.lifecycle_status !== "SETTLED").length));
    const deployed = nonNegative(cycle.started_deployed_amount_sol) ?? compact
      .filter((lifecycle) => lifecycle.lifecycle_status !== "SETTLED")
      .reduce((sum, lifecycle) => sum + (nonNegative(lifecycle.amount_sol) ?? 0), 0);
    const breakerObservedAt = iso(breaker?.observed_at ?? observedAt);
    const payload = {
      schema_version: SHADOW_EVIDENCE_SCHEMA_VERSION,
      kind: SHADOW_EVIDENCE_KIND,
      emitter: "shadow_lifecycle_management",
      run_id: runId,
      rollout_stage: typeof rolloutStage === "string" ? rolloutStage : null,
      strategy_profile: typeof strategyProfile === "string" ? strategyProfile : null,
      sequence: (Number.isInteger(previous?.sequence) ? previous.sequence : 0) + 1,
      observed_at: observedAt,
      continuity: {
        previous_heartbeat_at: previousAt,
        gap_ms: previousMs == null ? null : Math.max(0, observedMs - previousMs),
        previous_record_hash: previous?.record_hash ?? null,
      },
      exposure: {
        concurrent_positions: concurrent,
        deployed_amount_sol: round(deployed),
      },
      observation_failures: failures,
      lifecycles: compact,
      financials: financials(compact),
      breaker: breaker && typeof breaker === "object" ? {
        run_id: runId,
        observed_at: breakerObservedAt,
        tripped: breaker.tripped === true,
        manual_resume_required: breaker.manualResumeRequired === true,
        last_event_at_ms: finite(breaker.lastEventAtMs),
        tripped_at_ms: finite(breaker.trippedAtMs),
        resumed_at_ms: finite(breaker.resumedAtMs),
      } : null,
    };
    const record = { ...payload, record_hash: digest(payload) };
    appendDurably(opened, Buffer.from(`${JSON.stringify(record)}\n`, "utf8"));
    verifyAppendLock(appendLock);
    return record;
  } finally {
    if (opened) {
      closeDescriptor(opened.descriptor);
      closeDescriptor(opened.parentDescriptor);
    }
    releaseAppendLock(appendLock);
  }
}

function normalizedThresholds(overrides = {}) {
  const numberOr = (key) => finite(overrides[key]) ?? DEFAULT_SHADOW_EVIDENCE_THRESHOLDS[key];
  return {
    // Canary evidence requirements are locked minimums. Operators may tighten
    // them, but an override must never weaken a safety gate below baseline.
    minDryRunHours: Math.max(DEFAULT_SHADOW_EVIDENCE_THRESHOLDS.minDryRunHours, numberOr("minDryRunHours")),
    minCompletedShadowLifecycles: Math.max(
      DEFAULT_SHADOW_EVIDENCE_THRESHOLDS.minCompletedShadowLifecycles,
      Math.floor(numberOr("minCompletedShadowLifecycles")),
    ),
    minNetSol: Math.max(DEFAULT_SHADOW_EVIDENCE_THRESHOLDS.minNetSol, numberOr("minNetSol")),
    minProfitFactor: Math.max(
      DEFAULT_SHADOW_EVIDENCE_THRESHOLDS.minProfitFactor,
      numberOr("minProfitFactor"),
    ),
    maxSingleLossPct: Math.min(
      DEFAULT_SHADOW_EVIDENCE_THRESHOLDS.maxSingleLossPct,
      Math.max(0, numberOr("maxSingleLossPct")),
    ),
    maxDrawdownSol: Math.min(
      DEFAULT_SHADOW_EVIDENCE_THRESHOLDS.maxDrawdownSol,
      Math.max(0, numberOr("maxDrawdownSol")),
    ),
    maxHeartbeatGapMinutes: Math.min(
      DEFAULT_SHADOW_EVIDENCE_THRESHOLDS.maxHeartbeatGapMinutes,
      Math.max(1, numberOr("maxHeartbeatGapMinutes")),
    ),
    maxConcurrentPositions: Math.min(
      DEFAULT_SHADOW_EVIDENCE_THRESHOLDS.maxConcurrentPositions,
      Math.max(1, Math.floor(numberOr("maxConcurrentPositions"))),
    ),
    maxDeployedAmountSol: Math.min(
      DEFAULT_SHADOW_EVIDENCE_THRESHOLDS.maxDeployedAmountSol,
      Math.max(0, numberOr("maxDeployedAmountSol")),
    ),
    requiredDeployAmountSol: Math.max(
      DEFAULT_SHADOW_EVIDENCE_THRESHOLDS.requiredDeployAmountSol,
      Math.max(0, numberOr("requiredDeployAmountSol")),
    ),
  };
}

function result(pass, actual, required, reason) {
  return { pass: Boolean(pass), actual, required, reason };
}

function validateRecord(record, expectedPrevious) {
  if (!record || record.__invalid_json || record.schema_version !== SHADOW_EVIDENCE_SCHEMA_VERSION || record.kind !== SHADOW_EVIDENCE_KIND) return false;
  if (typeof record.run_id !== "string" || !record.run_id || timestamp(record.observed_at) == null) return false;
  const { record_hash: recordHash, ...payload } = record;
  if (typeof recordHash !== "string" || digest(payload) !== recordHash) return false;
  if (expectedPrevious) {
    if (record.sequence !== expectedPrevious.sequence + 1) return false;
    if (record.continuity?.previous_record_hash !== expectedPrevious.record_hash) return false;
    if (record.continuity?.previous_heartbeat_at !== expectedPrevious.observed_at) return false;
    const expectedGap = timestamp(record.observed_at) - timestamp(expectedPrevious.observed_at);
    if (!Number.isFinite(expectedGap) || record.continuity?.gap_ms !== expectedGap || expectedGap < 0) return false;
  } else if (record.sequence !== 1 || record.continuity?.previous_record_hash != null || record.continuity?.previous_heartbeat_at != null) {
    return false;
  }
  return true;
}

function chooseRun(records, expectedRunId) {
  const byRun = new Map();
  for (const record of records) {
    if (typeof record?.run_id !== "string") continue;
    const list = byRun.get(record.run_id) || [];
    list.push(record);
    byRun.set(record.run_id, list);
  }
  if (expectedRunId) return { runId: expectedRunId, records: byRun.get(expectedRunId) || [] };
  const candidates = [...byRun.entries()]
    .map(([runId, entries]) => ({ runId, records: entries }))
    .filter((candidate) => candidate.records.length)
    .sort((a, b) => timestamp(b.records.at(-1)?.observed_at) - timestamp(a.records.at(-1)?.observed_at));
  return candidates[0] || { runId: null, records: [] };
}

/**
 * Evaluate raw heartbeat source records only.  The returned object is a
 * diagnostic summary; callers must not treat a persisted copy of it as an
 * authorization token.
 */
export function evaluateShadowEvidence({
  filePath = null,
  runId = null,
  rolloutStage = SHADOW_ROLLOUT_STAGE,
  strategyProfile = YIELD_HOLD_STRATEGY_PROFILE,
  thresholds: overrides = {},
  now = new Date(),
} = {}) {
  const nowMs = timestamp(now);
  if (nowMs == null) throw new Error("Shadow evidence evaluation requires a valid current time");
  const thresholds = normalizedThresholds(overrides);
  if (!filePath) {
    return unavailableShadowEvidence("SHADOW_EVIDENCE_REQUIRED", filePath, runId, thresholds);
  }
  let source;
  try {
    source = readSecureShadowEvidence(filePath);
  } catch (error) {
    return unavailableShadowEvidence(shadowEvidenceFailureReason(error), filePath, runId, thresholds);
  }
  const allRecords = parseJsonLines(source.bytes);
  if (allRecords.some((record) => record?.__invalid_json)) {
    return unavailableShadowEvidence(
      "SHADOW_EVIDENCE_MALFORMED_OR_PARTIAL",
      filePath,
      runId,
      thresholds,
      { file: filePath, sha256: sha256Bytes(source.bytes), record_count: 0 },
    );
  }
  const selected = chooseRun(allRecords, runId);
  const records = selected.records;
  const sourceParseComplete = allRecords.length > 0;
  const structurallyValid = sourceParseComplete && records.length > 0 && records.every((record, index) => validateRecord(record, records[index - 1] || null));
  const firstMs = timestamp(records[0]?.observed_at);
  const lastMs = timestamp(records.at(-1)?.observed_at);
  const coverageHours = firstMs != null && lastMs != null ? Math.max(0, (lastMs - firstMs) / 3_600_000) : 0;
  const maxGapMs = records.slice(1).reduce((largest, record) => Math.max(largest, finite(record?.continuity?.gap_ms) ?? Infinity), 0);
  const allStagesCorrect = records.length > 0 && records.every((record) => record.rollout_stage === rolloutStage);
  const allStrategyProfilesCorrect = records.length > 0 && records.every((record) => record.strategy_profile === strategyProfile);
  const lifecycleLatest = new Map();
  let lifecycleCorrelated = true;
  let observationFailureCount = 0;
  let maxConcurrent = 0;
  let maxDeployed = 0;
  let financialsComplete = true;
  const netSeries = [];
  for (const record of records) {
    observationFailureCount += Array.isArray(record.observation_failures) ? record.observation_failures.length : 1;
    const concurrent = nonNegative(record.exposure?.concurrent_positions);
    const deployed = nonNegative(record.exposure?.deployed_amount_sol);
    if (concurrent == null || deployed == null) {
      financialsComplete = false;
    } else {
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      maxDeployed = Math.max(maxDeployed, deployed);
    }
    const lifecycles = Array.isArray(record.lifecycles) ? record.lifecycles : [];
    const openLifecycles = lifecycles.filter((lifecycle) => !(lifecycle?.lifecycle_status === "SETTLED" && lifecycle?.terminal_state === "CLOSED_SETTLED"));
    const openAmount = openLifecycles.reduce((total, lifecycle) => total + (nonNegative(lifecycle?.amount_sol) ?? 0), 0);
    if (concurrent != null && concurrent < openLifecycles.length) financialsComplete = false;
    if (deployed != null && deployed + 1e-9 < openAmount) financialsComplete = false;
    const reconstructed = financials(lifecycles);
    if (!reconstructed.complete || !record.financials ||
      Math.abs((finite(record.financials.mark_to_market_net_sol) ?? NaN) - reconstructed.mark_to_market_net_sol) > 1e-8 ||
      Math.abs((finite(record.financials.open_exposure_sol) ?? NaN) - reconstructed.open_exposure_sol) > 1e-8) {
      financialsComplete = false;
    }
    netSeries.push(reconstructed.mark_to_market_net_sol);
    for (const lifecycle of lifecycles) {
      if (!lifecycle?.lifecycle_id || lifecycle.run_id !== selected.runId || !lifecycle.deployed_at) lifecycleCorrelated = false;
      else lifecycleLatest.set(lifecycle.lifecycle_id, lifecycle);
    }
  }
  let peakNet = 0;
  let maxDrawdown = 0;
  for (const net of netSeries) {
    if (!Number.isFinite(net)) {
      financialsComplete = false;
      continue;
    }
    peakNet = Math.max(peakNet, net);
    maxDrawdown = Math.max(maxDrawdown, peakNet - net);
  }
  const lifecycles = [...lifecycleLatest.values()];
  const settled = lifecycles.filter((lifecycle) => lifecycle.lifecycle_status === "SETTLED" && lifecycle.terminal_state === "CLOSED_SETTLED");
  const unresolved = lifecycles.filter((lifecycle) => !(lifecycle.lifecycle_status === "SETTLED" && lifecycle.terminal_state === "CLOSED_SETTLED"));
  const lifecycleDeployAmounts = lifecycles.map((lifecycle) => finite(lifecycle?.amount_sol));
  const exactDeploymentAmount = lifecycles.length > 0 && lifecycleDeployAmounts.every((amount) => (
    amount != null && Math.abs(amount - thresholds.requiredDeployAmountSol) <= 1e-9
  ));
  const settledNetOutcomes = settled.map((lifecycle) => finite(lifecycle?.settlement?.net_pnl_sol));
  const settledOutcomeDataComplete = settled.length > 0 && settledNetOutcomes.every((outcome) => outcome != null);
  const grossProfitSol = settledOutcomeDataComplete
    ? settledNetOutcomes.reduce((sum, outcome) => sum + Math.max(0, outcome), 0)
    : null;
  const grossLossSol = settledOutcomeDataComplete
    ? settledNetOutcomes.reduce((sum, outcome) => sum + Math.max(0, -outcome), 0)
    : null;
  const profitFactor = grossProfitSol != null && grossLossSol != null && grossLossSol > 0
    ? grossProfitSol / grossLossSol
    : null;
  const profitFactorPass = settledOutcomeDataComplete && grossProfitSol > 0 && (
    grossLossSol === 0 || profitFactor >= thresholds.minProfitFactor
  );
  const settledLossPcts = settled.map((lifecycle) => {
    const principal = finite(lifecycle?.settlement?.initial_principal_sol ?? lifecycle?.amount_sol);
    const net = finite(lifecycle?.settlement?.net_pnl_sol);
    return principal != null && principal > 0 && net != null ? Math.max(0, -(net / principal * 100)) : null;
  });
  const maxSingleLossPct = settledLossPcts.length > 0 && settledLossPcts.every((loss) => loss != null)
    ? Math.max(...settledLossPcts)
    : null;
  const settlementsReconciled = settled.length > 0 && settled.every((lifecycle) => (
    lifecycle.reconciliation?.simulated === true && lifecycle.reconciliation?.verified === true &&
    lifecycle.reconciliation?.error_sol === 0 && lifecycle.reconciliation?.verified_at && lifecycle.settlement?.settled_at &&
    finite(lifecycle.reconciliation.expected_final_equity_sol) != null &&
    finite(lifecycle.reconciliation.observed_final_equity_sol) != null &&
    Math.abs(lifecycle.reconciliation.expected_final_equity_sol - lifecycle.reconciliation.observed_final_equity_sol) <= 1e-8 &&
    Math.abs(lifecycle.reconciliation.observed_final_equity_sol - lifecycle.settlement.final_equity_sol) <= 1e-8
  ));
  const cleanupVerified = settled.length > 0 && settled.every((lifecycle) => (
    lifecycle.cleanup?.simulated === true && lifecycle.cleanup?.verified === true &&
    lifecycle.cleanup?.no_wallet_or_transactions === true && lifecycle.cleanup?.verified_at
  ));
  const breakerObservations = records.map((record) => record.breaker);
  const breakerFresh = lastMs != null && nowMs - lastMs >= 0 && nowMs - lastMs <= thresholds.maxHeartbeatGapMinutes * 60_000;
  const breakerHealthy = breakerObservations.length === records.length && breakerObservations.every((breaker, index) => (
    breaker?.run_id === selected.runId && timestamp(breaker.observed_at) === timestamp(records[index]?.observed_at) &&
    breaker.tripped !== true && breaker.manual_resume_required !== true &&
    finite(breaker.last_event_at_ms) != null && finite(breaker.last_event_at_ms) <= nowMs + 60_000 &&
    !(firstMs != null && finite(breaker.resumed_at_ms) != null && breaker.resumed_at_ms >= firstMs)
  ));
  const dataQuality = structurallyValid && lifecycleCorrelated && financialsComplete && lifecycles.length > 0 && records.every((record) => (
    Array.isArray(record.lifecycles) && record.lifecycles.length > 0 && record.emitter === "shadow_lifecycle_management"
  ));
  const gates = {
    rollout_stage: result(allStagesCorrect, [...new Set(records.map((record) => record.rollout_stage))], rolloutStage, allStagesCorrect ? "ROLLOUT_STAGE_MATCHED" : "ROLLOUT_STAGE_MISMATCH"),
    strategy_profile: result(
      allStrategyProfilesCorrect,
      [...new Set(records.map((record) => record.strategy_profile))],
      strategyProfile,
      allStrategyProfilesCorrect ? "STRATEGY_PROFILE_MATCHED" : "STRATEGY_PROFILE_MISMATCH",
    ),
    heartbeat_coverage: result(
      structurallyValid && coverageHours >= thresholds.minDryRunHours && maxGapMs <= thresholds.maxHeartbeatGapMinutes * 60_000 && breakerFresh,
      { hours: round(coverageHours, 3), max_gap_minutes: round(maxGapMs / 60_000, 3), last_heartbeat_at: records.at(-1)?.observed_at ?? null },
      { hours: thresholds.minDryRunHours, max_gap_minutes: thresholds.maxHeartbeatGapMinutes, fresh_at_evaluation: true },
      !structurallyValid ? "HEARTBEAT_CHAIN_INVALID" : coverageHours < thresholds.minDryRunHours ? "HEARTBEAT_COVERAGE_BELOW_MINIMUM" : maxGapMs > thresholds.maxHeartbeatGapMinutes * 60_000 ? "HEARTBEAT_GAP_EXCEEDED" : !breakerFresh ? "HEARTBEAT_STALE" : "HEARTBEAT_COVERAGE_MET",
    ),
    shadow_lifecycle_count: result(settled.length >= thresholds.minCompletedShadowLifecycles, settled.length, thresholds.minCompletedShadowLifecycles, settled.length >= thresholds.minCompletedShadowLifecycles ? "SETTLED_LIFECYCLES_MET" : "SETTLED_LIFECYCLES_BELOW_MINIMUM"),
    deployment_amount: result(
      exactDeploymentAmount,
      [...new Set(lifecycleDeployAmounts.map((amount) => round(amount)))],
      thresholds.requiredDeployAmountSol,
      exactDeploymentAmount ? "EXACT_CANARY_DEPLOYMENT_AMOUNT_MET" : "CANARY_DEPLOYMENT_AMOUNT_MISMATCH",
    ),
    unresolved_lifecycles: result(lifecycles.length > 0 && unresolved.length === 0, unresolved.map((lifecycle) => lifecycle.lifecycle_id), 0, lifecycles.length === 0 ? "NO_LIFECYCLES_OBSERVED" : unresolved.length ? "UNRESOLVED_LIFECYCLES_PRESENT" : "ALL_LIFECYCLES_SETTLED"),
    net_sol: result(financialsComplete && netSeries.length > 0 && netSeries.at(-1) >= thresholds.minNetSol, round(netSeries.at(-1)), thresholds.minNetSol, financialsComplete ? "AUTHORITATIVE_MARK_TO_MARKET_NET_EVALUATED" : "AUTHORITATIVE_NET_DATA_INCOMPLETE"),
    profit_factor: result(
      profitFactorPass,
      grossLossSol === 0 && grossProfitSol > 0 ? "unbounded" : round(profitFactor, 6),
      thresholds.minProfitFactor,
      profitFactorPass ? "PROFIT_FACTOR_MET" : "PROFIT_FACTOR_BELOW_MINIMUM_OR_INCOMPLETE",
    ),
    max_single_loss: result(
      maxSingleLossPct != null && maxSingleLossPct <= thresholds.maxSingleLossPct,
      round(maxSingleLossPct, 6),
      thresholds.maxSingleLossPct,
      maxSingleLossPct == null
        ? "SINGLE_LOSS_DATA_INCOMPLETE"
        : maxSingleLossPct <= thresholds.maxSingleLossPct
          ? "MAX_SINGLE_LOSS_WITHIN_LIMIT"
          : "MAX_SINGLE_LOSS_EXCEEDED",
    ),
    drawdown: result(financialsComplete && netSeries.length > 0 && maxDrawdown <= thresholds.maxDrawdownSol, round(maxDrawdown), thresholds.maxDrawdownSol, financialsComplete ? "MARK_TO_MARKET_DRAWDOWN_EVALUATED" : "MARK_TO_MARKET_DRAWDOWN_DATA_INCOMPLETE"),
    reconciliation: result(settled.length >= thresholds.minCompletedShadowLifecycles && settlementsReconciled, settlementsReconciled, true, settlementsReconciled ? "EVERY_SETTLEMENT_RECONCILED" : "SIMULATED_RECONCILIATION_EVIDENCE_REQUIRED"),
    cleanup: result(settled.length >= thresholds.minCompletedShadowLifecycles && cleanupVerified, cleanupVerified, true, cleanupVerified ? "EVERY_SETTLEMENT_SHADOW_CLEANUP_VERIFIED" : "SIMULATED_SHADOW_CLEANUP_EVIDENCE_REQUIRED"),
    observation_failures: result(observationFailureCount === 0, observationFailureCount, 0, observationFailureCount === 0 ? "NO_OBSERVATION_FAILURES" : "OBSERVATION_FAILURES_PRESENT"),
    breaker: result(lifecycles.length > 0 && breakerFresh && breakerHealthy, { observations: breakerObservations.length, fresh: breakerFresh }, "healthy run-bound observation per heartbeat; no trip or manual resume", lifecycles.length > 0 && breakerHealthy && breakerFresh ? "BREAKER_HEALTHY_WITH_RUN_HISTORY" : "BREAKER_HISTORY_MISSING_UNHEALTHY_OR_STALE"),
    exposure_limits: result(lifecycles.length > 0 && maxConcurrent <= thresholds.maxConcurrentPositions && maxDeployed <= thresholds.maxDeployedAmountSol, { max_concurrent_positions: maxConcurrent, max_deployed_amount_sol: round(maxDeployed) }, { max_concurrent_positions: thresholds.maxConcurrentPositions, max_deployed_amount_sol: thresholds.maxDeployedAmountSol }, lifecycles.length > 0 && maxConcurrent <= thresholds.maxConcurrentPositions && maxDeployed <= thresholds.maxDeployedAmountSol ? "SHADOW_EXPOSURE_LIMITS_MET" : "SHADOW_EXPOSURE_LIMIT_EXCEEDED"),
    data_quality: result(dataQuality, { source_chain_valid: structurallyValid, lifecycle_correlation_valid: lifecycleCorrelated, financials_complete: financialsComplete, records: records.length }, "complete run-scoped lifecycle, interim-mark, and observation evidence", dataQuality ? "RUN_SCOPED_DATA_QUALITY_COMPLETE" : "RUN_SCOPED_DATA_QUALITY_INCOMPLETE"),
  };
  const ready = Object.values(gates).every((gate) => gate.pass);
  return {
    available: true,
    reason: null,
    run_id: selected.runId,
    source: { file: filePath, sha256: sha256Bytes(source.bytes), record_count: records.length },
    thresholds,
    coverage: { first_heartbeat_at: records[0]?.observed_at ?? null, last_heartbeat_at: records.at(-1)?.observed_at ?? null, hours: round(coverageHours, 3), max_gap_minutes: round(maxGapMs / 60_000, 3) },
    shadow_baseline: { strategy_profile: records.at(-1)?.strategy_profile ?? null, lifecycle_count: lifecycles.length, settled_lifecycle_count: settled.length, unresolved_lifecycle_count: unresolved.length, authoritative_net_sol: round(netSeries.at(-1)), profit_factor: grossLossSol === 0 && grossProfitSol > 0 ? "unbounded" : round(profitFactor, 6), max_single_loss_pct: round(maxSingleLossPct, 6), max_mark_to_market_drawdown_sol: round(maxDrawdown), max_concurrent_positions: maxConcurrent, max_deployed_amount_sol: round(maxDeployed), observation_failure_count: observationFailureCount },
    gates,
    ready,
  };
}
