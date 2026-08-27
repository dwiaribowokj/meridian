import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { buildCandidateObservation } from "../tools/rejected-candidate-evidence.js";

const observation = buildCandidateObservation({
  pool: "pool-a",
  name: "A-SOL",
  base: { mint: "mint-a", symbol: "A" },
  quote: { mint: "sol", symbol: "SOL" },
  price: 1,
  volatility: 7.8,
}, { ts: "2026-08-22T00:00:00.000Z", reasons: ["volatility 7.8 above maxVolatility 7.5"] });
assert.equal(observation.pool, "pool-a");
assert.equal(observation.rejected, true);
assert.deepEqual(observation.reasons, ["volatility 7.8 above maxVolatility 7.5"]);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-replay-"));
const input = path.join(dir, "evidence.jsonl");
fs.writeFileSync(input, [
  observation,
  { ...observation, ts: "2026-08-22T00:05:00.000Z", price: 1.1, rejected: false, reasons: [] },
  { ...observation, ts: "2026-08-22T00:15:00.000Z", price: 0.9, rejected: false, reasons: [] },
].map(JSON.stringify).join("\n") + "\n");
const stdout = execFileSync(process.execPath, ["scripts/rejected-candidate-replay.js", "--input", input, "--horizons", "5,15"], {
  cwd: path.resolve(import.meta.dirname, ".."),
  encoding: "utf8",
});
const report = JSON.parse(stdout);
assert.equal(report.independent_episodes, 1);
assert.equal(report.horizons["5m"].samples, 1);
assert(Math.abs(report.horizons["5m"].mean_return_pct - 10) < 1e-9);
assert(Math.abs(report.horizons["15m"].mean_return_pct + 10) < 1e-9);
console.log("rejected-candidate replay tests passed");
