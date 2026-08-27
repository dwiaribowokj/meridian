#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { rejectedCandidateEvidenceFile } from "../tools/rejected-candidate-evidence.js";

function parseArgs(argv) {
  const options = { input: rejectedCandidateEvidenceFile(), horizons: [5, 15, 30, 60, 90], episodeGapMinutes: 90 };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--input") options.input = path.resolve(argv[++i] || "");
    else if (token === "--horizons") options.horizons = String(argv[++i] || "").split(",").map(Number).filter((n) => n > 0);
    else if (token === "--episode-gap-minutes") options.episodeGapMinutes = Number(argv[++i]);
    else if (token === "--help") options.help = true;
    else throw new Error(`Unknown argument: ${token}`);
  }
  return options;
}

function usage() {
  return `Usage: node scripts/rejected-candidate-replay.js [options]\n\n` +
    `Read-only counterfactual report from rejected-candidate-evidence.jsonl.\n` +
    `Options:\n  --input <file>\n  --horizons <5,15,30,60,90>\n  --episode-gap-minutes <minutes>\n  --help\n`;
}

function readJsonl(file) {
  if (!fs.existsSync(file)) throw new Error(`Input file not found: ${file}`);
  return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); } catch { throw new Error(`Invalid JSONL at line ${index + 1}`); }
  }).filter((row) => row?.pool && Number.isFinite(Date.parse(row.ts)) && Number.isFinite(Number(row.price)));
}

function dedupeEpisodes(rows, gapMinutes) {
  const gapMs = gapMinutes * 60_000;
  const last = new Map();
  return rows.filter((row) => {
    const ts = Date.parse(row.ts);
    const previous = last.get(row.pool);
    if (previous != null && ts - previous < gapMs) return false;
    last.set(row.pool, ts);
    return true;
  });
}

function nearestFuture(rowsByPool, pool, targetMs, toleranceMs = 90_000) {
  const rows = rowsByPool.get(pool) || [];
  let best = null;
  for (const row of rows) {
    const delta = Math.abs(Date.parse(row.ts) - targetMs);
    if (delta <= toleranceMs && (!best || delta < best.delta)) best = { row, delta };
  }
  return best?.row || null;
}

function summarize(values) {
  if (!values.length) return { samples: 0, mean_return_pct: null, median_return_pct: null, win_rate_pct: null };
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return {
    samples: values.length,
    mean_return_pct: values.reduce((a, b) => a + b, 0) / values.length,
    median_return_pct: median,
    win_rate_pct: values.filter((value) => value > 0).length / values.length * 100,
  };
}

const options = parseArgs(process.argv.slice(2));
if (options.help) { process.stdout.write(usage()); process.exit(0); }
const rows = readJsonl(options.input).sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
const rowsByPool = new Map();
for (const row of rows) {
  if (!rowsByPool.has(row.pool)) rowsByPool.set(row.pool, []);
  rowsByPool.get(row.pool).push(row);
}
const rejected = rows.filter((row) => row.rejected);
const episodes = dedupeEpisodes(rejected, options.episodeGapMinutes);
const horizons = {};
for (const minutes of options.horizons) {
  const returns = [];
  for (const episode of episodes) {
    const future = nearestFuture(rowsByPool, episode.pool, Date.parse(episode.ts) + minutes * 60_000);
    if (!future) continue;
    returns.push((Number(future.price) / Number(episode.price) - 1) * 100);
  }
  horizons[`${minutes}m`] = summarize(returns);
}
const report = {
  schema: "meridian.rejected-candidate-replay.v1",
  input: options.input,
  observations: rows.length,
  rejected_observations: rejected.length,
  independent_episodes: episodes.length,
  unique_pools: new Set(episodes.map((row) => row.pool)).size,
  episode_gap_minutes: options.episodeGapMinutes,
  horizons,
  limitations: [
    "Price-only return in the pool quote asset; not a DLMM LP PnL simulation.",
    "Requires forward observations captured near each target horizon.",
    "No historical backfill is inferred from current prices.",
  ],
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
