#!/usr/bin/env node
import path from "node:path";
import { evaluateHistoricalReplaySource, resolveRuntimeStateFile, writeLegacyReplay } from "../tools/rollout-safety.js";

function usage() {
  console.error(`Usage: node scripts/rollout-replay.js [options]

Read-only by default. It never modifies state.json, lessons.json, trade-ledger.jsonl,
or shadow rollout evidence. Any replay output is diagnostic only. Canary startup
independently recomputes historical coverage from its configured raw runtime state source.

Options:
  --input <state.json>       Legacy state input (default: runtime state: MERIDIAN_STATE_FILE or state.json)
  --min-lifecycles <number> Historical coverage requirement (default: 30)
  --output <new-directory>  Explicit new directory outside this repository for replay artifacts
  --help                     Show this help

JSON metrics are written to stdout. A human summary is written to stderr.`);
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help") return { help: true };
    if (!token.startsWith("--")) throw new Error(`Unknown argument: ${token}`);
    const key = token.slice(2);
    const value = argv[++index];
    if (value == null || value.startsWith("--")) throw new Error(`Missing value for --${key}`);
    if (!new Set(["input", "min-lifecycles", "output"]).has(key)) throw new Error(`Unknown option: --${key}`);
    options[key] = value;
  }
  return options;
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    process.exit(0);
  }
  const input = path.resolve(options.input || resolveRuntimeStateFile());
  const historical = evaluateHistoricalReplaySource({
    statePath: input,
    minHistoricalLifecycles: options["min-lifecycles"],
  });
  if (!historical.available) throw new Error(historical.reason);
  const replay = historical.replay;
  const output = options.output ? writeLegacyReplay(replay, options.output) : null;
  console.error(
    `Historical replay ${replay.metrics.lifecycle_count} lifecycle(s): ` +
    `${replay.metrics.dry_run_gate.pass ? "dry-run coverage met" : "dry-run coverage blocked"}. ` +
    `${output ? `Wrote isolated artifacts to ${output.directory}.` : "Read-only: no files written."}`,
  );
  process.stdout.write(`${JSON.stringify({
    schema_version: replay.schema_version,
    kind: "historical_replay_result",
    metrics: replay.metrics,
    source: historical.source,
    output,
  }, null, 2)}\n`);
} catch (error) {
  console.error(`rollout replay blocked: ${error.message}`);
  process.exitCode = 1;
}
