import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-transaction-recovery-"));
process.env.MERIDIAN_USER_CONFIG_FILE = path.join(tempDir, "user-config.json");
process.env.MERIDIAN_STATE_FILE = path.join(tempDir, "state.json");
process.env.MERIDIAN_LESSONS_FILE = path.join(tempDir, "lessons.json");
fs.writeFileSync(process.env.MERIDIAN_USER_CONFIG_FILE, JSON.stringify({
  dryRun: true,
  rolloutMode: "dry_run",
  ledgerPath: path.join(tempDir, "trade-ledger.jsonl"),
}));

try {
  const { config } = await import("../config.js");
  const { claimFees, localCloseFeePlan, localDeployReceiptCandidate, shouldSubmitSeparateCloseClaim } = await import("../tools/dlmm.js");
  const {
    executeTool,
    finalizeLifecycleToolResult,
    isToolExecutionSuccess,
    recoverLifecycleOperationResult,
    withCanaryDeployReservation,
  } = await import("../tools/executor.js");

  const claimOnlyClose = recoverLifecycleOperationResult("close_position", [{
    position: "PositionAfterClaim",
    phase: "claim",
    signature: "claim-confirmed",
  }], { position_address: "PositionAfterClaim", reason: "recovery" });
  assert.equal(claimOnlyClose.success, false, "a claim checkpoint is not a completed close result");
  assert.equal(claimOnlyClose.reconciliation_required, true);
  assert.equal(claimOnlyClose.resume_close, undefined);
  assert.deepEqual(claimOnlyClose.claim_txs, ["claim-confirmed"]);
  assert.equal(isToolExecutionSuccess("close_position", claimOnlyClose), false);
  assert.equal(shouldSubmitSeparateCloseClaim({
    feePlan: localCloseFeePlan({ hasLiquidity: false }),
    confirmedClaimTxs: claimOnlyClose.claim_txs,
  }), false, "resumed close skips an independently confirmed pre-close claim");

  let claimOnlyCleanupCalls = 0;
  await finalizeLifecycleToolResult({
    name: "close_position",
    result: claimOnlyClose,
    dependencies: {
      getWalletPublicKey: () => "wallet",
      recordLifecycleTransactions: async (input) => {
        assert.deepEqual(input.transactions, [{ signature: "claim-confirmed", phase: "claim" }]);
        return { state: "CLOSING", lifecycle_id: "lp:PositionAfterClaim" };
      },
      markCleanupPending: () => { claimOnlyCleanupCalls += 1; },
    },
  });
  assert.equal(claimOnlyCleanupCalls, 0, "claim-only recovery must never finalize close cleanup");

  const completedClaimClose = recoverLifecycleOperationResult("close_position", [{
    position: "PositionAfterClaim",
    phase: "claim",
    signature: "claim-confirmed",
  }], { position_address: "PositionAfterClaim", reason: "recovery" }, {
    completions: [{
      phase: "claim",
      expected_transactions: [{ phase: "claim", signature: "claim-confirmed" }],
      position_absent: null,
    }],
  });
  assert.equal(completedClaimClose.success, undefined, "a completed claim can resume only the remaining close");
  assert.equal(completedClaimClose.resume_close, true);
  assert.equal(completedClaimClose.claim_completed, true);
  assert.equal(shouldSubmitSeparateCloseClaim({
    feePlan: localCloseFeePlan({ hasLiquidity: false }),
    confirmedClaimTxs: completedClaimClose.claim_txs,
  }), false, "resumed close skips an independently completed pre-close claim");

  const resumedClose = {
    success: true,
    position: completedClaimClose.position,
    claim_txs: completedClaimClose.claim_txs,
    close_txs: ["close-confirmed"],
  };
  let resumeReceiptInput = null;
  await finalizeLifecycleToolResult({
    name: "close_position",
    result: resumedClose,
    dependencies: {
      getWalletPublicKey: () => "wallet",
      recordLifecycleTransactions: async (input) => {
        resumeReceiptInput = input;
        return { state: "CLOSING", lifecycle_id: "lp:PositionAfterClaim" };
      },
      markCleanupPending: () => ({ state: "CLEANUP_PENDING", lifecycle_id: "lp:PositionAfterClaim" }),
      executeAutomaticPostCloseCleanup: async () => ({
        success: false,
        blocked: "INJECTED_PENDING",
      }),
    },
  });
  assert.deepEqual(resumeReceiptInput.transactions, [
    { signature: "close-confirmed", phase: "close" },
    { signature: "claim-confirmed", phase: "claim" },
  ], "resumed close records both independently confirmed phases without replaying the claim");
  assert.equal(resumedClose.success, true);

  const partialDeploy = recoverLifecycleOperationResult("deploy_position", [{
    position: "PartialDeployPosition",
    phase: "deploy",
    signature: "first-confirmed-deploy-tx",
  }], { pool_address: "PoolPartial" });
  assert.equal(partialDeploy.success, false);
  assert.equal(partialDeploy.blocked, true);
  assert.equal(partialDeploy.reconciliation_required, true);
  assert.deepEqual(partialDeploy.txs, ["first-confirmed-deploy-tx"]);
  assert.equal(isToolExecutionSuccess("deploy_position", partialDeploy), false);

  // Deploy success consumes the exact same canonical receipt collection in
  // both the finalizer and success predicate. A supported local SDK may return
  // one `tx` rather than a plural array; unresolved/unrelated strings cannot
  // satisfy the contract.
  const singularDeploy = {
    success: true,
    position: "SingularDeployPosition",
    pool: "SingularDeployPool",
    tx: "singular-confirmed-deploy",
    amount_y: 0.1,
    deploy_receipt_provenance: [{
      signature: "singular-confirmed-deploy",
      kind: "liquidity",
      layer_id: "single",
    }],
  };
  assert.equal(isToolExecutionSuccess("deploy_position", singularDeploy), true);
  let singularRecorderInput = null;
  await finalizeLifecycleToolResult({
    name: "deploy_position",
    result: singularDeploy,
    args: { amount_y: 0.1, pool_address: "SingularDeployPool" },
    dependencies: {
      getWalletPublicKey: () => "wallet",
      recordDeployLifecycle: async (input) => {
        singularRecorderInput = input;
        return { state: "ACTIVE", reconciliation_latched: false };
      },
    },
  });
  assert.deepEqual(singularRecorderInput.txs, ["singular-confirmed-deploy"]);
  assert.equal(singularDeploy.success, true);
  assert.equal(isToolExecutionSuccess("deploy_position", {
    success: true,
    tx: "unbound-singular-signature",
  }), false, "a singular receipt without a position remains unresolved");
  assert.equal(isToolExecutionSuccess("deploy_position", {
    success: true,
    position: "Position",
    signature: "unrelated-field-is-not-a-receipt",
  }), false, "arbitrary string fields are excluded from receipt canonicalization");
  const localSdkCandidate = localDeployReceiptCandidate({
    position: "LocalSdkPosition",
    pool: "LocalSdkPool",
    txs: ["local-sdk-confirmed"],
    deploy_receipt_provenance: [{ signature: "local-sdk-confirmed", kind: "liquidity", layer_id: "single" }],
  });
  assert.equal(localSdkCandidate.success, true);
  assert.equal(localSdkCandidate.reconciliation_required, undefined);
  assert.equal(isToolExecutionSuccess("deploy_position", localSdkCandidate), true,
    "supported local SDK output reaches the finalizer as a receipt candidate, not an unconditional NO-GO");

  const partialChunkedClose = recoverLifecycleOperationResult("close_position", [{
    position: "ChunkedClosePosition",
    phase: "close",
    signature: "remove-liquidity-chunk-1",
  }], { position_address: "ChunkedClosePosition" });
  assert.equal(partialChunkedClose.success, false);
  assert.equal(partialChunkedClose.reconciliation_required, true);
  assert.equal(isToolExecutionSuccess("close_position", partialChunkedClose), false,
    "one confirmed removeLiquidity chunk is never a terminal close");

  const recoveredPartialClaim = recoverLifecycleOperationResult("claim_fees", [{
    position: "ChunkedClaimPosition",
    phase: "claim",
    signature: "claim-chunk-1",
  }], { position_address: "ChunkedClaimPosition" });
  assert.equal(recoveredPartialClaim.success, false);
  assert.equal(recoveredPartialClaim.reconciliation_required, true,
    "a claim checkpoint is not complete while a multi-transaction claim lacks a durable completion marker");

  const recoveredCompletedClaim = recoverLifecycleOperationResult("claim_fees", [{
    position: "ChunkedClaimPosition",
    phase: "claim",
    signature: "claim-chunk-1",
  }, {
    position: "ChunkedClaimPosition",
    phase: "claim",
    signature: "claim-chunk-2",
  }], { position_address: "ChunkedClaimPosition" }, {
    completions: [{
      phase: "claim",
      expected_transactions: [
        { phase: "claim", signature: "claim-chunk-1" },
        { phase: "claim", signature: "claim-chunk-2" },
      ],
      position_absent: null,
    }],
  });
  assert.equal(recoveredCompletedClaim.success, true);
  assert.deepEqual(recoveredCompletedClaim.claim_txs, ["claim-chunk-1", "claim-chunk-2"]);

  const requestedVsConfirmed = {
    success: true,
    position: "BasisPosition",
    pool: "BasisPool",
    amount_y: 10,
    txs: ["confirmed-deploy-tx"],
    confirmed_deploy_economics: {
      status: "durability_reconciliation_required",
      receipts: ["confirmed-deploy-tx"],
      // A requested amount must never be promoted to this missing basis field.
      basis_lamports: null,
    },
  };
  let requestedDeployRecording = null;
  await finalizeLifecycleToolResult({
    name: "deploy_position",
    result: requestedVsConfirmed,
    dependencies: {
      getWalletPublicKey: () => "wallet",
      recordDeployLifecycle: async (input) => {
        requestedDeployRecording = input;
        return {
          state: "RECONCILIATION_REQUIRED",
          reconciliation_latched: true,
          lifecycle_id: "lp:BasisPosition",
        };
      },
    },
  });
  assert.equal(requestedDeployRecording.allowActivation, true, "the finalizer forwards successful deploy receipts to the authoritative recorder");
  assert.equal(requestedVsConfirmed.success, false);
  assert.equal(requestedVsConfirmed.blocked, true);
  assert.equal(requestedVsConfirmed.reconciliation_required, true);
  assert.match(requestedVsConfirmed.reason, /receipt reconciliation is required/i);
  assert.equal(isToolExecutionSuccess("deploy_position", requestedVsConfirmed), false);

  const reconciliationClose = {
    success: true,
    position: "ReconciliationPosition",
    close_txs: ["close-reconciliation"],
  };
  let reconciliationCleanupCalls = 0;
  await finalizeLifecycleToolResult({
    name: "close_position",
    result: reconciliationClose,
    dependencies: {
      getWalletPublicKey: () => "wallet",
      recordLifecycleTransactions: async () => ({
        state: "RECONCILIATION_REQUIRED",
        reconciliation_latched: true,
        lifecycle_id: "lp:ReconciliationPosition",
      }),
      markCleanupPending: () => { reconciliationCleanupCalls += 1; },
    },
  });
  assert.equal(reconciliationClose.success, false);
  assert.equal(reconciliationClose.blocked, true);
  assert.equal(reconciliationClose.reconciliation_required, true);
  assert.equal(reconciliationCleanupCalls, 0, "reconciliation-required results cannot transition to cleanup pending");
  assert.equal(isToolExecutionSuccess("close_position", reconciliationClose), false);

  // The immutable rollout authority was captured at import. Mutating the
  // process environment afterwards cannot create a live claim/close path.
  const priorDryRun = process.env.DRY_RUN;
  process.env.DRY_RUN = "false";
  try {
    const directClaim = await claimFees({ position_address: "11111111111111111111111111111111" });
    assert.equal(directClaim.dry_run, true);

    let beginCloseCalls = 0;
    const mutatedEnvClose = await executeTool("close_position", { position_address: "env-mutation-position" }, {
      toolMap: {
        close_position: async () => ({ dry_run: true, would_close: "env-mutation-position" }),
      },
      beginCloseLifecycle: async () => { beginCloseCalls += 1; throw new Error("must remain dry-run"); },
    });
    assert.equal(mutatedEnvClose.dry_run, true);
    assert.equal(beginCloseCalls, 0);

    let boundaryCalls = 0;
    const reservation = await withCanaryDeployReservation({
      checkBoundary: async () => { boundaryCalls += 1; throw new Error("must remain dry-run"); },
      run: async (boundary) => boundary,
    });
    assert.deepEqual(reservation, { pass: true, applied: false });
    assert.equal(boundaryCalls, 0);
  } finally {
    process.env.DRY_RUN = priorDryRun;
  }

  // A locked leaf rejects all requested changes before either a mutable leaf
  // or the temp user config is changed.
  const previousMinTvl = config.screening.minTvl;
  const configResult = await executeTool("update_config", {
    changes: { minTvl: previousMinTvl + 1, multiLayerEnabled: true },
    reason: "atomicity regression",
  });
  assert.equal(configResult.success, false);
  assert.equal(config.screening.minTvl, previousMinTvl);
  const persistedConfig = JSON.parse(fs.readFileSync(process.env.MERIDIAN_USER_CONFIG_FILE, "utf8"));
  assert.equal(Object.hasOwn(persistedConfig, "minTvl"), false);

  console.log("transaction recovery tests passed");
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
