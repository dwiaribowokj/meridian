import fs from "fs";
import { repoPath } from "./repo-root.js";
import { evaluatePriceStabilityObservations } from "./risk-policy.js";

const OBSERVATIONS_FILE = process.env.CANDIDATE_OBSERVATIONS_PATH || repoPath("candidate-observations.json");

function finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function load() {
  if (!fs.existsSync(OBSERVATIONS_FILE)) return { pools: {}, admissions: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(OBSERVATIONS_FILE, "utf8"));
    return parsed && typeof parsed === "object"
      ? {
          pools: parsed.pools && typeof parsed.pools === "object" ? parsed.pools : {},
          admissions: parsed.admissions && typeof parsed.admissions === "object" ? parsed.admissions : {},
        }
      : { pools: {}, admissions: {} };
  } catch {
    return { pools: {}, admissions: {} };
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
    instabilityRecoveryDwellMs: Math.max(0, Number(screening.candidateInstabilityRecoveryMinutes ?? 0)) * 60_000,
    minFeeRetentionPct: Math.max(0, Number(screening.candidateMinFeeRetentionPct ?? 70)),
    minVolumeRetentionPct: Math.max(0, Number(screening.candidateMinVolumeRetentionPct ?? 70)),
    priceStabilityEnabled: screening.candidatePriceStabilityEnabled === true,
    maxPriceDrawdownPct: Math.max(0.1, Number(screening.candidateMaxPriceDrawdownPct ?? 1.5)),
    maxDownsideBinDelta: Math.max(0.25, Number(screening.candidateMaxDownsideBinDelta ?? 2)),
    admissionRecoveryDwellMs: Math.max(0, Number(screening.candidateAdmissionRecoveryMinutes ?? 0)) * 60_000,
    executableRecoveryConfirmationCount: Math.max(1, Number(screening.candidateExecutableRecoveryConfirmationCount ?? 1)),
    executableRecoverySpacingMs: Math.max(0, Number(screening.candidateExecutableRecoverySpacingSeconds ?? 0)) * 1000,
    executableRecoveryMaxSpacingMs: Math.max(0, Number(screening.candidateExecutableRecoveryMaxSpacingSeconds ?? 0)) * 1000,
  };
}

function candidateInstabilitySnapshot(metrics, now, reasons) {
  return {
    ...metricSnapshot(metrics, now),
    lastInstabilityAt: now,
    lastInstabilityReasons: Array.isArray(reasons) ? reasons.map(String).slice(0, 8) : [],
  };
}

function recoveryDwell(entry, cfg, now) {
  const lastInstabilityAt = finiteNumber(entry?.lastInstabilityAt);
  if (cfg.instabilityRecoveryDwellMs <= 0 || lastInstabilityAt == null) {
    return { pass: true, lastInstabilityAt, remainingMs: 0 };
  }
  const remainingMs = Math.max(0, cfg.instabilityRecoveryDwellMs - (now - lastInstabilityAt));
  return { pass: remainingMs === 0, lastInstabilityAt, remainingMs };
}

function metricSnapshot(metrics, now) {
  const snapshot = {
    feeActiveTvlRatio: finiteNumber(metrics?.feeActiveTvlRatio),
    volume: finiteNumber(metrics?.volume),
    price: finiteNumber(metrics?.price),
    binStep: finiteNumber(metrics?.binStep),
    count: 1,
    observedAt: now,
    ready: false,
  };
  snapshot.observations = [{
    observedAt: now,
    feeActiveTvlRatio: snapshot.feeActiveTvlRatio,
    volume: snapshot.volume,
    price: snapshot.price,
    binStep: snapshot.binStep,
  }];
  return snapshot;
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
  const admissionMaxAgeMs = Math.max(60 * 60_000, maxAgeMs * 4);
  for (const [poolAddress, entry] of Object.entries(data.admissions || {})) {
    if (!entry?.lastFailureAt || now - entry.lastFailureAt > admissionMaxAgeMs) delete data.admissions[poolAddress];
  }
}

export function recordCandidateAdmissionFailure(poolAddress, {
  code = "ADMISSION_FAILED",
  reason = "Candidate admission failed.",
  volatility = null,
} = {}, screening = {}, now = Date.now()) {
  if (!poolAddress) return { recorded: false, reason: "Candidate pool address missing." };
  const cfg = settings(screening);
  const data = load();
  prune(data, now, cfg.maxAgeMs);
  data.admissions[poolAddress] = {
    lastFailureAt: now,
    code: String(code || "ADMISSION_FAILED").slice(0, 120),
    reason: String(reason || "Candidate admission failed.").replace(/[\r\n]+/g, " ").slice(0, 300),
    volatility: finiteNumber(volatility),
  };
  save(data);
  return { recorded: true, ...data.admissions[poolAddress] };
}

export function getCandidateAdmissionRecovery(poolAddress, screening = {}, now = Date.now()) {
  const cfg = settings(screening);
  if (!poolAddress || cfg.admissionRecoveryDwellMs <= 0) {
    return { required: false, pass: true, remainingMs: 0 };
  }
  const data = load();
  prune(data, now, cfg.maxAgeMs);
  const failure = data.admissions[poolAddress];
  if (!failure) return { required: false, pass: true, remainingMs: 0 };
  const lastFailureAt = finiteNumber(failure.lastFailureAt);
  const remainingMs = lastFailureAt == null
    ? 0
    : Math.max(0, cfg.admissionRecoveryDwellMs - (now - lastFailureAt));
  return {
    required: true,
    pass: remainingMs === 0,
    remainingMs,
    lastFailureAt,
    code: failure.code || "ADMISSION_FAILED",
    reason: failure.reason || null,
    volatility: finiteNumber(failure.volatility),
    quoteConfirmationCount: cfg.executableRecoveryConfirmationCount,
    quoteSpacingMs: cfg.executableRecoverySpacingMs,
    quoteMaxSpacingMs: Math.max(cfg.executableRecoverySpacingMs, cfg.executableRecoveryMaxSpacingMs),
  };
}

export function clearCandidateAdmissionRecovery(poolAddress) {
  if (!poolAddress) return false;
  const data = load();
  if (!data.admissions[poolAddress]) return false;
  delete data.admissions[poolAddress];
  save(data);
  return true;
}

export function observeCandidateStability(poolAddress, metrics, screening = {}, now = Date.now()) {
  const cfg = settings(screening);
  if (!cfg.enabled || cfg.target <= 1) {
    return { pass: true, count: 1, target: 1, reason: "Candidate confirmation disabled or single-observation mode." };
  }
  if (!poolAddress) return { pass: false, count: 0, target: cfg.target, reason: "Candidate pool address missing." };

  const current = metricSnapshot(metrics, now);
  if (
    current.feeActiveTvlRatio == null || current.volume == null ||
    (cfg.priceStabilityEnabled && (
      current.price == null || current.price <= 0 || current.binStep == null || current.binStep <= 0
    ))
  ) {
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
    const recovery = recoveryDwell(previous, cfg, now);
    const ready = previous.ready === true && recovery.pass;
    return {
      pass: ready,
      count: Number(previous.count ?? 1),
      target: cfg.target,
      observations: Array.isArray(previous.observations) ? previous.observations : [],
      lastInstabilityAt: recovery.lastInstabilityAt,
      recoveryRemainingMs: recovery.remainingMs,
      reason: previous.ready === true && !recovery.pass
        ? `Candidate recovered its sample count but entry timing remains blocked for ${Math.ceil(recovery.remainingMs / 1000)}s after recent instability.`
        : previous.ready === true
        ? `Candidate stability confirmed ${previous.count}/${cfg.target}.`
        : `Candidate observation is too soon; waiting ${Math.ceil((cfg.minSpacingMs - (now - previous.observedAt)) / 1000)}s.`,
    };
  }

  const feeRetentionPct = retentionPct(current.feeActiveTvlRatio, finiteNumber(previous.feeActiveTvlRatio));
  const volumeRetentionPct = retentionPct(current.volume, finiteNumber(previous.volume));
  if (feeRetentionPct < cfg.minFeeRetentionPct || volumeRetentionPct < cfg.minVolumeRetentionPct) {
    data.pools[poolAddress] = candidateInstabilitySnapshot(metrics, now, [
      feeRetentionPct < cfg.minFeeRetentionPct ? "FEE_RETENTION_BELOW_MINIMUM" : null,
      volumeRetentionPct < cfg.minVolumeRetentionPct ? "VOLUME_RETENTION_BELOW_MINIMUM" : null,
    ].filter(Boolean));
    save(data);
    const weak = feeRetentionPct < cfg.minFeeRetentionPct
      ? `fee ${feeRetentionPct.toFixed(1)}% < ${cfg.minFeeRetentionPct}%`
      : `volume ${volumeRetentionPct.toFixed(1)}% < ${cfg.minVolumeRetentionPct}%`;
    return { pass: false, count: 1, target: cfg.target, feeRetentionPct, volumeRetentionPct, lastInstabilityAt: now, reason: `Candidate stability reset: ${weak}.` };
  }

  const count = Math.min(cfg.target, Math.max(1, Number(previous.count ?? 1)) + 1);
  const ready = count >= cfg.target;
  const priorObservations = Array.isArray(previous.observations)
    ? previous.observations
    : [{
        observedAt: previous.observedAt,
        feeActiveTvlRatio: previous.feeActiveTvlRatio,
        volume: previous.volume,
        price: previous.price,
        binStep: previous.binStep,
      }];
  const observations = [...priorObservations, ...current.observations]
    .filter((entry) => entry?.observedAt != null)
    .slice(-cfg.target);
  const priceStability = evaluatePriceStabilityObservations(observations, {
    required: cfg.priceStabilityEnabled,
    maxPriceDrawdownPct: cfg.maxPriceDrawdownPct,
    maxDownsideBinDelta: cfg.maxDownsideBinDelta,
  });
  if (!priceStability.eligible) {
    data.pools[poolAddress] = candidateInstabilitySnapshot(metrics, now, priceStability.reasons);
    save(data);
    return {
      pass: false,
      count: 1,
      target: cfg.target,
      feeRetentionPct,
      volumeRetentionPct,
      priceStability,
      lastInstabilityAt: now,
      reason: `Candidate price stability reset: ${priceStability.reasons.join(", ")}.`,
    };
  }
  const next = {
    ...current,
    count,
    ready,
    observations,
    ...(finiteNumber(previous.lastInstabilityAt) != null ? {
      lastInstabilityAt: finiteNumber(previous.lastInstabilityAt),
      lastInstabilityReasons: Array.isArray(previous.lastInstabilityReasons)
        ? previous.lastInstabilityReasons
        : [],
    } : {}),
  };
  const recovery = recoveryDwell(next, cfg, now);
  data.pools[poolAddress] = next;
  save(data);
  return {
    pass: ready && recovery.pass,
    count,
    target: cfg.target,
    feeRetentionPct,
    volumeRetentionPct,
    priceStability,
    observations,
    lastInstabilityAt: recovery.lastInstabilityAt,
    recoveryRemainingMs: recovery.remainingMs,
    reason: ready && !recovery.pass
      ? `Candidate recovered its sample count but entry timing remains blocked for ${Math.ceil(recovery.remainingMs / 1000)}s after recent instability.`
      : ready
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
  const currentPrice = finiteNumber(metrics?.price);
  const currentBinStep = finiteNumber(metrics?.binStep);
  const feeRetentionPct = retentionPct(currentFee, finiteNumber(entry.feeActiveTvlRatio));
  const volumeRetentionPct = retentionPct(currentVolume, finiteNumber(entry.volume));
  if (
    currentFee == null || currentVolume == null ||
    (cfg.priceStabilityEnabled && (
      currentPrice == null || currentPrice <= 0 || currentBinStep == null || currentBinStep <= 0
    )) ||
    feeRetentionPct < cfg.minFeeRetentionPct || volumeRetentionPct < cfg.minVolumeRetentionPct
  ) {
    data.pools[poolAddress] = candidateInstabilitySnapshot(metrics, now, ["DEPLOY_PREFLIGHT_RETENTION_WEAKENED"]);
    save(data);
    return {
      pass: false,
      reason: `Candidate weakened during deploy preflight (fee ${feeRetentionPct.toFixed(1)}%, volume ${volumeRetentionPct.toFixed(1)}%); stability reset.`,
    };
  }
  const qualifiedObservations = Array.isArray(entry.observations)
    ? entry.observations
    : [{
        observedAt: entry.observedAt,
        feeActiveTvlRatio: entry.feeActiveTvlRatio,
        volume: entry.volume,
        price: entry.price,
        binStep: entry.binStep,
      }];
  const validationObservations = [
    ...qualifiedObservations,
    {
      observedAt: now,
      feeActiveTvlRatio: currentFee,
      volume: currentVolume,
      price: currentPrice,
      binStep: currentBinStep,
    },
  ];
  const priceStability = evaluatePriceStabilityObservations(validationObservations, {
    required: cfg.priceStabilityEnabled,
    maxPriceDrawdownPct: cfg.maxPriceDrawdownPct,
    maxDownsideBinDelta: cfg.maxDownsideBinDelta,
  });
  if (!priceStability.eligible) {
    data.pools[poolAddress] = candidateInstabilitySnapshot(metrics, now, priceStability.reasons);
    save(data);
    return {
      pass: false,
      priceStability,
      reason: `Candidate weakened during deploy preflight (${priceStability.reasons.join(", ")}); stability reset.`,
    };
  }
  const recovery = recoveryDwell(entry, cfg, now);
  if (!recovery.pass) {
    return {
      pass: false,
      feeRetentionPct,
      volumeRetentionPct,
      priceStability,
      observations: qualifiedObservations,
      lastInstabilityAt: recovery.lastInstabilityAt,
      recoveryRemainingMs: recovery.remainingMs,
      reason: `Candidate entry timing remains blocked for ${Math.ceil(recovery.remainingMs / 1000)}s after recent instability.`,
    };
  }
  return {
    pass: true,
    feeRetentionPct,
    volumeRetentionPct,
    priceStability,
    observations: qualifiedObservations,
    lastInstabilityAt: recovery.lastInstabilityAt,
    recoveryRemainingMs: 0,
  };
}

export function clearCandidateObservation(poolAddress) {
  if (!poolAddress) return false;
  const data = load();
  if (!data.pools[poolAddress] && !data.admissions[poolAddress]) return false;
  delete data.pools[poolAddress];
  delete data.admissions[poolAddress];
  save(data);
  return true;
}
