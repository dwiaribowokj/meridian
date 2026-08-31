/**
 * Persistent agent state — stored in state.json.
 *
 * Tracks position metadata that isn't available on-chain:
 * - When a position was deployed
 * - Strategy and bin config used
 * - When it first went out of range
 * - Actions taken (claims, rebalances)
 */

import crypto from "node:crypto";
import fs from "fs";
import { log } from "./logger.js";
import { repoPath } from "./repo-root.js";
import {
  LEGACY_SHADOW_ROTATION_STRATEGY_PROFILE,
  resolveEffectiveTakeProfitPct,
  SHADOW_ROTATION_STRATEGY_PROFILE,
  YIELD_HOLD_STRATEGY_PROFILE,
} from "./risk-policy.js";

const STATE_FILE = process.env.MERIDIAN_STATE_FILE || repoPath("state.json");

const MAX_RECENT_EVENTS = 20;
const MAX_SHADOW_ROLLOUT_ARCHIVES = 20;
const MAX_INSTRUCTION_LENGTH = 280;
const SHADOW_ROLLOUT_STAGE = "shadow_baseline";
export const SHADOW_ROLLOUT_ARCHIVE_CONFIRMATION = "ARCHIVE INVALID SHADOW RUN";

function sanitizeStoredText(text, maxLen = MAX_INSTRUCTION_LENGTH) {
  if (text == null) return null;
  const cleaned = String(text)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[<>`]/g, "")
    .trim()
    .slice(0, maxLen);
  return cleaned || null;
}

function load() {
  if (!fs.existsSync(STATE_FILE)) {
    return { positions: {}, recentEvents: [], lastUpdated: null };
  }
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch (err) {
    log("state_error", `Failed to read state.json: ${err.message}`);
    return { positions: {}, lastUpdated: null };
  }
}

function save(state, nowMs = Date.now()) {
  try {
    state.lastUpdated = new Date(finiteNumber(nowMs) ?? Date.now()).toISOString();
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    log("state_error", `Failed to write state.json: ${err.message}`);
  }
}

function normalizeShadowStrategyProfile(value) {
  if (value === SHADOW_ROTATION_STRATEGY_PROFILE) return SHADOW_ROTATION_STRATEGY_PROFILE;
  if (value === LEGACY_SHADOW_ROTATION_STRATEGY_PROFILE) return LEGACY_SHADOW_ROTATION_STRATEGY_PROFILE;
  return YIELD_HOLD_STRATEGY_PROFILE;
}

function ensureShadowRolloutRun(state, nowMs = Date.now(), strategyProfile = YIELD_HOLD_STRATEGY_PROFILE) {
  const requestedProfile = normalizeShadowStrategyProfile(strategyProfile);
  const existing = state.shadowRolloutRun;
  if (existing && typeof existing.run_id === "string" && existing.run_id && existing.rollout_stage === SHADOW_ROLLOUT_STAGE) {
    const existingProfile = normalizeShadowStrategyProfile(existing.strategy_profile);
    if (existingProfile !== requestedProfile) {
      throw new Error(`Active shadow run profile ${existingProfile} cannot accept ${requestedProfile} lifecycle`);
    }
    return { run: existing, created: false };
  }
  const startedAt = paperTimestampIso(nowMs);
  const run = {
    run_id: `shadow:${crypto.randomUUID()}`,
    rollout_stage: SHADOW_ROLLOUT_STAGE,
    strategy_profile: requestedProfile,
    started_at: startedAt,
  };
  state.shadowRolloutRun = run;
  return { run, created: true };
}

function optionalPaperNumber(value) {
  if (value == null || (typeof value === "string" && !value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function sanitizePaperPolicySnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return null;
  const numericKeys = [
    "timeframeMinutes",
    "evaluatedAtMs",
    "requestedDeployUsd",
    "activeTvlUsd",
    "volumeUsd",
    "feeActiveTvlRatioPct",
    "volatility",
    "binStep",
    "organicScoreBase",
    "organicScoreQuote",
    "holderCount",
    "marketCapUsd",
    "tokenAgeHours",
    "globalFeesSol",
    "smartWalletCount",
  ];
  const clean = {};
  for (const key of numericKeys) {
    const value = optionalPaperNumber(snapshot[key]);
    if (value != null) clean[key] = value;
  }
  for (const [key, value] of [
    ["strategyProfile", snapshot.strategyProfile],
    ["fundingModel", snapshot.fundingModel],
    ["poolAddress", snapshot.poolAddress],
    ["pairType", snapshot.pairType],
    ["protocol", snapshot.protocol],
  ]) {
    const text = sanitizeStoredText(value, 120);
    if (text) clean[key] = text;
  }
  for (const key of ["momentum5m", "momentum15m"]) {
    const momentum = snapshot[key];
    if (!momentum || typeof momentum !== "object" || Array.isArray(momentum)) continue;
    clean[key] = {
      available: momentum.available === true,
      supertrendDirection: sanitizeStoredText(momentum.supertrendDirection, 24) || "unknown",
      supertrendBreakUp: momentum.supertrendBreakUp === true,
      supertrendBreakDown: momentum.supertrendBreakDown === true,
      rsi: optionalPaperNumber(momentum.rsi),
      close: optionalPaperNumber(momentum.close),
      previousClose: optionalPaperNumber(momentum.previousClose),
      lowerBand: optionalPaperNumber(momentum.lowerBand),
      upperBand: optionalPaperNumber(momentum.upperBand),
    };
  }
  const entryEconomics = snapshot.entryEconomics;
  if (entryEconomics && typeof entryEconomics === "object" && !Array.isArray(entryEconomics)) {
    clean.entryEconomics = {};
    for (const key of [
      "timeframeMinutes",
      "maxHoldMinutes",
      "windows",
      "feeActiveTvlRatioPct",
      "feeParticipationPct",
      "feeAccrualHaircutPct",
      "estimatedRoundTripCostPct",
      "minimumFeeCoverageRatio",
      "minimumProjectedNetFeePct",
      "requiredCapturedFeePct",
      "requiredFeeActiveTvlRatioPct",
      "projectedCapturedFeePct",
      "projectedNetFeePct",
      "feeCoverageRatio",
    ]) {
      const value = optionalPaperNumber(entryEconomics[key]);
      if (value != null) clean.entryEconomics[key] = value;
    }
    clean.entryEconomics.eligible = entryEconomics.eligible === true;
  }
  const entryExecutableLiquidity = snapshot.entryExecutableLiquidity;
  if (entryExecutableLiquidity && typeof entryExecutableLiquidity === "object" && !Array.isArray(entryExecutableLiquidity)) {
    const executable = {};
    for (const key of [
      "quotedAtMs",
      "quoteSlippageBps",
      "recoveryBps",
      "roundTripLossBps",
      "maxPriceImpactBps",
      "maxRoundTripLossBps",
      "deployAmountSol",
    ]) {
      const value = optionalPaperNumber(entryExecutableLiquidity[key]);
      if (value != null) executable[key] = value;
    }
    for (const key of [
      "source",
      "baseMint",
      "inputSolLamports",
      "modeledTokenRaw",
      "executableRecoveryLamports",
    ]) {
      const value = sanitizeStoredText(entryExecutableLiquidity[key], 160);
      if (value) executable[key] = value;
    }
    for (const side of ["buy", "sell"]) {
      const quote = entryExecutableLiquidity[side];
      if (!quote || typeof quote !== "object" || Array.isArray(quote)) continue;
      executable[side] = {
        routeFound: quote.routeFound === true,
        worstOutRaw: sanitizeStoredText(quote.worstOutRaw, 160),
        networkFeeLamports: sanitizeStoredText(quote.networkFeeLamports, 160),
        worstNetLamports: sanitizeStoredText(quote.worstNetLamports, 160),
        priceImpactBps: optionalPaperNumber(quote.priceImpactBps),
        error: sanitizeStoredText(quote.error, 280),
      };
    }
    if (Object.keys(executable).length > 0) clean.entryExecutableLiquidity = executable;
  }
  if (Array.isArray(snapshot.observations)) {
    clean.observations = snapshot.observations.slice(-4).map((observation) => ({
      observedAtMs: optionalPaperNumber(observation?.observedAtMs),
      feeValue: optionalPaperNumber(observation?.feeValue),
      volumeValue: optionalPaperNumber(observation?.volumeValue),
      priceValue: optionalPaperNumber(observation?.priceValue),
      binStepValue: optionalPaperNumber(observation?.binStepValue),
    }));
  }
  return Object.keys(clean).length > 0 ? clean : null;
}

// ─── Position Registry ─────────────────────────────────────────

/**
 * Record a newly deployed position.
 */
export function trackPosition({
  position,
  pool,
  pool_name,
  base_mint = null,
  strategy,
  funding_model = null,
  bin_range = {},
  amount_sol,
  amount_x = 0,
  layers = null,
  active_bin,
  bin_step,
  volatility,
  fee_tvl_ratio,
  fee_timeframe = null,
  organic_score,
  initial_value_usd,
  signal_snapshot = null,
  entry_mcap = null,
  entry_tvl = null,
  entry_volume = null,
  entry_holders = null,
  wallet_sol_before_deploy = null,
  wallet_sol_after_deploy = null,
  transaction_signatures = [],
  // A deploy request/reservation is deliberately separate from receipt-proven
  // economics.  It may be used to conservatively reserve risk while receipt
  // reconciliation is pending, but it is never a PnL/equity cost basis.
  requested_deploy_lamports = null,
  risk_reserved_lamports = null,
  local_cost_basis_lamports = null,
  basis_status = "PENDING",
  lifecycle_id = null,
  notes = [],
}) {
  const state = load();
  const normalizedBasisStatus = String(basis_status || "PENDING");
  const requestFromAmount = Number(amount_sol);
  const inferredRequestLamports = Number.isFinite(requestFromAmount) && requestFromAmount > 0
    ? Math.round(requestFromAmount * 1e9)
    : null;
  const normalizeReservation = (value, fallback = null) => {
    const numeric = Number(value ?? fallback);
    return Number.isSafeInteger(Math.round(numeric)) && numeric >= 0 ? Math.round(numeric) : null;
  };
  const requestedLamports = normalizeReservation(requested_deploy_lamports, inferredRequestLamports);
  const riskReservedLamports = normalizeReservation(risk_reserved_lamports, requestedLamports);
  // A non-READY position never carries an actual basis.  In particular, do
  // not let a caller-provided request amount become a local accounting fact.
  const actualBasisLamports = normalizedBasisStatus === "READY" && local_cost_basis_lamports != null
    ? normalizeReservation(local_cost_basis_lamports)
    : null;
  state.positions[position] = {
    position,
    pool,
    pool_name,
    base_mint: sanitizeStoredText(base_mint, 120),
    strategy,
    funding_model: sanitizeStoredText(funding_model, 64) || "single_side_sol",
    bin_range,
    amount_sol,
    amount_x,
    layers,
    active_bin_at_deploy: active_bin,
    bin_step,
    volatility,
    fee_tvl_ratio,
    fee_timeframe: sanitizeStoredText(fee_timeframe, 24) || null,
    initial_fee_tvl_ratio: fee_tvl_ratio,
    initial_fee_tvl_24h: String(fee_timeframe || "").trim().toLowerCase() === "24h" ? fee_tvl_ratio : null,
    organic_score,
    initial_value_usd,
    entry_mcap,
    entry_tvl,
    entry_volume,
    entry_holders,
    wallet_sol_before_deploy,
    wallet_sol_after_deploy,
    wallet_sol_deploy_delta: wallet_sol_before_deploy != null && wallet_sol_after_deploy != null
      ? Number((wallet_sol_after_deploy - wallet_sol_before_deploy).toFixed(9))
      : null,
    transaction_signatures: Array.isArray(transaction_signatures) ? transaction_signatures.filter(Boolean) : [],
    requested_deploy_lamports: requestedLamports,
    risk_reserved_lamports: riskReservedLamports,
    local_cost_basis_lamports: actualBasisLamports,
    basis_status: normalizedBasisStatus,
    lifecycle_id: lifecycle_id || `lp:${position}`,
    ledger_status: normalizedBasisStatus === "READY" ? "ACTIVE" : "BASIS_PENDING",
    signal_snapshot: signal_snapshot || null,
    deployed_at: new Date().toISOString(),
    out_of_range_since: null,
    last_claim_at: null,
    total_fees_claimed_usd: 0,
    rebalance_count: 0,
    closed: false,
    closed_at: null,
    notes: Array.isArray(notes) ? notes.map((note) => sanitizeStoredText(note)).filter(Boolean) : [],
    peak_pnl_pct: 0,
    peak_pnl_confirmed_at: null,
    pending_peak_pnl_pct: null,
    pending_peak_confirm_count: 0,
    pending_peak_started_at: null,
    pending_exit_action: null,
    pending_exit_count: 0,
    pending_exit_started_at: null,
    pending_exit_observation_key: null,
    trailing_active: false,
  };
  pushEvent(state, { action: "deploy", position, pool_name: pool_name || pool });
  save(state);
  log("state", `Tracked new position: ${position} in pool ${pool}`);
}

/**
 * Record a dry-run deploy as a virtual paper position.
 * This never represents an on-chain position; it is only for strategy observation.
 */
export function trackPaperPosition({
  pool,
  pool_name,
  base_mint,
  strategy,
  funding_model = null,
  bin_range = {},
  amount_sol,
  amount_x = 0,
  layers = null,
  active_bin,
  bin_step,
  volatility,
  fee_tvl_ratio,
  fee_timeframe,
  organic_score,
  initial_value_usd,
  policy_snapshot,
  entry_mcap,
  entry_tvl,
  entry_volume,
  entry_holders,
  active_price,
  min_price,
  max_price,
  downside_coverage_pct,
  upside_coverage_pct,
  total_width_pct,
  nowMs = Date.now(),
  notes = [],
}) {
  const state = load();
  if (!state.paperPositions) state.paperPositions = {};
  const strategyProfile = normalizeShadowStrategyProfile(policy_snapshot?.strategyProfile);
  const { run } = ensureShadowRolloutRun(state, nowMs, strategyProfile);
  const deployedAt = paperTimestampIso(nowMs);
  const paperId = `paper:${pool}:${paperTimestampMs(nowMs)}`;
  state.paperPositions[paperId] = {
    paper: true,
    shadow_run_id: run.run_id,
    strategy_profile: strategyProfile,
    position: paperId,
    pool,
    pool_name,
    base_mint: sanitizeStoredText(base_mint, 120),
    strategy,
    funding_model: sanitizeStoredText(funding_model, 64) || "single_side_sol",
    bin_range,
    amount_sol,
    amount_x,
    layers,
    active_bin_at_deploy: active_bin,
    bin_step,
    volatility,
    fee_tvl_ratio,
    fee_timeframe: sanitizeStoredText(fee_timeframe, 24) || null,
    initial_fee_tvl_ratio: fee_tvl_ratio,
    initial_fee_tvl_24h: String(fee_timeframe || "").trim().toLowerCase() === "24h" ? fee_tvl_ratio : null,
    organic_score,
    initial_value_usd,
    policy_snapshot: sanitizePaperPolicySnapshot(policy_snapshot),
    entry_mcap: optionalPaperNumber(entry_mcap),
    entry_tvl: optionalPaperNumber(entry_tvl),
    entry_volume: optionalPaperNumber(entry_volume),
    entry_holders: optionalPaperNumber(entry_holders),
    active_price_at_deploy: active_price,
    min_price,
    max_price,
    downside_coverage_pct,
    upside_coverage_pct,
    total_width_pct,
    deployed_at: deployedAt,
    last_observed_at: null,
    last_active_bin: null,
    last_active_price: null,
    in_range: null,
    status: "open",
    lifecycle_status: "OPEN",
    terminal_state: null,
    settled_at: null,
    out_of_range_since: null,
    price_change_pct: null,
    peak_pnl_pct: 0,
    peak_pnl_confirmed_at: null,
    pending_peak_pnl_pct: null,
    pending_peak_confirm_count: 0,
    pending_peak_started_at: null,
    pending_exit_action: null,
    pending_exit_count: 0,
    pending_exit_started_at: null,
    pending_exit_observation_key: null,
    gross_mark_sol: Number(amount_sol || 0),
    estimated_fee_accrual_sol: 0,
    estimated_entry_cost_sol: 0,
    estimated_exit_cost_sol: 0,
    estimated_round_trip_cost_sol: 0,
    equity_net_sol: Number(amount_sol || 0),
    projected_net_pnl_sol: 0,
    projected_net_pnl_pct: 0,
    notes: Array.isArray(notes) ? notes.map((note) => sanitizeStoredText(note)).filter(Boolean) : [],
  };
  pushEvent(state, { ts: deployedAt, action: "paper_deploy", position: paperId, pool_name: pool_name || pool });
  save(state, nowMs);
  log("state", `Tracked paper position: ${paperId} in pool ${pool}`);
  return paperId;
}

/**
 * Mark a position as out of range (sets timestamp on first detection).
 */
export function markOutOfRange(position_address) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return;
  if (!pos.out_of_range_since) {
    pos.out_of_range_since = new Date().toISOString();
    save(state);
    log("state", `Position ${position_address} marked out of range`);
  }
}

/**
 * Mark a position as back in range (clears OOR timestamp).
 */
export function markInRange(position_address) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return;
  if (pos.out_of_range_since) {
    pos.out_of_range_since = null;
    save(state);
    log("state", `Position ${position_address} back in range`);
  }
}

/**
 * How many minutes has a position been out of range?
 * Returns 0 if currently in range.
 */
export function minutesOutOfRange(position_address) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || !pos.out_of_range_since) return 0;
  const ms = Date.now() - new Date(pos.out_of_range_since).getTime();
  return Math.floor(ms / 60000);
}

/**
 * Record a fee claim event.
 */
export function recordClaim(position_address, fees_usd) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return;
  pos.last_claim_at = new Date().toISOString();
  pos.total_fees_claimed_usd = (pos.total_fees_claimed_usd || 0) + (fees_usd || 0);
  pos.notes.push(`Claimed ~$${fees_usd?.toFixed(2) || "?"} fees at ${pos.last_claim_at}`);
  save(state);
}

/**
 * Append to the recent events log (shown in every prompt).
 */
function pushEvent(state, event) {
  if (!state.recentEvents) state.recentEvents = [];
  state.recentEvents.push({ ts: new Date().toISOString(), ...event });
  if (state.recentEvents.length > MAX_RECENT_EVENTS) {
    state.recentEvents = state.recentEvents.slice(-MAX_RECENT_EVENTS);
  }
}

// Records written before receipt accounting did not carry `basis_status` and
// retain their documented compatibility path. Once a record carries that
// status, only a receipt-proven READY basis may drive PnL-derived state or an
// automated exit.
function hasNonReadyStatusBearingBasis(pos) {
  return pos != null && Object.hasOwn(pos, "basis_status") && pos.basis_status !== "READY";
}

function clearPendingPnlSignals(pos) {
  let changed = false;
  for (const key of [
    "pending_peak_pnl_pct",
    "pending_peak_confirm_count",
    "pending_peak_started_at",
    "pending_exit_action",
    "pending_exit_count",
    "pending_exit_started_at",
    "pending_exit_observation_key",
  ]) {
    const cleared = key.endsWith("count") ? 0 : null;
    if (pos[key] !== cleared) {
      pos[key] = cleared;
      changed = true;
    }
  }
  return changed;
}

/**
 * Mark a position as closed.
 */
export function recordClose(position_address, reason) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return;
  pos.closed = true;
  pos.closed_at = new Date().toISOString();
  pos.notes.push(`Closed at ${pos.closed_at}: ${reason}`);
  pushEvent(state, { action: "close", position: position_address, pool_name: pos.pool_name || pos.pool, reason });
  save(state);
  log("state", `Position ${position_address} marked closed: ${reason}`);
}

export function recordCloseSolMetrics(position_address, metrics = {}) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return false;
  for (const [key, value] of Object.entries(metrics)) {
    if (value !== undefined) pos[key] = value;
  }
  save(state);
  log("state", `Position ${position_address} SOL metrics updated`);
  return true;
}

export function updatePositionAccounting(position_address, metrics = {}) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return false;
  const allowed = new Set([
    "basis_status",
    "ledger_status",
    "lifecycle_id",
    "base_mint",
    "requested_deploy_lamports",
    "risk_reserved_lamports",
    "local_cost_basis_lamports",
    "transaction_signatures",
    "deploy_tx_fees_lamports",
    "rent_created_lamports",
    "rent_reclaimed_lamports",
    "projected_exit_cost_lamports",
    "reconciliation_error_lamports",
    "equity_net_lamports",
    "settlement_pnl_source",
  ]);
  for (const [key, value] of Object.entries(metrics)) {
    if (allowed.has(key) && value !== undefined) {
      pos[key] = key === "base_mint" ? sanitizeStoredText(value, 120) : value;
    }
  }
  // INVALID/PENDING receipts have no actual basis.  Clear a stale legacy
  // field during every accounting transition rather than leaving it available
  // to PnL or exposure consumers as an implicit request amount.
  if (pos.basis_status !== "READY") {
    pos.local_cost_basis_lamports = null;
  } else if (!Number.isSafeInteger(Number(pos.local_cost_basis_lamports)) || Number(pos.local_cost_basis_lamports) < 0) {
    pos.local_cost_basis_lamports = null;
  } else {
    pos.local_cost_basis_lamports = Math.round(Number(pos.local_cost_basis_lamports));
  }
  save(state);
  log("state", `Position ${position_address} accounting updated (${pos.basis_status || "unknown"}/${pos.ledger_status || "unknown"})`);
  return true;
}

/**
 * Set a persistent instruction for a position (e.g. "hold until 5% profit").
 * Overwrites any previous instruction. Pass null to clear.
 */
export function setPositionInstruction(position_address, instruction) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return false;
  pos.instruction = sanitizeStoredText(instruction);
  save(state);
  log("state", `Position ${position_address} instruction set: ${pos.instruction}`);
  return true;
}

/**
 * Raise the confirmed peak PnL only after `confirmTicks` consecutive polls where the
 * candidate stays above the current peak. With the 3s RPC poller this confirms a real
 * high in ~3-6s and prevents a single noisy tick from inflating the peak (which would
 * otherwise arm a false trailing-drop). Replaces the old 15s setTimeout recheck.
 * Returns true when the peak was raised this call.
 */
export function confirmPeak(position_address, candidatePnlPct, confirmTicks = 2) {
  if (candidatePnlPct == null) return false;
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || pos.closed) return false;
  if (hasNonReadyStatusBearingBasis(pos)) {
    if (clearPendingPnlSignals(pos)) save(state);
    return false;
  }

  const currentPeak = pos.peak_pnl_pct ?? 0;
  // No new high — drop any pending peak candidate.
  if (candidatePnlPct <= currentPeak) {
    if (pos.pending_peak_pnl_pct != null) {
      pos.pending_peak_pnl_pct = null;
      pos.pending_peak_confirm_count = 0;
      pos.pending_peak_started_at = null;
      save(state);
    }
    return false;
  }

  // Same-or-higher candidate as the pending one → another confirming tick.
  if (pos.pending_peak_pnl_pct != null && candidatePnlPct >= pos.pending_peak_pnl_pct) {
    pos.pending_peak_confirm_count = (pos.pending_peak_confirm_count ?? 1) + 1;
    pos.pending_peak_pnl_pct = candidatePnlPct;
  } else {
    // New / lower-than-pending candidate → start a fresh confirmation streak.
    pos.pending_peak_pnl_pct = candidatePnlPct;
    pos.pending_peak_confirm_count = 1;
    pos.pending_peak_started_at = new Date().toISOString();
  }

  if (pos.pending_peak_confirm_count >= confirmTicks) {
    pos.peak_pnl_pct = Math.max(currentPeak, pos.pending_peak_pnl_pct);
    pos.peak_pnl_confirmed_at = new Date().toISOString();
    pos.pending_peak_pnl_pct = null;
    pos.pending_peak_confirm_count = 0;
    pos.pending_peak_started_at = null;
    save(state);
    log("state", `Position ${position_address} peak PnL confirmed at ${pos.peak_pnl_pct.toFixed(2)}% (${confirmTicks} ticks)`);
    return true;
  }

  save(state);
  return false;
}

/**
 * Consecutive-tick confirmation for an exit signal. The fast poller calls this every
 * tick with the exit action string detected this poll (or null when no exit). An exit
 * only fires after `confirmTicks` consecutive polls report the SAME action — so a single
 * noisy tick can't close a position. Streak resets whenever the signal clears or changes.
 * Returns { fire, action, count }.
 */
export function registerExitSignal(position_address, signal, confirmTicks = 2, observationKey = null) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || pos.closed) return { fire: false, action: null, count: 0 };
  // Receipt uncertainty blocks only signals derived from PnL. OUT_OF_RANGE is
  // established independently from live position/bin geometry and must retain
  // its normal consecutive-tick confirmation path.
  if (hasNonReadyStatusBearingBasis(pos) && signal !== "OUT_OF_RANGE") {
    if (clearPendingPnlSignals(pos)) save(state);
    return { fire: false, action: null, count: 0 };
  }

  if (!signal) {
    if (pos.pending_exit_action != null) {
      pos.pending_exit_action = null;
      pos.pending_exit_count = 0;
      pos.pending_exit_observation_key = null;
      save(state);
    }
    return { fire: false, action: null, count: 0 };
  }

  if (pos.pending_exit_action === signal) {
    if (observationKey == null || pos.pending_exit_observation_key !== observationKey) {
      pos.pending_exit_count = (pos.pending_exit_count ?? 1) + 1;
    }
  } else {
    pos.pending_exit_action = signal;
    pos.pending_exit_count = 1;
    pos.pending_exit_started_at = new Date().toISOString();
  }
  pos.pending_exit_observation_key = observationKey;

  const count = pos.pending_exit_count;
  const fire = count >= confirmTicks;
  if (fire) {
    pos.pending_exit_action = null;
    pos.pending_exit_count = 0;
    pos.pending_exit_started_at = null;
    pos.pending_exit_observation_key = null;
  }
  save(state);
  if (fire) log("state", `Position ${position_address} exit signal "${signal}" confirmed (${confirmTicks} ticks)`);
  return { fire, action: signal, count };
}

/**
 * Get all tracked positions (optionally filter open-only).
 */
export function getTrackedPositions(openOnly = false) {
  const state = load();
  const all = Object.values(state.positions);
  return openOnly ? all.filter((p) => !p.closed) : all;
}

/**
 * Get a single tracked position.
 */
export function getTrackedPosition(position_address) {
  const state = load();
  return state.positions[position_address] || null;
}

export function getOpenPaperPositions() {
  const state = load();
  return Object.values(state.paperPositions || {}).filter((p) => !p.closed);
}

function finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function configNumber(value, fallback) {
  const n = finiteNumber(value);
  return n == null ? fallback : n;
}

function costAwareProfitFloor(mgmtConfig) {
  if (mgmtConfig.costAwareTakeProfitEnabled === false) return 0;
  return Math.max(
    0,
    configNumber(mgmtConfig.estimatedRoundTripCostPct, 1.0) +
      configNumber(mgmtConfig.minNetProfitPct, 0.25),
  );
}

function positiveNumber(value) {
  const n = finiteNumber(value);
  return n != null && n > 0 ? n : null;
}

function paperTimestampMs(nowMs = Date.now()) {
  return finiteNumber(nowMs) ?? Date.now();
}

function paperTimestampIso(nowMs = Date.now()) {
  return new Date(paperTimestampMs(nowMs)).toISOString();
}

function paperConfirmationTicks(value, fallback = 2) {
  const fallbackTicks = Number.isInteger(fallback) && fallback > 0 ? fallback : 2;
  const ticks = finiteNumber(value);
  return Number.isInteger(ticks) && ticks > 0 ? ticks : fallbackTicks;
}

function resetPaperPendingConfirmations(pos) {
  pos.pending_exit_action = null;
  pos.pending_exit_count = 0;
  pos.pending_exit_started_at = null;
  pos.pending_exit_observation_key = null;
  pos.pending_peak_pnl_pct = null;
  pos.pending_peak_confirm_count = 0;
  pos.pending_peak_started_at = null;
}

function minutesSinceIso(iso) {
  if (!iso) return null;
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return null;
  return Math.max(0, Math.floor((Date.now() - ts) / 60000));
}

function paperPriceScaleWarning(entryPrice, currentPrice, binImpliedPrice = null) {
  const referencePrice = binImpliedPrice ?? entryPrice;
  if (referencePrice == null || currentPrice == null) return null;
  const hi = Math.max(referencePrice, currentPrice);
  const lo = Math.min(referencePrice, currentPrice);
  if (lo <= 0) return "invalid_price";
  const ratio = hi / lo;
  // When bins are available, both values describe the same active bin and even
  // a modest divergence is a unit/source mismatch. Legacy price-only records
  // get a wider guard so normal market movement is not misclassified.
  const mismatchThreshold = binImpliedPrice != null ? 1.25 : 10;
  return ratio >= mismatchThreshold ? `price_scale_mismatch:${Math.round(ratio * 100) / 100}x` : null;
}

function netExitMetrics(positionData, tracked, mgmtConfig) {
  const paperPrincipalSol = tracked?.paper === true ? positiveNumber(tracked?.amount_sol) : null;
  const readyActualBasis = tracked?.basis_status === "READY" &&
    Number.isFinite(Number(tracked?.local_cost_basis_lamports)) &&
    Number(tracked.local_cost_basis_lamports) > 0;
  // Risk reservations are intentionally excluded from PnL/exit accounting.
  // A legacy local basis is not trusted unless it has an explicit READY state.
  const deployedSol = paperPrincipalSol ?? (readyActualBasis
    ? positiveNumber(Number(tracked.local_cost_basis_lamports) / 1e9)
    : null);
  const pnlPct = finiteNumber(positionData.projected_net_pnl_pct ?? positionData.pnl_pct);
  const pnlSol = finiteNumber(
    positionData.projected_net_pnl_sol ??
      (mgmtConfig.solMode ? positionData.pnl_usd : null),
  );
  const minFloorPct = Math.max(0, configNumber(mgmtConfig.minNetProfitPct, 0.5));
  const floorSol = Math.max(
    Math.max(0, configNumber(mgmtConfig.minNetProfitSol, 0.0005)),
    deployedSol != null ? deployedSol * minFloorPct / 100 : 0,
  );
  const floorPct = deployedSol != null && deployedSol > 0
    ? floorSol / deployedSol * 100
    : minFloorPct;
  return { deployedSol, pnlPct, pnlSol, floorSol, floorPct };
}

function checkBaselineNetExit(position_address, positionData, pos, mgmtConfig, nowMs = Date.now()) {
  const evaluatedAtMs = paperTimestampMs(nowMs);
  const metrics = netExitMetrics(positionData, pos, mgmtConfig);
  const { deployedSol, pnlPct, pnlSol, floorSol, floorPct } = metrics;
  const ageMinutes = finiteNumber(positionData.age_minutes);
  const basisValid = positionData.pnl_basis_valid !== false && pos.basis_status !== "INVALID";
  const pnlRulesReady = !positionData.pnl_pct_suspicious && basisValid && pnlPct != null;

  if (pnlRulesReady) {
    const catastrophicStopPct = Number(mgmtConfig.catastrophicStopPct ?? -2.5);
    if (pnlPct <= catastrophicStopPct) {
      return {
        action: "CATASTROPHIC_STOP",
        reason: `Catastrophic stop: projected equity-net ${pnlPct.toFixed(2)}% <= ${catastrophicStopPct}%`,
        immediate: true,
      };
    }

    const stopLossPct = Number(mgmtConfig.stopLossPct ?? -1.5);
    const normalStopGraceMinutes = Math.max(0, Number(mgmtConfig.normalStopGraceMinutes ?? 0));
    const normalStopArmed = ageMinutes == null || ageMinutes >= normalStopGraceMinutes;
    if (normalStopArmed && pnlPct <= stopLossPct) {
      const graceLabel = normalStopGraceMinutes > 0 ? ` after ${normalStopGraceMinutes}m grace` : "";
      return {
        action: "STOP_LOSS",
        reason: `Net stop loss${graceLabel}: projected equity-net ${pnlPct.toFixed(2)}% <= ${stopLossPct}%`,
      };
    }

    const peakPnlPct = configNumber(pos.peak_pnl_pct, 0);
    const protectTrigger = Number(mgmtConfig.profitProtectTriggerPct ?? 0.8);
    const protectRetrace = Math.max(0, Number(mgmtConfig.profitProtectRetracePctPoints ?? 0.3));
    const dropFromPeak = peakPnlPct - pnlPct;
    const aboveFloor = pnlSol != null ? pnlSol >= floorSol : pnlPct >= floorPct;
    if (peakPnlPct >= protectTrigger && dropFromPeak >= protectRetrace && aboveFloor) {
      return {
        action: "PROFIT_PROTECT",
        reason: `Net profit protect: peak ${peakPnlPct.toFixed(2)}% retraced ${dropFromPeak.toFixed(2)}pp while current ${pnlPct.toFixed(2)}% remains above ${floorPct.toFixed(2)}% floor`,
      };
    }

    const takeProfitPct = resolveEffectiveTakeProfitPct(mgmtConfig);
    const executionBufferPct = Math.max(0, configNumber(mgmtConfig.takeProfitExecutionBufferPct, 0));
    if (pnlPct >= takeProfitPct && aboveFloor) {
      return {
        action: "TAKE_PROFIT",
        reason: `Net take profit: projected equity-net ${pnlPct.toFixed(2)}% >= effective gate ${takeProfitPct.toFixed(2)}% (execution reserve ${executionBufferPct.toFixed(2)}pp)`,
      };
    }
  }

  if (pos.out_of_range_since) {
    const minutesOOR = Math.floor((evaluatedAtMs - new Date(pos.out_of_range_since).getTime()) / 60000);
    const active = finiteNumber(positionData.active_bin);
    const lower = finiteNumber(positionData.lower_bin);
    const upper = finiteNumber(positionData.upper_bin);
    const belowRange = active != null && lower != null && active < lower;
    const aboveRange = active != null && upper != null && active > upper;
    const belowDistance = belowRange ? lower - active : 0;
    const aboveDistance = aboveRange ? active - upper : 0;
    const closeDepthBins = Math.max(0, Number(mgmtConfig.outOfRangeBinsToClose ?? 10));
    const configuredWaitMinutes = Math.max(1, Number(mgmtConfig.outOfRangeWaitMinutes ?? 30));
    const feePerTvl = finiteNumber(positionData.fee_per_tvl_24h);
    const totalFeesSol = mgmtConfig.solMode
      ? Math.max(0, configNumber(positionData.unclaimed_fees_usd, 0)) + Math.max(0, configNumber(positionData.collected_fees_usd, 0))
      : 0;
    const feeEarnedPct = deployedSol && deployedSol > 0 ? totalFeesSol / deployedSol * 100 : 0;
    const notEarning = positionData.earning_liquidity === false ||
      (feePerTvl != null && feePerTvl < Number(mgmtConfig.minFeePerTvl24h ?? 3) && feeEarnedPct < Number(mgmtConfig.lowYieldMaxCumulativeFeePct ?? 0.15));

    if (belowRange && belowDistance >= closeDepthBins && minutesOOR >= configuredWaitMinutes) {
      return {
        action: "OUT_OF_RANGE",
        reason: `Below range by ${belowDistance} bins for ${minutesOOR}m (limits: ${closeDepthBins} bins / ${configuredWaitMinutes}m)`,
      };
    }
    if (aboveRange && aboveDistance >= closeDepthBins && minutesOOR >= configuredWaitMinutes) {
      return {
        action: "OUT_OF_RANGE",
        reason: `Above range by ${aboveDistance} bins for ${minutesOOR}m (limits: ${closeDepthBins} bins / ${configuredWaitMinutes}m)`,
      };
    }
    if (
      mgmtConfig.strategyProfile === SHADOW_ROTATION_STRATEGY_PROFILE &&
      aboveRange &&
      minutesOOR >= Math.max(1, Number(mgmtConfig.shadowRotationAboveRangeExitMinutes ?? 15))
    ) {
      return {
        action: "OUT_OF_RANGE",
        reason: `Rotation range stopped earning above-range for ${minutesOOR}m`,
      };
    }
    if (aboveRange && minutesOOR >= 120) {
      return { action: "OUT_OF_RANGE", reason: `Above range for ${minutesOOR}m (hard limit: 120m)` };
    }
    if (aboveRange && minutesOOR >= 60 && notEarning) {
      return { action: "OUT_OF_RANGE", reason: `Above range for ${minutesOOR}m and no longer earning` };
    }
  }

  // Preserve the existing fail-closed behavior for every remaining policy
  // branch when PnL basis is unavailable. OOR above is the sole independent
  // exception because it is proven by active/lower/upper bin geometry.
  if (!pnlRulesReady) return null;

  const minAge = Number(mgmtConfig.minAgeBeforeYieldCheck ?? 120);
  const feePerTvl = finiteNumber(positionData.fee_per_tvl_24h);
  const totalFeesSol = mgmtConfig.solMode
    ? Math.max(0, configNumber(positionData.unclaimed_fees_usd, 0)) + Math.max(0, configNumber(positionData.collected_fees_usd, 0))
    : 0;
  const feeEarnedPct = deployedSol && deployedSol > 0 ? totalFeesSol / deployedSol * 100 : 0;
  const lowYieldNow = pnlRulesReady && ageMinutes != null && ageMinutes >= minAge && feePerTvl != null &&
    feePerTvl < Number(mgmtConfig.minFeePerTvl24h ?? 3) &&
    feeEarnedPct < Number(mgmtConfig.lowYieldMaxCumulativeFeePct ?? 0.15);

  // Rotation entries are justified by unusually strong fee flow. Once the
  // review window opens, fail the thesis when that flow has collapsed and the
  // position has not earned enough to compensate. Confirmation is applied by
  // the caller's normal multi-tick exit guard.
  const thesisReviewMinutes = Math.max(1, Number(mgmtConfig.thesisReviewMinutes ?? 20));
  const explicitEntryFeePerTvl = finiteNumber(pos.initial_fee_tvl_ratio);
  const explicitEntryTimeframe = sanitizeStoredText(pos.fee_timeframe, 24)?.toLowerCase() || null;
  const currentFeePerTvl = finiteNumber(positionData.current_fee_tvl_ratio);
  const currentFeeTimeframe = sanitizeStoredText(positionData.current_fee_timeframe, 24)?.toLowerCase() || null;
  const comparableExplicitWindow = explicitEntryFeePerTvl != null &&
    explicitEntryTimeframe != null &&
    currentFeePerTvl != null &&
    currentFeeTimeframe === explicitEntryTimeframe;
  // Compatibility is limited to genuinely legacy records that have no explicit
  // timeframe metadata. Never reinterpret a known 30m entry as a 24h value.
  const legacyEntryFeePerTvl24h = explicitEntryTimeframe == null && explicitEntryFeePerTvl == null
    ? finiteNumber(pos.initial_fee_tvl_24h)
    : null;
  const entryFeePerTvl = comparableExplicitWindow ? explicitEntryFeePerTvl : legacyEntryFeePerTvl24h;
  const comparableCurrentFeePerTvl = comparableExplicitWindow ? currentFeePerTvl : feePerTvl;
  const thesisMinRetentionPct = Math.max(0, Math.min(100, Number(mgmtConfig.thesisMinFeeRetentionPct ?? 50)));
  const thesisMaxEarnedFeePct = Math.max(0, Number(mgmtConfig.thesisMaxEarnedFeePct ?? 0.05));
  const feeRetentionPct = entryFeePerTvl != null && entryFeePerTvl > 0 && comparableCurrentFeePerTvl != null
    ? comparableCurrentFeePerTvl / entryFeePerTvl * 100
    : null;
  if (
    mgmtConfig.strategyProfile === SHADOW_ROTATION_STRATEGY_PROFILE &&
    ageMinutes != null && ageMinutes >= thesisReviewMinutes &&
    feeRetentionPct != null && feeRetentionPct < thesisMinRetentionPct &&
    feeEarnedPct < thesisMaxEarnedFeePct
  ) {
    return {
      action: "THESIS_FAILURE",
      reason: `Rotation fee thesis failed after ${ageMinutes}m: fee flow retained ${feeRetentionPct.toFixed(1)}% < ${thesisMinRetentionPct}% and earned ${feeEarnedPct.toFixed(3)}% < ${thesisMaxEarnedFeePct}%`,
      confirmation_key: positionData.current_fee_observed_at
        ? `fee-window:${currentFeeTimeframe || "24h"}:${positionData.current_fee_observed_at}`
        : null,
    };
  }

  if (lowYieldNow) {
    const spacingMs = Math.max(1, Number(mgmtConfig.lowYieldSampleSpacingMinutes ?? 5)) * 60_000;
    const lastSampleAt = pos.low_yield_last_sample_at ? Date.parse(pos.low_yield_last_sample_at) : 0;
    if (!Number.isFinite(lastSampleAt) || evaluatedAtMs - lastSampleAt >= spacingMs) {
      pos.low_yield_confirm_count = (pos.low_yield_confirm_count ?? 0) + 1;
      pos.low_yield_last_sample_at = new Date(evaluatedAtMs).toISOString();
    }
    if ((pos.low_yield_confirm_count ?? 0) >= Number(mgmtConfig.lowYieldConfirmSamples ?? 3)) {
      return {
        action: "LOW_YIELD",
        reason: `Low yield confirmed ${(pos.low_yield_confirm_count ?? 0)}x: fee/TVL ${feePerTvl.toFixed(2)}% and cumulative fees ${feeEarnedPct.toFixed(3)}%`,
      };
    }
  } else if ((pos.low_yield_confirm_count ?? 0) > 0) {
    pos.low_yield_confirm_count = 0;
    pos.low_yield_last_sample_at = null;
  }

  const maxHoldMinutes = Number(mgmtConfig.maxHoldMinutes ?? 360);
  if (ageMinutes != null && ageMinutes >= maxHoldMinutes) {
    return {
      action: "MAX_HOLD",
      reason: `Maximum hold reached: ${ageMinutes}m >= ${maxHoldMinutes}m`,
    };
  }

  return null;
}

export function updatePaperPositionObservation(position, observation, nowMs = Date.now()) {
  const state = load();
  const pos = state.paperPositions?.[position];
  if (!pos || pos.closed) return null;
  const observedAt = paperTimestampIso(nowMs);
  const entryPrice = positiveNumber(pos.active_price_at_deploy);
  const currentPrice = positiveNumber(observation.active_price);
  const minPrice = positiveNumber(pos.min_price);
  const maxPrice = positiveNumber(pos.max_price);
  const currentBin = finiteNumber(observation.active_bin);
  const minBin = finiteNumber(pos.bin_range?.min);
  const maxBin = finiteNumber(pos.bin_range?.max);
  const hasBinRange = currentBin != null && minBin != null && maxBin != null;
  const hasPriceRange = currentPrice != null && minPrice != null && maxPrice != null;
  const inRange = hasBinRange
    ? currentBin >= minBin && currentBin <= maxBin
    : hasPriceRange
      ? currentPrice >= minPrice && currentPrice <= maxPrice
      : null;
  const status = inRange === true
    ? "in_range"
    : currentBin != null && maxBin != null && currentBin > maxBin
      ? "out_above"
      : currentBin != null && minBin != null && currentBin < minBin
        ? "out_below"
        : "unknown";
  const binStep = positiveNumber(pos.bin_step);
  const entryBin = finiteNumber(pos.active_bin_at_deploy);
  const binImpliedPrice = entryPrice != null && entryBin != null && currentBin != null && binStep != null
    ? entryPrice * Math.pow(1 + binStep / 10000, currentBin - entryBin)
    : null;
  const priceScaleWarning = paperPriceScaleWarning(entryPrice, currentPrice, binImpliedPrice);
  const normalizedCurrentPrice = priceScaleWarning && binImpliedPrice != null
    ? binImpliedPrice
    : currentPrice;
  const priceChangePct = entryBin != null && currentBin != null && binStep != null
    ? (Math.pow(1 + binStep / 10000, currentBin - entryBin) - 1) * 100
    : !priceScaleWarning && entryPrice != null && currentPrice != null
      ? ((currentPrice - entryPrice) / entryPrice) * 100
      : null;
  const binDistance = status === "out_above" ? currentBin - maxBin : status === "out_below" ? minBin - currentBin : 0;
  pos.last_observed_at = observedAt;
  pos.last_active_bin = currentBin;
  pos.last_active_price = normalizedCurrentPrice;
  pos.last_active_price_raw = currentPrice;
  pos.price_normalization_source = priceScaleWarning && binImpliedPrice != null ? "bin_step" : "reported_price";
  pos.in_range = inRange;
  pos.status = status;
  pos.price_change_pct = priceChangePct == null ? null : Math.round(priceChangePct * 10000) / 10000;
  pos.price_scale_warning = priceScaleWarning;
  pos.price_change_source = entryBin != null && currentBin != null && binStep != null
    ? "bin_step"
    : !priceScaleWarning && entryPrice != null && currentPrice != null
      ? "price"
      : null;
  pos.bin_distance_to_range = Number.isFinite(binDistance) ? binDistance : null;
  if (inRange === false && !pos.out_of_range_since) {
    pos.out_of_range_since = pos.last_observed_at;
  } else if (inRange === true && pos.out_of_range_since) {
    pos.out_of_range_since = null;
  }
  if (!pos.observations) pos.observations = [];
  pos.observations.push({
    ts: pos.last_observed_at,
    active_bin: currentBin,
    active_price: normalizedCurrentPrice,
    active_price_raw: currentPrice,
    in_range: inRange,
    status,
    price_change_pct: pos.price_change_pct,
    price_change_source: pos.price_change_source,
    price_scale_warning: pos.price_scale_warning,
    price_normalization_source: pos.price_normalization_source,
    bin_distance_to_range: pos.bin_distance_to_range,
  });
  pos.observations = pos.observations.slice(-96);
  pushEvent(state, { ts: observedAt, action: "paper_observe", position, status, price_change_pct: pos.price_change_pct, price_change_source: pos.price_change_source, price_scale_warning: pos.price_scale_warning });
  save(state, nowMs);
  return pos;
}

const PAPER_VALUATION_FIELDS = new Set([
  "valuation_model",
  "valuation_version",
  "price_return_pct",
  "conservative_price_return_pct",
  "range_exposure_pct",
  "fee_accrual_haircut_pct",
  "fee_participation_pct",
  "fee_timeframe_minutes",
  "fee_tvl_ratio_24h_equivalent_pct",
  "fee_accrual_interval_minutes",
  "estimated_fee_increment_sol",
  "gross_mark_sol",
  "estimated_fee_accrual_sol",
  "estimated_entry_cost_sol",
  "estimated_exit_cost_sol",
  "estimated_round_trip_cost_sol",
  "equity_net_sol",
  "projected_net_pnl_sol",
  "projected_net_pnl_pct",
  "earning_liquidity",
  "pnl_basis_valid",
  "last_valued_at",
]);

function roundedPaperNumber(value, digits = 9) {
  const number = finiteNumber(value);
  if (number == null) return null;
  const factor = 10 ** digits;
  return Math.round(number * factor) / factor;
}

/**
 * Persist a conservative SOL-denominated mark for an open paper position. The
 * caller owns the valuation model; state only records its explicit inputs and
 * resulting equity so paper close/settlement remains auditable.
 */
export function updatePaperPositionValuation(position, valuation = {}, nowMs = Date.now()) {
  const state = load();
  const pos = state.paperPositions?.[position];
  if (!pos || pos.closed) return null;

  for (const [key, value] of Object.entries(valuation)) {
    if (!PAPER_VALUATION_FIELDS.has(key) || value === undefined) continue;
    if (key === "valuation_model" || key === "valuation_version" || key === "last_valued_at") {
      pos[key] = sanitizeStoredText(value, 120);
    } else if (key === "earning_liquidity" || key === "pnl_basis_valid") {
      pos[key] = value === true;
    } else {
      const number = roundedPaperNumber(value);
      if (number != null) pos[key] = number;
    }
  }
  const valuedAt = paperTimestampIso(nowMs);
  pos.last_valued_at = pos.last_valued_at || valuedAt;
  pushEvent(state, {
    ts: valuedAt,
    action: "paper_value",
    position,
    equity_net_sol: pos.equity_net_sol,
    projected_net_pnl_pct: pos.projected_net_pnl_pct,
    estimated_round_trip_cost_sol: pos.estimated_round_trip_cost_sol,
  });
  save(state, nowMs);
  return pos;
}

/**
 * Record an observation failure without creating a synthetic price or exit
 * signal. A later successful observation can resume normal management.
 */
export function recordPaperObservationFailure(position, error, nowMs = Date.now()) {
  const state = load();
  const pos = state.paperPositions?.[position];
  if (!pos || pos.closed) return false;
  const failedAt = paperTimestampIso(nowMs);
  resetPaperPendingConfirmations(pos);
  pos.last_observation_error = sanitizeStoredText(error, 240) || "unknown observation error";
  pos.last_observation_error_at = failedAt;
  pushEvent(state, { ts: failedAt, action: "paper_observe_failed", position, reason: pos.last_observation_error });
  save(state, nowMs);
  return true;
}

/**
 * Confirm paper peaks with the same consecutive-tick semantics as live
 * positions. This avoids a single noisy mark arming a paper profit-protect exit.
 */
export function confirmPaperPeak(position, candidatePnlPct, confirmTicks = 2, nowMs = Date.now()) {
  if (candidatePnlPct == null) return false;
  const state = load();
  const pos = state.paperPositions?.[position];
  if (!pos || pos.closed) return false;

  const candidate = finiteNumber(candidatePnlPct);
  if (candidate == null) return false;
  const requiredTicks = paperConfirmationTicks(confirmTicks);
  const confirmedAt = paperTimestampIso(nowMs);
  const currentPeak = pos.peak_pnl_pct ?? 0;
  if (candidate <= currentPeak) {
    if (pos.pending_peak_pnl_pct != null) {
      pos.pending_peak_pnl_pct = null;
      pos.pending_peak_confirm_count = 0;
      pos.pending_peak_started_at = null;
      save(state, nowMs);
    }
    return false;
  }

  if (pos.pending_peak_pnl_pct != null && candidate >= pos.pending_peak_pnl_pct) {
    pos.pending_peak_confirm_count = (pos.pending_peak_confirm_count ?? 1) + 1;
    pos.pending_peak_pnl_pct = candidate;
  } else {
    pos.pending_peak_pnl_pct = candidate;
    pos.pending_peak_confirm_count = 1;
    pos.pending_peak_started_at = confirmedAt;
  }

  if (pos.pending_peak_confirm_count >= requiredTicks) {
    pos.peak_pnl_pct = Math.max(currentPeak, pos.pending_peak_pnl_pct);
    pos.peak_pnl_confirmed_at = confirmedAt;
    pos.pending_peak_pnl_pct = null;
    pos.pending_peak_confirm_count = 0;
    pos.pending_peak_started_at = null;
    save(state, nowMs);
    log("state", `Paper position ${position} peak PnL confirmed at ${pos.peak_pnl_pct.toFixed(2)}%`);
    return true;
  }

  save(state, nowMs);
  return false;
}

/**
 * Consecutive-tick confirmation for paper exits. This is intentionally separate
 * from live position state so a paper signal can never invoke a transaction path.
 */
export function registerPaperExitSignal(position, signal, confirmTicks = 2, nowMs = Date.now(), observationKey = null) {
  const state = load();
  const pos = state.paperPositions?.[position];
  if (!pos || pos.closed) return { fire: false, action: null, count: 0 };
  const requiredTicks = paperConfirmationTicks(confirmTicks);
  const signaledAt = paperTimestampIso(nowMs);

  if (!signal) {
    if (pos.pending_exit_action != null) {
      pos.pending_exit_action = null;
      pos.pending_exit_count = 0;
      pos.pending_exit_started_at = null;
      pos.pending_exit_observation_key = null;
      save(state, nowMs);
    }
    return { fire: false, action: null, count: 0 };
  }

  if (pos.pending_exit_action === signal) {
    if (observationKey == null || pos.pending_exit_observation_key !== observationKey) {
      pos.pending_exit_count = (pos.pending_exit_count ?? 1) + 1;
    }
  } else {
    pos.pending_exit_action = signal;
    pos.pending_exit_count = 1;
    pos.pending_exit_started_at = signaledAt;
  }
  pos.pending_exit_observation_key = observationKey;

  const count = pos.pending_exit_count;
  const fire = count >= requiredTicks;
  if (fire) {
    pos.pending_exit_action = null;
    pos.pending_exit_count = 0;
    pos.pending_exit_started_at = null;
    pos.pending_exit_observation_key = null;
  }
  save(state, nowMs);
  if (fire) log("state", `Paper position ${position} exit signal "${signal}" confirmed (${requiredTicks} ticks)`);
  return { fire, action: signal, count };
}

/**
 * Evaluate the same baseline, equity-net policy used for live positions. Paper
 * callers provide a conservative valuation; this function only applies policy
 * and persists low-yield/OOR confirmation state.
 */
export function evaluatePaperPositionExit(position, positionData, mgmtConfig, nowMs = Date.now()) {
  const state = load();
  const pos = state.paperPositions?.[position];
  if (!pos || pos.closed) return null;

  let exit = null;
  if (mgmtConfig?.netExitPolicyEnabled !== false) {
    exit = checkBaselineNetExit(position, positionData, pos, mgmtConfig || {}, nowMs);
  } else {
    const pnlPct = finiteNumber(positionData?.projected_net_pnl_pct ?? positionData?.pnl_pct);
    if (pnlPct != null && pnlPct <= Number(mgmtConfig?.stopLossPct ?? -1.5)) {
      exit = { action: "STOP_LOSS", reason: `Paper stop loss: net ${pnlPct.toFixed(2)}% <= ${mgmtConfig?.stopLossPct ?? -1.5}%` };
    } else if (pnlPct != null && pnlPct >= Number(mgmtConfig?.takeProfitPct ?? 1.25)) {
      exit = { action: "TAKE_PROFIT", reason: `Paper take profit: net ${pnlPct.toFixed(2)}% >= ${mgmtConfig?.takeProfitPct ?? 1.25}%` };
    }
  }
  save(state, nowMs);
  return exit;
}

function summarizePaperLifecycles(paperPositions) {
  const positions = Object.values(paperPositions || {});
  const settled = positions.filter((pos) => pos.terminal_state === "CLOSED_SETTLED");
  const sum = (key) => settled.reduce((total, pos) => total + (finiteNumber(pos.settlement?.[key]) ?? 0), 0);
  const netPnlSol = sum("net_pnl_sol");
  const totalPrincipalSol = sum("initial_principal_sol");
  const totalCostSol = sum("estimated_round_trip_cost_sol");
  const averageNetPnlPct = settled.length
    ? settled.reduce((total, pos) => total + (finiteNumber(pos.settlement?.net_pnl_pct) ?? 0), 0) / settled.length
    : 0;
  return {
    open_positions: positions.filter((pos) => !pos.closed).length,
    completed_lifecycles: settled.length,
    settled_lifecycles: settled.length,
    wins: settled.filter((pos) => (finiteNumber(pos.settlement?.net_pnl_sol) ?? 0) > 0).length,
    losses: settled.filter((pos) => (finiteNumber(pos.settlement?.net_pnl_sol) ?? 0) < 0).length,
    total_principal_sol: roundedPaperNumber(totalPrincipalSol),
    total_net_pnl_sol: roundedPaperNumber(netPnlSol),
    total_estimated_cost_sol: roundedPaperNumber(totalCostSol),
    net_return_pct: totalPrincipalSol > 0 ? roundedPaperNumber(netPnlSol / totalPrincipalSol * 100, 6) : 0,
    average_net_pnl_pct: roundedPaperNumber(averageNetPnlPct, 6),
  };
}

/**
 * Mark a paper position terminally closed and settled. It records no signature,
 * touches no wallet, and frees the paper capacity slot immediately.
 */
export function settlePaperPosition(position, { reason, action, valuation = {}, observation = {}, cooldown = null } = {}, nowMs = Date.now()) {
  const state = load();
  const pos = state.paperPositions?.[position];
  if (!pos || pos.closed) return null;

  const initialPrincipalSol = Math.max(0, finiteNumber(pos.amount_sol) ?? 0);
  const finalEquitySol = Math.max(0, finiteNumber(valuation.equity_net_sol ?? pos.equity_net_sol) ?? initialPrincipalSol);
  const netPnlSol = finiteNumber(valuation.projected_net_pnl_sol ?? pos.projected_net_pnl_sol) ?? (finalEquitySol - initialPrincipalSol);
  const netPnlPct = finiteNumber(valuation.projected_net_pnl_pct ?? pos.projected_net_pnl_pct) ??
    (initialPrincipalSol > 0 ? netPnlSol / initialPrincipalSol * 100 : 0);
  const settledAtMs = paperTimestampMs(nowMs);
  const settledAt = new Date(settledAtMs).toISOString();
  const deployedAt = Date.parse(pos.deployed_at);
  const durationMinutes = Number.isFinite(deployedAt)
    ? Math.max(0, Math.floor((settledAtMs - deployedAt) / 60_000))
    : null;

  pos.closed = true;
  pos.closed_at = settledAt;
  pos.settled_at = settledAt;
  pos.status = "closed";
  pos.lifecycle_status = "SETTLED";
  pos.terminal_state = "CLOSED_SETTLED";
  pos.close_reason = sanitizeStoredText(reason || action || "paper exit", 280);
  pos.close_action = sanitizeStoredText(action || "PAPER_EXIT", 80);
  pos.settlement = {
    settled_at: settledAt,
    action: pos.close_action,
    reason: pos.close_reason,
    initial_principal_sol: roundedPaperNumber(initialPrincipalSol),
    gross_mark_sol: roundedPaperNumber(valuation.gross_mark_sol ?? pos.gross_mark_sol),
    estimated_fee_accrual_sol: roundedPaperNumber(valuation.estimated_fee_accrual_sol ?? pos.estimated_fee_accrual_sol),
    estimated_entry_cost_sol: roundedPaperNumber(valuation.estimated_entry_cost_sol ?? pos.estimated_entry_cost_sol),
    estimated_exit_cost_sol: roundedPaperNumber(valuation.estimated_exit_cost_sol ?? pos.estimated_exit_cost_sol),
    estimated_round_trip_cost_sol: roundedPaperNumber(valuation.estimated_round_trip_cost_sol ?? pos.estimated_round_trip_cost_sol),
    final_equity_sol: roundedPaperNumber(finalEquitySol),
    net_pnl_sol: roundedPaperNumber(netPnlSol),
    net_pnl_pct: roundedPaperNumber(netPnlPct, 6),
    duration_minutes: durationMinutes,
    exit_active_bin: finiteNumber(observation.active_bin ?? pos.last_active_bin),
    exit_active_price: finiteNumber(pos.last_active_price ?? observation.active_price),
    exit_active_price_raw: finiteNumber(pos.last_active_price_raw ?? observation.active_price),
  };
  const cooldownHours = Math.max(0, finiteNumber(cooldown?.hours) ?? 0);
  const cooldownUntilRunEnd = cooldown?.untilRunEnd === true;
  if (cooldownHours > 0 || cooldownUntilRunEnd) {
    const requestedScope = String(cooldown?.scope || "both").trim().toLowerCase();
    const scope = new Set(["pool", "token", "both"]).has(requestedScope) ? requestedScope : "both";
    const cooldownUntil = cooldownHours > 0
      ? new Date(settledAtMs + cooldownHours * 60 * 60_000).toISOString()
      : null;
    const cooldownReason = sanitizeStoredText(cooldown?.reason || pos.close_reason, 160) || "shadow bad outcome";
    if (!state.shadowCooldowns || typeof state.shadowCooldowns !== "object") {
      state.shadowCooldowns = { pools: {}, base_mints: {} };
    }
    if (!state.shadowCooldowns.pools) state.shadowCooldowns.pools = {};
    if (!state.shadowCooldowns.base_mints) state.shadowCooldowns.base_mints = {};
    const cooldownRecord = {
      until: cooldownUntil,
      until_run_end: cooldownUntilRunEnd,
      reason: cooldownReason,
      action: pos.close_action,
      position,
      run_id: pos.shadow_run_id || null,
    };
    if ((scope === "pool" || scope === "both" || !pos.base_mint) && pos.pool) {
      state.shadowCooldowns.pools[pos.pool] = cooldownRecord;
    }
    if ((scope === "token" || scope === "both") && pos.base_mint) {
      state.shadowCooldowns.base_mints[pos.base_mint] = cooldownRecord;
    }
    pos.settlement.cooldown = {
      scope,
      hours: cooldownHours,
      until: cooldownUntil,
      until_run_end: cooldownUntilRunEnd,
      run_id: pos.shadow_run_id || null,
      reason: cooldownReason,
    };
  }
  // Paper settlement has no wallet, signatures, or token-account cleanup.
  // Record that explicit local fact so rollout acceptance never infers a
  // cleanup or reconciliation result from a state transition alone.
  pos.reconciliation = {
    simulated: true,
    verified: true,
    verified_at: settledAt,
    expected_final_equity_sol: pos.settlement.final_equity_sol,
    observed_final_equity_sol: pos.settlement.final_equity_sol,
    error_sol: 0,
  };
  pos.cleanup = {
    simulated: true,
    verified: true,
    verified_at: settledAt,
    no_wallet_or_transactions: true,
    method: "local_paper_lifecycle_settlement",
  };
  pos.notes.push(`Paper closed and settled at ${settledAt}: ${pos.close_reason}`);
  pushEvent(state, {
    ts: settledAt,
    action: "paper_settled",
    position,
    pool_name: pos.pool_name || pos.pool,
    reason: pos.close_reason,
    net_pnl_sol: pos.settlement.net_pnl_sol,
    net_pnl_pct: pos.settlement.net_pnl_pct,
  });
  state.paperLifecycleMetrics = summarizePaperLifecycles(state.paperPositions);
  save(state, nowMs);
  log("state", `Paper position ${position} closed and settled: ${pos.close_reason}`);
  return pos;
}

export function getPaperLifecycleMetrics() {
  const state = load();
  return summarizePaperLifecycles(state.paperPositions);
}

function activeShadowCooldown(record, activeRunId, nowMs = Date.now()) {
  if (
    record?.until_run_end === true
    && typeof activeRunId === "string"
    && activeRunId.length > 0
    && record?.run_id === activeRunId
  ) {
    return true;
  }
  const untilMs = Date.parse(record?.until || "");
  return Number.isFinite(untilMs) && untilMs > paperTimestampMs(nowMs);
}

function retainTimedShadowCooldowns(cooldowns, nowMs = Date.now()) {
  const cutoffMs = paperTimestampMs(nowMs);
  const retainScope = (scope) => Object.fromEntries(Object.entries(scope || {}).filter(([, record]) => {
    const untilMs = Date.parse(record?.until || "");
    return Number.isFinite(untilMs) && untilMs > cutoffMs;
  }));
  const retained = {
    pools: retainScope(cooldowns?.pools),
    base_mints: retainScope(cooldowns?.base_mints),
  };
  return Object.keys(retained.pools).length > 0 || Object.keys(retained.base_mints).length > 0
    ? retained
    : null;
}

export function isShadowPoolOnCooldown(pool, nowMs = Date.now()) {
  if (!pool) return false;
  const state = load();
  return activeShadowCooldown(
    state.shadowCooldowns?.pools?.[pool],
    state.shadowRolloutRun?.run_id,
    nowMs,
  );
}

export function isShadowBaseMintOnCooldown(baseMint, nowMs = Date.now()) {
  if (!baseMint) return false;
  const state = load();
  return activeShadowCooldown(
    state.shadowCooldowns?.base_mints?.[baseMint],
    state.shadowRolloutRun?.run_id,
    nowMs,
  );
}

/**
 * Archive an invalid paper-only rollout without rewriting its evidence or
 * pretending that it settled economically. This is intentionally guarded by
 * an exact confirmation and expected run id because clearing the active paper
 * registry starts a new evidence epoch on the next deployment.
 */
export function archiveShadowRolloutRun({
  expectedRunId,
  reason,
  confirmation,
} = {}, nowMs = Date.now()) {
  if (confirmation !== SHADOW_ROLLOUT_ARCHIVE_CONFIRMATION) {
    throw new Error("Shadow rollout archive requires exact operator confirmation");
  }
  const state = load();
  const run = state.shadowRolloutRun;
  if (!run?.run_id) return { archived: false, reason: "NO_ACTIVE_SHADOW_RUN" };
  if (expectedRunId !== run.run_id) {
    throw new Error(`Shadow rollout run mismatch: expected ${expectedRunId || "missing"}, active ${run.run_id}`);
  }
  const archiveReason = sanitizeStoredText(reason, 280);
  if (!archiveReason) throw new Error("Shadow rollout archive requires a reason");

  const archivedAt = paperTimestampIso(nowMs);
  const positions = Object.values(state.paperPositions || {});
  if (positions.some((position) => position?.paper !== true)) {
    throw new Error("Shadow rollout archive may contain paper positions only");
  }
  const archivedPositions = positions.map((position) => ({
    ...position,
    closed: true,
    closed_at: archivedAt,
    status: "aborted",
    lifecycle_status: "ABORTED",
    terminal_state: "ABORTED_CONFIGURATION_ERROR",
    close_action: "SHADOW_RUN_ARCHIVE",
    close_reason: archiveReason,
    notes: [
      ...(Array.isArray(position.notes) ? position.notes : []),
      `Paper rollout archived at ${archivedAt}: ${archiveReason}`,
    ],
  }));
  const archive = {
    run_id: run.run_id,
    rollout_stage: run.rollout_stage,
    strategy_profile: normalizeShadowStrategyProfile(run.strategy_profile),
    started_at: run.started_at,
    archived_at: archivedAt,
    reason: archiveReason,
    invalid_for_acceptance: true,
    lifecycle_count: archivedPositions.length,
    positions: archivedPositions,
  };
  state.shadowRolloutArchives = [
    ...(Array.isArray(state.shadowRolloutArchives) ? state.shadowRolloutArchives : []),
    archive,
  ].slice(-MAX_SHADOW_ROLLOUT_ARCHIVES);
  state.paperPositions = {};
  delete state.shadowRolloutRun;
  // Run-bound cooldowns end with the archived evidence epoch, but explicit
  // time quarantines (for example a seven-day catastrophic-loss quarantine)
  // remain valid across a strategy/sizing migration.
  const retainedCooldowns = retainTimedShadowCooldowns(state.shadowCooldowns, nowMs);
  if (retainedCooldowns) state.shadowCooldowns = retainedCooldowns;
  else delete state.shadowCooldowns;
  state.paperLifecycleMetrics = summarizePaperLifecycles(state.paperPositions);
  pushEvent(state, {
    ts: archivedAt,
    action: "shadow_run_archived",
    run_id: run.run_id,
    reason: archiveReason,
    lifecycle_count: archivedPositions.length,
  });
  save(state, nowMs);
  log("state", `Archived invalid shadow run ${run.run_id}: ${archiveReason}`);
  return { archived: true, archive };
}

/**
 * Read the source fields emitted into a rollout heartbeat.  This function is
 * intentionally state-only: it has no wallet, RPC, executor, or transaction
 * dependency.  The run identifier is persisted with paper lifecycle state so
 * a restart cannot silently splice independent observations into one run.
 */
export function getShadowRolloutEvidenceSnapshot() {
  const state = load();
  const run = state.shadowRolloutRun;
  if (!run || typeof run.run_id !== "string" || !run.run_id || run.rollout_stage !== SHADOW_ROLLOUT_STAGE) {
    // Evidence coverage begins with an actual paper deployment.  Do not create
    // a run from an idle management cycle, because an empty pre-lifecycle
    // heartbeat must never count toward or poison baseline coverage.
    return null;
  }
  const lifecycles = Object.values(state.paperPositions || {}).map((position) => ({
    lifecycle_id: position.position,
    run_id: position.shadow_run_id ?? null,
    deployed_at: position.deployed_at ?? null,
    lifecycle_status: position.lifecycle_status ?? null,
    terminal_state: position.terminal_state ?? null,
    amount_sol: position.amount_sol,
    entry: {
      pool: position.pool,
      pool_name: position.pool_name,
      base_mint: position.base_mint ?? null,
      strategy: position.strategy,
      funding_model: position.funding_model ?? "single_side_sol",
      bin_range: position.bin_range,
      fee_tvl_ratio: position.fee_tvl_ratio,
      fee_timeframe: position.fee_timeframe ?? null,
      volatility: position.volatility,
      policy_snapshot: position.policy_snapshot ?? null,
    },
    last_observed_at: position.last_observed_at ?? null,
    last_observation_error_at: position.last_observation_error_at ?? null,
    last_observation: {
      active_bin: position.last_active_bin ?? null,
      active_price: position.last_active_price ?? null,
      active_price_raw: position.last_active_price_raw ?? null,
      in_range: position.in_range ?? null,
      status: position.status ?? null,
      price_change_pct: position.price_change_pct ?? null,
      price_change_source: position.price_change_source ?? null,
      price_scale_warning: position.price_scale_warning ?? null,
      price_normalization_source: position.price_normalization_source ?? null,
      bin_distance_to_range: position.bin_distance_to_range ?? null,
    },
    valuation: {
      model: position.valuation_model ?? null,
      version: position.valuation_version ?? null,
      last_valued_at: position.last_valued_at ?? null,
      price_return_pct: position.price_return_pct ?? null,
      conservative_price_return_pct: position.conservative_price_return_pct ?? null,
      range_exposure_pct: position.range_exposure_pct ?? null,
      equity_net_sol: position.equity_net_sol,
      projected_net_pnl_sol: position.projected_net_pnl_sol,
      estimated_round_trip_cost_sol: position.estimated_round_trip_cost_sol,
      estimated_fee_accrual_sol: position.estimated_fee_accrual_sol,
      estimated_fee_increment_sol: position.estimated_fee_increment_sol ?? null,
      fee_accrual_interval_minutes: position.fee_accrual_interval_minutes ?? null,
      fee_timeframe_minutes: position.fee_timeframe_minutes ?? null,
      fee_participation_pct: position.fee_participation_pct ?? null,
      fee_tvl_ratio_24h_equivalent_pct: position.fee_tvl_ratio_24h_equivalent_pct ?? null,
      pnl_basis_valid: position.pnl_basis_valid === true,
    },
    settlement: position.settlement ?? null,
    reconciliation: position.reconciliation ?? null,
    cleanup: position.cleanup ?? null,
  }));
  return {
    run_id: run.run_id,
    rollout_stage: run.rollout_stage,
    strategy_profile: normalizeShadowStrategyProfile(run.strategy_profile),
    started_at: run.started_at,
    lifecycles,
  };
}

export function getPaperPosition(position) {
  const state = load();
  return state.paperPositions?.[position] || null;
}

/**
 * Summarize state for the agent system prompt.
 */
export function getStateSummary() {
  const state = load();
  const open = Object.values(state.positions).filter((p) => !p.closed);
  const closed = Object.values(state.positions).filter((p) => p.closed);
  const totalFeesClaimed = Object.values(state.positions)
    .reduce((sum, p) => sum + (p.total_fees_claimed_usd || 0), 0);

  return {
    open_positions: open.length,
    closed_positions: closed.length,
    total_fees_claimed_usd: Math.round(totalFeesClaimed * 100) / 100,
    positions: open.map((p) => ({
      position: p.position,
      pool: p.pool,
      strategy: p.strategy,
      deployed_at: p.deployed_at,
      out_of_range_since: p.out_of_range_since,
      minutes_out_of_range: minutesOutOfRange(p.position),
      total_fees_claimed_usd: p.total_fees_claimed_usd,
      initial_fee_tvl_24h: p.initial_fee_tvl_24h,
      rebalance_count: p.rebalance_count,
      instruction: p.instruction || null,
    })),
    last_updated: state.lastUpdated,
    recent_events: (state.recentEvents || []).slice(-10),
  };
}

/**
 * Check all exit conditions for a position (trailing TP, stop loss, OOR, low yield).
 * Updates peak_pnl_pct, trailing_active, and OOR state.
 * @param {string} position_address
 * @param {object} positionData - fields from getMyPositions: pnl_pct, in_range, fee_per_tvl_24h
 * @param {object} mgmtConfig
 * Returns { action, reason } or null if no exit needed.
 */
export function updatePnlAndCheckExits(position_address, positionData, mgmtConfig) {
  const { pnl_pct: currentPnlPct, pnl_pct_suspicious, in_range, fee_per_tvl_24h } = positionData;
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || pos.closed) return null;
  let changed = false;

  // An unready receipt pauses only PnL-derived state and exits. Range status
  // comes from position/bin accounts and remains independently actionable.
  const pnlBasisUnready = hasNonReadyStatusBearingBasis(pos);
  if (pnlBasisUnready) changed = clearPendingPnlSignals(pos) || changed;

  // Activate trailing TP once trigger threshold is reached
  if (!pnlBasisUnready && mgmtConfig.trailingTakeProfit && !pos.trailing_active && (pos.peak_pnl_pct ?? 0) >= mgmtConfig.trailingTriggerPct) {
    pos.trailing_active = true;
    changed = true;
    log("state", `Position ${position_address} trailing TP activated (confirmed peak: ${pos.peak_pnl_pct}%)`);
  }

  // Update OOR state
  if (in_range === false && !pos.out_of_range_since) {
    pos.out_of_range_since = new Date().toISOString();
    changed = true;
    log("state", `Position ${position_address} marked out of range`);
  } else if (in_range === true && pos.out_of_range_since) {
    pos.out_of_range_since = null;
    changed = true;
    log("state", `Position ${position_address} back in range`);
  }

  if ((pos.peak_pnl_pct ?? 0) > 0 && !pos.peak_pnl_confirmed_at) {
    pos.peak_pnl_confirmed_at = new Date().toISOString();
    changed = true;
  }

  if (changed) save(state);

  if (mgmtConfig.netExitPolicyEnabled !== false) {
    const baselineExit = checkBaselineNetExit(position_address, positionData, pos, mgmtConfig);
    // The baseline helper also maintains low-yield confirmation state.
    save(state);
    return baselineExit;
  }

  if (pnlBasisUnready) {
    if (pos.out_of_range_since) {
      const minutesOOR = Math.floor((Date.now() - new Date(pos.out_of_range_since).getTime()) / 60000);
      if (minutesOOR >= mgmtConfig.outOfRangeWaitMinutes) {
        return {
          action: "OUT_OF_RANGE",
          reason: `Out of range for ${minutesOOR}m (limit: ${mgmtConfig.outOfRangeWaitMinutes}m)`,
        };
      }
    }
    return null;
  }

  const ageMinutes = positionData.age_minutes;
  let effectiveStopLossPct = mgmtConfig.stopLossPct;
  let effectiveStopReason = "Stop loss";
  if (
    mgmtConfig.dynamicStopLossEnabled &&
    !pnl_pct_suspicious &&
    currentPnlPct != null &&
    (ageMinutes == null || ageMinutes >= (mgmtConfig.dynamicStopMinAgeMinutes ?? 10)) &&
    (pos.peak_pnl_pct ?? 0) >= (mgmtConfig.breakevenTriggerPct ?? 1)
  ) {
    effectiveStopLossPct = Math.max(
      Number(mgmtConfig.dynamicStopBasePct ?? mgmtConfig.stopLossPct ?? -50),
      Number(mgmtConfig.breakevenStopPct ?? 0.5),
    );
    effectiveStopReason = `Dynamic SL: peak ${(pos.peak_pnl_pct ?? 0).toFixed(2)}% >= ${mgmtConfig.breakevenTriggerPct ?? 1}%`;
  }

  // ── Stop loss / dynamic stop-loss ──────────────────────────────
  if (!pnl_pct_suspicious && currentPnlPct != null && effectiveStopLossPct != null && currentPnlPct <= effectiveStopLossPct) {
    return {
      action: "STOP_LOSS",
      reason: `${effectiveStopReason}: PnL ${currentPnlPct.toFixed(2)}% <= ${effectiveStopLossPct}%`,
    };
  }

  // ── Profit protection / retrace exits ──────────────────────────
  if (!pnl_pct_suspicious && currentPnlPct != null) {
    const peakPnlPct = configNumber(pos.peak_pnl_pct, 0);
    const profitFloorPct = costAwareProfitFloor(mgmtConfig);

    if (mgmtConfig.microProfitProtectEnabled !== false) {
      const microPeakTriggerPct = configNumber(mgmtConfig.microProfitPeakTriggerPct, 0.5);
      const microRetracePct = configNumber(mgmtConfig.microProfitRetracePct, 45);
      const microMinCurrentPct = Math.max(
        configNumber(mgmtConfig.microProfitMinCurrentPct, 0.05),
        profitFloorPct,
      );
      const microMinAgeMinutes = configNumber(mgmtConfig.microProfitMinAgeMinutes, 8);
      if (
        peakPnlPct >= microPeakTriggerPct &&
        peakPnlPct > 0 &&
        (ageMinutes == null || ageMinutes >= microMinAgeMinutes)
      ) {
        const retracePct = ((peakPnlPct - currentPnlPct) / peakPnlPct) * 100;
        if (currentPnlPct >= microMinCurrentPct && retracePct >= microRetracePct) {
          return {
            action: "MICRO_PROFIT_PROTECT",
            reason: `Micro profit protect: peak ${peakPnlPct.toFixed(2)}% retraced ${retracePct.toFixed(2)}% >= ${microRetracePct}% while current ${currentPnlPct.toFixed(2)}% >= ${microMinCurrentPct}%`,
          };
        }
      }
    }

    if (mgmtConfig.peakDecayCloseEnabled !== false) {
      const peakDecayMinPeakPct = configNumber(mgmtConfig.peakDecayMinPeakPct, 0.4);
      const peakDecayMinDropPct = configNumber(mgmtConfig.peakDecayMinDropPct, 0.25);
      const peakDecayMinCurrentPct = Math.max(
        configNumber(mgmtConfig.peakDecayMinCurrentPct, 0.02),
        profitFloorPct,
      );
      const peakDecayMinutes = configNumber(mgmtConfig.peakDecayMinutes, 12);
      const peakDecayMaxFeePerTvl24h = configNumber(
        mgmtConfig.peakDecayMaxFeePerTvl24h,
        configNumber(mgmtConfig.minFeePerTvl24h, 3),
      );
      const minutesSincePeak = minutesSinceIso(pos.peak_pnl_confirmed_at);
      const dropFromPeakPct = peakPnlPct - currentPnlPct;
      if (
        peakPnlPct >= peakDecayMinPeakPct &&
        minutesSincePeak != null &&
        minutesSincePeak >= peakDecayMinutes &&
        dropFromPeakPct >= peakDecayMinDropPct &&
        currentPnlPct >= peakDecayMinCurrentPct &&
        fee_per_tvl_24h != null &&
        fee_per_tvl_24h <= peakDecayMaxFeePerTvl24h
      ) {
        return {
          action: "PEAK_DECAY_CLOSE",
          reason: `Peak decay close: peak ${peakPnlPct.toFixed(2)}% was ${minutesSincePeak}m ago, current ${currentPnlPct.toFixed(2)}%, drop ${dropFromPeakPct.toFixed(2)}% >= ${peakDecayMinDropPct}%, fee/TVL ${fee_per_tvl_24h.toFixed(2)}% <= ${peakDecayMaxFeePerTvl24h}%`,
        };
      }
    }

    if (mgmtConfig.profitStallCloseEnabled !== false) {
      const profitStallMinPeakPct = configNumber(mgmtConfig.profitStallMinPeakPct, 0.55);
      const profitStallMinCurrentPct = Math.max(
        configNumber(mgmtConfig.profitStallMinCurrentPct, 0.35),
        profitFloorPct,
      );
      const profitStallMinutes = configNumber(mgmtConfig.profitStallMinutes, 6);
      const profitStallMaxFeePerTvl24h = configNumber(
        mgmtConfig.profitStallMaxFeePerTvl24h,
        configNumber(mgmtConfig.minFeePerTvl24h, 3),
      );
      const minutesSincePeak = minutesSinceIso(pos.peak_pnl_confirmed_at);
      if (
        peakPnlPct >= profitStallMinPeakPct &&
        currentPnlPct >= profitStallMinCurrentPct &&
        minutesSincePeak != null &&
        minutesSincePeak >= profitStallMinutes &&
        fee_per_tvl_24h != null &&
        fee_per_tvl_24h <= profitStallMaxFeePerTvl24h
      ) {
        return {
          action: "PROFIT_STALL_CLOSE",
          reason: `Profit stall close: peak ${peakPnlPct.toFixed(2)}% has not improved for ${minutesSincePeak}m, current ${currentPnlPct.toFixed(2)}% >= ${profitStallMinCurrentPct}%, fee/TVL ${fee_per_tvl_24h.toFixed(2)}% <= ${profitStallMaxFeePerTvl24h}%`,
        };
      }
    }

    const profitProtectTriggerPct = Number(mgmtConfig.profitProtectTriggerPct ?? 2.0);
    const profitProtectStopPct = Number(mgmtConfig.profitProtectStopPct ?? 1.0);
    if (peakPnlPct >= profitProtectTriggerPct && currentPnlPct <= profitProtectStopPct) {
      return {
        action: "PROFIT_PROTECT",
        reason: `Profit protect: peak ${peakPnlPct.toFixed(2)}% >= ${profitProtectTriggerPct}% and current ${currentPnlPct.toFixed(2)}% <= ${profitProtectStopPct}%`,
      };
    }

    const retraceCloseTriggerPct = Number(mgmtConfig.retraceCloseTriggerPct ?? 1.5);
    const retraceClosePct = Number(mgmtConfig.retraceClosePct ?? 50);
    if (peakPnlPct >= retraceCloseTriggerPct && peakPnlPct > 0) {
      const retracePct = ((peakPnlPct - currentPnlPct) / peakPnlPct) * 100;
      if (retracePct >= retraceClosePct) {
        return {
          action: "RETRACE_CLOSE",
          reason: `Retrace close: peak ${peakPnlPct.toFixed(2)}% retraced ${retracePct.toFixed(2)}% >= ${retraceClosePct}% (current ${currentPnlPct.toFixed(2)}%)`,
        };
      }
    }
  }

  // ── Trailing TP ────────────────────────────────────────────────
  if (!pnl_pct_suspicious && pos.trailing_active) {
    const dropFromPeak = pos.peak_pnl_pct - currentPnlPct;
    if (dropFromPeak >= mgmtConfig.trailingDropPct) {
      return {
        action: "TRAILING_TP",
        reason: `Trailing TP: peak ${pos.peak_pnl_pct.toFixed(2)}% → current ${currentPnlPct.toFixed(2)}% (dropped ${dropFromPeak.toFixed(2)}% >= ${mgmtConfig.trailingDropPct}%)`,
        needs_confirmation: true,
        peak_pnl_pct: pos.peak_pnl_pct,
        current_pnl_pct: currentPnlPct,
        drop_from_peak_pct: dropFromPeak,
      };
    }
  }

  // ── Out of range too long ──────────────────────────────────────
  if (pos.out_of_range_since) {
    const minutesOOR = Math.floor((Date.now() - new Date(pos.out_of_range_since).getTime()) / 60000);
    if (minutesOOR >= mgmtConfig.outOfRangeWaitMinutes) {
      return {
        action: "OUT_OF_RANGE",
        reason: `Out of range for ${minutesOOR}m (limit: ${mgmtConfig.outOfRangeWaitMinutes}m)`,
      };
    }
  }

  // ── Low yield (only after position has had time to accumulate fees) ───
  const { age_minutes } = positionData;
  const minAgeForYieldCheck = mgmtConfig.minAgeBeforeYieldCheck ?? 60;
  if (
    fee_per_tvl_24h != null &&
    mgmtConfig.minFeePerTvl24h != null &&
    fee_per_tvl_24h < mgmtConfig.minFeePerTvl24h &&
    (age_minutes == null || age_minutes >= minAgeForYieldCheck)
  ) {
    return {
      action: "LOW_YIELD",
      reason: `Low yield: fee/TVL ${fee_per_tvl_24h.toFixed(2)}% < min ${mgmtConfig.minFeePerTvl24h}% (age: ${age_minutes ?? "?"}m)`,
    };
  }

  // ── Dead position / low-productivity timeout ───────────────────
  if (!pnl_pct_suspicious && currentPnlPct != null && age_minutes != null) {
    const peakPnlPct = pos.peak_pnl_pct ?? 0;
    const dead1Minutes = Number(mgmtConfig.deadPositionCheck1Minutes ?? 90);
    const dead1MaxPeakPct = Number(mgmtConfig.deadPositionCheck1MaxPeakPct ?? 0.5);
    const dead1MaxCurrentPct = Number(mgmtConfig.deadPositionCheck1MaxCurrentPct ?? dead1MaxPeakPct);
    const dead1MaxFeePerTvl24h = Number(mgmtConfig.deadPositionCheck1MaxFeePerTvl24h ?? mgmtConfig.minFeePerTvl24h ?? 3);
    const weakCurrentPnl = currentPnlPct <= dead1MaxCurrentPct;
    const weakYield = fee_per_tvl_24h == null || fee_per_tvl_24h <= dead1MaxFeePerTvl24h;
    if (age_minutes >= dead1Minutes && peakPnlPct < dead1MaxPeakPct && weakCurrentPnl && weakYield) {
      return {
        action: "DEAD_POSITION",
        reason: `Dead position: age ${age_minutes}m >= ${dead1Minutes}m, peak ${peakPnlPct.toFixed(2)}% < ${dead1MaxPeakPct}%, current ${currentPnlPct.toFixed(2)}% <= ${dead1MaxCurrentPct}%, fee/TVL ${fee_per_tvl_24h == null ? "n/a" : `${fee_per_tvl_24h.toFixed(2)}%`} <= ${dead1MaxFeePerTvl24h}%`,
      };
    }

    const dead2Minutes = Number(mgmtConfig.deadPositionCheck2Minutes ?? 120);
    const dead2MaxPeakPct = Number(mgmtConfig.deadPositionCheck2MaxPeakPct ?? 0.8);
    if (age_minutes >= dead2Minutes && peakPnlPct < dead2MaxPeakPct) {
      return {
        action: "DEAD_POSITION",
        reason: `Dead position: age ${age_minutes}m >= ${dead2Minutes}m and peak ${peakPnlPct.toFixed(2)}% < ${dead2MaxPeakPct}%`,
      };
    }
  }

  return null;
}

// ─── Briefing Tracking ─────────────────────────────────────────

/**
 * Get the date (YYYY-MM-DD UTC) when the last briefing was sent.
 */
export function getLastBriefingDate() {
  const state = load();
  return state._lastBriefingDate || null;
}

/**
 * Record that the briefing was sent today.
 */
export function setLastBriefingDate() {
  const state = load();
  state._lastBriefingDate = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
  save(state);
}

/**
 * Reconcile local state with actual on-chain positions.
 * Marks any local open positions as closed if they are not in the on-chain list.
 */
const SYNC_GRACE_MS = 5 * 60_000; // don't auto-close positions deployed < 5 min ago

export function syncOpenPositions(active_addresses) {
  const state = load();
  const activeSet = new Set(active_addresses);
  let changed = false;

  for (const posId in state.positions) {
    const pos = state.positions[posId];
    if (pos.closed || activeSet.has(posId)) continue;

    // Grace period: newly deployed positions may not be indexed yet
    const deployedAt = pos.deployed_at ? new Date(pos.deployed_at).getTime() : 0;
    if (Date.now() - deployedAt < SYNC_GRACE_MS) {
      log("state", `Position ${posId} not on-chain yet — within grace period, skipping auto-close`);
      continue;
    }

    pos.closed = true;
    pos.closed_at = new Date().toISOString();
    pos.notes.push(`Auto-closed during state sync (not found on-chain)`);
    changed = true;
    log("state", `Position ${posId} auto-closed (missing from on-chain data)`);
  }

  if (changed) save(state);
}
