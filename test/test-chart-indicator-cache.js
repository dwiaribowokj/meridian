import assert from "node:assert/strict";
import { config } from "../config.js";
import {
  clearChartIndicatorCache,
  fetchChartIndicatorsForMint,
} from "../tools/chart-indicators.js";

const originalFetch = globalThis.fetch;
const originalCacheTtl5mSec = config.indicators.cacheTtl5mSec;
const originalStaleIfError5mSec = config.indicators.staleIfError5mSec;

const payload = {
  latest: {
    candle: { close: 100 },
    previousCandle: { close: 99 },
    rsi: { value: 55 },
    bollinger: { lower: 90, middle: 100, upper: 110 },
    supertrend: { value: 95, direction: "bullish" },
    states: { supertrendBreakUp: false, supertrendBreakDown: false },
  },
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

try {
  config.indicators.cacheTtl5mSec = 60;
  config.indicators.staleIfError5mSec = 90;

  clearChartIndicatorCache();
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches += 1;
    return jsonResponse(payload);
  };
  const first = await fetchChartIndicatorsForMint("CacheMint", { interval: "5_MINUTE" });
  const second = await fetchChartIndicatorsForMint("CacheMint", { interval: "5_MINUTE" });
  assert.equal(fetches, 1, "a recent successful indicator payload is reused");
  assert.deepEqual(second, first);

  await fetchChartIndicatorsForMint("CacheMint", { interval: "5_MINUTE", refresh: true });
  assert.equal(fetches, 2, "an explicit refresh still attempts a new request");

  clearChartIndicatorCache();
  fetches = 0;
  let releaseFetch;
  const fetchGate = new Promise((resolve) => { releaseFetch = resolve; });
  globalThis.fetch = async () => {
    fetches += 1;
    await fetchGate;
    return jsonResponse(payload);
  };
  const concurrentA = fetchChartIndicatorsForMint("DedupeMint", { interval: "5_MINUTE" });
  const concurrentB = fetchChartIndicatorsForMint("DedupeMint", { interval: "5_MINUTE" });
  await Promise.resolve();
  assert.equal(fetches, 1, "concurrent requests for the same candle are deduplicated");
  releaseFetch();
  await Promise.all([concurrentA, concurrentB]);

  clearChartIndicatorCache();
  globalThis.fetch = async () => jsonResponse(payload);
  const recent = await fetchChartIndicatorsForMint("FallbackMint", { interval: "5_MINUTE" });
  globalThis.fetch = async () => jsonResponse({ error: "Jupiter HTTP 429 Too Many Requests" }, 429);
  const fallback = await fetchChartIndicatorsForMint("FallbackMint", {
    interval: "5_MINUTE",
    refresh: true,
  });
  assert.deepEqual(fallback, recent, "a transient 429 may reuse a recent successful payload");

  globalThis.fetch = async () => jsonResponse({ error: "unauthorized" }, 401);
  await assert.rejects(
    fetchChartIndicatorsForMint("FallbackMint", { interval: "5_MINUTE", refresh: true }),
    /unauthorized/,
    "authentication/configuration errors never use stale fallback",
  );

  config.indicators.staleIfError5mSec = 0;
  globalThis.fetch = async () => jsonResponse({ error: "Jupiter HTTP 429 Too Many Requests" }, 429);
  await assert.rejects(
    fetchChartIndicatorsForMint("FallbackMint", { interval: "5_MINUTE", refresh: true }),
    /429/,
    "the request fails closed when stale fallback is disabled or expired",
  );
} finally {
  clearChartIndicatorCache();
  config.indicators.cacheTtl5mSec = originalCacheTtl5mSec;
  config.indicators.staleIfError5mSec = originalStaleIfError5mSec;
  globalThis.fetch = originalFetch;
}

console.log("chart indicator cache tests passed");
