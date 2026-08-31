/**
 * Pool memory — persistent deploy history per pool.
 *
 * Keyed by pool address. Automatically updated when positions close
 * (via recordPerformance in lessons.js). Agent can query before deploying.
 */

import fs from "fs";
import { log } from "./logger.js";
import { config } from "./config.js";

import { repoPath } from "./repo-root.js";

const POOL_MEMORY_FILE = process.env.MERIDIAN_POOL_MEMORY_FILE || repoPath("pool-memory.json");
const MAX_NOTE_LENGTH = 280;
const LEGACY_STOP_COOLDOWN_REASON = "bad outcome: stop loss";

function sanitizeStoredNote(text, maxLen = MAX_NOTE_LENGTH) {
  if (text == null) return null;
  const cleaned = String(text)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[<>`]/g, "")
    .trim()
    .slice(0, maxLen);
  return cleaned || null;
}

function load(filePath = POOL_MEMORY_FILE) {
  if (!fs.existsSync(filePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return {};
  }
}

function save(data, filePath = POOL_MEMORY_FILE) {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filePath);
}

function isOorCloseReason(reason) {
  const text = String(reason || "").trim().toLowerCase();
  return text === "oor" || text.includes("out of range") || text.includes("oor");
}

function isAdjustedWinRateExcludedReason(reason) {
  const text = String(reason || "").trim().toLowerCase();
  return text.includes("out of range") ||
    text.includes("pumped far above range") ||
    text === "oor" ||
    text.includes("oor");
}

function isFeeGeneratingDeploy(deploy, management = config.management) {
  const minFeeEarnedPct = Number(management.repeatDeployCooldownMinFeeEarnedPct ?? 0);
  const feeEarnedPct = Number(deploy.fee_earned_pct ?? 0);
  const feesUsd = Number(deploy.fees_earned_usd ?? 0);
  const feesSol = Number(deploy.fees_earned_sol ?? 0);
  const hasFees = (Number.isFinite(feesUsd) && feesUsd > 0) || (Number.isFinite(feesSol) && feesSol > 0);
  if (!hasFees) return false;
  return Number.isFinite(feeEarnedPct) && feeEarnedPct >= minFeeEarnedPct;
}

function cooldownScope(value, fallback = "token") {
  const scope = String(value || fallback).trim().toLowerCase();
  return ["pool", "token", "both"].includes(scope) ? scope : fallback;
}

function isLowYieldCloseReason(reason) {
  return String(reason || "").toLowerCase().includes("low yield");
}

export function isStopLossCloseReason(reason) {
  const text = String(reason || "").toLowerCase();
  return text.includes("stop loss") ||
    text.includes("fee thesis failed") ||
    text.includes("thesis_failure");
}

export function cleanNetPnlPct(deploy) {
  if (deploy.position_sol_deployed == null || deploy.wallet_sol_roundtrip_delta_after_autoswap == null) {
    return null;
  }
  const deployed = Number(deploy.position_sol_deployed);
  const walletDelta = Number(deploy.wallet_sol_roundtrip_delta_after_autoswap);
  if (!Number.isFinite(deployed) || deployed <= 0 || !Number.isFinite(walletDelta)) return null;
  const netPct = (walletDelta / deployed) * 100;
  const grossPct = Number(deploy.position_sol_pnl_pct ?? deploy.pnl_pct);
  const maxDiffPct = Math.max(0, Number(config.management.poolMemoryMaxNetPnlDiffPct ?? 3));
  if (Number.isFinite(grossPct) && Math.abs(netPct - grossPct) > maxDiffPct) return null;
  return netPct;
}

export function recomputeAggregates(entry) {
  const withPnl = entry.deploys.filter((d) => d.pnl_pct != null);
  if (withPnl.length > 0) {
    entry.avg_pnl_pct = Math.round(
      (withPnl.reduce((s, d) => s + d.pnl_pct, 0) / withPnl.length) * 100
    ) / 100;
    entry.win_rate = Math.round(
      (withPnl.filter((d) => d.pnl_pct >= 0).length / withPnl.length) * 10000
    ) / 100;
  }

  const adjusted = withPnl.filter((d) => !isAdjustedWinRateExcludedReason(d.close_reason));
  entry.adjusted_win_rate_sample_count = adjusted.length;
  entry.adjusted_win_rate = adjusted.length > 0
    ? Math.round((adjusted.filter((d) => d.pnl_pct >= 0).length / adjusted.length) * 10000) / 100
    : 0;

  const recentNet = entry.deploys.slice(-10)
    .map((deploy) => ({ deploy, netPct: cleanNetPnlPct(deploy) }))
    .filter((item) => item.netPct != null);
  entry.recent_net_sample_count = recentNet.length;
  entry.recent_net_avg_pct = recentNet.length > 0
    ? Math.round((recentNet.reduce((sum, item) => sum + item.netPct, 0) / recentNet.length) * 100) / 100
    : null;
  entry.recent_net_win_rate = recentNet.length > 0
    ? Math.round((recentNet.filter((item) => item.netPct > 0).length / recentNet.length) * 10000) / 100
    : null;

  const latest = entry.deploys.at(-1);
  if (latest) {
    const latestNetPct = cleanNetPnlPct(latest);
    entry.last_outcome = isLowYieldCloseReason(latest.close_reason)
      ? "low_yield"
      : (latestNetPct ?? Number(latest.pnl_pct ?? 0)) > 0 ? "profit" : "loss";
  }
}

export function getPoolMemoryPolicy(entry, now = Date.now()) {
  const activePoolCooldown = entry?.cooldown_until && Date.parse(entry.cooldown_until) > now;
  const activeTokenCooldown = entry?.base_mint_cooldown_until && Date.parse(entry.base_mint_cooldown_until) > now;
  if (activePoolCooldown || activeTokenCooldown) {
    return "MEMORY POLICY: active cooldown is a hard block.";
  }
  return "MEMORY POLICY: no active cooldown; historical low-yield/OOR outcomes are advisory only. Judge the new entry on current clean-net evidence, fee/TVL, volume, and momentum.";
}

function setPoolCooldown(entry, hours, reason, nowMs = Date.now()) {
  const cooldownUntil = new Date(nowMs + hours * 60 * 60 * 1000).toISOString();
  const existingUntilMs = Date.parse(entry.cooldown_until);
  if (!Number.isFinite(existingUntilMs) || existingUntilMs < Date.parse(cooldownUntil)) {
    entry.cooldown_until = cooldownUntil;
    entry.cooldown_reason = reason;
  }
  return entry.cooldown_until;
}

function setBaseMintCooldown(db, baseMint, hours, reason, nowMs = Date.now()) {
  if (!baseMint) return null;
  const cooldownUntil = new Date(nowMs + hours * 60 * 60 * 1000).toISOString();
  let longestUntil = cooldownUntil;
  for (const entry of Object.values(db)) {
    if (entry?.base_mint === baseMint) {
      const existingUntilMs = Date.parse(entry.base_mint_cooldown_until);
      if (!Number.isFinite(existingUntilMs) || existingUntilMs < Date.parse(cooldownUntil)) {
        entry.base_mint_cooldown_until = cooldownUntil;
        entry.base_mint_cooldown_reason = reason;
      }
      if (Date.parse(entry.base_mint_cooldown_until) > Date.parse(longestUntil)) {
        longestUntil = entry.base_mint_cooldown_until;
      }
    }
  }
  return longestUntil;
}

function setScopedCooldown(db, entry, hours, reason, scope, nowMs = Date.now()) {
  const cooldownHours = Math.max(0, Number(hours ?? 0));
  if (cooldownHours <= 0) return;

  const resolvedScope = cooldownScope(scope, "token");
  if (resolvedScope === "pool" || resolvedScope === "both" || !entry.base_mint) {
    const poolCooldownUntil = setPoolCooldown(entry, cooldownHours, reason, nowMs);
    log("pool-memory", `Cooldown set for ${entry.name} until ${poolCooldownUntil} (${reason})`);
  }
  if ((resolvedScope === "token" || resolvedScope === "both") && entry.base_mint) {
    const mintCooldownUntil = setBaseMintCooldown(db, entry.base_mint, cooldownHours, reason, nowMs);
    if (mintCooldownUntil) {
      log("pool-memory", `Base mint cooldown set for ${entry.base_mint.slice(0, 8)} until ${mintCooldownUntil} (${reason})`);
    }
  }
}

function reconcileLegacyTokenStopCooldown(db, entry, {
  cooldownUntil = null,
  cooldownReason = null,
} = {}) {
  if (!entry?.base_mint || entry.base_mint_cooldown_reason !== LEGACY_STOP_COOLDOWN_REASON) {
    return false;
  }
  const linkedUntil = entry.base_mint_cooldown_until;
  let changed = false;
  for (const candidate of Object.values(db)) {
    if (
      candidate?.base_mint === entry.base_mint &&
      candidate.base_mint_cooldown_reason === LEGACY_STOP_COOLDOWN_REASON &&
      candidate.base_mint_cooldown_until === linkedUntil
    ) {
      if (cooldownUntil && cooldownReason) {
        candidate.base_mint_cooldown_until = cooldownUntil;
        candidate.base_mint_cooldown_reason = cooldownReason;
      } else {
        delete candidate.base_mint_cooldown_until;
        delete candidate.base_mint_cooldown_reason;
      }
      changed = true;
    }
  }
  return changed;
}

function reconcileAuthoritativeSettlementCooldown(db, entry, deploy, management, nowMs) {
  if (deploy?.authoritative_settlement !== true || !isStopLossCloseReason(deploy.close_reason)) {
    return false;
  }
  const latest = entry?.deploys?.at(-1);
  if (!latest || latest.settlement_id !== deploy.settlement_id) return false;

  const netPct = Number(deploy.position_sol_pnl_pct ?? deploy.pnl_pct);
  if (!Number.isFinite(netPct)) return false;
  const smallLossFloorPct = Math.min(0, Number(management.settlementSmallLossFloorPct ?? -0.75));
  const isSmallLoss = netPct < 0 && netPct >= smallLossFloorPct;
  const isNonLoss = netPct >= 0;
  if (!isSmallLoss && !isNonLoss) return false;

  let changed = false;
  if (isNonLoss) {
    changed = reconcileLegacyTokenStopCooldown(db, entry) || changed;
    if (entry.cooldown_reason === LEGACY_STOP_COOLDOWN_REASON) {
      delete entry.cooldown_until;
      delete entry.cooldown_reason;
      changed = true;
    }
    return changed;
  }

  const cooldownMinutes = Math.max(0, Number(management.settlementSmallLossCooldownMinutes ?? 60));
  const scope = cooldownScope(management.settlementSmallLossCooldownScope, "pool");
  const expectedUntil = new Date(nowMs + cooldownMinutes * 60_000).toISOString();
  const expectedReason = `small authoritative stop ${netPct.toFixed(3)}%`;
  const poolScoped = scope === "pool" || scope === "both" || !entry.base_mint;
  const tokenScoped = (scope === "token" || scope === "both") && entry.base_mint;
  changed = reconcileLegacyTokenStopCooldown(db, entry, tokenScoped ? {
    cooldownUntil: expectedUntil,
    cooldownReason: expectedReason,
  } : {}) || changed;
  const replaceablePoolCooldown = !entry.cooldown_until ||
    entry.cooldown_reason === LEGACY_STOP_COOLDOWN_REASON ||
    String(entry.cooldown_reason || "").startsWith("small authoritative stop ");
  if (poolScoped && replaceablePoolCooldown && (
    entry.cooldown_until !== expectedUntil || entry.cooldown_reason !== expectedReason
  )) {
    entry.cooldown_until = expectedUntil;
    entry.cooldown_reason = expectedReason;
    changed = true;
  } else if (!poolScoped && replaceablePoolCooldown && entry.cooldown_until) {
    delete entry.cooldown_until;
    delete entry.cooldown_reason;
    changed = true;
  }
  if (
    deploy.cooldown?.scope !== scope ||
    deploy.cooldown?.minutes !== cooldownMinutes ||
    deploy.cooldown?.reason !== "small authoritative settled loss"
  ) {
    deploy.cooldown = {
      scope,
      minutes: cooldownMinutes,
      reason: "small authoritative settled loss",
    };
    changed = true;
  }
  return changed;
}

// ─── Write ─────────────────────────────────────────────────────

/**
 * Record a closed deploy into pool-memory.json.
 * Called automatically from recordPerformance() in lessons.js.
 *
 * @param {string} poolAddress
 * @param {Object} deployData
 * @param {string} deployData.pool_name
 * @param {string} deployData.base_mint
 * @param {string} deployData.deployed_at
 * @param {string} deployData.closed_at
 * @param {number} deployData.pnl_pct
 * @param {number} deployData.pnl_usd
 * @param {number} deployData.range_efficiency
 * @param {number} deployData.minutes_held
 * @param {string} deployData.close_reason
 * @param {string} deployData.strategy
 * @param {number} deployData.volatility
 */
export function recordPoolDeploy(poolAddress, deployData, {
  storagePath = POOL_MEMORY_FILE,
  nowMs = Date.now(),
  policy = {},
} = {}) {
  if (!poolAddress) return { recorded: false, reason: "pool address missing" };

  const db = load(storagePath);
  // Tests and recovery jobs can supply one deterministic policy snapshot, but
  // ordinary runtime callers continue to inherit the active management
  // policy. Keeping the snapshot local also prevents a settlement retry from
  // mutating global config.
  const management = { ...config.management, ...policy };

  if (!db[poolAddress]) {
    db[poolAddress] = {
      name: deployData.pool_name || poolAddress.slice(0, 8),
      base_mint: deployData.base_mint || null,
      deploys: [],
      total_deploys: 0,
      avg_pnl_pct: 0,
      win_rate: 0,
      adjusted_win_rate: 0,
      adjusted_win_rate_sample_count: 0,
      last_deployed_at: null,
      last_outcome: null,
      notes: [],
    };
  }

  const entry = db[poolAddress];
  if (deployData.base_mint && !entry.base_mint) entry.base_mint = deployData.base_mint;
  if (deployData.pool_name && (
    !entry.name || entry.name === poolAddress.slice(0, 8) || /^\?[/_-]/.test(entry.name)
  )) {
    entry.name = deployData.pool_name;
  }
  const settlementId = sanitizeStoredNote(deployData.settlement_id, 500);
  if (settlementId) {
    const existing = entry.deploys.find((item) => item.settlement_id === settlementId);
    if (existing) {
      const cooldownMigrated = reconcileAuthoritativeSettlementCooldown(
        db,
        entry,
        existing,
        management,
        nowMs,
      );
      if (cooldownMigrated) save(db, storagePath);
      return {
        recorded: false,
        duplicate: true,
        cooldown_migrated: cooldownMigrated,
        pool_address: poolAddress,
        deploy: existing,
      };
    }
  }
  // Adaptive mode may have written a provisional close record before wallet
  // cleanup established the authoritative settlement. Upgrade that same trade
  // in place instead of counting one position twice in pool quality history.
  const provisionalIndex = settlementId && deployData.position
    ? entry.deploys.findIndex((item) => (
        item.position === deployData.position && item.authoritative_settlement !== true
      ))
    : -1;
  const provisional = provisionalIndex >= 0 ? entry.deploys[provisionalIndex] : null;

  const deploy = {
    settlement_id: settlementId,
    settlement_source: deployData.settlement_source || null,
    authoritative_settlement: deployData.authoritative_settlement === true,
    position: deployData.position || null,
    deployed_at: deployData.deployed_at || null,
    closed_at: deployData.closed_at || new Date(nowMs).toISOString(),
    pnl_pct: deployData.pnl_pct ?? null,
    pnl_usd: deployData.pnl_usd ?? null,
    pnl_sol: deployData.pnl_sol ?? deployData.position_sol_pnl ?? null,
    fees_earned_usd: deployData.fees_earned_usd ?? null,
    fees_earned_sol: deployData.fees_earned_sol ?? null,
    position_sol_deployed: deployData.position_sol_deployed ?? null,
    position_sol_withdrawn: deployData.position_sol_withdrawn ?? null,
    position_sol_fees: deployData.position_sol_fees ?? null,
    position_sol_final: deployData.position_sol_final ?? null,
    position_sol_pnl: deployData.position_sol_pnl ?? deployData.pnl_sol ?? null,
    position_sol_pnl_pct: deployData.position_sol_pnl_pct ?? null,
    wallet_sol_before_deploy: deployData.wallet_sol_before_deploy ?? null,
    wallet_sol_after_deploy: deployData.wallet_sol_after_deploy ?? null,
    wallet_sol_before_close: deployData.wallet_sol_before_close ?? null,
    wallet_sol_after_close: deployData.wallet_sol_after_close ?? null,
    wallet_sol_roundtrip_delta: deployData.wallet_sol_roundtrip_delta ?? null,
    wallet_sol_after_autoswap: deployData.wallet_sol_after_autoswap ?? null,
    wallet_sol_roundtrip_delta_after_autoswap: deployData.wallet_sol_roundtrip_delta_after_autoswap ?? null,
    wallet_sol_close_delta_after_autoswap: deployData.wallet_sol_close_delta_after_autoswap ?? null,
    fee_earned_pct: deployData.fee_earned_pct ?? null,
    range_efficiency: deployData.range_efficiency ?? null,
    minutes_held: deployData.minutes_held ?? null,
    close_reason: deployData.close_reason || null,
    strategy: deployData.strategy || null,
    volatility_at_deploy: deployData.volatility ?? null,
    entry_mcap: deployData.entry_mcap ?? null,
    entry_tvl: deployData.entry_tvl ?? null,
    entry_volume: deployData.entry_volume ?? null,
    exit_mcap: deployData.exit_mcap ?? null,
    exit_tvl: deployData.exit_tvl ?? null,
    exit_volume: deployData.exit_volume ?? null,
  };
  if (provisional) {
    for (const [key, value] of Object.entries(provisional)) {
      if (deploy[key] == null && value != null) deploy[key] = value;
    }
  }

  if (provisionalIndex >= 0) entry.deploys.splice(provisionalIndex, 1, deploy);
  else entry.deploys.push(deploy);
  entry.total_deploys = entry.deploys.length;
  entry.last_deployed_at = deploy.closed_at;
  recomputeAggregates(entry);

  const authoritativeNetPct = deploy.authoritative_settlement
    ? Number(deploy.position_sol_pnl_pct ?? deploy.pnl_pct)
    : null;
  const smallLossFloorPct = Math.min(0, Number(management.settlementSmallLossFloorPct ?? -0.75));
  const isSmallSettledStop = Number.isFinite(authoritativeNetPct) &&
    authoritativeNetPct < 0 &&
    authoritativeNetPct >= smallLossFloorPct &&
    isStopLossCloseReason(deploy.close_reason);
  const isNonLossSettledOutcome = Number.isFinite(authoritativeNetPct) && authoritativeNetPct >= 0;
  const deferBadOutcomeCooldownToSettlement = config.ledger?.enabled === true &&
    Boolean(deploy.position) &&
    deploy.authoritative_settlement !== true;

  if (management.badOutcomeCooldownEnabled && !deferBadOutcomeCooldownToSettlement) {
    const scope = management.badOutcomeCooldownScope;
    if (isLowYieldCloseReason(deploy.close_reason)) {
      setScopedCooldown(
        db,
        entry,
        management.lowYieldCooldownHours,
        "bad outcome: low yield",
        scope,
        nowMs,
      );
    } else if (isNonLossSettledOutcome) {
      // The close trigger is diagnostic; authoritative settlement decides
      // whether the outcome deserves a loss cooldown.
    } else if (isSmallSettledStop) {
      const cooldownMinutes = Math.max(0, Number(management.settlementSmallLossCooldownMinutes ?? 60));
      const smallLossScope = cooldownScope(management.settlementSmallLossCooldownScope, "pool");
      setScopedCooldown(
        db,
        entry,
        cooldownMinutes / 60,
        `small authoritative stop ${authoritativeNetPct.toFixed(3)}%`,
        smallLossScope,
        nowMs,
      );
      deploy.cooldown = {
        scope: smallLossScope,
        minutes: cooldownMinutes,
        reason: "small authoritative settled loss",
      };
    } else if (isStopLossCloseReason(deploy.close_reason)) {
      setScopedCooldown(
        db,
        entry,
        management.stopLossCooldownHours,
        "bad outcome: stop loss",
        scope,
        nowMs,
      );
    }
  }

  const oorTriggerCount = management.oorCooldownTriggerCount ?? 3;
  const oorCooldownHours = management.oorCooldownHours ?? 12;
  const recentDeploys = entry.deploys.slice(-oorTriggerCount);
  const repeatedOorCloses =
    recentDeploys.length >= oorTriggerCount &&
    recentDeploys.every((d) => isOorCloseReason(d.close_reason));

  if (repeatedOorCloses) {
    const reason = `repeated OOR closes (${oorTriggerCount}x)`;
    const poolCooldownUntil = setPoolCooldown(entry, oorCooldownHours, reason, nowMs);
    const mintCooldownUntil = setBaseMintCooldown(db, entry.base_mint, oorCooldownHours, reason, nowMs);
    log("pool-memory", `Cooldown set for ${entry.name} until ${poolCooldownUntil} (${reason})`);
    if (entry.base_mint && mintCooldownUntil) {
      log("pool-memory", `Base mint cooldown set for ${entry.base_mint.slice(0, 8)} until ${mintCooldownUntil} (${reason})`);
    }
  }

  if (management.repeatDeployCooldownEnabled) {
    const triggerCount = Math.max(1, Number(management.repeatDeployCooldownTriggerCount ?? 3));
    const cooldownHours = Math.max(0, Number(management.repeatDeployCooldownHours ?? 12));
    const scope = cooldownScope(management.repeatDeployCooldownScope, "token");
    const recentRepeatDeploys = entry.deploys.slice(-triggerCount);
    const repeatedFeeGeneratingDeploys =
      cooldownHours > 0 &&
      recentRepeatDeploys.length >= triggerCount &&
      recentRepeatDeploys.every((d) => d.pnl_pct != null && isFeeGeneratingDeploy(d, management));

    if (repeatedFeeGeneratingDeploys) {
      const reason = `repeat fee-generating deploys (${triggerCount}x)`;
      if (scope === "pool" || scope === "both" || !entry.base_mint) {
        const poolCooldownUntil = setPoolCooldown(entry, cooldownHours, reason, nowMs);
        log("pool-memory", `Cooldown set for ${entry.name} until ${poolCooldownUntil} (${reason})`);
      }
      if ((scope === "token" || scope === "both") && entry.base_mint) {
        const mintCooldownUntil = setBaseMintCooldown(db, entry.base_mint, cooldownHours, reason, nowMs);
        if (mintCooldownUntil) {
          log("pool-memory", `Base mint cooldown set for ${entry.base_mint.slice(0, 8)} until ${mintCooldownUntil} (${reason})`);
        }
      }
    }
  }

  if (deploy.authoritative_settlement) {
    const netPct = authoritativeNetPct;
    const catastrophicStopPct = Number(management.catastrophicStopPct);
    const breakerSingleLossPct = Number(policy.breakerSingleLossPct ?? config.circuitBreaker.singleLossPct);
    const catastrophic = Number.isFinite(netPct) && (
      (Number.isFinite(catastrophicStopPct) && netPct <= catastrophicStopPct) ||
      (Number.isFinite(breakerSingleLossPct) && netPct < breakerSingleLossPct)
    );
    if (catastrophic) {
      const quarantineHours = Math.max(0, Number(
        management.catastrophicQuarantineHours ?? management.shadowRotationCatastrophicQuarantineHours ?? 168,
      ));
      const reason = `authoritative catastrophic settlement ${netPct.toFixed(2)}%: temporary execution-risk quarantine`;
      setScopedCooldown(db, entry, quarantineHours, reason, "both", nowMs);
      deploy.quarantine = {
        scope: "both",
        hours: quarantineHours,
        reason,
      };
    }
  }

  reconcileAuthoritativeSettlementCooldown(db, entry, deploy, management, nowMs);

  save(db, storagePath);
  log("pool-memory", `Recorded deploy for ${entry.name} (${poolAddress.slice(0, 8)}): PnL ${deploy.pnl_pct}%`);
  return { recorded: true, duplicate: false, pool_address: poolAddress, deploy };
}

function signedLamports(value, field) {
  const text = String(value ?? "");
  if (!/^-?\d+$/.test(text)) throw new TypeError(`${field} must be an integer lamport string`);
  return BigInt(text);
}

/**
 * Persist operational safety memory from the authoritative trade-ledger
 * settlement. This path is intentionally independent from adaptive learning,
 * which remains frozen during canary operation.
 */
export function recordSettledPoolOutcome({
  position,
  lifecycleId,
  settlementId,
  poolAddress,
  poolName = null,
  baseMint = null,
  strategy = null,
  closeReason = null,
  deployedAt = null,
  settledAt = null,
  basisLamports,
  walletEquityNetLamports,
} = {}, options = {}) {
  if (!position || !lifecycleId || !settlementId || !poolAddress) {
    throw new TypeError("Authoritative settlement outcome requires position, lifecycle, settlement, and pool identities");
  }
  const basis = signedLamports(basisLamports, "basisLamports");
  const net = signedLamports(walletEquityNetLamports, "walletEquityNetLamports");
  if (basis <= 0n) throw new RangeError("Authoritative settlement basis must be greater than zero");
  const deployedSol = Number(basis) / 1e9;
  const pnlSol = Number(net) / 1e9;
  const pnlPct = Math.round((Number(net) / Number(basis) * 100) * 1e8) / 1e8;
  const settledAtMs = Date.parse(settledAt);
  // A crash-safe startup replay may project a settlement hours or days after
  // it occurred. Anchor operational cooldowns to the authoritative settlement
  // time so replay cannot silently extend an expired quarantine from "now".
  const projectionOptions = Object.hasOwn(options, "nowMs")
    ? options
    : {
        ...options,
        nowMs: Number.isFinite(settledAtMs) ? settledAtMs : Date.now(),
      };
  return recordPoolDeploy(poolAddress, {
    position,
    pool_name: poolName,
    base_mint: baseMint,
    deployed_at: deployedAt,
    closed_at: settledAt,
    pnl_pct: pnlPct,
    pnl_sol: pnlSol,
    position_sol_deployed: deployedSol,
    position_sol_final: Math.max(0, deployedSol + pnlSol),
    position_sol_pnl: pnlSol,
    position_sol_pnl_pct: pnlPct,
    wallet_sol_roundtrip_delta_after_autoswap: pnlSol,
    close_reason: closeReason,
    strategy,
    settlement_id: `${lifecycleId}:${settlementId}`,
    settlement_source: "trade_ledger_wallet_equity_net",
    authoritative_settlement: true,
  }, projectionOptions);
}

export function updatePoolDeploySolMetrics(poolAddress, position, metrics = {}) {
  if (!poolAddress || !position) return false;
  const db = load();
  const entry = db[poolAddress];
  if (!entry?.deploys?.length) return false;
  const deploy = [...entry.deploys].reverse().find((item) => item.position === position);
  if (!deploy) return false;

  for (const [key, value] of Object.entries(metrics)) {
    if (value !== undefined) deploy[key] = value;
  }
  recomputeAggregates(entry);
  save(db);
  log("pool-memory", `Updated final SOL metrics for ${entry.name} (${position.slice(0, 8)})`);
  return true;
}

export function isPoolOnCooldown(poolAddress) {
  if (!poolAddress) return false;
  const db = load();
  const entry = db[poolAddress];
  if (!entry?.cooldown_until) return false;
  return new Date(entry.cooldown_until) > new Date();
}

export function isBaseMintOnCooldown(baseMint) {
  if (!baseMint) return false;
  const db = load();
  const now = new Date();
  return Object.values(db).some((entry) =>
    entry?.base_mint === baseMint &&
    entry?.base_mint_cooldown_until &&
    new Date(entry.base_mint_cooldown_until) > now
  );
}

export function setManualTokenCooldown({ pool_address, base_mint, name, hours, reason = "manual cooldown" } = {}) {
  const cooldownHours = Math.max(0, Number(hours ?? config.management.repeatDeployCooldownHours ?? 12));
  if (!base_mint && !pool_address) return { success: false, error: "base_mint or pool_address required" };

  const db = load();
  if (pool_address && !db[pool_address]) {
    db[pool_address] = {
      name: name || pool_address.slice(0, 8),
      base_mint: base_mint || null,
      deploys: [],
      total_deploys: 0,
      avg_pnl_pct: 0,
      win_rate: 0,
      adjusted_win_rate: 0,
      adjusted_win_rate_sample_count: 0,
      last_deployed_at: null,
      last_outcome: null,
      notes: [],
    };
  }
  if (pool_address && base_mint && !db[pool_address].base_mint) db[pool_address].base_mint = base_mint;

  const cooldownUntil = new Date(Date.now() + cooldownHours * 60 * 60 * 1000).toISOString();
  let updated = 0;
  for (const entry of Object.values(db)) {
    if ((base_mint && entry?.base_mint === base_mint) || (!base_mint && pool_address && entry === db[pool_address])) {
      entry.base_mint_cooldown_until = cooldownUntil;
      entry.base_mint_cooldown_reason = reason;
      updated += 1;
    }
  }
  if (pool_address && db[pool_address]) {
    db[pool_address].cooldown_until = cooldownUntil;
    db[pool_address].cooldown_reason = reason;
    updated += 1;
  }
  save(db);
  log("pool-memory", `Manual token cooldown set for ${base_mint || pool_address} until ${cooldownUntil} (${reason})`);
  return { success: true, pool_address, base_mint, cooldown_until: cooldownUntil, hours: cooldownHours, updated };
}

// ─── Read ──────────────────────────────────────────────────────

/**
 * Tool handler: get_pool_memory
 * Returns deploy history and summary for a pool.
 */
export function getPoolMemory({ pool_address }) {
  if (!pool_address) return { error: "pool_address required" };

  const db = load();
  const entry = db[pool_address];

  if (!entry) {
    return {
      pool_address,
      known: false,
      message: "No history for this pool — first time deploying here.",
    };
  }

  return {
    pool_address,
    known: true,
    name: entry.name,
    base_mint: entry.base_mint,
    total_deploys: entry.total_deploys,
    avg_pnl_pct: entry.avg_pnl_pct,
    win_rate: entry.win_rate,
    adjusted_win_rate: entry.adjusted_win_rate ?? 0,
    adjusted_win_rate_sample_count: entry.adjusted_win_rate_sample_count ?? 0,
    recent_net_avg_pct: entry.recent_net_avg_pct ?? null,
    recent_net_win_rate: entry.recent_net_win_rate ?? null,
    recent_net_sample_count: entry.recent_net_sample_count ?? 0,
    last_deployed_at: entry.last_deployed_at,
    last_outcome: entry.last_outcome,
    cooldown_until: entry.cooldown_until || null,
    cooldown_reason: entry.cooldown_reason || null,
    base_mint_cooldown_until: entry.base_mint_cooldown_until || null,
    base_mint_cooldown_reason: entry.base_mint_cooldown_reason || null,
    notes: entry.notes,
    history: entry.deploys.slice(-10), // last 10 deploys
  };
}

/**
 * Record a live position snapshot during a management cycle.
 * Builds a trend dataset while position is still open — not just at close.
 * Keeps last 48 snapshots per pool (~4h at 5min intervals).
 */
export function recordPositionSnapshot(poolAddress, snapshot) {
  if (!poolAddress) return;
  const db = load();

  if (!db[poolAddress]) {
    db[poolAddress] = {
      name: snapshot.pair || poolAddress.slice(0, 8),
      base_mint: null,
      deploys: [],
      total_deploys: 0,
      avg_pnl_pct: 0,
      win_rate: 0,
      adjusted_win_rate: 0,
      adjusted_win_rate_sample_count: 0,
      last_deployed_at: null,
      last_outcome: null,
      notes: [],
      snapshots: [],
    };
  }

  if (!db[poolAddress].snapshots) db[poolAddress].snapshots = [];

  db[poolAddress].snapshots.push({
    ts: new Date().toISOString(),
    position: snapshot.position,
    pnl_pct: snapshot.pnl_pct ?? null,
    pnl_usd: snapshot.pnl_usd ?? null,
    in_range: snapshot.in_range ?? null,
    unclaimed_fees_usd: snapshot.unclaimed_fees_usd ?? null,
    minutes_out_of_range: snapshot.minutes_out_of_range ?? null,
    age_minutes: snapshot.age_minutes ?? null,
  });

  // Keep last 48 snapshots (~4h at 5min intervals)
  if (db[poolAddress].snapshots.length > 48) {
    db[poolAddress].snapshots = db[poolAddress].snapshots.slice(-48);
  }

  save(db);
}

/**
 * Recall focused context for a specific pool — used before screening or management.
 * Returns a short formatted string ready for injection into the agent goal.
 */
export function recallForPool(poolAddress) {
  if (!poolAddress) return null;
  const db = load();
  const entry = db[poolAddress];
  if (!entry) return null;

  const lines = [];

  // Deploy history summary
  if (entry.total_deploys > 0) {
    const recentNet = entry.recent_net_sample_count > 0
      ? `, recent clean net avg ${entry.recent_net_avg_pct}% / win ${entry.recent_net_win_rate}% (${entry.recent_net_sample_count} samples)`
      : ", recent clean net unavailable";
    lines.push(`POOL MEMORY [${entry.name}]: ${entry.total_deploys} past deploy(s), legacy gross avg ${entry.avg_pnl_pct}% / win ${entry.win_rate}%${recentNet}, last outcome: ${entry.last_outcome}`);
    if (entry.last_deployed_at) {
      const ageHours = Math.max(0, (Date.now() - Date.parse(entry.last_deployed_at)) / 3_600_000);
      if (Number.isFinite(ageHours)) lines.push(`MEMORY AGE: last deploy closed ${ageHours.toFixed(1)}h ago (${entry.last_deployed_at})`);
    }
  }

  if (entry.cooldown_until && new Date(entry.cooldown_until) > new Date()) {
    lines.push(`POOL COOLDOWN: active until ${entry.cooldown_until}${entry.cooldown_reason ? ` (${entry.cooldown_reason})` : ""}`);
  }

  if (entry.base_mint_cooldown_until && new Date(entry.base_mint_cooldown_until) > new Date()) {
    lines.push(`TOKEN COOLDOWN: active until ${entry.base_mint_cooldown_until}${entry.base_mint_cooldown_reason ? ` (${entry.base_mint_cooldown_reason})` : ""}`);
  }

  lines.push(getPoolMemoryPolicy(entry));

  // Recent snapshot trend (last 6 = ~30min)
  const snaps = (entry.snapshots || []).slice(-6);
  if (snaps.length >= 2) {
    const first = snaps[0];
    const last = snaps[snaps.length - 1];
    const pnlTrend = last.pnl_pct != null && first.pnl_pct != null
      ? (last.pnl_pct - first.pnl_pct).toFixed(2)
      : null;
    const oorCount = snaps.filter(s => s.in_range === false).length;
    const lastSnapshotAt = Date.parse(last.ts);
    const snapshotAgeHours = Number.isFinite(lastSnapshotAt)
      ? Math.max(0, (Date.now() - lastSnapshotAt) / 3_600_000)
      : null;
    const trendLabel = snapshotAgeHours != null && snapshotAgeHours > 6
      ? `LAST POSITION TREND (historical, ${snapshotAgeHours.toFixed(1)}h old)`
      : "RECENT POSITION TREND";
    lines.push(`${trendLabel}: PnL drift ${pnlTrend !== null ? (pnlTrend >= 0 ? "+" : "") + pnlTrend + "%" : "unknown"} over last ${snaps.length} cycles, OOR in ${oorCount}/${snaps.length} cycles`);
  }

  // Notes
  if (entry.notes?.length > 0) {
    const lastNote = entry.notes[entry.notes.length - 1];
    const safeNote = sanitizeStoredNote(lastNote.note);
    if (safeNote) lines.push(`NOTE: ${safeNote}`);
  }

  return lines.length > 0 ? lines.join("\n") : null;
}

/**
 * Tool handler: add_pool_note
 * Agent can annotate a pool with a freeform note.
 */
export function addPoolNote({ pool_address, note }) {
  if (!pool_address) return { error: "pool_address required" };
  const safeNote = sanitizeStoredNote(note);
  if (!safeNote) return { error: "note required" };

  const db = load();

  if (!db[pool_address]) {
    db[pool_address] = {
      name: pool_address.slice(0, 8),
      base_mint: null,
      deploys: [],
      total_deploys: 0,
      avg_pnl_pct: 0,
      win_rate: 0,
      last_deployed_at: null,
      last_outcome: null,
      notes: [],
    };
  }

  db[pool_address].notes.push({
    note: safeNote,
    added_at: new Date().toISOString(),
  });

  save(db);
  log("pool-memory", `Note added to ${pool_address.slice(0, 8)}: ${safeNote}`);
  return { saved: true, pool_address, note: safeNote };
}
