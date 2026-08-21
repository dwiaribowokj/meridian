import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import {
  CLEANUP_SWAP_SOURCE_BINDING_BLOCKER,
  executeSourceAccountBoundCleanupSwap,
} from "../tools/wallet.js";
import {
  TOKEN_PROGRAMS,
  executeTokenCleanup,
} from "../tools/token-cleanup.js";

const wallet = Keypair.generate().publicKey.toBase58();
const source = Keypair.generate().publicKey.toBase58();
const otherSource = Keypair.generate().publicKey.toBase58();
const mint = Keypair.generate().publicKey.toBase58();
const otherMint = Keypair.generate().publicKey.toBase58();
const otherWallet = Keypair.generate().publicKey.toBase58();

function provenance(rawAmount = "9") {
  return {
    provenance: {
      source: "bot_lifecycle",
      lifecycleId: "lp:source-bound-cleanup",
      evidence: "confirmed_lifecycle_token_delta",
      accountAddress: source,
      initialRawAmount: "0",
      attributableRawAmount: rawAmount,
      currentRawAmount: rawAmount,
      exclusive: true,
    },
  };
}

function action({ programId = TOKEN_PROGRAMS.token, rawAmount = "9" } = {}) {
  return {
    action: "swap_then_close",
    tokenAccount: source,
    mint,
    programId,
    rawAmount,
    owner: wallet,
    quote: {
      routeFound: true,
      worstOutLamports: "12",
      worstNetLamports: "10",
      networkFeeLamports: "2",
      priceImpactBps: "1",
    },
    ...provenance(rawAmount),
  };
}

function plan(swapAction) {
  return {
    policy: {
      confirmationReads: 1,
      confirmationDelayMs: 0,
      minSwapNetLamports: "1",
      maxSwapNetworkFeeLamports: "2",
      maxSwapPriceImpactBps: "2",
    },
    actions: [swapAction],
  };
}

function sourceAccount(swapAction, rawAmount = swapAction.rawAmount, overrides = {}) {
  return {
    exists: true,
    tokenAccount: swapAction.tokenAccount,
    owner: wallet,
    mint: swapAction.mint,
    programId: swapAction.programId,
    rawAmount,
    ...overrides,
  };
}

function audit(swapAction, overrides = {}) {
  return {
    inspection: "local_instruction_inspection",
    sourceTokenAccount: swapAction.tokenAccount,
    sourceMint: swapAction.mint,
    sourceTokenProgram: swapAction.programId,
    inputRawAmount: swapAction.rawAmount,
    walletTokenDebits: [{ tokenAccount: swapAction.tokenAccount, rawAmount: swapAction.rawAmount }],
    writableWalletTokenAccounts: [swapAction.tokenAccount],
    writableAccounts: [{
      address: swapAction.tokenAccount,
      role: "wallet_source_token",
      walletOwnedTokenAccount: true,
      safe: true,
    }],
    directSolTransfersLamports: "0",
    networkFeeLamports: "2",
    rentLamports: "0",
    ...overrides,
  };
}

function economics(overrides = {}) {
  return {
    worstOutLamports: "12",
    networkFeeLamports: "2",
    rentLamports: "0",
    ...overrides,
  };
}

function dependencies(swapAction, {
  initialRawAmount = swapAction.rawAmount,
  accountOverrides = {},
  onPrepare = () => {},
  onSwap = (state) => { state.rawAmount = "0"; },
  preparation = null,
  submitResult = null,
  confirmTransaction = async () => {},
} = {}) {
  const state = { exists: true, rawAmount: initialRawAmount };
  let swapCalls = 0;
  let batchCalls = 0;
  return {
    state,
    calls: {
      get swap() { return swapCalls; },
      get batch() { return batchCalls; },
    },
    dependencies: {
      walletPublicKey: wallet,
      wait: async () => {},
      readAccount: async () => state.exists
        ? sourceAccount(swapAction, state.rawAmount, accountOverrides)
        : null,
      prepareSwap: async (receivedAction) => {
        onPrepare(state);
        return preparation || {
          success: true,
          preparedSwap: { sourceTokenAccount: receivedAction.tokenAccount },
          sourceAccountAudit: audit(receivedAction),
          economicAudit: economics(),
        };
      },
      submitPreparedSwap: async () => {
        swapCalls += 1;
        onSwap(state);
        return submitResult || {
          success: true,
          signature: "swap-confirmed-signature",
        };
      },
      confirmTransaction,
      measureBatch: async () => ({ serializedBytes: 100, feeLamports: "1" }),
      simulateBatch: async () => ({ success: true }),
      executeBatch: async () => {
        batchCalls += 1;
        state.exists = false;
        return { success: true, signature: "close-confirmed-signature" };
      },
    },
  };
}

for (const programId of [TOKEN_PROGRAMS.token, TOKEN_PROGRAMS.token2022]) {
  const swapAction = action({ programId });
  const fixture = dependencies(swapAction);
  const result = await executeTokenCleanup(plan(swapAction), fixture.dependencies, { execute: true });
  assert.equal(result.failures.length, 0, `${programId} exact-account flow succeeds`);
  assert.equal(result.swaps.length, 1);
  assert.equal(result.batches.length, 1, "source close follows only the confirmed zero-account read");
  assert.equal(fixture.state.exists, false);
}

{
  const swapAction = action();
  const fixture = dependencies(swapAction, { accountOverrides: { tokenAccount: otherSource } });
  const result = await executeTokenCleanup(plan(swapAction), fixture.dependencies, { execute: true });
  assert.equal(fixture.calls.swap, 0);
  assert.match(result.failures[0].error, /source account read returned/i);
}

{
  const swapAction = action();
  const fixture = dependencies(swapAction, {
    preparation: {
      success: true,
      preparedSwap: { sourceTokenAccount: source },
      sourceAccountAudit: audit(swapAction),
      economicAudit: economics({ worstOutLamports: "2" }),
    },
  });
  const result = await executeTokenCleanup(plan(swapAction), fixture.dependencies, { execute: true });
  assert.equal(fixture.calls.swap, 0, "prepared order with no policy net output is rejected");
  assert.match(result.failures[0].error, /minimum net-output policy/i);
}

{
  const swapAction = action();
  const fixture = dependencies(swapAction, { initialRawAmount: "10" });
  const result = await executeTokenCleanup(plan(swapAction), fixture.dependencies, { execute: true });
  assert.equal(fixture.calls.swap, 0);
  assert.match(result.failures[0].error, /raw balance changed/);
}

{
  const swapAction = action();
  const fixture = dependencies(swapAction, {
    onPrepare: (state) => { state.rawAmount = "8"; },
  });
  const result = await executeTokenCleanup(plan(swapAction), fixture.dependencies, { execute: true });
  assert.equal(fixture.calls.swap, 0, "amount drift after route construction blocks submission");
  assert.match(result.failures[0].error, /raw balance changed/);
}

for (const [label, accountOverrides, expression] of [
  ["wrong owner", { owner: otherWallet }, /not the signing wallet/],
  ["wrong mint", { mint: otherMint }, /mint changed/],
  ["wrong program", { programId: TOKEN_PROGRAMS.token2022 }, /token program/],
]) {
  const swapAction = action();
  const fixture = dependencies(swapAction, { accountOverrides });
  const result = await executeTokenCleanup(plan(swapAction), fixture.dependencies, { execute: true });
  assert.equal(fixture.calls.swap, 0, `${label} cannot submit`);
  assert.match(result.failures[0].error, expression);
}

{
  const swapAction = action();
  const fixture = dependencies(swapAction, {
    preparation: {
      success: true,
      preparedSwap: { sourceTokenAccount: source },
      sourceAccountAudit: audit(swapAction, {
        walletTokenDebits: [
          { tokenAccount: source, rawAmount: "9" },
          { tokenAccount: otherSource, rawAmount: "1" },
        ],
        writableWalletTokenAccounts: [source, otherSource],
      }),
      economicAudit: economics(),
    },
  });
  const result = await executeTokenCleanup(plan(swapAction), fixture.dependencies, { execute: true });
  assert.equal(fixture.calls.swap, 0, "unsafe audit is rejected before submission");
  assert.equal(fixture.calls.batch, 0);
  assert.match(result.failures[0].error, /unrelated wallet token debit/i);
}

{
  const swapAction = action();
  const fixture = dependencies(swapAction, {
    preparation: {
      success: true,
      preparedSwap: { sourceTokenAccount: source },
      sourceAccountAudit: audit(swapAction, { directSolTransfersLamports: "1" }),
      economicAudit: economics(),
    },
  });
  const result = await executeTokenCleanup(plan(swapAction), fixture.dependencies, { execute: true });
  assert.equal(fixture.calls.swap, 0, "direct SOL transfer is rejected before submission");
  assert.match(result.failures[0].error, /direct SOL transfer/i);
}

{
  const swapAction = action();
  const fixture = dependencies(swapAction, {
    confirmTransaction: async () => { throw new Error("confirmation failed"); },
  });
  const result = await executeTokenCleanup(plan(swapAction), fixture.dependencies, { execute: true });
  assert.equal(fixture.calls.batch, 0, "unconfirmed swap never reaches source close");
  assert.equal(result.swaps.length, 0);
  assert.match(result.failures[0].error, /confirmation failed/);
}

{
  const swapAction = action();
  const fixture = dependencies(swapAction, {
    onSwap: (state) => { state.rawAmount = "1"; },
  });
  const result = await executeTokenCleanup(plan(swapAction), fixture.dependencies, { execute: true });
  assert.equal(fixture.calls.batch, 0, "nonzero source residue never reaches source close");
  assert.match(result.failures[0].error, /raw balance changed|source account/);
}

{
  // Malformed input fails closed before any provider/RPC action.
  const result = await executeSourceAccountBoundCleanupSwap({
    tokenAccount: "not-a-public-key",
    mint,
    rawAmount: "9",
    programId: TOKEN_PROGRAMS.token,
  }, {
    connection: {},
    wallet: { publicKey: Keypair.generate().publicKey },
    fetch: async () => { throw new Error("must not fetch"); },
  });
  assert.equal(result.success, false);
  assert.equal(result.blocked, CLEANUP_SWAP_SOURCE_BINDING_BLOCKER);
}

console.log("source-account cleanup swap tests passed");
