import { config } from "../config.js";
import { log } from "../logger.js";
import { agentMeridianJson, getAgentMeridianHeaders } from "./agent-meridian.js";
import { safeNumber } from "../utils/number.js";

const DEFAULT_INTERVALS = ["5_MINUTE"];
const DEFAULT_CANDLES = 298;

function normalizeIntervals(intervals) {
  const list = Array.isArray(intervals) ? intervals : DEFAULT_INTERVALS;
  return list
    .map((value) => String(value || "").trim().toUpperCase())
    .filter((value) => value === "5_MINUTE" || value === "15_MINUTE");
}

function safeNum(value) {
  return safeNumber(value, null);
}

function buildSignalSummary(payload) {
  const latest = payload?.latest || {};
  const candle = latest?.candle || {};
  const previousCandle = latest?.previousCandle || {};
  const rsi = safeNum(latest?.rsi?.value);
  const bollinger = latest?.bollinger || {};
  const supertrend = latest?.supertrend || {};
  const fibonacciLevels = latest?.fibonacci?.levels || {};
  return {
    close: safeNum(candle.close),
    previousClose: safeNum(previousCandle.close),
    rsi,
    lowerBand: safeNum(bollinger.lower),
    middleBand: safeNum(bollinger.middle),
    upperBand: safeNum(bollinger.upper),
    supertrendValue: safeNum(supertrend.value),
    supertrendDirection: String(supertrend.direction || "unknown"),
    supertrendBreakUp: !!latest?.states?.supertrendBreakUp,
    supertrendBreakDown: !!latest?.states?.supertrendBreakDown,
    fib50: safeNum(fibonacciLevels["0.500"]),
    fib618: safeNum(fibonacciLevels["0.618"]),
    fib786: safeNum(fibonacciLevels["0.786"]),
  };
}

function strictSupertrendState(summary = {}) {
  const direction = String(summary.supertrendDirection || "unknown").trim().toLowerCase();
  const bullish = summary.supertrendBreakUp === true ||
    (direction === "bullish" && summary.close != null && summary.supertrendValue != null && summary.close >= summary.supertrendValue);
  const bearish = summary.supertrendBreakDown === true ||
    (direction === "bearish" && summary.close != null && summary.supertrendValue != null && summary.close <= summary.supertrendValue);
  return { bullish, bearish };
}

/**
 * Pure evaluator for the strict entry gate. Bullish Supertrend remains
 * required, but a lower-only SOL range must not chase an already extended
 * candle because any further rise immediately leaves that range above entry.
 */
export function evaluateStrictEntrySignals({
  fiveMinute,
  fifteenMinute,
  rsiMin5m = config.indicators.entryRsiMin5m ?? 40,
  rsiMin15m = config.indicators.entryRsiMin15m ?? 35,
  rsiMax5m = config.indicators.entryRsiMax5m ?? 75,
  rsiMax15m = config.indicators.entryRsiMax15m ?? 80,
  rejectAboveUpperBand = config.indicators.entryRejectAboveUpperBand !== false,
} = {}) {
  const five = fiveMinute || {};
  const fifteen = fifteenMinute || {};
  const fiveTrend = strictSupertrendState(five);
  const fifteenTrend = strictSupertrendState(fifteen);
  const min5 = safeNum(rsiMin5m);
  const min15 = safeNum(rsiMin15m);
  const max5 = safeNum(rsiMax5m);
  const max15 = safeNum(rsiMax15m);
  const fiveRsiAvailable = five.rsi != null && min5 != null && max5 != null;
  const fifteenRsiAvailable = fifteen.rsi != null && min15 != null && max15 != null;
  const fiveBandAvailable = five.close != null && five.upperBand != null;
  const fifteenBandAvailable = fifteen.close != null && fifteen.upperBand != null;
  const fiveRsiUnrecovered = fiveRsiAvailable && five.rsi < min5;
  const fifteenRsiUnrecovered = fifteenRsiAvailable && fifteen.rsi < min15;
  const fiveRsiExtended = fiveRsiAvailable && five.rsi >= max5;
  const fifteenRsiExtended = fifteenRsiAvailable && fifteen.rsi >= max15;
  const fiveAboveUpperBand = rejectAboveUpperBand && fiveBandAvailable && five.close >= five.upperBand;
  const fifteenAboveUpperBand = rejectAboveUpperBand && fifteenBandAvailable && fifteen.close >= fifteen.upperBand;
  const failures = [];
  if (!fiveTrend.bullish) failures.push("5m Supertrend not bullish");
  if (fifteenTrend.bearish) failures.push("15m Supertrend bearish");
  if (!fiveRsiAvailable) failures.push("5m RSI unavailable");
  if (!fifteenRsiAvailable) failures.push("15m RSI unavailable");
  if (rejectAboveUpperBand && !fiveBandAvailable) failures.push("5m Bollinger data unavailable");
  if (rejectAboveUpperBand && !fifteenBandAvailable) failures.push("15m Bollinger data unavailable");
  if (fiveRsiUnrecovered) failures.push(`5m RSI ${five.rsi} < recovery minimum ${min5}`);
  if (fifteenRsiUnrecovered) failures.push(`15m RSI ${fifteen.rsi} < recovery minimum ${min15}`);
  if (fiveRsiExtended) failures.push(`5m RSI ${five.rsi} >= ${max5}`);
  if (fifteenRsiExtended) failures.push(`15m RSI ${fifteen.rsi} >= ${max15}`);
  if (fiveAboveUpperBand) failures.push("5m close at/above upper Bollinger band");
  if (fifteenAboveUpperBand) failures.push("15m close at/above upper Bollinger band");
  const confirmed = failures.length === 0;
  return {
    confirmed,
    reason: confirmed
      ? "5m bullish, 15m non-bearish, RSI recovered, and no Bollinger chase condition"
      : `Strict momentum failed: ${failures.join("; ")}`,
    failures,
    five: {
      bullish: fiveTrend.bullish,
      bearish: fiveTrend.bearish,
      rsiRecovered: fiveRsiAvailable && !fiveRsiUnrecovered,
      rsiExtended: fiveRsiExtended,
      aboveUpperBand: fiveAboveUpperBand,
      confirmed: fiveTrend.bullish && fiveRsiAvailable && (!rejectAboveUpperBand || fiveBandAvailable) && !fiveRsiUnrecovered && !fiveRsiExtended && !fiveAboveUpperBand,
    },
    fifteen: {
      bullish: fifteenTrend.bullish,
      bearish: fifteenTrend.bearish,
      rsiRecovered: fifteenRsiAvailable && !fifteenRsiUnrecovered,
      rsiExtended: fifteenRsiExtended,
      aboveUpperBand: fifteenAboveUpperBand,
      confirmed: !fifteenTrend.bearish && fifteenRsiAvailable && (!rejectAboveUpperBand || fifteenBandAvailable) && !fifteenRsiUnrecovered && !fifteenRsiExtended && !fifteenAboveUpperBand,
    },
  };
}

function evaluatePreset(side, preset, payload) {
  const summary = buildSignalSummary(payload);
  const oversold = Number(config.indicators.rsiOversold ?? 30);
  const overbought = Number(config.indicators.rsiOverbought ?? 80);
  const close = summary.close;
  const previousClose = summary.previousClose;
  const lowerBand = summary.lowerBand;
  const upperBand = summary.upperBand;
  const rsi = summary.rsi;
  const isBullish = summary.supertrendDirection === "bullish";
  const isBearish = summary.supertrendDirection === "bearish";
  const crossedUp = (level) =>
    level != null &&
    close != null &&
    previousClose != null &&
    previousClose < level &&
    close >= level;
  const crossedDown = (level) =>
    level != null &&
    close != null &&
    previousClose != null &&
    previousClose > level &&
    close <= level;

  switch (preset) {
    case "supertrend_break":
      return side === "entry"
        ? {
            confirmed: summary.supertrendBreakUp || (isBullish && close != null && summary.supertrendValue != null && close >= summary.supertrendValue),
            reason: summary.supertrendBreakUp ? "Supertrend flipped bullish" : "Price is above bullish Supertrend",
            signal: summary,
          }
        : {
            confirmed: summary.supertrendBreakDown || (isBearish && close != null && summary.supertrendValue != null && close <= summary.supertrendValue),
            reason: summary.supertrendBreakDown ? "Supertrend flipped bearish" : "Price is below bearish Supertrend",
            signal: summary,
          };
    case "rsi_reversal":
      return side === "entry"
        ? {
            confirmed: rsi != null && rsi <= oversold,
            reason: `RSI ${rsi ?? "n/a"} <= oversold ${oversold}`,
            signal: summary,
          }
        : {
            confirmed: rsi != null && rsi >= overbought,
            reason: `RSI ${rsi ?? "n/a"} >= overbought ${overbought}`,
            signal: summary,
          };
    case "bollinger_reversion":
      return side === "entry"
        ? {
            confirmed: close != null && lowerBand != null && close <= lowerBand,
            reason: `Close ${close ?? "n/a"} <= lower band ${lowerBand ?? "n/a"}`,
            signal: summary,
          }
        : {
            confirmed: close != null && upperBand != null && close >= upperBand,
            reason: `Close ${close ?? "n/a"} >= upper band ${upperBand ?? "n/a"}`,
            signal: summary,
          };
    case "rsi_plus_supertrend":
      return side === "entry"
        ? {
            confirmed:
              (rsi != null && rsi <= oversold) &&
              (summary.supertrendBreakUp || isBullish),
            reason: `RSI oversold with bullish Supertrend context`,
            signal: summary,
          }
        : {
            confirmed:
              (rsi != null && rsi >= overbought) &&
              (summary.supertrendBreakDown || isBearish),
            reason: `RSI overbought with bearish Supertrend context`,
            signal: summary,
          };
    case "supertrend_or_rsi":
      return side === "entry"
        ? {
            confirmed:
              summary.supertrendBreakUp ||
              (isBullish && close != null && summary.supertrendValue != null && close >= summary.supertrendValue) ||
              (rsi != null && rsi <= oversold),
            reason: "Supertrend bullish confirmation or RSI oversold",
            signal: summary,
          }
        : {
            confirmed:
              summary.supertrendBreakDown ||
              (isBearish && close != null && summary.supertrendValue != null && close <= summary.supertrendValue) ||
              (rsi != null && rsi >= overbought),
            reason: "Supertrend bearish confirmation or RSI overbought",
            signal: summary,
          };
    case "bb_plus_rsi":
      return side === "entry"
        ? {
            confirmed:
              close != null &&
              lowerBand != null &&
              close <= lowerBand &&
              rsi != null &&
              rsi <= oversold,
            reason: "Close at/below lower band with RSI oversold",
            signal: summary,
          }
        : {
            confirmed:
              close != null &&
              upperBand != null &&
              close >= upperBand &&
              rsi != null &&
              rsi >= overbought,
            reason: "Close at/above upper band with RSI overbought",
            signal: summary,
          };
    case "fibo_reclaim":
      return side === "entry"
        ? {
            confirmed:
              crossedUp(summary.fib618) ||
              crossedUp(summary.fib50) ||
              crossedUp(summary.fib786),
            reason: "Price reclaimed a key Fibonacci level",
            signal: summary,
          }
        : {
            confirmed:
              crossedUp(summary.fib618) ||
              crossedUp(summary.fib50),
            reason: "Price reclaimed a key Fibonacci level upward",
            signal: summary,
          };
    case "fibo_reject":
      return side === "entry"
        ? {
            confirmed:
              crossedDown(summary.fib618) ||
              crossedDown(summary.fib50),
            reason: "Price rejected from a key Fibonacci level",
            signal: summary,
          }
        : {
            confirmed:
              crossedDown(summary.fib618) ||
              crossedDown(summary.fib50) ||
              crossedDown(summary.fib786),
            reason: "Price rejected below a key Fibonacci level",
            signal: summary,
          };
    default:
      return {
        confirmed: false,
        reason: `Unknown preset ${preset}`,
        signal: summary,
      };
  }
}

async function fetchChartIndicatorsForMint(
  mint,
  {
    interval,
    candles = config.indicators.candles ?? DEFAULT_CANDLES,
    rsiLength = config.indicators.rsiLength ?? 2,
    refresh = false,
  } = {},
) {
  const normalizedInterval = String(interval || "15_MINUTE").trim().toUpperCase();
  const search = new URLSearchParams({
    interval: normalizedInterval,
    candles: String(candles),
    rsiLength: String(rsiLength),
  });
  if (refresh) search.set("refresh", "1");

  return agentMeridianJson(`/chart-indicators/${mint}?${search.toString()}`, {
    headers: getAgentMeridianHeaders(),
  });
}

export async function confirmIndicatorPreset({
  mint,
  side,
  preset = side === "entry" ? config.indicators.entryPreset : config.indicators.exitPreset,
  intervals = config.indicators.intervals,
  refresh = false,
} = {}) {
  if (!config.indicators.enabled || !mint || !preset) {
    return { enabled: false, confirmed: true, reason: "Indicators disabled or not configured", intervals: [] };
  }

  const targets = normalizeIntervals(intervals);
  if (targets.length === 0) {
    return { enabled: false, confirmed: true, reason: "No indicator intervals configured", intervals: [] };
  }

  const results = [];
  for (const interval of targets) {
    try {
      const payload = await fetchChartIndicatorsForMint(mint, { interval, refresh });
      const evaluation = evaluatePreset(side, preset, payload);
      results.push({
        interval,
        ok: true,
        confirmed: !!evaluation.confirmed,
        reason: evaluation.reason,
        signal: evaluation.signal,
        latest: payload?.latest || null,
      });
    } catch (error) {
      log("indicators_warn", `Indicator fetch failed for ${mint.slice(0, 8)} ${interval}: ${error.message}`);
      results.push({
        interval,
        ok: false,
        confirmed: null,
        reason: error.message,
        signal: null,
        latest: null,
      });
    }
  }

  const successful = results.filter((entry) => entry.ok);
  if (successful.length === 0) {
    return {
      enabled: true,
      confirmed: true,
      skipped: true,
      preset,
      side,
      reason: "Indicator API unavailable; falling back to existing logic",
      intervals: results,
    };
  }

  const requireAll = !!config.indicators.requireAllIntervals;
  const confirmed = requireAll
    ? successful.every((entry) => entry.confirmed)
    : successful.some((entry) => entry.confirmed);

  return {
    enabled: true,
    confirmed,
    skipped: false,
    preset,
    side,
    requireAllIntervals: requireAll,
    reason: confirmed
      ? `${preset} confirmed on ${successful.filter((entry) => entry.confirmed).map((entry) => entry.interval).join(", ")}`
      : `${preset} not confirmed on ${successful.map((entry) => entry.interval).join(", ")}`,
    intervals: results,
  };
}

/**
 * Conservative entry gate used by the deterministic screener:
 * - 5m must be bullish / break upward.
 * - 15m must be available and must not be bearish.
 * Missing data fails closed.
 */
export async function confirmStrictEntryMomentum({ mint, refresh = false } = {}) {
  if (!config.indicators.enabled || !mint) {
    return {
      enabled: true,
      confirmed: false,
      skipped: false,
      reason: "Strict entry momentum requires enabled indicators and a mint",
      intervals: [],
    };
  }

  const results = [];
  for (const interval of ["5_MINUTE", "15_MINUTE"]) {
    try {
      const payload = await fetchChartIndicatorsForMint(mint, { interval, refresh });
      const summary = buildSignalSummary(payload);
      const trend = strictSupertrendState(summary);
      results.push({ interval, ok: true, confirmed: false, bullish: trend.bullish, bearish: trend.bearish, signal: summary });
    } catch (error) {
      log("indicators_warn", `Strict indicator fetch failed for ${mint.slice(0, 8)} ${interval}: ${error.message}`);
      results.push({ interval, ok: false, confirmed: false, reason: error.message, signal: null });
    }
  }

  const five = results.find((entry) => entry.interval === "5_MINUTE");
  const fifteen = results.find((entry) => entry.interval === "15_MINUTE");
  const evaluation = evaluateStrictEntrySignals({
    fiveMinute: five?.ok ? five.signal : null,
    fifteenMinute: fifteen?.ok ? fifteen.signal : null,
  });
  if (five?.ok) five.confirmed = evaluation.five.confirmed;
  if (fifteen?.ok) fifteen.confirmed = evaluation.fifteen.confirmed;
  const confirmed = Boolean(five?.ok && fifteen?.ok && evaluation.confirmed);
  return {
    enabled: true,
    confirmed,
    skipped: false,
    preset: "strict_supertrend_no_chase_entry",
    side: "entry",
    reason: confirmed
      ? evaluation.reason
      : !five?.ok || !fifteen?.ok
        ? `Strict momentum failed: 5m=${five?.ok ? "available" : "unavailable"}, 15m=${fifteen?.ok ? "available" : "unavailable"}`
        : evaluation.reason,
    intervals: results,
  };
}
