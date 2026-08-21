import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  LIFECYCLE_STATES,
  TradeLedger,
} from "../trade-ledger.js";
import {
  checkpointCleanupExecution,
  finalizeLifecycleWithStore,
  getCheckpointedCleanupTransactions,
  recordLifecycleTransactions,
  requireLifecycleAttribution,
  validateTerminalEconomics,
} from "../ledger-runtime.js";
import {
  acquireSecureFileLock,
  releaseSecureFileLock,
} from "../durable-file.js";
import {
  buildSettlementBreakerEvents,
  derivePendingCleanupEquity,
  deriveCleanupTerminalEconomics,
  executeEconomicCleanup,
  listPendingCleanupLifecycles,
  reconcileLifecycleCleanup,
} from "../cleanup-runtime.js";
import {
  buildZeroLiquidityCloseClaimPlan,
  isAuthoritativePositionAbsent,
  inspectClosePositionLiquidity,
  localCloseFeePlan,
  shouldSubmitSeparateCloseClaim,
  zeroLiquidityCloseClaimMethods,
} from "../tools/dlmm.js";
import { createSerializedBreakerRuntime } from "../breaker-runtime.js";
import {
  createCircuitBreakerController,
  createMemoryCircuitBreakerStorage,
} from "../circuit-breaker.js";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-close-cleanup-"));
const ledgerPath = path.join(tempDir, "ledger.jsonl");
let eventNumber = 0;
let timeNumber = 0;
const ledger = new TradeLedger({
  filePath: ledgerPath,
  durable: false,
  idFactory: () => `event-${++eventNumber}`,
  now: () => new Date(Date.parse("2026-07-22T00:00:00.000Z") + (++timeNumber * 1_000)),
});

const terminalEvidence = ({ residual = "0", rent = "0", executionState = "not_required" } = {}) => ({
  source: "economic_cleanup_reconciliation",
  snapshot_at: "2026-07-22T00:10:00.000Z",
  scanned_programs: ["token", "token2022"],
  execution_state: executionState,
  economic_complete: true,
  residual_token_value_lamports: residual,
  reclaimable_rent_lamports: rent,
});

const pendingSwapEquity = derivePendingCleanupEquity({
  accounts: [{ tokenAccount: "PlumberAccount", mint: "PlumberMint", rawAmount: "1844297127", rentLamports: "2074080" }],
  plan: {
    actions: [{
      tokenAccount: "PlumberAccount",
      mint: "PlumberMint",
      rawAmount: "1844297127",
      action: "swap_then_close",
      quote: { routeFound: true, worstNetLamports: "32786791" },
    }],
  },
  conservativeCloseFeeLamports: "20000",
});
assert.equal(pendingSwapEquity.ok, true);
assert.equal(pendingSwapEquity.total_lamports, "34840871",
  "pending swap equity includes worst-net output plus reclaimable rent minus conservative close fee");
assert.equal(derivePendingCleanupEquity({
  accounts: [{ tokenAccount: "unknown", mint: "unknown-mint", rawAmount: "1", rentLamports: "2074080" }],
  plan: { actions: [{ tokenAccount: "unknown", mint: "unknown-mint", rawAmount: "1", action: "keep", quote: { routeFound: false } }] },
}).ok, false, "unpriced retained residue must produce valuation uncertainty");

function runCleanupCheckpointWorker({ ledgerPath: workerLedgerPath, position, readyFile, goFile, now }) {
  const worker = `
    import fs from "node:fs";
    import { TradeLedger } from ${JSON.stringify(pathToFileURL(path.join(process.cwd(), "trade-ledger.js")).href)};
    import { checkpointCleanupExecution } from ${JSON.stringify(pathToFileURL(path.join(process.cwd(), "ledger-runtime.js")).href)};
    fs.writeFileSync(process.env.MERIDIAN_CLEANUP_READY_FILE, "ready");
    while (!fs.existsSync(process.env.MERIDIAN_CLEANUP_GO_FILE)) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
    const store = new TradeLedger({
      filePath: process.env.MERIDIAN_CLEANUP_LEDGER_PATH,
      durable: false,
      now: () => new Date(process.env.MERIDIAN_CLEANUP_OCCURRED_AT),
    });
    checkpointCleanupExecution(process.env.MERIDIAN_CLEANUP_POSITION, {
      cleanupExecutionId: "cleanup-concurrency-regression",
      transactions: [{ signature: "cleanup-concurrent-once", phase: "cleanup", ownedAccounts: ["TokenAccountConcurrent"] }],
      store,
      ledgerEnabled: true,
    });
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", worker], {
      env: {
        ...process.env,
        MERIDIAN_CLEANUP_LEDGER_PATH: workerLedgerPath,
        MERIDIAN_CLEANUP_POSITION: position,
        MERIDIAN_CLEANUP_READY_FILE: readyFile,
        MERIDIAN_CLEANUP_GO_FILE: goFile,
        MERIDIAN_CLEANUP_OCCURRED_AT: now,
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`cleanup checkpoint worker exited ${code}: ${stderr}`));
    });
  });
}

async function waitForFile(file, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(file)) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for delayed cleanup worker dedupe read");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

try {
  // The exported cleanup runtime must reject direct execute:true calls before
  // it can load a signer, enumerate token accounts, or submit anything.
  let unauthorizedRuntimeWork = 0;
  const unauthorizedExecution = await executeEconomicCleanup({
    position: "Position111",
    execute: true,
    walletPublicKey: "11111111111111111111111111111111",
    dependencies: {
      getWalletBalances: async () => { unauthorizedRuntimeWork += 1; throw new Error("must not read balances"); },
      connection: {
        getParsedTokenAccountsByOwner: async () => { unauthorizedRuntimeWork += 1; throw new Error("must not enumerate accounts"); },
      },
    },
  });
  assert.equal(unauthorizedExecution.blocked, "CLEANUP_EXECUTION_CAPABILITY_REQUIRED");
  assert.equal(unauthorizedRuntimeWork, 0);

  // A position with liquidity has one Meteora removal transaction that claims
  // fees; only an already-empty position needs a separate claim first.
  assert.deepEqual(localCloseFeePlan({ hasLiquidity: true }), {
    claimSeparately: false,
    shouldClaimAndClose: true,
  });
  assert.deepEqual(localCloseFeePlan({ hasLiquidity: false }), {
    claimSeparately: true,
    shouldClaimAndClose: false,
  });
  assert.equal(inspectClosePositionLiquidity({
    positionData: { lowerBinId: 1, upperBinId: 2, positionBinData: [{ positionLiquidity: "0" }] },
  }).hasLiquidity, false);
  assert.equal(inspectClosePositionLiquidity({
    positionData: { positionBinData: [{ positionLiquidity: "1" }] },
  }).hasLiquidity, true, "liquid positions use only removeLiquidity's one fee claim path");
  assert.throws(() => inspectClosePositionLiquidity({ positionData: {} }), /snapshot is missing or incomplete/);
  assert.throws(() => inspectClosePositionLiquidity({
    positionData: { positionBinData: [{ positionLiquidity: "not-a-number" }] },
  }), /liquidity is unparseable/);

  // The bundled Meteora SDK throws for claimSwapFee with feeX=feeY=0, while
  // rewards are tracked in distinct rewardOne/rewardTwo fields. The close
  // planner must select exactly the required paths without an RPC call.
  const feeEmpty = buildZeroLiquidityCloseClaimPlan({
    positionData: { feeX: "0", feeY: "0", rewardOne: "0", rewardTwo: "0" },
  });
  assert.deepEqual(feeEmpty, { claimFees: false, claimRewards: false, noClaimRequired: true });
  assert.deepEqual(zeroLiquidityCloseClaimMethods(feeEmpty), []);
  const feeOnly = buildZeroLiquidityCloseClaimPlan({
    positionData: { feeX: "1", feeY: "0", rewardOne: "0", rewardTwo: "0" },
  });
  assert.deepEqual(feeOnly, { claimFees: true, claimRewards: false, noClaimRequired: false });
  assert.deepEqual(zeroLiquidityCloseClaimMethods(feeOnly), ["claimSwapFee"]);
  const rewardOnly = buildZeroLiquidityCloseClaimPlan({
    positionData: { feeX: "0", feeY: "0", rewardOne: "0", rewardTwo: "2" },
  });
  assert.deepEqual(rewardOnly, { claimFees: false, claimRewards: true, noClaimRequired: false });
  assert.deepEqual(zeroLiquidityCloseClaimMethods(rewardOnly), ["claimLMReward"]);
  assert.deepEqual(zeroLiquidityCloseClaimMethods({ claimFees: true, claimRewards: true }), ["claimSwapFee", "claimLMReward"],
    "fee and reward paths are independent and each appears once");
  assert.equal(shouldSubmitSeparateCloseClaim({
    feePlan: localCloseFeePlan({ hasLiquidity: false }),
    confirmedClaimTxs: ["durably-completed-recovered-claim"],
  }), false, "recovered claim receipts are never replayed by the close path");
  assert.equal(isAuthoritativePositionAbsent({
    source: "rpc",
    total_positions: 0,
    positions: [],
  }, "ClosedPosition"), true);
  assert.equal(isAuthoritativePositionAbsent({
    source: "meteora",
    total_positions: 0,
    positions: [],
  }, "ClosedPosition"), false, "a portfolio API response cannot complete a terminal close");
  assert.equal(isAuthoritativePositionAbsent({
    error: "RPC unavailable",
    total_positions: 0,
    positions: [],
  }, "ClosedPosition"), false, "an unavailable scan is never treated as position absence");

  // Fresh final scans must either have no accounts or preserve only a
  // conservative, currently quoted residual value. Preview-only actionable
  // cleanup cannot settle anything.
  const actionRequired = deriveCleanupTerminalEconomics({
    accounts: [{ tokenAccount: "close-me", rawAmount: "0", rentLamports: "10" }],
    plan: { actions: [{ tokenAccount: "close-me", action: "close" }] },
    execution: { executed: false, preview: true },
  });
  assert.equal(actionRequired.complete, false);
  assert.equal(actionRequired.blocked, "CLEANUP_EXECUTION_REQUIRED");

  const unpricedResidue = deriveCleanupTerminalEconomics({
    accounts: [{ tokenAccount: "residue", rawAmount: "5", rentLamports: "10" }],
    plan: { actions: [{ tokenAccount: "residue", action: "keep", reason: "quote_unavailable" }] },
  });
  assert.equal(unpricedResidue.complete, false);
  assert.equal(unpricedResidue.blocked, "RESIDUAL_VALUE_NOT_DEFENSIBLE");

  const pricedResidue = deriveCleanupTerminalEconomics({
    accounts: [{ tokenAccount: "residue", mint: "Mint111", rawAmount: "5", rentLamports: "10" }],
    plan: {
      actions: [{
        tokenAccount: "residue",
        action: "keep",
        reason: "uneconomic_route_dust",
        quote: { routeFound: true, worstNetLamports: "7" },
      }],
    },
  });
  assert.equal(pricedResidue.complete, true);
  assert.equal(pricedResidue.residualTokenValueLamports, "7");
  assert.equal(pricedResidue.reclaimableRentLamports, "10");
  assert.equal(pricedResidue.terminalEconomics.execution_state, "not_required");

  ledger.createLifecycle({
    lifecycle_id: "lp:Position111",
    position_address: "Position111",
    pool_address: "Pool111",
    expected_deposit_lamports: 100n,
  });
  ledger.transitionLifecycle("lp:Position111", LIFECYCLE_STATES.BASIS_PENDING);
  ledger.recordTransaction({
    lifecycle_id: "lp:Position111",
    signature: "deploy",
    phase: "deploy",
    layer_id: "single",
    amounts: {
      deposit_lamports: 100n,
      liquid_wallet_delta_lamports: -105n,
      tx_fee_lamports: 5n,
    },
  });
  ledger.recordBasisObservation({ lifecycle_id: "lp:Position111", source: "rpc", deposit_lamports: 100n });
  ledger.recordBasisObservation({ lifecycle_id: "lp:Position111", source: "rpc", deposit_lamports: 100n });
  ledger.transitionLifecycle("lp:Position111", LIFECYCLE_STATES.ACTIVE);
  ledger.transitionLifecycle("lp:Position111", LIFECYCLE_STATES.CLOSING, { reason: "TRAILING_TP" });
  ledger.recordTransaction({
    lifecycle_id: "lp:Position111",
    signature: "close",
    phase: "close",
    amounts: {
      withdrawal_lamports: 110n,
      liquid_wallet_delta_lamports: 105n,
      tx_fee_lamports: 5n,
    },
  });
  ledger.transitionLifecycle("lp:Position111", LIFECYCLE_STATES.CLEANUP_PENDING);
  ledger.createLifecycle({
    lifecycle_id: "lp:LatchedCleanup",
    position_address: "LatchedCleanup",
    pool_address: "LatchedPool",
    expected_deposit_lamports: 1n,
  });
  ledger.transitionLifecycle("lp:LatchedCleanup", LIFECYCLE_STATES.BASIS_PENDING);
  ledger.recordTransaction({
    lifecycle_id: "lp:LatchedCleanup",
    signature: "latched-deploy",
    phase: "deploy",
    layer_id: "single",
    amounts: { deposit_lamports: 1n, liquid_wallet_delta_lamports: -1n },
  });
  ledger.recordBasisObservation({ lifecycle_id: "lp:LatchedCleanup", source: "rpc", deposit_lamports: 1n });
  ledger.recordBasisObservation({ lifecycle_id: "lp:LatchedCleanup", source: "rpc", deposit_lamports: 1n });
  ledger.transitionLifecycle("lp:LatchedCleanup", LIFECYCLE_STATES.ACTIVE);
  ledger.transitionLifecycle("lp:LatchedCleanup", LIFECYCLE_STATES.CLOSING);
  ledger.transitionLifecycle("lp:LatchedCleanup", LIFECYCLE_STATES.CLEANUP_PENDING);
  ledger.transitionLifecycle("lp:LatchedCleanup", LIFECYCLE_STATES.RECONCILIATION_REQUIRED, {
    reason: "manual reconciliation fixture",
  });
  assert.deepEqual(
    listPendingCleanupLifecycles({ store: ledger }).map((item) => item.position),
    ["Position111"],
    "automatic cleanup enumeration includes only unlatched CLEANUP_PENDING lifecycles",
  );

  // Receipt accounting keeps every independently confirmed chunk that can be
  // inspected, even when a later receipt is temporarily unavailable. Retry
  // remains signature-idempotent and an untracked claim is blocked before it
  // can be submitted.
  ledger.createLifecycle({
    lifecycle_id: "lp:ReceiptPosition",
    position_address: "ReceiptPosition",
    pool_address: "ReceiptPool",
    expected_deposit_lamports: 1n,
  });
  ledger.transitionLifecycle("lp:ReceiptPosition", LIFECYCLE_STATES.BASIS_PENDING);
  ledger.recordTransaction({
    lifecycle_id: "lp:ReceiptPosition",
    signature: "receipt-deploy",
    phase: "deploy",
    layer_id: "single",
    amounts: { deposit_lamports: 1n, liquid_wallet_delta_lamports: -1n },
  });
  ledger.recordBasisObservation({ lifecycle_id: "lp:ReceiptPosition", source: "rpc", deposit_lamports: 1n });
  ledger.recordBasisObservation({ lifecycle_id: "lp:ReceiptPosition", source: "rpc", deposit_lamports: 1n });
  ledger.transitionLifecycle("lp:ReceiptPosition", LIFECYCLE_STATES.ACTIVE);
  assert.equal(requireLifecycleAttribution("MissingPosition", {
    store: ledger,
    ledgerEnabled: true,
  }).pass, false);
  assert.equal(requireLifecycleAttribution("ReceiptPosition", {
    store: ledger,
    ledgerEnabled: true,
  }).pass, true);
  // Close receipts are recorded only after the close lifecycle transition;
  // claim receipts in the same close operation remain attributable in CLOSING.
  ledger.transitionLifecycle("lp:ReceiptPosition", LIFECYCLE_STATES.CLOSING, { reason: "receipt accounting regression" });

  const receiptDetails = (signature) => ({
    signature,
    executionStatus: "succeeded",
    walletDeltaLamports: 10n,
    txFeeLamports: 1n,
    rentCreatedLamports: 0n,
    rentReclaimedLamports: 0n,
    tokenDeltas: [],
    tokenAccountEvidence: [],
    slot: 1,
  });
  await assert.rejects(recordLifecycleTransactions({
    position: "ReceiptPosition",
    walletAddress: "wallet-public-key",
    transactions: [
      { signature: "claim-confirmed", phase: "claim" },
      { signature: "close-temporarily-unavailable", phase: "close" },
      { signature: "close-confirmed", phase: "close" },
    ],
    inspectTransaction: async (signature) => {
      if (signature === "close-temporarily-unavailable") throw new Error("injected post-submit verification failure");
      return receiptDetails(signature);
    },
    store: ledger,
    ledgerEnabled: true,
  }), /close-temporarily-unavailable/);
  assert.deepEqual(ledger.getLifecycle("lp:ReceiptPosition").signatures, [
    "receipt-deploy",
    "claim-confirmed",
    "close-confirmed",
  ], "later receipt failure must not discard earlier or later confirmed receipts");
  const receiptsBeforeDuplicateRetry = ledger.readEvents().length;
  await recordLifecycleTransactions({
    position: "ReceiptPosition",
    walletAddress: "wallet-public-key",
    transactions: [
      { signature: "claim-confirmed", phase: "claim" },
      { signature: "close-confirmed", phase: "close" },
    ],
    inspectTransaction: async () => { throw new Error("duplicate receipt must not be inspected"); },
    store: ledger,
    ledgerEnabled: true,
  });
  assert.equal(ledger.readEvents().length, receiptsBeforeDuplicateRetry, "duplicate receipt retry must append no ledger event");

  // Reconciliation previews retain both the caller's public wallet identity
  // and injected read-only adapters. No private key is needed to scan either
  // SPL Token program, and this must remain true before the later final scan.
  const previewWallet = "11111111111111111111111111111111";
  const scannedOwners = [];
  const previousPrivateKey = process.env.WALLET_PRIVATE_KEY;
  const previousPublicKey = process.env.WALLET_PUBLIC_KEY;
  delete process.env.WALLET_PRIVATE_KEY;
  delete process.env.WALLET_PUBLIC_KEY;
  try {
    const previewReconciliation = await reconcileLifecycleCleanup({
      position: "Position111",
      walletPublicKey: previewWallet,
      dependencies: {
        store: ledger,
        getTrackedPositions: (open) => open ? [] : [{ position: "Position111", base_mint: "Mint111" }],
        getWalletBalances: async (owner) => {
          scannedOwners.push(owner);
          return { wallet: owner, tokens: [], sol_price: 0 };
        },
        connection: {
          getParsedTokenAccountsByOwner: async (owner) => {
            scannedOwners.push(owner.toBase58());
            return { value: [] };
          },
        },
        now: () => "2026-07-22T00:00:00.000Z",
      },
    });
    assert.equal(previewReconciliation.success, true);
    assert.equal(previewReconciliation.wallet, previewWallet);
    assert.equal(previewReconciliation.execution.preview, true);
    assert.deepEqual(scannedOwners, [previewWallet, previewWallet, previewWallet]);
  } finally {
    if (previousPrivateKey === undefined) delete process.env.WALLET_PRIVATE_KEY;
    else process.env.WALLET_PRIVATE_KEY = previousPrivateKey;
    if (previousPublicKey === undefined) delete process.env.WALLET_PUBLIC_KEY;
    else process.env.WALLET_PUBLIC_KEY = previousPublicKey;
  }

  const checkpointBefore = ledger.readEvents().length;
  checkpointCleanupExecution("Position111", {
    cleanupExecutionId: "cleanup-submit:position111:batch1",
    transactions: [{ signature: "cleanup-batch-1", phase: "cleanup", ownedAccounts: ["TokenAccount111"] }],
    store: ledger,
    ledgerEnabled: true,
  });
  checkpointCleanupExecution("Position111", {
    cleanupExecutionId: "cleanup-submit:position111:batch1",
    transactions: [{ signature: "cleanup-batch-1", phase: "cleanup", ownedAccounts: ["TokenAccount111"] }],
    store: ledger,
    ledgerEnabled: true,
  });
  assert.equal(ledger.readEvents().length, checkpointBefore + 1, "cleanup signature checkpoint is idempotent");
  assert.deepEqual(getCheckpointedCleanupTransactions("Position111", { store: ledger }), [{
    signature: "cleanup-batch-1",
    phase: "cleanup",
    ownedAccounts: ["TokenAccount111"],
  }]);

  // The dedupe read and valuation append share a durable cross-process lock.
  // Start two workers behind a held lock: neither may append while it is held,
  // and after release the second worker must observe the first checkpoint.
  const cleanupReadyA = path.join(tempDir, "cleanup-worker-a.ready");
  const cleanupReadyB = path.join(tempDir, "cleanup-worker-b.ready");
  const cleanupGo = path.join(tempDir, "cleanup-workers.go");
  const lastCheckpointEvent = ledger.readEvents({ lifecycle_id: "lp:Position111" }).at(-1);
  const concurrentCheckpointTime = new Date(Date.parse(lastCheckpointEvent.occurred_at) + 1).toISOString();
  const cleanupLock = acquireSecureFileLock(ledgerPath, {
    fsImpl: fs,
    label: "Cleanup execution checkpoint",
    lockName: `.${path.basename(ledgerPath)}.cleanup-checkpoint.lock`,
    durable: false,
  });
  let cleanupWorkers = [];
  try {
    cleanupWorkers = [
      runCleanupCheckpointWorker({
        ledgerPath,
        position: "Position111",
        readyFile: cleanupReadyA,
        goFile: cleanupGo,
        now: concurrentCheckpointTime,
      }),
      runCleanupCheckpointWorker({
        ledgerPath,
        position: "Position111",
        readyFile: cleanupReadyB,
        goFile: cleanupGo,
        now: concurrentCheckpointTime,
      }),
    ];
    await Promise.all([waitForFile(cleanupReadyA), waitForFile(cleanupReadyB)]);
    fs.writeFileSync(cleanupGo, "go");
    await new Promise((resolve) => setTimeout(resolve, 100));
    const checkpointWhileLocked = ledger.readEvents({ lifecycle_id: "lp:Position111" })
      .flatMap((event) => event.metadata?.cleanup_transactions || [])
      .filter((transaction) => transaction.signature === "cleanup-concurrent-once");
    assert.equal(checkpointWhileLocked.length, 0,
      "a held cleanup dedupe lock prevents a stale read from appending checkpoint evidence");
  } finally {
    releaseSecureFileLock(cleanupLock, {
      fsImpl: fs,
      label: "Cleanup execution checkpoint",
      durable: false,
    });
  }
  await Promise.all(cleanupWorkers);
  const concurrentCleanupCheckpoints = ledger.readEvents({ lifecycle_id: "lp:Position111" })
    .filter((event) => event.event_type === "valuation_recorded" && event.source === "cleanup-execution-checkpoint")
    .flatMap((event) => event.metadata?.cleanup_transactions || [])
    .filter((transaction) => transaction.signature === "cleanup-concurrent-once");
  assert.equal(concurrentCleanupCheckpoints.length, 1,
    "two workers with an interleaved dedupe read append one cleanup checkpoint");

  const beforeBlocked = ledger.readEvents().length;
  const blocked = finalizeLifecycleWithStore({
    store: ledger,
    position: "Position111",
    residualTokenValueLamports: "0",
    reclaimableRentLamports: "0",
    terminalEconomics: null,
    ledgerEnabled: true,
    updateAccounting: () => {},
  });
  assert.equal(blocked.finalized, false);
  assert.equal(blocked.blocked, "TERMINAL_ECONOMICS_EVIDENCE_REQUIRED");
  assert.equal(ledger.readEvents().length, beforeBlocked, "blocked evidence must not append a settlement event");

  const evidence = terminalEvidence();
  const settled = finalizeLifecycleWithStore({
    store: ledger,
    position: "Position111",
    residualTokenValueLamports: "0",
    reclaimableRentLamports: "0",
    terminalEconomics: evidence,
    reconciliationId: "cleanup:position111:empty",
    ledgerEnabled: true,
    toleranceLamports: 0,
    updateAccounting: () => {},
  });
  assert.equal(settled.finalized, true);
  assert.equal(settled.lifecycle.state, LIFECYCLE_STATES.SETTLED);
  assert.equal(settled.lifecycle.wallet_equity_net_lamports, "0", "net SOL wallet delta is settlement authority");
  assert.deepEqual(
    buildSettlementBreakerEvents(settled, "TRAILING_TP", Date.parse("2026-07-22T00:20:00.000Z")).map((event) => event.type),
    ["reconciliation_checked", "trade_settled", "profit_exit"],
    "settlement emits reconciliation, trade, and profit-exit breaker events exactly once",
  );

  const afterSettlement = ledger.readEvents().length;
  const retried = finalizeLifecycleWithStore({
    store: ledger,
    position: "Position111",
    residualTokenValueLamports: "0",
    reclaimableRentLamports: "0",
    terminalEconomics: evidence,
    reconciliationId: "cleanup:position111:empty",
    ledgerEnabled: true,
    updateAccounting: () => {},
  });
  assert.equal(retried.finalized, false);
  assert.equal(retried.already_settled, true);
  assert.equal(ledger.readEvents().length, afterSettlement, "retry must not duplicate valuation or settlement");
  assert.deepEqual(
    buildSettlementBreakerEvents(retried, "TRAILING_TP", Date.parse("2026-07-22T00:21:00.000Z")).map((event) => event.eventId),
    buildSettlementBreakerEvents(settled, "TRAILING_TP", Date.parse("2026-07-22T00:20:00.000Z")).map((event) => event.eventId),
    "already-settled retry re-emits the same durable breaker delivery ids",
  );

  assert.equal(validateTerminalEconomics({
    ...terminalEvidence(),
    scanned_programs: ["token"],
  }, {
    residualTokenValueLamports: "0",
    reclaimableRentLamports: "0",
  }).reason, "BOTH_TOKEN_PROGRAMS_MUST_BE_SCANNED");

  // A ledger arithmetic mismatch is recorded, but it is not a successful
  // cleanup. The caller receives a block and breaker delivery contains only
  // the reconciliation failure event, never a settled-trade event.
  ledger.createLifecycle({
    lifecycle_id: "lp:ReconciliationRequired",
    position_address: "ReconciliationRequired",
    pool_address: "PoolReconciliation",
    expected_deposit_lamports: 100n,
  });
  ledger.transitionLifecycle("lp:ReconciliationRequired", LIFECYCLE_STATES.BASIS_PENDING);
  ledger.recordTransaction({
    lifecycle_id: "lp:ReconciliationRequired",
    signature: "reconciliation-deploy",
    phase: "deploy",
    layer_id: "single",
    amounts: { deposit_lamports: 100n, liquid_wallet_delta_lamports: -100n },
  });
  ledger.recordBasisObservation({ lifecycle_id: "lp:ReconciliationRequired", source: "rpc", deposit_lamports: 100n });
  ledger.recordBasisObservation({ lifecycle_id: "lp:ReconciliationRequired", source: "rpc", deposit_lamports: 100n });
  ledger.transitionLifecycle("lp:ReconciliationRequired", LIFECYCLE_STATES.ACTIVE);
  ledger.transitionLifecycle("lp:ReconciliationRequired", LIFECYCLE_STATES.CLOSING);
  ledger.transitionLifecycle("lp:ReconciliationRequired", LIFECYCLE_STATES.CLEANUP_PENDING);
  ledger.recordTransaction({
    lifecycle_id: "lp:ReconciliationRequired",
    signature: "reconciliation-failed-cleanup",
    phase: "cleanup",
    execution_status: "failed",
    amounts: { liquid_wallet_delta_lamports: -10n, tx_fee_lamports: 5n },
  });
  const reconciliationRequired = finalizeLifecycleWithStore({
    store: ledger,
    position: "ReconciliationRequired",
    residualTokenValueLamports: "0",
    reclaimableRentLamports: "0",
    terminalEconomics: terminalEvidence(),
    reconciliationId: "cleanup:reconciliation-required",
    ledgerEnabled: true,
    toleranceLamports: 0,
    updateAccounting: () => {},
  });
  assert.equal(reconciliationRequired.blocked, "RECONCILIATION_REQUIRED");
  assert.equal(reconciliationRequired.lifecycle.state, LIFECYCLE_STATES.RECONCILIATION_REQUIRED);
  assert.deepEqual(
    buildSettlementBreakerEvents(reconciliationRequired, "TRAILING_TP").map((event) => event.type),
    ["reconciliation_checked"],
  );
  assert.equal(reconciliationRequired.lifecycle.reconciliation_latched, true,
    "a reconciliation-required settlement leaves durable history, not a mutable state-only flag");
  assert.throws(() => ledger.transitionLifecycle("lp:ReconciliationRequired", LIFECYCLE_STATES.CLOSING),
    /unresolved reconciliation latch/i,
    "a later close cannot silently step around reconciliation-required state");
  ledger.clearReconciliationLatch("lp:ReconciliationRequired", {
    reconciliation_id: "manual-reconciliation:reconciliation-required",
    reason: "isolated explicit reconciliation fixture",
  });
  const explicitlyCleared = ledger.getLifecycle("lp:ReconciliationRequired");
  assert.equal(explicitlyCleared.reconciliation_latched, false);
  assert.deepEqual(explicitlyCleared.reconciliation_history.map((entry) => entry.type), ["latched", "cleared"]);
  ledger.transitionLifecycle("lp:ReconciliationRequired", LIFECYCLE_STATES.CLOSING);

  // Runtime writes are serialized, so concurrent failures persist as two
  // ordered events and retain the manual-resume latch.
  const breakerController = createCircuitBreakerController({
    storage: createMemoryCircuitBreakerStorage(),
    now: () => Date.parse("2026-07-22T00:00:00.000Z"),
  });
  const breaker = createSerializedBreakerRuntime({ controller: breakerController });
  await Promise.all([
    breaker.record({ type: "operation_failure", operation: "cleanup", atMs: Date.parse("2026-07-22T00:00:01.000Z") }),
    breaker.record({ type: "operation_failure", operation: "swap", atMs: Date.parse("2026-07-22T00:00:02.000Z") }),
  ]);
  let breakerState = await breaker.getState();
  assert.equal(breakerState.tripped, true);
  assert.equal(breakerState.manualResumeRequired, true);
  await breaker.manualResume(Date.parse("2026-07-22T00:00:03.000Z"));
  breakerState = await breaker.getState();
  assert.equal(breakerState.tripped, false);
  assert.equal(breakerState.manualResumeRequired, false);

  // A settlement delivery can be retried after any individual breaker write.
  // Deduplication keeps a retry from double-counting loss or re-tripping after
  // the explicit manual resume latch was cleared.
  const deliveryController = createCircuitBreakerController({
    storage: createMemoryCircuitBreakerStorage(),
    now: () => Date.parse("2026-07-22T00:00:00.000Z"),
  });
  const settledLoss = {
    type: "trade_settled",
    eventId: "settlement:lp:Position111:reconciliation:trade_settled",
    netProfitSol: -0.1,
    deployedSol: 1,
    atMs: Date.parse("2026-07-22T00:00:04.000Z"),
  };
  await deliveryController.record(settledLoss);
  assert.equal((await deliveryController.getState()).tripped, true);
  await deliveryController.manualResume(Date.parse("2026-07-22T00:00:05.000Z"));
  await deliveryController.record(settledLoss);
  const dedupedDelivery = await deliveryController.getState();
  assert.equal(dedupedDelivery.tripped, false);
  assert.equal(dedupedDelivery.manualResumeRequired, false);
  assert.equal(dedupedDelivery.consecutiveNetLosses, 0);

  console.log("close cleanup lifecycle tests passed");
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
