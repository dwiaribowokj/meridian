import { discoverPools, getPoolDetail, getTopCandidates } from "./screening.js";
import {
  getActiveBin,
  deployPosition,
  getMyPositions,
  getWalletPositions,
  getPositionPnl,
  claimFees,
  closePosition,
  registerLiveClaimExecutionCapability,
  searchPools,
} from "./dlmm.js";
import { getWalletBalances, getWalletPublicKey, swapToken } from "./wallet.js";
import { studyTopLPers } from "./study.js";
import { addLesson, clearAllLessons, clearPerformance, removeLessonsByKeyword, getPerformanceHistory, pinLesson, unpinLesson, listLessons } from "../lessons.js";
import { getTrackedPositions, recordCloseSolMetrics, setPositionInstruction } from "../state.js";

import { getPoolMemory, addPoolNote } from "../pool-memory.js";
import { addStrategy, listStrategies, getStrategy, setActiveStrategy, removeStrategy } from "../strategy-library.js";
import { addToBlacklist, removeFromBlacklist, listBlacklist, isBlacklisted } from "../token-blacklist.js";
import { blockDev, unblockDev, listBlockedDevs, isDevBlocked } from "../dev-blocklist.js";
import { addSmartWallet, removeSmartWallet, listSmartWallets, checkSmartWalletsOnPool } from "../smart-wallets.js";
import { getTokenInfo, getTokenHolders, getTokenNarrative } from "./token.js";
import {
  config,
  getPaperDeploymentGate,
  isEffectiveDryRun,
  reloadScreeningThresholds,
  MIN_SAFE_BINS_BELOW,
} from "../config.js";
import { LOCKED_CANARY } from "./rollout-safety.js";
import { getRecentDecisions } from "../decision-log.js";
import fs from "fs";
import { execSync, spawn } from "child_process";
import { REPO_ROOT, repoPath } from "../repo-root.js";
import { normalizeTimeframe, scaleScreeningToTimeframe } from "../screening-scales.js";
import { validateCandidateStability } from "../candidate-observations.js";
import { confirmStrictEntryMomentum } from "./chart-indicators.js";
import {
  calculateAdaptiveSizing,
  candidatePolicyFromScreening,
  evaluateCandidate,
  isAuthorizedRotationRange,
  minimumBinsBelowForStrategyProfile,
  SHADOW_ROTATION_STRATEGY_PROFILE,
} from "../risk-policy.js";
import {
  beginCloseLifecycle,
  acquireLifecycleOperation,
  markCleanupPending,
  recordDeployLifecycle,
  recordLifecycleTransactions,
  requireLifecycleAttribution,
  withLifecycleOperation,
  getLifecycleOperationRecoveryEvidence,
  getTradeLedger,
  finalizeLifecycleOperation,
  getRetainedLifecycleOperationLeaseStatus,
  reconcileRetainedLifecycleOperationLease,
  recordLifecycleOperationGuardRetention,
  releaseLifecycleOperation,
  retainLifecycleOperationLease,
} from "../ledger-runtime.js";
import { circuitBreakerEntryAllowed, recordCircuitBreakerEvent } from "../breaker-runtime.js";
import {
  executeEconomicCleanup,
  executeLeasedLifecycleCleanup,
  listPendingCleanupLifecycles,
  registerCleanupExecutionCapability,
} from "../cleanup-runtime.js";

const USER_CONFIG_PATH = repoPath("user-config.json");
const POOL_DISCOVERY_BASE = "https://pool-discovery-api.datapi.meteora.ag";
const MIN_VOLATILITY_TIMEFRAME = "30m";
const LIVE_CANARY_DEPLOY_GUARD_RESOURCE = "global:live-canary-deploy";
const TIMEFRAME_MINUTES = {
  "5m": 5,
  "30m": 30,
  "1h": 60,
  "2h": 120,
  "4h": 240,
  "12h": 720,
  "24h": 1440,
};
import { log, logAction } from "../logger.js";
import { notifyDeploy, notifyClose, notifySwap } from "../telegram.js";

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function getVolatilityTimeframe(sourceTimeframe) {
  const source = String(sourceTimeframe || "").trim();
  const sourceMinutes = TIMEFRAME_MINUTES[source];
  const minMinutes = TIMEFRAME_MINUTES[MIN_VOLATILITY_TIMEFRAME];
  return sourceMinutes != null && sourceMinutes >= minMinutes ? source : MIN_VOLATILITY_TIMEFRAME;
}

function poolDetailTvl(pool) {
  return numberOrNull(pool?.tvl ?? pool?.active_tvl ?? pool?.liquidity);
}

function poolDetailActiveTvl(pool) {
  return numberOrNull(pool?.active_tvl);
}

function poolDetailBinStep(pool) {
  return numberOrNull(pool?.dlmm_params?.bin_step ?? pool?.pool_config?.bin_step);
}

function poolDetailFeeActiveTvlRatio(pool) {
  return numberOrNull(pool?.fee_active_tvl_ratio);
}

function poolDetailVolume(pool) {
  return numberOrNull(pool?.volume);
}

function poolDetailVolatility(pool) {
  return numberOrNull(pool?.volatility);
}

function poolDetailPrice(pool) {
  return numberOrNull(pool?.pool_price ?? pool?.price);
}

function isSolQuoteDetail(pool) {
  const quote = pool?.token_y || {};
  return quote?.address === config.tokens.SOL || String(quote?.symbol || "").toUpperCase() === "SOL";
}

async function fetchFreshPoolDetail(poolAddress, timeframe = config.screening.timeframe || "5m") {
  const encodedTimeframe = encodeURIComponent(timeframe);
  const filter = encodeURIComponent(`pool_address=${poolAddress}`);
  const url = `${POOL_DISCOVERY_BASE}/pools?page_size=1&filter_by=${filter}&timeframe=${encodedTimeframe}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Pool Discovery API error: ${res.status} ${res.statusText}`);
  const data = await res.json();
  return (data?.data || [])[0] ?? null;
}

async function validateDeployPoolThresholds(args) {
  let detail;
  try {
    detail = await fetchFreshPoolDetail(args.pool_address);
    if (!detail) throw new Error(`Pool ${args.pool_address} not found`);
  } catch (error) {
    return {
      pass: false,
      reason: `Could not verify pool screening thresholds before deploy: ${error.message}`,
    };
  }

  const tvl = poolDetailTvl(detail);
  const minTvl = numberOrNull(config.screening.minTvl);
  const maxTvl = numberOrNull(config.screening.maxTvl);
  if (!isSolQuoteDetail(detail)) {
    const quote = detail?.token_y || {};
    return {
      pass: false,
      reason: `Pool quote token is ${quote.symbol || quote.address || "unknown"}, not SOL. This agent only supports single-side SOL deploys into TOKEN-SOL pools.`,
    };
  }
  if (tvl == null) {
    return {
      pass: false,
      reason: "Could not verify pool TVL before deploy.",
    };
  }
  if (minTvl != null && minTvl > 0 && tvl < minTvl) {
    return {
      pass: false,
      reason: `Pool TVL $${tvl} is below configured minTvl $${minTvl}.`,
    };
  }
  if (maxTvl != null && maxTvl > 0 && tvl > maxTvl) {
    return {
      pass: false,
      reason: `Pool TVL $${tvl} is above configured maxTvl $${maxTvl}.`,
    };
  }

  const feeActiveTvlRatio = poolDetailFeeActiveTvlRatio(detail);
  const minFeeActiveTvlRatio = numberOrNull(config.screening.minFeeActiveTvlRatio);
  if (
    minFeeActiveTvlRatio != null &&
    minFeeActiveTvlRatio > 0 &&
    (feeActiveTvlRatio == null || feeActiveTvlRatio < minFeeActiveTvlRatio)
  ) {
    return {
      pass: false,
      reason: `Pool fee/active-TVL ${feeActiveTvlRatio ?? "unknown"}% is below configured minFeeActiveTvlRatio ${minFeeActiveTvlRatio}%.`,
    };
  }

  const volume = poolDetailVolume(detail);
  const minVolume = numberOrNull(config.screening.minVolume);
  if (minVolume != null && minVolume > 0 && (volume == null || volume < minVolume)) {
    return {
      pass: false,
      reason: `Pool volume ${volume ?? "unknown"} is below configured minVolume ${minVolume}.`,
    };
  }

  const volatilityTimeframe = getVolatilityTimeframe(config.screening.timeframe || "5m");
  let volatilityDetail = detail;
  if ((config.screening.timeframe || "5m") !== volatilityTimeframe) {
    try {
      volatilityDetail = await fetchFreshPoolDetail(args.pool_address, volatilityTimeframe);
    } catch (error) {
      return {
        pass: false,
        reason: `Could not verify pool ${volatilityTimeframe} volatility before deploy: ${error.message}`,
      };
    }
  }

  const volatility = poolDetailVolatility(volatilityDetail);
  if (volatility == null || volatility <= 0) {
    return {
      pass: false,
      reason: `Pool ${volatilityTimeframe} volatility ${volatility ?? "unknown"} is unusable. Refusing deploy.`,
    };
  }
  if (
    config.strategy.regimeHighVolAction === "skip" &&
    volatility >= Number(config.strategy.regimeHighVolMin ?? 2)
  ) {
    return {
      pass: false,
      reason: `Expansion regime blocked: volatility ${volatility} >= ${config.strategy.regimeHighVolMin}.`,
    };
  }
  const maxVolatility = numberOrNull(config.screening.maxVolatility);
  if (maxVolatility != null && maxVolatility > 0 && volatility >= maxVolatility) {
    return {
      pass: false,
      reason: `Pool ${volatilityTimeframe} volatility ${volatility} is at/above configured maxVolatility ${maxVolatility}.`,
    };
  }

  const confirmation = validateCandidateStability(
    args.pool_address,
    {
      feeActiveTvlRatio,
      volume,
      price: poolDetailPrice(detail),
      binStep: poolDetailBinStep(detail),
    },
    config.screening,
  );
  if (!confirmation.pass) return confirmation;

  const actualBinStep = poolDetailBinStep(detail);
  const minStep = numberOrNull(config.screening.minBinStep);
  const maxStep = numberOrNull(config.screening.maxBinStep);
  if (actualBinStep != null && minStep != null && actualBinStep < minStep) {
    return {
      pass: false,
      reason: `Pool bin_step ${actualBinStep} is below configured minBinStep ${minStep}.`,
    };
  }
  if (actualBinStep != null && maxStep != null && actualBinStep > maxStep) {
    return {
      pass: false,
      reason: `Pool bin_step ${actualBinStep} is above configured maxBinStep ${maxStep}.`,
    };
  }

  const baseMint = detail?.token_x?.address || detail?.base_token_address || null;
  if (!baseMint) return { pass: false, reason: "Could not verify base mint before deploy." };
  if (isBlacklisted(baseMint)) return { pass: false, reason: `Base mint ${baseMint} is blacklisted.` };
  const dev = detail?.token_x?.dev || detail?.base_token_dev || null;
  if (dev && isDevBlocked(dev)) return { pass: false, reason: `Pool deployer ${dev} is blocked.` };

  let tokenInfo;
  let momentum;
  try {
    const [tokenInfoResult, momentumResult] = await Promise.all([
      getTokenInfo({ query: baseMint }),
      confirmStrictEntryMomentum({ mint: baseMint, refresh: true }),
    ]);
    tokenInfo = tokenInfoResult?.results?.[0] ?? null;
    momentum = momentumResult;
  } catch (error) {
    return { pass: false, reason: `Could not complete fresh token/momentum deploy audit: ${error.message}` };
  }
  if (!tokenInfo || !momentum || !Array.isArray(momentum.intervals)) {
    return { pass: false, reason: !tokenInfo ? "Fresh token audit unavailable." : "Fresh momentum data unavailable." };
  }
  if (!momentum.confirmed && config.rollout.strategyProfile !== SHADOW_ROTATION_STRATEGY_PROFILE) {
    return { pass: false, reason: momentum?.reason || "Strict momentum failed." };
  }

  const intervalSignal = (interval) => {
    const item = momentum.intervals?.find((entry) => entry.interval === interval);
    return {
      available: item?.ok === true,
      supertrendDirection: String(item?.signal?.supertrendDirection || "unknown").toLowerCase(),
      supertrendBreakUp: item?.signal?.supertrendBreakUp === true,
      supertrendBreakDown: item?.signal?.supertrendBreakDown === true,
      rsi: numberOrNull(item?.signal?.rsi),
      close: numberOrNull(item?.signal?.close),
      previousClose: numberOrNull(item?.signal?.previousClose),
      lowerBand: numberOrNull(item?.signal?.lowerBand),
      upperBand: numberOrNull(item?.signal?.upperBand),
    };
  };
  const evaluatedAtMs = Date.now();
  const policySnapshot = args.policy_snapshot || {};
  const requestedStrategyProfile = policySnapshot.strategyProfile ?? config.rollout.strategyProfile;
  if (requestedStrategyProfile !== config.rollout.strategyProfile) {
    return {
      pass: false,
      reason: `Deploy strategy profile ${requestedStrategyProfile || "missing"} does not match active profile ${config.rollout.strategyProfile}.`,
    };
  }
  const configuredCandidatePolicy = candidatePolicyFromScreening(config.screening, {
    management: config.management,
    indicators: config.indicators,
    strategyProfile: requestedStrategyProfile,
    shadowRotation: config.shadowRotation,
  });
  const activeTvl = poolDetailActiveTvl(detail);
  const freshPolicySnapshot = {
    strategyProfile: requestedStrategyProfile,
    fundingModel: requestedStrategyProfile === SHADOW_ROTATION_STRATEGY_PROFILE
      ? config.shadowRotation.fundingModel
      : "single_side_sol",
    poolAddress: args.pool_address,
    pairType: "TOKEN-SOL",
    protocol: String(detail?.pool_type || "dlmm").toUpperCase(),
    timeframeMinutes: 30,
    evaluatedAtMs,
    requestedDeployUsd: numberOrNull(args.initial_value_usd),
    activeTvlUsd: activeTvl,
    volumeUsd: volume,
    feeActiveTvlRatioPct: feeActiveTvlRatio,
    volatility,
    binStep: actualBinStep,
    organicScoreBase: numberOrNull(detail?.token_x?.organic_score),
    organicScoreQuote: numberOrNull(detail?.token_y?.organic_score),
    holderCount: numberOrNull(tokenInfo?.holders ?? detail?.base_token_holders),
    marketCapUsd: numberOrNull(tokenInfo?.mcap ?? detail?.token_x?.market_cap),
    tokenAgeHours: detail?.token_x?.created_at
      ? Math.floor((Date.now() - Number(detail.token_x.created_at)) / 3_600_000)
      : null,
    globalFeesSol: numberOrNull(tokenInfo?.global_fees_sol),
    smartWalletCount: Math.max(0, Number(policySnapshot.smartWalletCount ?? 0)),
    audit: {
      checkedAtMs: evaluatedAtMs,
      botHolderPct: numberOrNull(tokenInfo?.audit?.bot_holders_pct),
      top10Pct: numberOrNull(tokenInfo?.audit?.top_holders_pct),
      mintAuthorityDisabled: tokenInfo?.audit?.mint_disabled === true,
      freezeAuthorityDisabled: tokenInfo?.audit?.freeze_disabled === true,
      criticalWarning: detail?.base_token_has_critical_warnings === true || detail?.quote_token_has_critical_warnings === true,
      highConcentration: detail?.base_token_has_high_supply_concentration === true,
      highSingleOwner: detail?.base_token_has_high_single_ownership === true,
      pvp: policySnapshot?.audit?.pvp === true,
      blocklisted: false,
    },
    momentum5m: intervalSignal("5_MINUTE"),
    momentum15m: intervalSignal("15_MINUTE"),
    observations: (confirmation.observations || []).map((entry) => ({
      observedAtMs: Number(entry.observedAt),
      feeValue: Number(entry.feeActiveTvlRatio),
      volumeValue: Number(entry.volume),
      priceValue: Number(entry.price),
      binStepValue: Number(entry.binStep),
    })),
  };
  const policyEvaluation = evaluateCandidate({
    ...freshPolicySnapshot,
  }, { nowMs: evaluatedAtMs }, configuredCandidatePolicy);
  if (!policyEvaluation.eligible) {
    return { pass: false, reason: `Fresh deterministic deploy gates failed: ${policyEvaluation.reasons.join(", ")}` };
  }
  freshPolicySnapshot.entryEconomics = policyEvaluation.economics;

  const entryMarketData = {
    entry_mcap: numberOrNull(detail?.token_x?.market_cap ?? detail?.base_token_market_cap),
    entry_tvl: tvl,
    entry_volume: numberOrNull(detail?.volume),
    entry_holders: numberOrNull(detail?.base_token_holders ?? detail?.token_x?.holders),
  };

  return { pass: true, entryMarketData, policyEvaluation, policySnapshot: freshPolicySnapshot };
}

// Registered by index.js so update_config can restart cron jobs when intervals change
let _cronRestarter = null;
export function registerCronRestarter(fn) { _cronRestarter = fn; }

function coerceBoolean(value, key) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  throw new Error(`${key} must be true or false`);
}

function coerceFiniteNumber(value, key) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${key} must be a finite number`);
  return n;
}

function coerceString(value, key) {
  if (typeof value !== "string") throw new Error(`${key} must be a string`);
  return value.trim();
}

function coerceStringArray(value, key) {
  if (!Array.isArray(value)) throw new Error(`${key} must be an array of strings`);
  return value.map((entry) => coerceString(entry, key)).filter(Boolean);
}

function coerceMultiLayerLayers(value, key) {
  if (!Array.isArray(value)) throw new Error(`${key} must be an array of layer objects`);
  const layers = value.map((layer, index) => {
    if (!layer || typeof layer !== "object" || Array.isArray(layer)) {
      throw new Error(`${key}[${index}] must be an object`);
    }
    const strategy = coerceString(layer.strategy, `${key}[${index}].strategy`);
    const pct = coerceFiniteNumber(layer.pct, `${key}[${index}].pct`);
    if (pct <= 0) throw new Error(`${key}[${index}].pct must be > 0`);
    return { strategy, pct };
  });
  const totalPct = layers.reduce((sum, layer) => sum + layer.pct, 0);
  if (Math.abs(totalPct - 100) > 0.0001) throw new Error(`${key} pct total must be 100`);
  return layers;
}

function normalizeMultiLayerLayersFromStrategy(strategyConfig) {
  const layers = Array.isArray(strategyConfig.multiLayerLayers) && strategyConfig.multiLayerLayers.length > 0
    ? strategyConfig.multiLayerLayers
    : [
        { strategy: strategyConfig.multiLayerPrimaryStrategy ?? "bid_ask", pct: strategyConfig.multiLayerPrimaryPct ?? 70 },
        { strategy: strategyConfig.multiLayerSecondaryStrategy ?? "spot", pct: strategyConfig.multiLayerSecondaryPct ?? 30 },
      ];
  return coerceMultiLayerLayers(layers, "multiLayerLayers");
}

function normalizeConfigValue(key, value) {
  const booleanKeys = new Set([
    "excludeHighSupplyConcentration",
    "useDiscordSignals",
    "avoidPvpSymbols",
    "blockPvpSymbols",
    "trailingTakeProfit",
    "dynamicStopLossEnabled",
    "microProfitProtectEnabled",
    "peakDecayCloseEnabled",
    "solMode",
    "darwinEnabled",
    "lpAgentRelayEnabled",
    "multiLayerEnabled",
    "indicatorHardFilter",
    "extraSearchOnlySolPools",
    "candidateConfirmationEnabled",
    "regimeOverrideExplicitStrategy",
    "costAwareTakeProfitEnabled",
    "entryRejectAboveUpperBand",
  ]);
  const arrayKeys = new Set(["allowedLaunchpads", "blockedLaunchpads", "extraSearchSymbols"]);
  const layerArrayKeys = new Set(["multiLayerLayers"]);
  const stringKeys = new Set([
    "timeframe",
    "category",
    "discordSignalMode",
    "strategy",
    "managementModel",
    "screeningModel",
    "generalModel",
    "hiveMindUrl",
    "hiveMindApiKey",
    "agentId",
    "hiveMindPullMode",
    "publicApiKey",
    "agentMeridianApiUrl",
    "pnlSource",
    "pnlRpcUrl",
    "gmgnFeeSource",
    "gmgnApiKey",
    "multiLayerMode",
    "multiLayerPrimaryStrategy",
    "multiLayerSecondaryStrategy",
    "regimeLowVolStrategy",
    "regimeMidVolStrategy",
    "regimeHighVolStrategy",
    "regimeHighVolAction",
  ]);
  if (value === null) return null;
  if (booleanKeys.has(key)) return coerceBoolean(value, key);
  if (arrayKeys.has(key)) return coerceStringArray(value, key);
  if (layerArrayKeys.has(key)) return coerceMultiLayerLayers(value, key);
  if (key === "regimeHighVolAction") {
    const action = coerceString(value, key).toLowerCase();
    if (action !== "skip" && action !== "deploy") {
      throw new Error(`${key} must be skip or deploy`);
    }
    return action;
  }
  if (stringKeys.has(key)) return coerceString(value, key);
  return coerceFiniteNumber(value, key);
}

// Map tool names to implementations
const toolMap = {
  discover_pools: discoverPools,
  get_top_candidates: getTopCandidates,
  get_pool_detail: getPoolDetail,
  get_position_pnl: getPositionPnl,
  get_active_bin: getActiveBin,
  deploy_position: deployPosition,
  get_my_positions: getMyPositions,
  get_wallet_positions: getWalletPositions,
  search_pools: searchPools,
  get_token_info: getTokenInfo,
  get_token_holders: getTokenHolders,
  get_token_narrative: getTokenNarrative,
  add_smart_wallet: addSmartWallet,
  remove_smart_wallet: removeSmartWallet,
  list_smart_wallets: listSmartWallets,
  check_smart_wallets_on_pool: checkSmartWalletsOnPool,
  claim_fees: claimFees,
  close_position: closePosition,
  // Model-facing cleanup is deliberately preview-only. The execution wrapper
  // below has a private capability and is not exposed as a tool.
  reconcile_cleanup: ({ position }) => executeEconomicCleanup({ position, execute: false }),
  get_wallet_balance: getWalletBalances,
  swap_token: swapToken,
  get_top_lpers: studyTopLPers,
  study_top_lpers: studyTopLPers,
  set_position_note: ({ position_address, instruction }) => {
    const ok = setPositionInstruction(position_address, instruction || null);
    if (!ok) return { error: `Position ${position_address} not found in state` };
    return { saved: true, position: position_address, instruction: instruction || null };
  },
  self_update: async () => {
    try {
      const result = execSync("git pull", { cwd: REPO_ROOT, encoding: "utf8" }).trim();
      if (result.includes("Already up to date")) {
        return { success: true, updated: false, message: "Already up to date — no restart needed." };
      }
      // Delay restart so this tool response (and Telegram message) gets sent first
      setTimeout(() => {
        if (!process.env.pm_id) {
          const child = spawn(process.execPath, process.argv.slice(1), {
            detached: true,
            stdio: "inherit",
            cwd: REPO_ROOT,
          });
          child.unref();
        }
        process.exit(0);
      }, 3000);
      const restartMode = process.env.pm_id
        ? "PM2 detected — exiting in 3s so PM2 can restart the managed process."
        : "Restarting in 3s...";
      return { success: true, updated: true, message: `Updated! ${restartMode}\n${result}` };
    } catch (e) {
      return { success: false, error: e.message };
    }
  },
  get_performance_history: getPerformanceHistory,
  get_recent_decisions: ({ limit } = {}) => ({ decisions: getRecentDecisions(limit || 6) }),
  add_strategy:        addStrategy,
  list_strategies:     listStrategies,
  get_strategy:        getStrategy,
  set_active_strategy: setActiveStrategy,
  remove_strategy:     removeStrategy,
  get_pool_memory: getPoolMemory,
  add_pool_note: addPoolNote,
  add_to_blacklist: addToBlacklist,
  remove_from_blacklist: removeFromBlacklist,
  list_blacklist: listBlacklist,
  block_deployer: blockDev,
  unblock_deployer: unblockDev,
  list_blocked_deployers: listBlockedDevs,
  add_lesson: ({ rule, tags, pinned, role }) => {
    addLesson(rule, tags || [], { pinned: !!pinned, role: role || null });
    return { saved: true, rule, pinned: !!pinned, role: role || "all" };
  },
  pin_lesson:   ({ id }) => pinLesson(id),
  unpin_lesson: ({ id }) => unpinLesson(id),
  list_lessons: ({ role, pinned, tag, limit } = {}) => listLessons({ role, pinned, tag, limit }),
  clear_lessons: ({ mode, keyword }) => {
    if (mode === "all") {
      const n = clearAllLessons();
      log("lessons", `Cleared all ${n} lessons`);
      return { cleared: n, mode: "all" };
    }
    if (mode === "performance") {
      const n = clearPerformance();
      log("lessons", `Cleared ${n} performance records`);
      return { cleared: n, mode: "performance" };
    }
    if (mode === "keyword") {
      if (!keyword) return { error: "keyword required for mode=keyword" };
      const n = removeLessonsByKeyword(keyword);
      log("lessons", `Cleared ${n} lessons matching "${keyword}"`);
      return { cleared: n, mode: "keyword", keyword };
    }
    return { error: "invalid mode" };
  },
  update_config: ({ changes, reason = "" }) => {
    // Flat key → config section mapping (covers everything in config.js)
    const CONFIG_MAP = {
      // screening
      minFeeActiveTvlRatio: ["screening", "minFeeActiveTvlRatio"],
      excludeHighSupplyConcentration: ["screening", "excludeHighSupplyConcentration"],
      minTvl: ["screening", "minTvl"],
      minActiveTvl: ["screening", "minActiveTvl"],
      maxTvl: ["screening", "maxTvl"],
      minVolume: ["screening", "minVolume"],
      maxVolatility: ["screening", "maxVolatility"],
      minOrganic: ["screening", "minOrganic"],
      minQuoteOrganic: ["screening", "minQuoteOrganic"],
      minHolders: ["screening", "minHolders"],
      minMcap: ["screening", "minMcap"],
      maxMcap: ["screening", "maxMcap"],
      minBinStep: ["screening", "minBinStep"],
      maxBinStep: ["screening", "maxBinStep"],
      timeframe: ["screening", "timeframe"],
      category: ["screening", "category"],
      minTokenFeesSol: ["screening", "minTokenFeesSol"],
      useDiscordSignals: ["screening", "useDiscordSignals"],
      discordSignalMode: ["screening", "discordSignalMode"],
      avoidPvpSymbols: ["screening", "avoidPvpSymbols"],
      blockPvpSymbols: ["screening", "blockPvpSymbols"],
      maxBotHoldersPct: ["screening", "maxBotHoldersPct"],
      maxTop10Pct: ["screening", "maxTop10Pct"],
      allowedLaunchpads: ["screening", "allowedLaunchpads"],
      blockedLaunchpads: ["screening", "blockedLaunchpads"],
      minTokenAgeHours: ["screening", "minTokenAgeHours"],
      maxTokenAgeHours: ["screening", "maxTokenAgeHours"],
      extraSearchSymbols: ["screening", "extraSearchSymbols"],
      extraSearchLimitPerSymbol: ["screening", "extraSearchLimitPerSymbol"],
      extraSearchOnlySolPools: ["screening", "extraSearchOnlySolPools"],
      candidateConfirmationEnabled: ["screening", "candidateConfirmationEnabled"],
      candidateConfirmationCount: ["screening", "candidateConfirmationCount"],
      candidateConfirmationMaxAgeMinutes: ["screening", "candidateConfirmationMaxAgeMinutes"],
      candidateConfirmationMinSpacingMinutes: ["screening", "candidateConfirmationMinSpacingMinutes"],
      candidateMinFeeRetentionPct: ["screening", "candidateMinFeeRetentionPct"],
      candidateMinVolumeRetentionPct: ["screening", "candidateMinVolumeRetentionPct"],
      minFeePerTvl24h: ["management", "minFeePerTvl24h"],
      loneCandidateMinDegen: ["screening", "loneCandidateMinDegen"],
      // management
      minClaimAmount: ["management", "minClaimAmount"],
      outOfRangeBinsToClose: ["management", "outOfRangeBinsToClose"],
      outOfRangeWaitMinutes: ["management", "outOfRangeWaitMinutes"],
      oorCooldownTriggerCount: ["management", "oorCooldownTriggerCount"],
      oorCooldownHours: ["management", "oorCooldownHours"],
      repeatDeployCooldownEnabled: ["management", "repeatDeployCooldownEnabled"],
      repeatDeployCooldownTriggerCount: ["management", "repeatDeployCooldownTriggerCount"],
      repeatDeployCooldownHours: ["management", "repeatDeployCooldownHours"],
      repeatDeployCooldownScope: ["management", "repeatDeployCooldownScope"],
      repeatDeployCooldownMinFeeEarnedPct: ["management", "repeatDeployCooldownMinFeeEarnedPct"],
      badOutcomeCooldownEnabled: ["management", "badOutcomeCooldownEnabled"],
      badOutcomeCooldownScope: ["management", "badOutcomeCooldownScope"],
      lowYieldCooldownHours: ["management", "lowYieldCooldownHours"],
      stopLossCooldownHours: ["management", "stopLossCooldownHours"],
      shadowOutOfRangeCooldownHours: ["management", "shadowOutOfRangeCooldownHours"],
      minVolumeToRebalance: ["management", "minVolumeToRebalance"],
      stopLossPct: ["management", "stopLossPct"],
      takeProfitPct: ["management", "takeProfitPct"],
      takeProfitFeePct: ["management", "takeProfitPct"],
      costAwareTakeProfitEnabled: ["management", "costAwareTakeProfitEnabled"],
      estimatedRoundTripCostPct: ["management", "estimatedRoundTripCostPct"],
      minNetProfitPct: ["management", "minNetProfitPct"],
      poolMemoryMaxNetPnlDiffPct: ["management", "poolMemoryMaxNetPnlDiffPct"],
      trailingTakeProfit: ["management", "trailingTakeProfit"],
      trailingTriggerPct: ["management", "trailingTriggerPct"],
      trailingDropPct: ["management", "trailingDropPct"],
      dynamicStopLossEnabled: ["management", "dynamicStopLossEnabled"],
      dynamicStopBasePct: ["management", "dynamicStopBasePct"],
      breakevenTriggerPct: ["management", "breakevenTriggerPct"],
      breakevenStopPct: ["management", "breakevenStopPct"],
      profitProtectTriggerPct: ["management", "profitProtectTriggerPct"],
      profitProtectStopPct: ["management", "profitProtectStopPct"],
      retraceCloseTriggerPct: ["management", "retraceCloseTriggerPct"],
      retraceClosePct: ["management", "retraceClosePct"],
      dynamicStopMinAgeMinutes: ["management", "dynamicStopMinAgeMinutes"],
      microProfitProtectEnabled: ["management", "microProfitProtectEnabled"],
      microProfitPeakTriggerPct: ["management", "microProfitPeakTriggerPct"],
      microProfitRetracePct: ["management", "microProfitRetracePct"],
      microProfitMinCurrentPct: ["management", "microProfitMinCurrentPct"],
      microProfitMinAgeMinutes: ["management", "microProfitMinAgeMinutes"],
      profitStallCloseEnabled: ["management", "profitStallCloseEnabled"],
      profitStallMinPeakPct: ["management", "profitStallMinPeakPct"],
      profitStallMinCurrentPct: ["management", "profitStallMinCurrentPct"],
      profitStallMinutes: ["management", "profitStallMinutes"],
      profitStallMaxFeePerTvl24h: ["management", "profitStallMaxFeePerTvl24h"],
      peakDecayCloseEnabled: ["management", "peakDecayCloseEnabled"],
      peakDecayMinPeakPct: ["management", "peakDecayMinPeakPct"],
      peakDecayMinDropPct: ["management", "peakDecayMinDropPct"],
      peakDecayMinCurrentPct: ["management", "peakDecayMinCurrentPct"],
      peakDecayMinutes: ["management", "peakDecayMinutes"],
      peakDecayMaxFeePerTvl24h: ["management", "peakDecayMaxFeePerTvl24h"],
      pnlSanityMaxDiffPct: ["management", "pnlSanityMaxDiffPct"],
      pnlNewPositionOutlierMinutes: ["management", "pnlNewPositionOutlierMinutes"],
      pnlNewPositionOutlierMaxPct: ["management", "pnlNewPositionOutlierMaxPct"],
      pnlOutlierMaxPct: ["management", "pnlOutlierMaxPct"],
      pnlDivergenceGateMinPct: ["management", "pnlDivergenceGateMinPct"],
      // pnl poller
      pnlConfirmTicks: ["pnl", "confirmTicks"],
      pnlProfitConfirmTicks: ["pnl", "profitConfirmTicks"],
      pnlStopConfirmTicks: ["pnl", "stopConfirmTicks"],
      // opportunity poller (interval/enabled changes apply on next restart)
      opportunityPollEnabled: ["opportunity", "enabled"],
      opportunityPollIntervalSec: ["opportunity", "pollIntervalSec"],
      opportunityPollLimit: ["opportunity", "limit"],
      opportunityMinScore: ["opportunity", "minScore"],
      opportunitySmartWalletBonus: ["opportunity", "smartWalletScoreBonus"],
      degenTargetVolRatio: ["opportunity", "targetVolRatio"],
      degenTargetLpCount: ["opportunity", "targetLpCount"],
      degenTargetFeeRatio: ["opportunity", "targetFeeRatio"],
      degenTargetLiquidity: ["opportunity", "targetLiquidity"],
      solMode: ["management", "solMode"],
      minSolToOpen: ["management", "minSolToOpen"],
      deployAmountSol: ["management", "deployAmountSol"],
      gasReserve: ["management", "gasReserve"],
      positionSizePct: ["management", "positionSizePct"],
      minAgeBeforeYieldCheck: ["management", "minAgeBeforeYieldCheck"],
      deadPositionCheck1Minutes: ["management", "deadPositionCheck1Minutes"],
      deadPositionCheck1MaxPeakPct: ["management", "deadPositionCheck1MaxPeakPct"],
      deadPositionCheck1MaxCurrentPct: ["management", "deadPositionCheck1MaxCurrentPct"],
      deadPositionCheck1MaxFeePerTvl24h: ["management", "deadPositionCheck1MaxFeePerTvl24h"],
      // risk
      maxPositions: ["risk", "maxPositions"],
      maxDeployAmount: ["risk", "maxDeployAmount"],
      // schedule
      managementIntervalMin: ["schedule", "managementIntervalMin"],
      screeningIntervalMin: ["schedule", "screeningIntervalMin"],
      healthCheckIntervalMin: ["schedule", "healthCheckIntervalMin"],
      // models
      managementModel: ["llm", "managementModel"],
      screeningModel: ["llm", "screeningModel"],
      generalModel: ["llm", "generalModel"],
      temperature: ["llm", "temperature"],
      maxTokens: ["llm", "maxTokens"],
      maxSteps: ["llm", "maxSteps"],
      // strategy
      strategy: ["strategy", "strategy"],
      binsBelow: ["strategy", "maxBinsBelow", ["maxBinsBelow"]],
      minBinsBelow: ["strategy", "minBinsBelow"],
      maxBinsBelow: ["strategy", "maxBinsBelow"],
      defaultBinsBelow: ["strategy", "defaultBinsBelow"],
      multiLayerEnabled: ["strategy", "multiLayerEnabled"],
      multiLayerMode: ["strategy", "multiLayerMode"],
      multiLayerLayers: ["strategy", "multiLayerLayers"],
      multiLayerPrimaryStrategy: ["strategy", "multiLayerPrimaryStrategy"],
      multiLayerSecondaryStrategy: ["strategy", "multiLayerSecondaryStrategy"],
      multiLayerPrimaryPct: ["strategy", "multiLayerPrimaryPct"],
      multiLayerSecondaryPct: ["strategy", "multiLayerSecondaryPct"],
      multiLayerMinLayerSol: ["strategy", "multiLayerMinLayerSol"],
      multiLayerMinSecondarySol: ["strategy", "multiLayerMinSecondarySol"],
      multiLayerMinDeploySol: ["strategy", "multiLayerMinDeploySol"],
      regimeStrategyEnabled: ["strategy", "regimeStrategyEnabled"],
      regimeOverrideExplicitStrategy: ["strategy", "regimeOverrideExplicitStrategy"],
      regimeLowVolMax: ["strategy", "regimeLowVolMax"],
      regimeHighVolMin: ["strategy", "regimeHighVolMin"],
      regimeLowVolStrategy: ["strategy", "regimeLowVolStrategy"],
      regimeMidVolStrategy: ["strategy", "regimeMidVolStrategy"],
      regimeHighVolStrategy: ["strategy", "regimeHighVolStrategy"],
      regimeHighVolAction: ["strategy", "regimeHighVolAction"],
      // hivemind
      hiveMindUrl: ["hiveMind", "url"],
      hiveMindApiKey: ["hiveMind", "apiKey"],
      agentId: ["hiveMind", "agentId"],
      hiveMindPullMode: ["hiveMind", "pullMode"],
      // meridian api / relay
      publicApiKey: ["api", "publicApiKey"],
      agentMeridianApiUrl: ["api", "url"],
      lpAgentRelayEnabled: ["api", "lpAgentRelayEnabled"],
      // pnl fetcher / poller
      pnlSource: ["pnl", "source", ["pnlSource"]],
      pnlRpcUrl: ["pnl", "rpcUrl", ["pnlRpcUrl"]],
      pnlPollIntervalSec: ["pnl", "pollIntervalSec", ["pnlPollIntervalSec"]],
      pnlDepositCacheTtlSec: ["pnl", "depositCacheTtlSec", ["pnlDepositCacheTtlSec"]],
      // gmgn fee source
      gmgnFeeSource: ["gmgn", "feeSource", ["gmgnFeeSource"]],
      gmgnApiKey: ["gmgn", "apiKey", ["gmgnApiKey"]],
      // chart indicators
      chartIndicatorsEnabled: ["indicators", "enabled", ["chartIndicators", "enabled"]],
      indicatorEntryPreset: ["indicators", "entryPreset", ["chartIndicators", "entryPreset"]],
      indicatorExitPreset: ["indicators", "exitPreset", ["chartIndicators", "exitPreset"]],
      rsiLength: ["indicators", "rsiLength", ["chartIndicators", "rsiLength"]],
      indicatorIntervals: ["indicators", "intervals", ["chartIndicators", "intervals"]],
      indicatorCandles: ["indicators", "candles", ["chartIndicators", "candles"]],
      rsiOversold: ["indicators", "rsiOversold", ["chartIndicators", "rsiOversold"]],
      rsiOverbought: ["indicators", "rsiOverbought", ["chartIndicators", "rsiOverbought"]],
      entryRsiMax5m: ["indicators", "entryRsiMax5m", ["chartIndicators", "entryRsiMax5m"]],
      entryRsiMax15m: ["indicators", "entryRsiMax15m", ["chartIndicators", "entryRsiMax15m"]],
      entryRejectAboveUpperBand: ["indicators", "entryRejectAboveUpperBand", ["chartIndicators", "entryRejectAboveUpperBand"]],
      requireAllIntervals: ["indicators", "requireAllIntervals", ["chartIndicators", "requireAllIntervals"]],
      indicatorHardFilter: ["indicators", "hardFilter", ["chartIndicators", "hardFilter"]],
    };

    const applied = {};
    const unknown = [];

    // Build case-insensitive lookup
    const CONFIG_MAP_LOWER = Object.fromEntries(
      Object.entries(CONFIG_MAP).map(([k, v]) => [k.toLowerCase(), [k, v]])
    );

    if (!changes || typeof changes !== "object" || Array.isArray(changes)) {
      return { success: false, error: "changes must be an object", reason };
    }

    const STRATEGY_BIN_KEYS = new Set(["binsBelow", "minBinsBelow", "maxBinsBelow", "defaultBinsBelow"]);
    for (const [key, val] of Object.entries(changes)) {
      const match = CONFIG_MAP[key] ? [key, CONFIG_MAP[key]] : CONFIG_MAP_LOWER[key.toLowerCase()];
      if (!match) { unknown.push(key); continue; }
      try {
        let normalizedVal = val;
        if (STRATEGY_BIN_KEYS.has(match[0])) {
          const numericVal = Number(val);
          if (!Number.isFinite(numericVal)) {
            throw new Error(`${match[0]} must be a finite number`);
          }
          normalizedVal = Math.max(MIN_SAFE_BINS_BELOW, Math.round(numericVal));
        } else {
          normalizedVal = normalizeConfigValue(match[0], val);
        }
        applied[match[0]] = normalizedVal;
      } catch (error) {
        return { success: false, error: error.message, key: match[0], reason };
      }
    }

    if (unknown.length > 0 || Object.keys(applied).length === 0) {
      log("config", `update_config failed — unknown keys: ${JSON.stringify(unknown)}, raw changes: ${JSON.stringify(changes)}`);
      return { success: false, unknown, reason };
    }

    let userConfig = {};
    if (fs.existsSync(USER_CONFIG_PATH)) {
      try {
        userConfig = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
      } catch (error) {
        return { success: false, error: `Invalid user-config.json: ${error.message}`, reason };
      }
    }

    // Auto-scale fee/volume when timeframe changes (unless user set them explicitly in same call).
    if (applied.timeframe != null && applied.minFeeActiveTvlRatio == null && applied.minVolume == null) {
      const tf = normalizeTimeframe(applied.timeframe);
      applied.timeframe = tf;
      const scaled = scaleScreeningToTimeframe(tf);
      applied.minFeeActiveTvlRatio = scaled.minFeeActiveTvlRatio;
      applied.minVolume = scaled.minVolume;
      applied._timeframeScaled = true;
      log("config", `timeframe ${tf} → auto-scaled minFeeActiveTvlRatio=${scaled.minFeeActiveTvlRatio}, minVolume=${scaled.minVolume}`);
    }

    // Plan all target leaves before touching either the in-memory config or
    // user-config.json. Locked rollout leaves must reject the whole request,
    // not leave earlier valid keys partially applied.
    const plannedValues = new Map();
    const planTarget = (section, field, value, key) => {
      const target = config[section];
      if (!target || typeof target !== "object") {
        throw new Error(`config.${section} is unavailable for ${key}`);
      }
      const targetKey = `${section}.${field}`;
      if (plannedValues.has(targetKey) && !Object.is(plannedValues.get(targetKey).value, value)) {
        throw new Error(`${key} conflicts with another requested value for config.${targetKey}`);
      }
      plannedValues.set(targetKey, { section, field, value, key });
    };
    const plannedValue = (section, field) => plannedValues.get(`${section}.${field}`)?.value ?? config[section][field];

    try {
      for (const [key, val] of Object.entries(applied)) {
        if (key.startsWith("_")) continue;
        const [section, field] = CONFIG_MAP[key];
        planTarget(section, field, val, key);
      }
      if (
        applied.binsBelow != null ||
        applied.minBinsBelow != null ||
        applied.maxBinsBelow != null ||
        applied.defaultBinsBelow != null
      ) {
        const minBinsBelow = Math.max(MIN_SAFE_BINS_BELOW, Math.round(Number(plannedValue("strategy", "minBinsBelow") ?? MIN_SAFE_BINS_BELOW)));
        const maxBinsBelow = Math.max(minBinsBelow, Math.round(Number(plannedValue("strategy", "maxBinsBelow") ?? minBinsBelow)));
        const defaultBinsBelow = Math.max(
          minBinsBelow,
          Math.min(maxBinsBelow, Math.round(Number(plannedValue("strategy", "defaultBinsBelow") ?? maxBinsBelow))),
        );
        plannedValues.set("strategy.minBinsBelow", { section: "strategy", field: "minBinsBelow", value: minBinsBelow, key: "minBinsBelow" });
        plannedValues.set("strategy.maxBinsBelow", { section: "strategy", field: "maxBinsBelow", value: maxBinsBelow, key: "maxBinsBelow" });
        plannedValues.set("strategy.defaultBinsBelow", { section: "strategy", field: "defaultBinsBelow", value: defaultBinsBelow, key: "defaultBinsBelow" });
        if (applied.minBinsBelow != null) applied.minBinsBelow = minBinsBelow;
        if (applied.maxBinsBelow != null || applied.binsBelow != null) {
          applied.maxBinsBelow = maxBinsBelow;
          if (applied.binsBelow != null) applied.binsBelow = maxBinsBelow;
        }
        if (applied.defaultBinsBelow != null) applied.defaultBinsBelow = defaultBinsBelow;
      }
      if (
        applied.multiLayerLayers != null ||
        applied.multiLayerPrimaryStrategy != null ||
        applied.multiLayerSecondaryStrategy != null ||
        applied.multiLayerPrimaryPct != null ||
        applied.multiLayerSecondaryPct != null
      ) {
        const strategyAfterPlan = {
          ...config.strategy,
          multiLayerPrimaryStrategy: plannedValue("strategy", "multiLayerPrimaryStrategy"),
          multiLayerSecondaryStrategy: plannedValue("strategy", "multiLayerSecondaryStrategy"),
          multiLayerPrimaryPct: plannedValue("strategy", "multiLayerPrimaryPct"),
          multiLayerSecondaryPct: plannedValue("strategy", "multiLayerSecondaryPct"),
          multiLayerLayers: plannedValue("strategy", "multiLayerLayers"),
        };
        const layers = applied.multiLayerLayers ?? normalizeMultiLayerLayersFromStrategy(strategyAfterPlan);
        planTarget("strategy", "multiLayerLayers", layers, "multiLayerLayers");
        applied.multiLayerLayers = layers;
      }

      for (const { section, field, key } of plannedValues.values()) {
        const target = config[section];
        const descriptor = Object.getOwnPropertyDescriptor(target, field);
        if (descriptor?.writable === false || (!descriptor && !Object.isExtensible(target))) {
          throw new Error(`${key} targets locked config.${section}.${field}`);
        }
      }
    } catch (error) {
      return { success: false, error: error.message, reason };
    }

    // Persist a fully prepared copy before applying the already-validated
    // memory mutation. renameSync prevents a partially written config file.
    for (const [key, val] of Object.entries(applied)) {
      if (key.startsWith("_")) continue;
      const persistPath = CONFIG_MAP[key]?.[2];
      if (Array.isArray(persistPath) && persistPath.length > 0) {
        let target = userConfig;
        for (const part of persistPath.slice(0, -1)) {
          if (!target[part] || typeof target[part] !== "object" || Array.isArray(target[part])) {
            target[part] = {};
          }
          target = target[part];
        }
        target[persistPath[persistPath.length - 1]] = val;
      } else {
        userConfig[key] = val;
      }
    }
    userConfig._lastAgentTune = new Date().toISOString();
    const temporaryConfigPath = `${USER_CONFIG_PATH}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(temporaryConfigPath, JSON.stringify(userConfig, null, 2));
      fs.renameSync(temporaryConfigPath, USER_CONFIG_PATH);
    } catch (error) {
      try { fs.unlinkSync(temporaryConfigPath); } catch {}
      return { success: false, error: `Could not persist user-config.json: ${error.message}`, reason };
    }

    for (const { section, field, value } of plannedValues.values()) {
      const before = config[section][field];
      config[section][field] = value;
      log("config", `update_config: config.${section}.${field} ${before} → ${value} (verify: ${config[section][field]})`);
    }
    // Restart cron jobs if intervals changed
    const intervalChanged =
      applied.managementIntervalMin != null ||
      applied.screeningIntervalMin != null ||
      applied.pnlPollIntervalSec != null ||
      applied.pnlConfirmTicks != null ||
      applied.pnlProfitConfirmTicks != null ||
      applied.opportunityPollEnabled != null ||
      applied.opportunityPollIntervalSec != null;
    if (intervalChanged && _cronRestarter) {
      _cronRestarter();
      log("config", `Cron restarted — management: ${config.schedule.managementIntervalMin}m, screening: ${config.schedule.screeningIntervalMin}m, pnlPoll: ${config.pnl.pollIntervalSec}s`);
    }

    // Skip repeated volatility-driven interval changes; they are operational tuning, not reusable lessons.
    const lessonsKeys = Object.keys(applied).filter(
      k => !k.startsWith("_") && k !== "managementIntervalMin" && k !== "screeningIntervalMin"
    );
    if (lessonsKeys.length > 0) {
      const summary = lessonsKeys.map(k => `${k}=${applied[k]}`).join(", ");
      addLesson(`[SELF-TUNED] Changed ${summary} — ${reason}`, ["self_tune", "config_change"]);
    }

    log("config", `Agent self-tuned: ${JSON.stringify(applied)} — ${reason}`);
    return { success: true, applied, unknown, reason };
  },
};

// Tools that modify on-chain state (need extra safety checks)
const WRITE_TOOLS = new Set([
  "deploy_position",
  "claim_fees",
  "close_position",
  "swap_token",
  "reconcile_cleanup",
]);
const PROTECTED_TOOLS = new Set([
  ...WRITE_TOOLS,
  "self_update",
]);

// These are executor-owned limits, intentionally independent of configuration
// values or prompt-level instructions. `amount_y` and legacy `amount_sol` are
// human SOL units; deployPosition converts the accepted value to lamports.
const CANARY_DEPLOY_EXACT_SOL = LOCKED_CANARY.deployAmountSol;
const CANARY_MAX_LIVE_POSITIONS = LOCKED_CANARY.maxPositions;
const LIVE_POSITION_SOURCES = new Set(["rpc", "meteora"]);
// A just-confirmed DLMM position can take several seconds to appear in the
// portfolio/indexer path even though its position-bound transaction receipt is
// already available. Keep the global canary reservation held while we retry
// that read instead of converting a normal indexing delay into an INVALID
// lifecycle that disables every PnL exit.
const CANARY_DEPLOY_VISIBILITY_ATTEMPTS = 6;
const CANARY_DEPLOY_VISIBILITY_DELAY_MS = 1_000;
export const CLEANUP_EXECUTION_CONFIRMATION = "I CONFIRM ECONOMIC CLEANUP";
export const LIVE_CANARY_GUARD_RECONCILIATION_CONFIRMATION = "I CONFIRM LIVE CANARY GUARD RECONCILIATION";

// This object is intentionally module-private. It is distinct from the
// Telegram command capability and is the only authority cleanup-runtime
// accepts for execute:true.
const CLEANUP_RUNTIME_EXECUTION_CAPABILITY = Object.freeze({});
registerCleanupExecutionCapability(CLEANUP_RUNTIME_EXECUTION_CAPABILITY);

// Kept module-private: the exported claim primitive accepts only this object
// identity and independently rechecks authoritative lifecycle attribution.
const LIVE_CLAIM_EXECUTION_CAPABILITY = Object.freeze({});
registerLiveClaimExecutionCapability(LIVE_CLAIM_EXECUTION_CAPABILITY);

// A promise tail acts as an in-process mutex. The critical section starts
// before the live RPC position count and lasts through final outcome
// reconciliation, so two concurrent requests cannot both observe an empty
// canary slot while indexing lags.
let canaryDeployReservationTail = Promise.resolve();

let operatorCleanupCapability = null;
let operatorCanaryGuardCapability = null;
let automaticCleanupRetryCapability = null;
let automaticCleanupRetryInFlight = null;

function assertCapabilityObject(capability, label) {
  if (!capability || typeof capability !== "object") {
    throw new TypeError(`${label} must be a non-null object capability`);
  }
}

/**
 * Index's Telegram command handler owns this capability. Registration is
 * deliberately one-time so a later in-process caller cannot replace it.
 */
export function registerOperatorCleanupCapability(capability) {
  assertCapabilityObject(capability, "Operator cleanup capability");
  if (operatorCleanupCapability == null) {
    operatorCleanupCapability = capability;
    return;
  }
  if (operatorCleanupCapability !== capability) {
    throw new Error("Operator cleanup capability is already registered and cannot be replaced");
  }
}

/**
 * Bind index's management loop to the executor-owned automatic retry path.
 * The object identity is never placed in model tool arguments or definitions.
 */
export function registerAutomaticCleanupRetryCapability(capability) {
  assertCapabilityObject(capability, "Automatic cleanup retry capability");
  if (automaticCleanupRetryCapability == null) {
    automaticCleanupRetryCapability = capability;
    return;
  }
  if (automaticCleanupRetryCapability !== capability) {
    throw new Error("Automatic cleanup retry capability is already registered and cannot be replaced");
  }
}

function hasAutomaticCleanupRetryCapability(capability) {
  return automaticCleanupRetryCapability != null && capability === automaticCleanupRetryCapability;
}

/**
 * A distinct capability keeps the high-impact retained-guard release outside
 * model tool JSON and separate from routine breaker resume authority.
 */
export function registerOperatorCanaryGuardCapability(capability) {
  assertCapabilityObject(capability, "Operator canary guard capability");
  if (operatorCanaryGuardCapability == null) {
    operatorCanaryGuardCapability = capability;
    return;
  }
  if (operatorCanaryGuardCapability !== capability) {
    throw new Error("Operator canary guard capability is already registered and cannot be replaced");
  }
}

/**
 * Every effective live-canary deploy shares one durable resource, independent
 * of pool. If a canary anomaly cannot be written to the breaker, retaining
 * this lease is the restart-safe global deploy block.
 */
export async function withLiveCanaryDeployGuard({
  effectiveRolloutMode = config.rollout?.mode,
  dryRun = isEffectiveDryRun(),
  run,
  operationKey = LIVE_CANARY_DEPLOY_GUARD_RESOURCE,
} = {}) {
  if (typeof run !== "function") throw new TypeError("Live canary deploy guard requires a run function");
  if (effectiveRolloutMode !== "canary" || dryRun) return run(null);
  return withLifecycleOperation({ operation: "deploy", operationKey }, run);
}

function hasOperatorCleanupCapability(capability) {
  return operatorCleanupCapability != null && capability === operatorCleanupCapability;
}

function hasOperatorCanaryGuardCapability(capability) {
  return operatorCanaryGuardCapability != null && capability === operatorCanaryGuardCapability;
}

/**
 * Serialize effective live-canary deploys. The injected boundary and runner
 * make the concurrency contract directly testable without an RPC call.
 */
export async function withCanaryDeployReservation({
  effectiveRolloutMode = config.rollout?.mode,
  dryRun = isEffectiveDryRun(),
  checkEntry = null,
  checkBoundary = () => checkCanaryDeployBoundary(),
  run,
} = {}) {
  if (typeof run !== "function") throw new TypeError("Canary deploy reservation requires a run function");
  if (effectiveRolloutMode !== "canary" || dryRun) {
    return run({ pass: true, applied: false });
  }

  let release;
  const previous = canaryDeployReservationTail;
  const current = new Promise((resolve) => { release = resolve; });
  canaryDeployReservationTail = previous.then(() => current, () => current);
  await previous;
  try {
    if (typeof checkEntry === "function") {
      let entry;
      try {
        entry = await checkEntry();
      } catch (error) {
        return {
          blocked: true,
          reason: `Canary deploy reservation could not verify circuit-breaker entry permission: ${error.message}`,
        };
      }
      if (!entry?.pass) {
        return {
          blocked: true,
          reason: entry?.reason || "Circuit breaker is tripped or requires manual resume; deploy_position is blocked.",
        };
      }
    }
    const boundary = await checkBoundary();
    if (!boundary?.pass) {
      return {
        blocked: true,
        reason: boundary?.reason || "Canary deploy reservation could not verify the live position boundary.",
      };
    }
    return await run(boundary);
  } finally {
    release();
  }
}

/**
 * Model JSON never receives the private capability. The Telegram handler must
 * first match the exact confirmation phrase, then invoke this wrapper.
 * `cleanupExecutor` exists only for isolated boundary tests.
 */
export async function executeConfirmedCleanup({
  position,
  confirmation,
  operatorCapability = null,
  dependencies = null,
  cleanupExecutor = executeLeasedLifecycleCleanup,
} = {}) {
  if (confirmation !== CLEANUP_EXECUTION_CONFIRMATION) {
    return {
      blocked: true,
      reason: "Cleanup execution requires the exact operator confirmation phrase.",
    };
  }
  if (!hasOperatorCleanupCapability(operatorCapability)) {
    return {
      blocked: true,
      reason: "Cleanup execution requires the registered Telegram operator capability.",
    };
  }
  if (!position) {
    return { blocked: true, reason: "reconcile_cleanup requires a single position." };
  }
  return cleanupExecutor({
    position,
    dependencies,
    executionCapability: CLEANUP_RUNTIME_EXECUTION_CAPABILITY,
  });
}

/**
 * Private post-close authority. It is reachable only from the confirmed close
 * finalizer below; model JSON and public Telegram cleanup commands never
 * receive the runtime capability object.
 */
async function executeAutomaticPostCloseCleanup({ position, dependencies = null } = {}) {
  return executeLeasedLifecycleCleanup({
    position,
    dependencies,
    executionCapability: CLEANUP_RUNTIME_EXECUTION_CAPABILITY,
  });
}

/**
 * Retry eligible cleanup lifecycles sequentially under the existing private
 * runtime capability. A retry result is operational evidence, never a deploy
 * gate: callers may log failures and continue their normal management cycle.
 */
export async function retryPendingLifecycleCleanups({
  retryCapability = null,
  dependencies = {},
} = {}) {
  if (!hasAutomaticCleanupRetryCapability(retryCapability)) {
    return {
      success: false,
      blocked: "AUTOMATIC_CLEANUP_RETRY_CAPABILITY_REQUIRED",
      attempted: 0,
      results: [],
    };
  }
  const dryRun = dependencies.isEffectiveDryRun || isEffectiveDryRun;
  if (dryRun()) {
    return { success: true, skipped: true, reason: "DRY_RUN", attempted: 0, results: [] };
  }
  if (automaticCleanupRetryInFlight) {
    return {
      success: true,
      skipped: true,
      reason: "AUTOMATIC_CLEANUP_RETRY_ALREADY_RUNNING",
      attempted: 0,
      results: [],
    };
  }

  const run = (async () => {
    const store = dependencies.store || getTradeLedger();
    const listPending = dependencies.listPendingCleanupLifecycles || listPendingCleanupLifecycles;
    const executeCleanup = dependencies.executeLeasedLifecycleCleanup || executeLeasedLifecycleCleanup;
    let eligible;
    try {
      eligible = listPending({ store });
    } catch (error) {
      return {
        success: false,
        attempted: 0,
        results: [],
        error: `Could not enumerate pending cleanup lifecycles: ${error.message}`,
      };
    }
    const results = [];
    for (const lifecycle of eligible) {
      const position = String(lifecycle?.position || "");
      if (!position) {
        results.push({ success: false, position: null, error: "Pending cleanup lifecycle has no position" });
        continue;
      }
      try {
        const result = await executeCleanup({
          position,
          dependencies: dependencies.cleanupDependencies || null,
          executionCapability: CLEANUP_RUNTIME_EXECUTION_CAPABILITY,
        });
        results.push({ position, lifecycle_id: lifecycle.lifecycle_id, result, success: result?.success === true });
      } catch (error) {
        log("cleanup_retry_error", `Automatic cleanup retry ${position}: ${error.message}`);
        results.push({
          position,
          lifecycle_id: lifecycle.lifecycle_id,
          success: false,
          blocked: error?.code || "AUTOMATIC_CLEANUP_RETRY_FAILED",
          error: error.message,
        });
      }
    }
    return {
      success: results.every((item) => item.success === true),
      attempted: results.length,
      settled: results.filter((item) => item.result?.finalization?.lifecycle?.state === "SETTLED").length,
      failed: results.filter((item) => item.success !== true).length,
      results,
    };
  })();
  automaticCleanupRetryInFlight = run;
  try {
    return await run;
  } finally {
    if (automaticCleanupRetryInFlight === run) automaticCleanupRetryInFlight = null;
  }
}

/**
 * Status is read-only and deliberately exposes only the exact operation id an
 * operator must repeat in the reconciliation command. A malformed lease or
 * journal is reported as unavailable, never as safe to release.
 */
export function getLiveCanaryDeployGuardStatus({ dependencies = {} } = {}) {
  const inspectGuard = dependencies.getRetainedLifecycleOperationLeaseStatus || getRetainedLifecycleOperationLeaseStatus;
  try {
    const status = inspectGuard({
      operation: "deploy",
      operationKey: LIVE_CANARY_DEPLOY_GUARD_RESOURCE,
      ...(dependencies.store ? { store: dependencies.store } : {}),
      ...(dependencies.directory ? { directory: dependencies.directory } : {}),
      ...(dependencies.fsImpl ? { fsImpl: dependencies.fsImpl } : {}),
    });
    return status.held
      ? {
          held: true,
          operation_id: status.lease.operation_id,
          resource: status.resource,
          acquired_at: status.lease.acquired_at,
          retention_evidence: status.guard_retention_count,
          prior_resolution_evidence: status.guard_resolution_count,
          journal_event_count: status.journal_event_count,
        }
      : {
          held: false,
          resource: status.resource,
        };
  } catch (error) {
    return {
      held: null,
      resource: LIVE_CANARY_DEPLOY_GUARD_RESOURCE,
      error: `Could not inspect retained live-canary deploy guard: ${error.message}`,
      code: error?.code || null,
    };
  }
}

/**
 * A retained global guard has no trustworthy cached position identity after a
 * breaker-write failure. It is therefore releasable only when a fresh
 * authoritative enumeration proves zero live positions. A present position,
 * malformed count, or unsupported source remains deliberately unresolved.
 */
export async function checkRetainedLiveCanaryDeployGuardOutcome({
  listLivePositions = getMyPositions,
  observedAt = () => new Date(),
} = {}) {
  let livePositions;
  try {
    livePositions = await listLivePositions({ force: true, silent: true });
  } catch (error) {
    return {
      pass: false,
      reason: `Could not obtain a fresh authoritative on-chain outcome for the retained canary guard: ${error.message}`,
    };
  }
  if (livePositions?.error || livePositions?.source !== "rpc" || !Array.isArray(livePositions?.positions) ||
      !Number.isSafeInteger(livePositions?.total_positions) || livePositions.total_positions < 0 ||
      livePositions.total_positions !== livePositions.positions.length) {
    return {
      pass: false,
      reason: "Fresh authoritative RPC on-chain outcome for the retained canary guard is malformed or unavailable.",
    };
  }
  if (livePositions.total_positions !== 0) {
    return {
      pass: false,
      reason: "A live on-chain position is still present, so the retained canary deploy outcome is unresolved and the global guard remains blocked.",
      live_position_count: livePositions.total_positions,
      position_source: livePositions.source,
    };
  }
  let observedAtIso;
  try {
    observedAtIso = new Date(observedAt()).toISOString();
  } catch (error) {
    return {
      pass: false,
      reason: `Fresh authoritative canary outcome timestamp is invalid: ${error.message}`,
    };
  }
  return {
    pass: true,
    outcome: {
      outcome: "no_live_canary_positions",
      observation_source: livePositions.source,
      observed_at: observedAtIso,
      live_position_count: 0,
    },
  };
}

/**
 * Operator-only resolution for the retained global canary guard. It performs
 * no submission and never follows breaker resume automatically: the caller
 * must provide the exact lease id, confirmation phrase, and private Telegram
 * capability on every attempt.
 */
export async function reconcileLiveCanaryDeployGuard({
  guardOperationId,
  confirmation,
  operatorCapability = null,
  dependencies = {},
} = {}) {
  if (confirmation !== LIVE_CANARY_GUARD_RECONCILIATION_CONFIRMATION) {
    return {
      success: false,
      blocked: true,
      reconciliation_required: true,
      reason: "Live-canary guard release requires the exact operator reconciliation confirmation phrase.",
    };
  }
  if (!hasOperatorCanaryGuardCapability(operatorCapability)) {
    return {
      success: false,
      blocked: true,
      reconciliation_required: true,
      reason: "Live-canary guard release requires the registered Telegram operator capability.",
    };
  }
  const exactOperationId = String(guardOperationId || "").trim();
  if (!exactOperationId || /[\r\n]/.test(exactOperationId)) {
    return {
      success: false,
      blocked: true,
      reconciliation_required: true,
      reason: "Live-canary guard release requires the exact retained guard operation id from /canaryguard.",
    };
  }

  const reconcileGuard = dependencies.reconcileRetainedLifecycleOperationLease || reconcileRetainedLifecycleOperationLease;
  const verifyGuardOutcome = dependencies.checkRetainedLiveCanaryDeployGuardOutcome || checkRetainedLiveCanaryDeployGuardOutcome;
  const recordBreaker = dependencies.recordCircuitBreakerEvent || recordCircuitBreakerEvent;
  try {
    const reconciliation = await reconcileGuard({
      operation: "deploy",
      operationKey: LIVE_CANARY_DEPLOY_GUARD_RESOURCE,
      operationId: exactOperationId,
      ...(dependencies.store ? { store: dependencies.store } : {}),
      ...(dependencies.directory ? { directory: dependencies.directory } : {}),
      ...(dependencies.fsImpl ? { fsImpl: dependencies.fsImpl } : {}),
      ...(dependencies.durable != null ? { durable: dependencies.durable } : {}),
      ...(dependencies.now ? { now: dependencies.now } : {}),
      verifyOutcome: async () => {
        const outcome = await verifyGuardOutcome({
          listLivePositions: dependencies.listLivePositions || getMyPositions,
          ...(dependencies.observedAt ? { observedAt: dependencies.observedAt } : {}),
        });
        if (!outcome?.pass) throw new Error(outcome?.reason || "Fresh authoritative canary outcome is unresolved.");
        return outcome.outcome;
      },
      persistBeforeRelease: async ({ lease, retention, outcome }) => recordBreaker({
        // The reducer preserves an unknown reconciliation event as a durable,
        // idempotent audit mutation without clearing any existing breaker latch.
        type: "canary_guard_reconciled",
        eventId: `canary-guard-reconciled:${lease.operation_id}:${retention.retention_id}`,
        operation_id: lease.operation_id,
        resource: lease.resource,
        outcome: outcome.outcome,
        atMs: Date.now(),
      }),
    });
    return {
      success: true,
      released: true,
      operation_id: reconciliation.operation_id,
      resource: reconciliation.resource,
      outcome: reconciliation.resolution.outcome,
      observed_at: reconciliation.resolution.observed_at,
      message: "Retained global live-canary deploy guard reconciled, audited, and securely released. Breaker state remains governed separately by /breaker resume.",
    };
  } catch (error) {
    log("canary_guard_reconciliation_block", `live-canary guard remains retained: ${error.message}`);
    return {
      success: false,
      blocked: true,
      reconciliation_required: true,
      reason: error.message,
      code: error?.code || null,
    };
  }
}

/** A close, claim, or swap dry-run is a preview, never an executed success.
 * Paper deployment remains a valid successful paper lifecycle. */
export function isToolExecutionSuccess(name, result) {
  if (!result || typeof result !== "object") return false;
  if (name === "deploy_position") {
    if (result.dry_run === true) {
      return typeof result.paper_position === "string" && result.paper_position.trim().length > 0 &&
        result.success !== false && !result.error && !result.blocked && result.reconciliation_required !== true;
    }
    const receipts = deployReceiptSignatures(result);
    return result.success === true &&
      typeof result.position === "string" && result.position.trim().length > 0 &&
      receipts.length > 0 &&
      !result.error && !result.blocked && result.reconciliation_required !== true;
  }
  const basicSuccess = result?.success !== false && !result?.error && !result?.blocked;
  if (!basicSuccess) return false;
  if (["close_position", "claim_fees"].includes(name) && result?.reconciliation_required === true) return false;
  if (name === "close_position" && !hasTerminalCloseReceipt(result)) return false;
  if (result?.dry_run === true && ["close_position", "claim_fees", "swap_token"].includes(name)) return false;
  return true;
}

export function isExecutedTransactionSuccess(name, result) {
  return result?.dry_run !== true && isToolExecutionSuccess(name, result);
}

/**
 * Actual receipt basis is used only for READY positions.  Any unresolved
 * position consumes risk solely through its explicit reservation field; this
 * prevents a requested amount or stale legacy basis from being reported as
 * deployed economics while still keeping sizing conservative.
 */
export function currentTrackedExposureSol(positions = []) {
  return (Array.isArray(positions) ? positions : []).reduce((sum, position) => {
    const localLamports = Number(position?.local_cost_basis_lamports);
    const reservationLamports = Number(position?.risk_reserved_lamports ?? position?.requested_deploy_lamports);
    const amountSol = position?.basis_status === "READY" && Number.isFinite(localLamports) && localLamports > 0
      ? localLamports / 1e9
      : Number.isFinite(reservationLamports) && reservationLamports > 0
        ? reservationLamports / 1e9
        : 0;
    return sum + (Number.isFinite(amountSol) && amountSol > 0 ? amountSol : 0);
  }, 0);
}

function forceReconciliationRequired(result, reason) {
  Object.assign(result, {
    success: false,
    blocked: true,
    reconciliation_required: true,
    reason,
  });
  return result;
}

function hasTerminalCloseReceipt(result) {
  return Array.isArray(result?.close_txs) && result.close_txs
    .some((signature) => typeof signature === "string" && signature.trim().length > 0);
}

function applySettledCloseEconomics(result, cleanup, {
  updateCloseMetrics = recordCloseSolMetrics,
} = {}) {
  const lifecycle = cleanup?.finalization?.lifecycle;
  const settlement = cleanup?.finalization?.settlement ?? lifecycle?.settlement;
  const basisLamports = Number(lifecycle?.cost_basis?.usable_basis_lamports);
  const equityNetLamports = Number(settlement?.wallet_equity_net_lamports);
  if (lifecycle?.state !== "SETTLED" || !Number.isSafeInteger(basisLamports) || basisLamports <= 0 ||
      !Number.isSafeInteger(equityNetLamports)) {
    return false;
  }
  const deployedSol = basisLamports / 1e9;
  const pnlSol = equityNetLamports / 1e9;
  const finalSol = (basisLamports + equityNetLamports) / 1e9;
  const pnlPct = equityNetLamports / basisLamports * 100;
  const walletBeforeDeploy = Number(result.wallet_sol_before_deploy);
  const walletAfterCleanup = Number.isFinite(walletBeforeDeploy)
    ? walletBeforeDeploy + pnlSol
    : null;
  Object.assign(result, {
    pnl_usd: pnlSol,
    pnl_sol: pnlSol,
    pnl_pct: pnlPct,
    position_sol_deployed: deployedSol,
    position_sol_final: finalSol,
    position_sol_pnl: pnlSol,
    position_sol_pnl_pct: Math.round(pnlPct * 100) / 100,
    ...(walletAfterCleanup != null ? { wallet_sol_after_cleanup: walletAfterCleanup } : {}),
    wallet_sol_roundtrip_delta_after_cleanup: pnlSol,
    settlement_pnl_source: "trade_ledger_wallet_equity_net",
  });
  updateCloseMetrics(result.position, {
    position_sol_deployed: deployedSol,
    position_sol_final: finalSol,
    position_sol_pnl: pnlSol,
    position_sol_pnl_pct: Math.round(pnlPct * 100) / 100,
    ...(walletAfterCleanup != null ? { wallet_sol_after_cleanup: walletAfterCleanup } : {}),
    wallet_sol_roundtrip_delta_after_cleanup: pnlSol,
    settlement_pnl_source: "trade_ledger_wallet_equity_net",
  });
  return true;
}

/**
 * Enforce the live-canary cap at the final executor boundary. The source must
 * enumerate current on-chain positions; local tracked/paper state is never
 * consulted because it can be stale or simulated.
 */
export async function checkCanaryDeployBoundary({
  args = {},
  effectiveRolloutMode = config.rollout?.mode,
  listLivePositions = getMyPositions,
} = {}) {
  if (effectiveRolloutMode !== "canary") {
    return { pass: true, applied: false };
  }

  const requestedAmounts = [
    ["amount_y", args.amount_y],
    ["amount_sol", args.amount_sol],
  ].filter(([, amount]) => amount != null);
  const selectedAmount = args.amount_y ?? args.amount_sol;
  const selectedAmountSol = Number(selectedAmount);

  if (requestedAmounts.length === 0 || !Number.isFinite(selectedAmountSol) || selectedAmountSol <= 0) {
    return {
      pass: false,
      reason: "Canary deploy requires one explicit positive SOL amount (amount_y or amount_sol).",
    };
  }

  for (const [field, amount] of requestedAmounts) {
    const amountSol = Number(amount);
    if (!Number.isFinite(amountSol) || amountSol <= 0) {
      return {
        pass: false,
        reason: `Canary deploy ${field} must be a finite positive SOL amount.`,
      };
    }
    if (amountSol !== CANARY_DEPLOY_EXACT_SOL) {
      return {
        pass: false,
        reason: `Canary deploy amount must equal exactly ${CANARY_DEPLOY_EXACT_SOL} SOL; received ${amountSol} SOL.`,
      };
    }
  }

  let livePositions;
  try {
    livePositions = await listLivePositions({ force: true, silent: true });
  } catch (error) {
    return {
      pass: false,
      reason: `Could not determine live on-chain position count for canary deploy: ${error.message}`,
    };
  }

  if (livePositions?.error) {
    return {
      pass: false,
      reason: `Could not determine live on-chain position count for canary deploy: ${livePositions.error}`,
    };
  }
  if (!LIVE_POSITION_SOURCES.has(livePositions?.source) || !Array.isArray(livePositions?.positions)) {
    return {
      pass: false,
      reason: "Could not verify a live on-chain position enumeration for canary deploy.",
    };
  }
  if (!Number.isSafeInteger(livePositions.total_positions) || livePositions.total_positions < 0 ||
      livePositions.total_positions !== livePositions.positions.length) {
    return {
      pass: false,
      reason: "Live on-chain position count was malformed or inconsistent; canary deploy is blocked.",
    };
  }
  if (livePositions.positions.length >= CANARY_MAX_LIVE_POSITIONS) {
    return {
      pass: false,
      reason: `Canary live-position limit (${CANARY_MAX_LIVE_POSITIONS}) reached. Close and confirm the existing position first.`,
    };
  }

  return {
    pass: true,
    applied: true,
    amount_sol: selectedAmountSol,
    live_position_count: livePositions.positions.length,
    position_source: livePositions.source,
  };
}

/**
 * A successful live-canary deploy is not final until its exact position is
 * visible in a fresh on-chain enumeration. This prevents a second request
 * from using an RPC indexing gap after the in-process reservation releases.
 */
export async function checkCanaryDeployOutcome({
  result,
  listLivePositions = getMyPositions,
  attempts = CANARY_DEPLOY_VISIBILITY_ATTEMPTS,
  retryDelayMs = CANARY_DEPLOY_VISIBILITY_DELAY_MS,
  wait = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
} = {}) {
  if (!isToolExecutionSuccess("deploy_position", result)) {
    const relaySubmittedWithoutPosition = result?.relay === true &&
      result?.reconciliation_required === true &&
      Array.isArray(result?.txs) && result.txs.some((signature) => typeof signature === "string" && signature.length > 0);
    return {
      pass: false,
      reason: relaySubmittedWithoutPosition
        ? "Relay submission returned transaction signatures but no verified position; durable reconciliation and manual resume are required."
        : "Canary deploy returned no unambiguous verified position and transaction receipt; durable reconciliation and manual resume are required.",
    };
  }

  const position = result.position.trim();
  const maxAttempts = Number.isSafeInteger(attempts) && attempts > 0
    ? attempts
    : CANARY_DEPLOY_VISIBILITY_ATTEMPTS;
  const delayMs = Number.isFinite(Number(retryDelayMs)) && Number(retryDelayMs) >= 0
    ? Number(retryDelayMs)
    : CANARY_DEPLOY_VISIBILITY_DELAY_MS;
  let lastFailureReason = "The deployed canary position was not uniquely visible in the fresh live enumeration.";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let livePositions;
    try {
      livePositions = await listLivePositions({ force: true, silent: true });
    } catch (error) {
      lastFailureReason = `Could not verify the deployed canary position in a fresh live enumeration: ${error.message}`;
      if (attempt < maxAttempts) {
        await wait(delayMs);
        continue;
      }
      break;
    }

    const validEnumeration = !livePositions?.error &&
      LIVE_POSITION_SOURCES.has(livePositions?.source) &&
      Array.isArray(livePositions?.positions) &&
      Number.isSafeInteger(livePositions?.total_positions) &&
      livePositions.total_positions >= 0 &&
      livePositions.total_positions === livePositions.positions.length;
    if (!validEnumeration) {
      lastFailureReason = "Could not verify the deployed canary position in a fresh live on-chain enumeration.";
    } else {
      const positionVisible = livePositions.positions.some((item) => item?.position === position);
      if (livePositions.positions.length === CANARY_MAX_LIVE_POSITIONS && positionVisible) {
        return {
          pass: true,
          position,
          live_position_count: livePositions.positions.length,
          position_source: livePositions.source,
          visibility_attempts: attempt,
        };
      }
      lastFailureReason = "The deployed canary position was not uniquely visible in the fresh live enumeration.";
    }

    if (attempt < maxAttempts) await wait(delayMs);
  }

  return {
    pass: false,
    reason: `${lastFailureReason} Retried ${maxAttempts} authoritative read(s); durable reconciliation and manual resume are required.`,
  };
}

/**
 * Latch the existing durable breaker when a canary submission cannot be
 * reconciled. The breaker is deliberately used instead of a second mutable
 * reservation state so a process restart cannot re-enable deployment.
 */
export async function finalizeCanaryDeployOutcome({
  result,
  listLivePositions = getMyPositions,
  recordBreakerEvent = recordCircuitBreakerEvent,
  canaryGuard = null,
  acquireGuard = () => acquireLifecycleOperation({
    operation: "deploy",
    operationKey: LIVE_CANARY_DEPLOY_GUARD_RESOURCE,
  }),
  recordGuardRetention = recordLifecycleOperationGuardRetention,
  retainGuard = retainLifecycleOperationLease,
  releaseGuard = releaseLifecycleOperation,
} = {}) {
  const outcome = await checkCanaryDeployOutcome({ result, listLivePositions });
  if (outcome.pass) return result;

  let breakerPersisted = true;
  let durableDeployBlockPersisted = false;
  let acquiredFallbackGuard = false;
  try {
    await recordBreakerEvent({
      type: "lifecycle_anomaly",
      kind: "partial",
      atMs: Date.now(),
    });
  } catch (error) {
    breakerPersisted = false;
    log("circuit_breaker_error", `Could not persist canary deploy reconciliation latch: ${error.message}`);
    let guard = canaryGuard;
    try {
      if (!guard) {
        guard = acquireGuard();
        acquiredFallbackGuard = true;
      }
      const retentionReason = `canary anomaly breaker write failed: ${error.message}`;
      // This append-only record is required before the guard may ever be
      // reconciled after restart. If it fails, retainGuard below still leaves
      // the O_EXCL lease in place and reconciliation will fail closed.
      recordGuardRetention(guard, { reason: retentionReason });
      retainGuard(guard, { reason: retentionReason });
      durableDeployBlockPersisted = true;
    } catch (guardError) {
      // A journal/validation failure is itself a reason to keep the global
      // lease. Do not let the wrapper's normal finally unlink this poison
      // record merely because its explanatory journal could not be written.
      try {
        if (guard) retainGuard(guard, {
          reason: `canary deploy guard retention failed closed: ${guardError.message}`,
        });
        if (guard) durableDeployBlockPersisted = true;
      } catch (retainError) {
        log("canary_guard_error", `Could not mark global live-canary guard retained: ${retainError.message}`);
      }
      log("canary_guard_error", `Could not retain global live-canary deploy guard: ${guardError.message}`);
    } finally {
      if (acquiredFallbackGuard && guard) {
        try { releaseGuard(guard); } catch (releaseError) {
          log("canary_guard_error", `Could not close retained global live-canary guard descriptor: ${releaseError.message}`);
        }
      }
    }
  }

  const original = result && typeof result === "object" ? result : {};
  return {
    ...original,
    success: false,
    blocked: true,
    reconciliation_required: true,
    error: original.error || outcome.reason,
    reason: outcome.reason,
    breaker_latch_persisted: breakerPersisted,
    durable_deploy_block_persisted: breakerPersisted || durableDeployBlockPersisted,
  };
}

function breakerOperationForTool(name) {
  if (name === "swap_token") return "swap";
  if (["deploy_position", "claim_fees", "close_position"].includes(name)) return "transaction";
  return null;
}

async function recordBreakerSafely(event, recordEvent = recordCircuitBreakerEvent) {
  try {
    await recordEvent(event);
  } catch (error) {
    log("circuit_breaker_error", `Could not persist ${event.type}: ${error.message}`);
  }
}

/**
 * Deployment is the circuit-breaker entry boundary for every caller of
 * executeTool, including the manual CLI path. Dry-run may inspect policy but
 * must not read-modify-write breaker state or emit an operational event.
 */
export async function checkDeployCircuitBreaker({
  dryRun = isEffectiveDryRun(),
  entryAllowed = circuitBreakerEntryAllowed,
} = {}) {
  if (dryRun) return { pass: true, dry_run: true };
  try {
    if (await entryAllowed()) return { pass: true };
    return {
      pass: false,
      reason: "Circuit breaker is tripped or requires manual resume; deploy_position is blocked.",
    };
  } catch (error) {
    return {
      pass: false,
      reason: `Could not verify circuit-breaker entry permission: ${error.message}`,
    };
  }
}

export function lifecycleReceiptTransactions(name, result = {}) {
  const claimSignatures = Array.isArray(result.claim_txs) && result.claim_txs.length > 0
    ? result.claim_txs
    : result.txs;
  const phases = name === "close_position"
    ? [
      [result.close_txs, "close"],
      [result.claim_txs, "claim"],
    ]
    : name === "claim_fees"
      ? [[claimSignatures, "claim"]]
      : [];
  const seen = new Set();
  return phases.flatMap(([signatures, phase]) => (Array.isArray(signatures) ? signatures : [])
    .filter((signature) => typeof signature === "string" && signature.trim())
    .filter((signature) => {
      if (seen.has(signature)) return false;
      seen.add(signature);
      return true;
    })
    .map((signature) => ({ signature, phase })));
}

export function deployReceiptSignatures(result = {}) {
  const seen = new Set();
  // Only these two deploy-result fields are receipt contracts. In particular,
  // do not treat `signature`, request IDs, errors, or arbitrary nested strings
  // as a confirmed transaction receipt.
  const candidates = [
    ...(Array.isArray(result.txs) ? result.txs : []),
    ...(typeof result.tx === "string" ? [result.tx] : []),
  ];
  return candidates
    .filter((signature) => typeof signature === "string" && signature.trim())
    .filter((signature) => {
      if (seen.has(signature)) return false;
      seen.add(signature);
      return true;
    });
}

function deployAmountSol(result = {}, args = {}) {
  const amount = args.amount_y ?? args.amount_sol ?? result.amount_y ?? result.amount_sol;
  return Number.isFinite(Number(amount)) && Number(amount) > 0 ? Number(amount) : null;
}

/** Receipt accounting is repeat-safe and happens even when the operation fails later. */
export async function recordLifecycleReceipts({
  name,
  result,
  walletAddress = getWalletPublicKey(),
  recordTransactions = recordLifecycleTransactions,
} = {}) {
  const transactions = lifecycleReceiptTransactions(name, result);
  if (!result?.position || result?.dry_run === true || transactions.length === 0) {
    return { lifecycle: null, transactions };
  }
  const lifecycle = await recordTransactions({
    position: result.position,
    walletAddress,
    transactions,
  });
  if (!lifecycle) throw new Error(`No authoritative lifecycle is available for ${result.position}`);
  return { lifecycle, transactions };
}

/** Live claims cannot proceed unless their receipts have one ledger lifecycle. */
export function checkExecutableClaimAttribution({
  position,
  getAttribution = requireLifecycleAttribution,
} = {}) {
  const attribution = getAttribution(position);
  return attribution?.pass
    ? attribution
    : {
      pass: false,
      reason: attribution?.reason || "Could not establish authoritative lifecycle attribution for live claim.",
    };
}

/**
 * The sole receipt/post-effect finalizer for deploy, claim, and close. It is
 * intentionally called for a partially failed result too, because confirmed
 * signatures still need attribution before the caller can safely retry.
 */
export async function finalizeLifecycleToolResult({
  name,
  result,
  args = {},
  dependencies = {},
} = {}) {
  if (!result || result.dry_run === true) return result;
  const walletPublicKey = dependencies.getWalletPublicKey || getWalletPublicKey;

  if (name === "deploy_position") {
    const txs = deployReceiptSignatures(result);
    const hasDeployReceipts = txs.length > 0;
    if (result.success === true && (!result.position || !hasDeployReceipts)) {
      return forceReconciliationRequired(
        result,
        "Deploy returned success without an authoritative position and confirmed transaction receipt set.",
      );
    }
    if (hasDeployReceipts && !result.position) {
      return forceReconciliationRequired(
        result,
        "Submitted deploy receipt signatures have no authoritative position identity and cannot be ledger-attributed; retain the existing durable deploy-operation/canary reconciliation guard before retry.",
      );
    }
    if (!result.position || !hasDeployReceipts) return result;

    const amountSol = deployAmountSol(result, args);
    if (amountSol == null) {
      return forceReconciliationRequired(
        result,
        "Deploy receipt signatures have a position identity but no positive requested SOL amount for authoritative basis reconciliation.",
      );
    }
    try {
      const recorderInput = {
        position: result.position,
        pool: result.pool || args.pool_address,
        amountSol,
        layers: Array.isArray(result.layers) ? result.layers : [],
        txs,
        walletAddress: walletPublicKey(),
        metadata: {
          relay: result.relay === true,
          result_reconciliation_required: result.reconciliation_required === true,
        },
        // A submitted-but-unresolved deploy may record its inspected receipts,
        // but cannot activate a lifecycle or promote a requested amount to
        // successful basis.
        allowActivation: result.success === true && result.reconciliation_required !== true && result.blocked !== true,
      };
      if (Object.hasOwn(result, "deploy_receipt_provenance")) {
        recorderInput.receiptProvenance = result.deploy_receipt_provenance;
      }
      const lifecycle = await (dependencies.recordDeployLifecycle || recordDeployLifecycle)(recorderInput);
      if (!lifecycle) {
        throw new Error(`No authoritative deploy lifecycle was recorded for ${result.position}`);
      }
      result.ledger = lifecycle;
      if (result.reconciliation_required === true || lifecycle.state === "RECONCILIATION_REQUIRED" || lifecycle.reconciliation_latched === true) {
        return forceReconciliationRequired(
          result,
          result.reason || `Deploy receipt reconciliation is required for ${result.position}; lifecycle activation is blocked.`,
        );
      }
      if (result.success === true && lifecycle.state !== "ACTIVE") {
        return forceReconciliationRequired(
          result,
          `Deploy receipts for ${result.position} did not reach ACTIVE after authoritative basis confirmation.`,
        );
      }
    } catch (error) {
      return forceReconciliationRequired(
        result,
        `Could not authoritatively record submitted deploy receipts for ${result.position}: ${error.message}`,
      );
    }
    return result;
  }

  if (!result.position || !["close_position", "claim_fees"].includes(name)) return result;
  const receipt = await recordLifecycleReceipts({
    name,
    result,
    walletAddress: walletPublicKey(),
    recordTransactions: dependencies.recordLifecycleTransactions || recordLifecycleTransactions,
  });
  if (receipt.lifecycle) result.ledger = receipt.lifecycle;

  if (result.reconciliation_required === true || receipt.lifecycle?.state === "RECONCILIATION_REQUIRED" || receipt.lifecycle?.reconciliation_latched === true) {
    return forceReconciliationRequired(
      result,
      result.reason || `Lifecycle reconciliation is required for ${result.position}; success and cleanup finalization are blocked.`,
    );
  }

  if (name === "claim_fees" && receipt.transactions.length > 0) {
    result.cleanup_pending = true;
    result.cleanup_note = "Claim residue remains pending scoped provenance reconciliation; no wallet-wide swap was submitted.";
  }

  if (name === "close_position" && result.success === true) {
    if (!hasTerminalCloseReceipt(result)) {
      return forceReconciliationRequired(
        result,
        "Close result has no confirmed terminal close receipt; cleanup finalization is blocked.",
      );
    }
    const markCloseCleanupPending = dependencies.markCleanupPending || markCleanupPending;
    const lifecycle = markCloseCleanupPending(result.position);
    if (!lifecycle || lifecycle.state !== "CLEANUP_PENDING") {
      throw new Error(`Could not transition ${result.position} to CLEANUP_PENDING after close`);
    }
    result.ledger = lifecycle;
    result.cleanup_pending = true;
    result.cleanup_note = "Post-close token cleanup entered durable scoped reconciliation.";

    const autoCleanup = dependencies.executeAutomaticPostCloseCleanup || executeAutomaticPostCloseCleanup;
    try {
      const cleanup = await autoCleanup({
        position: result.position,
        dependencies: dependencies.cleanupDependencies || null,
      });
      result.cleanup = cleanup;
      result.cleanup_pending = cleanup?.finalization?.lifecycle?.state !== "SETTLED";
      if (result.cleanup_pending) {
        result.cleanup_note = cleanup?.blocked
          ? `Post-close cleanup remains pending: ${cleanup.blocked}`
          : "Post-close cleanup remains pending for a safe retry/reconciliation.";
      } else {
        result.cleanup_note = "Post-close non-SOL residue was converted to SOL and the lifecycle settled.";
        applySettledCloseEconomics(result, cleanup, {
          updateCloseMetrics: dependencies.recordCloseSolMetrics || recordCloseSolMetrics,
        });
      }
    } catch (error) {
      // The close itself is already confirmed and durably recorded. Cleanup
      // failure must not rewrite that fact into a failed close or encourage a
      // second close submission; it remains visibly CLEANUP_PENDING.
      result.cleanup = {
        success: false,
        blocked: error?.code || "AUTOMATIC_POST_CLOSE_CLEANUP_FAILED",
        error: error.message,
      };
      result.cleanup_pending = true;
      result.cleanup_note = `Post-close cleanup remains pending: ${error.message}`;
      log("cleanup_error", `Automatic post-close cleanup ${result.position}: ${error.message}`);
    }

    // A note is advisory only; it is intentionally after durable receipt and
    // cleanup-state finalization and cannot change the operation outcome.
    if (args.reason && args.reason.toLowerCase().includes("yield")) {
      const poolAddr = result.pool || args.pool_address;
      if (poolAddr) {
        (dependencies.addPoolNote || addPoolNote)({
          pool_address: poolAddr,
          note: `Closed: low yield (fee/TVL below threshold) at ${new Date().toISOString().slice(0, 10)}`,
        }).catch?.(() => {});
      }
    }
  }
  return result;
}

/** Claim compatibility wrapper; delegates to the single finalization path. */
export async function applyClaimLifecyclePostEffects({ result, dependencies = {} } = {}) {
  return finalizeLifecycleToolResult({ name: "claim_fees", result, dependencies });
}

/** Close compatibility wrapper; delegates to the single finalization path. */
export async function applySuccessfulCloseLifecyclePostEffects({ result, args = {}, dependencies = {} } = {}) {
  return finalizeLifecycleToolResult({ name: "close_position", result, args, dependencies });
}

function lifecycleOperationKeyForTool(name, args = {}) {
  if (name === "deploy_position") {
    const pool = String(args.pool_address || "").trim();
    if (!pool) throw new TypeError("deploy_position requires pool_address for durable operation isolation");
    // One pool is one deploy resource during the locked rollout. This protects
    // separate processes before a new position address exists.
    return `deploy:${pool}`;
  }
  const position = String(args.position_address || "").trim();
  if (!position) throw new TypeError(`${name} requires position_address for durable operation isolation`);
  return position;
}

function completionMatchesCheckpoints(completion, checkpoints, { phase = null } = {}) {
  if (!completion || !Array.isArray(completion.expected_transactions)) return false;
  const actual = checkpoints
    .filter((checkpoint) => phase == null || checkpoint.phase === phase)
    .map((checkpoint) => `${checkpoint.phase}\u0000${checkpoint.signature}`);
  const expected = completion.expected_transactions
    .filter((transaction) => phase == null || transaction.phase === phase)
    .map((transaction) => `${transaction.phase}\u0000${transaction.signature}`);
  return actual.length === expected.length && new Set(actual).size === actual.length &&
    new Set(expected).size === expected.length && actual.every((key) => expected.includes(key));
}

function recoveredOperationRequiresReconciliation({ position, pool = null, claimTxs = [], closeTxs = [], reason }) {
  return {
    recovered: true,
    success: false,
    blocked: true,
    reconciliation_required: true,
    position,
    pool,
    claim_txs: claimTxs,
    close_txs: closeTxs,
    txs: [...claimTxs, ...closeTxs],
    reason,
  };
}

export function recoverLifecycleOperationResult(name, checkpoints = [], args = {}, recoveryEvidence = {}) {
  if (!Array.isArray(checkpoints) || checkpoints.length === 0) return null;
  const positions = [...new Set(checkpoints.map((checkpoint) => checkpoint?.position).filter(Boolean))];
  if (positions.length !== 1) {
    throw new Error(`Unfinished ${name} operation has ambiguous checkpoint positions`);
  }
  const position = positions[0];
  const phaseSignatures = (phase) => [...new Set(checkpoints
    .filter((checkpoint) => checkpoint.phase === phase)
    .map((checkpoint) => checkpoint.signature)
    .filter(Boolean))];
  const claimTxs = phaseSignatures("claim");
  const closeTxs = phaseSignatures("close");
  const deployTxs = phaseSignatures("deploy");
  const completions = Array.isArray(recoveryEvidence?.completions) ? recoveryEvidence.completions : [];
  const claimCompletion = completions.find((completion) => completion?.phase === "claim") || null;
  const closeCompletion = completions.find((completion) => completion?.phase === "close") || null;
  if (name === "deploy_position") {
    if (deployTxs.length === 0) throw new Error("Deploy checkpoint has no deploy signature");
    return {
      recovered: true,
      success: false,
      blocked: true,
      reconciliation_required: true,
      position,
      pool: args.pool_address,
      txs: deployTxs,
      reason: "Deploy checkpoints prove submitted receipts but cannot prove a complete deploy transaction set or authoritative basis; reconciliation is required.",
    };
  }
  if (name === "claim_fees") {
    if (claimTxs.length === 0) throw new Error("Claim checkpoint has no claim signature");
    if (!claimCompletion || !completionMatchesCheckpoints(claimCompletion, checkpoints, { phase: "claim" })) {
      return recoveredOperationRequiresReconciliation({
        position,
        claimTxs,
        reason: "Claim checkpoints prove only partial or uncompleted claim submission; durable completion evidence is required before recovery can succeed.",
      });
    }
    return {
      success: true,
      recovered: true,
      position,
      claim_txs: claimTxs,
      txs: claimTxs,
    };
  }
  if (name === "close_position") {
    if (closeTxs.length === 0 && claimTxs.length === 0) throw new Error("Close checkpoint has no position-bound signature");
    if (closeTxs.length === 0) {
      if (!claimCompletion || !completionMatchesCheckpoints(claimCompletion, checkpoints, { phase: "claim" })) {
        return recoveredOperationRequiresReconciliation({
          position,
          pool: args.pool_address || null,
          claimTxs,
          reason: "Recovered pre-close claim is incomplete or lacks durable completion evidence; close submission is blocked pending reconciliation.",
        });
      }
      return {
        recovered: true,
        resume_close: true,
        position,
        pool: args.pool_address || null,
        claim_txs: claimTxs,
        claim_completed: true,
        close_reason: args.reason || "agent decision",
      };
    }
    if (!closeCompletion || closeCompletion.position_absent !== true || !completionMatchesCheckpoints(closeCompletion, checkpoints)) {
      return recoveredOperationRequiresReconciliation({
        position,
        pool: args.pool_address || null,
        claimTxs,
        closeTxs,
        reason: "Close checkpoints do not prove the complete expected transaction set and fresh authoritative position absence; reconciliation is required.",
      });
    }
    return {
      success: true,
      recovered: true,
      position,
      pool: args.pool_address || null,
      claim_txs: claimTxs,
      close_txs: closeTxs,
      txs: [...claimTxs, ...closeTxs],
      close_reason: args.reason || "agent decision",
    };
  }
  return null;
}

async function executeWithDurableLifecycleOperation(name, args, run) {
  const operation = name === "deploy_position" ? "deploy" : name === "claim_fees" ? "claim" : "close";
  try {
    return await withLifecycleOperation({ operation, operationKey: lifecycleOperationKeyForTool(name, args) }, run);
  } catch (error) {
    log("lifecycle_operation_block", `${name} blocked: ${error.message}`);
    return {
      success: false,
      blocked: true,
      reconciliation_required: error?.code === "LIFECYCLE_OPERATION_LEASE_HELD" || error?.code === "LIFECYCLE_OPERATION_AMBIGUOUS",
      position: args.position_address,
      reason: error.message,
    };
  }
}

async function executeWithLiveCanaryDeployGuard(run) {
  try {
    return await withLiveCanaryDeployGuard({ run });
  } catch (error) {
    log("canary_guard_block", `deploy_position blocked: ${error.message}`);
    return {
      success: false,
      blocked: true,
      reconciliation_required: error?.code === "LIFECYCLE_OPERATION_LEASE_HELD" ||
        error?.code === "LIFECYCLE_OPERATION_AMBIGUOUS",
      reason: error.message,
    };
  }
}

// Tool arguments are ordinary JSON-shaped data. The executor may enrich them
// with locally verified market data and lifecycle context, so it must never
// mutate the caller's object. In particular, screening binds an exact deeply
// frozen request to its one-use local authority before entering this module.
function createMutableToolArgs(value, seen = new WeakMap()) {
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return seen.get(value);

  const copy = Array.isArray(value) ? [] : {};
  seen.set(value, copy);
  for (const [key, nestedValue] of Object.entries(value)) {
    // Define, rather than assign, every untrusted JSON key. Assignment to a
    // normal object invokes Object.prototype's __proto__ setter, which would
    // turn an own JSON field into attacker-controlled inherited data.
    Object.defineProperty(copy, key, {
      value: createMutableToolArgs(nestedValue, seen),
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  return copy;
}

/**
 * Execute a tool call with safety checks and logging.
 */
export async function executeTool(name, args = {}, dependencies = {}) {
  const startTime = Date.now();
  const recordToolBreaker = (event) => recordBreakerSafely(
    event,
    dependencies.recordCircuitBreakerEvent || recordCircuitBreakerEvent,
  );

  // Strip model artifacts like "<|channel|>commentary" appended to tool names
  name = name.replace(/<.*$/, "").trim();
  // All safety and execution work below uses this one internal mutable copy.
  // `args` remains the caller-owned value, including an immutable screening
  // request bound at createScreeningDeployBoundary.
  const workingArgs = createMutableToolArgs(args);

  // ─── Validate tool exists ─────────────────
  const fn = (dependencies.toolMap || toolMap)[name];
  if (!fn) {
    const error = `Unknown tool: ${name}`;
    log("error", error);
    return { error };
  }

  // A tool-call JSON object cannot carry the private operator capability used
  // by executeConfirmedCleanup. Even a literal execute:true is rejected here;
  // the model can only obtain the preview implementation in toolMap.
  if (name === "reconcile_cleanup" && workingArgs?.execute === true) {
    return {
      blocked: true,
      reason: "Cleanup execution is operator-only and requires the confirmed Telegram command.",
    };
  }

  // Recompute the raw replay source at the final generic executor boundary.
  // Every Telegram, TTY, CLI, agent, and in-process helper route that reaches
  // a deploy implementation passes here before that implementation is called.
  if (name === "deploy_position") {
    let paperGate;
    try {
      paperGate = (dependencies.getPaperDeploymentGate || getPaperDeploymentGate)();
    } catch (error) {
      paperGate = { pass: false, reason: `Could not evaluate raw replay paper-deploy gate: ${error.message}` };
    }
    if (!paperGate?.pass) {
      const reason = paperGate?.reason || "Historical replay coverage is required before a paper deploy.";
      log("safety_block", `${name} blocked: ${reason}`);
      return { blocked: true, reason, replay_gate: paperGate || null };
    }
  }

  // Deploy breaker permission is not the reservation itself. The latter begins
  // before the live-position count below and remains held through deployment.
  if (name === "deploy_position") {
    const breakerCheck = await checkDeployCircuitBreaker();
    if (!breakerCheck.pass) {
      log("safety_block", `${name} blocked: ${breakerCheck.reason}`);
      return { blocked: true, reason: breakerCheck.reason };
    }
  }

  const executeAfterSafetyChecks = async (reservation = {}, lifecycleOperation = null, canaryGuard = null) => {
    // ─── Pre-execution safety checks ──────────
    if (PROTECTED_TOOLS.has(name)) {
      const safetyCheck = await runSafetyChecks(name, workingArgs, dependencies);
      if (!safetyCheck.pass) {
        log("safety_block", `${name} blocked: ${safetyCheck.reason}`);
        return {
          blocked: true,
          reason: safetyCheck.reason,
        };
      }
    }

    // ─── Execute ──────────────────────────────
    try {
    if (name === "close_position" && !isEffectiveDryRun()) {
      const closingLifecycle = await (dependencies.beginCloseLifecycle || beginCloseLifecycle)(
        workingArgs.position_address,
        workingArgs.reason || "close requested",
      );
      if (!closingLifecycle) {
        return {
          success: false,
          blocked: true,
          position: workingArgs.position_address,
          reason: "No authoritative lifecycle is available to begin close.",
        };
      }
    }
    if (name === "claim_fees" && !isEffectiveDryRun()) {
      const attribution = checkExecutableClaimAttribution({ position: workingArgs.position_address });
      if (!attribution.pass) {
        log("safety_block", `claim_fees blocked: ${attribution.reason}`);
        return {
          success: false,
          blocked: true,
          position: workingArgs.position_address,
          reason: attribution.reason,
        };
      }
    }
    const recoveryEvidence = lifecycleOperation
      ? getLifecycleOperationRecoveryEvidence(lifecycleOperation)
      : { checkpoints: [], completions: [] };
    const checkpoints = recoveryEvidence.checkpoints;
    const recoveredResult = recoverLifecycleOperationResult(name, checkpoints, workingArgs, recoveryEvidence);
    workingArgs.lifecycleOperation = lifecycleOperation;
    if (recoveredResult?.resume_close === true) {
      workingArgs.recovery = {
        confirmedClaimTxs: recoveredResult.claim_txs,
        claimCompleted: recoveredResult.claim_completed === true,
      };
    }
    if (name === "claim_fees") workingArgs.executionCapability = LIVE_CLAIM_EXECUTION_CAPABILITY;
    const result = recoveredResult?.reconciliation_required === true || recoveredResult?.success === true
      ? recoveredResult
      : await fn(workingArgs);
    try {
      await finalizeLifecycleToolResult({ name, result, args: workingArgs, dependencies });
      const lifecycleSucceeded = isToolExecutionSuccess(name, result);
      if (lifecycleOperation && lifecycleSucceeded) {
        // A receipt-proven deploy is durably complete even if the separate
        // portfolio visibility check below is still lagging. Finalize this
        // pool-scoped operation now so a later close/redeploy cannot recover
        // and replay an already-confirmed deploy receipt.
        finalizeLifecycleOperation(lifecycleOperation, { position: result.position ?? workingArgs.position_address ?? null });
      }
      // Receipt accounting is the authoritative basis boundary and must run
      // before the eventually-consistent live-position visibility check. A
      // visibility lag may block another deploy, but it must never downgrade
      // a receipt-proven ACTIVE position to INVALID and disable SL/OOR exits.
      if (name === "deploy_position" && reservation.applied === true) {
        const canaryResult = await finalizeCanaryDeployOutcome({ result, canaryGuard });
        if (canaryResult !== result) Object.assign(result, canaryResult);
      }
    } catch (error) {
      result.success = false;
      result.accounting_error = error.message;
      result.reconciliation_required = true;
      log("ledger_error", `${name} lifecycle finalization failed: ${error.message}`);
    }
    const duration = Date.now() - startTime;
    const success = isToolExecutionSuccess(name, result);
    const breakerOperation = breakerOperationForTool(name);

    if (breakerOperation && !isEffectiveDryRun() && result?.dry_run !== true) {
      await recordToolBreaker({
        type: success ? "operation_success" : "operation_failure",
        operation: breakerOperation,
        atMs: Date.now(),
      });
    }

    logAction({
      tool: name,
      args: workingArgs,
      result: summarizeResult(result),
      duration_ms: duration,
      success,
    });

    if (success) {
      if (name === "swap_token" && result.tx) {
        notifySwap({ inputSymbol: workingArgs.input_mint?.slice(0, 8), outputSymbol: workingArgs.output_mint === "So11111111111111111111111111111111111111112" || workingArgs.output_mint === "SOL" ? "SOL" : workingArgs.output_mint?.slice(0, 8), amountIn: result.amount_in, amountOut: result.amount_out, tx: result.tx }).catch(() => {});
      } else if (name === "deploy_position") {
        notifyDeploy({ pair: result.pool_name || workingArgs.pool_name || workingArgs.pool_address?.slice(0, 8), amountSol: workingArgs.amount_y ?? workingArgs.amount_sol ?? 0, position: result.position, tx: result.txs?.[0] ?? result.tx, priceRange: result.price_range, rangeCoverage: result.range_coverage, binStep: result.bin_step, baseFee: result.base_fee }).catch(() => {});
      } else if (name === "close_position" && result?.dry_run !== true) {
        notifyClose({
          pair: result.pool_name || workingArgs.position_address?.slice(0, 8),
          pnlUsd: result.pnl_usd ?? 0,
          pnlPct: result.pnl_pct ?? 0,
          pnlSol: result.position_sol_pnl ?? result.pnl_sol,
          positionSolDeployed: result.position_sol_deployed,
          positionSolFinal: result.position_sol_final,
          walletSolBeforeDeploy: result.wallet_sol_before_deploy,
          walletSolAfterClose: result.wallet_sol_after_cleanup ?? result.wallet_sol_after_close,
          walletSolRoundtripDelta: result.wallet_sol_roundtrip_delta_after_cleanup ?? result.wallet_sol_roundtrip_delta,
          reason: result.close_reason || workingArgs.reason,
        }).catch(() => {});
      }
    }

      return result;
    } catch (error) {
    const duration = Date.now() - startTime;

    logAction({
      tool: name,
      args: workingArgs,
      error: error.message,
      duration_ms: duration,
      success: false,
    });
    const breakerOperation = breakerOperationForTool(name);
    if (breakerOperation && !isEffectiveDryRun()) {
      await recordToolBreaker({ type: "operation_failure", operation: breakerOperation, atMs: Date.now() });
    }

    // Return error to LLM so it can decide what to do
      return {
        error: error.message,
        tool: name,
      };
    }
  };

  if (name === "deploy_position") {
    return withCanaryDeployReservation({
      checkEntry: checkDeployCircuitBreaker,
      checkBoundary: () => checkCanaryDeployBoundary({ args: workingArgs }),
      run: (reservation) => isEffectiveDryRun()
        ? executeAfterSafetyChecks(reservation)
        : executeWithLiveCanaryDeployGuard((canaryGuard) => executeWithDurableLifecycleOperation(
          name,
          workingArgs,
          (operation) => executeAfterSafetyChecks(reservation, operation, canaryGuard),
        )),
    });
  }
  if (["claim_fees", "close_position"].includes(name) && !isEffectiveDryRun()) {
    return executeWithDurableLifecycleOperation(name, workingArgs, (operation) => executeAfterSafetyChecks({}, operation));
  }
  return executeAfterSafetyChecks();
}

/**
 * Run safety checks before executing write operations.
 */
async function runSafetyChecks(name, args, dependencies = {}) {
  switch (name) {
    case "deploy_position": {
      const validatePoolThresholds = dependencies.validateDeployPoolThresholds || validateDeployPoolThresholds;
      const poolThresholds = await validatePoolThresholds(args);
      if (!poolThresholds.pass) return poolThresholds;
      if (poolThresholds.entryMarketData) Object.assign(args, poolThresholds.entryMarketData);
      if (poolThresholds.policySnapshot) args.policy_snapshot = poolThresholds.policySnapshot;

      // Reject pools with bin_step out of configured range
      const minStep = config.screening.minBinStep;
      const maxStep = config.screening.maxBinStep;
      if (args.bin_step != null && (args.bin_step < minStep || args.bin_step > maxStep)) {
        return {
          pass: false,
          reason: `bin_step ${args.bin_step} is outside the allowed range of [${minStep}-${maxStep}].`,
        };
      }

      const deployAmountY = Number(args.amount_y ?? args.amount_sol ?? 0);
      const deployAmountX = Number(args.amount_x ?? 0);
      if (Number.isFinite(deployAmountX) && deployAmountX > 0) {
        return {
          pass: false,
          reason: "This agent only supports single-side SOL deploys. Use amount_y/amount_sol and keep amount_x=0.",
        };
      }
      const requestedBinsBelow = Number(args.bins_below ?? config.strategy.defaultBinsBelow ?? config.strategy.minBinsBelow);
      const requestedBinsAbove = Number(args.bins_above ?? config.strategy.upperBufferBins ?? 0);
      const strategyProfile = args.policy_snapshot?.strategyProfile ?? config.rollout.strategyProfile;
      const minBinsBelow = minimumBinsBelowForStrategyProfile({
        effectiveDryRun: isEffectiveDryRun(),
        effectiveRolloutMode: config.rollout.mode,
        rotationEnabled: config.shadowRotation.enabled,
        strategyProfile,
        rotationBinsBelow: config.shadowRotation.binsBelow,
        liveMinimumBinsBelow: Math.max(MIN_SAFE_BINS_BELOW, Number(config.strategy.minBinsBelow ?? MIN_SAFE_BINS_BELOW)),
      });
      const isSingleSidedSol = deployAmountY > 0 && deployAmountX <= 0;
      const requestedTotalBins = requestedBinsBelow + requestedBinsAbove;
      const authorizedRotationRange = isAuthorizedRotationRange({
        effectiveDryRun: isEffectiveDryRun(),
        effectiveRolloutMode: config.rollout.mode,
        rotationEnabled: config.shadowRotation.enabled,
        strategyProfile,
        strategy: args.strategy,
        binsBelow: requestedBinsBelow,
        binsAbove: requestedBinsAbove,
        rotationStrategy: config.shadowRotation.strategy,
        rotationBinsBelow: config.shadowRotation.binsBelow,
        rotationBinsAbove: config.shadowRotation.binsAbove,
      });
      const requestedVolatility = args.volatility == null ? null : Number(args.volatility);
      if (args.volatility != null && (!Number.isFinite(requestedVolatility) || requestedVolatility <= 0)) {
        return {
          pass: false,
          reason: `volatility ${args.volatility} is invalid. Refusing deploy because the volatility feed is unusable.`,
        };
      }
      if (
        args.downside_pct == null &&
        args.upside_pct == null &&
        (
          !Number.isFinite(requestedBinsBelow) ||
          !Number.isFinite(requestedBinsAbove) ||
          !Number.isInteger(requestedBinsBelow) ||
          !Number.isInteger(requestedBinsAbove) ||
          requestedBinsBelow < 0 ||
          requestedBinsAbove < 0 ||
          requestedTotalBins < minBinsBelow
        )
      ) {
        return {
          pass: false,
          reason: `deploy range ${requestedTotalBins} total bins is below minimum ${minBinsBelow}. Refusing 1-bin/tiny-range deploy.`,
        };
      }
      if (
        strategyProfile === SHADOW_ROTATION_STRATEGY_PROFILE &&
        String(args.strategy || "").trim() !== config.shadowRotation.strategy
      ) {
        return {
          pass: false,
          reason: `Shadow rotation requires strategy ${config.shadowRotation.strategy}; received ${args.strategy || "missing"}.`,
        };
      }
      if (
        strategyProfile === SHADOW_ROTATION_STRATEGY_PROFILE &&
        (
          requestedBinsBelow !== config.shadowRotation.binsBelow ||
          requestedBinsAbove !== config.shadowRotation.binsAbove
        )
      ) {
        return {
          pass: false,
          reason: `Shadow rotation requires centered range ${config.shadowRotation.binsBelow} below + ${config.shadowRotation.binsAbove} above; received ${requestedBinsBelow}+${requestedBinsAbove}.`,
        };
      }
      if (
        strategyProfile === SHADOW_ROTATION_STRATEGY_PROFILE &&
        !authorizedRotationRange
      ) {
        return {
          pass: false,
          reason: "Shadow rotation range does not satisfy the locked executable contract (at least 4 bins below and 5 total bins).",
        };
      }
      if (
        isSingleSidedSol &&
        args.downside_pct == null &&
        (!Number.isFinite(requestedBinsBelow) || !Number.isInteger(requestedBinsBelow) || requestedBinsBelow < minBinsBelow)
      ) {
        return {
          pass: false,
          reason: `bins_below ${args.bins_below ?? "missing"} is below minimum ${minBinsBelow}. Refusing 1-bin/tiny-range deploy.`,
        };
      }
      if (
        isSingleSidedSol &&
        args.upside_pct == null &&
        (!Number.isFinite(requestedBinsAbove) || !Number.isInteger(requestedBinsAbove) || requestedBinsAbove < 0)
      ) {
        return {
          pass: false,
          reason: "Single-side SOL deploy bins_above/upperBufferBins must be a non-negative whole-bin integer.",
        };
      }
      if (
        isSingleSidedSol &&
        requestedBinsAbove > 0 &&
        config.strategy.upperBufferDryRunOnly !== false &&
        !isEffectiveDryRun() &&
        !authorizedRotationRange
      ) {
        return {
          pass: false,
          reason: "upperBufferBins is currently dry-run only. Validate paper results before live use.",
        };
      }

      // Check position count limit + duplicate pool guard — force fresh scan to avoid stale cache
      const positions = await getMyPositions({ force: true });
      if (positions.total_positions >= config.risk.maxPositions) {
        return {
          pass: false,
          reason: `Max positions (${config.risk.maxPositions}) reached. Close a position first.`,
        };
      }
      const alreadyInPool = positions.positions.some(
        (p) => p.pool === args.pool_address
      );
      if (alreadyInPool) {
        return {
          pass: false,
          reason: `Already have an open position in pool ${args.pool_address}. Cannot open duplicate.`,
        };
      }

      // Block same base token across different pools
      if (args.base_mint) {
        const alreadyHasMint = positions.positions.some(
          (p) => p.base_mint === args.base_mint
        );
        if (alreadyHasMint) {
          return {
            pass: false,
            reason: `Already holding base token ${args.base_mint} in another pool. One position per token only.`,
          };
        }
      }

      // Check amount limits
      const amountY = deployAmountY;
      if (!Number.isFinite(amountY) || amountY <= 0) {
        return {
          pass: false,
          reason: `Must provide a positive SOL amount (amount_y).`,
        };
      }

      const minDeploy = Math.max(0.1, config.management.deployAmountSol);
      if (amountY < minDeploy) {
        return {
          pass: false,
          reason: `Amount ${amountY} SOL is below the minimum deploy amount (${minDeploy} SOL). Use at least ${minDeploy} SOL.`,
        };
      }
      if (amountY > config.risk.maxDeployAmount) {
        return {
          pass: false,
          reason: `SOL amount ${amountY} exceeds maximum allowed per position (${config.risk.maxDeployAmount}).`,
        };
      }

      // Rent-aware, exposure-aware sizing. Dry-run uses its configured virtual
      // starting equity; live execution always uses actual liquid SOL.
      const balance = await getWalletBalances();
      if (!isEffectiveDryRun() && (!balance || balance.error)) {
        return {
          pass: false,
          reason: `Authoritative wallet preflight failed: ${balance?.error || "wallet balance unavailable"}`,
        };
      }
      const sizingBalance = isEffectiveDryRun()
        ? Math.max(balance.sol, config.rollout.shadowInitialEquitySol)
        : balance.sol;
      const currentExposureSol = currentTrackedExposureSol(getTrackedPositions(true));
      const sizingDecision = calculateAdaptiveSizing({
        equitySol: sizingBalance,
        liquidSol: sizingBalance,
        quotedPositionRentSol: 0.05740608,
        missingAtaRentSol: 0.00203928,
        currentExposureSol,
        openPositionCount: positions.total_positions,
        // Shadow is an exact simulation of the only authorized live stage.
        // Keep both sides on the locked 0.20 SOL canary sizing boundary.
        canary: true,
      });
      if (!sizingDecision.eligible) {
        return {
          pass: false,
          reason: `Adaptive sizing blocked deploy: ${sizingDecision.reasons.join(", ")}`,
        };
      }
      if (Math.abs(amountY - sizingDecision.amountSol) > 1e-9) {
        return {
          pass: false,
          reason: `Deploy amount ${amountY} SOL does not match deterministic sizing ${sizingDecision.amountSol} SOL.`,
        };
      }

      return { pass: true };
    }

    case "swap_token": {
      // Basic check — prevent swapping when DRY_RUN is true
      // (handled inside swapToken itself, but belt-and-suspenders)
      return { pass: true };
    }

    case "reconcile_cleanup": {
      if (!args?.position) {
        return { pass: false, reason: "reconcile_cleanup requires a single position." };
      }
      if (args.execute === true && config.cleanup.enabled !== true) {
        return { pass: false, reason: "Economic cleanup is disabled by configuration." };
      }
      return { pass: true };
    }

    case "self_update": {
      if (process.env.ALLOW_SELF_UPDATE !== "true") {
        return {
          pass: false,
          reason: "self_update is disabled by default. Set ALLOW_SELF_UPDATE=true locally if you really want to enable it.",
        };
      }
      if (!process.stdin.isTTY) {
        return {
          pass: false,
          reason: "self_update is only allowed from a local interactive TTY session, not from Telegram or background automation.",
        };
      }
      return { pass: true };
    }

    default:
      return { pass: true };
  }
}

/**
 * Summarize a result for logging (truncate large responses).
 */
function summarizeResult(result) {
  const str = JSON.stringify(result);
  if (str.length > 1000) {
    return str.slice(0, 1000) + "...(truncated)";
  }
  return result;
}
