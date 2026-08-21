import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-executor-canary-boundary-"));
process.env.MERIDIAN_USER_CONFIG_FILE = path.join(tmp, "user-config.json");
process.env.MERIDIAN_STATE_FILE = path.join(tmp, "state.json");
process.env.MERIDIAN_LESSONS_FILE = path.join(tmp, "lessons.json");
fs.writeFileSync(process.env.MERIDIAN_USER_CONFIG_FILE, JSON.stringify({
  dryRun: true,
  rolloutMode: "dry_run",
  ledgerPath: path.join(tmp, "trade-ledger.jsonl"),
}));

try {
  const { createCircuitBreakerController, createMemoryCircuitBreakerStorage } = await import("../circuit-breaker.js");
  const { TradeLedger } = await import("../trade-ledger.js");
  const {
    LifecycleOperationLeaseError,
    acquireLifecycleOperation,
    releaseLifecycleOperation,
  } = await import("../ledger-runtime.js");
  const {
    executeEconomicCleanup,
    registerCleanupExecutionCapability,
  } = await import("../cleanup-runtime.js");
  const {
    checkCanaryDeployBoundary,
    checkCanaryDeployOutcome,
    finalizeCanaryDeployOutcome,
    getLiveCanaryDeployGuardStatus,
    withCanaryDeployReservation,
    executeTool,
    executeConfirmedCleanup,
    registerAutomaticCleanupRetryCapability,
    retryPendingLifecycleCleanups,
    reconcileLiveCanaryDeployGuard,
    registerOperatorCanaryGuardCapability,
    registerOperatorCleanupCapability,
    applySuccessfulCloseLifecyclePostEffects,
    applyClaimLifecyclePostEffects,
    checkExecutableClaimAttribution,
    lifecycleReceiptTransactions,
    deployReceiptSignatures,
    finalizeLifecycleToolResult,
    CLEANUP_EXECUTION_CONFIRMATION,
    LIVE_CANARY_GUARD_RECONCILIATION_CONFIRMATION,
    isToolExecutionSuccess,
    isExecutedTransactionSuccess,
  } = await import("../tools/executor.js");
  const canaryGuardOperatorCapability = Object.freeze({});
  registerOperatorCanaryGuardCapability(canaryGuardOperatorCapability);
  const { claimFees } = await import("../tools/dlmm.js");
  const emptyLivePositions = { source: "rpc", total_positions: 0, positions: [] };
  const executorSource = fs.readFileSync(new URL("../tools/executor.js", import.meta.url), "utf8");
  assert.match(
    executorSource,
    /const configuredCandidatePolicy = candidatePolicyFromScreening\(config\.screening, \{[\s\S]*management: config\.management,[\s\S]*indicators: config\.indicators,[\s\S]*\}\);/,
    "fresh deploy preflight must derive the same momentum and economics policy as screening",
  );
  assert.match(
    executorSource,
    /\}, \{ nowMs: evaluatedAtMs \}, configuredCandidatePolicy\);/,
    "fresh deploy preflight must evaluate candidates with the configured policy rather than fixed defaults",
  );
  assert.match(
    executorSource,
    /Shadow is an exact simulation[\s\S]*canary: true,/,
    "shadow and live preflight sizing must both use the locked canary exposure",
  );
  assert.doesNotMatch(
    executorSource,
    /canary: config\.rollout\.mode !== "adaptive"/,
    "dry_run must not be misclassified as a live canary sizing request",
  );
  const breakerCall = executorSource.indexOf("const breakerCheck = await checkDeployCircuitBreaker();");
  const canaryCall = executorSource.indexOf("return withCanaryDeployReservation({");
  assert.ok(
    breakerCall >= 0 && canaryCall > breakerCall && executorSource.includes("checkEntry: checkDeployCircuitBreaker") && executorSource.includes("executeWithDurableLifecycleOperation"),
    "executeTool must check the breaker before waiting and again inside the canary reservation",
  );

  let deployImplementationCalls = 0;
  const replayBlocked = await executeTool("deploy_position", { pool_address: "blocked-pool" }, {
    toolMap: {
      deploy_position: async () => {
        deployImplementationCalls += 1;
        return { success: true };
      },
    },
    getPaperDeploymentGate: () => ({ pass: false, reason: "HISTORICAL_REPLAY_COVERAGE_BELOW_MINIMUM" }),
  });
  assert.equal(replayBlocked.blocked, true);
  assert.match(replayBlocked.reason, /HISTORICAL_REPLAY/);
  assert.equal(deployImplementationCalls, 0, "raw replay paper gate must run before any deploy implementation");

  let lookupOptions = null;
  const accepted = await checkCanaryDeployBoundary({
    args: { amount_y: 0.20 },
    effectiveRolloutMode: "canary",
    listLivePositions: async (options) => {
      lookupOptions = options;
      return emptyLivePositions;
    },
  });
  assert.equal(accepted.pass, true);
  assert.equal(accepted.amount_sol, 0.20);
  assert.equal(accepted.live_position_count, 0);
  assert.deepEqual(lookupOptions, { force: true, silent: true });

  for (const amount of [0.199999999, 0.200000001]) {
    let invalidAmountLookupCalled = false;
    const invalidAmount = await checkCanaryDeployBoundary({
      args: { amount_y: amount },
      effectiveRolloutMode: "canary",
      listLivePositions: async () => {
        invalidAmountLookupCalled = true;
        return emptyLivePositions;
      },
    });
    assert.equal(invalidAmount.pass, false);
    assert.match(invalidAmount.reason, /must equal exactly 0\.2 SOL/);
    assert.equal(invalidAmountLookupCalled, false, "a non-exact amount must not reach an RPC lookup");
  }

  const conflictingAliases = await checkCanaryDeployBoundary({
    args: { amount_y: 0.20, amount_sol: 0.21 },
    effectiveRolloutMode: "canary",
    listLivePositions: async () => {
      throw new Error("must not run when either requested alias is not exact");
    },
  });
  assert.equal(conflictingAliases.pass, false);
  assert.match(conflictingAliases.reason, /must equal exactly 0\.2 SOL/);

  const exactAliases = await checkCanaryDeployBoundary({
    args: { amount_y: 0.20, amount_sol: 0.20 },
    effectiveRolloutMode: "canary",
    listLivePositions: async () => {
      return emptyLivePositions;
    },
  });
  assert.equal(exactAliases.pass, true);

  let exceededLookupCalled = false;
  const exceeded = await checkCanaryDeployBoundary({
    args: { amount_y: 0.200000001 },
    effectiveRolloutMode: "canary",
    listLivePositions: async () => {
      exceededLookupCalled = true;
      return emptyLivePositions;
    },
  });
  assert.equal(exceeded.pass, false);
  assert.match(exceeded.reason, /must equal exactly 0\.2 SOL/);
  assert.equal(exceededLookupCalled, false, "an above-exact amount must not reach an RPC lookup");

  const existingPosition = await checkCanaryDeployBoundary({
    args: { amount_sol: 0.20 },
    effectiveRolloutMode: "canary",
    listLivePositions: async () => ({
      source: "meteora",
      total_positions: 1,
      positions: [{ position: "on-chain-position" }],
    }),
  });
  assert.equal(existingPosition.pass, false);
  assert.match(existingPosition.reason, /live-position limit \(1\) reached/);

  const countFailure = await checkCanaryDeployBoundary({
    args: { amount_y: 0.20 },
    effectiveRolloutMode: "canary",
    listLivePositions: async () => {
      throw new Error("RPC unavailable");
    },
  });
  assert.equal(countFailure.pass, false);
  assert.match(countFailure.reason, /Could not determine live on-chain position count/);

  let nonCanaryLookupCalled = false;
  const nonCanary = await checkCanaryDeployBoundary({
    args: { amount_y: 5 },
    effectiveRolloutMode: "dry_run",
    listLivePositions: async () => {
      nonCanaryLookupCalled = true;
      throw new Error("must not run outside canary");
    },
  });
  assert.deepEqual(nonCanary, { pass: true, applied: false });
  assert.equal(nonCanaryLookupCalled, false);

  // The reservation starts before the live-position check and stays held until
  // the first deploy path completes, so a second concurrent request rechecks
  // after the first has consumed the one available slot.
  let deployed = false;
  let boundaryChecks = 0;
  let runCount = 0;
  let releaseFirst;
  let firstEntered;
  const firstEnteredPromise = new Promise((resolve) => { firstEntered = resolve; });
  const first = withCanaryDeployReservation({
    effectiveRolloutMode: "canary",
    dryRun: false,
    checkBoundary: async () => {
      boundaryChecks += 1;
      return deployed ? { pass: false, reason: "slot already occupied" } : { pass: true };
    },
    run: async () => {
      runCount += 1;
      firstEntered();
      await new Promise((resolve) => { releaseFirst = resolve; });
      deployed = true;
      return { success: true, position: "first" };
    },
  });
  await firstEnteredPromise;
  const second = withCanaryDeployReservation({
    effectiveRolloutMode: "canary",
    dryRun: false,
    checkBoundary: async () => {
      boundaryChecks += 1;
      return deployed ? { pass: false, reason: "slot already occupied" } : { pass: true };
    },
    run: async () => {
      runCount += 1;
      return { success: true, position: "second" };
    },
  });
  releaseFirst();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.success, true);
  assert.equal(secondResult.blocked, true);
  assert.equal(runCount, 1);
  assert.equal(boundaryChecks, 2);

  // A submitted canary is not complete while its position is absent from a
  // fresh enumeration. The resulting durable breaker latch must block a
  // queued request even though that request passed the earlier outer check.
  const breaker = createCircuitBreakerController({
    storage: createMemoryCircuitBreakerStorage(),
    now: () => 1_000,
  });
  const breakerEntry = async () => (await breaker.entryAllowed())
    ? { pass: true }
    : { pass: false, reason: "manual resume required" };
  let laggingRunCount = 0;
  let laggingBoundaryChecks = 0;
  let releaseLaggingFirst;
  let laggingFirstEntered;
  const laggingFirstEnteredPromise = new Promise((resolve) => { laggingFirstEntered = resolve; });
  const laggingFirst = withCanaryDeployReservation({
    effectiveRolloutMode: "canary",
    dryRun: false,
    checkEntry: breakerEntry,
    checkBoundary: async () => {
      laggingBoundaryChecks += 1;
      return { pass: true, applied: true };
    },
    run: async () => {
      laggingRunCount += 1;
      laggingFirstEntered();
      await new Promise((resolve) => { releaseLaggingFirst = resolve; });
      return finalizeCanaryDeployOutcome({
        result: { success: true, position: "lagging-position", txs: ["submitted-signature"] },
        listLivePositions: async () => emptyLivePositions,
        recordBreakerEvent: (event) => breaker.record(event),
      });
    },
  });
  await laggingFirstEnteredPromise;
  const queuedAfterLag = withCanaryDeployReservation({
    effectiveRolloutMode: "canary",
    dryRun: false,
    checkEntry: breakerEntry,
    checkBoundary: async () => {
      laggingBoundaryChecks += 1;
      return { pass: true, applied: true };
    },
    run: async () => {
      laggingRunCount += 1;
      return { success: true, position: "must-not-deploy", txs: ["must-not-submit"] };
    },
  });
  releaseLaggingFirst();
  const [laggingFirstResult, queuedAfterLagResult] = await Promise.all([laggingFirst, queuedAfterLag]);
  assert.equal(laggingFirstResult.success, false);
  assert.equal(laggingFirstResult.blocked, true);
  assert.equal(laggingFirstResult.reconciliation_required, true);
  assert.equal(await breaker.entryAllowed(), false, "a lagging live enumeration must latch the durable breaker");
  assert.equal(queuedAfterLagResult.blocked, true);
  assert.match(queuedAfterLagResult.reason, /manual resume required/);
  assert.equal(laggingRunCount, 1);
  assert.equal(laggingBoundaryChecks, 1, "the queued request must stop at the in-reservation breaker recheck");
  await breaker.manualResume(2_000);
  assert.equal(await breaker.entryAllowed(), true, "only manual resume may clear the durable deploy block");

  // Signatures alone never count as a live deploy. They must latch the same
  // durable/manual-resume block without attempting a position enumeration.
  const relayBreaker = createCircuitBreakerController({
    storage: createMemoryCircuitBreakerStorage(),
    now: () => 3_000,
  });
  let relayLookupCalled = false;
  const submittedButUnverified = await finalizeCanaryDeployOutcome({
    result: {
      success: false,
      relay: true,
      reconciliation_required: true,
      txs: ["relay-submitted-signature"],
    },
    listLivePositions: async () => {
      relayLookupCalled = true;
      return emptyLivePositions;
    },
    recordBreakerEvent: (event) => relayBreaker.record(event),
  });
  assert.equal(submittedButUnverified.success, false);
  assert.equal(submittedButUnverified.blocked, true);
  assert.equal(submittedButUnverified.reconciliation_required, true);
  assert.match(submittedButUnverified.reason, /Relay submission returned transaction signatures but no verified position/);
  assert.equal(relayLookupCalled, false);
  assert.equal(await relayBreaker.entryAllowed(), false);
  await relayBreaker.manualResume(4_000);
  assert.equal(await relayBreaker.entryAllowed(), true);

  // If the breaker itself cannot persist an anomaly, the global live-canary
  // lease becomes the restart-safe deploy block. It is pool-independent and
  // cannot be auto-unlinked by the wrapper's finally path. Reconciliation is
  // intentionally an explicit operator flow; these fixtures never raw-unlink
  // a retained lease.
  const guardLedger = new TradeLedger({
    filePath: path.join(tmp, "canary-guard-ledger.jsonl"),
    durable: false,
  });
  async function createRetainedGlobalCanaryGuard(label) {
    const directory = path.join(tmp, `${label}-operations`);
    const guard = acquireLifecycleOperation({
      operation: "deploy",
      operationKey: "global:live-canary-deploy",
      store: guardLedger,
      directory,
      durable: false,
    });
    const breakerWriteFailed = await finalizeCanaryDeployOutcome({
      result: { success: true, position: `unverified-${label}`, txs: [`submitted-${label}`] },
      listLivePositions: async () => emptyLivePositions,
      recordBreakerEvent: async () => { throw new Error(`injected durable breaker write failure (${label})`); },
      canaryGuard: guard,
    });
    assert.equal(breakerWriteFailed.success, false);
    assert.equal(breakerWriteFailed.durable_deploy_block_persisted, true);
    assert.equal(releaseLifecycleOperation(guard).retained, true);
    return { directory, operationId: guard.operation_id, checkpointFile: guard.checkpoint_file };
  }

  const globalGuard = await createRetainedGlobalCanaryGuard("canary-guard-success");
  const retainedStatus = getLiveCanaryDeployGuardStatus({ dependencies: {
    store: guardLedger,
    directory: globalGuard.directory,
  } });
  assert.equal(retainedStatus.held, true);
  assert.equal(retainedStatus.operation_id, globalGuard.operationId);
  assert.equal(retainedStatus.retention_evidence, 1, "retention rationale must be durable before resolution");
  assert.throws(() => acquireLifecycleOperation({
    operation: "deploy",
    operationKey: "global:live-canary-deploy",
    store: guardLedger,
    directory: globalGuard.directory,
  }), (error) => error instanceof LifecycleOperationLeaseError && error.code === "LIFECYCLE_OPERATION_LEASE_HELD",
  "a restart or a later deploy for another pool sees the retained global canary block");
  const independentlyResumedBreaker = createCircuitBreakerController({
    storage: createMemoryCircuitBreakerStorage(),
    now: () => 5_000,
  });
  await independentlyResumedBreaker.manualResume(5_001);
  assert.equal(await independentlyResumedBreaker.entryAllowed(), true);
  assert.equal(getLiveCanaryDeployGuardStatus({ dependencies: {
    store: guardLedger,
    directory: globalGuard.directory,
  } }).held, true, "breaker resume never auto-releases the independently retained global guard");

  const unauthorizedGuardRelease = await reconcileLiveCanaryDeployGuard({
    guardOperationId: globalGuard.operationId,
    confirmation: LIVE_CANARY_GUARD_RECONCILIATION_CONFIRMATION,
    operatorCapability: Object.freeze({}),
    dependencies: { store: guardLedger, directory: globalGuard.directory, durable: false },
  });
  assert.equal(unauthorizedGuardRelease.blocked, true, "only the registered operator capability may release a retained guard");

  const wrongIdentity = await reconcileLiveCanaryDeployGuard({
    guardOperationId: "wrong-retained-guard-id",
    confirmation: LIVE_CANARY_GUARD_RECONCILIATION_CONFIRMATION,
    operatorCapability: canaryGuardOperatorCapability,
    dependencies: { store: guardLedger, directory: globalGuard.directory, durable: false },
  });
  assert.equal(wrongIdentity.blocked, true);
  assert.equal(wrongIdentity.code, "LIFECYCLE_OPERATION_GUARD_IDENTITY_MISMATCH");

  const ambiguousOutcome = await reconcileLiveCanaryDeployGuard({
    guardOperationId: globalGuard.operationId,
    confirmation: LIVE_CANARY_GUARD_RECONCILIATION_CONFIRMATION,
    operatorCapability: canaryGuardOperatorCapability,
    dependencies: {
      store: guardLedger,
      directory: globalGuard.directory,
      durable: false,
      listLivePositions: async () => ({ source: "meteora", total_positions: 0, positions: [] }),
      recordCircuitBreakerEvent: async () => { throw new Error("must not persist breaker for ambiguous outcome"); },
    },
  });
  assert.equal(ambiguousOutcome.blocked, true);
  assert.equal(ambiguousOutcome.code, "LIFECYCLE_OPERATION_GUARD_OUTCOME_UNRESOLVED");

  const unresolvedOutcome = await reconcileLiveCanaryDeployGuard({
    guardOperationId: globalGuard.operationId,
    confirmation: LIVE_CANARY_GUARD_RECONCILIATION_CONFIRMATION,
    operatorCapability: canaryGuardOperatorCapability,
    dependencies: {
      store: guardLedger,
      directory: globalGuard.directory,
      durable: false,
      listLivePositions: async () => ({ source: "rpc", total_positions: 1, positions: [{ position: "unresolved-on-chain" }] }),
      recordCircuitBreakerEvent: async () => { throw new Error("must not persist breaker for unresolved outcome"); },
    },
  });
  assert.equal(unresolvedOutcome.blocked, true);
  assert.equal(unresolvedOutcome.code, "LIFECYCLE_OPERATION_GUARD_OUTCOME_UNRESOLVED");

  const guardReleaseEvents = [];
  const successfulGuardRelease = await reconcileLiveCanaryDeployGuard({
    guardOperationId: globalGuard.operationId,
    confirmation: LIVE_CANARY_GUARD_RECONCILIATION_CONFIRMATION,
    operatorCapability: canaryGuardOperatorCapability,
    dependencies: {
      store: guardLedger,
      directory: globalGuard.directory,
      durable: false,
      now: () => new Date("2026-07-24T00:00:01.000Z"),
      observedAt: () => new Date("2026-07-24T00:00:00.000Z"),
      listLivePositions: async () => emptyLivePositions,
      recordCircuitBreakerEvent: async (event) => { guardReleaseEvents.push(event); },
    },
  });
  assert.equal(successfulGuardRelease.success, true);
  assert.equal(guardReleaseEvents.length, 1, "breaker reconciliation event must persist before guard removal");
  assert.equal(guardReleaseEvents[0].type, "canary_guard_reconciled");
  const successJournal = fs.readFileSync(globalGuard.checkpointFile, "utf8");
  assert.match(successJournal, /"type":"guard_reconciliation_resolved"/,
    "an append-only durable resolution event precedes secure lease removal");
  const successorGlobalGuard = acquireLifecycleOperation({
    operation: "deploy",
    operationKey: "global:live-canary-deploy",
    store: guardLedger,
    directory: globalGuard.directory,
    durable: false,
  });
  releaseLifecycleOperation(successorGlobalGuard);

  const breakerPersistenceGuard = await createRetainedGlobalCanaryGuard("canary-guard-breaker-failure");
  const breakerPersistenceFailure = await reconcileLiveCanaryDeployGuard({
    guardOperationId: breakerPersistenceGuard.operationId,
    confirmation: LIVE_CANARY_GUARD_RECONCILIATION_CONFIRMATION,
    operatorCapability: canaryGuardOperatorCapability,
    dependencies: {
      store: guardLedger,
      directory: breakerPersistenceGuard.directory,
      durable: false,
      listLivePositions: async () => emptyLivePositions,
      recordCircuitBreakerEvent: async () => { throw new Error("injected reconciliation breaker persistence failure"); },
    },
  });
  assert.equal(breakerPersistenceFailure.code, "LIFECYCLE_OPERATION_GUARD_BREAKER_PERSISTENCE_FAILED");
  assert.throws(() => acquireLifecycleOperation({
    operation: "deploy",
    operationKey: "global:live-canary-deploy",
    store: guardLedger,
    directory: breakerPersistenceGuard.directory,
  }), /already leased/i, "breaker persistence failure retains the global deploy guard");

  const journalFailureGuard = await createRetainedGlobalCanaryGuard("canary-guard-journal-failure");
  const journalFailingFs = Object.assign(Object.create(fs), {
    writeSync(descriptor, buffer, offset, length, position) {
      const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer));
      if (bytes.toString("utf8").includes("\"type\":\"guard_reconciliation_resolved\"")) {
        const error = new Error("injected guard reconciliation journal failure");
        error.code = "EIO";
        throw error;
      }
      return fs.writeSync(descriptor, buffer, offset, length, position);
    },
  });
  const journalWriteFailure = await reconcileLiveCanaryDeployGuard({
    guardOperationId: journalFailureGuard.operationId,
    confirmation: LIVE_CANARY_GUARD_RECONCILIATION_CONFIRMATION,
    operatorCapability: canaryGuardOperatorCapability,
    dependencies: {
      store: guardLedger,
      directory: journalFailureGuard.directory,
      fsImpl: journalFailingFs,
      durable: false,
      listLivePositions: async () => emptyLivePositions,
      recordCircuitBreakerEvent: async () => {},
    },
  });
  assert.equal(journalWriteFailure.code, "LIFECYCLE_OPERATION_GUARD_RECONCILIATION_PERSISTENCE_FAILED");
  assert.throws(() => acquireLifecycleOperation({
    operation: "deploy",
    operationKey: "global:live-canary-deploy",
    store: guardLedger,
    directory: journalFailureGuard.directory,
  }), /already leased/i, "journal write failure retains the global deploy guard");

  const removeFailureGuard = await createRetainedGlobalCanaryGuard("canary-guard-remove-failure");
  const removeFailingFs = Object.assign(Object.create(fs), {
    unlinkSync(file) {
      if (String(file).endsWith(".lease")) {
        // Model the harder case: unlink reached the kernel but the secure
        // remover still reports failure (for example, parent fsync failure).
        // The resolver must recreate the exact poison lease before returning.
        fs.unlinkSync(file);
        const error = new Error("injected secure guard removal failure");
        error.code = "EIO";
        throw error;
      }
      return fs.unlinkSync(file);
    },
  });
  const secureRemoveFailure = await reconcileLiveCanaryDeployGuard({
    guardOperationId: removeFailureGuard.operationId,
    confirmation: LIVE_CANARY_GUARD_RECONCILIATION_CONFIRMATION,
    operatorCapability: canaryGuardOperatorCapability,
    dependencies: {
      store: guardLedger,
      directory: removeFailureGuard.directory,
      fsImpl: removeFailingFs,
      durable: false,
      listLivePositions: async () => emptyLivePositions,
      recordCircuitBreakerEvent: async () => {},
    },
  });
  assert.equal(secureRemoveFailure.code, "LIFECYCLE_OPERATION_GUARD_SECURE_REMOVE_FAILED");
  assert.throws(() => acquireLifecycleOperation({
    operation: "deploy",
    operationKey: "global:live-canary-deploy",
    store: guardLedger,
    directory: removeFailureGuard.directory,
  }), /already leased/i, "secure removal failure retains the global deploy guard after its audit event");

  const verifiedOutcome = await checkCanaryDeployOutcome({
    result: { success: true, position: "verified-position", txs: ["verified-signature"] },
    listLivePositions: async () => ({
      source: "rpc",
      total_positions: 1,
      positions: [{ position: "verified-position" }],
    }),
  });
  assert.equal(verifiedOutcome.pass, true);
  assert.equal(verifiedOutcome.visibility_attempts, 1);
  let delayedVisibilityReads = 0;
  let delayedVisibilityWaits = 0;
  const delayedVisibility = await checkCanaryDeployOutcome({
    result: { success: true, position: "delayed-position", txs: ["delayed-signature"] },
    attempts: 3,
    retryDelayMs: 0,
    wait: async () => { delayedVisibilityWaits += 1; },
    listLivePositions: async () => {
      delayedVisibilityReads += 1;
      return delayedVisibilityReads < 3
        ? emptyLivePositions
        : { source: "rpc", total_positions: 1, positions: [{ position: "delayed-position" }] };
    },
  });
  assert.equal(delayedVisibility.pass, true, "normal RPC indexing lag must be retried while the canary reservation is held");
  assert.equal(delayedVisibility.visibility_attempts, 3);
  assert.equal(delayedVisibilityReads, 3);
  assert.equal(delayedVisibilityWaits, 2);
  let exhaustedVisibilityReads = 0;
  const exhaustedVisibility = await checkCanaryDeployOutcome({
    result: { success: true, position: "still-lagging-position", txs: ["still-lagging-signature"] },
    attempts: 2,
    retryDelayMs: 0,
    wait: async () => {},
    listLivePositions: async () => {
      exhaustedVisibilityReads += 1;
      return emptyLivePositions;
    },
  });
  assert.equal(exhaustedVisibility.pass, false);
  assert.equal(exhaustedVisibilityReads, 2);
  assert.match(exhaustedVisibility.reason, /Retried 2 authoritative read\(s\)/);
  assert.equal(isToolExecutionSuccess("deploy_position", undefined), false);
  assert.equal(isToolExecutionSuccess("deploy_position", { success: true, position: "ambiguous-position" }), false);

  // Deploy finalization owns the authoritative deploy receipt path. A success
  // reaches the injectable recorder with the concrete position, receipts, and
  // basis-confirmation permission; retries remain recorder-owned/idempotent.
  const successfulDeploy = {
    success: true,
    position: "ledger-recorded-deploy",
    pool: "ledger-recorded-pool",
    amount_y: 0.1,
    txs: ["ledger-recorded-signature", "ledger-recorded-signature"],
  };
  const deployRecorderInputs = [];
  await finalizeLifecycleToolResult({
    name: "deploy_position",
    result: successfulDeploy,
    args: { pool_address: "ignored-pool", amount_y: 0.1 },
    dependencies: {
      getWalletPublicKey: () => "wallet-public-key",
      recordDeployLifecycle: async (input) => {
        deployRecorderInputs.push(input);
        return { state: "ACTIVE", lifecycle_id: "lp:ledger-recorded-deploy" };
      },
    },
  });
  assert.equal(deployRecorderInputs.length, 1);
  assert.deepEqual(deployRecorderInputs[0], {
    position: "ledger-recorded-deploy",
    pool: "ledger-recorded-pool",
    amountSol: 0.1,
    layers: [],
    txs: ["ledger-recorded-signature"],
    walletAddress: "wallet-public-key",
    metadata: { relay: false, result_reconciliation_required: false },
    allowActivation: true,
  });
  assert.equal(successfulDeploy.ledger.state, "ACTIVE");

  const failedSubmittedDeploy = {
    success: false,
    blocked: true,
    reconciliation_required: true,
    position: "failed-ledger-deploy",
    pool: "failed-ledger-pool",
    amount_y: 0.1,
    txs: ["failed-ledger-signature"],
  };
  let failedDeployRecorderInput = null;
  await finalizeLifecycleToolResult({
    name: "deploy_position",
    result: failedSubmittedDeploy,
    dependencies: {
      getWalletPublicKey: () => "wallet-public-key",
      recordDeployLifecycle: async (input) => {
        failedDeployRecorderInput = input;
        return { state: "RECONCILIATION_REQUIRED", reconciliation_latched: true, lifecycle_id: "lp:failed-ledger-deploy" };
      },
    },
  });
  assert.equal(failedDeployRecorderInput.allowActivation, false, "submitted but unresolved deploys record receipts without activation permission");
  assert.equal(failedSubmittedDeploy.success, false);
  assert.equal(failedSubmittedDeploy.reconciliation_required, true);
  assert.equal(failedSubmittedDeploy.ledger.state, "RECONCILIATION_REQUIRED");

  // Deploy receipts have a deliberately narrow result contract. A singular
  // submitted `tx` is authoritative, deduplicates with `txs`, and records in
  // non-activating mode when the result is unresolved; unrelated strings are
  // never promoted to receipts.
  assert.deepEqual(deployReceiptSignatures({
    txs: ["array-deploy-signature", "array-deploy-signature"],
    tx: "singular-deploy-signature",
    signature: "unrelated-signature-field",
    request_id: "unrelated-request-id",
    error: "unrelated error string",
  }), ["array-deploy-signature", "singular-deploy-signature"]);
  const singularSubmittedDeploy = {
    success: false,
    blocked: true,
    reconciliation_required: true,
    position: "singular-ledger-deploy",
    pool: "singular-ledger-pool",
    amount_y: 0.1,
    tx: "singular-deploy-signature",
    deploy_receipt_provenance: [{
      signature: "singular-deploy-signature",
      kind: "liquidity",
      layer_id: "single",
    }],
  };
  let singularRecorderInput = null;
  await finalizeLifecycleToolResult({
    name: "deploy_position",
    result: singularSubmittedDeploy,
    dependencies: {
      getWalletPublicKey: () => "wallet-public-key",
      recordDeployLifecycle: async (input) => {
        singularRecorderInput = input;
        return { state: "RECONCILIATION_REQUIRED", reconciliation_latched: true, lifecycle_id: "lp:singular-ledger-deploy" };
      },
    },
  });
  assert.deepEqual(singularRecorderInput.txs, ["singular-deploy-signature"]);
  assert.equal(singularRecorderInput.allowActivation, false);
  assert.deepEqual(singularRecorderInput.receiptProvenance, singularSubmittedDeploy.deploy_receipt_provenance);
  assert.equal(singularSubmittedDeploy.reconciliation_required, true);

  const unattributedSubmittedDeploy = {
    success: false,
    blocked: true,
    reconciliation_required: true,
    txs: ["unattributed-deploy-signature"],
  };
  let unattributedRecorderCalls = 0;
  await finalizeLifecycleToolResult({
    name: "deploy_position",
    result: unattributedSubmittedDeploy,
    dependencies: {
      recordDeployLifecycle: async () => { unattributedRecorderCalls += 1; },
    },
  });
  assert.equal(unattributedRecorderCalls, 0, "a receipt without a position identity is never fabricated into a lifecycle");
  assert.match(unattributedSubmittedDeploy.reason, /no authoritative position identity.*cannot be ledger-attributed/i);
  assert.equal(unattributedSubmittedDeploy.reconciliation_required, true);

  const noPositionSingularDeploy = {
    success: false,
    blocked: true,
    reconciliation_required: true,
    tx: "unattributed-singular-deploy-signature",
  };
  let noPositionSingularRecorderCalls = 0;
  await finalizeLifecycleToolResult({
    name: "deploy_position",
    result: noPositionSingularDeploy,
    dependencies: {
      recordDeployLifecycle: async () => { noPositionSingularRecorderCalls += 1; },
    },
  });
  assert.equal(noPositionSingularRecorderCalls, 0, "a singular receipt without a position stays blocked and unattributed");
  assert.equal(noPositionSingularDeploy.reconciliation_required, true);

  // An exception cannot strand the reservation and block later canary work.
  await assert.rejects(withCanaryDeployReservation({
    effectiveRolloutMode: "canary",
    dryRun: false,
    checkBoundary: async () => ({ pass: true }),
    run: async () => { throw new Error("injected deploy failure"); },
  }), /injected deploy failure/);
  let ranAfterFailure = false;
  await withCanaryDeployReservation({
    effectiveRolloutMode: "canary",
    dryRun: false,
    checkBoundary: async () => ({ pass: true }),
    run: async () => { ranAfterFailure = true; return { success: true }; },
  });
  assert.equal(ranAfterFailure, true);

  // A successful close records receipts and then invokes only the private,
  // lifecycle-scoped automatic cleanup boundary.
  const successfulClose = {
    success: true,
    position: "closed-position",
    base_mint: "shared-mint",
    wallet_sol_before_deploy: 0.5,
    close_txs: ["close-signature"],
    claim_txs: ["claim-signature"],
  };
  let closeLifecycleInput = null;
  let automaticCleanupInput = null;
  await applySuccessfulCloseLifecyclePostEffects({
    result: successfulClose,
    args: { position_address: "closed-position", reason: "manual /close" },
    dependencies: {
      getWalletPublicKey: () => "wallet-public-key",
      recordLifecycleTransactions: async (input) => {
        closeLifecycleInput = input;
        return { state: "CLOSING", lifecycle_id: "lp:closed-position" };
      },
      markCleanupPending: (position) => ({ state: "CLEANUP_PENDING", position }),
      executeAutomaticPostCloseCleanup: async (input) => {
        automaticCleanupInput = input;
        return {
          success: true,
          finalization: {
            lifecycle: {
              state: "SETTLED",
              cost_basis: { usable_basis_lamports: "200000000" },
            },
            settlement: { wallet_equity_net_lamports: "-10000000" },
          },
        };
      },
      recordCloseSolMetrics: () => true,
    },
  });
  assert.equal(successfulClose.cleanup_pending, false);
  assert.match(successfulClose.cleanup_note, /converted to SOL.*settled/i);
  assert.equal(successfulClose.pnl_sol, -0.01);
  assert.equal(successfulClose.pnl_pct, -5);
  assert.equal(successfulClose.position_sol_final, 0.19);
  assert.equal(successfulClose.wallet_sol_after_cleanup, 0.49);
  assert.equal(successfulClose.wallet_sol_roundtrip_delta_after_cleanup, -0.01);
  assert.equal(successfulClose.settlement_pnl_source, "trade_ledger_wallet_equity_net");
  assert.deepEqual(automaticCleanupInput, { position: "closed-position", dependencies: null });
  assert.deepEqual(closeLifecycleInput, {
    position: "closed-position",
    walletAddress: "wallet-public-key",
    transactions: [
      { signature: "close-signature", phase: "close" },
      { signature: "claim-signature", phase: "claim" },
    ],
  }, "a successful close records only close/claim receipts, never a mint-wide swap receipt");
  assert.equal(Object.hasOwn(successfulClose, "auto_swap_tx"), false);
  assert.doesNotMatch(applySuccessfulCloseLifecyclePostEffects.toString(), /swapToken|getWalletBalances/,
    "the successful-close wrapper never reads or swaps a mint-wide wallet balance");

  // A live claim is blocked before submission when it cannot be attached to
  // an authoritative lifecycle. Confirmed claim receipts are phase-bound and
  // remain pending for scoped cleanup, never a mint-wide autoswap.
  const previousDryRun = process.env.DRY_RUN;
  process.env.DRY_RUN = "false";
  try {
    const exportedClaimRejected = await claimFees({ position_address: "11111111111111111111111111111111" });
    assert.equal(exportedClaimRejected.dry_run, true, "mutating process.env cannot turn the imported dry-run authority live");
  } finally {
    process.env.DRY_RUN = previousDryRun;
  }
  const untrackedClaim = checkExecutableClaimAttribution({
    position: "untracked-position",
    getAttribution: () => ({ pass: false, reason: "No authoritative lifecycle exists" }),
  });
  assert.equal(untrackedClaim.pass, false);
  assert.match(untrackedClaim.reason, /No authoritative lifecycle/);
  const claimAttributionAt = executorSource.indexOf("const attribution = checkExecutableClaimAttribution({ position: workingArgs.position_address });");
  const claimExecutionAt = executorSource.indexOf("const result = recoveredResult?.reconciliation_required === true");
  assert.ok(
    claimAttributionAt >= 0 && claimAttributionAt < claimExecutionAt,
    "claim lifecycle attribution must be checked before the executable tool function",
  );

  const claimResult = {
    success: true,
    position: "claimed-position",
    claim_txs: ["claim-signature", "claim-signature"],
    txs: ["claim-signature"],
    base_mint: "shared-mint",
  };
  let claimLifecycleInput = null;
  await applyClaimLifecyclePostEffects({
    result: claimResult,
    dependencies: {
      getWalletPublicKey: () => "wallet-public-key",
      recordLifecycleTransactions: async (input) => {
        claimLifecycleInput = input;
        return { state: "ACTIVE", lifecycle_id: "lp:claimed-position" };
      },
    },
  });
  assert.deepEqual(claimLifecycleInput, {
    position: "claimed-position",
    walletAddress: "wallet-public-key",
    transactions: [{ signature: "claim-signature", phase: "claim" }],
  });
  assert.equal(claimResult.cleanup_pending, true);
  assert.match(claimResult.cleanup_note, /no wallet-wide swap/i);
  assert.deepEqual(lifecycleReceiptTransactions("claim_fees", {
    position: "claimed-position",
    claim_txs: [],
    txs: ["fallback-claim-signature"],
  }), [{ signature: "fallback-claim-signature", phase: "claim" }]);
  assert.doesNotMatch(
    applyClaimLifecyclePostEffects.toString(),
    /swapBaseToSolWithRetry|swapToken|getWalletBalances/,
    "claim post-effects must not aggregate or swap wallet balances",
  );
  assert.doesNotMatch(
    executorSource,
    /claim_fees" && config\.management\.autoSwapAfterClaim|swapBaseToSolWithRetry/,
    "the executor must have no automatic post-claim aggregate swap path",
  );

  // Finalization is before breaker success. A late cleanup-pending transition
  // failure turns the completed SDK result into a reconciliation-required
  // failure and emits only an operation failure.
  const priorDryRunForLateEffect = process.env.DRY_RUN;
  const lateBreakerEvents = [];
  let lateCloseCalls = 0;
  process.env.DRY_RUN = "false";
  try {
    const latePostEffect = await executeTool("close_position", { position_address: "late-close-position" }, {
      toolMap: {
        close_position: async () => {
          lateCloseCalls += 1;
          return {
            success: true,
            position: "late-close-position",
            close_txs: ["late-close-signature"],
            txs: ["late-close-signature"],
          };
        },
      },
      beginCloseLifecycle: async () => ({ state: "CLOSING" }),
      getWalletPublicKey: () => "wallet-public-key",
      recordLifecycleTransactions: async () => ({ state: "CLOSING" }),
      markCleanupPending: () => { throw new Error("injected cleanup-pending failure"); },
      recordCircuitBreakerEvent: async (event) => { lateBreakerEvents.push(event); },
    });
    assert.equal(lateCloseCalls, 1);
    assert.equal(latePostEffect.success, false);
    assert.equal(latePostEffect.reconciliation_required, true);
    assert.match(latePostEffect.accounting_error, /cleanup-pending failure/);
    assert.deepEqual(lateBreakerEvents.map((event) => event.type), [], "a dry-run process must not emit a breaker effect after env mutation");
  } finally {
    process.env.DRY_RUN = priorDryRunForLateEffect;
  }

  // An LLM tool call cannot manufacture cleanup authority from JSON. The
  // confirmed wrapper additionally requires the Telegram-held object identity.
  const modelExecution = await executeTool("reconcile_cleanup", { position: "test-position", execute: true });
  assert.equal(modelExecution.blocked, true);
  assert.match(
    executorSource,
    /reconcile_cleanup:\s*\(\{ position \}\) => executeEconomicCleanup\(\{ position, execute: false \}\)/,
    "the model-facing tool keeps capability-bearing arguments out of its call shape",
  );
  let cleanupInput = null;
  const rejectedConfirmation = await executeConfirmedCleanup({
    position: "test-position",
    confirmation: "not confirmed",
    cleanupExecutor: async (input) => { cleanupInput = input; return { success: true }; },
  });
  assert.equal(rejectedConfirmation.blocked, true);
  assert.equal(cleanupInput, null);
  const phraseOnly = await executeConfirmedCleanup({
    position: "test-position",
    confirmation: CLEANUP_EXECUTION_CONFIRMATION,
    cleanupExecutor: async (input) => { cleanupInput = input; return { success: true }; },
  });
  assert.equal(phraseOnly.blocked, true);
  assert.equal(cleanupInput, null);

  const telegramOperatorCapability = Object.freeze({});
  registerOperatorCleanupCapability(telegramOperatorCapability);
  registerOperatorCleanupCapability(telegramOperatorCapability);
  assert.throws(
    () => registerOperatorCleanupCapability(Object.freeze({})),
    /already registered and cannot be replaced/,
  );
  assert.throws(
    () => registerCleanupExecutionCapability(Object.freeze({})),
    /already registered and cannot be replaced/,
  );
  const wrongCapability = await executeConfirmedCleanup({
    position: "test-position",
    confirmation: CLEANUP_EXECUTION_CONFIRMATION,
    operatorCapability: Object.freeze({}),
    cleanupExecutor: async (input) => { cleanupInput = input; return { success: true }; },
  });
  assert.equal(wrongCapability.blocked, true);
  assert.equal(cleanupInput, null);

  const directRuntimeExecution = await executeEconomicCleanup({
    position: "test-position",
    execute: true,
    dependencies: {
      connection: { getParsedTokenAccountsByOwner: () => { throw new Error("must not scan before capability authorization"); } },
      getWalletBalances: () => { throw new Error("must not read balances before capability authorization"); },
    },
  });
  assert.equal(directRuntimeExecution.blocked, "CLEANUP_EXECUTION_CAPABILITY_REQUIRED");
  const wrongRuntimeCapability = await executeEconomicCleanup({
    position: "test-position",
    execute: true,
    executionCapability: Object.freeze({}),
  });
  assert.equal(wrongRuntimeCapability.blocked, "CLEANUP_EXECUTION_CAPABILITY_REQUIRED");

  let retryExecutions = [];
  const automaticRetryCapability = Object.freeze({});
  registerAutomaticCleanupRetryCapability(automaticRetryCapability);
  registerAutomaticCleanupRetryCapability(automaticRetryCapability);
  assert.throws(
    () => registerAutomaticCleanupRetryCapability(Object.freeze({})),
    /already registered and cannot be replaced/,
  );
  const forgedRetry = await retryPendingLifecycleCleanups({
    retryCapability: Object.freeze({}),
    dependencies: {
      listPendingCleanupLifecycles: () => { throw new Error("must not enumerate without capability"); },
    },
  });
  assert.equal(forgedRetry.blocked, "AUTOMATIC_CLEANUP_RETRY_CAPABILITY_REQUIRED");
  const retryEligibleOnly = await retryPendingLifecycleCleanups({
    retryCapability: automaticRetryCapability,
    dependencies: {
      isEffectiveDryRun: () => false,
      listPendingCleanupLifecycles: () => [
        { lifecycle_id: "lp:pending-a", position: "pending-a", state: "CLEANUP_PENDING" },
        { lifecycle_id: "lp:pending-b", position: "pending-b", state: "CLEANUP_PENDING" },
      ],
      executeLeasedLifecycleCleanup: async (input) => {
        retryExecutions.push(input);
        return { success: true, finalization: { lifecycle: { state: "SETTLED" } } };
      },
    },
  });
  assert.equal(retryEligibleOnly.success, true);
  assert.equal(retryEligibleOnly.attempted, 2);
  assert.equal(retryEligibleOnly.settled, 2);
  assert.deepEqual(retryExecutions.map((input) => input.position), ["pending-a", "pending-b"]);
  assert.equal(retryExecutions.every((input) => Object.isFrozen(input.executionCapability)), true);

  let releaseFirstRetry;
  let overlappingExecutions = 0;
  const firstRetry = retryPendingLifecycleCleanups({
    retryCapability: automaticRetryCapability,
    dependencies: {
      isEffectiveDryRun: () => false,
      listPendingCleanupLifecycles: () => [{ lifecycle_id: "lp:slow", position: "slow" }],
      executeLeasedLifecycleCleanup: async () => {
        overlappingExecutions += 1;
        await new Promise((resolve) => { releaseFirstRetry = resolve; });
        return { success: true, finalization: { lifecycle: { state: "SETTLED" } } };
      },
    },
  });
  while (!releaseFirstRetry) await new Promise((resolve) => setImmediate(resolve));
  const overlappingRetry = await retryPendingLifecycleCleanups({
    retryCapability: automaticRetryCapability,
    dependencies: { isEffectiveDryRun: () => false },
  });
  assert.equal(overlappingRetry.skipped, true);
  assert.equal(overlappingRetry.reason, "AUTOMATIC_CLEANUP_RETRY_ALREADY_RUNNING");
  assert.equal(overlappingExecutions, 1, "automatic cleanup retries cannot overlap in process");
  releaseFirstRetry();
  await firstRetry;
  assert.doesNotMatch(
    fs.readFileSync(new URL("../tools/definitions.js", import.meta.url), "utf8"),
    /retryPendingLifecycleCleanups|AUTOMATIC_CLEANUP_RETRY_CAPABILITY/,
    "automatic retry and its private capability must not leak into model tool definitions",
  );

  const operatorExecution = await executeConfirmedCleanup({
    position: "test-position",
    confirmation: CLEANUP_EXECUTION_CONFIRMATION,
    operatorCapability: telegramOperatorCapability,
    dependencies: { isolated: true },
    cleanupExecutor: async (input) => { cleanupInput = input; return { success: true, execution: { executed: true } }; },
  });
  assert.equal(operatorExecution.success, true);
  assert.deepEqual(
    { position: cleanupInput.position, execute: cleanupInput.execute, dependencies: cleanupInput.dependencies },
    { position: "test-position", execute: undefined, dependencies: { isolated: true } },
  );
  assert.equal(typeof cleanupInput.executionCapability, "object");
  assert.equal(Object.isFrozen(cleanupInput.executionCapability), true, "the registered execution capability reaches only the injected cleanup boundary");
  assert.notEqual(cleanupInput.executionCapability, telegramOperatorCapability);

  // A dry-run close/claim/swap must remain a preview, while a paper deploy is
  // still a valid paper lifecycle outcome.
  for (const name of ["close_position", "claim_fees", "swap_token"]) {
    assert.equal(isToolExecutionSuccess(name, { dry_run: true }), false);
    assert.equal(isExecutedTransactionSuccess(name, { dry_run: true }), false);
  }
  assert.equal(isToolExecutionSuccess("claim_fees", {
    success: true,
    position: "claimed-position",
    reconciliation_required: true,
  }), false, "receipt-accounting uncertainty must fail closed");
  assert.equal(isToolExecutionSuccess("deploy_position", { dry_run: true, paper_position: "paper-1" }), true);

  console.log("executor canary-boundary tests passed");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
