import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Keypair } from "@solana/web3.js";
import { BorshInstructionCoder } from "@coral-xyz/anchor";
import { IDL as DLMM_IDL } from "@meteora-ag/dlmm";
import BN from "bn.js";
import bs58 from "bs58";
import { LIFECYCLE_STATES, TradeLedger } from "../trade-ledger.js";
import {
  LifecycleOperationLeaseError,
  acquireLifecycleOperation,
  checkpointLifecycleOperationSignature,
  completeLifecycleOperation,
  finalizeLifecycleOperation,
  getLifecycleOperationRecoveryEvidence,
  getPendingLifecycleOperationCheckpoints,
  recordDeployLifecycle,
  reconcileDeployLifecycle,
  reconcileUnsubmittedLifecycleOperationLease,
  inspectLedgerTransaction,
  recordLifecycleTransactions,
  releaseLifecycleOperation,
  requireLifecycleAttribution,
  withLifecycleOperation,
} from "../ledger-runtime.js";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-durable-lifecycle-"));
const ledger = new TradeLedger({
  filePath: path.join(tempDir, "ledger.jsonl"),
  durable: false,
  idFactory: (() => { let n = 0; return () => `event-${++n}`; })(),
});
const operationDirectory = path.join(tempDir, "operations");

function shortWriteFs(maximumBytes = 2) {
  return Object.assign(Object.create(fs), {
    writeSync(descriptor, buffer, offset, length, position) {
      return fs.writeSync(descriptor, buffer, offset, Math.min(length, maximumBytes), position);
    },
  });
}

function operationJournalEvents(operation) {
  const text = fs.existsSync(operation.checkpoint_file)
    ? fs.readFileSync(operation.checkpoint_file, "utf8")
    : "";
  return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function replacementRaceFs() {
  let target = null;
  let armed = false;
  const replaceLease = () => {
    const replacement = fs.readFileSync(target.lease_file);
    fs.unlinkSync(target.lease_file);
    fs.writeFileSync(target.lease_file, replacement);
  };
  return {
    arm(operation) {
      target = operation;
      armed = true;
    },
    fsImpl: Object.assign(Object.create(fs), {
      openSync(file, flags, mode) {
        const descriptor = fs.openSync(file, flags, mode);
        if (armed && (flags & fs.constants.O_APPEND) !== 0 && String(file).endsWith(path.basename(target.checkpoint_file))) {
          armed = false;
          replaceLease();
        }
        return descriptor;
      },
    }),
  };
}

function postAppendReplacementFs() {
  let target = null;
  let eventType = null;
  let armed = false;
  const replaceLease = () => {
    const replacement = fs.readFileSync(target.lease_file);
    fs.unlinkSync(target.lease_file);
    fs.writeFileSync(target.lease_file, replacement);
  };
  return {
    arm(operation, type) {
      target = operation;
      eventType = type;
      armed = true;
    },
    fsImpl: Object.assign(Object.create(fs), {
      writeSync(descriptor, buffer, offset, length, position) {
        const written = fs.writeSync(descriptor, buffer, offset, length, position);
        const writtenBytes = Buffer.isBuffer(buffer)
          ? buffer.subarray(offset, offset + written)
          : Buffer.from(String(buffer)).subarray(offset, offset + written);
        if (armed && writtenBytes.toString("utf8").includes(`"type":"${eventType}"`)) {
          armed = false;
          replaceLease();
        }
        return written;
      },
    }),
  };
}

function activate(position) {
  const lifecycleId = `lp:${position}`;
  ledger.createLifecycle({
    lifecycle_id: lifecycleId,
    position_address: position,
    pool_address: `pool-${position}`,
    expected_deposit_lamports: 1n,
  });
  ledger.transitionLifecycle(lifecycleId, LIFECYCLE_STATES.BASIS_PENDING);
  ledger.recordTransaction({
    lifecycle_id: lifecycleId,
    signature: `deploy-${position}`,
    phase: "deploy",
    layer_id: "single",
    amounts: { deposit_lamports: 1n, liquid_wallet_delta_lamports: -1n },
  });
  ledger.recordBasisObservation({ lifecycle_id: lifecycleId, source: "rpc", deposit_lamports: 1n });
  ledger.recordBasisObservation({ lifecycle_id: lifecycleId, source: "rpc", deposit_lamports: 1n });
  ledger.transitionLifecycle(lifecycleId, LIFECYCLE_STATES.ACTIVE);
}

function receipt(signature, { deployContext = null, evidenceKind = "liquidity", depositLamports = 1n } = {}) {
  return {
    signature,
    executionStatus: "succeeded",
    walletDeltaLamports: 1n,
    txFeeLamports: 0n,
    rentCreatedLamports: 0n,
    rentReclaimedLamports: 0n,
    tokenDeltas: [],
    tokenAccountEvidence: [],
    slot: 1,
    ...(deployContext ? {
      // Unit-level injected inspection preserves the same narrow result
      // contract as inspectLedgerTransaction. Raw RPC/IDL fixtures below
      // exercise the decoder itself; this keeps lifecycle tests focused on
      // durability and immutable retry behavior.
      deployReceiptEvidence: {
        kind: evidenceKind,
        position: deployContext.position,
        pool: deployContext.pool,
        deposit_lamports: String(depositLamports),
      },
    } : {}),
  };
}

function deployProvenance(signature, layerId = "single") {
  return [{ signature, kind: "liquidity", layer_id: layerId }];
}

const DLMM_PROGRAM = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";
const NATIVE_SOL_MINT = "So11111111111111111111111111111111111111112";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const dlmmCoder = new BorshInstructionCoder(DLMM_IDL);

/** A minimal v0 RPC receipt shape whose DLMM bytes are encoded by the installed IDL. */
function rpcShapedDlmmLiquidityReceipt({
  amount = 1n,
  kind = "liquidity",
  instructionName = "add_liquidity_by_strategy2",
  identity = null,
  atomicNativeSolWrap = false,
  reserveStructuralResidual = 0n,
  unrelatedSolTransfer = false,
  unknownOuterProgram = false,
  duplicateLoadedKey = false,
} = {}) {
  const wallet = identity?.wallet || Keypair.generate().publicKey.toString();
  const position = identity?.position || Keypair.generate().publicKey.toString();
  const pool = identity?.pool || Keypair.generate().publicKey.toString();
  const bitmap = Keypair.generate().publicKey.toString();
  const userX = Keypair.generate().publicKey.toString();
  const userY = Keypair.generate().publicKey.toString();
  const reserveX = Keypair.generate().publicKey.toString();
  const reserveY = Keypair.generate().publicKey.toString();
  const tokenXMint = Keypair.generate().publicKey.toString();
  const eventAuthority = Keypair.generate().publicKey.toString();
  const unrelatedDestination = Keypair.generate().publicKey.toString();
  const binArrayLower = Keypair.generate().publicKey.toString();
  const binArrayUpper = Keypair.generate().publicKey.toString();
  const usesLegacyStrategyAccounts = instructionName === "add_liquidity_by_strategy";
  // reserveY is loaded, exercising final effective key indexing rather than
  // relying on static-only account arrays.
  const staticKeys = [
    position, pool, bitmap, userX, userY, reserveX, tokenXMint, NATIVE_SOL_MINT,
    wallet, TOKEN_PROGRAM, eventAuthority, DLMM_PROGRAM, SYSTEM_PROGRAM, Keypair.generate().publicKey.toString(),
    ...(usesLegacyStrategyAccounts ? [binArrayLower, binArrayUpper] : []),
    ...(unrelatedSolTransfer ? [unrelatedDestination] : []),
    ...(unknownOuterProgram ? [Keypair.generate().publicKey.toString()] : []),
  ];
  const associatedTokenProgramIndex = staticKeys.length;
  if (atomicNativeSolWrap) staticKeys.push("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
  const reserveYIndex = staticKeys.length;
  const loadedAddresses = {
    writable: [reserveY],
    readonly: duplicateLoadedKey ? [reserveY] : [],
  };
  const instructionData = kind === "setup"
    ? dlmmCoder.encode("initialize_position", { lower_bin_id: -2, width: 3 })
    : dlmmCoder.encode(instructionName, {
    liquidity_parameter: {
      amount_x: new BN(0),
      amount_y: new BN(amount.toString()),
      active_id: 0,
      max_active_bin_slippage: 0,
      strategy_parameters: {
        min_bin_id: -2,
        max_bin_id: 0,
        strategy_type: { SpotOneSide: {} },
        parameteres: Array(64).fill(0),
      },
    },
    remaining_accounts_info: { slices: [] },
    });
  const compiledInstructions = [{
    programIdIndex: 11,
    accountKeyIndexes: kind === "setup"
      ? [8, 0, 1, 8, 12, 13, 10, 11]
      : usesLegacyStrategyAccounts
        ? [
          0, 1, 2, 3, 4, 5, reserveYIndex, 6, 7,
          staticKeys.indexOf(binArrayLower), staticKeys.indexOf(binArrayUpper),
          8, 9, 9, 10, 11,
        ]
        : [0, 1, 2, 3, 4, 5, reserveYIndex, 6, 7, 8, 9, 9, 10, 11],
    data: bs58.encode(instructionData),
  }];
  if (atomicNativeSolWrap && kind !== "setup") {
    compiledInstructions.splice(0, 0, {
      programIdIndex: associatedTokenProgramIndex,
      accountKeyIndexes: [
        staticKeys.indexOf(wallet), staticKeys.indexOf(userY), staticKeys.indexOf(wallet),
        staticKeys.indexOf(NATIVE_SOL_MINT), staticKeys.indexOf(SYSTEM_PROGRAM), staticKeys.indexOf(TOKEN_PROGRAM),
      ],
      data: bs58.encode(Buffer.from([1])),
    }, {
      programIdIndex: staticKeys.indexOf(SYSTEM_PROGRAM),
      accountKeyIndexes: [staticKeys.indexOf(wallet), staticKeys.indexOf(userY)],
      data: bs58.encode(Buffer.from([2, 0, 0, 0, ...Buffer.from(new BN(amount.toString()).toArray("le", 8))])),
    }, {
      programIdIndex: staticKeys.indexOf(TOKEN_PROGRAM),
      accountKeyIndexes: [staticKeys.indexOf(userY)],
      data: bs58.encode(Buffer.from([17])),
    });
    compiledInstructions.push({
      programIdIndex: staticKeys.indexOf(TOKEN_PROGRAM),
      accountKeyIndexes: [staticKeys.indexOf(userY), staticKeys.indexOf(wallet), staticKeys.indexOf(wallet)],
      data: bs58.encode(Buffer.from([9])),
    });
  }
  if (unrelatedSolTransfer) {
    const systemData = Buffer.alloc(12);
    systemData.writeUInt32LE(2, 0);
    systemData.writeBigUInt64LE(amount, 4);
    compiledInstructions.push({
      programIdIndex: 12,
      accountKeyIndexes: [8, staticKeys.indexOf(unrelatedDestination)],
      data: bs58.encode(systemData),
    });
  }
  if (unknownOuterProgram) {
    compiledInstructions.push({
      programIdIndex: staticKeys.length - 1,
      accountKeyIndexes: [],
      data: bs58.encode(Buffer.from([1])),
    });
  }
  const effectiveKeyCount = staticKeys.length + loadedAddresses.writable.length + loadedAddresses.readonly.length;
  const preBalances = Array(effectiveKeyCount).fill(0);
  const postBalances = Array(effectiveKeyCount).fill(0);
  const tokenAmount = kind === "setup" ? 0n : amount;
  preBalances[8] = Number(tokenAmount * (unrelatedSolTransfer ? 2n : 1n));
  postBalances[8] = 0;
  return {
    wallet,
    position,
    pool,
    transaction: {
      transaction: { message: { staticAccountKeys: staticKeys, compiledInstructions } },
      meta: {
        err: null,
        fee: 0,
        loadedAddresses,
        preBalances,
        postBalances,
        preTokenBalances: [
          ...(atomicNativeSolWrap ? [] : [
            { accountIndex: 4, mint: NATIVE_SOL_MINT, owner: wallet, uiTokenAmount: { amount: tokenAmount.toString() } },
          ]),
          { accountIndex: reserveYIndex, mint: NATIVE_SOL_MINT, owner: pool, uiTokenAmount: { amount: "0" } },
        ],
        postTokenBalances: [
          ...(atomicNativeSolWrap ? [] : [
            { accountIndex: 4, mint: NATIVE_SOL_MINT, owner: wallet, uiTokenAmount: { amount: "0" } },
          ]),
          { accountIndex: reserveYIndex, mint: NATIVE_SOL_MINT, owner: pool, uiTokenAmount: {
            amount: (tokenAmount - reserveStructuralResidual).toString(),
          } },
        ],
      },
      slot: 1,
    },
  };
}

try {
  let deployPositionUpdates = [];
  const recordedDeploy = await recordDeployLifecycle({
    position: "RecordedDeployPosition",
    pool: "RecordedDeployPool",
    amountSol: 0.000000001,
    txs: ["recorded-deploy-signature"],
    receiptProvenance: deployProvenance("recorded-deploy-signature"),
    walletAddress: "wallet",
    inspectTransaction: async (signature, context) => ({ ...receipt(signature, context), walletDeltaLamports: -1n }),
    store: ledger,
    ledgerEnabled: true,
    updatePosition: (_position, update) => { deployPositionUpdates.push(update); },
  });
  assert.equal(recordedDeploy.state, LIFECYCLE_STATES.ACTIVE, "a successful decoded receipt is ledger-recorded as historical basis");
  assert.equal(ledger.findTransaction("lp:RecordedDeployPosition", "recorded-deploy-signature").execution_status, "succeeded");
  assert.equal(deployPositionUpdates.at(-1).ledger_status, "ACTIVE");
  let duplicateDeployInspectorCalls = 0;
  const duplicateDeploy = await recordDeployLifecycle({
    position: "RecordedDeployPosition",
    pool: "RecordedDeployPool",
    amountSol: 0.000000001,
    txs: ["recorded-deploy-signature"],
    receiptProvenance: deployProvenance("recorded-deploy-signature"),
    walletAddress: "wallet",
    inspectTransaction: async () => { duplicateDeployInspectorCalls += 1; throw new Error("duplicate deploy must not be reinspected"); },
    store: ledger,
    ledgerEnabled: true,
    readPositionAccount: async () => { throw new Error("duplicate deploy must not re-read basis"); },
    sleep: async () => { throw new Error("duplicate deploy must not sleep"); },
    updatePosition: () => { throw new Error("duplicate deploy must not rewrite position accounting"); },
  });
  assert.equal(duplicateDeploy.state, LIFECYCLE_STATES.ACTIVE);
  assert.equal(duplicateDeployInspectorCalls, 0, "duplicate deploy receipts preserve global signature uniqueness without another inspection");

  // Cleanup uses the same non-stealable durable journal as close/claim, while
  // allowing an ordered swap receipt followed by one or more account-cleanup
  // receipts. A second process cannot acquire the position during that gap.
  const cleanupOperation = acquireLifecycleOperation({
    operation: "cleanup",
    position: "DurableCleanupPosition",
    store: ledger,
    directory: operationDirectory,
    durable: false,
  });
  checkpointLifecycleOperationSignature(cleanupOperation, {
    position: "DurableCleanupPosition",
    phase: "swap",
    signature: "durable-cleanup-swap",
  });
  assert.throws(() => acquireLifecycleOperation({
    operation: "cleanup",
    position: "DurableCleanupPosition",
    store: ledger,
    directory: operationDirectory,
    durable: false,
  }), /already leased/i);
  checkpointLifecycleOperationSignature(cleanupOperation, {
    position: "DurableCleanupPosition",
    phase: "cleanup",
    signature: "durable-cleanup-close-account",
  });
  completeLifecycleOperation(cleanupOperation, {
    position: "DurableCleanupPosition",
    phase: "cleanup",
    expectedTransactions: [
      { phase: "swap", signature: "durable-cleanup-swap" },
      { phase: "cleanup", signature: "durable-cleanup-close-account" },
    ],
  });
  finalizeLifecycleOperation(cleanupOperation);
  releaseLifecycleOperation(cleanupOperation);

  // A request is an immutable expectation, never a substitute for receipt
  // economics. One lamport of confirmed liquid outflow cannot become a
  // requested two-lamport deploy or manufacture matching basis observations.
  const underfundedDeploy = await recordDeployLifecycle({
    position: "UnderfundedDeployPosition",
    pool: "UnderfundedDeployPool",
    amountSol: 0.000000002,
    txs: ["underfunded-deploy-signature"],
    receiptProvenance: deployProvenance("underfunded-deploy-signature"),
    walletAddress: "wallet",
    inspectTransaction: async (signature, context) => ({ ...receipt(signature, context), walletDeltaLamports: -1n }),
    store: ledger,
    ledgerEnabled: true,
    updatePosition: () => {},
  });
  assert.equal(underfundedDeploy.state, LIFECYCLE_STATES.RECONCILIATION_REQUIRED);
  assert.equal(ledger.findTransaction("lp:UnderfundedDeployPosition", "underfunded-deploy-signature").amounts.deposit_lamports, "1");
  assert.equal(
    ledger.readEvents({ lifecycle_id: "lp:UnderfundedDeployPosition" }).filter((event) => event.event_type === "basis_observed").length,
    0,
    "a requested amount is never fabricated into a basis observation",
  );

  // Wide ranges create the position before any liquidity. Explicit producer
  // provenance, not receipt order, keeps the setup debit out of layer basis.
  const wideLayers = [
    { layer_id: "wide-primary", expected_deposit_lamports: 2n },
    { layer_id: "wide-secondary", expected_deposit_lamports: 1n },
  ];
  const wideProvenance = [
    { signature: "wide-create", kind: "setup", layer_id: null },
    { signature: "wide-primary-liquidity-1", kind: "liquidity", layer_id: "wide-primary" },
    { signature: "wide-primary-liquidity-2", kind: "liquidity", layer_id: "wide-primary" },
    { signature: "wide-secondary-liquidity", kind: "liquidity", layer_id: "wide-secondary" },
  ];
  const wideEconomics = new Map([
    ["wide-create", { walletDeltaLamports: -7n, txFeeLamports: 2n, rentCreatedLamports: 5n }],
    ["wide-primary-liquidity-1", { walletDeltaLamports: -1n }],
    ["wide-primary-liquidity-2", { walletDeltaLamports: -1n }],
    ["wide-secondary-liquidity", { walletDeltaLamports: -1n }],
  ]);
  const wideDeploy = await recordDeployLifecycle({
    position: "WideProvenancePosition",
    pool: "WideProvenancePool",
    amountSol: 0.000000003,
    layers: wideLayers,
    txs: wideProvenance.map((mapping) => mapping.signature),
    receiptProvenance: wideProvenance,
    walletAddress: "wallet",
    inspectTransaction: async (signature, context) => {
      const mapping = wideProvenance.find((entry) => entry.signature === signature);
      return {
        ...receipt(signature, {
          ...context,
          evidenceKind: mapping.kind,
          depositLamports: mapping.kind === "setup" ? 0n : 1n,
        }),
        ...wideEconomics.get(signature),
      };
    },
    store: ledger,
    ledgerEnabled: true,
    updatePosition: () => {},
  });
  assert.equal(wideDeploy.state, LIFECYCLE_STATES.ACTIVE);
  assert.equal(wideDeploy.cost_basis.required_stable_reads, 0, "receipt evidence replaces fictional position-account historical basis reads");
  assert.equal(ledger.findTransaction("lp:WideProvenancePosition", "wide-create").layer_id, null);
  assert.equal(ledger.findTransaction("lp:WideProvenancePosition", "wide-create").amounts.deposit_lamports, "0");
  assert.equal(ledger.findTransaction("lp:WideProvenancePosition", "wide-primary-liquidity-1").layer_id, "wide-primary");
  assert.equal(ledger.findTransaction("lp:WideProvenancePosition", "wide-primary-liquidity-2").layer_id, "wide-primary");
  assert.equal(ledger.findTransaction("lp:WideProvenancePosition", "wide-secondary-liquidity").layer_id, "wide-secondary");

  let exactRetryInspections = 0;
  const exactWideRetry = await recordDeployLifecycle({
    position: "WideProvenancePosition",
    pool: "WideProvenancePool",
    amountSol: 0.000000003,
    layers: wideLayers,
    txs: wideProvenance.map((mapping) => mapping.signature),
    receiptProvenance: wideProvenance,
    walletAddress: "wallet",
    inspectTransaction: async () => { exactRetryInspections += 1; throw new Error("exact retry must not inspect"); },
    store: ledger,
    ledgerEnabled: true,
    readPositionAccount: async () => { throw new Error("exact retry must not read position basis"); },
    sleep: async () => { throw new Error("exact retry must not sleep"); },
    updatePosition: () => { throw new Error("exact retry must not update accounting"); },
  });
  assert.equal(exactWideRetry.state, LIFECYCLE_STATES.ACTIVE);
  assert.equal(exactRetryInspections, 0, "an exact terminal retry is byte-idempotent");
  for (const changedRequest of [
    { pool: "ChangedPool" },
    { amountSol: 0.000000004, layers: [
      { layer_id: "wide-primary", expected_deposit_lamports: 1n },
      { layer_id: "wide-secondary", expected_deposit_lamports: 3n },
    ] },
    { layers: [...wideLayers].reverse() },
    { receiptProvenance: [
      wideProvenance[0],
      { signature: "wide-primary-liquidity-1", kind: "liquidity", layer_id: "wide-secondary" },
      wideProvenance[2],
      { signature: "wide-secondary-liquidity", kind: "liquidity", layer_id: "wide-primary" },
    ] },
  ]) {
    await assert.rejects(recordDeployLifecycle({
      position: "WideProvenancePosition",
      pool: "WideProvenancePool",
      amountSol: 0.000000003,
      layers: wideLayers,
      txs: wideProvenance.map((mapping) => mapping.signature),
      receiptProvenance: wideProvenance,
      walletAddress: "wallet",
      inspectTransaction: async () => { throw new Error("changed retry must not inspect"); },
      store: ledger,
      ledgerEnabled: true,
      ...changedRequest,
    }), /immutable request\/provenance/i);
  }
  assert.equal(ledger.getLifecycle("lp:WideProvenancePosition").state, LIFECYCLE_STATES.ACTIVE,
    "a changed retry must not mutate the original lifecycle");

  // A position object alone is not an economics observation. A missing or
  // ambiguous map likewise records receipts without guessing any layer.
  const existenceOnly = await recordDeployLifecycle({
    position: "ExistenceOnlyPosition",
    pool: "ExistenceOnlyPool",
    amountSol: 0.000000001,
    txs: ["existence-only-signature"],
    receiptProvenance: deployProvenance("existence-only-signature"),
    walletAddress: "wallet",
    inspectTransaction: async (signature) => ({ ...receipt(signature), walletDeltaLamports: -1n }),
    store: ledger,
    ledgerEnabled: true,
    updatePosition: () => {},
  });
  assert.equal(existenceOnly.state, LIFECYCLE_STATES.RECONCILIATION_REQUIRED);
  const ambiguousProvenance = await recordDeployLifecycle({
    position: "AmbiguousProvenancePosition",
    pool: "AmbiguousProvenancePool",
    amountSol: 0.000000001,
    txs: ["ambiguous-create", "ambiguous-liquidity"],
    receiptProvenance: [{ signature: "ambiguous-liquidity", kind: "liquidity", layer_id: "single" }],
    walletAddress: "wallet",
    inspectTransaction: async (signature, context) => ({ ...receipt(signature, context), walletDeltaLamports: -1n }),
    store: ledger,
    ledgerEnabled: true,
    updatePosition: () => {},
  });
  assert.equal(ambiguousProvenance.state, LIFECYCLE_STATES.RECONCILIATION_REQUIRED);
  assert.equal(ledger.findTransaction("lp:AmbiguousProvenancePosition", "ambiguous-create").layer_id, null);
  assert.equal(ledger.findTransaction("lp:AmbiguousProvenancePosition", "ambiguous-liquidity").amounts.deposit_lamports, "0");

  const failedDeploy = await recordDeployLifecycle({
    position: "FailedDeployPosition",
    pool: "FailedDeployPool",
    amountSol: 0.000000001,
    txs: ["failed-deploy-signature"],
    receiptProvenance: deployProvenance("failed-deploy-signature"),
    walletAddress: "wallet",
    inspectTransaction: async (signature) => ({
      ...receipt(signature),
      executionStatus: "failed",
      walletDeltaLamports: -5n,
      txFeeLamports: 5n,
    }),
    store: ledger,
    ledgerEnabled: true,
    updatePosition: () => {},
  });
  const failedDeployReceipt = ledger.findTransaction("lp:FailedDeployPosition", "failed-deploy-signature");
  assert.equal(failedDeploy.state, LIFECYCLE_STATES.RECONCILIATION_REQUIRED, "a failed submitted deploy cannot become active");
  assert.equal(failedDeployReceipt.execution_status, "failed");
  assert.equal(failedDeployReceipt.amounts.deposit_lamports, "0");
  assert.equal(failedDeployReceipt.amounts.rent_created_lamports, "0");
  assert.deepEqual(failedDeployReceipt.token_deltas, []);
  assert.deepEqual(failedDeployReceipt.metadata.token_account_evidence, []);
  const exactReconciliationRetry = await recordDeployLifecycle({
    position: "FailedDeployPosition",
    pool: "FailedDeployPool",
    amountSol: 0.000000001,
    txs: ["failed-deploy-signature"],
    receiptProvenance: deployProvenance("failed-deploy-signature"),
    walletAddress: "wallet",
    inspectTransaction: async () => { throw new Error("reconciliation retry must not inspect"); },
    store: ledger,
    ledgerEnabled: true,
    readPositionAccount: async () => { throw new Error("reconciliation retry must not read"); },
    sleep: async () => { throw new Error("reconciliation retry must not sleep"); },
    updatePosition: () => { throw new Error("reconciliation retry must not update accounting"); },
  });
  assert.equal(exactReconciliationRetry.state, LIFECYCLE_STATES.RECONCILIATION_REQUIRED,
    "an exact reconciliation-required retry returns the original immutable lifecycle");

  // Production evidence is decoded from the installed Meteora IDL and an RPC
  // transaction shape. No caller-supplied position/basis object participates
  // in activation, and reserveY deliberately comes from loaded addresses.
  const rpcFixture = rpcShapedDlmmLiquidityReceipt({ amount: 1n });
  const inspectedRpcReceipt = await inspectLedgerTransaction("rpc-shaped-liquidity", {
    walletAddress: rpcFixture.wallet,
    connection: { getTransaction: async () => rpcFixture.transaction },
    deployContext: { position: rpcFixture.position, pool: rpcFixture.pool },
  });
  assert.deepEqual(inspectedRpcReceipt.deployReceiptEvidence, {
    kind: "liquidity",
    instruction: "add_liquidity_by_strategy2",
    position: rpcFixture.position,
    pool: rpcFixture.pool,
    user_token_y: inspectedRpcReceipt.deployReceiptEvidence.user_token_y,
    reserve_y: inspectedRpcReceipt.deployReceiptEvidence.reserve_y,
    token_y_mint: NATIVE_SOL_MINT,
    requested_amount_y_lamports: "1",
    reserve_y_delta_lamports: "1",
    deposit_lamports: "1",
    structural_residual_lamports: "0",
    funding_model: "persistent_wsol_spl_delta",
  });
  const rpcEvidenceLifecycle = await recordDeployLifecycle({
    position: rpcFixture.position,
    pool: rpcFixture.pool,
    amountSol: 0.000000001,
    txs: ["rpc-shaped-liquidity"],
    receiptProvenance: deployProvenance("rpc-shaped-liquidity"),
    walletAddress: rpcFixture.wallet,
    inspectTransaction: (signature, context) => inspectLedgerTransaction(signature, {
      walletAddress: rpcFixture.wallet,
      connection: { getTransaction: async () => rpcFixture.transaction },
      deployContext: context.deployContext,
    }),
    store: ledger,
    ledgerEnabled: true,
    updatePosition: () => {},
  });
  assert.equal(rpcEvidenceLifecycle.state, LIFECYCLE_STATES.ACTIVE,
    "a supported local receipt reaches ACTIVE from position-bound DLMM/SPL proof alone");
  assert.equal(rpcEvidenceLifecycle.cost_basis.usable_basis_lamports, "1");
  assert.equal(rpcEvidenceLifecycle.cost_basis.required_stable_reads, 0);

  // Regression from live signature 3dES...RNnte: the SDK creates a WSOL ATA,
  // funds it with the requested native SOL, syncs it, adds liquidity and then
  // closes it in one transaction. RPC omits that transaction-local account
  // from pre/post token snapshots, while reserve-Y receives amount minus a
  // two-lamport structural residue. The exact position/pool/DLMM amount,
  // native transfer and account lifecycle prove the exact 0.20 SOL funded
  // basis while retaining the two-lamport returned residue as audit evidence.
  const atomicNativeFixture = rpcShapedDlmmLiquidityReceipt({
    amount: 200_000_000n,
    atomicNativeSolWrap: true,
    reserveStructuralResidual: 2n,
  });
  const inspectedAtomicNativeReceipt = await inspectLedgerTransaction("rpc-atomic-native-sol", {
    walletAddress: atomicNativeFixture.wallet,
    connection: { getTransaction: async () => atomicNativeFixture.transaction },
    deployContext: { position: atomicNativeFixture.position, pool: atomicNativeFixture.pool },
  });
  assert.equal(inspectedAtomicNativeReceipt.deployReceiptEvidence.kind, "liquidity");
  assert.equal(inspectedAtomicNativeReceipt.deployReceiptEvidence.funding_model, "atomic_native_sol_wrap");
  assert.equal(inspectedAtomicNativeReceipt.deployReceiptEvidence.requested_amount_y_lamports, "200000000");
  assert.equal(inspectedAtomicNativeReceipt.deployReceiptEvidence.reserve_y_delta_lamports, "199999998");
  assert.equal(inspectedAtomicNativeReceipt.deployReceiptEvidence.structural_residual_lamports, "2");
  assert.equal(inspectedAtomicNativeReceipt.deployReceiptEvidence.deposit_lamports, "200000000");
  const atomicNativeLifecycle = await recordDeployLifecycle({
    position: atomicNativeFixture.position,
    pool: atomicNativeFixture.pool,
    amountSol: 0.2,
    txs: ["rpc-atomic-native-sol"],
    receiptProvenance: deployProvenance("rpc-atomic-native-sol"),
    walletAddress: atomicNativeFixture.wallet,
    inspectTransaction: (signature, context) => inspectLedgerTransaction(signature, {
      walletAddress: atomicNativeFixture.wallet,
      connection: { getTransaction: async () => atomicNativeFixture.transaction },
      deployContext: context.deployContext,
    }),
    store: ledger,
    ledgerEnabled: true,
    updatePosition: () => {},
  });
  assert.equal(atomicNativeLifecycle.state, LIFECYCLE_STATES.ACTIVE);
  assert.equal(atomicNativeLifecycle.cost_basis.usable_basis_lamports, "200000000");

  const excessiveResidualFixture = rpcShapedDlmmLiquidityReceipt({
    amount: 200_000_000n,
    atomicNativeSolWrap: true,
    reserveStructuralResidual: 100_001n,
  });
  const excessiveResidualReceipt = await inspectLedgerTransaction("rpc-atomic-native-sol-excessive-residual", {
    walletAddress: excessiveResidualFixture.wallet,
    connection: { getTransaction: async () => excessiveResidualFixture.transaction },
    deployContext: { position: excessiveResidualFixture.position, pool: excessiveResidualFixture.pool },
  });
  assert.equal(excessiveResidualReceipt.deployReceiptEvidence.kind, "invalid");
  assert.match(excessiveResidualReceipt.deployReceiptEvidence.reason, /excessive unexplained WSOL structural residual/i);

  const repairLedger = new TradeLedger({
    filePath: path.join(tempDir, "atomic-native-repair-ledger.jsonl"),
    durable: false,
    idFactory: (() => { let n = 0; return () => `atomic-repair-${++n}`; })(),
  });
  repairLedger.createLifecycle({
    lifecycle_id: `lp:${atomicNativeFixture.position}`,
    position_address: atomicNativeFixture.position,
    pool_address: atomicNativeFixture.pool,
    expected_deposit_lamports: 200_000_000n,
    metadata: {
      deploy_immutable: {
        position_address: atomicNativeFixture.position,
        pool_address: atomicNativeFixture.pool,
        expected_deposit_lamports: "200000000",
        expected_layers: [{ layer_id: "single", expected_deposit_lamports: "200000000" }],
        receipt_provenance: [{ signature: "rpc-atomic-native-sol-repair", kind: "liquidity", layer_id: "single" }],
      },
    },
  });
  repairLedger.transitionLifecycle(`lp:${atomicNativeFixture.position}`, LIFECYCLE_STATES.BASIS_PENDING);
  repairLedger.recordTransaction({
    lifecycle_id: `lp:${atomicNativeFixture.position}`,
    signature: "rpc-atomic-native-sol-repair",
    phase: "deploy",
    layer_id: "single",
    amounts: { deposit_lamports: 0n, liquid_wallet_delta_lamports: -200_000_000n },
  });
  repairLedger.transitionLifecycle(`lp:${atomicNativeFixture.position}`, LIFECYCLE_STATES.RECONCILIATION_REQUIRED);
  let repairedPositionUpdate = null;
  const repairedAtomicNative = await reconcileDeployLifecycle({
    position: atomicNativeFixture.position,
    signature: "rpc-atomic-native-sol-repair",
    walletAddress: atomicNativeFixture.wallet,
    reconciliationId: "atomic-native-live-regression",
    inspectTransaction: (signature, context) => inspectLedgerTransaction(signature, {
      walletAddress: atomicNativeFixture.wallet,
      connection: { getTransaction: async () => atomicNativeFixture.transaction },
      deployContext: context.deployContext,
    }),
    store: repairLedger,
    ledgerEnabled: true,
    updatePosition: (_position, update) => { repairedPositionUpdate = update; },
  });
  assert.equal(repairedAtomicNative.state, LIFECYCLE_STATES.ACTIVE);
  assert.equal(repairedAtomicNative.reconciliation_latched, false);
  assert.equal(repairedAtomicNative.cost_basis.usable_basis_lamports, "200000000");
  assert.equal(repairedPositionUpdate.basis_status, "READY");
  assert.equal(repairedPositionUpdate.local_cost_basis_lamports, "200000000");
  assert.equal(repairLedger.readEvents({ lifecycle_id: `lp:${atomicNativeFixture.position}` })
    .find((event) => event.event_type === "transaction_recorded").amounts.deposit_lamports, "0");

  // The legacy Strategy layout is independently encoded by the installed IDL:
  // unlike Strategy2, sender is account 11 because the two bin-array accounts
  // precede it. Keep this alongside the v0/loaded-address Strategy2 fixture.
  const legacyInstruction = DLMM_IDL.instructions.find((instruction) => instruction.name === "add_liquidity_by_strategy");
  const strategy2Instruction = DLMM_IDL.instructions.find((instruction) => instruction.name === "add_liquidity_by_strategy2");
  assert.equal(legacyInstruction?.accounts?.[11]?.name, "sender");
  assert.equal(strategy2Instruction?.accounts?.[9]?.name, "sender");
  const legacyRpcFixture = rpcShapedDlmmLiquidityReceipt({
    instructionName: "add_liquidity_by_strategy",
  });
  const inspectedLegacyReceipt = await inspectLedgerTransaction("rpc-shaped-legacy-strategy", {
    walletAddress: legacyRpcFixture.wallet,
    connection: { getTransaction: async () => legacyRpcFixture.transaction },
    deployContext: { position: legacyRpcFixture.position, pool: legacyRpcFixture.pool },
  });
  assert.deepEqual(inspectedLegacyReceipt.deployReceiptEvidence, {
    kind: "liquidity",
    instruction: "add_liquidity_by_strategy",
    position: legacyRpcFixture.position,
    pool: legacyRpcFixture.pool,
    user_token_y: inspectedLegacyReceipt.deployReceiptEvidence.user_token_y,
    reserve_y: inspectedLegacyReceipt.deployReceiptEvidence.reserve_y,
    token_y_mint: NATIVE_SOL_MINT,
    requested_amount_y_lamports: "1",
    reserve_y_delta_lamports: "1",
    deposit_lamports: "1",
    structural_residual_lamports: "0",
    funding_model: "persistent_wsol_spl_delta",
  });
  const legacyEvidenceLifecycle = await recordDeployLifecycle({
    position: legacyRpcFixture.position,
    pool: legacyRpcFixture.pool,
    amountSol: 0.000000001,
    txs: ["rpc-shaped-legacy-strategy"],
    receiptProvenance: deployProvenance("rpc-shaped-legacy-strategy"),
    walletAddress: legacyRpcFixture.wallet,
    inspectTransaction: (signature, context) => inspectLedgerTransaction(signature, {
      walletAddress: legacyRpcFixture.wallet,
      connection: { getTransaction: async () => legacyRpcFixture.transaction },
      deployContext: context.deployContext,
    }),
    store: ledger,
    ledgerEnabled: true,
    updatePosition: () => {},
  });
  assert.equal(legacyEvidenceLifecycle.state, LIFECYCLE_STATES.ACTIVE,
    "the decoded legacy Strategy receipt reaches ACTIVE with its own sender role");

  // One setup receipt, two receipts for the same layer, and a secondary layer
  // all use independently encoded RPC fixtures. Setup creates no basis; only
  // the three exact reserveY transfers form the multi-layer total.
  const multiIdentity = {
    wallet: Keypair.generate().publicKey.toString(),
    position: Keypair.generate().publicKey.toString(),
    pool: Keypair.generate().publicKey.toString(),
  };
  const multiFixtures = new Map([
    ["rpc-wide-setup", rpcShapedDlmmLiquidityReceipt({ kind: "setup", identity: multiIdentity })],
    ["rpc-wide-primary-a", rpcShapedDlmmLiquidityReceipt({ identity: multiIdentity })],
    ["rpc-wide-primary-b", rpcShapedDlmmLiquidityReceipt({ identity: multiIdentity })],
    ["rpc-wide-secondary", rpcShapedDlmmLiquidityReceipt({ identity: multiIdentity })],
  ]);
  const multiProvenance = [
    { signature: "rpc-wide-setup", kind: "setup", layer_id: null },
    { signature: "rpc-wide-primary-a", kind: "liquidity", layer_id: "primary" },
    { signature: "rpc-wide-primary-b", kind: "liquidity", layer_id: "primary" },
    { signature: "rpc-wide-secondary", kind: "liquidity", layer_id: "secondary" },
  ];
  const multiLifecycle = await recordDeployLifecycle({
    position: multiIdentity.position,
    pool: multiIdentity.pool,
    amountSol: 0.000000003,
    layers: [
      { layer_id: "primary", expected_deposit_lamports: 2n },
      { layer_id: "secondary", expected_deposit_lamports: 1n },
    ],
    txs: multiProvenance.map((item) => item.signature),
    receiptProvenance: multiProvenance,
    walletAddress: multiIdentity.wallet,
    inspectTransaction: (signature, context) => inspectLedgerTransaction(signature, {
      walletAddress: multiIdentity.wallet,
      connection: { getTransaction: async () => multiFixtures.get(signature).transaction },
      deployContext: context.deployContext,
    }),
    store: ledger,
    ledgerEnabled: true,
    updatePosition: () => {},
  });
  assert.equal(multiLifecycle.state, LIFECYCLE_STATES.ACTIVE);
  assert.equal(multiLifecycle.cost_basis.usable_basis_lamports, "3");
  assert.equal(ledger.findTransaction(`lp:${multiIdentity.position}`, "rpc-wide-setup").amounts.deposit_lamports, "0");
  assert.equal(multiLifecycle.cost_basis.layer_status.find((layer) => layer.layer_id === "primary").confirmed_deposit_lamports, "2");

  // A valid-looking caller label and matching native debit cannot convert an
  // unrelated SystemProgram transfer into liquidity. The confirmed receipt is
  // retained, with zero deposit, and requires explicit reconciliation.
  const unrelatedFixture = rpcShapedDlmmLiquidityReceipt({ amount: 1n, unrelatedSolTransfer: true });
  const unrelatedLifecycle = await recordDeployLifecycle({
    position: unrelatedFixture.position,
    pool: unrelatedFixture.pool,
    amountSol: 0.000000001,
    txs: ["rpc-unrelated-native-transfer"],
    receiptProvenance: deployProvenance("rpc-unrelated-native-transfer"),
    walletAddress: unrelatedFixture.wallet,
    inspectTransaction: (signature, context) => inspectLedgerTransaction(signature, {
      walletAddress: unrelatedFixture.wallet,
      connection: { getTransaction: async () => unrelatedFixture.transaction },
      deployContext: context.deployContext,
    }),
    store: ledger,
    ledgerEnabled: true,
    updatePosition: () => {},
  });
  assert.equal(unrelatedLifecycle.state, LIFECYCLE_STATES.RECONCILIATION_REQUIRED);
  assert.equal(ledger.findTransaction(`lp:${unrelatedFixture.position}`, "rpc-unrelated-native-transfer").amounts.deposit_lamports, "0");

  const duplicateFixture = rpcShapedDlmmLiquidityReceipt({ duplicateLoadedKey: true });
  await assert.rejects(inspectLedgerTransaction("rpc-duplicate-effective-key", {
    walletAddress: duplicateFixture.wallet,
    connection: { getTransaction: async () => duplicateFixture.transaction },
    deployContext: { position: duplicateFixture.position, pool: duplicateFixture.pool },
  }), /duplicate effective/i);

  const unknownProgramFixture = rpcShapedDlmmLiquidityReceipt({ unknownOuterProgram: true });
  const unknownProgramReceipt = await inspectLedgerTransaction("rpc-unknown-outer-program", {
    walletAddress: unknownProgramFixture.wallet,
    connection: { getTransaction: async () => unknownProgramFixture.transaction },
    deployContext: { position: unknownProgramFixture.position, pool: unknownProgramFixture.pool },
  });
  assert.equal(unknownProgramReceipt.deployReceiptEvidence.kind, "invalid");
  assert.match(unknownProgramReceipt.deployReceiptEvidence.reason, /unknown outer program/i);

  activate("PositionA");
  assert.equal(requireLifecycleAttribution("PositionA", { store: ledger, ledgerEnabled: true }).pass, true);
  ledger.transitionLifecycle("lp:PositionA", LIFECYCLE_STATES.CLOSING);
  assert.equal(requireLifecycleAttribution("PositionA", { store: ledger, ledgerEnabled: true }).pass, false,
    "standalone claims are allowlisted to ACTIVE lifecycle state only");

  activate("PositionB");
  const first = acquireLifecycleOperation({
    operation: "claim",
    position: "PositionB",
    store: ledger,
    directory: operationDirectory,
    durable: true,
  });
  assert.throws(() => acquireLifecycleOperation({
    operation: "claim",
    position: "PositionB",
    store: ledger,
    directory: operationDirectory,
  }), (error) => error instanceof LifecycleOperationLeaseError && error.code === "LIFECYCLE_OPERATION_LEASE_HELD",
  "an existing O_EXCL lease is never stolen by a concurrent caller");

  // Simulate a crash after the first confirmed SDK signature: the checkpoint
  // exists before later receipt inspection and a clean retry adopts its exact
  // operation id instead of preparing another submission.
  checkpointLifecycleOperationSignature(first, {
    position: "PositionB",
    phase: "claim",
    signature: "claim-after-confirmation",
  });
  const duplicateCheckpoint = checkpointLifecycleOperationSignature(first, {
    position: "PositionB",
    phase: "claim",
    signature: "claim-after-confirmation",
  });
  assert.equal(duplicateCheckpoint.already_checkpointed, true);
  // A real crash leaves the O_EXCL lease in place. Recovery does not steal it;
  // this explicit temp-only removal represents operator reconciliation after
  // confirming the durable checkpoint.
  fs.unlinkSync(first.lease_file);

  // An explicitly supplied id cannot sidestep an unfinished checkpoint for a
  // different operation. Recovery must preserve that original identity.
  assert.throws(() => acquireLifecycleOperation({
    operation: "claim",
    position: "PositionB",
    operationId: "competing-operation-id",
    store: ledger,
    directory: operationDirectory,
  }), (error) => error instanceof LifecycleOperationLeaseError &&
    error.code === "LIFECYCLE_OPERATION_ID_MISMATCH");

  const replay = acquireLifecycleOperation({
    operation: "claim",
    position: "PositionB",
    store: ledger,
    directory: operationDirectory,
  });
  assert.equal(replay.operation_id, first.operation_id, "retry resumes the exact incomplete operation identity");
  // The old descriptor is now a stale capability. It must not write a late
  // checkpoint/final marker or remove the replacement owner's lease.
  assert.throws(() => checkpointLifecycleOperationSignature(first, {
    position: "PositionB",
    phase: "claim",
    signature: "stale-owner-checkpoint",
  }), (error) => error instanceof LifecycleOperationLeaseError &&
    error.code === "LIFECYCLE_OPERATION_LEASE_OWNERSHIP_LOST");
  assert.throws(() => finalizeLifecycleOperation(first), (error) => error instanceof LifecycleOperationLeaseError &&
    error.code === "LIFECYCLE_OPERATION_LEASE_OWNERSHIP_LOST");
  assert.throws(() => releaseLifecycleOperation(first), (error) => error instanceof LifecycleOperationLeaseError &&
    error.code === "LIFECYCLE_OPERATION_LEASE_OWNERSHIP_LOST");
  assert.deepEqual(getPendingLifecycleOperationCheckpoints(replay), [{
    operation: "claim",
    operation_id: first.operation_id,
    position: "PositionB",
    phase: "claim",
    signature: "claim-after-confirmation",
    metadata: {},
  }]);

  await recordLifecycleTransactions({
    position: "PositionB",
    walletAddress: "wallet",
    transactions: [{ signature: "claim-after-confirmation", phase: "claim" }],
    inspectTransaction: async (signature) => receipt(signature),
    store: ledger,
    ledgerEnabled: true,
  });
  assert.deepEqual(ledger.getLifecycle("lp:PositionB").signatures, [
    "deploy-PositionB",
    "claim-after-confirmation",
  ]);
  assert.throws(() => finalizeLifecycleOperation(replay), (error) => error instanceof LifecycleOperationLeaseError &&
    error.code === "LIFECYCLE_OPERATION_COMPLETION_REQUIRED",
  "a claim receipt alone can never finalize a multi-transaction-capable claim operation");
  completeLifecycleOperation(replay, {
    position: "PositionB",
    phase: "claim",
    expectedTransactions: [{ phase: "claim", signature: "claim-after-confirmation" }],
  });
  finalizeLifecycleOperation(replay);
  releaseLifecycleOperation(replay);

  // A short chunk of a close can never manufacture terminal completion. The
  // complete expected set must be checkpointed and a terminal close needs the
  // separate authoritative-absence assertion before it can be finalized.
  const partialClose = acquireLifecycleOperation({
    operation: "close",
    position: "PositionPartialClose",
    store: ledger,
    directory: operationDirectory,
  });
  checkpointLifecycleOperationSignature(partialClose, {
    position: "PositionPartialClose",
    phase: "close",
    signature: "chunk-one-confirmed",
  });
  assert.throws(() => completeLifecycleOperation(partialClose, {
    position: "PositionPartialClose",
    phase: "close",
    expectedTransactions: [
      { phase: "close", signature: "chunk-one-confirmed" },
      { phase: "close", signature: "chunk-two-missing" },
    ],
    positionAbsent: true,
  }), (error) => error instanceof LifecycleOperationLeaseError &&
    error.code === "LIFECYCLE_OPERATION_COMPLETION_RECEIPTS_INCOMPLETE",
  );
  assert.throws(() => finalizeLifecycleOperation(partialClose), (error) => error instanceof LifecycleOperationLeaseError &&
    error.code === "LIFECYCLE_OPERATION_COMPLETION_REQUIRED",
  );
  releaseLifecycleOperation(partialClose);

  // If persistence fails after confirmation, finally must close its descriptor
  // but retain the O_EXCL lease path. A later process cannot acquire or submit
  // until an explicit reconciliation removes that retained durable lease.
  const checkpointFailingFs = Object.assign(Object.create(fs), {
    writeSync(descriptor, buffer, offset, length, position) {
      const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer));
      if (bytes.toString("utf8").includes("\"type\":\"signature_checkpoint\"")) {
        const error = new Error("injected checkpoint persistence failure");
        error.code = "EIO";
        throw error;
      }
      return fs.writeSync(descriptor, buffer, offset, length, position);
    },
  });
  let retainedLease = null;
  await assert.rejects(withLifecycleOperation({
    operation: "claim",
    position: "PositionCheckpointPersistenceFailure",
    store: ledger,
    directory: operationDirectory,
    fsImpl: checkpointFailingFs,
    durable: false,
  }, async (operation) => {
    retainedLease = operation.lease_file;
    checkpointLifecycleOperationSignature(operation, {
      position: "PositionCheckpointPersistenceFailure",
      phase: "claim",
      signature: "confirmed-but-uncheckpointable",
    });
  }), (error) => error instanceof LifecycleOperationLeaseError &&
    error.code === "LIFECYCLE_OPERATION_CHECKPOINT_PERSISTENCE_FAILED");
  assert.equal(fs.existsSync(retainedLease), true, "post-confirmation checkpoint failure leaves the durable lease path in place");
  assert.throws(() => acquireLifecycleOperation({
    operation: "claim",
    position: "PositionCheckpointPersistenceFailure",
    store: ledger,
    directory: operationDirectory,
  }), (error) => error instanceof LifecycleOperationLeaseError && error.code === "LIFECYCLE_OPERATION_LEASE_HELD");
  fs.unlinkSync(retainedLease); // explicit manual reconciliation in this isolated fixture

  // Ordinary failures before any confirmed submission still release normally;
  // retention is reserved strictly for post-confirmation durability failure.
  let noSubmissionLease = null;
  const noSubmissionFailure = await withLifecycleOperation({
    operation: "claim",
    position: "PositionNoSubmissionFailure",
    store: ledger,
    directory: operationDirectory,
    durable: false,
  }, async (operation) => {
    noSubmissionLease = operation.lease_file;
    return { success: false, error: "SDK rejected before submission" };
  });
  assert.equal(noSubmissionFailure.success, false);
  assert.equal(fs.existsSync(noSubmissionLease), false, "no-submission failures must not poison a future retry");

  // A process termination can leave the O_EXCL lease before the SDK submits.
  // Only a fresh, post-lease chain observation plus an empty journal may
  // release that exact operation; any observed signature remains fail-closed.
  const interruptedBeforeSubmission = acquireLifecycleOperation({
    operation: "close",
    position: "PositionInterruptedBeforeSubmission",
    store: ledger,
    directory: operationDirectory,
    durable: false,
  });
  const interruptedLeaseBytes = fs.readFileSync(interruptedBeforeSubmission.lease_file);
  releaseLifecycleOperation(interruptedBeforeSubmission);
  fs.writeFileSync(interruptedBeforeSubmission.lease_file, interruptedLeaseBytes, { mode: 0o600 });
  const releasedUnsubmitted = await reconcileUnsubmittedLifecycleOperationLease({
    operation: "close",
    position: "PositionInterruptedBeforeSubmission",
    operationId: interruptedBeforeSubmission.operation_id,
    store: ledger,
    directory: operationDirectory,
    durable: false,
    verifyOutcome: async (lease) => ({
      outcome: "no_submitted_operation",
      observation_source: "fixture_confirmed_rpc_position_history",
      observed_at: new Date(Date.parse(lease.acquired_at) + 1_000).toISOString(),
      position_exists: true,
      signatures_after_lease: [],
    }),
  });
  assert.equal(releasedUnsubmitted.released, true);
  assert.equal(fs.existsSync(interruptedBeforeSubmission.lease_file), false);

  const ambiguousInterrupted = acquireLifecycleOperation({
    operation: "close",
    position: "PositionInterruptedAmbiguous",
    store: ledger,
    directory: operationDirectory,
    durable: false,
  });
  const ambiguousLeaseBytes = fs.readFileSync(ambiguousInterrupted.lease_file);
  releaseLifecycleOperation(ambiguousInterrupted);
  fs.writeFileSync(ambiguousInterrupted.lease_file, ambiguousLeaseBytes, { mode: 0o600 });
  await assert.rejects(reconcileUnsubmittedLifecycleOperationLease({
    operation: "close",
    position: "PositionInterruptedAmbiguous",
    operationId: ambiguousInterrupted.operation_id,
    store: ledger,
    directory: operationDirectory,
    durable: false,
    verifyOutcome: async (lease) => ({
      outcome: "no_submitted_operation",
      observation_source: "fixture_confirmed_rpc_position_history",
      observed_at: new Date(Date.parse(lease.acquired_at) + 1_000).toISOString(),
      position_exists: true,
      signatures_after_lease: ["unexpected-close-signature"],
    }),
  }), /does not prove an unsubmitted lifecycle operation/i);
  fs.unlinkSync(ambiguousInterrupted.lease_file);

  // Two independently scheduled receipt writers both inspect the same
  // signature. The append lease plus post-inspection recheck emits one line.
  activate("PositionC");
  await Promise.all([
    recordLifecycleTransactions({
      position: "PositionC",
      walletAddress: "wallet",
      transactions: [{ signature: "duplicate-across-writers", phase: "claim" }],
      inspectTransaction: async (signature) => { await Promise.resolve(); return receipt(signature); },
      store: ledger,
      ledgerEnabled: true,
    }),
    recordLifecycleTransactions({
      position: "PositionC",
      walletAddress: "wallet",
      transactions: [{ signature: "duplicate-across-writers", phase: "claim" }],
      inspectTransaction: async (signature) => { await Promise.resolve(); return receipt(signature); },
      store: ledger,
      ledgerEnabled: true,
    }),
  ]);
  assert.deepEqual(ledger.getLifecycle("lp:PositionC").signatures, [
    "deploy-PositionC",
    "duplicate-across-writers",
  ], "an exact same-phase signature is idempotent across writers");

  // A compact but unterminated checkpoint is indistinguishable from a torn
  // confirmed-signature write and therefore blocks recovery/resubmission.
  const partial = acquireLifecycleOperation({
    operation: "claim",
    position: "PositionPartialJournal",
    store: ledger,
    directory: operationDirectory,
  });
  releaseLifecycleOperation(partial);
  fs.writeFileSync(partial.checkpoint_file, JSON.stringify({
    type: "signature_checkpoint",
    operation_id: "partial-operation",
    signature: "confirmed-but-torn",
  }));
  assert.throws(() => acquireLifecycleOperation({
    operation: "claim",
    position: "PositionPartialJournal",
    store: ledger,
    directory: operationDirectory,
  }), /not newline terminated/i);

  // Syntax alone is insufficient for a durable recovery journal: a complete
  // JSON object with no lifecycle-record schema must fail closed as well.
  const invalidSchemaJournal = acquireLifecycleOperation({
    operation: "claim",
    position: "PositionInvalidSchemaJournal",
    store: ledger,
    directory: operationDirectory,
  });
  releaseLifecycleOperation(invalidSchemaJournal);
  fs.writeFileSync(invalidSchemaJournal.checkpoint_file, "{}\n");
  assert.throws(() => acquireLifecycleOperation({
    operation: "claim",
    position: "PositionInvalidSchemaJournal",
    store: ledger,
    directory: operationDirectory,
  }), /record type is invalid/i);

  // Both final journal files and exclusive lease files reject hardlinks; a
  // symlinked operation directory is rejected during descriptor traversal.
  const hardlinkedJournal = acquireLifecycleOperation({
    operation: "claim",
    position: "PositionHardlinkedJournal",
    store: ledger,
    directory: operationDirectory,
  });
  releaseLifecycleOperation(hardlinkedJournal);
  const checkpointTarget = path.join(tempDir, "checkpoint-target.jsonl");
  fs.writeFileSync(checkpointTarget, "{}\n");
  fs.linkSync(checkpointTarget, hardlinkedJournal.checkpoint_file);
  assert.throws(() => acquireLifecycleOperation({
    operation: "claim",
    position: "PositionHardlinkedJournal",
    store: ledger,
    directory: operationDirectory,
  }), /hard links/i);

  const linkedLease = acquireLifecycleOperation({
    operation: "close",
    position: "PositionHardlinkedLease",
    store: ledger,
    directory: operationDirectory,
  });
  const leaseTarget = path.join(tempDir, "lease-target");
  fs.linkSync(linkedLease.lease_file, leaseTarget);
  assert.throws(() => acquireLifecycleOperation({
    operation: "close",
    position: "PositionHardlinkedLease",
    store: ledger,
    directory: operationDirectory,
  }), (error) => error instanceof LifecycleOperationLeaseError &&
    error.code === "LIFECYCLE_OPERATION_LEASE_UNAVAILABLE" && /hard links/i.test(error.message));
  fs.unlinkSync(leaseTarget);
  releaseLifecycleOperation(linkedLease);

  const symlinkedDirectory = path.join(tempDir, "symlinked-operations");
  fs.symlinkSync(operationDirectory, symlinkedDirectory);
  assert.throws(() => acquireLifecycleOperation({
    operation: "deploy",
    operationKey: "symlinked-directory",
    store: ledger,
    directory: symlinkedDirectory,
  }), (error) => error instanceof LifecycleOperationLeaseError &&
    error.code === "LIFECYCLE_OPERATION_LEASE_UNAVAILABLE");

  const shortWrite = acquireLifecycleOperation({
    operation: "claim",
    position: "PositionShortCheckpoint",
    store: ledger,
    directory: path.join(tempDir, "short-write-operations"),
    fsImpl: shortWriteFs(),
    durable: false,
  });
  checkpointLifecycleOperationSignature(shortWrite, {
    position: "PositionShortCheckpoint",
    phase: "claim",
    signature: "short-write-confirmed",
  });
  assert.equal(getPendingLifecycleOperationCheckpoints(shortWrite).length, 1,
    "short descriptor writes are retried before a signature checkpoint is accepted");
  releaseLifecycleOperation(shortWrite);

  // A replacement that races the completion append is detected after the
  // journal read and before any success marker reaches the stream. The retry
  // sees only the confirmed checkpoint, never a stale-owner completion.
  const completionRace = replacementRaceFs();
  const racedCompletion = acquireLifecycleOperation({
    operation: "claim",
    position: "PositionCompletionReplacementRace",
    store: ledger,
    directory: operationDirectory,
    fsImpl: completionRace.fsImpl,
    durable: false,
  });
  checkpointLifecycleOperationSignature(racedCompletion, {
    position: "PositionCompletionReplacementRace",
    phase: "claim",
    signature: "completion-race-checkpoint",
  });
  completionRace.arm(racedCompletion);
  assert.throws(() => completeLifecycleOperation(racedCompletion, {
    position: "PositionCompletionReplacementRace",
    phase: "claim",
    expectedTransactions: [{ phase: "claim", signature: "completion-race-checkpoint" }],
  }), (error) => error instanceof LifecycleOperationLeaseError &&
    error.code === "LIFECYCLE_OPERATION_LEASE_OWNERSHIP_LOST",
  "a replacement between completion ownership verification and append writes no completion");
  assert.deepEqual(operationJournalEvents(racedCompletion).map((event) => event.type), ["signature_checkpoint"]);
  fs.unlinkSync(racedCompletion.lease_file); // fixture-only removal of the replacement inode
  const completionRaceRecovery = acquireLifecycleOperation({
    operation: "claim",
    position: "PositionCompletionReplacementRace",
    store: ledger,
    directory: operationDirectory,
  });
  assert.equal(getLifecycleOperationRecoveryEvidence(completionRaceRecovery).completions.length, 0,
    "the replacement race cannot be recovered as a completed claim");
  releaseLifecycleOperation(completionRaceRecovery);

  // The same interleaving at finalization must not append a late final marker.
  const finalRace = replacementRaceFs();
  const racedFinalization = acquireLifecycleOperation({
    operation: "claim",
    position: "PositionFinalizationReplacementRace",
    store: ledger,
    directory: operationDirectory,
    fsImpl: finalRace.fsImpl,
    durable: false,
  });
  checkpointLifecycleOperationSignature(racedFinalization, {
    position: "PositionFinalizationReplacementRace",
    phase: "claim",
    signature: "finalization-race-checkpoint",
  });
  completeLifecycleOperation(racedFinalization, {
    position: "PositionFinalizationReplacementRace",
    phase: "claim",
    expectedTransactions: [{ phase: "claim", signature: "finalization-race-checkpoint" }],
  });
  finalRace.arm(racedFinalization);
  assert.throws(() => finalizeLifecycleOperation(racedFinalization), (error) => error instanceof LifecycleOperationLeaseError &&
    error.code === "LIFECYCLE_OPERATION_LEASE_OWNERSHIP_LOST",
  "a replacement between finalization ownership verification and append writes no finalization");
  assert.equal(operationJournalEvents(racedFinalization).filter((event) => event.type === "operation_finalized").length, 0);
  fs.unlinkSync(racedFinalization.lease_file); // fixture-only removal of the replacement inode
  const finalRaceRecovery = acquireLifecycleOperation({
    operation: "claim",
    position: "PositionFinalizationReplacementRace",
    store: ledger,
    directory: operationDirectory,
  });
  assert.equal(getLifecycleOperationRecoveryEvidence(finalRaceRecovery).completions.length, 1,
    "a legitimate successor can see completion evidence but not a stale finalization");
  releaseLifecycleOperation(finalRaceRecovery);

  // If a lease is replaced after success bytes are durable, both an O_EXCL
  // mutation lock and a poison record remain. Even after this fixture removes
  // the lock to inspect the sidecar, acquisition refuses recovery as success.
  const postAppendRace = postAppendReplacementFs();
  const postAppendCompletion = acquireLifecycleOperation({
    operation: "claim",
    position: "PositionPostAppendReplacementRace",
    store: ledger,
    directory: operationDirectory,
    fsImpl: postAppendRace.fsImpl,
    durable: false,
  });
  checkpointLifecycleOperationSignature(postAppendCompletion, {
    position: "PositionPostAppendReplacementRace",
    phase: "claim",
    signature: "post-append-race-checkpoint",
  });
  postAppendRace.arm(postAppendCompletion, "operation_completed");
  assert.throws(() => completeLifecycleOperation(postAppendCompletion, {
    position: "PositionPostAppendReplacementRace",
    phase: "claim",
    expectedTransactions: [{ phase: "claim", signature: "post-append-race-checkpoint" }],
  }), (error) => error instanceof LifecycleOperationLeaseError &&
    error.code === "LIFECYCLE_OPERATION_LEASE_OWNERSHIP_LOST");
  assert.equal(operationJournalEvents(postAppendCompletion).filter((event) => event.type === "operation_completed").length, 1,
    "the post-write race fixture leaves the success-shaped bytes in place");
  assert.equal(fs.existsSync(postAppendCompletion.poison_file), true,
    "a durable poison sidecar permanently fail-closes the ambiguous journal");
  const poisonedMutationLock = path.join(
    path.dirname(postAppendCompletion.checkpoint_file),
    `.${path.basename(postAppendCompletion.checkpoint_file)}.mutation.lock`,
  );
  fs.unlinkSync(postAppendCompletion.lease_file); // fixture-only removal of the replacement inode
  fs.unlinkSync(poisonedMutationLock); // prove the sidecar itself also blocks recovery
  assert.throws(() => acquireLifecycleOperation({
    operation: "claim",
    position: "PositionPostAppendReplacementRace",
    operationId: postAppendCompletion.operation_id,
    store: ledger,
    directory: operationDirectory,
  }), (error) => error instanceof LifecycleOperationLeaseError &&
    error.code === "LIFECYCLE_OPERATION_POISONED");
  releaseLifecycleOperation(postAppendCompletion);

  // Position-scoped operations cannot accept caller-provided forged positions
  // at checkpoint, completion, or finalization.
  const positionBoundClaim = acquireLifecycleOperation({
    operation: "claim",
    position: "PositionBoundClaim",
    store: ledger,
    directory: operationDirectory,
  });
  assert.throws(() => checkpointLifecycleOperationSignature(positionBoundClaim, {
    position: "ForgedPosition",
    phase: "claim",
    signature: "forged-checkpoint",
  }), (error) => error instanceof LifecycleOperationLeaseError &&
    error.code === "LIFECYCLE_OPERATION_POSITION_MISMATCH");
  checkpointLifecycleOperationSignature(positionBoundClaim, {
    position: "PositionBoundClaim",
    phase: "claim",
    signature: "bound-checkpoint",
  });
  assert.throws(() => completeLifecycleOperation(positionBoundClaim, {
    position: "ForgedPosition",
    phase: "claim",
    expectedTransactions: [{ phase: "claim", signature: "bound-checkpoint" }],
  }), (error) => error instanceof LifecycleOperationLeaseError &&
    error.code === "LIFECYCLE_OPERATION_POSITION_MISMATCH");
  completeLifecycleOperation(positionBoundClaim, {
    position: "PositionBoundClaim",
    phase: "claim",
    expectedTransactions: [{ phase: "claim", signature: "bound-checkpoint" }],
  });
  assert.throws(() => finalizeLifecycleOperation(positionBoundClaim, { position: "ForgedPosition" }),
    (error) => error instanceof LifecycleOperationLeaseError && error.code === "LIFECYCLE_OPERATION_POSITION_MISMATCH");
  finalizeLifecycleOperation(positionBoundClaim);
  releaseLifecycleOperation(positionBoundClaim);

  // Resource-scoped deploys bind the first verified position append-only, then
  // require that same position for all later evidence and finalization.
  const unboundDeploy = acquireLifecycleOperation({
    operation: "deploy",
    operationKey: "deploy-resource-requires-verified-position",
    store: ledger,
    directory: operationDirectory,
  });
  assert.throws(() => finalizeLifecycleOperation(unboundDeploy, { position: "CallerControlledDeployPosition" }),
    (error) => error instanceof LifecycleOperationLeaseError && error.code === "LIFECYCLE_OPERATION_POSITION_REQUIRED");
  releaseLifecycleOperation(unboundDeploy);

  const boundDeploy = acquireLifecycleOperation({
    operation: "deploy",
    operationKey: "deploy-resource-position-binding",
    store: ledger,
    directory: operationDirectory,
  });
  checkpointLifecycleOperationSignature(boundDeploy, {
    position: "VerifiedDeployPosition",
    phase: "deploy",
    signature: "deploy-position-binding-checkpoint",
  });
  assert.throws(() => checkpointLifecycleOperationSignature(boundDeploy, {
    position: "ConflictingDeployPosition",
    phase: "deploy",
    signature: "deploy-position-binding-conflict",
  }), (error) => error instanceof LifecycleOperationLeaseError &&
    error.code === "LIFECYCLE_OPERATION_POSITION_MISMATCH");
  assert.throws(() => completeLifecycleOperation(boundDeploy, {
    position: "ConflictingDeployPosition",
    phase: "deploy",
    expectedTransactions: [{ phase: "deploy", signature: "deploy-position-binding-checkpoint" }],
  }), (error) => error instanceof LifecycleOperationLeaseError &&
    error.code === "LIFECYCLE_OPERATION_POSITION_MISMATCH");
  completeLifecycleOperation(boundDeploy, {
    position: "VerifiedDeployPosition",
    phase: "deploy",
    expectedTransactions: [{ phase: "deploy", signature: "deploy-position-binding-checkpoint" }],
  });
  finalizeLifecycleOperation(boundDeploy);
  assert.equal(operationJournalEvents(boundDeploy).find((event) => event.type === "operation_finalized").position,
    "VerifiedDeployPosition");
  releaseLifecycleOperation(boundDeploy);

  // A final operation id is never acquirable again, and a syntactically valid
  // record injected after finalization invalidates the whole stream.
  const finalizedOperation = acquireLifecycleOperation({
    operation: "claim",
    position: "PositionNoRecordsAfterFinalization",
    operationId: "finalized-operation-id",
    store: ledger,
    directory: operationDirectory,
  });
  checkpointLifecycleOperationSignature(finalizedOperation, {
    position: "PositionNoRecordsAfterFinalization",
    phase: "claim",
    signature: "finalized-operation-checkpoint",
  });
  completeLifecycleOperation(finalizedOperation, {
    position: "PositionNoRecordsAfterFinalization",
    phase: "claim",
    expectedTransactions: [{ phase: "claim", signature: "finalized-operation-checkpoint" }],
  });
  finalizeLifecycleOperation(finalizedOperation);
  releaseLifecycleOperation(finalizedOperation);
  assert.equal(operationJournalEvents(finalizedOperation).filter((event) => event.type === "operation_finalized").length, 1);
  assert.throws(() => acquireLifecycleOperation({
    operation: "claim",
    position: "PositionNoRecordsAfterFinalization",
    operationId: "finalized-operation-id",
    store: ledger,
    directory: operationDirectory,
  }), (error) => error instanceof LifecycleOperationLeaseError &&
    error.code === "LIFECYCLE_OPERATION_ID_FINALIZED");
  fs.appendFileSync(finalizedOperation.checkpoint_file, `${JSON.stringify({
    type: "signature_checkpoint",
    operation: "claim",
    operation_id: "finalized-operation-id",
    resource: "PositionNoRecordsAfterFinalization",
    position: "PositionNoRecordsAfterFinalization",
    phase: "claim",
    signature: "late-after-finalization",
    checkpointed_at: "2026-07-24T00:00:00.000Z",
    metadata: {},
  })}\n`);
  assert.throws(() => acquireLifecycleOperation({
    operation: "claim",
    position: "PositionNoRecordsAfterFinalization",
    store: ledger,
    directory: operationDirectory,
  }), /records after finalization/i);

  console.log("durable lifecycle operation tests passed");
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
