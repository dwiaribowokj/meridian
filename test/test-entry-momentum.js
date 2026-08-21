import assert from "node:assert/strict";
import { evaluateStrictEntrySignals } from "../tools/chart-indicators.js";

const bullish = {
  close: 100,
  rsi: 70,
  upperBand: 105,
  supertrendValue: 95,
  supertrendDirection: "bullish",
  supertrendBreakUp: false,
  supertrendBreakDown: false,
};

assert.equal(evaluateStrictEntrySignals({
  fiveMinute: bullish,
  fifteenMinute: { ...bullish, rsi: 74 },
  rsiMin5m: 40,
  rsiMin15m: 35,
  rsiMax5m: 75,
  rsiMax15m: 80,
}).confirmed, true);

const fallingKnife = evaluateStrictEntrySignals({
  fiveMinute: { ...bullish, rsi: 36.663 },
  fifteenMinute: { ...bullish, rsi: 34.262 },
  rsiMin5m: 40,
  rsiMin15m: 35,
});
assert.equal(fallingKnife.confirmed, false);
assert.ok(fallingKnife.failures.some((reason) => reason.includes("5m RSI 36.663 < recovery minimum 40")));
assert.ok(fallingKnife.failures.some((reason) => reason.includes("15m RSI 34.262 < recovery minimum 35")));

const recoveredBoundary = evaluateStrictEntrySignals({
  fiveMinute: { ...bullish, rsi: 40 },
  fifteenMinute: { ...bullish, rsi: 35 },
  rsiMin5m: 40,
  rsiMin15m: 35,
});
assert.equal(recoveredBoundary.confirmed, true);

const extended15m = evaluateStrictEntrySignals({
  fiveMinute: bullish,
  fifteenMinute: { ...bullish, rsi: 81.6 },
  rsiMax5m: 75,
  rsiMax15m: 80,
});
assert.equal(extended15m.confirmed, false);
assert.ok(extended15m.failures.some((reason) => reason.includes("15m RSI")));

const upperBandChase = evaluateStrictEntrySignals({
  fiveMinute: { ...bullish, close: 106 },
  fifteenMinute: bullish,
});
assert.equal(upperBandChase.confirmed, false);
assert.ok(upperBandChase.failures.includes("5m close at/above upper Bollinger band"));

const bearish15m = evaluateStrictEntrySignals({
  fiveMinute: bullish,
  fifteenMinute: {
    ...bullish,
    close: 90,
    supertrendValue: 95,
    supertrendDirection: "bearish",
  },
});
assert.equal(bearish15m.confirmed, false);
assert.ok(bearish15m.failures.includes("15m Supertrend bearish"));

const missingNoChaseData = evaluateStrictEntrySignals({
  fiveMinute: { ...bullish, rsi: null, upperBand: null },
  fifteenMinute: { ...bullish, rsi: null, upperBand: null },
});
assert.equal(missingNoChaseData.confirmed, false);
assert.ok(missingNoChaseData.failures.includes("5m RSI unavailable"));
assert.ok(missingNoChaseData.failures.includes("15m Bollinger data unavailable"));

console.log("strict entry momentum no-chase tests passed");
