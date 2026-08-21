import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-baseline-rollout-"));
process.env.MERIDIAN_USER_CONFIG_FILE = path.join(tmp, "user-config.json");
process.env.MERIDIAN_STATE_FILE = path.join(tmp, "state.json");
process.env.MERIDIAN_LESSONS_FILE = path.join(tmp, "lessons.json");

function historicalState(count) {
  return {
    positions: Object.fromEntries(Array.from({ length: count }, (_, index) => [
      `closed-${index}`,
      { position: `closed-${index}`, closed: true },
    ])),
  };
}

fs.writeFileSync(process.env.MERIDIAN_USER_CONFIG_FILE, JSON.stringify({
  dryRun: true,
  rolloutMode: "dry_run",
  multiLayerEnabled: true,
  darwinEnabled: true,
  hiveMindEnabled: true,
  rebalanceEnabled: true,
  compoundEnabled: true,
  adaptiveSizingEnabled: false,
}));
fs.writeFileSync(process.env.MERIDIAN_STATE_FILE, JSON.stringify(historicalState(29)));

try {
  const {
    config,
    LOCKED_CANARY_LIMITS,
    getHistoricalReplayCoverageGate,
    getPaperDeploymentGate,
  } = await import("../config.js");
  const {
    ensureAgentId,
    getSharedLessonsForPrompt,
    isHiveMindEnabled,
  } = await import("../hivemind.js");
  const {
    runManagementCycle,
    runScreeningCycle,
  } = await import("../index.js");

  const beforeCoverage = getHistoricalReplayCoverageGate();
  const beforePaperGate = getPaperDeploymentGate();
  assert.equal(beforeCoverage.pass, false);
  assert.equal(beforeCoverage.actual, 29);
  assert.equal(beforeCoverage.required, 30);
  assert.equal(beforeCoverage.reason, "HISTORICAL_REPLAY_COVERAGE_BELOW_MINIMUM");
  assert.equal(config.rollout.historicalReplayCoverage.pass, false, "startup exposes the raw replay signal");
  assert.equal(beforePaperGate.applied, true);
  assert.equal(beforePaperGate.pass, false, "paper screening/deploy must fail closed before replay coverage");
  const callerSuppliedBypass = getPaperDeploymentGate({
    rollout: { mode: "canary", dryRun: false, historicalReplayStateFile: "forged-state.json" },
    historicalReplayCoverage: { pass: true, actual: 999, required: 0 },
  });
  assert.equal(callerSuppliedBypass.pass, false, "caller-supplied rollout and coverage cannot bypass the private gate");
  assert.equal(callerSuppliedBypass.historicalReplayCoverage.actual, 29);

  // Every baseline override is ignored and locked against in-process mutation.
  assert.equal(config.rollout.baseline.locked, true);
  assert.equal(config.strategy.multiLayerEnabled, false);
  assert.equal(config.darwin.enabled, false);
  assert.equal(config.management.rebalanceEnabled, false);
  assert.equal(config.management.compoundEnabled, false);
  assert.equal(config.hiveMind.enabled, false);
  assert.equal(config.sizing.enabled, true, "adaptive sizing remains enabled");
  assert.throws(() => { config.strategy.multiLayerEnabled = true; }, TypeError);
  assert.throws(() => { config.darwin.enabled = true; }, TypeError);
  assert.throws(() => { config.hiveMind.enabled = true; }, TypeError);
  assert.throws(() => { config.management.rebalanceEnabled = true; }, TypeError);
  assert.throws(() => { config.management.compoundEnabled = true; }, TypeError);
  for (const key of ["strategy", "management", "darwin", "hiveMind", "sizing", "rollout"]) {
    const descriptor = Object.getOwnPropertyDescriptor(config, key);
    assert.equal(descriptor?.writable, false, `${key} container is non-replaceable`);
    assert.equal(descriptor?.configurable, false, `${key} container is non-configurable`);
  }
  assert.throws(() => { config.strategy = { multiLayerEnabled: true }; }, TypeError);
  assert.throws(() => { config.management = { rebalanceEnabled: true, compoundEnabled: true }; }, TypeError);
  assert.throws(() => { config.darwin = { enabled: true }; }, TypeError);
  assert.throws(() => { config.hiveMind = { enabled: true }; }, TypeError);
  assert.throws(() => { config.sizing = { enabled: false }; }, TypeError);
  assert.throws(() => { config.rollout = { mode: "canary", dryRun: false, baseline: { locked: false } }; }, TypeError);
  assert.throws(() => { config.rollout.baseline = { locked: false }; }, TypeError);
  assert.throws(() => Object.assign(config.strategy, { multiLayerEnabled: true }), TypeError, "update_config-style mutation cannot change locked leaves");
  assert.equal(config.strategy.multiLayerEnabled, false);
  assert.equal(config.management.rebalanceEnabled, false);
  assert.equal(config.management.compoundEnabled, false);
  assert.equal(config.darwin.enabled, false);
  assert.equal(config.hiveMind.enabled, false);
  assert.equal(config.sizing.enabled, true, "adaptive sizing remains enabled after mutation attempts");
  assert.deepEqual(LOCKED_CANARY_LIMITS, { deployAmountSol: 0.2, maxPositions: 1 });
  assert.equal(config.rollout.canaryDeployAmountSol, 0.2);
  assert.equal(config.rollout.canaryMaxPositions, 1);

  // HiveMind cannot create an identity, read cached shared lessons, or become
  // enabled while the baseline is locked.
  const configBeforeHiveProbe = fs.readFileSync(process.env.MERIDIAN_USER_CONFIG_FILE, "utf8");
  assert.equal(isHiveMindEnabled(), false);
  assert.equal(ensureAgentId(), null);
  assert.equal(getSharedLessonsForPrompt(), null);
  assert.equal(fs.readFileSync(process.env.MERIDIAN_USER_CONFIG_FILE, "utf8"), configBeforeHiveProbe);

  // Paper observation/settlement still precedes the entry gate. This injects
  // only the observation and gate behavior; no wallet, RPC, or evidence path
  // is exercised by the isolated test.
  const managementOrder = [];
  const managementReport = await runManagementCycle({
    silent: true,
    dependencies: {
      runShadowLifecycleCycle: async () => {
        managementOrder.push("observe");
        return {
          started_open_positions: 0,
          started_deployed_amount_sol: 0,
          records: [],
          metrics: { completed_lifecycles: 0, open_positions: 0, total_net_pnl_sol: 0, total_estimated_cost_sol: 0 },
          report: "",
          observed: 0,
          settled: 0,
          failed: 0,
          open_positions: 0,
        };
      },
      getShadowRolloutEvidenceSnapshot: () => null,
      getPaperDeploymentGate: () => {
        managementOrder.push("entry-gate");
        return beforePaperGate;
      },
    },
  });
  assert.deepEqual(managementOrder, ["observe", "entry-gate"]);
  assert.match(managementReport, /existing paper positions remain under observation/i);

  // The normal screening entry path also returns before its wallet/RPC work
  // when the fresh raw replay gate is below baseline.
  const screeningReport = await runScreeningCycle({ silent: true });
  assert.match(screeningReport, /Screening blocked — historical replay coverage 29\/30/);

  // The runtime gate re-reads raw state; adding the 30th closed lifecycle is
  // the only change needed to allow a new paper lifecycle to be screened.
  fs.writeFileSync(process.env.MERIDIAN_STATE_FILE, JSON.stringify(historicalState(30)));
  const readyCoverage = getHistoricalReplayCoverageGate();
  const readyPaperGate = getPaperDeploymentGate();
  assert.equal(readyCoverage.pass, true);
  assert.equal(readyCoverage.reason, "HISTORICAL_REPLAY_COVERAGE_MET");
  assert.equal(readyPaperGate.pass, true);

  console.log("baseline rollout gate tests passed");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

// index.js imports the DLMM module, which owns cache-clearing intervals. Exit
// after isolated gate behavior tests so no service loop remains active.
process.exit(0);
