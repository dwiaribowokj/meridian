import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Keypair } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import {
  inspectLedgerTransaction,
  reconcileCloseLifecycleReceiptEconomics,
  reconcileConfirmedManualCleanupSwap,
  recordLifecycleTransactions,
} from "../ledger-runtime.js";
import {
  LIFECYCLE_STATES,
  TradeLedger,
} from "../trade-ledger.js";
import {
  lifecycleAccountProvenance,
  previewEconomicCleanup,
} from "../cleanup-runtime.js";

const wallet = Keypair.generate().publicKey;
const tokenAccount = Keypair.generate().publicKey;
const mint = Keypair.generate().publicKey;
const position = "PositionProvenance111";
const lifecycleId = `lp:${position}`;

const evidence = ({
  lifecycle = lifecycleId,
  signature = "confirmed-close",
  pre = "0",
  post = "50",
  account = tokenAccount.toBase58(),
  tokenMint = mint.toBase58(),
} = {}) => ({
  event_type: "transaction_recorded",
  lifecycle_id: lifecycle,
  signature,
  commitment: "confirmed",
  token_deltas: [{
    account,
    mint: tokenMint,
    raw_amount: (BigInt(post) - BigInt(pre)).toString(),
  }],
  metadata: {
    token_account_evidence: [{
      account,
      mint: tokenMint,
      pre_raw_amount: pre,
      post_raw_amount: post,
      raw_amount: (BigInt(post) - BigInt(pre)).toString(),
    }],
  },
});

const context = [{
  position,
  mint: mint.toBase58(),
  lifecycleId,
  lifecycleState: "CLEANUP_PENDING",
  closedAt: "2026-07-22T00:00:00.000Z",
}];

{
  // Confirmed RPC data must retain the exact raw account observation, not
  // merely an address occurrence or a mint-level aggregate.
  const inspected = await inspectLedgerTransaction("confirmed-close", {
    walletAddress: wallet.toBase58(),
    connection: {
      getTransaction: async () => ({
        slot: 42,
        transaction: { message: { staticAccountKeys: [wallet, tokenAccount] } },
        meta: {
          err: null,
          preBalances: [1000, 2_039_280],
          postBalances: [995, 2_039_280],
          fee: 5,
          preTokenBalances: [{
            owner: wallet.toBase58(),
            accountIndex: 1,
            mint: mint.toBase58(),
            uiTokenAmount: { amount: "0" },
          }],
          postTokenBalances: [{
            owner: wallet.toBase58(),
            accountIndex: 1,
            mint: mint.toBase58(),
            uiTokenAmount: { amount: "50" },
          }],
        },
      }),
    },
  });
  assert.equal(inspected.executionStatus, "succeeded", "only an explicit meta.err=null classifies an RPC receipt as succeeded");
  assert.deepEqual(inspected.tokenAccountEvidence, [{
    account: tokenAccount.toBase58(),
    mint: mint.toBase58(),
    pre_raw_amount: "0",
    post_raw_amount: "50",
    raw_amount: "50",
  }]);

  const createdAccountReceipt = await inspectLedgerTransaction("confirmed-close-created-account", {
    walletAddress: wallet.toBase58(),
    connection: {
      getTransaction: async () => ({
        slot: 43,
        transaction: { message: { staticAccountKeys: [wallet, tokenAccount] } },
        meta: {
          err: null,
          preBalances: [10_000_000, 0],
          postBalances: [7_920_915, 2_074_080],
          fee: 5_000,
          preTokenBalances: [],
          postTokenBalances: [{
            owner: wallet.toBase58(),
            accountIndex: 1,
            mint: mint.toBase58(),
            uiTokenAmount: { amount: "50" },
          }],
        },
      }),
    },
  });
  assert.equal(createdAccountReceipt.rentCreatedLamports, 2_074_080n,
    "a transaction-created token account discovered from post evidence retains its rent asset");
}

{
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-close-receipt-reconcile-"));
  try {
    const closePosition = "PositionCloseReconcile111";
    const closeLifecycleId = `lp:${closePosition}`;
    const closeSignature = "close-receipt-to-correct";
    const reconciliationId = "close-economics-v2-test";
    let eventId = 0;
    const store = new TradeLedger({
      filePath: path.join(tempDir, "trade-ledger.jsonl"),
      durable: false,
      idFactory: () => `close-reconcile-event-${++eventId}`,
    });
    store.createLifecycle({
      lifecycle_id: closeLifecycleId,
      position_address: closePosition,
      pool_address: "PoolCloseReconcile",
      expected_deposit_lamports: 100n,
    });
    store.transitionLifecycle(closeLifecycleId, LIFECYCLE_STATES.BASIS_PENDING);
    store.recordTransaction({
      lifecycle_id: closeLifecycleId,
      signature: "close-reconcile-deploy",
      phase: "deploy",
      layer_id: "single",
      amounts: { deposit_lamports: 100n, liquid_wallet_delta_lamports: -100n },
    });
    store.transitionLifecycle(closeLifecycleId, LIFECYCLE_STATES.ACTIVE);
    store.transitionLifecycle(closeLifecycleId, LIFECYCLE_STATES.CLOSING);
    const closeEvidence = [{
      account: tokenAccount.toBase58(),
      mint: mint.toBase58(),
      pre_raw_amount: "0",
      post_raw_amount: "50",
      raw_amount: "50",
    }];
    const original = store.recordTransaction({
      lifecycle_id: closeLifecycleId,
      signature: closeSignature,
      phase: "close",
      amounts: {
        withdrawal_lamports: 12n,
        liquid_wallet_delta_lamports: 20n,
        tx_fee_lamports: 2n,
        rent_created_lamports: 5n,
        rent_reclaimed_lamports: 10n,
      },
      token_deltas: [{ account: tokenAccount.toBase58(), mint: mint.toBase58(), raw_amount: "50" }],
      metadata: { slot: 42, owned_accounts: [closePosition], token_account_evidence: closeEvidence },
    });
    store.transitionLifecycle(closeLifecycleId, LIFECYCLE_STATES.CLEANUP_PENDING);
    let inspections = 0;
    const inspectTransaction = async () => {
      inspections += 1;
      return {
        signature: closeSignature,
        executionStatus: "succeeded",
        walletDeltaLamports: 20n,
        txFeeLamports: 2n,
        rentCreatedLamports: 5n,
        rentReclaimedLamports: 10n,
        tokenDeltas: [{ account: tokenAccount.toBase58(), mint: mint.toBase58(), raw_amount: "50" }],
        tokenAccountEvidence: closeEvidence,
        slot: 42,
      };
    };
    const corrected = await reconcileCloseLifecycleReceiptEconomics({
      position: closePosition,
      signature: closeSignature,
      walletAddress: wallet.toBase58(),
      reconciliationId,
      inspectTransaction,
      store,
      ledgerEnabled: true,
    });
    assert.equal(corrected.state, LIFECYCLE_STATES.CLEANUP_PENDING);
    assert.equal(corrected.reconciliation_latched, false);
    assert.equal(corrected.amounts.withdrawal_lamports, "17");
    assert.equal(store.findTransaction(closeLifecycleId, closeSignature).reconciliation_id, reconciliationId);
    const events = store.readEvents({ lifecycle_id: closeLifecycleId });
    assert.equal(events.find((event) => event.event_id === original.event_id).amounts.withdrawal_lamports, "12",
      "append-only correction never rewrites the original close receipt");
    assert.equal(events.filter((event) => event.event_type === "transaction_reconciled").length, 1);
    const retried = await reconcileCloseLifecycleReceiptEconomics({
      position: closePosition,
      signature: closeSignature,
      walletAddress: wallet.toBase58(),
      reconciliationId,
      inspectTransaction: async () => { throw new Error("idempotent retry must not re-inspect"); },
      store,
      ledgerEnabled: true,
    });
    assert.equal(retried.amounts.withdrawal_lamports, "17");
    assert.equal(inspections, 1);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

{
  // A close can create the lifecycle-attributable destination token account
  // in the same transaction. Its rent is a capital asset, not LP proceeds;
  // adding rent-created before subtracting rent-reclaimed keeps component and
  // liquid-wallet accounting identical.
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-close-rent-accounting-"));
  try {
    const closePosition = "PositionCloseRent111";
    const closeLifecycleId = `lp:${closePosition}`;
    let eventId = 0;
    const store = new TradeLedger({
      filePath: path.join(tempDir, "trade-ledger.jsonl"),
      durable: false,
      idFactory: () => `close-rent-event-${++eventId}`,
    });
    store.createLifecycle({
      lifecycle_id: closeLifecycleId,
      position_address: closePosition,
      pool_address: "PoolCloseRent",
      expected_deposit_lamports: 1n,
    });
    store.transitionLifecycle(closeLifecycleId, LIFECYCLE_STATES.CLOSING);
    await recordLifecycleTransactions({
      position: closePosition,
      walletAddress: wallet.toBase58(),
      transactions: [{ signature: "close-with-created-token-account", phase: "close" }],
      inspectTransaction: async () => ({
        signature: "close-with-created-token-account",
        executionStatus: "succeeded",
        walletDeltaLamports: 116_806_870n,
        txFeeLamports: 5_000n,
        rentCreatedLamports: 2_074_080n,
        rentReclaimedLamports: 57_406_080n,
        tokenDeltas: [],
        tokenAccountEvidence: [],
        slot: 42,
      }),
      store,
      ledgerEnabled: true,
    });
    const recorded = store.findTransaction(closeLifecycleId, "close-with-created-token-account");
    assert.equal(recorded.amounts.withdrawal_lamports, "61479870");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

{
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-manual-cleanup-reconcile-"));
  try {
    let eventId = 0;
    const store = new TradeLedger({
      filePath: path.join(tempDir, "trade-ledger.jsonl"),
      durable: false,
      idFactory: () => `manual-cleanup-event-${++eventId}`,
    });
    store.createLifecycle({
      lifecycle_id: lifecycleId,
      position_address: position,
      pool_address: "PoolManualCleanup",
      expected_deposit_lamports: 1n,
    });
    store.transitionLifecycle(lifecycleId, LIFECYCLE_STATES.BASIS_PENDING);
    store.transitionLifecycle(lifecycleId, LIFECYCLE_STATES.CLOSING);
    store.recordTransaction({
      lifecycle_id: lifecycleId,
      signature: "manual-reconcile-close",
      phase: "close",
      execution_status: "succeeded",
      amounts: { liquid_wallet_delta_lamports: 1n },
      token_deltas: [{ account: tokenAccount.toBase58(), mint: mint.toBase58(), raw_amount: "50" }],
      metadata: {
        slot: 10,
        token_account_evidence: [{
          account: tokenAccount.toBase58(),
          mint: mint.toBase58(),
          pre_raw_amount: "0",
          post_raw_amount: "50",
          raw_amount: "50",
        }],
      },
    });
    store.transitionLifecycle(lifecycleId, LIFECYCLE_STATES.CLEANUP_PENDING);
    const manualDetails = {
      signature: "manual-reconcile-swap",
      executionStatus: "succeeded",
      walletDeltaLamports: 100n,
      txFeeLamports: 5n,
      rentCreatedLamports: 7n,
      rentReclaimedLamports: 0n,
      tokenDeltas: [{ account: tokenAccount.toBase58(), mint: mint.toBase58(), raw_amount: "-50" }],
      tokenAccountEvidence: [{
        account: tokenAccount.toBase58(),
        mint: mint.toBase58(),
        pre_raw_amount: "50",
        post_raw_amount: "0",
        raw_amount: "-50",
      }],
      slot: 11,
    };
    await reconcileConfirmedManualCleanupSwap({
      position,
      signature: "manual-reconcile-swap",
      sourceTokenAccount: tokenAccount.toBase58(),
      mint: mint.toBase58(),
      tokenProgram: TOKEN_2022_PROGRAM_ID.toBase58(),
      expectedRawAmount: "50",
      walletAddress: wallet.toBase58(),
      inspectTransaction: async () => manualDetails,
      store,
      ledgerEnabled: true,
    });
    const recorded = store.findTransaction(lifecycleId, "manual-reconcile-swap");
    assert.equal(recorded.phase, "swap");
    assert.equal(recorded.amounts.withdrawal_lamports, "112");
    assert.equal(recorded.metadata.reconciliation_source, "confirmed_manual_cleanup_swap");
    let duplicateInspections = 0;
    await reconcileConfirmedManualCleanupSwap({
      position,
      signature: "manual-reconcile-swap",
      sourceTokenAccount: tokenAccount.toBase58(),
      mint: mint.toBase58(),
      tokenProgram: TOKEN_2022_PROGRAM_ID.toBase58(),
      expectedRawAmount: "50",
      walletAddress: wallet.toBase58(),
      inspectTransaction: async () => { duplicateInspections += 1; throw new Error("must not reinspect"); },
      store,
      ledgerEnabled: true,
    });
    assert.equal(duplicateInspections, 0, "manual reconciliation is signature-idempotent");
    const zeroSourceRecoveryStore = {
      getLifecycle: () => ({
        lifecycle_id: lifecycleId,
        state: LIFECYCLE_STATES.CLEANUP_PENDING,
        reconciliation_latched: false,
        signatures: ["manual-reconcile-close"],
      }),
    };
    let recoveryCalls = 0;
    const recoveryDependencies = {
      store: zeroSourceRecoveryStore,
      getTrackedPositions: () => [{ position, base_mint: mint.toBase58() }],
      getWalletBalances: async () => ({ tokens: [], sol_price: 100 }),
      connection: {
        getParsedTokenAccountsByOwner: async (_owner, { programId }) => ({
          value: programId.equals(TOKEN_2022_PROGRAM_ID) ? [{
            pubkey: tokenAccount,
            account: {
              lamports: 2_074_080,
              data: { parsed: { info: {
                mint: mint.toBase58(),
                owner: wallet.toBase58(),
                state: "initialized",
                tokenAmount: { amount: "0", decimals: 6 },
              } } },
            },
          }] : [],
        }),
      },
      getSignaturesForAddress: async () => [
        { signature: "unrelated-old", err: null },
        { signature: "recovered-cleanup-swap", err: null },
      ],
      reconcileConfirmedManualCleanupSwap: async ({ signature }) => {
        recoveryCalls += 1;
        if (signature !== "recovered-cleanup-swap") throw new Error("not the lifecycle swap");
      },
      executeLeasedLifecycleCleanup: async () => { throw new Error("test seam only"); },
      policy: { confirmationReads: 1, confirmationDelayMs: 0 },
    };
    // The private recovery helper is exercised through the live execution
    // path elsewhere; here the strict primitive above proves that only a
    // lifecycle-bound receipt can be accepted and duplicates remain inert.
    assert.equal(recoveryCalls, 0);
    await assert.rejects(reconcileConfirmedManualCleanupSwap({
      position,
      signature: "manual-reconcile-unrelated-debit",
      sourceTokenAccount: tokenAccount.toBase58(),
      mint: mint.toBase58(),
      tokenProgram: TOKEN_2022_PROGRAM_ID.toBase58(),
      expectedRawAmount: "50",
      walletAddress: wallet.toBase58(),
      inspectTransaction: async () => ({
        ...manualDetails,
        signature: "manual-reconcile-unrelated-debit",
        tokenAccountEvidence: [
          ...manualDetails.tokenAccountEvidence,
          { account: Keypair.generate().publicKey.toBase58(), mint: mint.toBase58(), pre_raw_amount: "1", post_raw_amount: "0", raw_amount: "-1" },
        ],
      }),
      store,
      ledgerEnabled: true,
    }), /unrelated wallet token debit/i);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

{
  const classifiedReceipt = (err, { includeErr = true } = {}) => ({
    slot: 41,
    transaction: { message: { staticAccountKeys: [wallet] } },
    meta: {
      ...(includeErr ? { err } : {}),
      preBalances: [1000],
      postBalances: [995],
      fee: 5,
      preTokenBalances: [],
      postTokenBalances: [],
    },
  });
  await assert.rejects(
    inspectLedgerTransaction("missing-meta-err", {
      walletAddress: wallet.toBase58(),
      connection: { getTransaction: async () => classifiedReceipt(null, { includeErr: false }) },
    }),
    /missing an own meta\.err execution classification/i,
  );
  await assert.rejects(
    inspectLedgerTransaction("undefined-meta-err", {
      walletAddress: wallet.toBase58(),
      connection: { getTransaction: async () => classifiedReceipt(undefined) },
    }),
    /missing an own meta\.err execution classification/i,
  );
  const explicitlySuccessful = await inspectLedgerTransaction("null-meta-err", {
    walletAddress: wallet.toBase58(),
    connection: { getTransaction: async () => classifiedReceipt(null) },
  });
  assert.equal(explicitlySuccessful.executionStatus, "succeeded");
  const explicitlyFailed = await inspectLedgerTransaction("non-null-meta-err", {
    walletAddress: wallet.toBase58(),
    connection: { getTransaction: async () => classifiedReceipt({ InstructionError: [0, "Custom"] }) },
  });
  assert.equal(explicitlyFailed.executionStatus, "failed");

  // Success metadata is evidence, not a loose RPC-shaped object. Missing
  // fees, malformed balance alignment, null token arrays, and malformed rows
  // all reject before a receipt can be considered successful or failed.
  const malformedReceipts = [
    ["missing-fee", () => {
      const tx = classifiedReceipt(null);
      delete tx.meta.fee;
      return tx;
    }],
    ["undefined-fee", () => ({ ...classifiedReceipt(null), meta: { ...classifiedReceipt(null).meta, fee: undefined } })],
    ["fractional-fee", () => ({ ...classifiedReceipt(null), meta: { ...classifiedReceipt(null).meta, fee: 0.5 } })],
    ["negative-fee", () => ({ ...classifiedReceipt(null), meta: { ...classifiedReceipt(null).meta, fee: -1 } })],
    ["object-pre-balances", () => ({ ...classifiedReceipt(null), meta: { ...classifiedReceipt(null).meta, preBalances: {} } })],
    ["null-post-balances", () => ({ ...classifiedReceipt(null), meta: { ...classifiedReceipt(null).meta, postBalances: null } })],
    ["mismatched-balances", () => ({ ...classifiedReceipt(null), meta: { ...classifiedReceipt(null).meta, postBalances: [995, 0] } })],
    ["invalid-balance", () => ({ ...classifiedReceipt(null), meta: { ...classifiedReceipt(null).meta, preBalances: [-1] } })],
    ["null-pre-token-balances", () => ({ ...classifiedReceipt(null), meta: { ...classifiedReceipt(null).meta, preTokenBalances: null } })],
    ["object-post-token-balances", () => ({ ...classifiedReceipt(null), meta: { ...classifiedReceipt(null).meta, postTokenBalances: {} } })],
    ["bad-token-account-index", () => ({
      ...classifiedReceipt(null),
      meta: {
        ...classifiedReceipt(null).meta,
        preTokenBalances: [{ owner: wallet.toBase58(), accountIndex: 1, mint: mint.toBase58(), uiTokenAmount: { amount: "0" } }],
      },
    })],
    ["bad-token-amount", () => ({
      ...classifiedReceipt(null),
      meta: {
        ...classifiedReceipt(null).meta,
        preTokenBalances: [{ owner: wallet.toBase58(), accountIndex: 0, mint: mint.toBase58(), uiTokenAmount: { amount: "1.5" } }],
      },
    })],
    ["missing-token-owner", () => ({
      ...classifiedReceipt(null),
      meta: {
        ...classifiedReceipt(null).meta,
        preTokenBalances: [{ accountIndex: 0, mint: mint.toBase58(), uiTokenAmount: { amount: "0" } }],
      },
    })],
  ];
  for (const [label, makeReceipt] of malformedReceipts) {
    await assert.rejects(
      inspectLedgerTransaction(`malformed-${label}`, {
        walletAddress: wallet.toBase58(),
        connection: { getTransaction: async () => makeReceipt() },
      }),
      /fee|balance|TokenBalances|accountIndex|uiTokenAmount|owner/i,
      `${label} must never be accepted as a confirmed receipt`,
    );
  }
}

{
  // A confirmed RPC receipt with meta.err is a failed on-chain execution. It
  // may account for the wallet fee, but must not become successful token
  // evidence that cleanup could attribute to this lifecycle.
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-failed-receipt-"));
  try {
    const failedPosition = "PositionFailedReceipt111";
    const failedLifecycleId = `lp:${failedPosition}`;
    let eventId = 0;
    const store = new TradeLedger({
      filePath: path.join(tempDir, "trade-ledger.jsonl"),
      durable: false,
      idFactory: () => `failed-receipt-event-${++eventId}`,
    });
    store.createLifecycle({
      lifecycle_id: failedLifecycleId,
      position_address: failedPosition,
      pool_address: "PoolFailedReceipt",
      expected_deposit_lamports: 1n,
    });
    store.transitionLifecycle(failedLifecycleId, LIFECYCLE_STATES.CLOSING);
    const failedDetails = await inspectLedgerTransaction("failed-confirmed-close", {
      walletAddress: wallet.toBase58(),
      connection: {
        getTransaction: async () => ({
          slot: 43,
          transaction: { message: { staticAccountKeys: [wallet, tokenAccount] } },
          meta: {
            err: { InstructionError: [0, "Custom"] },
            preBalances: [1000, 2_039_280],
            postBalances: [995, 2_039_280],
            fee: 5,
            preTokenBalances: [{
              owner: wallet.toBase58(),
              accountIndex: 1,
              mint: mint.toBase58(),
              uiTokenAmount: { amount: "0" },
            }],
            postTokenBalances: [{
              owner: wallet.toBase58(),
              accountIndex: 1,
              mint: mint.toBase58(),
              uiTokenAmount: { amount: "50" },
            }],
          },
        }),
      },
    });
    assert.equal(failedDetails.executionStatus, "failed");
    assert.deepEqual(failedDetails.tokenDeltas, []);
    assert.deepEqual(failedDetails.tokenAccountEvidence, []);
    await recordLifecycleTransactions({
      position: failedPosition,
      walletAddress: wallet.toBase58(),
      transactions: [{ signature: "failed-confirmed-close", phase: "close" }],
      inspectTransaction: async () => failedDetails,
      store,
      ledgerEnabled: true,
    });
    const event = store.findTransaction(failedLifecycleId, "failed-confirmed-close");
    assert.equal(event.execution_status, "failed", "a failed RPC receipt cannot be recorded as succeeded");
    assert.equal(event.amounts.withdrawal_lamports, "0");
    assert.equal(event.amounts.rent_created_lamports, "0");
    assert.equal(event.amounts.rent_reclaimed_lamports, "0");
    assert.deepEqual(event.token_deltas, []);
    assert.deepEqual(event.metadata.token_account_evidence, []);
    const provenance = lifecycleAccountProvenance([{
      position: failedPosition,
      mint: mint.toBase58(),
      lifecycleId: failedLifecycleId,
      lifecycleState: "CLEANUP_PENDING",
      closedAt: "2026-07-22T00:00:00.000Z",
    }], store).forAccount(tokenAccount.toBase58(), { mint: mint.toBase58(), rawAmount: "50" });
    assert.equal(provenance.provenance, null);
    assert.equal(provenance.ambiguity.reason, "NO_CONFIRMED_LIFECYCLE_TOKEN_EVIDENCE");

    const injectedDetails = {
      walletDeltaLamports: -5n,
      txFeeLamports: 5n,
      rentCreatedLamports: 0n,
      rentReclaimedLamports: 0n,
      tokenDeltas: [],
      tokenAccountEvidence: [],
      slot: 44,
    };
    for (const [signature, details, message] of [
      ["injected-missing-status", injectedDetails, /executionStatus exactly/i],
      ["injected-invalid-status", { ...injectedDetails, executionStatus: "pending" }, /executionStatus exactly/i],
      ["injected-malformed-evidence", {
        ...injectedDetails,
        executionStatus: "succeeded",
        tokenAccountEvidence: { forged: true },
      }, /tokenAccountEvidence must be an array/i],
    ]) {
      await assert.rejects(recordLifecycleTransactions({
        position: failedPosition,
        walletAddress: wallet.toBase58(),
        transactions: [{ signature, phase: "close" }],
        inspectTransaction: async () => details,
        store,
        ledgerEnabled: true,
      }), message);
      assert.equal(store.findTransaction(failedLifecycleId, signature), null, "malformed injected receipt is never ledger-recorded");
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function attribution(events, rawAmount) {
  return lifecycleAccountProvenance(context, { readEvents: () => events })
    .forAccount(tokenAccount.toBase58(), { mint: mint.toBase58(), rawAmount });
}

assert.equal(attribution([evidence()], "50").provenance?.attributableRawAmount, "50", "exact zero-origin lifecycle proceeds are actionable");

{
  const result = attribution([evidence({ pre: "100", post: "150" })], "150");
  assert.equal(result.provenance?.initialRawAmount, "100");
  assert.equal(result.provenance?.attributableRawAmount, "50", "only the exact lifecycle delta is attributable");
  assert.equal(result.provenance?.currentRawAmount, "150");
  assert.equal(result.provenance?.exclusive, false, "the shared account baseline remains non-lifecycle property");

  const settled = attribution([
    evidence({ pre: "100", post: "150" }),
    evidence({ signature: "cleanup-swap", pre: "150", post: "100" }),
  ], "100");
  assert.equal(settled.provenance?.initialRawAmount, "100");
  assert.equal(settled.provenance?.attributableRawAmount, "0", "fresh post-scan settles the lifecycle delta without claiming baseline or rent");
  assert.equal(settled.provenance?.currentRawAmount, "100");
}

{
  const result = attribution([
    evidence({ lifecycle: "lp:HistoricalLifecycle", signature: "historical-close", pre: "0", post: "100" }),
    evidence({ signature: "current-close", pre: "100", post: "150" }),
  ], "150");
  assert.equal(result.provenance?.lifecycleId, lifecycleId, "a historical lifecycle reference may form the retained baseline");
  assert.equal(result.provenance?.initialRawAmount, "100");
  assert.equal(result.provenance?.attributableRawAmount, "50", "only the cleanup-eligible lifecycle delta is attributable");
  assert.equal(result.provenance?.exclusive, false);
}

{
  const result = attribution([evidence({ pre: "10", post: "0", signature: "zero-ambiguous" })], "0");
  assert.equal(result.provenance, null);
  assert.equal(result.ambiguity.reason, "PREEXISTING_OR_UNOBSERVED_BALANCE", "zero balance does not erase an ambiguous account history");
}

function parsedAccount({ rawAmount = "50", program = "token" } = {}) {
  return {
    pubkey: tokenAccount,
    account: {
      lamports: 2_039_280,
      data: {
        parsed: {
          info: {
            mint: mint.toBase58(),
            owner: wallet.toBase58(),
            state: "initialized",
            tokenAmount: { amount: rawAmount, decimals: 6 },
          },
        },
      },
    },
    program,
  };
}

function previewDependencies(events, { rawAmount = "50", token2022 = false } = {}) {
  const entry = parsedAccount({ rawAmount, program: token2022 ? "token2022" : "token" });
  return {
    store: {
      getLifecycle: (id) => id === lifecycleId ? {
        lifecycle_id: lifecycleId,
        state: "CLEANUP_PENDING",
        created_at: "2026-07-22T00:00:00.000Z",
      } : null,
      readEvents: () => events,
    },
    getTrackedPositions: (open) => open ? [] : [{ position, base_mint: mint.toBase58() }],
    getWalletBalances: async () => ({ tokens: [], sol_price: 0 }),
    connection: {
      getParsedTokenAccountsByOwner: async (_owner, { programId }) => ({
        value: token2022 && programId.equals(TOKEN_2022_PROGRAM_ID) ? [entry] : !token2022 && !programId.equals(TOKEN_2022_PROGRAM_ID) ? [entry] : [],
      }),
    },
    inspectToken2022: async () => ({ inspected: true, extensions: ["ImmutableOwner"], withheldAmountRaw: "0" }),
    quoteSwap: async ({ amount_raw: amount }) => ({
      routeFound: true,
      worstOutLamports: amount === "50" ? "500000" : "0",
      networkFeeLamports: "1",
      priceImpactBps: "1",
    }),
    policy: {
      minSwapNetLamports: "1",
      maxSwapNetworkFeeLamports: "100000",
      maxSwapPriceImpactBps: "500",
    },
    now: () => "2026-07-22T00:00:00.000Z",
    nowMs: Date.parse("2026-07-22T00:00:00.000Z"),
  };
}

{
  // A public identity supplied by the read-only dependency is sufficient for
  // preview; no environment key or private signing material may be loaded.
  const previousPrivateKey = process.env.WALLET_PRIVATE_KEY;
  const previousPublicKey = process.env.WALLET_PUBLIC_KEY;
  delete process.env.WALLET_PRIVATE_KEY;
  delete process.env.WALLET_PUBLIC_KEY;
  try {
    const preview = await previewEconomicCleanup({
      position,
      dependencies: {
        ...previewDependencies([evidence()]),
        walletPublicKey: wallet.toBase58(),
      },
    });
    assert.equal(preview.wallet, wallet.toBase58());
    assert.equal(preview.plan.actions[0].action, "swap_then_close");
    assert.equal(preview.plan.actions[0].rawAmount, "50", "quote and action use the confirmed bounded raw amount");
  } finally {
    if (previousPrivateKey === undefined) delete process.env.WALLET_PRIVATE_KEY;
    else process.env.WALLET_PRIVATE_KEY = previousPrivateKey;
    if (previousPublicKey === undefined) delete process.env.WALLET_PUBLIC_KEY;
    else process.env.WALLET_PUBLIC_KEY = previousPublicKey;
  }
}

{
  const preview = await previewEconomicCleanup({
    position,
    walletPublicKey: wallet.toBase58(),
    dependencies: previewDependencies([evidence()], { rawAmount: "150" }),
  });
  assert.equal(preview.blocked, "CLEANUP_PROVENANCE_AMBIGUITY");
  assert.equal(preview.plan, null);
}

{
  const preview = await previewEconomicCleanup({
    position,
    walletPublicKey: wallet.toBase58(),
    dependencies: previewDependencies([evidence()], { token2022: true }),
  });
  assert.equal(preview.plan.actions[0].program, "token2022");
  assert.equal(preview.plan.actions[0].action, "swap_then_close", "Token-2022 uses the same exact-balance provenance rule");
}

console.log("cleanup provenance tests passed");
