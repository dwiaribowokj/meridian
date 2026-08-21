import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import {
  PROTECTED_STABLECOIN_MINTS,
  TOKEN_PROGRAMS,
  WRAPPED_SOL_MINT,
  buildTokenCleanupInstructions,
  executeTokenCleanup,
  parseRawInteger,
  planCleanupBatches,
  planTokenCleanup,
} from "../tools/token-cleanup.js";

const NOW = Date.parse("2026-07-18T00:00:00Z");
const OLD = new Date(NOW - 25 * 60 * 60 * 1000).toISOString();
const YOUNG = new Date(NOW - 60 * 60 * 1000).toISOString();

const bot = (lifecycleId, tokenAccount, rawAmount = "1") => ({
  provenance: {
    source: "bot_lifecycle",
    lifecycleId,
    evidence: "confirmed_lifecycle_token_delta",
    accountAddress: tokenAccount,
    initialRawAmount: "0",
    attributableRawAmount: String(rawAmount),
    currentRawAmount: String(rawAmount),
    exclusive: true,
  },
});
const account = (tokenAccount, overrides = {}) => {
  const value = {
    tokenAccount,
    mint: `mint-${tokenAccount}`,
    programId: TOKEN_PROGRAMS.token,
    rawAmount: "1",
    decimals: 6,
    rentLamports: "2039280",
    markedValueLamports: "100000",
    markedAt: OLD,
    ...overrides,
  };
  if (!Object.hasOwn(overrides, "provenance")) Object.assign(value, bot(`lifecycle-${tokenAccount}`, tokenAccount, value.rawAmount));
  return value;
};

assert.equal(parseRawInteger("900719925474099312345").toString(), "900719925474099312345");
assert.throws(() => parseRawInteger(1.5), /integer/);
assert.throws(() => parseRawInteger(Number.MAX_SAFE_INTEGER + 1), /safe integer/);

const accounts = [
  account("zero-token", { rawAmount: "0" }),
  account("zero-2022", {
    rawAmount: "0",
    programId: TOKEN_PROGRAMS.token2022,
    extensions: ["TransferHook"],
  }),
  account("wsol", { mint: WRAPPED_SOL_MINT, rawAmount: "123456789" }),
  account("economic", { rawAmount: "999999999999999999" }),
  account("stable", { mint: PROTECTED_STABLECOIN_MINTS[0] }),
  account("unknown", { provenance: null, lifecycleId: null }),
  account("frozen", { frozen: true }),
  account("delegated", { delegate: "delegate-address" }),
  account("unsupported-2022", {
    programId: TOKEN_PROGRAMS.token2022,
    extensions: ["ImmutableOwner", "TransferHook"],
  }),
  account("safe-2022", {
    programId: TOKEN_PROGRAMS.token2022,
    extensions: ["ImmutableOwner"],
  }),
  account("uninspected-2022", { programId: TOKEN_PROGRAMS.token2022 }),
  account("young-no-route", { markedAt: YOUNG }),
  account("uneconomic-route", { markedAt: YOUNG }),
  account("quote-error"),
  account("fractional", { rawAmount: "0.1" }),
];

const quotes = {
  economic: {
    routeFound: true,
    worstOutLamports: "250000",
    worstNetLamports: "999999", // must be capped by output minus fee
    networkFeeLamports: "50000",
    priceImpactBps: "200",
  },
  "uneconomic-route": {
    routeFound: true,
    worstOutLamports: "100000",
    networkFeeLamports: "50000",
    priceImpactBps: "100",
  },
};

const plan = await planTokenCleanup(accounts, {
  now: NOW,
  quoteSwap: async ({ tokenAccount }) => {
    if (tokenAccount === "quote-error") throw new Error("temporary quote outage");
    return quotes[tokenAccount] || { routeFound: false };
  },
});

const byAccount = Object.fromEntries(plan.actions.map((action) => [action.tokenAccount, action]));
assert.equal(byAccount["zero-token"].action, "close");
assert.equal(byAccount["zero-2022"].action, "close", "unsupported extensions do not block closing zero accounts");
assert.equal(byAccount.wsol.action, "unwrap");
assert.equal(byAccount.economic.action, "swap_then_close");
assert.equal(byAccount.economic.quote.worstNetLamports, "200000", "optimistic adapter net must be capped");
assert.equal(byAccount.stable.reason, "protected_mint_no_economic_swap");
assert.equal(byAccount.unknown.reason, "unknown_provenance");
assert.equal(byAccount.frozen.reason, "frozen_account");
assert.equal(byAccount.delegated.reason, "delegated_account");
assert.equal(byAccount["unsupported-2022"].reason, "token_2022_unsupported_extensions");
assert.equal(byAccount["safe-2022"].action, "burn_then_close");
assert.equal(byAccount["uninspected-2022"].reason, "token_2022_unsupported_extensions");
assert.equal(byAccount["young-no-route"].reason, "no_route_residue_too_young");
assert.equal(byAccount["uneconomic-route"].action, "burn_then_close", "an uneconomic real route need not age 24h");
assert.equal(byAccount["quote-error"].reason, "quote_unavailable", "quote errors must not be treated as confirmed no-route");
assert.equal(byAccount.fractional.reason, "invalid_raw_amount");
assert.doesNotThrow(() => JSON.stringify(plan));

// Sharing a lifecycle mint is never evidence that this particular account
// belongs to it. Even a favorable route must leave the holding untouched.
const mintOnlyProvenance = await planTokenCleanup([
  account("unrelated-positive", {
    mint: "lifecycle-mint",
    provenance: {
      source: "bot_lifecycle",
      lifecycleId: "lp:known-lifecycle",
      evidence: "confirmed_lifecycle_token_delta",
      accountAddress: "different-token-account",
      initialRawAmount: "0",
      attributableRawAmount: "1",
      currentRawAmount: "1",
      exclusive: true,
    },
  }),
  account("safe-zero", { rawAmount: "0", inUseByOpenPosition: true }),
], {
  now: NOW,
  quoteSwap: async () => ({
    routeFound: true,
    worstOutLamports: "500000",
    networkFeeLamports: "1",
    priceImpactBps: "1",
  }),
});
const mintOnlyByAccount = Object.fromEntries(mintOnlyProvenance.actions.map((action) => [action.tokenAccount, action]));
assert.equal(mintOnlyByAccount["unrelated-positive"].action, "keep");
assert.equal(mintOnlyByAccount["unrelated-positive"].reason, "provenance_ambiguity");
assert.equal(mintOnlyByAccount["safe-zero"].reason, "account_in_use_by_open_position", "a zero account shared with an open position remains untouched");

const delegatedZero = await planTokenCleanup([
  account("delegated-zero", { rawAmount: "0", delegate: "delegate-address" }),
], { now: NOW, quoteSwap: async () => ({ routeFound: false }) });
assert.equal(delegatedZero.actions[0].action, "keep");
assert.equal(delegatedZero.actions[0].reason, "delegated_account", "zero balance does not permit removing a delegated account");

const sameMintPlan = await planTokenCleanup([
  account("same-a", { mint: "same-mint", markedValueLamports: "300000" }),
  account("same-b", { mint: "same-mint", markedValueLamports: "300000" }),
], { now: NOW, quoteSwap: async () => ({ routeFound: false }) });
assert.ok(sameMintPlan.actions.every((action) => action.reason === "burn_value_cap_exceeded_per_mint"));

const sweepPlan = await planTokenCleanup(
  Array.from({ length: 5 }, (_, index) => account(`cap-${index}`, { markedValueLamports: "500000" })),
  { now: NOW, quoteSwap: async () => ({ routeFound: false }) },
);
assert.equal(sweepPlan.actions.filter((action) => action.action === "burn_then_close").length, 4);
assert.equal(sweepPlan.actions.filter((action) => action.reason === "burn_sweep_cap_exceeded").length, 1);

{
  let quoteCalls = 0;
  const partial = await planTokenCleanup([
    account("preexisting-plus-proceeds", {
      rawAmount: "150",
      ...bot("lp:partial", "preexisting-plus-proceeds", "50"),
    }),
  ], {
    now: NOW,
    quoteSwap: async () => {
      quoteCalls += 1;
      return { routeFound: true, worstOutLamports: "500000", networkFeeLamports: "1", priceImpactBps: "1" };
    },
  });
  assert.equal(partial.actions[0].action, "keep");
  assert.equal(partial.actions[0].reason, "provenance_balance_mismatch");
  assert.equal(quoteCalls, 0, "inconsistent provenance is never quoted");
}

{
  let swapCalls = 0;
  const result = await executeTokenCleanup({
    policy: { confirmationReads: 1, confirmationDelayMs: 0 },
    actions: [{
      action: "swap_then_close",
      tokenAccount: "bounded-source",
      mint: "bounded-mint",
      rawAmount: "50",
      ...bot("lp:bounded", "bounded-source", "50"),
    }],
  }, {
    walletPublicKey: "bounded-cleanup-wallet",
    wait: async () => {},
    readAccount: async () => ({ exists: true, rawAmount: "150" }),
    prepareSwap: async () => {
      swapCalls += 1;
      return { success: true };
    },
    submitPreparedSwap: async () => ({ success: true, signature: "should-not-submit" }),
    measureBatch: async () => ({ serializedBytes: 100, feeLamports: 5_000 }),
    simulateBatch: async () => ({ success: true }),
    executeBatch: async () => ({ success: true }),
  }, { execute: true });
  assert.equal(result.failures[0].stage, "preflight");
  assert.equal(swapCalls, 0, "execution must not submit a bounded swap after the live account exceeds its proof");
}

const batchActions = [
  ...Array.from({ length: 11 }, (_, index) => ({ action: "burn_then_close", tokenAccount: `burn-${index}` })),
  ...Array.from({ length: 21 }, (_, index) => ({ action: "close", tokenAccount: `close-${index}` })),
];
const packed = await planCleanupBatches(batchActions, {
  measureBatch: async (items) => ({
    serializedBytes: 100 + items.length * 120,
    feeLamports: items.length * 3000,
  }),
});
assert.equal(packed.rejected.length, 0);
assert.ok(packed.batches.every((batch) => Number(batch.serializedBytes) <= 1100));
assert.ok(packed.batches.every((batch) => Number(batch.feeLamports) <= 20000));
assert.ok(packed.batches.filter((batch) => batch.kind === "burn_then_close").every((batch) => batch.actions.length <= 10));
assert.ok(packed.batches.filter((batch) => batch.kind === "close_only").every((batch) => batch.actions.length <= 20));

const oversized = await planCleanupBatches([{ action: "close", tokenAccount: "huge" }], {
  measureBatch: async () => ({ serializedBytes: 1101, feeLamports: 5000 }),
});
assert.equal(oversized.batches.length, 0);
assert.equal(oversized.rejected[0].reason, "serialized_size_cap_exceeded");

{
  const owner = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const tokenAccount = Keypair.generate().publicKey;
  const legacy = buildTokenCleanupInstructions({
    action: "burn_then_close",
    tokenAccount: tokenAccount.toBase58(),
    mint: mint.toBase58(),
    programId: TOKEN_PROGRAMS.token,
    rawAmount: "1844674407370955161",
    decimals: 9,
    owner: owner.toBase58(),
  });
  assert.equal(legacy.length, 2);
  assert.ok(legacy.every((instruction) => instruction.programId.toBase58() === TOKEN_PROGRAMS.token));

  const token2022 = buildTokenCleanupInstructions({
    action: "close",
    tokenAccount: tokenAccount.toBase58(),
    mint: mint.toBase58(),
    programId: TOKEN_PROGRAMS.token2022,
    rawAmount: "0",
    decimals: 9,
    owner: owner.toBase58(),
  });
  assert.equal(token2022.length, 1);
  assert.equal(token2022[0].programId.toBase58(), TOKEN_PROGRAMS.token2022);
}

{
  const executionPlan = {
    policy: {
      confirmationReads: 2,
      confirmationDelayMs: 0,
      minSwapNetLamports: "1",
      maxSwapNetworkFeeLamports: "10",
      maxSwapPriceImpactBps: "10",
    },
    actions: [
      {
        action: "swap_then_close",
        tokenAccount: "swap-source",
        mint: "mint-swap",
        programId: TOKEN_PROGRAMS.token,
        rawAmount: "10",
        quote: {
          routeFound: true,
          worstOutLamports: "2",
          worstNetLamports: "1",
          networkFeeLamports: "1",
          priceImpactBps: "1",
        },
        ...bot("lp:swap", "swap-source", "10"),
      },
      { action: "close", tokenAccount: "zero-source", mint: "mint-zero", rawAmount: "0", ...bot("lp:zero", "zero-source", "0") },
    ],
  };
  const state = new Map([
    ["swap-source", 10n],
    ["zero-source", 0n],
  ]);
  let simulationCalls = 0;
  let executionCalls = 0;
  const dependencies = {
    walletPublicKey: "cleanup-wallet",
    wait: async () => {},
    readAccount: async (action) => state.has(action.tokenAccount)
      ? {
        exists: true,
        tokenAccount: action.tokenAccount,
        rawAmount: state.get(action.tokenAccount).toString(),
        owner: "cleanup-wallet",
        mint: action.mint,
        programId: action.programId || TOKEN_PROGRAMS.token,
      }
      : null,
    prepareSwap: async (action) => ({
      success: true,
      preparedSwap: { source: action.tokenAccount },
      sourceAccountAudit: {
        inspection: "local_instruction_inspection",
        sourceTokenAccount: action.tokenAccount,
        sourceMint: action.mint,
        sourceTokenProgram: action.programId,
        inputRawAmount: action.rawAmount,
        walletTokenDebits: [{ tokenAccount: action.tokenAccount, rawAmount: action.rawAmount }],
        writableWalletTokenAccounts: [action.tokenAccount],
        writableAccounts: [{
          address: action.tokenAccount,
          role: "wallet_source_token",
          walletOwnedTokenAccount: true,
          safe: true,
        }],
        directSolTransfersLamports: "0",
        networkFeeLamports: "1",
        rentLamports: "0",
      },
      economicAudit: {
        worstOutLamports: "2",
        networkFeeLamports: "1",
        rentLamports: "0",
      },
    }),
    submitPreparedSwap: async (_preparedSwap, action) => {
      state.set(action.tokenAccount, 0n);
      return {
        success: true,
        signature: "swap-signature",
      };
    },
    confirmTransaction: async () => {},
    measureBatch: async (items) => ({ serializedBytes: 100 + items.length * 100, feeLamports: 5000 }),
    simulateBatch: async (items) => {
      simulationCalls += 1;
      return items.length === 1 ? { success: true } : { success: false, error: "split me" };
    },
    executeBatch: async (items) => {
      executionCalls += 1;
      for (const item of items) state.delete(item.tokenAccount);
      return { success: true, signature: `batch-${executionCalls}` };
    },
  };

  const preview = await executeTokenCleanup(executionPlan, dependencies);
  assert.equal(preview.preview, true);
  assert.equal(state.get("swap-source"), 10n, "preview must not mutate state");

  const result = await executeTokenCleanup(executionPlan, dependencies, { execute: true });
  assert.equal(result.failures.length, 0);
  assert.equal(result.swaps.length, 1);
  assert.equal(result.batches.length, 2, "failed two-account simulation must halve into singleton batches");
  assert.ok(simulationCalls >= 3);
  assert.equal(executionCalls, 2);
  assert.equal(state.has("swap-source"), false);
  assert.equal(state.has("zero-source"), false);
}

{
  // Checkpoint callbacks run immediately after confirmation, before later
  // account verification can fail. This is the process-crash/retry boundary.
  const executionPlan = {
    policy: { confirmationReads: 1, confirmationDelayMs: 0 },
    actions: [{ action: "close", tokenAccount: "later-fails", mint: "mint", rawAmount: "0", ...bot("lp:later", "later-fails", "0") }],
  };
  let readCount = 0;
  const checkpointed = [];
  const result = await executeTokenCleanup(executionPlan, {
    wait: async () => {},
    readAccount: async () => {
      readCount += 1;
      if (readCount > 1) throw new Error("post-confirmation RPC read failed");
      return { exists: true, rawAmount: "0" };
    },
    measureBatch: async () => ({ serializedBytes: 100, feeLamports: 5_000 }),
    simulateBatch: async () => ({ success: true }),
    executeBatch: async () => ({ success: true, signature: "confirmed-before-failure" }),
    confirmTransaction: async () => {},
  }, {
    execute: true,
    onTransactionConfirmed: async (confirmed) => checkpointed.push(confirmed.signature),
  });
  assert.deepEqual(checkpointed, ["confirmed-before-failure"]);
  assert.equal(result.failures.length, 1, "later verification failure must not erase confirmed checkpoint evidence");
}

console.log("token cleanup tests passed");
