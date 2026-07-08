/**
 * Persistent agent state — stored in state.json.
 *
 * Tracks position metadata that isn't available on-chain:
 * - When a position was deployed
 * - Strategy and bin config used
 * - When it first went out of range
 * - Actions taken (claims, rebalances)
 */

import fs from "fs";
import { log } from "./logger.js";
import { repoPath } from "./repo-root.js";

const STATE_FILE = repoPath("state.json");

const MAX_RECENT_EVENTS = 20;
const MAX_INSTRUCTION_LENGTH = 280;

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

function save(state) {
  try {
    state.lastUpdated = new Date().toISOString();
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    log("state_error", `Failed to write state.json: ${err.message}`);
  }
}

// ─── Position Registry ─────────────────────────────────────────

/**
 * Record a newly deployed position.
 */
export function trackPosition({
  position,
  pool,
  pool_name,
  strategy,
  bin_range = {},
  amount_sol,
  amount_x = 0,
  layers = null,
  active_bin,
  bin_step,
  volatility,
  fee_tvl_ratio,
  organic_score,
  initial_value_usd,
  signal_snapshot = null,
  entry_mcap = null,
  entry_tvl = null,
  entry_volume = null,
  entry_holders = null,
  notes = [],
}) {
  const state = load();
  state.positions[position] = {
    position,
    pool,
    pool_name,
    strategy,
    bin_range,
    amount_sol,
    amount_x,
    layers,
    active_bin_at_deploy: active_bin,
    bin_step,
    volatility,
    fee_tvl_ratio,
    initial_fee_tvl_24h: fee_tvl_ratio,
    organic_score,
    initial_value_usd,
    entry_mcap,
    entry_tvl,
    entry_volume,
    entry_holders,
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
  strategy,
  bin_range = {},
  amount_sol,
  amount_x = 0,
  layers = null,
  active_bin,
  bin_step,
  volatility,
  fee_tvl_ratio,
  organic_score,
  initial_value_usd,
  active_price,
  min_price,
  max_price,
  downside_coverage_pct,
  upside_coverage_pct,
  total_width_pct,
  notes = [],
}) {
  const state = load();
  if (!state.paperPositions) state.paperPositions = {};
  const paperId = `paper:${pool}:${Date.now()}`;
  state.paperPositions[paperId] = {
    paper: true,
    position: paperId,
    pool,
    pool_name,
    strategy,
    bin_range,
    amount_sol,
    amount_x,
    layers,
    active_bin_at_deploy: active_bin,
    bin_step,
    volatility,
    fee_tvl_ratio,
    initial_fee_tvl_24h: fee_tvl_ratio,
    organic_score,
    initial_value_usd,
    active_price_at_deploy: active_price,
    min_price,
    max_price,
    downside_coverage_pct,
    upside_coverage_pct,
    total_width_pct,
    deployed_at: new Date().toISOString(),
    last_observed_at: null,
    last_active_bin: null,
    last_active_price: null,
    in_range: null,
    price_change_pct: null,
    notes: Array.isArray(notes) ? notes.map((note) => sanitizeStoredText(note)).filter(Boolean) : [],
  };
  pushEvent(state, { action: "paper_deploy", position: paperId, pool_name: pool_name || pool });
  save(state);
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
export function registerExitSignal(position_address, signal, confirmTicks = 2) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || pos.closed) return { fire: false, action: null, count: 0 };

  if (!signal) {
    if (pos.pending_exit_action != null) {
      pos.pending_exit_action = null;
      pos.pending_exit_count = 0;
      save(state);
    }
    return { fire: false, action: null, count: 0 };
  }

  if (pos.pending_exit_action === signal) {
    pos.pending_exit_count = (pos.pending_exit_count ?? 1) + 1;
  } else {
    pos.pending_exit_action = signal;
    pos.pending_exit_count = 1;
    pos.pending_exit_started_at = new Date().toISOString();
  }

  const count = pos.pending_exit_count;
  const fire = count >= confirmTicks;
  if (fire) {
    pos.pending_exit_action = null;
    pos.pending_exit_count = 0;
    pos.pending_exit_started_at = null;
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

function positiveNumber(value) {
  const n = finiteNumber(value);
  return n != null && n > 0 ? n : null;
}

function minutesSinceIso(iso) {
  if (!iso) return null;
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return null;
  return Math.max(0, Math.floor((Date.now() - ts) / 60000));
}

function paperPriceScaleWarning(entryPrice, currentPrice) {
  if (entryPrice == null || currentPrice == null) return null;
  const hi = Math.max(entryPrice, currentPrice);
  const lo = Math.min(entryPrice, currentPrice);
  if (lo <= 0) return "invalid_price";
  const ratio = hi / lo;
  return ratio >= 100 ? `price_scale_mismatch:${Math.round(ratio * 100) / 100}x` : null;
}

export function updatePaperPositionObservation(position, observation) {
  const state = load();
  const pos = state.paperPositions?.[position];
  if (!pos) return null;
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
  const priceScaleWarning = paperPriceScaleWarning(entryPrice, currentPrice);
  const priceChangePct = entryBin != null && currentBin != null && binStep != null
    ? (Math.pow(1 + binStep / 10000, currentBin - entryBin) - 1) * 100
    : !priceScaleWarning && entryPrice != null && currentPrice != null
      ? ((currentPrice - entryPrice) / entryPrice) * 100
      : null;
  const binDistance = status === "out_above" ? currentBin - maxBin : status === "out_below" ? minBin - currentBin : 0;
  pos.last_observed_at = new Date().toISOString();
  pos.last_active_bin = currentBin;
  pos.last_active_price = currentPrice;
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
  if (!pos.observations) pos.observations = [];
  pos.observations.push({
    ts: pos.last_observed_at,
    active_bin: currentBin,
    active_price: currentPrice,
    in_range: inRange,
    status,
    price_change_pct: pos.price_change_pct,
    price_change_source: pos.price_change_source,
    price_scale_warning: pos.price_scale_warning,
    bin_distance_to_range: pos.bin_distance_to_range,
  });
  pos.observations = pos.observations.slice(-96);
  pushEvent(state, { action: "paper_observe", position, status, price_change_pct: pos.price_change_pct, price_change_source: pos.price_change_source, price_scale_warning: pos.price_scale_warning });
  save(state);
  return pos;
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

  // Activate trailing TP once trigger threshold is reached
  if (mgmtConfig.trailingTakeProfit && !pos.trailing_active && (pos.peak_pnl_pct ?? 0) >= mgmtConfig.trailingTriggerPct) {
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

    if (mgmtConfig.microProfitProtectEnabled !== false) {
      const microPeakTriggerPct = configNumber(mgmtConfig.microProfitPeakTriggerPct, 0.5);
      const microRetracePct = configNumber(mgmtConfig.microProfitRetracePct, 45);
      const microMinCurrentPct = configNumber(mgmtConfig.microProfitMinCurrentPct, 0.05);
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
      const peakDecayMinCurrentPct = configNumber(mgmtConfig.peakDecayMinCurrentPct, 0.02);
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
    if (age_minutes >= dead1Minutes && peakPnlPct < dead1MaxPeakPct) {
      return {
        action: "DEAD_POSITION",
        reason: `Dead position: age ${age_minutes}m >= ${dead1Minutes}m and peak ${peakPnlPct.toFixed(2)}% < ${dead1MaxPeakPct}%`,
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
