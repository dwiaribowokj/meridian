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

assert.equal(clearCandidateObservation(pool), true);
assert.equal(clearCandidateObservation(pool), false);

fs.rmSync(dir, { recursive: true, force: true });
console.log("candidate observation tests passed");
