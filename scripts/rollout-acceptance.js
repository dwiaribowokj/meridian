#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import {
  evaluateRolloutAcceptance,
  formatAcceptanceSummary,
  writeAcceptanceArtifact,
} from "../tools/rollout-safety.js";

function usage() {
  console.error(`Usage: node scripts/rollout-acceptance.js --shadow-evidence <file> [options]

This command is read-only unless --output is supplied. It never writes a ledger,
state file, environment file, or production artifact. Its output artifact is
diagnostic only and never authorizes a canary.

Options:
  --shadow-evidence <file>         run-scoped heartbeat JSONL emitted by shadow management (read only)
  --shadow-run-id <id>             require one specific evidence run (default: freshest run)
  --historical-state <file>        raw state snapshot; required to report canary-ready historical coverage
  --historical-metrics <file>      optional diagnostic replay metric; never authorizes a canary
  --min-historical-lifecycles <n>  default 30
  --min-dry-run-hours <n>          default 24
  --min-shadow-lifecycles <n>      default 5
  --min-net-sol <n>                locked minimum 0.000001
  --max-drawdown-sol <n>           default 0.003
  --max-heartbeat-gap-minutes <n>  default 15
  --output <new-file>              explicit new artifact outside this repository; refuses overwrite
  --help                           show this help

Canary promotion also locks profit factor >= 1.2 and maximum single loss <= 2.5%.

JSON metrics are written to stdout. A human summary is written to stderr.`);
}

function parseArgs(argv) {
  const allowed = new Set([
    "historical-metrics",
    "historical-state",
    "shadow-evidence",
    "shadow-run-id",
    "min-historical-lifecycles",
    "min-dry-run-hours",
    "min-shadow-lifecycles",
    "min-net-sol",
    "max-drawdown-sol",
    "max-heartbeat-gap-minutes",
    "output",
  ]);
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help") return { help: true };
    if (!token.startsWith("--")) throw new Error(`Unknown argument: ${token}`);
    const key = token.slice(2);
    if (!allowed.has(key)) throw new Error(`Unknown option: --${key}`);
    const value = argv[++index];
    if (value == null || value.startsWith("--")) throw new Error(`Missing value for --${key}`);
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
  if (!options["shadow-evidence"]) throw new Error("--shadow-evidence is required");
  const historicalMetricsPath = options["historical-metrics"] ? path.resolve(options["historical-metrics"]) : null;
  const historicalMetrics = historicalMetricsPath ? JSON.parse(fs.readFileSync(historicalMetricsPath, "utf8")) : null;
  const acceptance = evaluateRolloutAcceptance({
    historicalMetrics,
    historicalMetricsPath,
    historicalStatePath: options["historical-state"] ? path.resolve(options["historical-state"]) : null,
    shadowEvidencePath: path.resolve(options["shadow-evidence"]),
    shadowRunId: options["shadow-run-id"] || null,
    thresholds: {
      minHistoricalLifecycles: options["min-historical-lifecycles"],
      minDryRunHours: options["min-dry-run-hours"],
      minCompletedShadowLifecycles: options["min-shadow-lifecycles"],
      minNetSol: options["min-net-sol"],
      maxDrawdownSol: options["max-drawdown-sol"],
      maxHeartbeatGapMinutes: options["max-heartbeat-gap-minutes"],
    },
  });
  const output = options.output ? writeAcceptanceArtifact(acceptance, options.output) : null;
  console.error(formatAcceptanceSummary(acceptance));
  if (output) console.error(`Wrote isolated acceptance artifact: ${output}`);
  process.stdout.write(`${JSON.stringify(acceptance, null, 2)}\n`);
} catch (error) {
  console.error(`rollout acceptance blocked: ${error.message}`);
  process.exitCode = 1;
}
