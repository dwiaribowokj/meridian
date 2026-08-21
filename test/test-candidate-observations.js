import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-candidate-test-"));
process.env.CANDIDATE_OBSERVATIONS_PATH = path.join(dir, "observations.json");

const {
  observeCandidateStability,
  validateCandidateStability,
  clearCandidateObservation,
} = await import("../candidate-observations.js");

const cfg = {
  candidateConfirmationEnabled: true,
  candidateConfirmationCount: 3,
  candidateConfirmationMaxAgeMinutes: 15,
  candidateConfirmationMinSpacingMinutes: 4,
  candidateMinFeeRetentionPct: 85,
  candidateMinVolumeRetentionPct: 85,
};

const pool = "Pool111111111111111111111111111111111111111";
const start = Date.parse("2026-07-12T00:00:00Z");

assert.equal(observeCandidateStability(pool, { feeActiveTvlRatio: 1, volume: 1000 }, cfg, start).count, 1);
assert.equal(observeCandidateStability(pool, { feeActiveTvlRatio: 0.95, volume: 950 }, cfg, start + 5 * 60_000).count, 2);
const ready = observeCandidateStability(pool, { feeActiveTvlRatio: 0.92, volume: 920 }, cfg, start + 10 * 60_000);
assert.equal(ready.pass, true);
assert.equal(ready.count, 3);
assert.equal(validateCandidateStability(pool, { feeActiveTvlRatio: 0.9, volume: 900 }, cfg, start + 11 * 60_000).pass, true);

const reset = observeCandidateStability(pool, { feeActiveTvlRatio: 0.5, volume: 500 }, cfg, start + 15 * 60_000);
assert.equal(reset.pass, false);
assert.equal(reset.count, 1);
assert.match(reset.reason, /reset/);
assert.equal(validateCandidateStability(pool, { feeActiveTvlRatio: 0.5, volume: 500 }, cfg, start + 16 * 60_000).pass, false);

const priceCfg = {
  ...cfg,
  candidateConfirmationMinSpacingMinutes: 0.5,
  candidatePriceStabilityEnabled: true,
  candidateMaxPriceDrawdownPct: 1.5,
  candidateMaxDownsideBinDelta: 2,
};
const stablePricePool = "StablePricePool111111111111111111111111111";
assert.equal(observeCandidateStability(stablePricePool, {
  feeActiveTvlRatio: 1,
  volume: 1000,
  price: 1,
  binStep: 100,
}, priceCfg, start).count, 1);
assert.equal(observeCandidateStability(stablePricePool, {
  feeActiveTvlRatio: 1.02,
  volume: 1020,
  price: 1.004,
  binStep: 100,
}, priceCfg, start + 30_000).count, 2);
const stablePriceReady = observeCandidateStability(stablePricePool, {
  feeActiveTvlRatio: 1.03,
  volume: 1030,
  price: 1.006,
  binStep: 100,
}, priceCfg, start + 60_000);
assert.equal(stablePriceReady.pass, true);
assert.equal(stablePriceReady.priceStability.eligible, true);
assert.equal(validateCandidateStability(stablePricePool, {
  feeActiveTvlRatio: 1.03,
  volume: 1030,
  price: 1.005,
  binStep: 100,
}, priceCfg, start + 65_000).pass, true);

const unstablePricePool = "UnstablePricePool1111111111111111111111111";
observeCandidateStability(unstablePricePool, {
  feeActiveTvlRatio: 1,
  volume: 1000,
  price: 1,
  binStep: 100,
}, priceCfg, start);
observeCandidateStability(unstablePricePool, {
  feeActiveTvlRatio: 1.01,
  volume: 1010,
  price: 1.002,
  binStep: 100,
}, priceCfg, start + 30_000);
const unstablePrice = observeCandidateStability(unstablePricePool, {
  feeActiveTvlRatio: 1.02,
  volume: 1020,
  price: 0.98,
  binStep: 100,
}, priceCfg, start + 60_000);
assert.equal(unstablePrice.pass, false);
assert.equal(unstablePrice.count, 1);
assert.match(unstablePrice.reason, /PRICE_DRAWDOWN_ABOVE_MAXIMUM/);

const preflightDropPool = "PreflightDropPool11111111111111111111111111";
observeCandidateStability(preflightDropPool, {
  feeActiveTvlRatio: 1,
  volume: 1000,
  price: 1,
  binStep: 100,
}, priceCfg, start);
observeCandidateStability(preflightDropPool, {
  feeActiveTvlRatio: 1.01,
  volume: 1010,
  price: 1.003,
  binStep: 100,
}, priceCfg, start + 30_000);
assert.equal(observeCandidateStability(preflightDropPool, {
  feeActiveTvlRatio: 1.02,
  volume: 1020,
  price: 1.004,
  binStep: 100,
}, priceCfg, start + 60_000).pass, true);
const preflightDrop = validateCandidateStability(preflightDropPool, {
  feeActiveTvlRatio: 1.02,
  volume: 1020,
  price: 0.982,
  binStep: 100,
}, priceCfg, start + 65_000);
assert.equal(preflightDrop.pass, false);
assert.match(preflightDrop.reason, /PRICE_DRAWDOWN_ABOVE_MAXIMUM/);

const missingPricePool = "MissingPricePool11111111111111111111111111";
assert.equal(observeCandidateStability(missingPricePool, {
  feeActiveTvlRatio: 1,
  volume: 1000,
}, priceCfg, start).pass, false);

assert.equal(clearCandidateObservation(pool), true);
assert.equal(clearCandidateObservation(pool), false);

fs.rmSync(dir, { recursive: true, force: true });
console.log("candidate observation tests passed");
