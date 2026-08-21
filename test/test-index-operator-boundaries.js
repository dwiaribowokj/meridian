import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-index-operator-boundaries-"));
process.env.MERIDIAN_USER_CONFIG_FILE = path.join(tmp, "user-config.json");
process.env.MERIDIAN_STATE_FILE = path.join(tmp, "state.json");
process.env.MERIDIAN_LESSONS_FILE = path.join(tmp, "lessons.json");
fs.writeFileSync(process.env.MERIDIAN_USER_CONFIG_FILE, JSON.stringify({ dryRun: true, rolloutMode: "dry_run" }));

try {
  const {
    formatOperatorStatusText,
    formatCommittedBreakerCleanupFailure,
    calculateCanaryEquitySol,
    observeLiveCanaryEquity,
    runManagementCycle,
    deployLatestCandidate,
    deployPoolAddress,
    deployTokenAddress,
  } = await import("../index.js");

  const status = formatOperatorStatusText({
    rollout: {
      mode: "dry_run",
      requestedMode: "canary",
      dryRun: true,
      operatorOverrideActive: true,
      canaryDeployAmountSol: 0.2,
      canaryMaxPositions: 1,
      safety: {
        acceptance: {
          ready: false,
          run_id: "shadow-run-1",
          reason: "SHADOW_BASELINE_PENDING",
          // A stale top-level count must never override the nested source
          // structure produced by resolveRolloutSafety.
          source: {
            record_count: 999,
            shadow: { record_count: 24 },
            historical: { file: "isolated-state.json" },
          },
          gates: {
            historical_replay: { actual: 30, pass: true, reason: "HISTORICAL_REPLAY_COVERAGE_MET" },
          },
        },
        diagnostics: [],
      },
    },
    breaker: { tripped: false, manualResumeRequired: false, reasons: [], consecutiveOperationalFailures: 0 },
    ledgerStatus: "Ledger: isolated",
  });
  assert.match(status, /shadow records 24/);
  assert.match(status, /Operator readiness override: ACTIVE/);
  assert.doesNotMatch(status, /records 999/);
  assert.match(status, /Historical replay: 30 lifecycle\(s\) \| READY/);

  const postUnlinkCloseMessage = await formatCommittedBreakerCleanupFailure({
    operation: "resume",
    error: { committed: true, cleanupLockState: "absent" },
    persistenceStatus: () => ({
      committed: true,
      cleanupError: "injected post-unlink close failure",
      cleanupLockState: "absent",
    }),
    entryAllowed: async () => true,
  });
  assert.match(postUnlinkCloseMessage, /update lock is absent/i);
  assert.match(postUnlinkCloseMessage, /Entry is currently allowed/i);
  assert.doesNotMatch(postUnlinkCloseMessage, /remains fail-closed/i);

  const retainedCleanupMessage = await formatCommittedBreakerCleanupFailure({
    operation: "resume",
    error: { committed: true, cleanupLockState: "retained_or_unknown" },
    entryAllowed: async () => true,
  });
  assert.match(retainedCleanupMessage, /remains fail-closed/i);

  const valuation = calculateCanaryEquitySol({
    wallet: { sol: 0.8, sol_price: 100 },
    positions: [{ position: "lp-1", total_value_true_usd: 20 }],
    solMode: false,
  });
  assert.equal(valuation.ok, true);
  assert.equal(valuation.wallet_sol, 0.8);
  assert.equal(valuation.open_lp_sol, 0.2);
  assert.equal(valuation.unclaimed_fee_sol, 0);
  assert.equal(valuation.pending_cleanup_sol, 0);
  assert.equal(valuation.equity_sol, 1);
  const pendingCleanupValuation = calculateCanaryEquitySol({
    wallet: { sol: 0.6091348369442029, sol_price: 100 },
    positions: [],
    pendingCleanupEquity: {
      ok: true,
      total_sol: 0.034855871,
      total_lamports: "34855871",
      lifecycle_count: 1,
    },
    solMode: false,
  });
  assert.equal(pendingCleanupValuation.ok, true);
  assert.equal(pendingCleanupValuation.pending_cleanup_sol, 0.034855871);
  assert.equal(pendingCleanupValuation.equity_sol, 0.6439907079442029);
  assert.ok(
    ((0.6458733195250063 - pendingCleanupValuation.equity_sol) / 0.6458733195250063) * 100 < 3,
    "Plumber's conservative residue mark must keep the demonstrated canary drawdown below 3%",
  );
  assert.equal(calculateCanaryEquitySol({
    wallet: { sol: 0.6091348369442029, sol_price: 100 },
    positions: [],
    pendingCleanupEquity: { ok: false, reason: "quote unavailable" },
  }).ok, false, "unpriced cleanup residue must not be silently marked to zero");
  const informationalNonStableMarkIgnored = calculateCanaryEquitySol({
    wallet: {
      sol: 0.6,
      sol_price: 100,
      tokens: [{ mint: "PlumberMint", usd_raw: 3 }],
    },
    positions: [],
    pendingCleanupEquity: {
      ok: true,
      total_sol: 0.05,
      lifecycle_count: 1,
      positions: [{ accounts: [{ mint: "PlumberMint" }] }],
    },
  });
  assert.equal(informationalNonStableMarkIgnored.equity_sol, 0.65,
    "non-stable wallet token marks are informational and are not double-counted by base wallet equity");
  const feeInclusiveValuation = calculateCanaryEquitySol({
    wallet: { sol: 0.13, sol_price: 100 },
    positions: [{
      position: "lp-with-fees",
      total_value_true_usd: 13,
      unclaimed_fees_true_usd: 10,
    }],
    solMode: false,
  });
  assert.equal(feeInclusiveValuation.open_lp_sol, 0.13);
  assert.equal(feeInclusiveValuation.unclaimed_fee_sol, 0.1);
  assert.equal(feeInclusiveValuation.equity_sol, 0.36,
    "claimable on-chain LP fees are canary equity and must not create a false drawdown");
  const cashAwareValuation = calculateCanaryEquitySol({
    wallet: {
      sol: 0.355697682,
      sol_price: 75.78,
      usdc: 16.073572,
      usdt: 0.655841,
      tokens: [
        { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", balance: 16.073572, usd_raw: 16.0700626 },
        { mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", balance: 0.655841, usd_raw: 0.6551458 },
      ],
    },
    positions: [],
    solMode: false,
  });
  assert.equal(cashAwareValuation.ok, true);
  assert.ok(cashAwareValuation.equity_sol > 0.57, "stablecoin cash must not look like a wallet drawdown");
  assert.ok(cashAwareValuation.equity_sol < 0.59);
  assert.equal(calculateCanaryEquitySol({
    wallet: { sol: 0.8, sol_price: 0 },
    positions: [{ position: "lp-unknown" }],
    solMode: false,
  }).ok, false);

  const events = [];
  const observed = await observeLiveCanaryEquity({
    wallet: { sol: 0.8, sol_price: 100 },
    positions: [{ position: "lp-1", total_value_true_usd: 20, unclaimed_fees_true_usd: 0 }],
    effectiveRolloutMode: "canary",
    dryRun: false,
    solMode: false,
    listPendingCleanups: () => [],
    atMs: 123,
    recordBreakerEvent: async (event) => { events.push(event); },
  });
  assert.equal(observed.observed, true);
  assert.deepEqual(events, [{ type: "canary_equity", equitySol: 1, atMs: 123 }]);

  const unavailableObservation = await observeLiveCanaryEquity({
    wallet: { sol: 0.8, sol_price: 0 },
    positions: [{ position: "lp-unknown" }],
    effectiveRolloutMode: "canary",
    dryRun: false,
    solMode: false,
    listPendingCleanups: () => [],
    atMs: 124,
    recordBreakerEvent: async (event) => { events.push(event); },
  });
  assert.equal(unavailableObservation.entryBlocked, true);
  assert.equal(unavailableObservation.transientError, true);
  assert.equal(events.length, 1, "provider uncertainty must not be persisted as a permanent loss latch");

  let dryRunWalletRead = false;
  let dryRunBreakerWrite = false;
  const skipped = await observeLiveCanaryEquity({
    positions: [],
    effectiveRolloutMode: "canary",
    dryRun: true,
    getWallet: async () => { dryRunWalletRead = true; throw new Error("must not be called"); },
    recordBreakerEvent: async () => { dryRunBreakerWrite = true; },
  });
  assert.equal(skipped.skipped, true);
  assert.equal(dryRunWalletRead, false);
  assert.equal(dryRunBreakerWrite, false);

  let idleWalletRead = false;
  let idleBreakerWrite = false;
  const idle = await observeLiveCanaryEquity({
    positions: [],
    effectiveRolloutMode: "canary",
    dryRun: false,
    hasCanaryExposure: false,
    listPendingCleanups: () => [],
    getWallet: async () => { idleWalletRead = true; throw new Error("must not be called"); },
    recordBreakerEvent: async () => { idleBreakerWrite = true; },
  });
  assert.equal(idle.reason, "NO_CANARY_EXPOSURE");
  assert.equal(idleWalletRead, false);
  assert.equal(idleBreakerWrite, false);

  const persistenceBlocked = await observeLiveCanaryEquity({
    wallet: { sol: 0.8, sol_price: 100 },
    positions: [],
    effectiveRolloutMode: "canary",
    dryRun: false,
    hasCanaryExposure: true,
    listPendingCleanups: () => [],
    recordBreakerEvent: async () => { throw new Error("retained breaker lock"); },
  });
  assert.equal(persistenceBlocked.persistenceError, true);
  assert.match(persistenceBlocked.error, /retained breaker lock/i);

  const cleanupEquityEvents = [];
  const cleanupExposureObserved = await observeLiveCanaryEquity({
    wallet: { wallet: "wallet-public-key", sol: 0.6091348369442029, sol_price: 100 },
    positions: [],
    effectiveRolloutMode: "canary",
    dryRun: false,
    hasCanaryExposure: false,
    listPendingCleanups: () => [{ lifecycle_id: "lp:Plumber", position: "Plumber" }],
    previewPendingCleanupEquityFn: async () => ({
      ok: true,
      total_sol: 0.034855871,
      total_lamports: "34855871",
      lifecycle_count: 1,
    }),
    recordBreakerEvent: async (event) => { cleanupEquityEvents.push(event); },
    atMs: 125,
  });
  assert.equal(cleanupExposureObserved.observed, true,
    "pending cleanup remains canary exposure even when the DLMM position is absent");
  assert.equal(cleanupEquityEvents[0].equitySol, 0.6439907079442029);

  const unpricedCleanupEvents = [];
  const unpricedCleanup = await observeLiveCanaryEquity({
    wallet: { wallet: "wallet-public-key", sol: 0.6091348369442029, sol_price: 100 },
    positions: [],
    effectiveRolloutMode: "canary",
    dryRun: false,
    hasCanaryExposure: false,
    listPendingCleanups: () => [{ lifecycle_id: "lp:Plumber", position: "Plumber" }],
    previewPendingCleanupEquityFn: async () => ({ ok: false, reason: "quote unavailable" }),
    recordBreakerEvent: async (event) => { unpricedCleanupEvents.push(event); },
  });
  assert.equal(unpricedCleanup.entryBlocked, true);
  assert.equal(unpricedCleanup.transientError, true);
  assert.equal(unpricedCleanupEvents.length, 0,
    "unpriced cleanup residue is transient uncertainty, never a persisted financial loss");

  // Management may read positions before observing canary equity, but a
  // breaker persistence failure is an immediate blocker: it must not dispatch
  // screening or reach any deploy-capable continuation afterward.
  let screeningDispatches = 0;
  const managementBlocked = await runManagementCycle({
    silent: true,
    dependencies: {
      isEffectiveDryRun: () => false,
      retryPendingLifecycleCleanups: async () => ({ success: true, attempted: 0, results: [] }),
      getMyPositions: async () => ({ positions: [], total_positions: 0 }),
      observeLiveCanaryEquity: async () => ({
        observed: false,
        persistenceError: true,
        error: "Could not record canary equity: retained breaker lock",
      }),
      runScreeningCycle: async () => { screeningDispatches += 1; },
      attemptAutomaticCircuitBreakerResume: async () => ({ resumed: false, blocked: "BREAKER_ALREADY_READY", skipped: true }),
    },
  });
  assert.match(managementBlocked, /Management blocked.*persistence uncertainty/i);
  assert.equal(screeningDispatches, 0, "persistence uncertainty must stop screening/deploy dispatch");

  const transientManagementBlocked = await runManagementCycle({
    silent: true,
    dependencies: {
      isEffectiveDryRun: () => false,
      retryPendingLifecycleCleanups: async () => ({ success: true, attempted: 0, results: [] }),
      getMyPositions: async () => ({ positions: [], total_positions: 0 }),
      observeLiveCanaryEquity: async () => ({
        observed: false,
        entryBlocked: true,
        transientError: true,
        error: "Canary equity is unavailable: provider timeout",
      }),
      runScreeningCycle: async () => { screeningDispatches += 1; },
      attemptAutomaticCircuitBreakerResume: async () => ({ resumed: false, blocked: "BREAKER_ALREADY_READY", skipped: true }),
    },
  });
  assert.match(transientManagementBlocked, /entry blocked for this cycle.*provider timeout/i);
  assert.equal(screeningDispatches, 0, "transient valuation failure must fail closed without dispatching entry");

  let cleanupRetryCalls = 0;
  const cleanupFailureDoesNotBlock = await runManagementCycle({
    silent: true,
    dependencies: {
      isEffectiveDryRun: () => false,
      retryPendingLifecycleCleanups: async () => {
        cleanupRetryCalls += 1;
        return { success: false, attempted: 1, settled: 0, failed: 1, results: [] };
      },
      getPositionCounts: () => ({ onChain: 0, tracked: 0, paper: 0, effective: 0, hasSettlingTracked: false }),
      getMyPositions: async () => ({ positions: [], total_positions: 0 }),
      observeLiveCanaryEquity: async () => ({ observed: false, skipped: true, reason: "NO_CANARY_EXPOSURE" }),
      runScreeningCycle: async () => { screeningDispatches += 1; },
      attemptAutomaticCircuitBreakerResume: async () => ({ resumed: false, blocked: "BREAKER_ALREADY_READY", skipped: true }),
    },
  });
  assert.equal(cleanupRetryCalls, 1);
  assert.match(cleanupFailureDoesNotBlock, /cleanup remains pending.*triggering screening/i);
  assert.equal(screeningDispatches, 1,
    "CLEANUP_PENDING retry failure must not suppress screening/deploy dispatch");

  // Every manual deploy helper checks the fresh paper-entry gate before it can
  // inspect candidates, query pool data, read a wallet, or invoke executeTool.
  // The temporary state file has no historical lifecycles, so each helper must
  // return the same actionable operator block rather than its normal lookup
  // error or an execution result.
  for (const attempt of [
    () => deployLatestCandidate(999),
    () => deployPoolAddress("11111111111111111111111111111111"),
    () => deployTokenAddress("11111111111111111111111111111111"),
  ]) {
    await assert.rejects(
      attempt,
      /Manual deployment blocked — historical replay coverage 0\/30: HISTORICAL_REPLAY_SOURCE_(?:REQUIRED|MISSING)/,
    );
  }

  console.log("index operator-boundary tests passed");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

// index.js imports the DLMM module, which owns cache-clearing intervals. Exit
// after isolated helper tests so no service, RPC, or production state path runs.
process.exit(0);
