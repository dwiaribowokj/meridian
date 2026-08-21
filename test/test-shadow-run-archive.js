import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-shadow-archive-"));
const statePath = path.join(tempDir, "state.json");
process.env.MERIDIAN_STATE_FILE = statePath;
fs.writeFileSync(statePath, JSON.stringify({ positions: {}, paperPositions: {}, recentEvents: [] }));

const {
  SHADOW_ROLLOUT_ARCHIVE_CONFIRMATION,
  archiveShadowRolloutRun,
  getOpenPaperPositions,
  getShadowRolloutEvidenceSnapshot,
  trackPaperPosition,
} = await import(`../state.js?shadow-archive=${Date.now()}`);

const first = trackPaperPosition({
  pool: "invalid-sizing-pool",
  pool_name: "INVALID-SOL",
  strategy: "bid_ask",
  amount_sol: 0.17,
  active_bin: 100,
  bin_step: 100,
  active_price: 1,
  min_price: 0.9,
  max_price: 1.1,
}, Date.UTC(2026, 0, 1));
const firstSnapshot = getShadowRolloutEvidenceSnapshot();
assert.equal(getOpenPaperPositions().length, 1);
assert.equal(firstSnapshot.lifecycles[0].amount_sol, 0.17);
const stateBeforeArchive = JSON.parse(fs.readFileSync(statePath, "utf8"));
stateBeforeArchive.shadowRolloutRun.strategy_profile = "rotation_v1";
stateBeforeArchive.shadowCooldowns = {
  pools: {
    "catastrophic-pool": {
      until: "2026-01-08T00:00:00.000Z",
      until_run_end: true,
      run_id: firstSnapshot.run_id,
    },
    "run-only-pool": {
      until: null,
      until_run_end: true,
      run_id: firstSnapshot.run_id,
    },
  },
  base_mints: {},
};
fs.writeFileSync(statePath, JSON.stringify(stateBeforeArchive));

assert.throws(() => archiveShadowRolloutRun({
  expectedRunId: firstSnapshot.run_id,
  reason: "invalid sizing",
  confirmation: "wrong",
}), /exact operator confirmation/);

const archived = archiveShadowRolloutRun({
  expectedRunId: firstSnapshot.run_id,
  reason: "0.17 SOL did not match the locked 0.20 SOL shadow exposure",
  confirmation: SHADOW_ROLLOUT_ARCHIVE_CONFIRMATION,
}, Date.UTC(2026, 0, 1, 0, 1));
assert.equal(archived.archived, true);
assert.equal(getOpenPaperPositions().length, 0);
assert.equal(getShadowRolloutEvidenceSnapshot(), null);

const persisted = JSON.parse(fs.readFileSync(statePath, "utf8"));
assert.equal(persisted.paperPositions && Object.keys(persisted.paperPositions).length, 0);
assert.equal(persisted.shadowRolloutArchives.length, 1);
assert.equal(persisted.shadowRolloutArchives[0].positions[0].position, first);
assert.equal(persisted.shadowRolloutArchives[0].positions[0].terminal_state, "ABORTED_CONFIGURATION_ERROR");
assert.equal(persisted.shadowRolloutArchives[0].invalid_for_acceptance, true);
assert.equal(persisted.shadowRolloutArchives[0].strategy_profile, "rotation_v1");
assert.equal(persisted.shadowCooldowns.pools["catastrophic-pool"].until, "2026-01-08T00:00:00.000Z");
assert.equal(Object.hasOwn(persisted.shadowCooldowns.pools, "run-only-pool"), false);

trackPaperPosition({
  pool: "valid-sizing-pool",
  pool_name: "VALID-SOL",
  strategy: "bid_ask",
  amount_sol: 0.2,
  active_bin: 100,
  bin_step: 100,
  active_price: 1,
  min_price: 0.9,
  max_price: 1.1,
}, Date.UTC(2026, 0, 1, 0, 2));
const secondSnapshot = getShadowRolloutEvidenceSnapshot();
assert.notEqual(secondSnapshot.run_id, firstSnapshot.run_id);
assert.equal(secondSnapshot.lifecycles.length, 1);
assert.equal(secondSnapshot.lifecycles[0].amount_sol, 0.2);

fs.rmSync(tempDir, { recursive: true, force: true });
console.log("shadow run archive tests passed");
