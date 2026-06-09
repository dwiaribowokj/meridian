import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { trackPaperPosition, updatePaperPositionObservation } from "../state.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-paper-state-"));
process.chdir(tmp);
fs.mkdirSync("logs", { recursive: true });

const position = trackPaperPosition({
  pool: "pool-a",
  pool_name: "TEST-SOL",
  strategy: "test",
  bin_range: { min: 90, max: 110 },
  amount_sol: 0.2,
  active_bin: 100,
  bin_step: 100,
  active_price: 25,
  min_price: 20,
  max_price: 30,
});

let observed = updatePaperPositionObservation(position, {
  active_bin: 101,
  active_price: 0.011,
});
assert.equal(observed.price_change_source, "bin_step");
assert.equal(observed.price_scale_warning, "price_scale_mismatch:2272.73x");
assert.equal(observed.price_change_pct, 1);
assert.equal(observed.status, "in_range");

const noBinPosition = trackPaperPosition({
  pool: "pool-b",
  pool_name: "NOBIN-SOL",
  strategy: "test",
  bin_range: {},
  amount_sol: 0.2,
  active_price: 10,
  min_price: 8,
  max_price: 12,
});

observed = updatePaperPositionObservation(noBinPosition, {
  active_price: 11,
});
assert.equal(observed.price_change_source, "price");
assert.equal(observed.price_scale_warning, null);
assert.equal(observed.price_change_pct, 10);
assert.equal(observed.status, "in_range");

observed = updatePaperPositionObservation(noBinPosition, {
  active_price: 0.001,
});
assert.equal(observed.price_change_source, null);
assert.equal(observed.price_scale_warning, "price_scale_mismatch:10000x");
assert.equal(observed.price_change_pct, null);
