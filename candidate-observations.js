import fs from "fs";
import { repoPath } from "./repo-root.js";

const OBSERVATIONS_FILE = process.env.CANDIDATE_OBSERVATIONS_PATH || repoPath("candidate-observations.json");

function finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function load() {
  if (!fs.existsSync(OBSERVATIONS_FILE)) return { pools: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(OBSERVATIONS_FILE, "utf8"));
    return parsed && typeof parsed === "object"
      ? { pools: parsed.pools && typeof parsed.pools === "object" ? parsed.pools : {} }
      : { pools: {} };
  } catch {
    return { pools: {} };
  }
}

function save(data) {
  const tmp = `${OBSERVATIONS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, OBSERVATIONS_FILE);
}

function settings(screening = {}) {
  return {
    enabled: screening.candidateConfirmationEnabled !== false,
    target: Math.max(1, Number(screening.candidateConfirmationCount ?? 2)),
    maxAgeMs: Math.max(1, Number(screening.candidateConfirmationMaxAgeMinutes ?? 15)) * 60_000,
    minSpacingMs: Math.max(0, Number(screening.candidateConfirmationMinSpacingMinutes ?? 2)) * 60_000,
    minFeeRetentionPct: Math.max(0, Number(screening.candidateMinFeeRetentionPct ?? 70)),
    minVolumeRetentionPct: Math.max(0, Number(screening.candidateMinVolumeRetentionPct ?? 70)),
  };
}

function metricSnapshot(metrics, now) {
  return {
    feeActiveTvlRatio: finiteNumber(metrics?.feeActiveTvlRatio),
    volume: finiteNumber(metrics?.volume),
    count: 1,
    observedAt: now,
    ready: false,
  };
}

function retentionPct(current, previous) {
  if (previous == null || previous <= 0 || current == null) return 100;
  return (current / previous) * 100;
}

function prune(data, now, maxAgeMs) {
  const staleAfterMs = Math.max(maxAgeMs * 4, 60 * 60_000);
  for (const [poolAddress, entry] of Object.entries(data.pools)) {
    if (!entry?.observedAt || now - entry.observedAt > staleAfterMs) delete data.pools[poolAddress];
  }
}

export function observeCandidateStability(poolAddress, metrics, screening = {}, now = Date.now()) {
  const cfg = settings(screening);
  if (!cfg.enabled || cfg.target <= 1) {
    return { pass: true, count: 1, target: 1, reason: "Candidate confirmation disabled or single-observation mode." };
  }
  if (!poolAddress) return { pass: false, count: 0, target: cfg.target, reason: "Candidate pool address missing." };

  const current = metricSnapshot(metrics, now);
  if (current.feeActiveTvlRatio == null || current.volume == null) {
    return { pass: false, count: 0, target: cfg.target, reason: "Candidate stability metrics are incomplete." };
  }

  const data = load();
  prune(data, now, cfg.maxAgeMs);
  const previous = data.pools[poolAddress];

  if (!previous || now - previous.observedAt > cfg.maxAgeMs) {
    data.pools[poolAddress] = current;
    save(data);
    return { pass: false, count: 1, target: cfg.target, reason: `Candidate stability 1/${cfg.target}; waiting for more observations.` };
  }

  if (now - previous.observedAt < cfg.minSpacingMs) {
    return {
      pass: previous.ready === true,
      count: Number(previous.count ?? 1),
      target: cfg.target,
      reason: previous.ready === true
        ? `Candidate stability confirmed ${previous.count}/${cfg.target}.`
        : `Candidate observation is too soon; waiting ${Math.ceil((cfg.minSpacingMs - (now - previous.observedAt)) / 1000)}s.`,
    };
  }

  const feeRetentionPct = retentionPct(current.feeActiveTvlRatio, finiteNumber(previous.feeActiveTvlRatio));
  const volumeRetentionPct = retentionPct(current.volume, finiteNumber(previous.volume));
  if (feeRetentionPct < cfg.minFeeRetentionPct || volumeRetentionPct < cfg.minVolumeRetentionPct) {
    data.pools[poolAddress] = current;
    save(data);
    const weak = feeRetentionPct < cfg.minFeeRetentionPct
      ? `fee ${feeRetentionPct.toFixed(1)}% < ${cfg.minFeeRetentionPct}%`
      : `volume ${volumeRetentionPct.toFixed(1)}% < ${cfg.minVolumeRetentionPct}%`;
    return { pass: false, count: 1, target: cfg.target, feeRetentionPct, volumeRetentionPct, reason: `Candidate stability reset: ${weak}.` };
  }

  const count = Math.min(cfg.target, Math.max(1, Number(previous.count ?? 1)) + 1);
  const ready = count >= cfg.target;
  data.pools[poolAddress] = { ...current, count, ready };
  save(data);
  return {
    pass: ready,
    count,
    target: cfg.target,
    feeRetentionPct,
    volumeRetentionPct,
    reason: ready
      ? `Candidate stability confirmed ${count}/${cfg.target}.`
      : `Candidate stability ${count}/${cfg.target}; waiting for more observations.`,
  };
}

export function validateCandidateStability(poolAddress, metrics, screening = {}, now = Date.now()) {
  const cfg = settings(screening);
  if (!cfg.enabled || cfg.target <= 1) return { pass: true };
  const data = load();
  const entry = data.pools[poolAddress];
  if (!entry || entry.ready !== true || Number(entry.count ?? 0) < cfg.target) {
    return { pass: false, reason: `Candidate has not completed ${cfg.target} stable pre-LLM observations.` };
  }
  if (now - entry.observedAt > cfg.maxAgeMs) {
    delete data.pools[poolAddress];
    save(data);
    return { pass: false, reason: "Candidate stability confirmation expired." };
  }

  const currentFee = finiteNumber(metrics?.feeActiveTvlRatio);
  const currentVolume = finiteNumber(metrics?.volume);
  const feeRetentionPct = retentionPct(currentFee, finiteNumber(entry.feeActiveTvlRatio));
  const volumeRetentionPct = retentionPct(currentVolume, finiteNumber(entry.volume));
  if (currentFee == null || currentVolume == null || feeRetentionPct < cfg.minFeeRetentionPct || volumeRetentionPct < cfg.minVolumeRetentionPct) {
    data.pools[poolAddress] = metricSnapshot(metrics, now);
    save(data);
    return {
      pass: false,
      reason: `Candidate weakened during deploy preflight (fee ${feeRetentionPct.toFixed(1)}%, volume ${volumeRetentionPct.toFixed(1)}%); stability reset.`,
    };
  }
  return { pass: true, feeRetentionPct, volumeRetentionPct };
}

export function clearCandidateObservation(poolAddress) {
  if (!poolAddress) return false;
  const data = load();
  if (!data.pools[poolAddress]) return false;
  delete data.pools[poolAddress];
  save(data);
  return true;
}
