import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT, repoPath } from "../repo-root.js";
import {
  DEFAULT_SHADOW_EVIDENCE_THRESHOLDS,
  evaluateShadowEvidence,
  sha256File,
} from "../rollout-evidence.js";
import { SHADOW_ROTATION_STRATEGY_PROFILE } from "../risk-policy.js";

export const ROLLOUT_ACCEPTANCE_SCHEMA_VERSION = 4;
export const LOCKED_CANARY = Object.freeze({
  deployAmountSol: 0.2,
  maxPositions: 1,
  strategyProfile: SHADOW_ROTATION_STRATEGY_PROFILE,
});
export const DEFAULT_ACCEPTANCE_THRESHOLDS = Object.freeze({
  minHistoricalLifecycles: 30,
  minDryRunHours: 24,
  minCompletedShadowLifecycles: 5,
  minNetSol: 0.000001,
  maxDrawdownSol: 0.003,
});

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function positiveFiniteNumber(value) {
  const number = finiteNumber(value);
  return number != null && number > 0 ? number : null;
}

function validTimestamp(value) {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function isoOrNull(value) {
  return validTimestamp(value) == null ? null : new Date(value).toISOString();
}

function asNonNegativeInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}

function normalizedThresholds(overrides = {}) {
  return {
    // Locked rollout gates may only be tightened. This keeps a lower CLI or
    // config value from silently reducing the 30 / 24h / five-lifecycle bar.
    minHistoricalLifecycles: Math.max(
      DEFAULT_ACCEPTANCE_THRESHOLDS.minHistoricalLifecycles,
      asNonNegativeInteger(overrides.minHistoricalLifecycles, DEFAULT_ACCEPTANCE_THRESHOLDS.minHistoricalLifecycles),
    ),
    minDryRunHours: Math.max(
      DEFAULT_ACCEPTANCE_THRESHOLDS.minDryRunHours,
      finiteNumber(overrides.minDryRunHours) ?? DEFAULT_ACCEPTANCE_THRESHOLDS.minDryRunHours,
    ),
    minCompletedShadowLifecycles: Math.max(
      DEFAULT_ACCEPTANCE_THRESHOLDS.minCompletedShadowLifecycles,
      asNonNegativeInteger(overrides.minCompletedShadowLifecycles, DEFAULT_ACCEPTANCE_THRESHOLDS.minCompletedShadowLifecycles),
    ),
    minNetSol: Math.max(DEFAULT_ACCEPTANCE_THRESHOLDS.minNetSol, finiteNumber(overrides.minNetSol) ?? DEFAULT_ACCEPTANCE_THRESHOLDS.minNetSol),
    maxDrawdownSol: Math.min(
      DEFAULT_ACCEPTANCE_THRESHOLDS.maxDrawdownSol,
      Math.max(0, finiteNumber(overrides.maxDrawdownSol) ?? DEFAULT_ACCEPTANCE_THRESHOLDS.maxDrawdownSol),
    ),
    maxHeartbeatGapMinutes: Math.min(
      DEFAULT_SHADOW_EVIDENCE_THRESHOLDS.maxHeartbeatGapMinutes,
      Math.max(1, finiteNumber(overrides.maxHeartbeatGapMinutes) ?? DEFAULT_SHADOW_EVIDENCE_THRESHOLDS.maxHeartbeatGapMinutes),
    ),
  };
}

function uniqueSorted(items) {
  return [...new Set(items.filter(Boolean))].sort();
}

/** Resolve the same state source used by state.js, as an absolute path. */
export function resolveRuntimeStateFile(environment = process.env) {
  const configured = typeof environment?.MERIDIAN_STATE_FILE === "string"
    ? environment.MERIDIAN_STATE_FILE
    : "";
  return configured ? path.resolve(configured) : repoPath("state.json");
}

function legacyRecord(position, key) {
  const flags = [
    "LEGACY_NO_TRANSACTION_LEDGER",
    "LEGACY_NO_RECONCILIATION_EVIDENCE",
    "LEGACY_NO_CLEANUP_EVIDENCE",
    "LEGACY_NO_BREAKER_EVIDENCE",
  ];
  const deployedSol = positiveFiniteNumber(position.position_sol_deployed);
  const withdrawnSol = finiteNumber(position.position_sol_withdrawn);
  const feesSol = finiteNumber(position.position_sol_fees);
  const finalSol = finiteNumber(position.position_sol_final);
  const netSol = finiteNumber(position.position_sol_pnl);
  const walletRoundTripSol = finiteNumber(
    position.wallet_sol_roundtrip_delta_after_autoswap ?? position.wallet_sol_roundtrip_delta,
  );
  const economicsComplete = [deployedSol, withdrawnSol, feesSol, finalSol, netSol].every((value) => value != null);

  if (!economicsComplete) flags.push("MISSING_COMPLETE_SOL_ECONOMICS");
  if (walletRoundTripSol == null) flags.push("MISSING_WALLET_ROUNDTRIP_DELTA");
  if (!isoOrNull(position.deployed_at)) flags.push("MISSING_OR_INVALID_DEPLOY_TIME");
  if (!isoOrNull(position.closed_at)) flags.push("MISSING_OR_INVALID_CLOSE_TIME");

  return {
    schema_version: 1,
    record_type: "legacy_lifecycle_replay",
    lifecycle_id: `legacy:${String(position.position || key)}`,
    position_address: position.position || key,
    pool_address: position.pool || null,
    deployed_at: isoOrNull(position.deployed_at),
    closed_at: isoOrNull(position.closed_at),
    strategy: position.strategy || null,
    economics: {
      reported_deploy_sol: finiteNumber(position.amount_sol),
      deployed_sol: deployedSol,
      withdrawn_sol: withdrawnSol,
      fees_sol: feesSol,
      final_sol: finalSol,
      net_sol: netSol,
      wallet_roundtrip_sol: walletRoundTripSol,
    },
    data_quality: {
      classification: economicsComplete ? "legacy_partial" : "legacy_incomplete",
      economics_complete: economicsComplete,
      reconciliation_available: false,
      cleanup_evidence_available: false,
      breaker_evidence_available: false,
      flags: uniqueSorted(flags),
    },
  };
}

/**
 * Convert closed state records to an in-memory historical replay. The raw
 * source snapshot can satisfy historical coverage only; stored replay output
 * remains diagnostic and cannot authorize a canary on its own.
 */
export function buildLegacyReplay(state, {
  source = "state.json",
  now = new Date(),
  minHistoricalLifecycles = DEFAULT_ACCEPTANCE_THRESHOLDS.minHistoricalLifecycles,
} = {}) {
  const positions = Object.entries(state?.positions || {});
  const records = positions
    .filter(([, position]) => position?.closed === true)
    .map(([key, position]) => legacyRecord(position, key));
  const uniqueFlags = uniqueSorted(records.flatMap((record) => record.data_quality.flags));
  const economicsCompleteCount = records.filter((record) => record.data_quality.economics_complete).length;
  const validTimestampCount = records.filter((record) => record.deployed_at && record.closed_at).length;
  const thresholds = normalizedThresholds({ minHistoricalLifecycles });

  const metrics = {
    schema_version: ROLLOUT_ACCEPTANCE_SCHEMA_VERSION,
    kind: "historical_replay_metrics",
    generated_at: new Date(now).toISOString(),
    dataset_type: "historical_replay",
    source: String(source),
    lifecycle_count: records.length,
    valid_timestamp_count: validTimestampCount,
    data_quality: {
      classification: "legacy_count_only",
      economics_complete_count: economicsCompleteCount,
      economics_incomplete_count: records.length - economicsCompleteCount,
      reconciliation_available_count: 0,
      cleanup_evidence_available_count: 0,
      breaker_evidence_available_count: 0,
      flags: uniqueFlags,
      // Legacy economics are not permitted to satisfy financial canary gates.
      usable_for_financial_canary_gates: false,
      usable_for_historical_coverage_gate: records.length >= thresholds.minHistoricalLifecycles,
    },
    dry_run_gate: {
      pass: records.length >= thresholds.minHistoricalLifecycles,
      actual: records.length,
      required: thresholds.minHistoricalLifecycles,
      reason: records.length >= thresholds.minHistoricalLifecycles
        ? "HISTORICAL_REPLAY_COVERAGE_MET"
        : "HISTORICAL_REPLAY_COVERAGE_BELOW_MINIMUM",
    },
  };

  return {
    schema_version: ROLLOUT_ACCEPTANCE_SCHEMA_VERSION,
    kind: "legacy_lifecycle_replay",
    generated_at: metrics.generated_at,
    dataset_type: "historical_replay",
    source: String(source),
    records,
    metrics,
  };
}

function isWithin(candidate, container) {
  return candidate === container || candidate.startsWith(`${container}${path.sep}`);
}

function pathComponents(resolved) {
  const parsed = path.parse(resolved);
  const relative = path.relative(parsed.root, resolved);
  return relative && relative !== "." ? relative.split(path.sep).filter(Boolean) : [];
}

function descriptorPath(descriptor, name = null) {
  const base = `/proc/self/fd/${descriptor}`;
  return name == null ? base : path.join(base, name);
}

function closeDescriptor(descriptor) {
  if (descriptor != null) fs.closeSync(descriptor);
}

function requireSecureDescriptorSupport(label) {
  const { O_DIRECTORY, O_NOFOLLOW, O_CREAT, O_EXCL } = fs.constants;
  if (process.platform !== "linux" || ![O_DIRECTORY, O_NOFOLLOW, O_CREAT, O_EXCL].every(Number.isInteger)) {
    throw new Error(`Secure descriptor-based ${label.toLowerCase()} handling requires Linux O_DIRECTORY and O_NOFOLLOW support`);
  }
  try {
    fs.accessSync("/proc/self/fd", fs.constants.R_OK | fs.constants.X_OK);
  } catch (error) {
    throw new Error(`Secure descriptor-based ${label.toLowerCase()} handling requires accessible /proc/self/fd: ${error.message}`);
  }
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

/**
 * Confirm that the descriptor still names the directory we opened and, for
 * output, that this directory cannot resolve into the repository.
 */
function inspectOpenedDirectory(descriptor, label, { requireExternal = false } = {}) {
  const opened = fs.fstatSync(descriptor);
  if (!opened.isDirectory()) throw new Error(`Secure ${label.toLowerCase()} descriptor is not a directory`);

  const anchoredPath = descriptorPath(descriptor);
  const throughProc = fs.statSync(anchoredPath);
  if (!sameFileIdentity(opened, throughProc)) {
    throw new Error(`Secure ${label.toLowerCase()} descriptor identity changed during validation`);
  }

  const realDirectory = fs.realpathSync(anchoredPath);
  if (requireExternal && isWithin(realDirectory, fs.realpathSync(REPO_ROOT))) {
    throw new Error(`${label} output resolves inside the repository`);
  }
  return { realDirectory, identity: { dev: opened.dev, ino: opened.ino } };
}

/**
 * Walk an absolute path one directory at a time through already-opened Linux
 * directory descriptors. Node has no openat API, but /proc/self/fd/<n>/child
 * gives the same anchor for this process. O_NOFOLLOW applies at every step.
 */
function openSecureDirectory(resolved, label, {
  createMissing = false,
  requireExternal = false,
} = {}) {
  requireSecureDescriptorSupport(label);
  const parsed = path.parse(resolved);
  const directoryFlags = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
  let descriptor = null;
  try {
    descriptor = fs.openSync(parsed.root, directoryFlags);
    inspectOpenedDirectory(descriptor, label, { requireExternal: false });

    for (const component of pathComponents(resolved)) {
      const childPath = descriptorPath(descriptor, component);
      let child = null;
      try {
        child = fs.openSync(childPath, directoryFlags);
      } catch (error) {
        if (!createMissing || error?.code !== "ENOENT") throw error;
        try {
          fs.mkdirSync(childPath, { mode: 0o700 });
        } catch (mkdirError) {
          if (mkdirError?.code !== "EEXIST") throw mkdirError;
        }
        child = fs.openSync(childPath, directoryFlags);
      }
      closeDescriptor(descriptor);
      descriptor = child;
      inspectOpenedDirectory(descriptor, label, { requireExternal });
    }
    return descriptor;
  } catch (error) {
    closeDescriptor(descriptor);
    throw new Error(`Could not establish secure descriptor-based ${label.toLowerCase()} directory: ${error.message}`);
  }
}

function assertNoSymlinkPathComponents(resolved, label) {
  const parsed = path.parse(resolved);
  let probe = parsed.root;
  let stat = null;
  for (const component of pathComponents(resolved)) {
    probe = path.join(probe, component);
    stat = fs.lstatSync(probe);
    if (stat.isSymbolicLink()) {
      const error = new Error(`${label} rejects symlinked ancestors: ${probe}`);
      error.code = "ELOOP";
      throw error;
    }
  }
  return stat;
}

/**
 * Check every existing ancestor without following a symlink. This prevents a
 * lexically external output such as /tmp/link/artifact from resolving back
 * into the repository through a symlink or mount-like real path.
 */
function assertArtifactPathConfined(resolved, label) {
  const repositoryLexical = path.resolve(REPO_ROOT);
  if (isWithin(resolved, repositoryLexical)) {
    throw new Error(`${label} output must be outside the repository`);
  }

  let probe = resolved;
  const missingSegments = [];
  while (true) {
    let stat;
    try {
      stat = fs.lstatSync(probe);
    } catch (error) {
      if (error?.code !== "ENOENT") throw new Error(`Could not inspect ${label.toLowerCase()} output path: ${error.message}`);
      const parent = path.dirname(probe);
      if (parent === probe) throw new Error(`Could not resolve ${label.toLowerCase()} output path`);
      missingSegments.unshift(path.basename(probe));
      probe = parent;
      continue;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`${label} output rejects symlinked ancestors: ${probe}`);
    }
    let realAncestor;
    try {
      realAncestor = fs.realpathSync(probe);
    } catch (error) {
      throw new Error(`Could not resolve ${label.toLowerCase()} output path: ${error.message}`);
    }
    const realRepository = fs.realpathSync(REPO_ROOT);
    const realTarget = path.resolve(realAncestor, ...missingSegments);
    if (isWithin(realTarget, realRepository)) {
      throw new Error(`${label} output resolves inside the repository`);
    }
    return;
  }
}

function assertNewExternalPath(outputPath, label) {
  const resolved = path.resolve(outputPath);
  assertArtifactPathConfined(resolved, label);
  return resolved;
}

function createNewSecureOutputDirectory(outputDir, label) {
  const directory = assertNewExternalPath(outputDir, label);
  const parent = path.dirname(directory);
  const name = path.basename(directory);
  let parentDescriptor = null;
  let directoryDescriptor = null;
  try {
    parentDescriptor = openSecureDirectory(parent, label, { createMissing: true, requireExternal: true });
    try {
      fs.mkdirSync(descriptorPath(parentDescriptor, name), { mode: 0o700 });
    } catch (error) {
      if (error?.code === "EEXIST") {
        throw new Error(`Refusing to overwrite ${label.toLowerCase()} output at existing path: ${directory}`);
      }
      throw error;
    }
    const directoryFlags = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
    directoryDescriptor = fs.openSync(descriptorPath(parentDescriptor, name), directoryFlags);
    const inspected = inspectOpenedDirectory(directoryDescriptor, label, { requireExternal: true });
    return { descriptor: directoryDescriptor, directory: inspected.realDirectory };
  } catch (error) {
    closeDescriptor(directoryDescriptor);
    throw error;
  } finally {
    closeDescriptor(parentDescriptor);
  }
}

function openSecureOutputDirectory(outputPath, label) {
  const directory = path.dirname(assertNewExternalPath(outputPath, label));
  const descriptor = openSecureDirectory(directory, label, { createMissing: true, requireExternal: true });
  try {
    const inspected = inspectOpenedDirectory(descriptor, label, { requireExternal: true });
    return { descriptor, directory: inspected.realDirectory };
  } catch (error) {
    closeDescriptor(descriptor);
    throw error;
  }
}

function writeNewDiagnosticFile(directoryDescriptor, filename, contents, label) {
  if (!filename || path.basename(filename) !== filename || filename === "." || filename === "..") {
    throw new Error(`Invalid ${label.toLowerCase()} output filename`);
  }

  inspectOpenedDirectory(directoryDescriptor, label, { requireExternal: true });
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW;
  let descriptor = null;
  try {
    descriptor = fs.openSync(descriptorPath(directoryDescriptor, filename), flags, 0o600);
    if (!fs.fstatSync(descriptor).isFile()) {
      throw new Error(`Secure ${label.toLowerCase()} output descriptor is not a regular file`);
    }
    fs.writeFileSync(descriptor, contents);
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new Error(`Refusing to overwrite ${label.toLowerCase()} output at existing path: ${filename}`);
    }
    throw error;
  } finally {
    closeDescriptor(descriptor);
  }

  // Re-read both descriptor identity and canonical location after writing so
  // a renamed parent returns the actual external directory, not an attacker
  // controlled replacement of the original path.
  return path.join(inspectOpenedDirectory(directoryDescriptor, label, { requireExternal: true }).realDirectory, filename);
}

/** Writes only new, explicit, repository-external diagnostic replay artifacts. */
export function writeLegacyReplay(replay, outputDir) {
  if (!outputDir) throw new Error("An explicit --output directory is required before writing replay artifacts");
  const output = createNewSecureOutputDirectory(outputDir, "Replay");
  try {
    const replayPath = writeNewDiagnosticFile(
      output.descriptor,
      "legacy-lifecycle-replay.jsonl",
      `${replay.records.map((record) => JSON.stringify(record)).join("\n")}\n`,
      "Replay",
    );
    const metricsPath = writeNewDiagnosticFile(
      output.descriptor,
      "historical-replay-metrics.json",
      `${JSON.stringify(replay.metrics, null, 2)}\n`,
      "Replay",
    );
    const manifestPath = writeNewDiagnosticFile(
      output.descriptor,
      "manifest.json",
      `${JSON.stringify({
        schema_version: ROLLOUT_ACCEPTANCE_SCHEMA_VERSION,
        kind: "legacy_replay_output",
        dataset_type: "historical_replay",
        source: replay.source,
        records: replay.records.length,
        files: {
          replay: path.basename(replayPath),
          metrics: path.basename(metricsPath),
        },
        production_ledger_touched: false,
      }, null, 2)}\n`,
      "Replay",
    );
    const directory = inspectOpenedDirectory(output.descriptor, "Replay", { requireExternal: true }).realDirectory;
    return { directory, replayPath, metricsPath, manifestPath };
  } finally {
    closeDescriptor(output.descriptor);
  }
}

function gate(pass, actual, required, reason) {
  return { pass: Boolean(pass), actual, required, reason };
}

function historicalReplayGate(metrics, thresholds, sourceAvailable, sourceReason = null) {
  const historicalValid = metrics?.kind === "historical_replay_metrics"
    && metrics?.dataset_type === "historical_replay";
  const historicalCount = asNonNegativeInteger(metrics?.lifecycle_count, 0);
  const pass = sourceAvailable === true && historicalValid && historicalCount >= thresholds.minHistoricalLifecycles;
  return gate(
    pass,
    historicalCount,
    thresholds.minHistoricalLifecycles,
    !sourceAvailable ? sourceReason || "HISTORICAL_REPLAY_SOURCE_REQUIRED"
      : !historicalValid ? "HISTORICAL_REPLAY_METRICS_REQUIRED"
        : historicalCount >= thresholds.minHistoricalLifecycles
          ? "HISTORICAL_REPLAY_COVERAGE_MET"
          : "HISTORICAL_REPLAY_COVERAGE_BELOW_MINIMUM",
  );
}

/**
 * Recompute historical coverage directly from one raw state snapshot. The
 * snapshot's bytes are parsed and hashed in the same read, so startup never
 * relies on a stored `ready` flag or a separately editable replay summary.
 */
export function evaluateHistoricalReplaySource({
  statePath = null,
  now = new Date(),
  minHistoricalLifecycles = DEFAULT_ACCEPTANCE_THRESHOLDS.minHistoricalLifecycles,
} = {}) {
  const evaluatedAt = new Date(now);
  if (!Number.isFinite(evaluatedAt.getTime())) throw new Error("Historical replay evaluation requires a valid current time");
  if (!statePath) {
    return {
      available: false,
      reason: "HISTORICAL_REPLAY_SOURCE_REQUIRED",
      metrics: null,
      replay: null,
      source: { file: null, sha256: null, bytes: 0, modified_at: null },
    };
  }

  const file = path.resolve(statePath);
  let stat;
  try {
    // Reject every symlink component before opening. The descriptor walk below
    // repeats this protection under O_NOFOLLOW so an ancestor swap after this
    // validation fails closed instead of redirecting the source read.
    stat = assertNoSymlinkPathComponents(file, "Historical replay source");
  } catch (error) {
    if (error?.code !== "ELOOP") {
      return {
        available: false,
        reason: "HISTORICAL_REPLAY_SOURCE_MISSING",
        metrics: null,
        replay: null,
        source: { file, sha256: null, bytes: 0, modified_at: null },
      };
    }
    return {
      available: false,
      reason: "HISTORICAL_REPLAY_SOURCE_NOT_REGULAR_FILE",
      metrics: null,
      replay: null,
      source: { file, sha256: null, bytes: 0, modified_at: null },
    };
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    return {
      available: false,
      reason: "HISTORICAL_REPLAY_SOURCE_NOT_REGULAR_FILE",
      metrics: null,
      replay: null,
      source: { file, sha256: null, bytes: 0, modified_at: stat.mtime.toISOString() },
    };
  }

  let bytes;
  let state;
  try {
    // Anchor the final open to a descriptor walk with O_NOFOLLOW at every
    // ancestor, then use this one descriptor for validation and hashing.
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);
    const parentDescriptor = openSecureDirectory(path.dirname(file), "Historical replay source");
    let descriptor = null;
    try {
      descriptor = fs.openSync(descriptorPath(parentDescriptor, path.basename(file)), flags);
      stat = fs.fstatSync(descriptor);
      if (!stat.isFile()) {
        return {
          available: false,
          reason: "HISTORICAL_REPLAY_SOURCE_NOT_REGULAR_FILE",
          metrics: null,
          replay: null,
          source: { file, sha256: null, bytes: 0, modified_at: stat.mtime.toISOString() },
        };
      }
      bytes = fs.readFileSync(descriptor);
    } finally {
      closeDescriptor(descriptor);
      closeDescriptor(parentDescriptor);
    }
    state = JSON.parse(bytes.toString("utf8"));
  } catch {
    return {
      available: false,
      reason: "HISTORICAL_REPLAY_SOURCE_UNREADABLE",
      metrics: null,
      replay: null,
      source: { file, sha256: null, bytes: 0, modified_at: stat.mtime.toISOString() },
    };
  }
  if (!state || typeof state !== "object" || Array.isArray(state) ||
    (state.positions != null && (typeof state.positions !== "object" || Array.isArray(state.positions)))) {
    return {
      available: false,
      reason: "HISTORICAL_REPLAY_SOURCE_INVALID_STATE",
      metrics: null,
      replay: null,
      source: { file, sha256: null, bytes: bytes.length, modified_at: stat.mtime.toISOString() },
    };
  }

  const replay = buildLegacyReplay(state, {
    source: file,
    now: evaluatedAt,
    minHistoricalLifecycles,
  });
  return {
    available: true,
    reason: null,
    metrics: replay.metrics,
    replay,
    source: {
      file,
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
      modified_at: stat.mtime.toISOString(),
      evaluated_at: evaluatedAt.toISOString(),
    },
  };
}

/**
 * Read-only acceptance evaluation. Historical coverage is recomputed from a
 * raw state snapshot and joins authoritative shadow evidence in the canary
 * decision. Legacy economics still never satisfy shadow financial gates.
 */
export function evaluateRolloutAcceptance({
  historicalStatePath = null,
  // Retained solely for diagnostic compatibility with replay reports. Startup
  // authorization ignores it and recomputes from historicalStatePath.
  historicalMetrics = null,
  historicalMetricsPath = null,
  shadowEvidencePath = null,
  shadowRunId = null,
  thresholds: thresholdOverrides = {},
  now = new Date(),
} = {}) {
  const nowMs = new Date(now).getTime();
  if (!Number.isFinite(nowMs)) throw new Error("Acceptance evaluation requires a valid current time");
  const thresholds = normalizedThresholds(thresholdOverrides);
  const historicalSource = evaluateHistoricalReplaySource({
    statePath: historicalStatePath,
    now: new Date(nowMs),
    minHistoricalLifecycles: thresholds.minHistoricalLifecycles,
  });
  const historicalGate = historicalReplayGate(
    historicalSource.metrics,
    thresholds,
    historicalSource.available,
    historicalSource.reason,
  );
  const shadow = evaluateShadowEvidence({
    filePath: shadowEvidencePath,
    runId: shadowRunId,
    strategyProfile: LOCKED_CANARY.strategyProfile,
    thresholds: {
      minDryRunHours: thresholds.minDryRunHours,
      minCompletedShadowLifecycles: thresholds.minCompletedShadowLifecycles,
      minNetSol: thresholds.minNetSol,
      maxDrawdownSol: thresholds.maxDrawdownSol,
      maxHeartbeatGapMinutes: thresholds.maxHeartbeatGapMinutes,
      maxConcurrentPositions: LOCKED_CANARY.maxPositions,
      maxDeployedAmountSol: LOCKED_CANARY.deployAmountSol,
      requiredDeployAmountSol: LOCKED_CANARY.deployAmountSol,
    },
    now: new Date(nowMs),
  });
  const canaryConstraintGate = gate(
    LOCKED_CANARY.deployAmountSol === 0.2 &&
      LOCKED_CANARY.maxPositions === 1 &&
      LOCKED_CANARY.strategyProfile === SHADOW_ROTATION_STRATEGY_PROFILE,
    LOCKED_CANARY,
    {
      deployAmountSol: 0.2,
      maxPositions: 1,
      strategyProfile: SHADOW_ROTATION_STRATEGY_PROFILE,
    },
    "LOCKED_CANARY_CONSTRAINTS",
  );

  const sourceGates = shadow.gates && Object.keys(shadow.gates).length > 0
    ? shadow.gates
    : { source_evidence: gate(false, false, true, shadow.reason || "SHADOW_EVIDENCE_REQUIRED") };
  const canaryGates = {
    historical_replay: historicalGate,
    ...sourceGates,
    canary_constraints: canaryConstraintGate,
  };
  const canaryReady = Object.values(canaryGates).every((item) => item.pass);

  return {
    schema_version: ROLLOUT_ACCEPTANCE_SCHEMA_VERSION,
    kind: "rollout_acceptance",
    generated_at: new Date(nowMs).toISOString(),
    thresholds,
    historical_replay: {
      dataset_type: historicalSource.metrics?.dataset_type ?? null,
      lifecycle_count: asNonNegativeInteger(historicalSource.metrics?.lifecycle_count, 0),
      data_quality: historicalSource.metrics?.data_quality ?? null,
      source: historicalSource.source,
      recomputed_from_source: historicalSource.available,
      diagnostic_metrics_supplied: historicalMetrics != null || historicalMetricsPath != null,
    },
    shadow_baseline: {
      dataset_type: "shadow_baseline",
      run_id: shadow.run_id ?? shadowRunId ?? null,
      evidence_path: shadowEvidencePath ?? null,
      coverage: shadow.coverage ?? null,
      ...(shadow.shadow_baseline ?? {}),
    },
    source_hashes: {
      shadow_evidence: shadow.source?.sha256 ?? null,
      historical_replay_source: historicalSource.source?.sha256 ?? null,
      historical_metrics_diagnostic: historicalMetricsPath ? sha256File(historicalMetricsPath) : null,
    },
    source_evidence: shadow.source ?? { file: shadowEvidencePath ?? null, sha256: null, record_count: 0 },
    dry_run: {
      ready: historicalGate.pass,
      gates: { historical_replay: historicalGate },
    },
    canary: {
      ready: canaryReady,
      gates: canaryGates,
    },
  };
}

export function formatAcceptanceSummary(acceptance) {
  const canaryGates = Object.entries(acceptance.canary.gates)
    .map(([name, result]) => `  ${result.pass ? "PASS" : "BLOCK"} ${name}: ${result.reason}`);
  return [
    `Rollout acceptance: ${acceptance.generated_at}`,
    `Historical replay: ${acceptance.historical_replay.lifecycle_count} lifecycle(s), quality=${acceptance.historical_replay.data_quality?.classification ?? "missing"}, source=${acceptance.historical_replay.source?.file ?? "missing"}`,
    `Dry run: ${acceptance.dry_run.ready ? "READY" : "BLOCKED"}`,
    `Shadow baseline: run=${acceptance.shadow_baseline.run_id ?? "missing"}, ${acceptance.shadow_baseline.settled_lifecycle_count ?? 0} settled lifecycle(s), ${acceptance.shadow_baseline.coverage?.hours ?? 0}h, net ${acceptance.shadow_baseline.authoritative_net_sol ?? "?"} SOL, PF ${acceptance.shadow_baseline.profit_factor ?? "?"}, max loss ${acceptance.shadow_baseline.max_single_loss_pct ?? "?"}%, drawdown ${acceptance.shadow_baseline.max_mark_to_market_drawdown_sol ?? "?"} SOL`,
    `Canary (${LOCKED_CANARY.deployAmountSol.toFixed(2)} SOL, one ${LOCKED_CANARY.strategyProfile} position): ${acceptance.canary.ready ? "READY" : "BLOCKED"}`,
    ...canaryGates,
  ].join("\n");
}

/** Explicit, non-overwriting diagnostic file write; never an authorization token. */
export function writeAcceptanceArtifact(acceptance, outputPath) {
  if (!outputPath) throw new Error("An explicit --output file is required before writing acceptance metrics");
  const filename = path.basename(path.resolve(outputPath));
  const output = openSecureOutputDirectory(outputPath, "Acceptance");
  try {
    return writeNewDiagnosticFile(output.descriptor, filename, `${JSON.stringify(acceptance, null, 2)}\n`, "Acceptance");
  } finally {
    closeDescriptor(output.descriptor);
  }
}
