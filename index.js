import "./envcrypt.js";
import cron from "node-cron";
import readline from "readline";
import path from "path";
import { fileURLToPath } from "url";
import {
  agentLoop,
  createScreeningDeployBoundary,
  dispatchInteractiveDeployInput,
  resolveInteractiveDeployRoute,
  resolveTelegramConversationRoute,
} from "./agent.js";
import { log } from "./logger.js";
import { getMyPositions, getActiveBin, searchPools } from "./tools/dlmm.js";
import { getWalletBalances } from "./tools/wallet.js";
import { getTopCandidates, getPoolDetail, getPoolFeeWindow, degenScore, isNonCanonicalPvpRisk } from "./tools/screening.js";
import { config, enforceEffectiveRolloutEnvironment, getPaperDeploymentGate, isEffectiveDryRun, reloadScreeningThresholds, computeDeployAmount } from "./config.js";
import { evolveThresholds, getPerformanceSummary as getLearningPerformanceSummary } from "./lessons.js";
import {
  executeTool,
  executeConfirmedCleanup,
  CLEANUP_EXECUTION_CONFIRMATION,
  getLiveCanaryDeployGuardStatus,
  isExecutedTransactionSuccess,
  isToolExecutionSuccess,
  LIVE_CANARY_GUARD_RECONCILIATION_CONFIRMATION,
  reconcileLiveCanaryDeployGuard,
  registerAutomaticCleanupRetryCapability,
  registerOperatorCanaryGuardCapability,
  registerOperatorCleanupCapability,
  retryPendingLifecycleCleanups,
  registerCronRestarter,
} from "./tools/executor.js";
import {
  startPolling,
  stopPolling,
  sendMessage,
  sendMessageWithButtons,
  sendHTML,
  editMessage,
  editMessageWithButtons,
  answerCallbackQuery,
  notifyOutOfRange,
  isEnabled as telegramEnabled,
  createLiveMessage,
} from "./telegram.js";
import { generateBriefing } from "./briefing.js";
import {
  getSettlementPerformanceHistory,
  getSettlementPerformanceSummary,
} from "./settlement-report.js";
import { getLastBriefingDate, setLastBriefingDate, getTrackedPosition, getTrackedPositions, getOpenPaperPositions, getShadowRolloutEvidenceSnapshot, setPositionInstruction, updatePnlAndCheckExits, confirmPeak, registerExitSignal } from "./state.js";
import { recordPositionSnapshot, recallForPool, addPoolNote, setManualTokenCooldown } from "./pool-memory.js";
import { checkSmartWalletsOnPool } from "./smart-wallets.js";
import { getTokenNarrative, getTokenInfo } from "./tools/token.js";
import { bootstrapHiveMind, ensureAgentId, getHiveMindPullMode, isHiveMindEnabled, pullHiveMindLessons, pullHiveMindPresets, registerHiveMindAgent, startHiveMindBackgroundSync } from "./hivemind.js";
import { appendDecision } from "./decision-log.js";
import {
  clearCandidateObservation,
  getCandidateAdmissionRecovery,
  observeCandidateStability,
} from "./candidate-observations.js";
import {
  calculateAdaptiveSizing,
  candidatePolicyFromScreening,
  resolveShadowRotationRange,
  resolveEffectiveTakeProfitPct,
  selectDeterministicCandidate,
  SHADOW_ROTATION_STRATEGY_PROFILE,
} from "./risk-policy.js";
import {
  CIRCUIT_BREAKER_DURABILITY_REPAIR_CONFIRMATION,
  circuitBreakerEntryAllowed,
  getCircuitBreakerPersistenceStatus,
  getCircuitBreakerState,
  manuallyResumeCircuitBreaker,
  recordCircuitBreakerEvent,
  registerCircuitBreakerRepairOperatorCapability,
  repairCircuitBreakerDurability,
} from "./breaker-runtime.js";
import { runShadowLifecycleCycle } from "./shadow-lifecycle.js";
import { appendShadowEvidenceHeartbeat } from "./rollout-evidence.js";
import { getTradeLedger } from "./ledger-runtime.js";
import {
  listPendingCleanupLifecycles,
  previewPendingCleanupEquity,
  projectSettledLifecycleOutcomes,
} from "./cleanup-runtime.js";
import { attemptAutomaticCircuitBreakerResume } from "./automatic-breaker-resume.js";

import { REPO_ROOT, repoPath } from "./repo-root.js";

// envcrypt loads before this module body but can run after config's dependency
// evaluation. Re-assert the private effective stage before any index path can
// branch on dry-run behavior or invoke a tool.
enforceEffectiveRolloutEnvironment();

const entrypointPath = process.env.pm_exec_path || process.argv[1];
const indexPath = fileURLToPath(import.meta.url);
const isMain = process.env.pm_id != null
  || (entrypointPath ? path.resolve(entrypointPath) === indexPath : false);

if (isMain) {
  log("startup", "DLMM LP Agent starting...");
  log("startup", `Repo: ${REPO_ROOT} | cwd: ${process.cwd()}${process.env.pm_id ? ` | PM2 id: ${process.env.pm_id}` : ""}`);
  if (path.resolve(process.cwd()) !== path.resolve(REPO_ROOT)) {
    log("startup_warn", `process.cwd() differs from repo root — use "npm run pm2:start" (not "pm2 start index.js" from another directory)`);
  }
  log("startup", `Effective mode: ${isEffectiveDryRun() ? "DRY RUN" : "LIVE CANARY"}`);
  log("startup", `Model: ${process.env.LLM_MODEL || "hermes-3-405b"}`);
  if (!isEffectiveDryRun()) {
    try {
      const projection = projectSettledLifecycleOutcomes();
      if (projection.recorded > 0) {
        log("startup", `Projected ${projection.recorded} authoritative settlement(s) into operational pool memory`);
      }
      if (!projection.success) {
        log(
          "startup_warn",
          `Could not project ${projection.failures.length}/${projection.attempted} authoritative settlement(s): ` +
            projection.failures.map((failure) => `${failure.lifecycle_id || failure.position || "unknown"}: ${failure.error}`).join("; "),
        );
      }
    } catch (error) {
      // Projection is a derived operational index. The authoritative ledger is
      // still intact, so report the degraded memory view without killing the
      // autonomous runtime during startup.
      log("startup_warn", `Settlement memory startup projection failed: ${error.message}`);
    }
  }
  if (isHiveMindEnabled()) {
    ensureAgentId();
    bootstrapHiveMind().catch((error) => log("hivemind_warn", `Bootstrap failed: ${error.message}`));
    startHiveMindBackgroundSync();
  } else {
    log("hivemind", "Disabled by the locked rollout baseline");
  }
}

const TP_PCT = config.management.takeProfitPct;
const DEPLOY = config.management.deployAmountSol;

async function attachComparableFeeWindows(positions = [], readFeeWindow = getPoolFeeWindow) {
  if (
    config.rollout.strategyProfile !== SHADOW_ROTATION_STRATEGY_PROFILE ||
    typeof readFeeWindow !== "function"
  ) {
    return positions;
  }

  return Promise.all(positions.map(async (position) => {
    const tracked = getTrackedPosition(position?.position);
    const entryFee = Number(tracked?.initial_fee_tvl_ratio);
    const timeframe = String(tracked?.fee_timeframe || "").trim().toLowerCase();
    const ageMinutes = Number(position?.age_minutes);
    const reviewMinutes = Math.max(1, Number(config.management.thesisReviewMinutes ?? 20));
    if (
      !position?.pool ||
      !Number.isFinite(entryFee) || entryFee <= 0 ||
      !timeframe ||
      (Number.isFinite(ageMinutes) && ageMinutes < reviewMinutes)
    ) {
      return position;
    }

    let metric = null;
    try {
      metric = await readFeeWindow({
        pool_address: position.pool,
        timeframe,
      });
    } catch {
      metric = null;
    }
    return metric ? { ...position, ...metric } : position;
  }));
}

// This identity stays inside the real Telegram command handler. The executor
// records it once, then requires the same object alongside the public phrase.
const TELEGRAM_CLEANUP_OPERATOR_CAPABILITY = Object.freeze({});
registerOperatorCleanupCapability(TELEGRAM_CLEANUP_OPERATOR_CAPABILITY);
// Separate from Telegram/operator execution authority: this identity is held
// only by the deterministic management loop and accepted only by executor's
// scoped pending-cleanup retry API.
const AUTOMATIC_CLEANUP_RETRY_CAPABILITY = Object.freeze({});
registerAutomaticCleanupRetryCapability(AUTOMATIC_CLEANUP_RETRY_CAPABILITY);
const TELEGRAM_CANARY_GUARD_OPERATOR_CAPABILITY = Object.freeze({});
registerOperatorCanaryGuardCapability(TELEGRAM_CANARY_GUARD_OPERATOR_CAPABILITY);
// This capability is intentionally private to the Telegram operator command
// boundary. It is never supplied to LLM/provider tools or tool definitions.
const TELEGRAM_BREAKER_REPAIR_OPERATOR_CAPABILITY = Object.freeze({});
registerCircuitBreakerRepairOperatorCapability(TELEGRAM_BREAKER_REPAIR_OPERATOR_CAPABILITY);
// ═══════════════════════════════════════════
//  CYCLE TIMERS
// ═══════════════════════════════════════════
const timers = {
  managementLastRun: null,
  screeningLastRun: null,
};

function nextRunIn(lastRun, intervalMin) {
  if (!lastRun) return intervalMin * 60;
  const elapsed = (Date.now() - lastRun) / 1000;
  return Math.max(0, intervalMin * 60 - elapsed);
}

function formatCountdown(seconds) {
  if (seconds <= 0) return "now";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function buildPrompt() {
  const mgmt = formatCountdown(nextRunIn(timers.managementLastRun, config.schedule.managementIntervalMin));
  const scrn = formatCountdown(nextRunIn(timers.screeningLastRun, config.schedule.screeningIntervalMin));
  return `[manage: ${mgmt} | screen: ${scrn}]\n> `;
}

// ═══════════════════════════════════════════
//  CRON DEFINITIONS
// ═══════════════════════════════════════════
let _cronTasks = [];
let _managementBusy = false; // prevents overlapping management cycles
let _screeningBusy = false;  // prevents overlapping screening cycles
let _screeningLastTriggered = 0; // epoch ms — prevents management from spamming screening
let _screeningQueuedWhileBusy = false; // coalesce repeated trigger attempts while a screening run is active
// Exit/peak confirmation is now done by consecutive-tick counting in state.js
// (registerExitSignal / confirmPeak), driven by the 3s RPC poller — no setTimeout rechecks.

function getPositionCounts(positionResult = null) {
  const onChain = Number(positionResult?.total_positions ?? positionResult?.positions?.length ?? 0);
  const tracked = getTrackedPositions(true).length;
  const paper = isEffectiveDryRun() ? getOpenPaperPositions().length : 0;
  return {
    onChain: Number.isFinite(onChain) ? onChain : 0,
    tracked,
    paper,
    effective: Math.max(Number.isFinite(onChain) ? onChain : 0, tracked, paper),
    hasSettlingTracked: tracked > (Number.isFinite(onChain) ? onChain : 0),
  };
}

/** Strip <think>...</think> reasoning blocks that some models leak into output */
function stripThink(text) {
  if (!text) return text;
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

function finiteOrNull(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function nonNegativeFiniteOrNull(value) {
  const n = finiteOrNull(value);
  return n != null && n >= 0 ? n : null;
}

function stablecoinCashUsd(wallet) {
  const tokens = Array.isArray(wallet?.tokens) ? wallet.tokens : [];
  const supported = [
    { mint: config.tokens.USDC, fallbackBalance: wallet?.usdc },
    { mint: config.tokens.USDT, fallbackBalance: wallet?.usdt },
  ];
  let totalUsd = 0;
  for (const { mint, fallbackBalance } of supported) {
    const token = tokens.find((entry) => entry?.mint === mint);
    const balance = nonNegativeFiniteOrNull(token?.balance) ?? nonNegativeFiniteOrNull(fallbackBalance) ?? 0;
    const markedUsd = nonNegativeFiniteOrNull(token?.usd_raw);
    totalUsd += markedUsd != null && (markedUsd > 0 || balance === 0) ? markedUsd : balance;
  }
  return totalUsd;
}

export function calculateCanaryEquitySol({
  wallet,
  positions,
  pendingCleanupEquity = null,
  solMode = config.management.solMode,
} = {}) {
  if (!wallet || wallet.error) {
    return { ok: false, reason: `Wallet valuation unavailable${wallet?.error ? `: ${wallet.error}` : ""}.` };
  }
  const walletSol = nonNegativeFiniteOrNull(wallet.sol);
  if (walletSol == null) return { ok: false, reason: "Wallet SOL balance is unavailable or invalid." };
  if (!Array.isArray(positions)) return { ok: false, reason: "Open LP positions are unavailable for equity valuation." };

  const solPrice = nonNegativeFiniteOrNull(wallet.sol_price);
  const stablecoinUsd = stablecoinCashUsd(wallet);
  if (stablecoinUsd > 0 && !(solPrice > 0)) {
    return { ok: false, reason: "Stablecoin cash cannot be converted to SOL because the SOL price is unavailable." };
  }
  const stablecoinSol = stablecoinUsd > 0 ? stablecoinUsd / solPrice : 0;
  const pendingCleanupSol = pendingCleanupEquity == null
    ? 0
    : nonNegativeFiniteOrNull(pendingCleanupEquity?.total_sol);
  if (pendingCleanupEquity != null && (pendingCleanupEquity?.ok !== true || pendingCleanupSol == null)) {
    return {
      ok: false,
      reason: `Pending cleanup residue cannot be valued conservatively${pendingCleanupEquity?.reason ? `: ${pendingCleanupEquity.reason}` : ""}.`,
    };
  }
  let openLpSol = 0;
  let unclaimedFeeSol = 0;
  for (const position of positions) {
    const directSol = nonNegativeFiniteOrNull(position?.total_value_sol);
    const nativeValue = solMode === true ? nonNegativeFiniteOrNull(position?.total_value_usd) : null;
    const usdValue = nonNegativeFiniteOrNull(position?.total_value_true_usd);
    let valueSol = directSol ?? nativeValue;
    if (valueSol == null && usdValue != null && solPrice != null && solPrice > 0) {
      valueSol = usdValue / solPrice;
    }
    if (valueSol == null) {
      return { ok: false, reason: `Open LP ${position?.position || "unknown"} cannot be valued conservatively in SOL.` };
    }
    openLpSol += valueSol;

    const directFeeSol = nonNegativeFiniteOrNull(position?.unclaimed_fees_sol);
    const nativeFeeValue = solMode === true ? nonNegativeFiniteOrNull(position?.unclaimed_fees_usd) : null;
    const usdFeeValue = nonNegativeFiniteOrNull(position?.unclaimed_fees_true_usd);
    let feeSol = directFeeSol ?? nativeFeeValue;
    if (feeSol == null && usdFeeValue != null && solPrice != null && solPrice > 0) {
      feeSol = usdFeeValue / solPrice;
    }
    const feeFieldsAbsent = !Object.hasOwn(position || {}, "unclaimed_fees_sol") &&
      !Object.hasOwn(position || {}, "unclaimed_fees_usd") &&
      !Object.hasOwn(position || {}, "unclaimed_fees_true_usd");
    if (feeSol == null && feeFieldsAbsent) feeSol = 0;
    if (feeSol == null) {
      return { ok: false, reason: `Open LP ${position?.position || "unknown"} unclaimed fees cannot be valued conservatively in SOL.` };
    }
    unclaimedFeeSol += feeSol;
  }
  return {
    ok: true,
    wallet_sol: walletSol,
    stablecoin_cash_usd: stablecoinUsd,
    stablecoin_cash_sol: stablecoinSol,
    open_lp_sol: openLpSol,
    unclaimed_fee_sol: unclaimedFeeSol,
    // Wallet valuation above counts native SOL plus USDC/USDT only. Non-stable
    // lifecycle residue is therefore absent and this scoped mark is not a
    // duplicate of Helius' informational wallet.tokens USD fields.
    pending_cleanup_sol: pendingCleanupSol,
    pending_cleanup_lifecycle_count: pendingCleanupEquity?.lifecycle_count ?? 0,
    equity_sol: walletSol + stablecoinSol + openLpSol + unclaimedFeeSol + pendingCleanupSol,
  };
}

export async function observeLiveCanaryEquity({
  positions,
  wallet,
  effectiveRolloutMode = isEffectiveDryRun() ? "dry_run" : "canary",
  dryRun = isEffectiveDryRun(),
  getWallet = getWalletBalances,
  listPendingCleanups = listPendingCleanupLifecycles,
  previewPendingCleanupEquityFn = previewPendingCleanupEquity,
  cleanupEquityDependencies = {},
  recordBreakerEvent = recordCircuitBreakerEvent,
  solMode = config.management.solMode,
  hasCanaryExposure = Array.isArray(positions) && positions.length > 0,
  atMs = Date.now(),
} = {}) {
  if (effectiveRolloutMode !== "canary" || dryRun) {
    return { observed: false, skipped: true, reason: "NOT_EFFECTIVE_LIVE_CANARY" };
  }
  let pendingCleanupLifecycles;
  try {
    pendingCleanupLifecycles = listPendingCleanups({ store: cleanupEquityDependencies.store || getTradeLedger() });
  } catch (error) {
    return {
      observed: false,
      entryBlocked: true,
      transientError: true,
      error: `Canary equity is unavailable: pending cleanup lifecycle discovery failed: ${error.message}`,
    };
  }
  // Wallet-wide idle cash flows are not canary PnL. Pending cleanup is still
  // unsettled canary exposure even after its DLMM position has disappeared.
  if (hasCanaryExposure !== true && pendingCleanupLifecycles.length === 0) {
    return { observed: false, skipped: true, reason: "NO_CANARY_EXPOSURE" };
  }

  let currentWallet = wallet;
  if (!currentWallet) {
    try {
      currentWallet = await getWallet();
    } catch (error) {
      currentWallet = { error: error.message };
    }
  }
  let pendingCleanupEquity = {
    ok: true,
    total_lamports: "0",
    total_sol: 0,
    lifecycle_count: 0,
    positions: [],
  };
  if (pendingCleanupLifecycles.length > 0) {
    try {
      pendingCleanupEquity = await previewPendingCleanupEquityFn({
        walletPublicKey: currentWallet?.wallet || null,
        lifecycles: pendingCleanupLifecycles,
        dependencies: cleanupEquityDependencies,
      });
    } catch (error) {
      pendingCleanupEquity = { ok: false, reason: error.message };
    }
  }
  const valuation = calculateCanaryEquitySol({
    wallet: currentWallet,
    positions,
    pendingCleanupEquity,
    solMode,
  });
  if (!valuation.ok) {
    // Provider uncertainty blocks entry for this cycle, but it is not proof of
    // financial loss and therefore must not permanently poison the breaker.
    return {
      observed: false,
      valuation,
      entryBlocked: true,
      transientError: true,
      error: `Canary equity is unavailable: ${valuation.reason}`,
    };
  }
  const event = { type: "canary_equity", equitySol: valuation.equity_sol, atMs };
  try {
    await recordBreakerEvent(event);
    return {
      observed: true,
      valuation,
      event,
      persistenceDiagnostic: getCircuitBreakerPersistenceStatus()?.diagnostic ?? null,
    };
  } catch (error) {
    // Persistence uncertainty is a deployment blocker. Returning an explicit
    // blocker lets management stop before it dispatches screening; callers
    // must never treat this as a best-effort telemetry failure.
    return {
      observed: false,
      valuation,
      persistenceError: true,
      error: `Could not record canary equity: ${error.message}`,
    };
  }
}

function currentExposureSol() {
  return getTrackedPositions(true).reduce((sum, position) => {
    const local = finiteOrNull(position.local_cost_basis_lamports);
    const reservation = finiteOrNull(position.risk_reserved_lamports ?? position.requested_deploy_lamports);
    // Keep the top-level adaptive-sizing guard aligned with executor: actual
    // exposure exists only once receipt basis is READY; unresolved positions
    // consume their explicitly named reservation, never a request/stale basis.
    const amount = position.basis_status === "READY" && local != null && local > 0
      ? local / 1e9
      : reservation != null && reservation > 0
        ? reservation / 1e9
        : 0;
    return sum + Math.max(0, amount ?? 0);
  }, 0);
}

function getAdaptiveSizingDecision(walletSol, openPositionCount = 0) {
  const sizingBalance = isEffectiveDryRun()
    ? Math.max(walletSol, config.rollout.shadowInitialEquitySol)
    : walletSol;
  return calculateAdaptiveSizing({
    equitySol: sizingBalance,
    liquidSol: sizingBalance,
    quotedPositionRentSol: 0.05740608,
    missingAtaRentSol: 0.00203928,
    currentExposureSol: currentExposureSol(),
    openPositionCount,
    // Both supported rollout stages are locked to the same 0.20 SOL exposure:
    // shadow must model the exact live canary boundary or its evidence can never
    // satisfy the rollout exposure gate.
    canary: true,
  });
}

function policyMomentum(indicator, interval) {
  const entry = indicator?.intervals?.find((item) => item.interval === interval);
  return {
    available: entry?.ok === true,
    supertrendDirection: String(entry?.signal?.supertrendDirection || "unknown").toLowerCase(),
    supertrendBreakUp: entry?.signal?.supertrendBreakUp === true,
    supertrendBreakDown: entry?.signal?.supertrendBreakDown === true,
    rsi: finiteOrNull(entry?.signal?.rsi),
    close: finiteOrNull(entry?.signal?.close),
    previousClose: finiteOrNull(entry?.signal?.previousClose),
    lowerBand: finiteOrNull(entry?.signal?.lowerBand),
    upperBand: finiteOrNull(entry?.signal?.upperBand),
  };
}

function toPolicyCandidate(candidate, evaluatedAtMs = Date.now(), requestedDeployUsd = null) {
  const { pool, sw, ti, stability } = candidate;
  const audit = ti?.audit || {};
  const observations = (stability?.observations || []).map((entry) => ({
    observedAtMs: Number(entry.observedAt),
    feeValue: Number(entry.feeActiveTvlRatio),
    volumeValue: Number(entry.volume),
    priceValue: Number(entry.price),
    binStepValue: Number(entry.binStep),
  }));
  return {
    strategyProfile: config.rollout.strategyProfile,
    poolAddress: pool.pool,
    pairType: "TOKEN-SOL",
    protocol: String(pool.pool_type || "dlmm").toUpperCase(),
    timeframeMinutes: 30,
    evaluatedAtMs,
    requestedDeployUsd: finiteOrNull(requestedDeployUsd),
    activeTvlUsd: finiteOrNull(pool.active_tvl ?? pool.tvl),
    volumeUsd: finiteOrNull(pool.volume_window ?? pool.volume),
    feeActiveTvlRatioPct: finiteOrNull(pool.fee_active_tvl_ratio),
    volatility: finiteOrNull(pool.volatility),
    binStep: finiteOrNull(pool.bin_step),
    organicScoreBase: finiteOrNull(pool.organic_score ?? pool.base?.organic),
    organicScoreQuote: finiteOrNull(pool.quote_organic_score ?? pool.quote?.organic),
    holderCount: finiteOrNull(ti?.holders ?? pool.holders),
    marketCapUsd: finiteOrNull(ti?.mcap ?? pool.mcap),
    tokenAgeHours: finiteOrNull(pool.token_age_hours),
    globalFeesSol: finiteOrNull(ti?.global_fees_sol),
    smartWalletCount: Number(sw?.in_pool?.length ?? 0),
    audit: {
      checkedAtMs: evaluatedAtMs,
      botHolderPct: finiteOrNull(audit.bot_holders_pct),
      top10Pct: finiteOrNull(audit.top_holders_pct),
      mintAuthorityDisabled: audit.mint_disabled === true,
      freezeAuthorityDisabled: audit.freeze_disabled === true,
      criticalWarning: pool.critical_warning === true,
      highConcentration: pool.high_supply_concentration === true,
      highSingleOwner: pool.high_single_owner === true,
      pvp: isNonCanonicalPvpRisk(pool),
      blocklisted: false,
    },
    momentum5m: policyMomentum(pool.indicator_confirmation, "5_MINUTE"),
    momentum15m: policyMomentum(pool.indicator_confirmation, "15_MINUTE"),
    observations,
    runtime: candidate,
  };
}

function parseVetoJson(content) {
  const text = String(content || "").trim();
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    if (typeof parsed.approved !== "boolean") return null;
    return {
      approved: parsed.approved,
      reason_code: String(parsed.reason_code || (parsed.approved ? "APPROVE" : "DATA_CONFLICT")).slice(0, 40),
      note: String(parsed.note || "").replace(/[\r\n]+/g, " ").slice(0, 300),
    };
  } catch {
    return null;
  }
}

async function requestAiVeto(policyCandidate) {
  try {
    const compact = {
      pool: policyCandidate.poolAddress,
      metrics: {
        tvl: policyCandidate.activeTvlUsd,
        volume30m: policyCandidate.volumeUsd,
        feeActiveTvlRatio: policyCandidate.feeActiveTvlRatioPct,
        volatility: policyCandidate.volatility,
        organicBase: policyCandidate.organicScoreBase,
        organicQuote: policyCandidate.organicScoreQuote,
        holders: policyCandidate.holderCount,
        mcap: policyCandidate.marketCapUsd,
      },
      audit: policyCandidate.audit,
      momentum5m: policyCandidate.momentum5m,
      momentum15m: policyCandidate.momentum15m,
    };
    const { content } = await agentLoop(`
You are a veto-only risk reviewer. Code has already selected the top candidate deterministically and all hard gates passed.
You MAY veto only for a concrete security risk, contradictory data, manipulation risk, or known event risk. You may not choose another pool, change sizing, strategy, or range.
Return JSON only:
{"approved":true|false,"reason_code":"APPROVE|SECURITY_RISK|DATA_CONFLICT|MANIPULATION_RISK|EVENT_RISK","note":"short evidence"}

CANDIDATE:
${JSON.stringify(compact)}
    `, 1, [], "SCREENER", config.llm.screeningModel, 300, {
      allowNoToolFinal: true,
      toolsOverride: [],
    });
    return parseVetoJson(content) || {
      approved: false,
      reason_code: "DATA_CONFLICT",
      note: "AI veto response was malformed; fail-closed.",
    };
  } catch (error) {
    return {
      approved: false,
      reason_code: "DATA_CONFLICT",
      note: `AI veto unavailable: ${error.message}`.slice(0, 300),
    };
  }
}

async function runBriefing() {
  log("cron", "Starting morning briefing");
  try {
    const briefing = await generateBriefing();
    if (telegramEnabled()) {
      await sendHTML(briefing);
    }
    setLastBriefingDate();
  } catch (error) {
    log("cron_error", `Morning briefing failed: ${error.message}`);
  }
}

/**
 * If the agent restarted after the 1:00 AM UTC cron window,
 * fire the briefing immediately on startup so it's never skipped.
 */
async function maybeRunMissedBriefing() {
  const todayUtc = new Date().toISOString().slice(0, 10);
  const lastSent = getLastBriefingDate();

  if (lastSent === todayUtc) return; // already sent today

  // Only fire if it's past the scheduled time (1:00 AM UTC)
  const nowUtc = new Date();
  const briefingHourUtc = 1;
  if (nowUtc.getUTCHours() < briefingHourUtc) return; // too early, cron will handle it

  log("cron", `Missed briefing detected (last sent: ${lastSent || "never"}) — sending now`);
  await runBriefing();
}

function stopCronJobs() {
  for (const task of _cronTasks) task.stop();
  if (_cronTasks._pnlPollInterval) clearInterval(_cronTasks._pnlPollInterval);
  if (_cronTasks._shadowMonitorInterval) clearInterval(_cronTasks._shadowMonitorInterval);
  if (_cronTasks._opportunityPollInterval) clearInterval(_cronTasks._opportunityPollInterval);
  _cronTasks = [];
}

/**
 * Execute the actions decided by the deterministic rules. CLOSE/CLAIM run directly
 * via executeTool (no LLM) — preserving all post-effects (notify,
 * recordPerformance, decision-log, HiveMind). Only INSTRUCTION positions, whose
 * free-text condition JS can't parse, are handed to the MANAGER LLM. Returns a
 * one-line-per-position result string.
 */
async function executeManagementActions(actionPositions, actionMap, { liveMessage = null, cur = "$" } = {}) {
  const lines = [];
  const instructionPositions = [];

  const mechanical = actionPositions.filter(p => actionMap.get(p.position).action !== "INSTRUCTION");
  if (mechanical.length) {
    log("cron", `Management: executing ${mechanical.length} mechanical action(s) — no LLM`);
  }

  for (const p of actionPositions) {
    const act = actionMap.get(p.position);
    if (act.action === "INSTRUCTION") { instructionPositions.push(p); continue; }

    if (act.action === "CLOSE") {
      const reason = act.reason || (act.rule ? `Rule ${act.rule}` : "rule close");
      await liveMessage?.toolStart("close_position");
      const res = await executeTool("close_position", { position_address: p.position, reason }).catch(e => ({ error: e.message }));
      const ok = isExecutedTransactionSuccess("close_position", res);
      await liveMessage?.toolFinish("close_position", res, ok);
      lines.push(`${p.pair}: ${ok ? `closed (${reason})` : res?.dry_run === true ? "close preview — no transaction submitted" : `close FAILED — ${res?.error || res?.reason || "unknown"}`}`);
    } else if (act.action === "CLAIM") {
      await liveMessage?.toolStart("claim_fees");
      const res = await executeTool("claim_fees", { position_address: p.position }).catch(e => ({ error: e.message }));
      const ok = isExecutedTransactionSuccess("claim_fees", res);
      await liveMessage?.toolFinish("claim_fees", res, ok);
      lines.push(`${p.pair}: ${ok ? "fees claimed" : res?.dry_run === true ? "claim preview — no transaction submitted" : `claim FAILED — ${res?.error || res?.reason || "unknown"}`}`);
    }
  }

  // INSTRUCTION positions need the LLM to evaluate the free-text condition.
  if (instructionPositions.length > 0) {
    log("cron", `Management: ${instructionPositions.length} instruction position(s) — invoking LLM [model: ${config.llm.managementModel}]`);
    const actionBlocks = instructionPositions.map((p) => [
      `POSITION: ${p.pair} (${p.position})`,
      `  pool: ${p.pool}`,
      `  pnl_pct: ${p.pnl_pct}% | unclaimed_fees: ${cur}${p.unclaimed_fees_usd} | value: ${cur}${p.total_value_usd} | fee_per_tvl_24h: ${p.fee_per_tvl_24h ?? "?"}%`,
      `  bins: lower=${p.lower_bin} upper=${p.upper_bin} active=${p.active_bin} | oor_minutes: ${p.minutes_out_of_range ?? 0}`,
      `  instruction: "${p.instruction}"`,
    ].join("\n")).join("\n\n");

    const { content } = await agentLoop(`
INSTRUCTION EVALUATION — ${instructionPositions.length} position(s)

${actionBlocks}

For each position, evaluate the instruction condition against the live data:
- If the condition is MET → call close_position (it claims fees internally; do NOT call claim_fees first).
- If NOT met → HOLD, do nothing.

After evaluating, write a brief one-line result per position.
    `, config.llm.maxSteps, [], "MANAGER", config.llm.managementModel, 2048, {
      onToolStart: async ({ name }) => { await liveMessage?.toolStart(name); },
      onToolFinish: async ({ name, result, success }) => { await liveMessage?.toolFinish(name, result, success); },
    });
    if (content) lines.push(content);
  }

  return lines.join("\n");
}

export async function runManagementCycle({ silent = false, dependencies = {} } = {}) {
  const runShadowLifecycleCycleFn = dependencies.runShadowLifecycleCycle ?? runShadowLifecycleCycle;
  const getShadowRolloutEvidenceSnapshotFn = dependencies.getShadowRolloutEvidenceSnapshot ?? getShadowRolloutEvidenceSnapshot;
  const getPaperDeploymentGateFn = dependencies.getPaperDeploymentGate ?? getPaperDeploymentGate;
  const getMyPositionsFn = dependencies.getMyPositions ?? getMyPositions;
  const observeLiveCanaryEquityFn = dependencies.observeLiveCanaryEquity ?? observeLiveCanaryEquity;
  const retryPendingLifecycleCleanupsFn = dependencies.retryPendingLifecycleCleanups ?? retryPendingLifecycleCleanups;
  const runScreeningCycleFn = dependencies.runScreeningCycle ?? runScreeningCycle;
  const isEffectiveDryRunFn = dependencies.isEffectiveDryRun ?? isEffectiveDryRun;
  const getPositionCountsFn = dependencies.getPositionCounts ?? getPositionCounts;
  const getPoolFeeWindowFn = dependencies.getPoolFeeWindow ?? getPoolFeeWindow;
  const attemptAutomaticCircuitBreakerResumeFn = dependencies.attemptAutomaticCircuitBreakerResume ?? attemptAutomaticCircuitBreakerResume;
  if (_managementBusy) return null;
  _managementBusy = true;
  timers.managementLastRun = Date.now();
  log("cron", "Starting management cycle");
  let mgmtReport = null;
  let positions = [];
  let liveMessage = null;
  const screeningCooldownMs = Math.max(1, Number(config.schedule.screeningIntervalMin ?? 3)) * 60 * 1000;

  try {
    if (!silent && telegramEnabled()) {
      liveMessage = await createLiveMessage("🔄 Management Cycle", "Evaluating positions...");
    }

    // Paper positions are managed on the normal management cadence, but never
    // through the live close executor path. The shadow lifecycle only reads active
    // bins, marks conservative SOL equity, confirms exits, and settles locally.
    if (isEffectiveDryRunFn()) {
      const shadow = await runShadowLifecycleCycleFn({
        getActiveBin,
        getFeeWindow: getPoolFeeWindowFn,
        managementConfig: config.management,
        pnlConfig: config.pnl,
      });
      // This is the sole source used by canary acceptance.  It is emitted on
      // the ordinary management cadence, after local paper valuations and
      // settlements, and contains no wallet or transaction data.
      const evidenceSnapshot = getShadowRolloutEvidenceSnapshotFn();
      if (evidenceSnapshot) {
        let breakerObservation = null;
        try {
          breakerObservation = await getCircuitBreakerState();
        } catch (error) {
          log("rollout_evidence_warn", `Breaker observation unavailable: ${error.message}`);
        }
        try {
          appendShadowEvidenceHeartbeat({
            filePath: config.rollout.shadowEvidenceFile,
            runId: evidenceSnapshot.run_id,
            rolloutStage: evidenceSnapshot.rollout_stage,
            strategyProfile: evidenceSnapshot.strategy_profile,
            lifecycles: evidenceSnapshot.lifecycles,
            cycle: {
              started_open_positions: shadow.started_open_positions,
              started_deployed_amount_sol: shadow.started_deployed_amount_sol,
              observation_failures: shadow.records
                .filter((record) => record.status === "observation_failed")
                .map((record) => ({ lifecycle_id: record.position, message: record.error })),
            },
            breaker: breakerObservation,
          });
        } catch (error) {
          // Failing closed is handled at config startup: without this primary
          // evidence a canary cannot be authorized. Management remains paper-only.
          log("rollout_evidence_error", `Shadow heartbeat was not persisted: ${error.message}`);
        }
      }
      const metrics = shadow.metrics;
      const metricsLine = `Paper lifecycle: ${metrics.completed_lifecycles} settled | open ${metrics.open_positions} | net ◎${Number(metrics.total_net_pnl_sol ?? 0).toFixed(6)} | estimated costs ◎${Number(metrics.total_estimated_cost_sol ?? 0).toFixed(6)}`;
      const shadowLines = shadow.report ? `${shadow.report}\n\n` : "";
      mgmtReport = `🧪 SHADOW MANAGEMENT\n\n${shadowLines}${metricsLine}`;
      log("cron", `Shadow management: observed ${shadow.observed}, settled ${shadow.settled}, failed ${shadow.failed}, open ${shadow.open_positions}`);
      await liveMessage?.note(mgmtReport).catch(() => {});

      // A settled paper position immediately frees the one-position shadow
      // capacity. Only then may the normal deterministic screener create the
      // next paper lifecycle.
      if (shadow.open_positions > 0) return mgmtReport;
      const paperDeployGate = getPaperDeploymentGateFn();
      if (!paperDeployGate.pass) {
        const coverage = paperDeployGate.historicalReplayCoverage;
        const blocked = `Historical replay gate ${coverage.actual}/${coverage.required} (${paperDeployGate.reason}); existing paper positions remain under observation, but new paper screening is locked.`;
        log("rollout_safety", blocked);
        return `${mgmtReport}\n\n${blocked}`;
      }
      if (_screeningBusy) {
        return `${mgmtReport}\n\nPaper capacity is open; screening is already running.`;
      }
      if (Date.now() - _screeningLastTriggered < screeningCooldownMs) {
        const secondsLeft = Math.ceil((screeningCooldownMs - (Date.now() - _screeningLastTriggered)) / 1000);
        return `${mgmtReport}\n\nPaper capacity is open; screening cooldown ${secondsLeft}s.`;
      }
      log("cron", "Shadow capacity is open — management triggering deterministic paper screening");
      runScreeningCycleFn().catch((error) => log("cron_error", `Triggered shadow screening failed: ${error.message}`));
      return `${mgmtReport}\n\nPaper capacity is open; management triggered screening.`;
    }

    let cleanupRetry = null;
    try {
      cleanupRetry = await retryPendingLifecycleCleanupsFn({
        retryCapability: AUTOMATIC_CLEANUP_RETRY_CAPABILITY,
        dependencies: dependencies.cleanupRetryDependencies || {},
      });
      if (cleanupRetry.attempted > 0) {
        log(
          cleanupRetry.success ? "cleanup_retry" : "cleanup_retry_warn",
          `Automatic cleanup retry: ${cleanupRetry.settled || 0} settled, ${cleanupRetry.failed || 0} pending/failed`,
        );
      } else if (cleanupRetry.error) {
        log("cleanup_retry_warn", cleanupRetry.error);
      }
    } catch (error) {
      // A lifecycle remains visibly CLEANUP_PENDING and will be retried later.
      // This path is deliberately not a deployment prohibition.
      cleanupRetry = { success: false, attempted: 0, error: error.message };
      log("cleanup_retry_error", `Automatic cleanup retry cycle failed: ${error.message}`);
    }

    const livePositions = await getMyPositionsFn({ force: true }).catch(() => null);
    positions = livePositions?.positions || [];
    const positionCounts = getPositionCountsFn(livePositions);
    const canaryEquity = await observeLiveCanaryEquityFn({
      positions: livePositions?.positions,
      hasCanaryExposure: positionCounts.effective > 0,
    });
    if (canaryEquity.persistenceError) {
      const blocker = `Management blocked — circuit breaker persistence uncertainty: ${canaryEquity.error}`;
      log("circuit_breaker", blocker);
      mgmtReport = blocker;
      return mgmtReport;
    }
    if (canaryEquity.persistenceDiagnostic) {
      log("circuit_breaker_warn", `Canary equity breaker state committed with cleanup diagnostic: ${canaryEquity.persistenceDiagnostic}`);
    }
    if (canaryEquity.error) {
      log("canary_equity_error", canaryEquity.error);
    } else if (canaryEquity.observed && !canaryEquity.valuation.ok) {
      log("canary_equity_warn", `Canary equity valuation failed closed: ${canaryEquity.valuation.reason}`);
    }
    if (canaryEquity.entryBlocked && positions.length === 0) {
      const blocker = `Management entry blocked for this cycle — ${canaryEquity.error}`;
      mgmtReport = blocker;
      return mgmtReport;
    }

    const automaticResume = await attemptAutomaticCircuitBreakerResumeFn({
      enabled: config.circuitBreaker.automaticResume,
      dryRun: isEffectiveDryRunFn(),
      effectiveRolloutMode: config.rollout.mode,
      livePositions,
      getTrackedPositions,
      getCircuitBreakerState,
      recordCircuitBreakerEvent,
      getTradeLedger,
      listPendingCleanupLifecycles,
      getLiveCanaryDeployGuardStatus,
      appendAudit: appendDecision,
      cooldownMs: config.circuitBreaker.automaticResumeCooldownMs,
    });
    if (automaticResume.resumed === true) {
      log(
        "circuit_breaker_auto_resume",
        `Breaker automatically resumed after clean zero-exposure recovery ${automaticResume.recovery_id} ` +
        `(prior reasons: ${(automaticResume.prior_reasons || []).join(", ") || "none"})`,
      );
      if (automaticResume.auditDiagnostic) {
        log("circuit_breaker_auto_resume_warn", `Supplementary decision audit failed: ${automaticResume.auditDiagnostic}`);
      }
    } else if (automaticResume.persistenceError || automaticResume.error) {
      log(
        "circuit_breaker_auto_resume_warn",
        `Automatic breaker resume blocked (${automaticResume.blocked}): ${automaticResume.error || "state boundary unavailable"}`,
      );
    }

    if (positions.length === 0) {
      if (positionCounts.tracked > 0) {
        log("cron", `No indexed positions yet, but ${positionCounts.tracked} tracked position(s) still open — waiting before screening`);
        mgmtReport = `No indexed positions yet, but ${positionCounts.tracked} tracked position(s) still open. Waiting for indexer/RPC before screening.`;
        await liveMessage?.note(mgmtReport).catch(() => {});
        return mgmtReport;
      }
      if (_screeningBusy) {
        log("cron", "No open positions — screening already running; management will not trigger another cycle");
        mgmtReport = "No open positions. Screening already running.";
        await liveMessage?.note("No open positions — screening already running.").catch(() => {});
      } else if (Date.now() - _screeningLastTriggered < screeningCooldownMs) {
        const secondsLeft = Math.ceil((screeningCooldownMs - (Date.now() - _screeningLastTriggered)) / 1000);
        log("cron", `No open positions — screening cooldown active (${secondsLeft}s remaining)`);
        mgmtReport = `No open positions. Screening cooldown active for ${secondsLeft}s.`;
        await liveMessage?.note(mgmtReport).catch(() => {});
      } else {
        log("cron", "No open positions — management triggering screening cycle");
        mgmtReport = cleanupRetry?.attempted > 0 && cleanupRetry.success !== true
          ? "No open positions. Cleanup remains pending and will retry automatically; management is triggering screening cycle."
          : "No open positions. Management triggering screening cycle.";
        await liveMessage?.note("No open positions — management triggering screening.").catch(() => {});
        runScreeningCycleFn().catch((e) => log("cron_error", `Triggered screening failed: ${e.message}`));
      }
      return mgmtReport;
    }

    positions = await attachComparableFeeWindows(positions, getPoolFeeWindowFn);

    // Snapshot + load pool memory
    const positionData = positions.map((p) => {
      recordPositionSnapshot(p.pool, p);
      return { ...p, recall: recallForPool(p.pool) };
    });

    // JS exit checks. Management is the slow cron backstop. Profit/range exits
    // may act on its fresh observation, while normal loss and thesis exits share
    // the same multi-observation guard as the fast poller. Catastrophic remains
    // immediate regardless of which loop observes it first.
    const exitMap = new Map();
    for (const p of positionData) {
      if (!p.pnl_pct_suspicious) confirmPeak(p.position, p.projected_net_pnl_pct ?? p.pnl_pct, 1);
      const exit = updatePnlAndCheckExits(p.position, p, config.management);
      const guardedStop = exit?.action === "STOP_LOSS" || exit?.action === "THESIS_FAILURE";
      const requiredTicks = exit?.action === "CATASTROPHIC_STOP"
        ? 1
        : guardedStop
          ? Math.max(1, Number(config.pnl.stopConfirmTicks ?? 3))
          : 1;
      const confirmation = registerExitSignal(
        p.position,
        exit?.action || null,
        requiredTicks,
        exit?.confirmation_key ?? null,
      );
      if (exit && confirmation.fire) {
        exitMap.set(p.position, exit);
        log("state", `Exit alert for ${p.pair}: ${exit.reason}`);
      } else if (exit) {
        log("state", `Exit pending for ${p.pair}: ${exit.action} ${confirmation.count}/${requiredTicks}`);
      }
    }

    // ── Deterministic rule checks (no LLM) ──────────────────────────
    // action: CLOSE | CLAIM | STAY | INSTRUCTION (needs LLM)
    const actionMap = new Map();
    for (const p of positionData) {
      // Hard exit — highest priority
      if (exitMap.has(p.position)) {
        actionMap.set(p.position, { action: "CLOSE", rule: "exit", reason: exitMap.get(p.position).reason });
        continue;
      }
      // Instruction-set — pass to LLM, can't parse in JS
      if (p.instruction) {
        actionMap.set(p.position, { action: "INSTRUCTION" });
        continue;
      }

      const closeRule = getDeterministicCloseRule(p, config.management);
      if (closeRule) {
        actionMap.set(p.position, closeRule);
        continue;
      }
      // Claim rule
      if (config.management.periodicClaimEnabled && (p.unclaimed_fees_usd ?? 0) >= config.management.minClaimAmount) {
        actionMap.set(p.position, { action: "CLAIM" });
        continue;
      }
      actionMap.set(p.position, { action: "STAY" });
    }

    // ── Build JS report ──────────────────────────────────────────────
    const totalValue = positionData.reduce((s, p) => s + (p.total_value_usd ?? 0), 0);
    const totalUnclaimed = positionData.reduce((s, p) => s + (p.unclaimed_fees_usd ?? 0), 0);

    const reportLines = positionData.map((p) => {
      const act = actionMap.get(p.position);
      const inRange = p.in_range ? "🟢 IN" : `🔴 OOR ${p.minutes_out_of_range ?? 0}m`;
      const val = config.management.solMode ? `◎${p.total_value_usd ?? "?"}` : `$${p.total_value_usd ?? "?"}`;
      const unclaimed = config.management.solMode ? `◎${p.unclaimed_fees_usd ?? "?"}` : `$${p.unclaimed_fees_usd ?? "?"}`;
      const statusLabel = act.action === "INSTRUCTION" ? "HOLD (instruction)" : act.action;
      // getMyPositions() returns live RPC-derived position data and does not carry
      // confirmed state-only fields such as peak_pnl_pct. Use tracked state first
      // so the management report/DynSL display matches actual exit logic.
      const tracked = getTrackedPosition(p.position);
      const peak = tracked?.peak_pnl_pct ?? p.peak_pnl_pct ?? 0;
      const dynEnabled = !!config.management.dynamicStopLossEnabled;
      const dynTrigger = config.management.breakevenTriggerPct ?? 1;
      const dynStop = config.management.breakevenStopPct ?? 0.5;
      const baseStop = config.management.dynamicStopBasePct ?? config.management.stopLossPct;
      const dynActive = dynEnabled && peak >= dynTrigger && (p.age_minutes == null || p.age_minutes >= (config.management.dynamicStopMinAgeMinutes ?? 10));
      const effectiveSl = dynActive ? Math.max(Number(baseStop ?? -50), Number(dynStop)) : baseStop;
      const slInfo = dynEnabled
        ? `SL: ${Number(effectiveSl).toFixed(2)}% (${dynActive ? `DynSL active; peak ${Number(peak).toFixed(2)}%` : `DynSL armed @ +${Number(dynTrigger).toFixed(2)}% → +${Number(dynStop).toFixed(2)}%`})`
        : `SL: ${baseStop ?? "?"}%`;
      const netPct = p.projected_net_pnl_pct ?? p.pnl_pct;
      let line = `**${p.pair}** | Age: ${p.age_minutes ?? "?"}m | Val: ${val} | Unclaimed: ${unclaimed} | Est. Net PnL: ${netPct ?? "?"}% | Gross estimate: ${p.pnl_pct ?? "?"}% | Peak: ${Number(peak).toFixed(2)}% | ${slInfo} | Yield: ${p.fee_per_tvl_24h ?? "?"}% | ${inRange} | ${statusLabel}`;
      if (p.instruction) line += `\nNote: "${p.instruction}"`;
      if (act.action === "CLOSE" && act.rule === "exit") line += `\n⚡ Trailing TP: ${act.reason}`;
      if (act.action === "CLOSE" && act.rule && act.rule !== "exit") line += `\nRule ${act.rule}: ${act.reason}`;
      if (act.action === "CLAIM") line += `\n→ Claiming fees`;
      return line;
    });

    const needsAction = [...actionMap.values()].filter(a => a.action !== "STAY");
    const actionSummary = needsAction.length > 0
      ? needsAction.map(a => a.action === "INSTRUCTION" ? "EVAL instruction" : `${a.action}${a.reason ? ` (${a.reason})` : ""}`).join(", ")
      : "no action";

    const cur = config.management.solMode ? "◎" : "$";
    mgmtReport = reportLines.join("\n\n") +
      `\n\nSummary: 💼 ${positions.length} positions | ${cur}${totalValue.toFixed(4)} | fees: ${cur}${totalUnclaimed.toFixed(4)} | ${actionSummary}`;

    // ── Call LLM only if action needed ──────────────────────────────
    const actionPositions = positionData.filter(p => {
      const a = actionMap.get(p.position);
      return a.action !== "STAY";
    });

    if (actionPositions.length > 0) {
      await liveMessage?.note(`Executing ${actionPositions.length} management action(s): ${actionSummary}`).catch(() => {});
      const execReport = await executeManagementActions(actionPositions, actionMap, { liveMessage, cur });
      if (execReport) mgmtReport += `\n\n${execReport}`;
    } else {
      log("cron", "Management: all positions STAY — skipping");
      await liveMessage?.note("No tool actions needed.");
    }

    // Trigger screening after management
    const afterPositions = await getMyPositionsFn({ force: true }).catch(() => null);
    const afterCount = getPositionCounts(afterPositions).effective;
    if (afterCount < config.risk.maxPositions && Date.now() - _screeningLastTriggered > screeningCooldownMs) {
      if (_screeningBusy) {
        log("cron", `Post-management: ${afterCount}/${config.risk.maxPositions} positions — screening already running; skipping duplicate trigger`);
      } else {
        log("cron", `Post-management: ${afterCount}/${config.risk.maxPositions} positions — triggering screening`);
        runScreeningCycleFn().catch((e) => log("cron_error", `Triggered screening failed: ${e.message}`));
      }
    }
  } catch (error) {
    log("cron_error", `Management cycle failed: ${error.message}`);
    mgmtReport = `Management cycle failed: ${error.message}`;
  } finally {
    _managementBusy = false;
    if (!silent && telegramEnabled()) {
      if (mgmtReport) {
        if (liveMessage) await liveMessage.finalize(stripThink(mgmtReport)).catch(() => {});
        else sendMessage(`🔄 Management Cycle\n\n${stripThink(mgmtReport)}`).catch(() => { });
      }
      for (const p of positions) {
        if (!p.in_range && p.minutes_out_of_range >= config.management.outOfRangeWaitMinutes) {
          notifyOutOfRange({ pair: p.pair, minutesOOR: p.minutes_out_of_range }).catch(() => { });
        }
      }
    }
  }
  return mgmtReport;
}

export async function runScreeningCycle({ silent = false } = {}) {
  if (_screeningBusy) {
    _screeningQueuedWhileBusy = true;
    log("cron", "Screening skipped — previous cycle still running");
    return null;
  }
  // Recompute from the raw runtime state before any wallet/RPC/candidate work.
  // This prevents a dry-run process from creating its first paper lifecycle
  // before the historical replay coverage gate is met.
  const paperDeployGate = getPaperDeploymentGate();
  if (!paperDeployGate.pass) {
    const coverage = paperDeployGate.historicalReplayCoverage;
    const screenReport = `Screening blocked — historical replay coverage ${coverage.actual}/${coverage.required}: ${paperDeployGate.reason}. No new paper deploy was started.`;
    log("rollout_safety", screenReport);
    return screenReport;
  }
  _screeningBusy = true; // set immediately — prevents TOCTOU race with concurrent callers
  _screeningLastTriggered = Date.now();

  // Hard guards — don't even run the agent if preconditions aren't met
  let prePositions, preBalance;
  let liveMessage = null;
  let screenReport = null;
  try {
    [prePositions, preBalance] = await Promise.all([getMyPositions({ force: true }), getWalletBalances()]);
    if (!preBalance || preBalance.error) {
      const reason = preBalance?.error || "wallet balance is unavailable";
      screenReport = `Screening skipped — authoritative wallet preflight failed: ${reason}.`;
      log("wallet_error", screenReport);
      appendDecision({
        type: "skip",
        actor: "SCREENER",
        summary: "Screening skipped",
        reason: `Authoritative wallet preflight failed (${reason})`,
      });
      _screeningBusy = false;
      return screenReport;
    }
    if (!(await circuitBreakerEntryAllowed())) {
      const breaker = await getCircuitBreakerState();
      screenReport = `Screening skipped — circuit breaker latched: ${(breaker.reasons || []).join(", ") || "manual resume required"}.`;
      log("circuit_breaker", screenReport);
      _screeningBusy = false;
      return screenReport;
    }
    const preCounts = getPositionCounts(prePositions);
    if (preCounts.hasSettlingTracked) {
      log("cron", `Screening skipped — ${preCounts.tracked} tracked position(s) still settling; on-chain reader sees ${preCounts.onChain}`);
      screenReport = `Screening skipped — ${preCounts.tracked} tracked position(s) still settling; on-chain reader sees ${preCounts.onChain}.`;
      if (!silent && telegramEnabled()) sendMessage(`🔍 Screening skipped\n${screenReport}`).catch(() => {});
      appendDecision({
        type: "skip",
        actor: "SCREENER",
        summary: "Screening skipped",
        reason: `Tracked positions still settling (${preCounts.tracked} tracked, ${preCounts.onChain} on-chain)`,
      });
      _screeningBusy = false;
      return screenReport;
    }
    if (preCounts.effective >= config.risk.maxPositions) {
      log("cron", `Screening skipped — max positions reached (${preCounts.effective}/${config.risk.maxPositions})`);
      screenReport = `Screening skipped — max positions reached (${preCounts.effective}/${config.risk.maxPositions}).`;
      if (!silent && telegramEnabled()) sendMessage(`🔍 Screening skipped\n${screenReport}`).catch(() => {});
      appendDecision({
        type: "skip",
        actor: "SCREENER",
        summary: "Screening skipped",
        reason: `Max positions reached (${preCounts.effective}/${config.risk.maxPositions})`,
      });
      _screeningBusy = false;
      return screenReport;
    }
    const sizing = getAdaptiveSizingDecision(preBalance.sol, preCounts.effective);
    if (!sizing.eligible) {
      log("cron", `Screening skipped — sizing preflight failed (${sizing.reasons.join(", ")})`);
      screenReport = `Screening skipped — sizing preflight failed: ${sizing.reasons.join(", ")}.`;
      if (!silent && telegramEnabled()) sendMessage(`🔍 Screening skipped\n${screenReport}`).catch(() => {});
      appendDecision({
        type: "skip",
        actor: "SCREENER",
        summary: "Screening skipped",
        reason: `Sizing preflight failed (${sizing.reasons.join(", ")})`,
      });
      _screeningBusy = false;
      return screenReport;
    }
  } catch (e) {
    log("cron_error", `Screening pre-check failed: ${e.message}`);
    screenReport = `Screening pre-check failed: ${e.message}`;
    _screeningBusy = false;
    return screenReport;
  }
  if (!silent && telegramEnabled()) {
    liveMessage = await createLiveMessage("🔍 Screening Cycle", "Scanning candidates...");
  }
  timers.screeningLastRun = Date.now();
  log("cron", `Starting screening cycle [model: ${config.llm.screeningModel}]`);
  try {
    // Reuse pre-fetched balance — no extra RPC call needed
    const currentBalance = preBalance;
    const sizing = getAdaptiveSizingDecision(currentBalance.sol, getPositionCounts(prePositions).effective);
    if (!sizing.eligible) throw new Error(`Adaptive sizing blocked deploy: ${sizing.reasons.join(", ")}`);
    const deployAmount = sizing.amountSol;
    log("cron", `Computed ${sizing.canary ? "canary" : sizing.tier} deploy amount: ${deployAmount} SOL (wallet: ${currentBalance.sol} SOL, setup buffer: ${sizing.setupBufferSol} SOL)`);
    await liveMessage?.note(`Wallet ${currentBalance.sol} SOL → ${sizing.canary ? "canary" : sizing.tier} deploy ${deployAmount} SOL; fetching candidates...`).catch(() => {});

    // Fetch top candidates, then recon each sequentially with a small delay to avoid 429s
    const topCandidates = await getTopCandidates({ limit: 10 }).catch(() => null);
    const candidates = (topCandidates?.candidates || topCandidates?.pools || []).slice(0, 10);
    const earlyFilteredExamples = topCandidates?.filtered_examples || [];
    const screeningDiagnostics = topCandidates?.screening_diagnostics || null;
    if (screeningDiagnostics) {
      const nearMissReasons = (screeningDiagnostics.near_miss_reasons || [])
        .slice(0, 3)
        .map((entry) => `${entry.count}x ${entry.reason}`)
        .join(" | ");
      log(
        "screening",
        `Waterfall: API ${screeningDiagnostics.primary_returned}/${screeningDiagnostics.primary_total} ` +
        `→ threshold ${screeningDiagnostics.threshold_passed} → blocklist ${screeningDiagnostics.eligible_after_blocklists} ` +
        `→ final ${candidates.length}` +
        (screeningDiagnostics.near_miss_total > 0
          ? `; near misses ${screeningDiagnostics.near_miss_total}${nearMissReasons ? ` (${nearMissReasons})` : ""}`
          : ""),
      );
    }
    await liveMessage?.note(`Fetched ${candidates.length} top candidate(s); running audits/recon...`).catch(() => {});

    const allCandidates = [];
    const shadowRotationRecon = isEffectiveDryRun() && config.shadowRotation.enabled === true;
    for (const pool of candidates) {
      const mint = pool.base?.mint;
      const [smartWallets, narrative, tokenInfo] = await Promise.allSettled(shadowRotationRecon
        ? [
            Promise.resolve(null),
            Promise.resolve(null),
            mint ? getTokenInfo({ query: mint }) : Promise.resolve(null),
          ]
        : [
            checkSmartWalletsOnPool({ pool_address: pool.pool }),
            mint ? getTokenNarrative({ mint }) : Promise.resolve(null),
            mint ? getTokenInfo({ query: mint }) : Promise.resolve(null),
          ]);
      allCandidates.push({
        pool,
        sw: smartWallets.status === "fulfilled" ? smartWallets.value : null,
        n: narrative.status === "fulfilled" ? narrative.value : null,
        ti: tokenInfo.status === "fulfilled" ? tokenInfo.value?.results?.[0] : null,
        mem: recallForPool(pool.pool),
      });
      await new Promise(r => setTimeout(r, 150)); // avoid 429s
    }

    // Hard filters after token recon — block launchpads and excessive Jupiter bot holders
    const filteredOut = [];
    const qualityPassing = allCandidates.filter(({ pool, ti }) => {
      const launchpad = ti?.launchpad ?? null;
      if (launchpad && config.screening.allowedLaunchpads?.length > 0 && !config.screening.allowedLaunchpads.includes(launchpad)) {
        log("screening", `Skipping ${pool.name} — launchpad ${launchpad} not in allow-list`);
        filteredOut.push({ name: pool.name, reason: `launchpad ${launchpad} not in allow-list` });
        return false;
      }
      if (launchpad && config.screening.blockedLaunchpads.includes(launchpad)) {
        log("screening", `Skipping ${pool.name} — blocked launchpad (${launchpad})`);
        filteredOut.push({ name: pool.name, reason: `blocked launchpad (${launchpad})` });
        return false;
      }
      const botPct = ti?.audit?.bot_holders_pct;
      const maxBotHoldersPct = config.screening.maxBotHoldersPct;
      if (botPct != null && maxBotHoldersPct != null && botPct > maxBotHoldersPct) {
        log("screening", `Bot-holder filter: dropped ${pool.name} — bots ${botPct}% > ${maxBotHoldersPct}%`);
        filteredOut.push({ name: pool.name, reason: `bot holders ${botPct}% > ${maxBotHoldersPct}%` });
        return false;
      }
      return true;
    });

    // Stability and regime gates run before the LLM. This avoids spending tokens on
    // candidates that have not survived multiple independent screening observations.
    const passing = [];
    for (const candidate of qualityPassing) {
      const { pool } = candidate;
      const volatility = Number(pool.volatility);
      if (
        config.strategy.regimeHighVolAction === "skip" &&
        Number.isFinite(volatility) &&
        volatility >= Number(config.strategy.regimeHighVolMin ?? 2)
      ) {
        const reason = `expansion regime volatility ${volatility} >= ${config.strategy.regimeHighVolMin}`;
        log("screening", `Regime gate: dropped ${pool.name} — ${reason}`);
        filteredOut.push({ name: pool.name, reason });
        continue;
      }

      const stability = observeCandidateStability(
        pool.pool,
        {
          feeActiveTvlRatio: pool.fee_active_tvl_ratio,
          volume: pool.volume_window ?? pool.volume,
          price: pool.price,
          binStep: pool.bin_step,
        },
        config.screening,
      );
      candidate.stability = stability;
      if (!stability.pass) {
        log("screening", `Stability gate: held ${pool.name} — ${stability.reason}`);
        filteredOut.push({ name: pool.name, reason: stability.reason });
        continue;
      }
      const admissionRecovery = getCandidateAdmissionRecovery(pool.pool, config.screening);
      candidate.admissionRecovery = admissionRecovery;
      if (admissionRecovery.required && !admissionRecovery.pass) {
        const reason = `Candidate admission recovery remains blocked for ${Math.ceil(admissionRecovery.remainingMs / 1000)}s after ${admissionRecovery.code}.`;
        log("screening", `Admission recovery: held ${pool.name} — ${reason}`);
        filteredOut.push({ name: pool.name, reason });
        continue;
      }
      passing.push(candidate);
    }

    if (passing.length === 0) {
      const combined = filteredOut.length > 0 ? filteredOut : earlyFilteredExamples;
      const combinedExamples = combined.slice(0, 3)
        .map((entry) => `- ${entry.name}: ${entry.reason}`)
        .join("\n");
      screenReport = combinedExamples
        ? `No candidates available.\nFiltered examples:\n${combinedExamples}`
        : `No candidates available (all filtered by launchpad / holder-quality rules).`;
      appendDecision({
        type: "no_deploy",
        actor: "SCREENER",
        summary: "No candidates available",
        reason: combinedExamples || "All candidates filtered before deploy",
        rejected: combined.slice(0, 5).map((entry) => `${entry.name}: ${entry.reason}`),
      });
      return screenReport;
    }

    // Deterministic selection is authoritative. The LLM is a veto-only reviewer
    // and cannot choose another candidate or mutate amount/range/strategy.
    const evaluatedAtMs = Date.now();
    const deployValueUsd = currentBalance.sol_price > 0 ? deployAmount * currentBalance.sol_price : null;
    const policyCandidates = passing.map((candidate) => toPolicyCandidate(candidate, evaluatedAtMs, deployValueUsd));
    const candidatePolicy = candidatePolicyFromScreening(config.screening, {
      management: config.management,
      indicators: config.indicators,
      strategyProfile: config.rollout.strategyProfile,
      shadowRotation: config.shadowRotation,
    });
    const selection = selectDeterministicCandidate(policyCandidates, { nowMs: evaluatedAtMs }, candidatePolicy);
    if (!selection.selected) {
      const rejected = selection.rejected.slice(0, 5).map(({ candidate, evaluation }) =>
        `- ${candidate.runtime?.pool?.name || candidate.poolAddress}: ${evaluation.reasons.join(", ")}`);
      screenReport = [
        "⛔ NO DEPLOY",
        "",
        "Cycle finished with no valid deterministic entry.",
        "",
        "REJECTED",
        ...(rejected.length ? rejected : ["- none: all candidates failed fail-closed policy mapping"]),
      ].join("\n");
      appendDecision({
        type: "no_deploy",
        actor: "SCREENER",
        summary: "Deterministic hard gates rejected all candidates",
        reason: rejected.join("; ").slice(0, 500),
      });
      return screenReport;
    }

    const selectedPolicy = selection.selected.candidate;
    const selectedRuntime = selectedPolicy.runtime;
    const selectedPool = selectedRuntime.pool;
    const rotationProfileActive = config.shadowRotation.enabled === true &&
      config.rollout.strategyProfile === SHADOW_ROTATION_STRATEGY_PROFILE;
    const veto = rotationProfileActive
      ? {
          approved: true,
          skipped: true,
          reason_code: "ROTATION_DETERMINISTIC_ONLY",
          note: `${SHADOW_ROTATION_STRATEGY_PROFILE} uses the same deterministic gates in shadow and live canary.`,
        }
      : await requestAiVeto(selectedPolicy);
    if (!veto.approved && !rotationProfileActive) {
      screenReport = [
        "⛔ NO DEPLOY",
        "",
        "Cycle finished with no executed entry.",
        "",
        "BEST LOOKING CANDIDATE",
        selectedPool.name,
        "",
        "WHY SKIPPED",
        `AI veto ${veto.reason_code}: ${veto.note || "no additional detail"}`,
      ].join("\n");
      appendDecision({
        type: "no_deploy",
        actor: "AI_VETO",
        pool: selectedPool.pool,
        pool_name: selectedPool.name,
        summary: "Deterministic candidate vetoed",
        reason: `${veto.reason_code}: ${veto.note}`.slice(0, 500),
      });
      return screenReport;
    }
    if (!veto.approved) {
      log(
        "screening",
        `Rotation profile continuing past advisory AI veto ${veto.reason_code}: ${veto.note || "no evidence"}`,
      );
      appendDecision({
        type: "review",
        actor: "AI_ADVISORY",
        pool: selectedPool.pool,
        pool_name: selectedPool.name,
        summary: "Rotation profile ignored non-authoritative AI veto",
        reason: `${veto.reason_code}: ${veto.note || "no evidence"}`.slice(0, 500),
      });
    }

    const volatility = Number(selectedPool.volatility);
    const { runtime: _runtimeOnly, ...selectedPolicySnapshot } = selectedPolicy;
    const policySnapshot = {
      ...selectedPolicySnapshot,
      strategyProfile: config.rollout.strategyProfile,
      fundingModel: rotationProfileActive ? config.shadowRotation.fundingModel : "single_side_sol",
      entryEconomics: selection.selected.evaluation.economics,
    };
    const rotationRange = rotationProfileActive
      ? resolveShadowRotationRange(volatility, config.shadowRotation)
      : null;
    if (rotationProfileActive && !rotationRange?.eligible) {
      screenReport = `⛔ NO DEPLOY\n\nRotation range selection failed: ${rotationRange?.reason || "invalid volatility/range configuration"}`;
      return screenReport;
    }
    if (rotationRange) {
      policySnapshot.rangeRegime = rotationRange.regime;
      policySnapshot.rangeBinsBelow = rotationRange.binsBelow;
      policySnapshot.rangeBinsAbove = rotationRange.binsAbove;
    }
    const binsBelow = rotationProfileActive
      ? rotationRange.binsBelow
      : Math.max(
          config.strategy.minBinsBelow,
          Math.min(
            config.strategy.maxBinsBelow,
            Math.round(config.strategy.minBinsBelow + (volatility / 5) * (config.strategy.maxBinsBelow - config.strategy.minBinsBelow)),
          ),
        );
    const deployStrategy = rotationProfileActive
      ? config.shadowRotation.strategy
      : config.strategy.strategy;
    const binsAbove = rotationProfileActive ? rotationRange.binsAbove : 0;
    await liveMessage?.note(`Deterministic winner ${selectedPool.name}; AI approved. Executing fixed ${deployAmount} SOL / ${binsBelow}+${binsAbove} bins${rotationRange ? ` (${rotationRange.regime})` : ""}.`).catch(() => {});
    // The deterministic selector has already fixed every deploy field. Bind
    // that exact immutable request to a fresh, local one-use capability rather
    // than asking a prompt or provider to authorize (or shape) the deploy.
    const screeningDeploy = createScreeningDeployBoundary({
      pool_address: selectedPool.pool,
      amount_y: deployAmount,
      amount_x: 0,
      strategy: deployStrategy,
      bins_below: binsBelow,
      bins_above: binsAbove,
      pool_name: selectedPool.name,
      base_mint: selectedPool.base?.mint,
      bin_step: selectedPool.bin_step,
      base_fee: selectedPool.fee_pct,
      volatility,
      fee_tvl_ratio: selectedPool.fee_active_tvl_ratio,
      organic_score: selectedPool.organic_score,
      initial_value_usd: deployValueUsd,
      policy_snapshot: policySnapshot,
    });
    const deployResult = await screeningDeploy.dispatchScreeningDeploy(
      screeningDeploy.capability,
      screeningDeploy.request,
    );
    const deterministicDeploySucceeded = isToolExecutionSuccess("deploy_position", deployResult);
    if (!deterministicDeploySucceeded) {
      screenReport = `⛔ NO DEPLOY\n\nDeterministic deploy failed safety/execution: ${deployResult?.reason || deployResult?.error || "unknown"}`;
      appendDecision({
        type: "no_deploy",
        actor: "SCREENER",
        pool: selectedPool.pool,
        pool_name: selectedPool.name,
        summary: "Deterministic deploy failed",
        reason: deployResult?.reason || deployResult?.error || "unknown",
      });
      return screenReport;
    }

    clearCandidateObservation(selectedPool.pool);
    const coverage = deployResult.range_coverage || deployResult.would_deploy || {};
    screenReport = [
      isEffectiveDryRun() ? "🧪 SHADOW DEPLOYED" : "🚀 DEPLOYED",
      "",
      selectedPool.name,
      selectedPool.pool,
      "",
      `◎ ${deployAmount} SOL | ${deployStrategy} | ${binsBelow} below + ${binsAbove} above | ${config.rollout.strategyProfile}`,
      `Net policy: TP target +${config.management.takeProfitPct}% | projected gate +${getEffectiveTakeProfitPct(config.management).toFixed(2)}% | SL ${config.management.stopLossPct}% | floor max(${config.management.minNetProfitSol} SOL, ${config.management.minNetProfitPct}%)`,
      `Fee/TVL ${selectedPool.fee_active_tvl_ratio}% | Volume $${selectedPool.volume_window} | TVL $${selectedPool.tvl ?? selectedPool.active_tvl}`,
      veto.skipped
        ? `AI advisory skipped in shadow rotation — ${veto.note}`
        : veto.approved
        ? `AI veto review: APPROVE${veto.note ? ` — ${veto.note}` : ""}`
        : `AI advisory only in shadow rotation: ${veto.reason_code}${veto.note ? ` — ${veto.note}` : ""}`,
      coverage.downside_pct != null ? `Range downside: ${Number(coverage.downside_pct).toFixed(2)}%` : null,
    ].filter(Boolean).join("\n");
    appendDecision({
      type: "deploy",
      actor: "DETERMINISTIC_SCORER",
      pool: selectedPool.pool,
      pool_name: selectedPool.name,
      position: deployResult.position || deployResult.paper_position,
      summary: `${isEffectiveDryRun() ? "Shadow deployed" : "Deployed"} ${deployAmount} SOL`,
      reason: `Ranked first by fee/TVL, volume efficiency, retention, and audit; AI approved (${veto.note || "no veto"})`,
    });
    return screenReport;
  } catch (error) {
    log("cron_error", `Screening cycle failed: ${error.message}`);
    screenReport = `Screening cycle failed: ${error.message}`;
  } finally {
    _screeningBusy = false;
    if (!silent && telegramEnabled()) {
      if (screenReport) {
        if (liveMessage) await liveMessage.finalize(stripThink(screenReport)).catch(() => {});
        else sendMessage(`🔍 Screening Cycle\n\n${stripThink(screenReport)}`).catch(() => { });
      }
    }
  }
  return screenReport;
}

export function startCronJobs() {
  stopCronJobs(); // stop any running tasks before (re)starting

  const mgmtTask = cron.schedule(`*/${Math.max(1, config.schedule.managementIntervalMin)} * * * *`, async () => {
    if (_managementBusy) return;
    timers.managementLastRun = Date.now();
    await runManagementCycle();
  });

  // Option A: empty-state screening is driven by the management cycle.
  // Keep periodic screening cron disabled to avoid dual trigger sources.
  const screenTask = null;

  const healthTask = cron.schedule(`0 * * * *`, async () => {
    if (_managementBusy) return;
    _managementBusy = true;
    log("cron", "Starting health check");
    try {
      await agentLoop(`
HEALTH CHECK

Summarize the current portfolio health, total fees earned, and performance of all open positions. Recommend any high-level adjustments if needed.
      `, config.llm.maxSteps, [], "MANAGER");
    } catch (error) {
      log("cron_error", `Health check failed: ${error.message}`);
    } finally {
      _managementBusy = false;
    }
  });

  // Morning Briefing at 8:00 AM UTC+7 (1:00 AM UTC)
  const briefingTask = cron.schedule(`0 1 * * *`, async () => {
    await runBriefing();
  }, { timezone: 'UTC' });

  // Every 6h — catch up if briefing was missed (agent restart, crash, etc.)
  const briefingWatchdog = cron.schedule(`0 */6 * * *`, async () => {
    await maybeRunMissedBriefing();
  }, { timezone: 'UTC' });

  // Fast PnL poller — the real-time exit path between management cycles, no LLM.
  // Runs on public infra (RPC + Jupiter + Meteora deposits) so it can poll aggressively.
  // Exits require `confirmTicks` consecutive confirming polls (registerExitSignal) so a
  // single noisy tick can't close a position; confirmed exits close DIRECTLY here (no
  // management-interval cooldown gate that used to swallow rule hits).
  const pnlPollMs = Math.max(1, Number(config.pnl.pollIntervalSec ?? 3)) * 1000;
  const confirmTicks = Math.max(1, Number(config.pnl.confirmTicks ?? 2));
  let _pnlPollBusy = false;
  const pnlPollInterval = setInterval(async () => {
    // Dry-run exits are settled locally by runShadowLifecycleCycle above. Do
    // not route paper state through the live close/executor path.
    if (isEffectiveDryRun()) return;
    if (_managementBusy || _screeningBusy || _pnlPollBusy) return;
    if (getTrackedPositions(true).length === 0) return;
    _pnlPollBusy = true;
    try {
      const result = await getMyPositions({ force: true, silent: true }).catch(() => null);
      const canaryEquity = await observeLiveCanaryEquity({ positions: result?.positions });
      if (canaryEquity.error) {
        log("canary_equity_error", canaryEquity.error);
      } else if (canaryEquity.observed && !canaryEquity.valuation.ok) {
        log("canary_equity_warn", `Canary equity valuation failed closed: ${canaryEquity.valuation.reason}`);
      }
      if (!result?.positions?.length) return;
      const positionsWithComparableFees = await attachComparableFeeWindows(result.positions);
      for (const p of positionsWithComparableFees) {
        if (!p.pnl_pct_suspicious) confirmPeak(p.position, p.projected_net_pnl_pct ?? p.pnl_pct, confirmTicks);

        // Detect an exit signal this tick (rule-based exits, then deterministic close rules).
        const exit = updatePnlAndCheckExits(p.position, p, config.management);
        const closeRule = exit ? null : getDeterministicCloseRule(p, config.management);
        let signal = null, reason = null, rule = "exit";
        if (exit) { signal = exit.action; reason = exit.reason; }
        else if (closeRule) { signal = `RULE_${closeRule.rule}`; reason = closeRule.reason; rule = closeRule.rule; }

        // Profit capture is latency-sensitive; loss and range exits retain the
        // normal multi-tick noise guard.
        const profitSignals = new Set(["TAKE_PROFIT", "PROFIT_PROTECT", "RULE_2"]);
        const stopSignals = new Set(["STOP_LOSS", "THESIS_FAILURE", "RULE_1"]);
        const requiredTicks = signal === "CATASTROPHIC_STOP"
          ? 1
          : profitSignals.has(signal)
            ? Math.max(1, Number(config.pnl.profitConfirmTicks ?? 2))
            : stopSignals.has(signal)
              ? Math.max(1, Number(config.pnl.stopConfirmTicks ?? 3))
              : confirmTicks;
        const { fire } = registerExitSignal(p.position, signal, requiredTicks, exit?.confirmation_key ?? null);
        if (!signal || !fire) continue;

        log("state", `[PnL poll] ${signal} confirmed (${requiredTicks} ticks): ${p.pair} — ${reason} — closing directly`);
        // Hold the management lock so the cron cycle can't double-act on this position.
        _managementBusy = true;
        try {
          const actMap = new Map([[p.position, { action: "CLOSE", rule, reason }]]);
          const rpt = await executeManagementActions([p], actMap, {});
          log("state", `[PnL poll] ${p.pair}: ${rpt || "closed"}`);
        } catch (e) {
          log("cron_error", `Poll-triggered close failed: ${e.message}`);
        } finally {
          _managementBusy = false;
        }
        break; // one action per tick
      }
    } finally {
      _pnlPollBusy = false;
    }
  }, pnlPollMs);

  // Shadow micro-rotation needs a faster read-only active-bin cadence than the
  // ordinary minute management job. This loop never calls a wallet, signer, or
  // live close path; it only advances the local paper lifecycle. Keep a small
  // guard band around the minute boundary so the evidence heartbeat retains
  // priority and state writes cannot overlap.
  let shadowMonitorInterval = null;
  let _shadowMonitorBusy = false;
  if (isEffectiveDryRun() && config.shadowRotation.enabled) {
    const shadowMonitorMs = Math.max(
      10,
      Number(config.shadowRotation.monitorIntervalSeconds ?? 15),
    ) * 1000;
    shadowMonitorInterval = setInterval(async () => {
      const second = new Date().getSeconds();
      if (second <= 5 || second >= 52) return;
      if (_managementBusy || _screeningBusy || _shadowMonitorBusy) return;
      if (getOpenPaperPositions().length === 0) return;
      _shadowMonitorBusy = true;
      _managementBusy = true;
      try {
        const shadow = await runShadowLifecycleCycle({
          getActiveBin,
          getFeeWindow: getPoolFeeWindow,
          managementConfig: config.management,
          pnlConfig: config.pnl,
        });
        if (shadow.settled > 0 || shadow.failed > 0) {
          log(
            "cron",
            `Fast shadow monitor: observed ${shadow.observed}, settled ${shadow.settled}, failed ${shadow.failed}, open ${shadow.open_positions}`,
          );
        }
      } catch (error) {
        log("cron_error", `Fast shadow monitor failed: ${error.message}`);
      } finally {
        _managementBusy = false;
        _shadowMonitorBusy = false;
      }
    }, shadowMonitorMs);
  }

  // Opportunity poller — catches strong pools between the (slow) screening cycles.
  // Reuses the getTopCandidates pipeline (discovery + holder audit + filters + score);
  // when the best candidate clears the score pre-gate it triggers the existing screening
  // deploy decision (runScreeningCycle), which re-checks guards and forces the deploy LLM.
  let opportunityPollInterval = null;
  if (config.opportunity.enabled) {
    const oppMs = Math.max(15, Number(config.opportunity.pollIntervalSec ?? 45)) * 1000;
    const oppCooldownMs = config.shadowRotation.enabled
      ? Math.max(30_000, Number(config.shadowRotation.confirmationSpacingMs ?? 30_000))
      : 5 * 60 * 1000;
    const opportunityScoreTargets = config.shadowRotation.enabled
      ? {
          ...config.opportunity,
          targetVolRatio: 40,
          targetLpCount: 10,
          targetFeeRatio: config.shadowRotation.minFeeActiveTvlRatioPct,
          targetLiquidity: 1_000,
        }
      : config.opportunity;
    let _opportunityPollBusy = false;
    opportunityPollInterval = setInterval(async () => {
      if (_screeningBusy || _managementBusy || _opportunityPollBusy) return;
      if (Date.now() - _screeningLastTriggered < oppCooldownMs) return;
      _opportunityPollBusy = true;
      try {
        const [positions, balance] = await Promise.all([
          getMyPositions({ force: true, silent: true }).catch(() => null),
          getWalletBalances().catch(() => null),
        ]);
        if (!positions || (positions.total_positions ?? 0) >= config.risk.maxPositions) return;
        const minRequired = config.management.deployAmountSol + config.management.gasReserve;
        if (!isEffectiveDryRun() && (!balance || balance.sol < minRequired)) return;

        const top = await getTopCandidates({ limit: config.opportunity.limit }).catch(() => null);
        const candidates = (top?.candidates || []).slice().sort((a, b) => degenScore(b, opportunityScoreTargets) - degenScore(a, opportunityScoreTargets));
        if (!candidates.length) return;

        const minScore = config.opportunity.minScore;
        const bonus = Number(config.opportunity.smartWalletScoreBonus ?? 0);
        const floor = minScore - bonus; // lowest degen that could qualify, only WITH a smart wallet

        // A pool qualifies if degen >= minScore, OR it's borderline (floor..minScore) AND a
        // tracked smart wallet sits on it (checkSmartWalletsOnPool, on-chain positions of our
        // tracked KOL list). The smart-wallet lookup runs only for borderline pools to keep
        // the 45s poll cheap.
        let trigger = null;
        for (const c of candidates) {
          const s = degenScore(c, opportunityScoreTargets);
          if (s < floor) break; // sorted desc — nothing below can qualify either
          if (s >= minScore) { trigger = { c, s, smart: [] }; break; }
          if (bonus <= 0) continue; // borderline but smart-wallet rescue disabled
          const smart = (await checkSmartWalletsOnPool({ pool_address: c.pool }).catch(() => null))?.in_pool || [];
          if (smart.length > 0) { trigger = { c, s, smart }; break; }
        }
        if (!trigger) return;

        const smartTag = trigger.smart.length
          ? ` + smart wallet [${trigger.smart.map((w) => w.name || w.address?.slice(0, 4)).join(", ")}] (bar lowered ${minScore}→${floor})`
          : "";
        log("cron", `[Opportunity] ${trigger.c.name} degen ${trigger.s.toFixed(1)} >= ${trigger.smart.length ? floor : minScore}${smartTag} — triggering screening deploy decision`);
        runScreeningCycle({ silent: true }).catch((e) => log("cron_error", `Opportunity-triggered screening failed: ${e.message}`));
      } catch (e) {
        log("cron_error", `Opportunity poll failed: ${e.message}`);
      } finally {
        _opportunityPollBusy = false;
      }
    }, oppMs);
  }

  _cronTasks = [mgmtTask, screenTask, healthTask, briefingTask, briefingWatchdog].filter(Boolean);
  // Store interval refs so stopCronJobs can clear them
  _cronTasks._pnlPollInterval = pnlPollInterval;
  _cronTasks._shadowMonitorInterval = shadowMonitorInterval;
  _cronTasks._opportunityPollInterval = opportunityPollInterval;
  log(
    "cron",
    `Cycles started — management every ${config.schedule.managementIntervalMin}m, screening every ${config.schedule.screeningIntervalMin}m` +
    (shadowMonitorInterval ? `, shadow monitor every ${config.shadowRotation.monitorIntervalSeconds}s` : "") +
    (config.opportunity.enabled ? `, opportunity poll every ${config.opportunity.pollIntervalSec}s` : ""),
  );
}

// ═══════════════════════════════════════════
//  GRACEFUL SHUTDOWN
// ═══════════════════════════════════════════
let _shuttingDown = false;

function withTimeout(promise, ms) {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), ms);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function shutdown(signal) {
  if (_shuttingDown) {
    log("shutdown", `Received ${signal} while shutdown is already in progress.`);
    return;
  }
  _shuttingDown = true;

  log("shutdown", `Received ${signal}. Shutting down...`);
  stopPolling();
  stopCronJobs();

  const positions = await withTimeout(
    getMyPositions({ force: true, silent: true }).catch((error) => {
      log("shutdown", `Position snapshot failed during shutdown: ${error.message}`);
      return null;
    }),
    5000
  );
  if (positions) {
    log("shutdown", `Open positions at shutdown: ${positions.total_positions}`);
  } else {
    log("shutdown", "Open position snapshot skipped during shutdown timeout");
  }
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// ═══════════════════════════════════════════
//  FORMAT CANDIDATES TABLE
// ═══════════════════════════════════════════
function formatCandidates(candidates) {
  if (!candidates.length) return "  No eligible pools found right now.";

  const lines = candidates.map((p, i) => {
    const name = (p.name || "unknown").padEnd(20);
    const ftvl = `${p.fee_active_tvl_ratio ?? p.fee_tvl_ratio}%`.padStart(8);
    const vol = `$${((p.volume_window || 0) / 1000).toFixed(1)}k`.padStart(8);
    const active = `${p.active_pct}%`.padStart(6);
    const org = String(p.organic_score).padStart(4);
    return `  [${i + 1}]  ${name}  fee/aTVL:${ftvl}  vol:${vol}  in-range:${active}  organic:${org}`;
  });

  return [
    "  #   pool                  fee/aTVL     vol    in-range  organic",
    "  " + "─".repeat(68),
    ...lines,
  ].join("\n");
}

export function getEffectiveTakeProfitPct(managementConfig) {
  return resolveEffectiveTakeProfitPct(managementConfig);
}

function getDeterministicCloseRule(position, managementConfig) {
  if (managementConfig.netExitPolicyEnabled !== false) return null;
  const tracked = getTrackedPosition(position.position);
  const pnlSuspect = (() => {
    // Couldn't-price-this-tick flag (e.g. Jupiter outage) — never act on PnL rules.
    if (position.pnl_pct_suspicious) return true;
    if (position.pnl_pct == null) return false;
    if (position.pnl_pct > -90) return false;
    if (tracked?.amount_sol && (position.total_value_usd ?? 0) > 0.01) {
      log("cron_warn", `Suspect PnL for ${position.pair}: ${position.pnl_pct}% but position still has value — skipping PnL rules`);
      return true;
    }
    return false;
  })();

  if (!pnlSuspect && position.pnl_pct != null && position.pnl_pct <= managementConfig.stopLossPct) {
    return { action: "CLOSE", rule: 1, reason: "stop loss" };
  }
  const effectiveTakeProfitPct = getEffectiveTakeProfitPct(managementConfig);
  if (!pnlSuspect && position.pnl_pct != null && position.pnl_pct >= effectiveTakeProfitPct) {
    return { action: "CLOSE", rule: 2, reason: `cost-aware take profit (${effectiveTakeProfitPct.toFixed(2)}%)` };
  }
  if (
    position.active_bin != null &&
    position.upper_bin != null &&
    position.active_bin > position.upper_bin + managementConfig.outOfRangeBinsToClose
  ) {
    return { action: "CLOSE", rule: 3, reason: "pumped far above range" };
  }
  if (
    position.active_bin != null &&
    position.upper_bin != null &&
    position.active_bin > position.upper_bin &&
    (position.minutes_out_of_range ?? 0) >= managementConfig.outOfRangeWaitMinutes
  ) {
    return { action: "CLOSE", rule: 4, reason: "OOR" };
  }
  if (
    position.fee_per_tvl_24h != null &&
    position.fee_per_tvl_24h < managementConfig.minFeePerTvl24h &&
    (position.age_minutes ?? 0) >= 60
  ) {
    return { action: "CLOSE", rule: 5, reason: "low yield" };
  }
  return null;
}

// ═══════════════════════════════════════════
//  INTERACTIVE REPL
// ═══════════════════════════════════════════
const isTTY = process.stdin.isTTY;
let cronStarted = false;
let busy = false;
const _telegramQueue = []; // queued messages received while agent was busy
let _telegramCommandBusy = false;
let _telegramDrainTimer = null;
const sessionHistory = []; // persists conversation across REPL turns
const MAX_HISTORY = 20;    // keep last 20 messages (10 exchanges)
const BREAKER_RESUME_CONFIRMATION = "I CONFIRM BREAKER RESUME";
const BREAKER_RESUME_CALLBACK_PREFIX = "breaker_resume:";
const BREAKER_RESUME_CANCEL_CALLBACK = `${BREAKER_RESUME_CALLBACK_PREFIX}cancel`;
let _ttyInterface = null;
let _latestCandidates = [];
let _latestCandidatesAt = null;

function setLatestCandidates(candidates = []) {
  _latestCandidates = Array.isArray(candidates) ? candidates : [];
  _latestCandidatesAt = new Date().toISOString();
}

function getLatestCandidatesMeta() {
  return {
    candidates: _latestCandidates,
    count: _latestCandidates.length,
    updatedAt: _latestCandidatesAt,
  };
}

function describeLatestCandidates(limit = 5) {
  if (!_latestCandidates.length) return "No cached candidates yet. Run /screen first.";
  const lines = _latestCandidates.slice(0, limit).map((pool, i) => {
    const feeTvl = pool.fee_active_tvl_ratio ?? pool.fee_tvl_ratio ?? "?";
    const vol = pool.volume_window ?? pool.volume_24h ?? "?";
    const active = pool.active_pct ?? "?";
    const organic = pool.organic_score ?? "?";
    return `${i + 1}. ${pool.name} | fee/aTVL ${feeTvl}% | vol $${vol} | in-range ${active}% | organic ${organic}`;
  });
  const age = _latestCandidatesAt ? new Date(_latestCandidatesAt).toLocaleString("en-US", { hour12: false }) : "unknown";
  return `Latest candidates (${_latestCandidates.length}) — updated ${age}\n\n${lines.join("\n")}`;
}

function formatWalletStatus(wallet, positions) {
  const deployAmount = computeDeployAmount(wallet.sol);
  const hive = isHiveMindEnabled() ? "on" : "off";
  return [
    `Wallet: ${wallet.sol} SOL ($${wallet.sol_usd})`,
    `SOL price: $${wallet.sol_price}`,
    `Open positions: ${positions.total_positions}/${config.risk.maxPositions}`,
    `Next deploy amount: ${deployAmount} SOL`,
    `Effective mode: ${isEffectiveDryRun() ? "DRY RUN" : "LIVE CANARY"}`,
    `HiveMind: ${hive}`,
  ].join("\n");
}

function formatBreakerStatus(breaker) {
  if (!breaker) return "Circuit breaker: unavailable";
  const status = breaker.tripped || breaker.manualResumeRequired ? "LATCHED" : "READY";
  const reasons = Array.isArray(breaker.reasons) && breaker.reasons.length
    ? breaker.reasons.join(", ")
    : "none";
  return [
    `Circuit breaker: ${status}`,
    `Manual resume required: ${breaker.manualResumeRequired === true ? "yes" : "no"}`,
    `Automatic recovery: ${config.circuitBreaker.automaticResume ? `enabled (${config.circuitBreaker.automaticResumeCooldownMs / 1000}s clean-state cooldown)` : "disabled"}`,
    `Reasons: ${reasons}`,
    `Operational failures: ${Number(breaker.consecutiveOperationalFailures ?? 0)}`,
  ].join("\n");
}

function breakerResumeCallbackData(breaker) {
  const trippedAtMs = Number(breaker?.trippedAtMs);
  if (!Number.isSafeInteger(trippedAtMs) || trippedAtMs <= 0) return null;
  return `${BREAKER_RESUME_CALLBACK_PREFIX}${trippedAtMs}`;
}

function parseBreakerResumeCallback(data) {
  const match = String(data || "").match(/^breaker_resume:(\d+)$/);
  if (!match) return null;
  const trippedAtMs = Number(match[1]);
  return Number.isSafeInteger(trippedAtMs) && trippedAtMs > 0 ? trippedAtMs : null;
}

function breakerResumeShortcut(breaker) {
  if (!breaker) {
    return { text: "Circuit breaker state is unavailable; resume remains fail-closed.", keyboard: null };
  }
  if (breaker.tripped !== true && breaker.manualResumeRequired !== true) {
    return { text: `${formatBreakerStatus(breaker)}\n\nNo resume is needed.`, keyboard: null };
  }
  const callbackData = breakerResumeCallbackData(breaker);
  if (!callbackData) {
    return {
      text: [
        formatBreakerStatus(breaker),
        "",
        "The latch has no safe trip identity for a shortcut confirmation.",
        `Use exactly: /breaker resume ${BREAKER_RESUME_CONFIRMATION}`,
      ].join("\n"),
      keyboard: null,
    };
  }
  return {
    text: [
      formatBreakerStatus(breaker),
      "",
      "Resume re-enables eligibility for future entries; it does not submit a transaction or bypass cleanup/global deploy guards.",
      "Tap the confirmation button only if you intend to resume this exact breaker trip.",
    ].join("\n"),
    keyboard: [[
      { text: "✅ Resume breaker", callback_data: callbackData },
      { text: "Cancel", callback_data: BREAKER_RESUME_CANCEL_CALLBACK },
    ]],
  };
}

/**
 * Cleanup faults need an outcome-aware operator message. A descriptor close
 * failure after unlink is not a retained-lock condition, so only a fresh
 * breaker read may say whether entry is currently allowed.
 */
export async function formatCommittedBreakerCleanupFailure({
  operation,
  error,
  entryAllowed = circuitBreakerEntryAllowed,
  persistenceStatus = getCircuitBreakerPersistenceStatus,
} = {}) {
  const status = typeof persistenceStatus === "function" ? persistenceStatus() : persistenceStatus;
  const cleanupLockState = status?.cleanupLockState ?? error?.cleanupLockState ?? "retained_or_unknown";
  if (error?.committed !== true) return `Circuit breaker ${operation} failed.`;

  if (cleanupLockState !== "absent") {
    return `⚠️ Circuit breaker ${operation} was durably committed, but lock cleanup reported an error. Entry remains fail-closed until the retained or unresolved lock condition is resolved.`;
  }

  let currentlyAllowed = null;
  try {
    currentlyAllowed = await entryAllowed();
  } catch {
    // The lock absence is still known; only the independent current-state
    // result is unavailable, so do not claim either permission or blockage.
  }
  if (currentlyAllowed === true) {
    return `⚠️ Circuit breaker ${operation} was durably committed and the update lock is absent, but descriptor cleanup reported an error. Entry is currently allowed.`;
  }
  if (currentlyAllowed === false) {
    return `⚠️ Circuit breaker ${operation} was durably committed and the update lock is absent, but descriptor cleanup reported an error. The update lock is not blocking entry; the committed breaker state remains controlling.`;
  }
  return `⚠️ Circuit breaker ${operation} was durably committed and the update lock is absent, but descriptor cleanup reported an error. Entry state could not be re-read.`;
}

function formatLiveCanaryDeployGuardStatus(status) {
  if (status?.held === false) {
    return "Live-canary deploy guard: CLEAR\nNo retained global guard is blocking deploys.";
  }
  if (status?.held !== true) {
    return [
      "Live-canary deploy guard: UNVERIFIABLE",
      `Reason: ${status?.error || "durable guard status is unavailable"}`,
      "Deploy remains fail-closed until the retained guard can be inspected and explicitly reconciled.",
    ].join("\n");
  }
  const evidence = status.retention_evidence === 1 ? "READY" : `INVALID (${status.retention_evidence ?? 0})`;
  return [
    "Live-canary deploy guard: RETAINED / BLOCKING",
    `Guard operation id: ${status.operation_id}`,
    `Resource: ${status.resource}`,
    `Acquired: ${status.acquired_at}`,
    `Durable retention evidence: ${evidence}`,
    `Prior resolution audit records: ${status.prior_resolution_evidence ?? 0}`,
    `To reconcile (does not resume breaker): /canaryguard reconcile ${status.operation_id} ${LIVE_CANARY_GUARD_RECONCILIATION_CONFIRMATION}`,
  ].join("\n");
}

function formatLedgerStatus() {
  if (config.ledger?.enabled !== true) return "Ledger: disabled";
  try {
    const lifecycles = getTradeLedger().listLifecycles();
    const count = (state) => lifecycles.filter((lifecycle) => lifecycle.state === state).length;
    return [
      `Ledger: ${lifecycles.length} lifecycle(s)`,
      `Active: ${count("ACTIVE")} | closing: ${count("CLOSING")} | cleanup pending: ${count("CLEANUP_PENDING")}`,
      `Reconciliation required: ${count("RECONCILIATION_REQUIRED")} | settled: ${count("SETTLED")}`,
    ].join("\n");
  } catch {
    return "Ledger: unavailable (read error)";
  }
}

export function formatOperatorStatusText({
  rollout = config.rollout,
  breaker = null,
  ledgerStatus = formatLedgerStatus(),
} = {}) {
  const effectiveMode = isEffectiveDryRun() ? "dry_run" : "canary";
  const safety = rollout?.safety || {};
  const evidence = safety.acceptance || {};
  const source = evidence.source || {};
  const shadowSource = source.shadow || {};
  const historicalGate = evidence.gates?.historical_replay || null;
  const paperDeployGate = getPaperDeploymentGate();
  const rawHistoricalReplay = paperDeployGate.historicalReplayCoverage || {};
  const shadowRecords = Number.isSafeInteger(shadowSource.record_count) && shadowSource.record_count >= 0
    ? shadowSource.record_count
    : 0;
  const historicalCount = Number.isSafeInteger(historicalGate?.actual) && historicalGate.actual >= 0
    ? historicalGate.actual
    : null;
  const historicalLine = historicalGate
    ? `Historical replay: ${historicalCount ?? "?"} lifecycle(s) | ${historicalGate.pass === true ? "READY" : historicalGate.reason || "NOT READY"}`
    : "Historical replay: gate unavailable";
  const diagnostics = Array.isArray(safety.diagnostics) && safety.diagnostics.length
    ? safety.diagnostics.slice(0, 3).join(", ")
    : "none";
  return [
    "Operator safety status",
    "",
    `Rollout: effective ${effectiveMode} | requested ${rollout?.requestedMode || "dry_run"} | dry run ${isEffectiveDryRun() ? "yes" : "no"}`,
    `Operator readiness override: ${rollout?.operatorOverrideActive === true ? "ACTIVE" : "inactive"}`,
    `Canary limits: ◎${rollout?.canaryDeployAmountSol ?? 0.2} | ${rollout?.canaryMaxPositions ?? 1} position`,
    `Evidence (startup authorization): ${evidence.ready === true ? "READY" : "NOT READY"} | run ${evidence.run_id || "none"} | shadow records ${shadowRecords}`,
    historicalLine,
    `Raw historical replay gate: ${rawHistoricalReplay.pass === true ? "READY" : rawHistoricalReplay.reason || "NOT READY"} | ${rawHistoricalReplay.actual ?? "?"}/${rawHistoricalReplay.required ?? 30} lifecycle(s)`,
    `Paper deploy gate: ${paperDeployGate.pass === true ? "READY" : paperDeployGate.reason || "NOT READY"}`,
    `Evidence reason: ${evidence.reason || "all gates passed"}`,
    `Rollout diagnostics: ${diagnostics}`,
    "",
    formatBreakerStatus(breaker),
    "",
    ledgerStatus,
  ].join("\n");
}

async function formatOperatorStatus() {
  const breaker = await getCircuitBreakerState().catch(() => null);
  return formatOperatorStatusText({ breaker });
}

function cleanupActionSummary(plan) {
  const actions = Array.isArray(plan?.actions) ? plan.actions : [];
  if (!actions.length) return "Cleanup plan: no lifecycle accounts require action";
  const counts = new Map();
  for (const action of actions) {
    const type = String(action?.action || "unknown");
    counts.set(type, (counts.get(type) || 0) + 1);
  }
  return `Cleanup plan: ${[...counts.entries()].map(([type, count]) => `${type} ${count}`).join(", ")}`;
}

function cleanupResultMessage(result, { executionRequested = false } = {}) {
  const execution = result?.execution || {};
  const reconciliation = result?.reconciliation || {};
  const failed = result?.success === false || Boolean(result?.error) || Boolean(result?.blocked);
  const outcome = failed ? "❌ Cleanup not completed" : executionRequested ? "✅ Cleanup execution completed" : "🔎 Cleanup preview";
  const blocker = result?.error || result?.blocked || reconciliation?.blocked || null;
  return [
    outcome,
    cleanupActionSummary(result?.plan),
    `Execution: ${execution.executed === true ? "submitted" : execution.dry_run === true ? "blocked by dry run" : "not submitted"}`,
    `Reconciliation: ${reconciliation.complete === true ? "complete" : blocker || "pending"}`,
    blocker ? `Reason: ${blocker}` : null,
  ].filter(Boolean).join("\n");
}

function formatConfigSnapshot() {
  return [
    "Config snapshot",
    "",
    `Strategy: ${config.strategy.strategy} | binsBelow: ${config.strategy.minBinsBelow}-${config.strategy.maxBinsBelow} | default ${config.strategy.defaultBinsBelow}`,
    `Deploy: ${config.management.deployAmountSol} SOL | gasReserve: ${config.management.gasReserve} | maxPositions: ${config.risk.maxPositions}`,
    `Stop loss: ${config.management.stopLossPct}% | TP target: ${config.management.takeProfitPct}% | projected TP gate: ${getEffectiveTakeProfitPct(config.management).toFixed(2)}%`,
    `Trailing: ${config.management.trailingTakeProfit ? "on" : "off"} | trigger ${config.management.trailingTriggerPct}% | drop ${config.management.trailingDropPct}%`,
    `OOR: ${config.management.outOfRangeWaitMinutes}m | cooldown ${config.management.oorCooldownTriggerCount}x / ${config.management.oorCooldownHours}h`,
    `Repeat deploy cooldown: ${config.management.repeatDeployCooldownEnabled ? "on" : "off"} | ${config.management.repeatDeployCooldownTriggerCount}x / ${config.management.repeatDeployCooldownHours}h | min fee earned ${config.management.repeatDeployCooldownMinFeeEarnedPct}% | ${config.management.repeatDeployCooldownScope}`,
    `Yield floor: ${config.management.minFeePerTvl24h}% | min age ${config.management.minAgeBeforeYieldCheck}m`,
    `Screening: ${config.screening.category} / ${config.screening.timeframe} | TVL ${config.screening.minTvl}-${config.screening.maxTvl}`,
    `Extra search: ${formatExtraSearchSymbolsInline()} | limit ${config.screening.extraSearchLimitPerSymbol} | SOL only ${config.screening.extraSearchOnlySolPools ? "yes" : "no"}`,
    `Intervals: manage ${config.schedule.managementIntervalMin}m | screen ${config.schedule.screeningIntervalMin}m`,
    `HiveMind: ${isHiveMindEnabled() ? "enabled" : "disabled"}${config.hiveMind.agentId ? ` | ${config.hiveMind.agentId}` : ""}`,
  ].join("\n");
}

function isMintLikeSymbol(value) {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(value || "").trim());
}

function normalizeExtraSearchSymbol(value) {
  let symbol = String(value || "")
    .trim()
    .replace(/^[$\s]+/, "")
    .replace(/\s+/g, " ");
  if (
    (symbol.startsWith('"') && symbol.endsWith('"')) ||
    (symbol.startsWith("'") && symbol.endsWith("'")) ||
    (symbol.startsWith("`") && symbol.endsWith("`"))
  ) {
    symbol = symbol.slice(1, -1).trim();
  }
  symbol = symbol.replace(/,+$/g, "").trim();
  if (!symbol || symbol.length > 80 || symbol.startsWith("/")) return "";
  return isMintLikeSymbol(symbol) ? symbol : symbol.toUpperCase();
}

function extraSearchSymbolKey(symbol) {
  const value = String(symbol || "").trim();
  return isMintLikeSymbol(value) ? `mint:${value}` : `query:${value.toUpperCase()}`;
}

function getExtraSearchSymbols() {
  return Array.isArray(config.screening.extraSearchSymbols)
    ? config.screening.extraSearchSymbols.map((entry) => String(entry || "").trim()).filter(Boolean)
    : [];
}

function dedupeExtraSearchSymbols(symbols) {
  const seen = new Set();
  const deduped = [];
  for (const raw of symbols || []) {
    const symbol = normalizeExtraSearchSymbol(raw);
    if (!symbol) continue;
    const key = extraSearchSymbolKey(symbol);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(symbol);
  }
  return deduped;
}

function formatExtraSearchSymbolsInline(symbols = getExtraSearchSymbols()) {
  const current = dedupeExtraSearchSymbols(symbols);
  return current.length ? current.join(", ") : "(empty)";
}

function formatExtraSearchStatus(symbols = getExtraSearchSymbols()) {
  const current = dedupeExtraSearchSymbols(symbols);
  const list = current.length
    ? current.map((symbol, index) => `${index + 1}. ${symbol}`).join("\n")
    : "(empty)";
  return [
    "Extra search symbols",
    "",
    list,
    "",
    `Limit per symbol: ${config.screening.extraSearchLimitPerSymbol}`,
    `SOL pools only: ${config.screening.extraSearchOnlySolPools ? "yes" : "no"}`,
    "Applies on next screening cycle. No restart needed for symbol changes.",
  ].join("\n");
}

function formatCloseSolLines(result) {
  const fmt = (value) => {
    if (value == null) return null;
    const n = Number(value);
    return Number.isFinite(n) ? n.toFixed(6) : null;
  };
  const lines = [];
  const settled = result.settlement_pnl_source === "trade_ledger_wallet_equity_net";
  lines.push(settled
    ? "PnL source: on-chain cash settlement"
    : "PnL source: executable estimate; final settlement pending");
  const pnlSolValue = result.position_sol_pnl ?? result.pnl_sol;
  const pnlSol = fmt(pnlSolValue);
  if (pnlSol != null) {
    const sign = Number(pnlSolValue) >= 0 ? "+" : "";
    const pctValue = result.position_sol_pnl_pct ?? result.pnl_pct;
    const pct = Number(pctValue);
    lines.push(`${settled ? "On-chain net PnL" : "Estimated net PnL"}: ${sign}◎${pnlSol}${pctValue != null && Number.isFinite(pct) ? ` (${sign}${pct.toFixed(2)}%)` : ""}`);
  } else {
    const pnlValue = Number(result.pnl_usd);
    const pnlPct = Number(result.pnl_pct);
    const sign = pnlValue >= 0 ? "+" : "";
    const unit = config.management.solMode ? "◎" : "$";
    const digits = config.management.solMode ? 6 : 2;
    lines.push(`Estimated PnL: ${Number.isFinite(pnlValue) ? `${sign}${unit}${pnlValue.toFixed(digits)}` : "n/a"}${result.pnl_pct != null && Number.isFinite(pnlPct) ? ` (${sign}${pnlPct.toFixed(2)}%)` : ""}`);
  }
  const deployed = fmt(result.position_sol_deployed);
  const finalSol = fmt(result.position_sol_final);
  if (deployed != null && finalSol != null) {
    lines.push(`Position SOL: ◎${deployed} -> ◎${finalSol}`);
  }
  const before = fmt(result.wallet_sol_before_deploy);
  const walletAfterValue = result.wallet_sol_after_cleanup ?? result.wallet_sol_after_close;
  const after = fmt(walletAfterValue);
  const deltaValue = result.wallet_sol_roundtrip_delta_after_cleanup ?? result.wallet_sol_roundtrip_delta;
  const delta = fmt(deltaValue);
  if (before != null && after != null) {
    const sign = Number(deltaValue) >= 0 ? "+" : "";
    lines.push(`Wallet SOL: ◎${before} -> ◎${after}${delta != null ? ` (${sign}◎${delta})` : ""}`);
  }
  return lines;
}

function formatSettlementPerformanceMessage(report) {
  const fixed = (value, digits = 6) => {
    if (value == null) return "n/a";
    const number = Number(value);
    return Number.isFinite(number) ? number.toFixed(digits) : "n/a";
  };
  const signed = (value) => {
    if (value == null) return "n/a";
    const number = Number(value);
    if (!Number.isFinite(number)) return "n/a";
    return `${number >= 0 ? "+" : "-"}◎${Math.abs(number).toFixed(6)}`;
  };
  const signedPct = (value) => {
    if (value == null) return "n/a";
    const number = Number(value);
    if (!Number.isFinite(number)) return "n/a";
    return `${number >= 0 ? "+" : ""}${number.toFixed(2)}%`;
  };
  const positions = report.positions.map((position, index) => (
    `${index + 1}. ${position.pool_name} | ${signed(position.pnl_sol)} (${signedPct(position.pnl_pct)}) | ` +
    `◎${fixed(position.principal_sol)} → ◎${fixed(position.final_sol)} | ${position.minutes_held}m`
  ));
  return [
    `Kinerja final on-chain (${report.hours == null ? "all time" : `${report.hours} jam`})`,
    "Sumber: arus wallet lifecycle ter-rekonsiliasi; tanpa fallback web-LP",
    "",
    `Settlement tunai: ${report.total_positions_settled} | Win rate: ${report.win_rate_pct == null ? "N/A" : `${report.win_rate_pct.toFixed(2)}%`}`,
    `Net PnL: ${signed(report.total_pnl_sol)} (${signedPct(report.total_pnl_pct)})`,
    `Modal → Akhir: ◎${fixed(report.total_principal_sol)} → ◎${fixed(report.total_final_sol)}`,
    `Arus Wallet: keluar ◎${fixed(report.total_wallet_deploy_outflow_sol)} | kembali ◎${fixed(report.total_wallet_post_deploy_inflow_sol)}`,
    `Biaya transaksi: ◎${fixed(report.total_tx_fee_sol)}`,
    report.settlement_pending_count > 0 ? `Settlement tertunda: ${report.settlement_pending_count}` : null,
    report.excluded_non_cash_count > 0 ? `Settlement non-tunai dikecualikan: ${report.excluded_non_cash_count}` : null,
    positions.length ? "\nSettlement terbaru:" : null,
    ...positions,
  ].filter(Boolean).join("\n");
}

async function updateExtraSearchSymbols(symbols, reason) {
  const next = dedupeExtraSearchSymbols(symbols);
  const result = await executeTool("update_config", {
    changes: { extraSearchSymbols: next },
    reason,
  });
  if (!result?.success) {
    throw new Error(result?.error || `Config update failed. Unknown: ${(result?.unknown || []).join(", ") || "none"}`);
  }
  return next;
}

async function handleExtraSearchCommand(text) {
  if (/^\/(?:extra|extras|watch)(?:@\w+)?$/i.test(text)) {
    await sendMessage(formatExtraSearchStatus()).catch(() => {});
    return true;
  }

  const addExtraMatch = text.match(/^\/add(?:@\w+)?(?:\s+(.+))?$/i);
  if (addExtraMatch) {
    try {
      const symbol = normalizeExtraSearchSymbol(addExtraMatch[1]);
      if (!symbol) {
        await sendMessage(`Usage: /add <symbol_or_mint>\n\n${formatExtraSearchStatus()}`).catch(() => {});
        return true;
      }
      const current = dedupeExtraSearchSymbols(getExtraSearchSymbols());
      if (current.some((entry) => extraSearchSymbolKey(entry) === extraSearchSymbolKey(symbol))) {
        await sendMessage(`Already tracked: ${symbol}\n\n${formatExtraSearchStatus(current)}`).catch(() => {});
        return true;
      }
      const next = await updateExtraSearchSymbols([...current, symbol], "Telegram slash command /add extraSearchSymbols");
      await sendMessage(`✅ Added ${symbol}\n\n${formatExtraSearchStatus(next)}`).catch(() => {});
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return true;
  }

  const remExtraMatch = text.match(/^\/rem(?:@\w+)?(?:\s+(.+))?$/i);
  if (remExtraMatch) {
    try {
      const symbol = normalizeExtraSearchSymbol(remExtraMatch[1]);
      if (!symbol) {
        await sendMessage(`Usage: /rem <symbol_or_mint>\n\n${formatExtraSearchStatus()}`).catch(() => {});
        return true;
      }
      const current = dedupeExtraSearchSymbols(getExtraSearchSymbols());
      const target = extraSearchSymbolKey(symbol);
      const nextRaw = current.filter((entry) => extraSearchSymbolKey(entry) !== target);
      if (nextRaw.length === current.length) {
        await sendMessage(`Not found: ${symbol}\n\n${formatExtraSearchStatus(current)}`).catch(() => {});
        return true;
      }
      const next = await updateExtraSearchSymbols(nextRaw, "Telegram slash command /rem extraSearchSymbols");
      await sendMessage(`✅ Removed ${symbol}\n\n${formatExtraSearchStatus(next)}`).catch(() => {});
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return true;
  }

  return false;
}

function parseConfigValue(raw) {
  const value = String(raw ?? "").trim();
  if (!value.length) return "";
  if (/^(true|false)$/i.test(value)) return value.toLowerCase() === "true";
  if (/^null$/i.test(value)) return null;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if ((value.startsWith("[") && value.endsWith("]")) || (value.startsWith("{") && value.endsWith("}"))) {
    return JSON.parse(value);
  }
  return value;
}

function settingValue(key) {
  const values = {
    solMode: config.management.solMode,
    lpAgentRelayEnabled: config.api.lpAgentRelayEnabled,
    chartIndicatorsEnabled: config.indicators.enabled,
    trailingTakeProfit: config.management.trailingTakeProfit,
    useDiscordSignals: config.screening.useDiscordSignals,
    blockPvpSymbols: config.screening.blockPvpSymbols,
    strategy: config.strategy.strategy,
    minBinsBelow: config.strategy.minBinsBelow,
    maxBinsBelow: config.strategy.maxBinsBelow,
    defaultBinsBelow: config.strategy.defaultBinsBelow,
    deployAmountSol: config.management.deployAmountSol,
    gasReserve: config.management.gasReserve,
    maxPositions: config.risk.maxPositions,
    maxDeployAmount: config.risk.maxDeployAmount,
    takeProfitPct: config.management.takeProfitPct,
    stopLossPct: config.management.stopLossPct,
    trailingTriggerPct: config.management.trailingTriggerPct,
    trailingDropPct: config.management.trailingDropPct,
    repeatDeployCooldownEnabled: config.management.repeatDeployCooldownEnabled,
    repeatDeployCooldownTriggerCount: config.management.repeatDeployCooldownTriggerCount,
    repeatDeployCooldownHours: config.management.repeatDeployCooldownHours,
    repeatDeployCooldownMinFeeEarnedPct: config.management.repeatDeployCooldownMinFeeEarnedPct,
    managementIntervalMin: config.schedule.managementIntervalMin,
    screeningIntervalMin: config.schedule.screeningIntervalMin,
    indicatorEntryPreset: config.indicators.entryPreset,
    indicatorExitPreset: config.indicators.exitPreset,
    rsiLength: config.indicators.rsiLength,
    indicatorIntervals: config.indicators.intervals,
    requireAllIntervals: config.indicators.requireAllIntervals,
  };
  return values[key];
}

function fmtSettingValue(value) {
  if (Array.isArray(value)) return value.join(",");
  if (typeof value === "boolean") return value ? "on" : "off";
  return String(value);
}

function settingButton(label, data) {
  return { text: label, callback_data: data };
}

function toggleButton(key, label) {
  return settingButton(`${label}: ${fmtSettingValue(settingValue(key))}`, `cfg:toggle:${key}`);
}

function stepButtons(key, label, step, { digits = 2 } = {}) {
  const value = Number(settingValue(key));
  const shown = Number.isFinite(value) ? value.toFixed(digits).replace(/\.?0+$/, "") : "?";
  return [
    settingButton(`- ${label}`, `cfg:step:${key}:${-step}`),
    settingButton(`${label}: ${shown}`, `cfg:noop`),
    settingButton(`+ ${label}`, `cfg:step:${key}:${step}`),
  ];
}

function renderSettingsMenu(page = "main") {
  const title = page === "main" ? "Settings menu" : `Settings: ${page}`;
  const summary = [
    title,
    "",
    `Mode: ${config.management.solMode ? "SOL" : "USD"} | Relay: ${config.api.lpAgentRelayEnabled ? "on" : "off"}`,
    `Strategy: ${config.strategy.strategy} | bins ${config.strategy.minBinsBelow}-${config.strategy.maxBinsBelow} | deploy ${config.management.deployAmountSol} SOL`,
    `TP target/gate/SL: ${config.management.takeProfitPct}% / ${getEffectiveTakeProfitPct(config.management).toFixed(2)}% / ${config.management.stopLossPct}% | trailing ${config.management.trailingTakeProfit ? "on" : "off"}`,
    `Indicators: ${config.indicators.enabled ? "on" : "off"} | entry ${config.indicators.entryPreset} | ${fmtSettingValue(config.indicators.intervals)}`,
  ].join("\n");

  const nav = [
    [
      settingButton("Main", "cfg:page:main"),
      settingButton("Risk", "cfg:page:risk"),
      settingButton("Screen", "cfg:page:screen"),
      settingButton("Indicators", "cfg:page:indicators"),
    ],
  ];

  const footer = [
    [
      settingButton("Refresh", `cfg:page:${page}`),
      settingButton("Close", "cfg:close"),
    ],
  ];

  let rows;
  if (page === "risk") {
    rows = [
      stepButtons("deployAmountSol", "Deploy", 0.1),
      stepButtons("gasReserve", "Gas", 0.05),
      stepButtons("maxPositions", "Max pos", 1, { digits: 0 }),
      stepButtons("maxDeployAmount", "Max SOL", 1, { digits: 0 }),
      stepButtons("takeProfitPct", "TP %", 1, { digits: 0 }),
      stepButtons("stopLossPct", "SL %", 5, { digits: 0 }),
      [toggleButton("trailingTakeProfit", "Trailing TP")],
      stepButtons("trailingTriggerPct", "Trail trigger", 0.5, { digits: 1 }),
      stepButtons("trailingDropPct", "Trail drop", 0.5, { digits: 1 }),
      [toggleButton("repeatDeployCooldownEnabled", "Repeat cooldown")],
      stepButtons("repeatDeployCooldownTriggerCount", "Repeat count", 1, { digits: 0 }),
      stepButtons("repeatDeployCooldownHours", "Repeat hrs", 1, { digits: 0 }),
      stepButtons("repeatDeployCooldownMinFeeEarnedPct", "Fee earned %", 0.1, { digits: 1 }),
    ];
  } else if (page === "screen") {
    rows = [
      [toggleButton("useDiscordSignals", "Discord signals"), toggleButton("blockPvpSymbols", "PVP canonical")],
      [
        settingButton(`Strategy: spot`, "cfg:set:strategy:spot"),
        settingButton(`Strategy: bid_ask`, "cfg:set:strategy:bid_ask"),
      ],
      stepButtons("minBinsBelow", "Min bins", 1, { digits: 0 }),
      stepButtons("maxBinsBelow", "Max bins", 1, { digits: 0 }),
      stepButtons("defaultBinsBelow", "Default bins", 1, { digits: 0 }),
      stepButtons("managementIntervalMin", "Manage min", 1, { digits: 0 }),
      stepButtons("screeningIntervalMin", "Screen min", 5, { digits: 0 }),
    ];
  } else if (page === "indicators") {
    rows = [
      [toggleButton("chartIndicatorsEnabled", "Chart indicators"), toggleButton("requireAllIntervals", "Require all TF")],
      [
        settingButton("TF: 5m", "cfg:set:indicatorIntervals:5_MINUTE"),
        settingButton("TF: 15m", "cfg:set:indicatorIntervals:15_MINUTE"),
        settingButton("TF: both", "cfg:set:indicatorIntervals:both"),
      ],
      [
        settingButton("Entry: ST", "cfg:set:indicatorEntryPreset:supertrend_break"),
        settingButton("Entry: RSI", "cfg:set:indicatorEntryPreset:rsi_reversal"),
        settingButton("Entry: ST/RSI", "cfg:set:indicatorEntryPreset:supertrend_or_rsi"),
      ],
      [
        settingButton("Exit: ST", "cfg:set:indicatorExitPreset:supertrend_break"),
        settingButton("Exit: RSI", "cfg:set:indicatorExitPreset:rsi_reversal"),
        settingButton("Exit: BB+RSI", "cfg:set:indicatorExitPreset:bb_plus_rsi"),
      ],
      stepButtons("rsiLength", "RSI len", 1, { digits: 0 }),
    ];
  } else {
    rows = [
      [toggleButton("solMode", "SOL mode"), toggleButton("lpAgentRelayEnabled", "LPAgent relay")],
      [toggleButton("chartIndicatorsEnabled", "Chart indicators"), toggleButton("trailingTakeProfit", "Trailing TP")],
      [
        settingButton("Risk / deploy", "cfg:page:risk"),
        settingButton("Screening", "cfg:page:screen"),
      ],
      [
        settingButton("Indicators", "cfg:page:indicators"),
        settingButton("Show config", "cfg:show"),
      ],
    ];
  }

  return { text: summary, keyboard: [...nav, ...rows, ...footer] };
}

async function showSettingsMenu({ messageId = null, page = "main" } = {}) {
  const menu = renderSettingsMenu(page);
  if (messageId) {
    await editMessageWithButtons(menu.text, messageId, menu.keyboard);
  } else {
    await sendMessageWithButtons(menu.text, menu.keyboard);
  }
}

function normalizeMenuValue(key, raw) {
  if (key === "indicatorIntervals") {
    if (raw === "both") return ["5_MINUTE", "15_MINUTE"];
    return [raw];
  }
  return parseConfigValue(raw);
}

async function applySettingsMenuCallback(msg) {
  const data = msg.callbackData || msg.text || "";
  const parts = data.split(":");
  const action = parts[1];
  let page = "main";

  if (action === "noop") {
    await answerCallbackQuery(msg.callbackQueryId);
    return;
  }
  if (action === "close") {
    await answerCallbackQuery(msg.callbackQueryId, "Closed");
    await editMessage("Settings menu closed.", msg.messageId);
    return;
  }
  if (action === "show") {
    await answerCallbackQuery(msg.callbackQueryId);
    await editMessageWithButtons(formatConfigSnapshot(), msg.messageId, [[settingButton("Back", "cfg:page:main")]]);
    return;
  }
  if (action === "page") {
    page = parts[2] || "main";
    await answerCallbackQuery(msg.callbackQueryId);
    await showSettingsMenu({ messageId: msg.messageId, page });
    return;
  }

  const key = parts[2];
  let value;
  if (action === "toggle") {
    value = !Boolean(settingValue(key));
  } else if (action === "step") {
    const current = Number(settingValue(key));
    const delta = Number(parts[3]);
    if (!Number.isFinite(current) || !Number.isFinite(delta)) {
      await answerCallbackQuery(msg.callbackQueryId, "Invalid setting");
      return;
    }
    value = Number((current + delta).toFixed(4));
    if (key === "maxPositions") value = Math.max(1, Math.round(value));
    if (key === "rsiLength") value = Math.max(2, Math.round(value));
    if (key === "repeatDeployCooldownTriggerCount") value = Math.max(1, Math.round(value));
    if (key === "repeatDeployCooldownHours") value = Math.max(0, Math.round(value));
    if (key === "repeatDeployCooldownMinFeeEarnedPct") value = Math.max(0, value);
    if (["minBinsBelow", "maxBinsBelow", "defaultBinsBelow"].includes(key)) value = Math.max(35, Math.round(value));
    if (["deployAmountSol", "gasReserve", "maxDeployAmount"].includes(key)) value = Math.max(0, value);
  } else if (action === "set") {
    value = normalizeMenuValue(key, parts.slice(3).join(":"));
  } else {
    await answerCallbackQuery(msg.callbackQueryId, "Unknown action");
    return;
  }

  const result = await executeTool("update_config", {
    changes: { [key]: value },
    reason: "Telegram settings menu",
  });
  if (!result?.success) {
    await answerCallbackQuery(msg.callbackQueryId, "Config update failed");
    return;
  }
  page = key.startsWith("indicator") || key === "chartIndicatorsEnabled" || key === "rsiLength" || key === "requireAllIntervals"
    ? "indicators"
    : ["useDiscordSignals", "blockPvpSymbols", "strategy", "minBinsBelow", "maxBinsBelow", "defaultBinsBelow", "managementIntervalMin", "screeningIntervalMin"].includes(key)
      ? "screen"
      : "risk";
  await answerCallbackQuery(msg.callbackQueryId, `Updated ${key}`);
  await showSettingsMenu({ messageId: msg.messageId, page });
}

function formatHelpText() {
  return [
    "Telegram commands",
    "",
    "/help — show commands",
    "/status — wallet, positions, rollout, breaker, and ledger",
    "/opsstatus — rollout, evidence, breaker, and ledger only",
    "/wallet — wallet, deploy amount, HiveMind status",
    "/positions — list open positions",
    "/pool <n> — detailed info for one open position",
    "/close <n> — close one position by index",
    "/closecooldown <n> — close one position and cooldown its token",
    "/cooldown <pool_or_token> — cooldown token/pool without closing",
    "/closeall — close all open positions",
    "/cleanup <closed_position_address> — preview scoped economic cleanup",
    `/cleanup execute <closed_position_address> ${CLEANUP_EXECUTION_CONFIRMATION} — execute scoped cleanup`,
    "/breaker — circuit-breaker state",
    "/resumebreaker — safely resume the current breaker trip with a confirmation button",
    `/breaker resume ${BREAKER_RESUME_CONFIRMATION} — manually resume entry`,
    `/breaker repair ${CIRCUIT_BREAKER_DURABILITY_REPAIR_CONFIRMATION} — restore a durable latched breaker after storage uncertainty`,
    "/canaryguard — inspect retained global live-canary deploy guard",
    `/canaryguard reconcile <guard_operation_id> ${LIVE_CANARY_GUARD_RECONCILIATION_CONFIRMATION} — reconcile and release retained guard`,
    "/set <n> <note> — set note/instruction on position",
    "/config — show important runtime config",
    "/settings — button menu for common config",
    "/setcfg <key> <value> — update persisted config",
    "/extra — show extra search tokens",
    "/add <symbol> — add extra search token",
    "/rem <symbol> — remove extra search token",
    "/screen — refresh deterministic candidate list",
    "/candidates — show latest cached candidates",
    "/deploy <n> — deploy candidate by cached index",
    "/deploy <token_address> — find best pool for token and deploy",
    "/briefing — morning briefing",
    "/performance [hours|all] — reconciled on-chain cash-settled PnL",
    "/hive — HiveMind sync status",
    "/hive pull — manual HiveMind pull now",
    "/pause — stop cron cycles",
    "/resume — start cron cycles again",
    "/stop — shut down agent",
  ].join("\n");
}

async function runDeterministicScreen(limit = 5) {
  const top = await getTopCandidates({ limit });
  const candidates = (top?.candidates || top?.pools || []).slice(0, limit);
  setLatestCandidates(candidates);
  if (candidates.length > 0) {
    const lines = candidates.map((pool, i) => {
      const feeTvl = pool.fee_active_tvl_ratio ?? pool.fee_tvl_ratio ?? "?";
      const vol = pool.volume_window ?? pool.volume_24h ?? "?";
      return `${i + 1}. ${pool.name} | ${pool.pool}\n   fee/aTVL ${feeTvl}% | vol $${vol} | organic ${pool.organic_score ?? "?"}`;
    });
    return `Top candidates (${candidates.length})\n\n${lines.join("\n")}`;
  }
  const examples = (top?.filtered_examples || []).slice(0, 3)
    .map((entry) => `- ${entry.name}: ${entry.reason}`)
    .join("\n");
  return examples
    ? `No candidates available.\nFiltered examples:\n${examples}`
    : "No candidates available right now.";
}

export function assertManualPaperDeploymentGate() {
  const gate = getPaperDeploymentGate();
  if (gate?.pass === true) return gate;
  const coverage = gate?.historicalReplayCoverage || {};
  const actual = Number.isSafeInteger(coverage.actual) && coverage.actual >= 0 ? coverage.actual : "?";
  const required = Number.isSafeInteger(coverage.required) && coverage.required >= 0 ? coverage.required : 30;
  const reason = gate?.reason || coverage.reason || "HISTORICAL_REPLAY_COVERAGE_BELOW_MINIMUM";
  throw new Error(
    `Manual deployment blocked — historical replay coverage ${actual}/${required}: ${reason}. ` +
    "Existing paper positions remain under observation and settlement.",
  );
}

export async function deployLatestCandidate(index) {
  // Manual deploys are a separate operator path and must receive the same
  // fresh paper-entry authorization before candidate, wallet, or tool work.
  assertManualPaperDeploymentGate();
  const candidate = _latestCandidates[index];
  if (!candidate) {
    throw new Error("Invalid candidate index. Run /screen first.");
  }
  if (_latestCandidates.length === 1) {
    const mint = candidate.base?.mint || candidate.base_mint || null;
    const [smartWallets, narrative, tokenInfo] = await Promise.allSettled([
      checkSmartWalletsOnPool({ pool_address: candidate.pool }),
      mint ? getTokenNarrative({ mint }) : Promise.resolve(null),
      mint ? getTokenInfo({ query: mint }) : Promise.resolve(null),
    ]);
    const context = {
      pool: candidate,
      sw: smartWallets.status === "fulfilled" ? smartWallets.value : null,
      n: narrative.status === "fulfilled" ? narrative.value : null,
      ti: tokenInfo.status === "fulfilled" ? tokenInfo.value?.results?.[0] : null,
    };
    const skipReason = getLoneCandidateSkipReason(context);
    if (skipReason) {
      appendDecision({
        type: "no_deploy",
        actor: "SCREENER",
        summary: "Single cached candidate skipped",
        reason: skipReason,
        pool: candidate.pool,
        pool_name: candidate.name,
      });
      throw new Error(`NO DEPLOY: only cached candidate ${candidate.name} is not worth deploying — ${skipReason}`);
    }
  }
  const deployAmount = computeDeployAmount((await getWalletBalances()).sol);
  const binsBelow = computeBinsBelow(candidate.volatility);
  // Candidate reconnaissance can take time; refresh the raw replay decision at
  // the actual executeTool boundary as well as at manual-command entry.
  assertManualPaperDeploymentGate();
  const result = await executeTool("deploy_position", {
    pool_address: candidate.pool,
    amount_y: deployAmount,
    strategy: config.strategy.strategy,
    bins_below: binsBelow,
    bins_above: 0,
    pool_name: candidate.name,
    base_mint: candidate.base?.mint || candidate.base_mint || null,
    bin_step: candidate.bin_step,
    base_fee: candidate.base_fee,
    volatility: candidate.volatility,
    fee_tvl_ratio: candidate.fee_active_tvl_ratio ?? candidate.fee_tvl_ratio,
    organic_score: candidate.organic_score,
    initial_value_usd: candidate.tvl ?? candidate.active_tvl ?? null,
  });
  if (result?.success === false || result?.error) {
    throw new Error(result.error || "Deploy failed");
  }
  return { result, candidate, deployAmount, binsBelow };
}


export async function deployPoolAddress(poolAddress) {
  assertManualPaperDeploymentGate();
  const candidate = await getPoolDetail({ pool_address: poolAddress, timeframe: config.screening.timeframe });
  if (!candidate?.pool && !candidate?.pool_address) {
    throw new Error(`Pool detail not found for ${poolAddress}`);
  }
  candidate.pool = candidate.pool || candidate.pool_address || poolAddress;
  candidate.name = candidate.name || `${poolAddress.slice(0, 8)}...`;
  candidate.base_mint = candidate.base?.mint || candidate.base_mint || candidate.token_x?.address || null;
  candidate.base_fee = candidate.base_fee ?? candidate.fee_pct;
  candidate.fee_tvl_ratio = candidate.fee_active_tvl_ratio ?? candidate.fee_tvl_ratio;
  setLatestCandidates([candidate]);
  return deployLatestCandidate(0);
}

export async function deployTokenAddress(tokenAddress) {
  assertManualPaperDeploymentGate();
  const found = await searchPools({ query: tokenAddress, limit: 10 });
  const mint = String(tokenAddress || "").trim();
  const rawPools = (found?.pools || []).filter((p) =>
    p?.token_x?.mint === mint || p?.token_y?.mint === mint
  );
  if (!rawPools.length) {
    throw new Error(`No DLMM pools found for token ${mint}`);
  }

  const detailed = [];
  const filtered = [];
  for (const raw of rawPools) {
    try {
      const detail = await getPoolDetail({ pool_address: raw.pool, timeframe: config.screening.timeframe });
      const baseMint = detail?.base?.mint || detail?.base_mint || detail?.token_x?.address || raw.token_x?.mint || null;
      if (baseMint !== mint) {
        filtered.push(`${raw.name || raw.pool}: token is not base/token_x for this pool`);
        continue;
      }
      const tvl = Number(detail.tvl ?? detail.active_tvl ?? raw.tvl ?? 0);
      const minTvl = Number(config.screening.minTvl ?? 0);
      const maxTvl = config.screening.maxTvl == null ? null : Number(config.screening.maxTvl);
      const feeActiveTvlRatio = Number(detail.fee_active_tvl_ratio ?? detail.fee_tvl_ratio ?? 0);
      const minFeeActiveTvlRatio = Number(config.screening.minFeeActiveTvlRatio ?? 0);
      const volatility = Number(detail.volatility ?? 0);
      if (Number.isFinite(minTvl) && minTvl > 0 && tvl < minTvl) { filtered.push(`${detail.name || raw.name}: TVL below min`); continue; }
      if (Number.isFinite(maxTvl) && maxTvl > 0 && tvl > maxTvl) { filtered.push(`${detail.name || raw.name}: TVL above max`); continue; }
      if (Number.isFinite(minFeeActiveTvlRatio) && minFeeActiveTvlRatio > 0 && (!Number.isFinite(feeActiveTvlRatio) || feeActiveTvlRatio < minFeeActiveTvlRatio)) { filtered.push(`${detail.name || raw.name}: fee/active-TVL below min`); continue; }
      if (!Number.isFinite(volatility) || volatility <= 0) { filtered.push(`${detail.name || raw.name}: volatility unusable`); continue; }
      detailed.push(detail);
    } catch (e) {
      filtered.push(`${raw.name || raw.pool}: ${e.message}`);
    }
  }
  if (!detailed.length) {
    throw new Error(`No eligible pool for token ${mint}. ${filtered.slice(0, 3).join('; ')}`);
  }
  detailed.sort((a, b) => degenScore(b, config.opportunity) - degenScore(a, config.opportunity));
  const candidate = detailed[0];
  setLatestCandidates([candidate]);
  return deployLatestCandidate(0);
}

function appendHistory(userMsg, assistantMsg) {
  sessionHistory.push({ role: "user", content: userMsg });
  sessionHistory.push({ role: "assistant", content: assistantMsg });
  // Trim to last MAX_HISTORY messages
  if (sessionHistory.length > MAX_HISTORY) {
    sessionHistory.splice(0, sessionHistory.length - MAX_HISTORY);
  }
}

function refreshPrompt() {
  if (!_ttyInterface) return;
  _ttyInterface.setPrompt(buildPrompt());
  _ttyInterface.prompt(true);
}

function scheduleTelegramQueueDrain(delayMs = 500) {
  if (_telegramDrainTimer || _telegramQueue.length === 0) return;
  _telegramDrainTimer = setTimeout(() => {
    _telegramDrainTimer = null;
    drainTelegramQueue().catch((error) => log("telegram_error", `Queue drain failed: ${error.message}`));
  }, delayMs);
}

function enqueueTelegramMessage(msg, label) {
  if (_telegramQueue.length >= 5) {
    sendMessage("Queue is full (5 messages). Wait for the current command to finish.").catch(() => {});
    return;
  }
  _telegramQueue.push(msg);
  log("telegram", `Queued ${label} (depth ${_telegramQueue.length})`);
  sendMessage(`⏳ Queued (${_telegramQueue.length} in queue): ${label}`).catch(() => {});
  scheduleTelegramQueueDrain();
}

async function drainTelegramQueue() {
  if (_telegramQueue.length === 0) return;
  if (_telegramCommandBusy || _managementBusy || _screeningBusy || busy) {
    scheduleTelegramQueueDrain();
    return;
  }
  const queued = _telegramQueue.shift();
  await telegramHandler(queued);
}

function telegramCommandLabel(text) {
  const command = String(text || "").match(/^\/([a-z0-9_]+)(?:\s+([a-z0-9_]+))?/i);
  if (!command) return "free-form";
  return `/${command[1].toLowerCase()}${command[2] ? ` ${command[2].toLowerCase()}` : ""}`;
}

async function telegramHandler(msg) {
  const text = msg?.text?.trim();
  if (!text) return;
  const label = telegramCommandLabel(text);
  if (_telegramCommandBusy || _managementBusy || _screeningBusy || busy) {
    enqueueTelegramMessage(msg, label);
    return;
  }
  _telegramCommandBusy = true;
  const startedAt = Date.now();
  log("telegram", `Incoming ${label}`);
  try {
    return await handleTelegramMessage(msg);
  } finally {
    log("telegram", `Completed ${label} in ${Date.now() - startedAt}ms`);
    _telegramCommandBusy = false;
    scheduleTelegramQueueDrain(0);
  }
}

async function handleTelegramMessage(msg) {
  const text = msg?.text?.trim();
  if (!text) return;
  if (msg?.isCallback && text === BREAKER_RESUME_CANCEL_CALLBACK) {
    await answerCallbackQuery(msg.callbackQueryId, "Cancelled").catch(() => {});
    await editMessage("Circuit-breaker resume cancelled. The current latch was not changed.", msg.messageId).catch(() => {});
    return;
  }
  const expectedBreakerTripAtMs = msg?.isCallback ? parseBreakerResumeCallback(text) : null;
  if (expectedBreakerTripAtMs != null) {
    await answerCallbackQuery(msg.callbackQueryId, "Checking current breaker...").catch(() => {});
    try {
      const current = await getCircuitBreakerState();
      const currentTripAtMs = Number(current?.trippedAtMs);
      if (current?.tripped !== true && current?.manualResumeRequired !== true) {
        await editMessage(`${formatBreakerStatus(current)}\n\nNo resume was needed; the breaker is already ready.`, msg.messageId).catch(() => {});
        return;
      }
      if (currentTripAtMs !== expectedBreakerTripAtMs) {
        await editMessage([
          "⚠️ This confirmation button is stale. The breaker latch was not changed.",
          formatBreakerStatus(current),
          "Use /resumebreaker to inspect and confirm the current trip.",
        ].join("\n\n"), msg.messageId).catch(() => {});
        return;
      }
      const breaker = await manuallyResumeCircuitBreaker();
      const persistenceDiagnostic = getCircuitBreakerPersistenceStatus()?.diagnostic;
      await editMessage([
        "✅ Circuit breaker manually resumed.",
        formatBreakerStatus(breaker),
        persistenceDiagnostic
          ? `⚠️ State was committed, but lock cleanup reported: ${persistenceDiagnostic}`
          : null,
      ].filter(Boolean).join("\n\n"), msg.messageId).catch(() => {});
    } catch (e) {
      const message = await formatCommittedBreakerCleanupFailure({ operation: "resume", error: e });
      await editMessage(message, msg.messageId).catch(() => {});
    }
    return;
  }
  if (msg?.isCallback && text.startsWith("cfg:")) {
    try {
      await applySettingsMenuCallback(msg);
    } catch (e) {
      await answerCallbackQuery(msg.callbackQueryId, e.message).catch(() => {});
    }
    return;
  }
  if (text === "/settings" || text === "/menu" || text === "/configmenu") {
    await showSettingsMenu().catch((e) => sendMessage(`Settings error: ${e.message}`).catch(() => {}));
    return;
  }
  if (await handleExtraSearchCommand(text)) {
    return;
  }
  if (_managementBusy || _screeningBusy || busy) {
    enqueueTelegramMessage(msg, telegramCommandLabel(text));
    return;
  }

  if (text === "/briefing") {
    try {
      const briefing = await generateBriefing();
      await sendHTML(briefing);
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  const performanceMatch = text.match(/^\/performance(?:\s+(all|\d+(?:\.\d+)?))?$/i);
  if (performanceMatch) {
    try {
      const requested = performanceMatch[1];
      const hours = requested?.toLowerCase() === "all"
        ? null
        : Math.min(8_760, Math.max(1, requested == null ? 24 : Number(requested)));
      const report = getSettlementPerformanceHistory({ hours, limit: 10 });
      await sendMessage(formatSettlementPerformanceMessage(report));
    } catch (e) {
      await sendMessage(`On-chain settlement report unavailable: ${e.message}\nNo web-LP fallback was used.`).catch(() => {});
    }
    return;
  }

  if (text === "/help") {
    await sendMessage(formatHelpText()).catch(() => {});
    return;
  }

  if (text === "/wallet" || text === "/status") {
    try {
      const [wallet, positions, operatorStatus] = await Promise.all([
        getWalletBalances(),
        getMyPositions({ force: true }),
        text === "/status" ? formatOperatorStatus() : Promise.resolve(null),
      ]);
      const suffix = text === "/status" && positions.total_positions
        ? `\n\nUse /positions for the numbered list.`
        : "";
      await sendMessage([
        formatWalletStatus(wallet, positions),
        operatorStatus ? `\n${operatorStatus}` : null,
        suffix,
      ].filter(Boolean).join("\n")).catch(() => {});
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  if (text === "/opsstatus") {
    await sendMessage(await formatOperatorStatus()).catch((e) => sendMessage(`Error: ${e.message}`).catch(() => {}));
    return;
  }

  if (text === "/config") {
    await sendMessage(formatConfigSnapshot()).catch(() => {});
    return;
  }

  if (text === "/positions") {
    try {
      const { positions, total_positions } = await getMyPositions({ force: true });
      if (total_positions === 0) { await sendMessage("No open positions."); return; }
      const cur = config.management.solMode ? "◎" : "$";
      const lines = positions.map((p, i) => {
        const pnl = p.pnl_usd >= 0 ? `+${cur}${p.pnl_usd}` : `-${cur}${Math.abs(p.pnl_usd)}`;
        const age = p.age_minutes != null ? `${p.age_minutes}m` : "?";
        const oor = !p.in_range ? " ⚠️OOR" : "";
        return `${i + 1}. ${p.pair} | ${cur}${p.total_value_usd} | Est. PnL: ${pnl} | fees: ${cur}${p.unclaimed_fees_usd} | ${age}${oor}`;
      });
      await sendMessage(`📊 Open Positions (${total_positions})\nPnL source: executable estimate\n\n${lines.join("\n")}\n\n/close <n> to close | /set <n> <note> to set instruction`);
    } catch (e) { await sendMessage(`Error: ${e.message}`).catch(() => {}); }
    return;
  }

  const poolMatch = text.match(/^\/pool\s+(\d+)$/i);
  if (poolMatch) {
    try {
      const idx = parseInt(poolMatch[1]) - 1;
      const { positions } = await getMyPositions({ force: true });
      if (idx < 0 || idx >= positions.length) { await sendMessage("Invalid number. Use /positions first."); return; }
      const pos = positions[idx];
      await sendMessage([
        `${idx + 1}. ${pos.pair}`,
        `Pool: ${pos.pool}`,
        `Position: ${pos.position}`,
        `Range: ${pos.lower_bin} → ${pos.upper_bin} | active ${pos.active_bin}`,
        `Estimated PnL: ${pos.pnl_pct ?? "?"}% | fees: ${config.management.solMode ? "◎" : "$"}${pos.unclaimed_fees_usd ?? "?"}`,
        `PnL source: executable estimate`,
        `Value: ${config.management.solMode ? "◎" : "$"}${pos.total_value_usd ?? "?"}`,
        `Age: ${pos.age_minutes ?? "?"}m | ${pos.in_range ? "IN RANGE" : `OOR ${pos.minutes_out_of_range ?? 0}m`}`,
        pos.instruction ? `Note: ${pos.instruction}` : null,
      ].filter(Boolean).join("\n"));
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  const cleanupExecuteMatch = text.match(/^\/cleanup\s+execute\s+([1-9A-HJ-NP-Za-km-z]{32,44})(?:\s+(.+))?$/);
  if (cleanupExecuteMatch) {
    const [, position, confirmation] = cleanupExecuteMatch;
    if (confirmation !== CLEANUP_EXECUTION_CONFIRMATION) {
      await sendMessage([
        "⚠️ Cleanup execution was not requested.",
        "This may submit scoped swaps, burns, and token-account closes for one closed lifecycle.",
        `Use exactly: /cleanup execute ${position} ${CLEANUP_EXECUTION_CONFIRMATION}`,
      ].join("\n")).catch(() => {});
      return;
    }
    try {
      const result = await executeConfirmedCleanup({
        position,
        confirmation,
        operatorCapability: TELEGRAM_CLEANUP_OPERATOR_CAPABILITY,
      });
      await sendMessage(cleanupResultMessage(result, { executionRequested: true })).catch(() => {});
    } catch (e) {
      await sendMessage(`Cleanup execution error: ${e.message}`).catch(() => {});
    }
    return;
  }

  const cleanupPreviewMatch = text.match(/^\/cleanup\s+([1-9A-HJ-NP-Za-km-z]{32,44})$/i);
  if (cleanupPreviewMatch) {
    try {
      const position = cleanupPreviewMatch[1];
      const result = await executeTool("reconcile_cleanup", { position, execute: false });
      await sendMessage(cleanupResultMessage(result)).catch(() => {});
    } catch (e) {
      await sendMessage(`Cleanup preview error: ${e.message}`).catch(() => {});
    }
    return;
  }

  if (/^\/cleanup(?:\s|$)/i.test(text)) {
    await sendMessage([
      "Usage: /cleanup <closed_position_address>",
      `Execution: /cleanup execute <closed_position_address> ${CLEANUP_EXECUTION_CONFIRMATION}`,
      "Preview never submits transactions. Execution is scoped to one closed ledger lifecycle and remains blocked in dry run.",
    ].join("\n")).catch(() => {});
    return;
  }

  if (text === "/resumebreaker") {
    const breaker = await getCircuitBreakerState().catch(() => null);
    const shortcut = breakerResumeShortcut(breaker);
    if (shortcut.keyboard) {
      await sendMessageWithButtons(shortcut.text, shortcut.keyboard).catch(() => {});
    } else {
      await sendMessage(shortcut.text).catch(() => {});
    }
    return;
  }

  const breakerResumeMatch = text.match(/^\/breaker\s+resume(?:\s+(.+))?$/);
  if (breakerResumeMatch) {
    if (breakerResumeMatch[1] !== BREAKER_RESUME_CONFIRMATION) {
      await sendMessage([
        "⚠️ Circuit breaker remains latched.",
        "Manual resume re-enables eligibility for future entries; it does not start cron cycles or submit a transaction.",
        `Use exactly: /breaker resume ${BREAKER_RESUME_CONFIRMATION}`,
      ].join("\n")).catch(() => {});
      return;
    }
    try {
      const breaker = await manuallyResumeCircuitBreaker();
      const persistenceDiagnostic = getCircuitBreakerPersistenceStatus()?.diagnostic;
      await sendMessage([
        "✅ Circuit breaker manually resumed.",
        formatBreakerStatus(breaker),
        persistenceDiagnostic
          ? `⚠️ State was committed, but lock cleanup reported: ${persistenceDiagnostic}`
          : null,
      ].filter(Boolean).join("\n\n")).catch(() => {});
    } catch (e) {
      const message = await formatCommittedBreakerCleanupFailure({ operation: "resume", error: e });
      await sendMessage(message).catch(() => {});
    }
    return;
  }

  const breakerRepairMatch = text.match(/^\/breaker\s+repair(?:\s+(.+))?$/);
  if (breakerRepairMatch) {
    if (breakerRepairMatch[1] !== CIRCUIT_BREAKER_DURABILITY_REPAIR_CONFIRMATION) {
      await sendMessage([
        "⚠️ Circuit breaker durability repair was not requested.",
        "Repair only recreates a known durable, manually latched state; it never resumes entry.",
        `Use exactly: /breaker repair ${CIRCUIT_BREAKER_DURABILITY_REPAIR_CONFIRMATION}`,
      ].join("\n")).catch(() => {});
      return;
    }
    try {
      const breaker = await repairCircuitBreakerDurability({
        confirmation: breakerRepairMatch[1],
        operatorCapability: TELEGRAM_BREAKER_REPAIR_OPERATOR_CAPABILITY,
      });
      await sendMessage([
        "✅ Circuit breaker durability repair completed.",
        formatBreakerStatus(breaker),
        getCircuitBreakerPersistenceStatus()?.diagnostic
          ? `⚠️ State was committed, but lock cleanup reported: ${getCircuitBreakerPersistenceStatus().diagnostic}`
          : null,
        "The breaker remains latched. Manual resume is a separate audited action.",
      ].join("\n\n")).catch(() => {});
    } catch (e) {
      const message = await formatCommittedBreakerCleanupFailure({ operation: "durability repair", error: e });
      await sendMessage(message).catch(() => {});
    }
    return;
  }

  const canaryGuardReconcileMatch = text.match(/^\/canaryguard\s+reconcile\s+(\S+)(?:\s+(.+))?$/i);
  if (canaryGuardReconcileMatch) {
    const [, guardOperationId, confirmation] = canaryGuardReconcileMatch;
    if (confirmation !== LIVE_CANARY_GUARD_RECONCILIATION_CONFIRMATION) {
      await sendMessage([
        "⚠️ Retained live-canary deploy guard remains blocked.",
        "Reconciliation verifies the durable guard journal and a fresh authoritative on-chain zero-position outcome before secure release.",
        `Use exactly: /canaryguard reconcile ${guardOperationId} ${LIVE_CANARY_GUARD_RECONCILIATION_CONFIRMATION}`,
      ].join("\n")).catch(() => {});
      return;
    }
    const result = await reconcileLiveCanaryDeployGuard({
      guardOperationId,
      confirmation,
      operatorCapability: TELEGRAM_CANARY_GUARD_OPERATOR_CAPABILITY,
    });
    if (result.success === true) {
      await sendMessage([
        "✅ Retained live-canary deploy guard reconciled and securely released.",
        `Guard operation id: ${result.operation_id}`,
        `On-chain outcome: ${result.outcome} at ${result.observed_at}`,
        "Breaker resume remains a separate explicit /breaker resume action when required.",
      ].join("\n")).catch(() => {});
    } else {
      await sendMessage([
        "❌ Retained live-canary deploy guard remains blocked.",
        `Reason: ${result.reason || "reconciliation could not be completed"}`,
        result.code ? `Code: ${result.code}` : null,
      ].filter(Boolean).join("\n")).catch(() => {});
    }
    return;
  }

  if (text === "/canaryguard") {
    await sendMessage(formatLiveCanaryDeployGuardStatus(getLiveCanaryDeployGuardStatus())).catch(() => {});
    return;
  }

  if (/^\/canaryguard(?:\s|$)/i.test(text)) {
    await sendMessage([
      "Usage: /canaryguard",
      `Resolution: /canaryguard reconcile <guard_operation_id> ${LIVE_CANARY_GUARD_RECONCILIATION_CONFIRMATION}`,
      "Resolution is operator-only and does not resume the circuit breaker automatically.",
    ].join("\n")).catch(() => {});
    return;
  }

  if (text === "/breaker") {
    const breaker = await getCircuitBreakerState().catch(() => null);
    await sendMessage(formatBreakerStatus(breaker)).catch(() => {});
    return;
  }

  const closeCooldownMatch = text.match(/^\/closecooldown\s+(\d+)$/i);
  if (closeCooldownMatch) {
    try {
      const idx = parseInt(closeCooldownMatch[1]) - 1;
      const { positions } = await getMyPositions({ force: true });
      if (idx < 0 || idx >= positions.length) { await sendMessage("Invalid number. Use /positions first."); return; }
      const pos = positions[idx];
      await sendMessage(`Closing ${pos.pair} and setting token cooldown...`);
      const result = await executeTool("close_position", { position_address: pos.position, reason: "manual /closecooldown" });
      if (isExecutedTransactionSuccess("close_position", result)) {
        const cooldown = setManualTokenCooldown({
          pool_address: pos.pool,
          base_mint: pos.base_mint || result.base_mint,
          name: pos.pair,
          hours: config.management.repeatDeployCooldownHours,
          reason: "manual /closecooldown",
        });
        const closeTxs = result.close_txs?.length ? result.close_txs : result.txs;
        await sendMessage([
          `✅ Closed ${pos.pair}`,
          `Reason: ${result.close_reason || "manual /closecooldown"}`,
          ...formatCloseSolLines(result),
          `Token cooldown until: ${cooldown.cooldown_until || "n/a"}`,
          `Close txs: ${closeTxs?.join(", ") || "n/a"}`,
        ].join("\n"));
      } else if (result?.dry_run === true) {
        await sendMessage(`🧪 Close preview for ${pos.pair}; no transaction was submitted and no cooldown was applied.`);
      } else {
        await sendMessage(`❌ Close failed: ${JSON.stringify(result)}`);
      }
    } catch (e) { await sendMessage(`Error: ${e.message}`).catch(() => {}); }
    return;
  }

  const cooldownMatch = text.match(/^\/cooldown\s+([1-9A-HJ-NP-Za-km-z]{32,44})$/i);
  if (cooldownMatch) {
    try {
      const address = cooldownMatch[1];
      let poolAddress = null;
      let baseMint = null;
      let name = address.slice(0, 8);

      const tracked = getTrackedPositions().find((p) => p.pool === address || p.signal_snapshot?.base_mint === address);
      if (tracked) {
        poolAddress = tracked.pool || null;
        baseMint = tracked.signal_snapshot?.base_mint || null;
        name = tracked.pool_name || name;
      }

      if (!poolAddress) {
        try {
          const detail = await getPoolDetail({ pool_address: address, timeframe: config.screening.timeframe });
          if (detail?.pool || detail?.pool_address) {
            poolAddress = detail.pool || detail.pool_address || address;
            baseMint = detail.base?.mint || detail.base_mint || detail.token_x?.address || null;
            name = detail.name || name;
          }
        } catch {}
      }

      if (!poolAddress && !baseMint) {
        baseMint = address;
        try {
          const found = await searchPools({ query: address, limit: 1 });
          const first = found?.pools?.[0];
          if (first) {
            poolAddress = first.pool || null;
            name = first.name || name;
          }
        } catch {}
      }

      const cooldown = setManualTokenCooldown({
        pool_address: poolAddress,
        base_mint: baseMint,
        name,
        hours: config.management.repeatDeployCooldownHours,
        reason: "manual /cooldown",
      });
      if (!cooldown?.success) {
        await sendMessage(`❌ Cooldown failed: ${cooldown?.error || "unknown error"}`).catch(() => {});
        return;
      }
      await sendMessage([
        `✅ Cooldown set for ${name}`,
        poolAddress ? `Pool: ${poolAddress}` : null,
        baseMint ? `Token: ${baseMint}` : null,
        `Until: ${cooldown.cooldown_until || "n/a"}`,
        `Updated entries: ${cooldown.updated ?? "?"}`,
      ].filter(Boolean).join("\n")).catch(() => {});
    } catch (e) { await sendMessage(`Error: ${e.message}`).catch(() => {}); }
    return;
  }

  const closeMatch = text.match(/^\/close\s+(\d+)$/i);
  if (closeMatch) {
    try {
      const idx = parseInt(closeMatch[1]) - 1;
      const { positions } = await getMyPositions({ force: true });
      if (idx < 0 || idx >= positions.length) { await sendMessage("Invalid number. Use /positions first."); return; }
      const pos = positions[idx];
      await sendMessage(`Closing ${pos.pair}...`);
      const result = await executeTool("close_position", { position_address: pos.position, reason: "manual /close" });
      if (isExecutedTransactionSuccess("close_position", result)) {
        const closeTxs = result.close_txs?.length ? result.close_txs : result.txs;
        const claimNote = result.claim_txs?.length ? `\nClaim txs: ${result.claim_txs.join(", ")}` : "";
        const solLines = formatCloseSolLines(result);
        await sendMessage([
          `✅ Closed ${pos.pair}`,
          `Reason: ${result.close_reason || "manual /close"}`,
          ...solLines,
          `Close txs: ${closeTxs?.join(", ") || "n/a"}${claimNote}`,
        ].join("\n"));
      } else if (result?.dry_run === true) {
        await sendMessage(`🧪 Close preview for ${pos.pair}; no transaction was submitted.`);
      } else {
        await sendMessage(`❌ Close failed: ${JSON.stringify(result)}`);
      }
    } catch (e) { await sendMessage(`Error: ${e.message}`).catch(() => {}); }
    return;
  }

  if (text === "/closeall") {
    try {
      const { positions } = await getMyPositions({ force: true });
      if (!positions.length) { await sendMessage("No open positions."); return; }
      await sendMessage(`Closing ${positions.length} position(s)...`);
      const results = [];
      for (const pos of positions) {
        try {
          const result = await executeTool("close_position", { position_address: pos.position, reason: "manual /closeall" });
          const succeeded = isExecutedTransactionSuccess("close_position", result);
          results.push(`${pos.pair}: ${succeeded ? "closed" : result?.dry_run === true ? "preview only (no transaction submitted)" : `failed (${result?.error || result?.reason || "unknown"})`}`);
        } catch (error) {
          results.push(`${pos.pair}: failed (${error.message})`);
        }
      }
      await sendMessage(`Close-all finished.\n\n${results.join("\n")}`).catch(() => {});
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  const setMatch = text.match(/^\/set\s+(\d+)\s+(.+)$/i);
  if (setMatch) {
    try {
      const idx = parseInt(setMatch[1]) - 1;
      const note = setMatch[2].trim();
      const { positions } = await getMyPositions({ force: true });
      if (idx < 0 || idx >= positions.length) { await sendMessage("Invalid number. Use /positions first."); return; }
      const pos = positions[idx];
      setPositionInstruction(pos.position, note);
      await sendMessage(`✅ Note set for ${pos.pair}:\n"${note}"`);
    } catch (e) { await sendMessage(`Error: ${e.message}`).catch(() => {}); }
    return;
  }

  const setCfgMatch = text.match(/^\/setcfg\s+([A-Za-z0-9_]+)\s+(.+)$/i);
  if (setCfgMatch) {
    try {
      const key = setCfgMatch[1];
      const value = parseConfigValue(setCfgMatch[2]);
      const result = await executeTool("update_config", {
        changes: { [key]: value },
        reason: "Telegram slash command /setcfg",
      });
      if (!result?.success) {
        await sendMessage(`Config update failed.\nUnknown: ${(result?.unknown || []).join(", ") || "none"}`).catch(() => {});
        return;
      }
      await sendMessage(`✅ Updated ${key} = ${JSON.stringify(value)}`).catch(() => {});
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  if (text === "/screen") {
    try {
      await sendMessage(await runDeterministicScreen(5)).catch(() => {});
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  if (text === "/candidates") {
    await sendMessage(describeLatestCandidates(5)).catch(() => {});
    return;
  }

  const deployPoolMatch = text.match(/^\/deploy\s+pool\s+([1-9A-HJ-NP-Za-km-z]{32,44})$/i);
  if (deployPoolMatch) {
    try {
      const poolAddress = deployPoolMatch[1];
      const { candidate, result, deployAmount, binsBelow } = await deployPoolAddress(poolAddress);
      const coverage = result.range_coverage
        ? `Range: ${fmtPct(result.range_coverage.downside_pct)} downside | ${fmtPct(result.range_coverage.upside_pct)} upside`
        : `Strategy: ${config.strategy.strategy} | binsBelow: ${binsBelow}`;
      await sendMessage([
        `✅ Deployed ${candidate.name}`,
        `Pool: ${candidate.pool}`,
        `Amount: ${deployAmount} SOL`,
        coverage,
        `Position: ${result.position || "n/a"}`,
        result.txs?.length ? `Tx: ${result.txs[0]}` : null,
      ].filter(Boolean).join("\n")).catch(() => {});
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  const deployAddressMatch = text.match(/^\/deploy\s+([1-9A-HJ-NP-Za-km-z]{32,44})$/i);
  if (deployAddressMatch) {
    try {
      const tokenAddress = deployAddressMatch[1];
      const { candidate, result, deployAmount, binsBelow } = await deployTokenAddress(tokenAddress);
      const coverage = result.range_coverage
        ? `Range: ${fmtPct(result.range_coverage.downside_pct)} downside | ${fmtPct(result.range_coverage.upside_pct)} upside`
        : `Strategy: ${config.strategy.strategy} | binsBelow: ${binsBelow}`;
      await sendMessage([
        `✅ Deployed ${candidate.name}`,
        `Token: ${tokenAddress}`,
        `Pool: ${candidate.pool}`,
        `Amount: ${deployAmount} SOL`,
        coverage,
        `Position: ${result.position || "n/a"}`,
        result.txs?.length ? `Tx: ${result.txs[0]}` : null,
      ].filter(Boolean).join("\n")).catch(() => {});
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  const deployMatch = text.match(/^\/deploy\s+(\d+)$/i);
  if (deployMatch) {
    try {
      const idx = parseInt(deployMatch[1]) - 1;
      const { candidate, result, deployAmount, binsBelow } = await deployLatestCandidate(idx);
      const coverage = result.range_coverage
        ? `Range: ${fmtPct(result.range_coverage.downside_pct)} downside | ${fmtPct(result.range_coverage.upside_pct)} upside`
        : `Strategy: ${config.strategy.strategy} | binsBelow: ${binsBelow}`;
      await sendMessage([
        `✅ Deployed ${candidate.name}`,
        `Pool: ${candidate.pool}`,
        `Amount: ${deployAmount} SOL`,
        coverage,
        `Position: ${result.position || "n/a"}`,
        result.txs?.length ? `Tx: ${result.txs[0]}` : null,
      ].filter(Boolean).join("\n")).catch(() => {});
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  if (text === "/pause") {
    stopCronJobs();
    cronStarted = false;
    await sendMessage("⏸ Paused autonomous cycles. Telegram control still works. Use /resume to start again.").catch(() => {});
    return;
  }

  if (text === "/resume") {
    if (!cronStarted) {
      cronStarted = true;
      timers.managementLastRun = Date.now();
      timers.screeningLastRun = Date.now();
      startCronJobs();
      await sendMessage("▶️ Autonomous cycles resumed.").catch(() => {});
    } else {
      await sendMessage("Autonomous cycles are already running.").catch(() => {});
    }
    return;
  }

  if (text === "/hive" || text === "/hive pull") {
    try {
      const enabled = isHiveMindEnabled();
      const agentId = ensureAgentId();
      if (!enabled) {
        await sendMessage(`HiveMind: disabled\nAgent ID: ${agentId}\nSet hiveMindApiKey to connect.`).catch(() => {});
        return;
      }
      const isManualPull = text === "/hive pull";
      const pullMode = getHiveMindPullMode();
      const [registerResult, lessons, presets] = await Promise.all([
        registerHiveMindAgent({ reason: isManualPull ? "telegram_pull" : "telegram_status" }),
        (pullMode === "auto" || isManualPull) ? pullHiveMindLessons(12) : Promise.resolve(null),
        (pullMode === "auto" || isManualPull) ? pullHiveMindPresets() : Promise.resolve(null),
      ]);
      await sendMessage([
        "HiveMind: enabled",
        `Agent ID: ${agentId}`,
        `URL: ${config.hiveMind.url}`,
        `Pull mode: ${pullMode}`,
        `Register: ${registerResult ? "ok" : "warn"}`,
        `Shared lessons: ${Array.isArray(lessons) ? lessons.length : (pullMode === "manual" ? "manual" : 0)}`,
        `Presets: ${Array.isArray(presets) ? presets.length : (pullMode === "manual" ? "manual" : 0)}`,
        isManualPull ? "Manual pull: completed" : null,
      ].join("\n")).catch(() => {});
    } catch (e) {
      await sendMessage(`HiveMind error: ${e.message}`).catch(() => {});
    }
    return;
  }

  busy = true;
  let liveMessage = null;
  try {
    const { agentRole, agentModel } = resolveTelegramConversationRoute(text);
    liveMessage = await createLiveMessage("🤖 Live Update", `Request: ${text.slice(0, 240)}`);
    const { content } = await agentLoop(text, config.llm.maxSteps, sessionHistory, agentRole, agentModel, null, {
      interactive: true,
      onToolStart: async ({ name }) => { await liveMessage?.toolStart(name); },
      onToolFinish: async ({ name, result, success }) => { await liveMessage?.toolFinish(name, result, success); },
    });
    appendHistory(text, content);
    if (liveMessage) await liveMessage.finalize(stripThink(content));
    else await sendMessage(stripThink(content));
  } catch (e) {
    if (liveMessage) await liveMessage.fail(e.message).catch(() => {});
    else await sendMessage(`Error: ${e.message}`).catch(() => {});
  } finally {
    busy = false;
    refreshPrompt();
  }
}

function fmtPct(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `${n.toFixed(2)}%` : "?";
}

function getLoneCandidateSkipReason({ pool, sw, n, ti } = {}) {
  if (!pool) return "missing candidate data";
  const tokenInfo = ti || {};
  const hasNarrative = !!n?.narrative;
  // Degen Score is the conviction signal for a solo deploy. Smart wallet is NO LONGER a
  // gate here — it's a confidence boost surfaced to the LLM, not a requirement.
  const degen = degenScore(pool, config.opportunity);
  const degenStrong = degen >= (config.screening.loneCandidateMinDegen ?? 50);
  const globalFeesSol = Number(tokenInfo.global_fees_sol ?? pool.gmgn_total_fee_sol);
  const top10Pct = Number(tokenInfo.audit?.top_holders_pct ?? pool.gmgn_token_info_top10_pct ?? pool.gmgn_top10_holder_pct);
  const botPct = Number(tokenInfo.audit?.bot_holders_pct ?? pool.gmgn_bot_degen_pct);

  // Hard fundamental gates — no override.
  if (Number.isFinite(globalFeesSol) && globalFeesSol < config.screening.minTokenFeesSol) {
    return `token fees ${globalFeesSol} SOL below minimum ${config.screening.minTokenFeesSol} SOL`;
  }
  if (Number.isFinite(top10Pct) && top10Pct > config.screening.maxTop10Pct) {
    return `top10 concentration ${top10Pct}% above maximum ${config.screening.maxTop10Pct}%`;
  }
  if (Number.isFinite(botPct) && botPct > config.screening.maxBotHoldersPct) {
    return `bot holders ${botPct}% above maximum ${config.screening.maxBotHoldersPct}%`;
  }

  // Only a non-canonical PVP rival needs extra conviction. The canonical pool
  // has already won deterministic score ranking among eligible same-symbol pools.
  if (isNonCanonicalPvpRisk(pool) && !degenStrong) {
    return `PVP symbol conflict without strong degen conviction (degen ${degen.toFixed(1)} < ${config.screening.loneCandidateMinDegen ?? 50})`;
  }
  // Conviction: a solo deploy needs a narrative OR a strong degen score.
  if (!hasNarrative && !degenStrong) {
    return `only candidate has no narrative and weak degen score (${degen.toFixed(1)} < ${config.screening.loneCandidateMinDegen ?? 50})`;
  }
  return null;
}

function computeBinsBelow(volatility) {
  const parsedVolatility = Number(volatility);
  if (!Number.isFinite(parsedVolatility) || parsedVolatility <= 0) {
    throw new Error(`Invalid volatility ${volatility ?? "unknown"} — refusing volatility-scaled deploy.`);
  }
  const lo = config.strategy.minBinsBelow;
  const hi = config.strategy.maxBinsBelow;
  return Math.max(lo, Math.min(hi, Math.round(lo + (parsedVolatility / 5) * (hi - lo))));
}

// Register restarter — when update_config changes intervals, running cron jobs get replaced
registerCronRestarter(() => { if (cronStarted) startCronJobs(); });

if (isMain && isTTY) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: buildPrompt(),
  });
  _ttyInterface = rl;

  // Update prompt countdown every 10 seconds
  setInterval(() => {
    if (!busy) {
      rl.setPrompt(buildPrompt());
      rl.prompt(true); // true = preserve current line
    }
  }, 10_000);

  function launchCron() {
    if (!cronStarted) {
      cronStarted = true;
      // Seed timers so countdown starts from now
      timers.managementLastRun = Date.now();
      timers.screeningLastRun = Date.now();
      startCronJobs();
      console.log("Autonomous cycles are now running.\n");
      rl.setPrompt(buildPrompt());
      rl.prompt(true);
    }
  }

  async function runBusy(fn) {
    if (busy) { console.log("Agent is busy, please wait..."); rl.prompt(); return; }
    busy = true; rl.pause();
    try { await fn(); }
    catch (e) { console.error(`Error: ${e.message}`); }
    finally { busy = false; rl.setPrompt(buildPrompt()); rl.resume(); rl.prompt(); }
  }

  // ── Startup: show wallet + top candidates ──
  console.log(`
╔═══════════════════════════════════════════╗
║         DLMM LP Agent — Ready             ║
╚═══════════════════════════════════════════╝
`);

  console.log("Fetching wallet and top pool candidates...\n");

  busy = true;
  try {
    const [wallet, positions, { candidates, total_eligible, total_screened }] = await Promise.all([
      getWalletBalances(),
      getMyPositions({ force: true }),
      getTopCandidates({ limit: 5 }),
    ]);

    setLatestCandidates(candidates);

    console.log(`Wallet:    ${wallet.sol} SOL  ($${wallet.sol_usd})  |  SOL price: $${wallet.sol_price}`);
    console.log(`Positions: ${positions.total_positions} open\n`);

    if (positions.total_positions > 0) {
      console.log("Open positions:");
      for (const p of positions.positions) {
        const status = p.in_range ? "in-range ✓" : "OUT OF RANGE ⚠";
        console.log(`  ${p.pair.padEnd(16)} ${status}  fees: $${p.unclaimed_fees_usd}`);
      }
      console.log();
    }

    console.log(`Top pools (${total_eligible} eligible from ${total_screened} screened):\n`);
    console.log(formatCandidates(candidates));

  } catch (e) {
    console.error(`Startup fetch failed: ${e.message}`);
  } finally {
    busy = false;
  }

  // Always start autonomous cycles on launch
  launchCron();
  maybeRunMissedBriefing().catch(() => { });

  startPolling(telegramHandler);

  console.log(`
Commands:
  1 / 2 / 3 ...  Deploy ${DEPLOY} SOL into that pool
  auto           Let the agent pick and deploy automatically
  /status        Refresh wallet + positions
  /candidates    Refresh top pool list
  /briefing      Show morning briefing (last 24h)
  /performance   Show reconciled on-chain cash-settled PnL
  /learn         Study top LPers from the best current pool and save lessons
  /learn <addr>  Study top LPers from a specific pool address
  /thresholds    Show current screening thresholds + performance stats
  /evolve        Manually trigger threshold evolution from performance data
  /stop          Shut down
`);

  rl.prompt();

  rl.on("line", async (line) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }

    const latest = getLatestCandidatesMeta().candidates;
    const interactiveDeployRoute = resolveInteractiveDeployRoute(input, latest.length);
    if (interactiveDeployRoute) {
      await runBusy(async () => {
        if (interactiveDeployRoute.kind === "OPERATOR_CANDIDATE") {
          const pool = latest[interactiveDeployRoute.index];
          console.log(`\nDeploying ${DEPLOY} SOL into ${pool.name}...\n`);
          const { value: deployment } = await dispatchInteractiveDeployInput(input, latest.length, {
            deployLatestCandidateOverride: deployLatestCandidate,
            runScreeningCycleOverride: runScreeningCycle,
          });
          const outcome = deployment.result?.success === false || deployment.result?.error
            ? `Deploy failed: ${deployment.result?.error || deployment.result?.reason || "unknown"}`
            : `Deployed ${deployment.deployAmount} SOL into ${deployment.candidate.name} (${deployment.binsBelow} bins below).`;
          console.log(`\n${outcome}\n`);
        } else {
          console.log("\nRunning deterministic screening and AI veto review...\n");
          const { value: report } = await dispatchInteractiveDeployInput(input, latest.length, {
            deployLatestCandidateOverride: deployLatestCandidate,
            runScreeningCycleOverride: runScreeningCycle,
          });
          console.log(`\n${report || "No screening report."}\n`);
        }
        launchCron();
      });
      return;
    }

    // ── go: start cron without deploying ────
    if (input.toLowerCase() === "go") {
      launchCron();
      rl.prompt();
      return;
    }

    // ── Slash commands ───────────────────────
    if (input === "/stop") { await shutdown("user command"); return; }

    if (input === "/status") {
      await runBusy(async () => {
        const [wallet, positions] = await Promise.all([getWalletBalances(), getMyPositions({ force: true })]);
        console.log(`\nWallet: ${wallet.sol} SOL  ($${wallet.sol_usd})`);
        console.log(`Positions: ${positions.total_positions}`);
        for (const p of positions.positions) {
          const status = p.in_range ? "in-range ✓" : "OUT OF RANGE ⚠";
          console.log(`  ${p.pair.padEnd(16)} ${status}  fees: ${config.management.solMode ? "◎" : "$"}${p.unclaimed_fees_usd}`);
        }
        console.log();
      });
      return;
    }

    if (input === "/briefing") {
      await runBusy(async () => {
        const briefing = await generateBriefing();
        console.log(`\n${briefing.replace(/<[^>]*>/g, "")}\n`);
      });
      return;
    }

    const performanceInput = input.match(/^\/performance(?:\s+(all|\d+(?:\.\d+)?))?$/i);
    if (performanceInput) {
      await runBusy(async () => {
        const requested = performanceInput[1];
        const hours = requested?.toLowerCase() === "all"
          ? null
          : Math.min(8_760, Math.max(1, requested == null ? 24 : Number(requested)));
        const report = getSettlementPerformanceHistory({ hours, limit: 10 });
        console.log(`\n${formatSettlementPerformanceMessage(report)}\n`);
      });
      return;
    }

    if (input === "/candidates") {
      await runBusy(async () => {
        const { candidates, total_eligible, total_screened } = await getTopCandidates({ limit: 5 });
        setLatestCandidates(candidates);
        console.log(`\nTop pools (${total_eligible} eligible from ${total_screened} screened):\n`);
        console.log(formatCandidates(candidates));
        console.log();
      });
      return;
    }

    if (input === "/thresholds") {
      const s = config.screening;
      console.log("\nCurrent screening thresholds:");
      console.log(`  minFeeActiveTvlRatio: ${s.minFeeActiveTvlRatio}`);
      console.log(`  minOrganic:           ${s.minOrganic}`);
      console.log(`  minHolders:           ${s.minHolders}`);
      console.log(`  minTvl:               ${s.minTvl}`);
      console.log(`  maxTvl:               ${s.maxTvl}`);
      console.log(`  minVolume:            ${s.minVolume}`);
      console.log(`  minTokenFeesSol:      ${s.minTokenFeesSol}`);
      console.log(`  maxBotHoldersPct:     ${s.maxBotHoldersPct}`);
      console.log(`  maxTop10Pct:          ${s.maxTop10Pct}`);
      console.log(`  timeframe:            ${s.timeframe}`);
      const perf = getSettlementPerformanceSummary();
      if (perf.total_positions_settled > 0) {
        console.log(`\n  Based on ${perf.total_positions_settled} on-chain cash settlements`);
        console.log(`  Win rate: ${perf.win_rate_pct.toFixed(2)}%  |  Net PnL: ${perf.total_pnl_sol >= 0 ? "+" : ""}${perf.total_pnl_sol.toFixed(6)} SOL (${perf.total_pnl_pct.toFixed(2)}%)`);
      } else {
        console.log("\n  No closed positions yet — thresholds are preset defaults.");
      }
      console.log();
      rl.prompt();
      return;
    }

    if (input.startsWith("/learn")) {
      await runBusy(async () => {
        const parts = input.split(" ");
        const poolArg = parts[1] || null;

        let poolsToStudy = [];

        if (poolArg) {
          poolsToStudy = [{ pool: poolArg, name: poolArg }];
        } else {
          // Fetch top 10 candidates across all eligible pools
          console.log("\nFetching top pool candidates to study...\n");
          const { candidates } = await getTopCandidates({ limit: 10 });
          if (!candidates.length) {
            console.log("No eligible pools found to study.\n");
            return;
          }
          poolsToStudy = candidates.map((c) => ({ pool: c.pool, name: c.name }));
        }

        console.log(`\nStudying top LPers across ${poolsToStudy.length} pools...\n`);
        for (const p of poolsToStudy) console.log(`  • ${p.name || p.pool}`);
        console.log();

        const poolList = poolsToStudy
          .map((p, i) => `${i + 1}. ${p.name} (${p.pool})`)
          .join("\n");

        const { content: reply } = await agentLoop(
          `Study top LPers across these ${poolsToStudy.length} pools by calling study_top_lpers for each:

${poolList}

For each pool, call study_top_lpers then move to the next. After studying all pools:
1. Identify patterns that appear across multiple pools (hold time, scalping vs holding, win rates).
2. Note pool-specific patterns where behaviour differs significantly.
3. Derive 4-8 concrete, actionable lessons using add_lesson. Prioritize cross-pool patterns — they're more reliable.
4. Summarize what you learned.

Focus on: hold duration, entry/exit timing, what win rates look like, whether scalpers or holders dominate.`,
          config.llm.maxSteps,
          [],
          "GENERAL"
        );
        console.log(`\n${reply}\n`);
      });
      return;
    }

    if (input === "/evolve") {
      await runBusy(async () => {
        const perf = getLearningPerformanceSummary();
        if (!perf || perf.total_positions_closed < 5) {
          const needed = 5 - (perf?.total_positions_closed || 0);
          console.log(`\nNeed at least 5 closed positions to evolve. ${needed} more needed.\n`);
          return;
        }
        const fs = await import("fs");
        const lessonsData = JSON.parse(fs.default.readFileSync(repoPath("lessons.json"), "utf8"));
        const result = evolveThresholds(lessonsData.performance, config);
        if (!result || Object.keys(result.changes).length === 0) {
          console.log("\nNo threshold changes needed — current settings already match performance data.\n");
        } else {
          reloadScreeningThresholds();
          console.log("\nThresholds evolved:");
          for (const [key, val] of Object.entries(result.changes)) {
            console.log(`  ${key}: ${result.rationale[key]}`);
          }
          console.log("\nSaved to user-config.json. Applied immediately.\n");
        }
      });
      return;
    }

    // ── Free-form chat ───────────────────────
    await runBusy(async () => {
      log("user", input);
      const { content } = await agentLoop(input, config.llm.maxSteps, sessionHistory, "GENERAL", config.llm.generalModel, null, { interactive: true });
      appendHistory(input, content);
      console.log(`\n${content}\n`);
    });
  });

  rl.on("close", () => shutdown("stdin closed"));

} else if (isMain) {
  // Non-TTY: start immediately
  log("startup", "Non-TTY mode — starting cron cycles immediately.");
  startCronJobs();
  maybeRunMissedBriefing().catch(() => { });
  startPolling(telegramHandler);
  (async () => {
    try {
      // Run management first so any durable CLEANUP_PENDING lifecycle gets its
      // serialized automatic retry and conservative equity observation before
      // startup screening. Pending cleanup itself is not a deploy prohibition.
      await runManagementCycle({ silent: true });
      await runScreeningCycle({ silent: false });
    } catch (e) {
      log("startup_error", e.message);
    }
  })();
}
