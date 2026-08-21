import assert from "node:assert/strict";
import {
  getRawPoolScreeningRejectReasons,
  isNonCanonicalPvpRisk,
  scoreCandidate,
  selectCanonicalPvpCandidates,
} from "../tools/screening.js";

const now = Date.now();
const reasons = getRawPoolScreeningRejectReasons({
  name: "near-miss-SOL",
  pool_type: "dlmm",
  token_x: {
    market_cap: 5_000_000,
    organic_score: 90,
    created_at: now - 48 * 60 * 60_000,
  },
  token_y: { symbol: "SOL", organic_score: 99 },
  base_token_holders: 10_000,
  volume: 3_000,
  tvl: 350_000,
  active_tvl: 340_000,
  fee_active_tvl_ratio: 0.04,
  volatility: 1.2,
  dlmm_params: { bin_step: 50 },
}, {
  excludeHighSupplyConcentration: true,
  minMcap: 1_000_000,
  maxMcap: 12_000_000,
  minHolders: 5_000,
  minVolume: 3_500,
  minTvl: 50_000,
  maxTvl: 300_000,
  minBinStep: 80,
  maxBinStep: 125,
  minFeeActiveTvlRatio: 0.05,
  maxVolatility: 2.5,
  minOrganic: 75,
  minQuoteOrganic: 80,
  allowedLaunchpads: [],
  blockedLaunchpads: [],
  minTokenAgeHours: 24,
  maxTokenAgeHours: null,
});

assert.deepEqual(reasons, [
  "volume 3000 below minVolume 3500",
  "TVL 350000 above maxTvl 300000",
  "bin_step 50 below minBinStep 80",
  "fee/active-TVL 0.04 below minFeeActiveTvlRatio 0.05",
]);

const microRotationReasons = getRawPoolScreeningRejectReasons({
  name: "Tucker-SOL",
  pool_type: "dlmm",
  token_x: {
    market_cap: 97_899,
    organic_score: 74.24,
    created_at: now - 140 * 24 * 60 * 60_000,
  },
  token_y: { symbol: "SOL", organic_score: 99.34 },
  base_token_holders: 1_494,
  volume: 515.17,
  tvl: 909.87,
  active_tvl: 841.47,
  fee_active_tvl_ratio: 1.98,
  volatility: 4.04,
  dlmm_params: { bin_step: 100 },
}, {
  excludeHighSupplyConcentration: true,
  minMcap: 50_000,
  maxMcap: 50_000_000,
  minHolders: 500,
  minVolume: 250,
  minTvl: 400,
  maxTvl: 300_000,
  minBinStep: 80,
  maxBinStep: 125,
  minFeeActiveTvlRatio: 0.45,
  maxVolatility: 4.5,
  minOrganic: 70,
  minQuoteOrganic: 80,
  allowedLaunchpads: [],
  blockedLaunchpads: [],
  minTokenAgeHours: 1,
  maxTokenAgeHours: null,
});
assert.deepEqual(microRotationReasons, []);

const pvpLower = {
  name: "FOMO-SOL lower",
  pool: "pool-z",
  base: { symbol: "fomo", mint: "mint-lower" },
  fee_active_tvl_ratio: 1.1,
  organic_score: 80,
  volume_window: 500,
  holders: 1_000,
  is_pvp: true,
};
const pvpHigher = {
  name: "FOMO-SOL higher",
  pool: "pool-y",
  base: { symbol: " FOMO ", mint: "mint-higher" },
  fee_active_tvl_ratio: 1.3,
  organic_score: 80,
  volume_window: 500,
  holders: 1_000,
};
const unrelated = {
  name: "OTHER-SOL",
  pool: "pool-other",
  base: { symbol: "OTHER", mint: "mint-other" },
  fee_active_tvl_ratio: 1.05,
};
assert.ok(scoreCandidate(pvpHigher) > scoreCandidate(pvpLower));
const canonicalized = selectCanonicalPvpCandidates([pvpLower, unrelated, pvpHigher]);
assert.deepEqual(canonicalized.candidates, [unrelated, pvpHigher]);
assert.deepEqual(canonicalized.removed, [pvpLower]);
assert.equal(pvpHigher.pvp_canonical, true);
assert.equal(isNonCanonicalPvpRisk(pvpHigher), false, "canonical PVP winner must map to policy as non-risky");
assert.equal(isNonCanonicalPvpRisk(pvpLower), true);
assert.equal(Object.hasOwn(unrelated, "pvp_canonical"), false, "non-PVP candidates remain unchanged");

const tiedA = {
  name: "TIE-SOL A",
  pool: "pool-a",
  base: { symbol: "TIE", mint: "mint-a" },
  fee_active_tvl_ratio: 1.2,
  is_pvp: true,
};
const tiedB = {
  name: "TIE-SOL B",
  pool: "pool-b",
  base: { symbol: "tie", mint: "mint-b" },
  fee_active_tvl_ratio: 1.2,
};
assert.equal(
  selectCanonicalPvpCandidates([tiedB, tiedA]).candidates[0],
  tiedA,
  "score ties use a stable identity key instead of API order",
);

console.log("screening diagnostics tests passed");
