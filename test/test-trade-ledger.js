import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  LIFECYCLE_STATES,
  TradeLedger,
  aggregateLedgerEvents,
  calculateComponentEquityNetLamports,
  calculateGrossPositionPnlLamports,
  calculateGuardedPnl,
  calculateProjectedEquityNetLamports,
  calculateRealizedEquityNetLamports,
  readTradeLedgerEvents,
  reconcileLedgerAmounts,
} from "../trade-ledger.js";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-trade-ledger-"));
const ledgerPath = path.join(tempDir, "trade-ledger.jsonl");
let eventSequence = 0;
let timeSequence = 0;
const ledger = new TradeLedger({
  filePath: ledgerPath,
  durable: false,
  idFactory: () => `event-${++eventSequence}`,
  now: () => new Date(Date.parse("2026-07-01T00:00:00.000Z") + (++timeSequence * 1_000)),
});

function shortWriteFs(maximumBytes = 3) {
  return Object.assign(Object.create(fs), {
    writeSync(descriptor, buffer, offset, length, position) {
      return fs.writeSync(descriptor, buffer, offset, Math.min(length, maximumBytes), position);
    },
  });
}

function runConcurrentLedgerWriter(filePath, signature) {
  const moduleUrl = pathToFileURL(path.resolve("trade-ledger.js")).href;
  const source = [
    `import { TradeLedger } from ${JSON.stringify(moduleUrl)};`,
    `const ledger = new TradeLedger({ filePath: ${JSON.stringify(filePath)}, idFactory: () => ${JSON.stringify(`event-${signature}`)} });`,
    `ledger.recordTransaction({ lifecycle_id: "concurrent", signature: ${JSON.stringify(signature)}, phase: "deploy", layer_id: "single", amounts: { tx_fee_lamports: 1n } });`,
  ].join("\n");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", source], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`concurrent ledger writer exited ${code}: ${stderr}`));
    });
  });
}

try {
  // Regression: a delayed 70/30 multi-layer deposit must never expose the
  // partial 70% basis which previously manufactured a +42.85% PnL tick.
  ledger.createLifecycle({
    lifecycle_id: "multi-layer-70-30",
    position_address: "Position111",
    pool_address: "Pool111",
    expected_deposit_lamports: 120_000_000n,
    expected_layers: [
      { layer_id: "primary-70", expected_deposit_lamports: 84_000_000n },
      { layer_id: "secondary-30", expected_deposit_lamports: 36_000_000n },
    ],
    // This fixture explicitly exercises the optional legacy RPC-validation
    // mode. Production deploys use required_stable_basis_reads: 0 because
    // receipt-proven reserve deltas, not an invented account basis field, are
    // the historical basis.
    required_stable_basis_reads: 2,
    occurred_at: "2026-06-01T00:00:00.000Z",
  });
  ledger.transitionLifecycle("multi-layer-70-30", LIFECYCLE_STATES.BASIS_PENDING);
  ledger.recordTransaction({
    lifecycle_id: "multi-layer-70-30",
    signature: "sig-deploy-primary",
    phase: "deploy",
    layer_id: "primary-70",
    amounts: {
      deposit_lamports: 84_000_000n,
      liquid_wallet_delta_lamports: -124_000_005n,
      tx_fee_lamports: 5n,
      rent_created_lamports: 40_000_000n,
    },
    token_deltas: [{ mint: "TokenMint111", raw_amount: "900719925474099312345" }],
  });
  ledger.recordBasisObservation({
    lifecycle_id: "multi-layer-70-30",
    source: "rpc",
    deposit_lamports: 84_000_000n,
  });
  ledger.recordBasisObservation({
    lifecycle_id: "multi-layer-70-30",
    source: "rpc",
    deposit_lamports: 84_000_000n,
  });
  ledger.recordBasisObservation({
    lifecycle_id: "multi-layer-70-30",
    source: "external",
    deposit_lamports: 84_000_000n,
  });

  let lifecycle = ledger.getLifecycle("multi-layer-70-30");
  assert.equal(lifecycle.cost_basis.ready, false);
  assert.equal(lifecycle.cost_basis.local_confirmed_basis_lamports, "84000000");
  assert.equal(lifecycle.cost_basis.usable_basis_lamports, null);
  assert.equal(lifecycle.cost_basis.external.accepted, false);
  assert.match(lifecycle.cost_basis.external.reason, /local_basis_not_ready/);
  assert.ok(lifecycle.cost_basis.reason_codes.includes("EXPECTED_LAYERS_INCOMPLETE"));
  assert.ok(lifecycle.cost_basis.reason_codes.includes("LOCAL_BASIS_TOTAL_MISMATCH"));

  const falsePartialPnlPct = ((120_000_000 - 84_000_000) / 84_000_000) * 100;
  assert.equal(Number(falsePartialPnlPct.toFixed(2)), 42.86);
  const falseThirtyPercentPnlPct = ((120_000_000 - 36_000_000) / 36_000_000) * 100;
  assert.equal(Number(falseThirtyPercentPnlPct.toFixed(2)), 233.33);
  assert.deepEqual(calculateGuardedPnl({
    cost_basis: lifecycle.cost_basis,
    current_position_value_lamports: 120_000_000n,
  }), {
    ready: false,
    basis_lamports: null,
    pnl_lamports: null,
    pnl_bps: null,
    reason_codes: lifecycle.cost_basis.reason_codes,
  });
  assert.throws(
    () => ledger.transitionLifecycle("multi-layer-70-30", LIFECYCLE_STATES.ACTIVE),
    /cost basis not ready/i,
  );

  // Being old does not release the guard. Only the missing confirmed layer and
  // two new complete RPC reads can make the local basis usable.
  ledger.recordTransaction({
    lifecycle_id: "multi-layer-70-30",
    signature: "sig-deploy-secondary",
    phase: "deploy",
    layer_id: "secondary-30",
    amounts: {
      deposit_lamports: 36_000_000n,
      liquid_wallet_delta_lamports: -36_000_005n,
      tx_fee_lamports: 5n,
    },
  });
  lifecycle = ledger.getLifecycle("multi-layer-70-30");
  assert.equal(lifecycle.cost_basis.ready, false);
  assert.equal(lifecycle.cost_basis.stable_rpc_reads, 0);

  ledger.recordBasisObservation({
    lifecycle_id: "multi-layer-70-30",
    source: "rpc",
    deposit_lamports: 120_000_000n,
  });
  assert.equal(ledger.getLifecycle("multi-layer-70-30").cost_basis.ready, false);

  ledger.recordBasisObservation({
    lifecycle_id: "multi-layer-70-30",
    source: "rpc",
    deposit_lamports: 120_000_000n,
  });
  lifecycle = ledger.getLifecycle("multi-layer-70-30");
  assert.equal(lifecycle.cost_basis.ready, true);
  assert.equal(lifecycle.cost_basis.usable_basis_lamports, "120000000");
  assert.equal(lifecycle.cost_basis.source, "position_bound_confirmed_receipts");
  assert.equal(lifecycle.cost_basis.external.accepted, false, "stale partial API basis remains rejected");
  assert.equal(ledger.assertCostBasisReady("multi-layer-70-30"), "120000000");

  const guardedPnl = calculateGuardedPnl({
    cost_basis: lifecycle.cost_basis,
    current_position_value_lamports: 120_000_000n,
  });
  assert.equal(guardedPnl.ready, true);
  assert.equal(guardedPnl.pnl_lamports, "0");
  assert.equal(guardedPnl.pnl_bps, "0");

  ledger.recordBasisObservation({
    lifecycle_id: "multi-layer-70-30",
    source: "external",
    deposit_lamports: 120_000_001n,
  });
  assert.equal(
    ledger.getLifecycle("multi-layer-70-30").cost_basis.external.accepted,
    true,
    "external basis is validation-only and accepted within one lamport",
  );
  ledger.transitionLifecycle("multi-layer-70-30", LIFECYCLE_STATES.ACTIVE);

  assert.throws(() => ledger.recordTransaction({
    lifecycle_id: "multi-layer-70-30",
    signature: "sig-deploy-secondary",
    phase: "hold",
  }), /Duplicate transaction signature/);
  assert.throws(() => ledger.recordTransaction({
    lifecycle_id: "multi-layer-70-30",
    signature: "sig-fractional",
    phase: "hold",
    amounts: { tx_fee_lamports: 1.5 },
  }), /must be a safe integer/);

  ledger.transitionLifecycle("multi-layer-70-30", LIFECYCLE_STATES.CLOSING);
  ledger.recordTransaction({
    lifecycle_id: "multi-layer-70-30",
    signature: "sig-close",
    phase: "close",
    amounts: {
      withdrawal_lamports: 122_000_000n,
      claimed_fee_lamports: 1_000_000n,
      liquid_wallet_delta_lamports: 162_999_995n,
      tx_fee_lamports: 5n,
      rent_reclaimed_lamports: 40_000_000n,
    },
    token_deltas: [{ mint: "TokenMint111", raw_amount: "-900719925474099312345" }],
  });
  ledger.transitionLifecycle("multi-layer-70-30", LIFECYCLE_STATES.CLEANUP_PENDING);
  ledger.recordValuation({
    lifecycle_id: "multi-layer-70-30",
    source: "confirmed-wallet-snapshot",
    residual_token_value_lamports: 0n,
    reclaimable_rent_lamports: 0n,
  });
  const settlement = ledger.finalizeSettlement({
    lifecycle_id: "multi-layer-70-30",
    tolerance_lamports: 0n,
  });
  assert.equal(settlement.outcome_state, LIFECYCLE_STATES.SETTLED);

  lifecycle = ledger.getLifecycle("multi-layer-70-30");
  assert.equal(lifecycle.state, LIFECYCLE_STATES.SETTLED);
  assert.equal(lifecycle.amounts.deposit_lamports, "120000000");
  assert.equal(lifecycle.amounts.withdrawal_lamports, "122000000");
  assert.equal(lifecycle.amounts.claimed_fee_lamports, "1000000");
  assert.equal(lifecycle.amounts.tx_fee_lamports, "15");
  assert.equal(lifecycle.amounts.rent_created_lamports, "40000000");
  assert.equal(lifecycle.amounts.rent_reclaimed_lamports, "40000000");
  assert.equal(lifecycle.gross_position_pnl_lamports, "3000000");
  assert.equal(lifecycle.wallet_equity_net_lamports, "2999985");
  assert.equal(lifecycle.component_equity_net_lamports, "2999985");
  assert.equal(lifecycle.reconciliation.reconciliation_error_lamports, "0");
  assert.equal(lifecycle.token_raw_deltas.TokenMint111, "0");
  assert.throws(() => ledger.recordValuation({
    lifecycle_id: "multi-layer-70-30",
    source: "late-write",
  }), /already settled/);

  // JSONL is append-only, newline-delimited, and preserves exact integers as
  // strings even when raw token amounts exceed Number.MAX_SAFE_INTEGER.
  const rawLines = fs.readFileSync(ledgerPath, "utf8").trim().split("\n");
  const parsedEvents = readTradeLedgerEvents(ledgerPath);
  assert.equal(rawLines.length, parsedEvents.length);
  assert.equal(parsedEvents[2].amounts.deposit_lamports, "84000000");
  assert.equal(parsedEvents[2].token_deltas[0].raw_amount, "900719925474099312345");

  // Storage paths are hostile input: a symlink or hardlink must never be
  // followed as a ledger, even if its target contains otherwise valid JSONL.
  const hostileTarget = path.join(tempDir, "hostile-target.jsonl");
  fs.writeFileSync(hostileTarget, fs.readFileSync(ledgerPath));
  const symlinkLedger = path.join(tempDir, "symlink-ledger.jsonl");
  fs.symlinkSync(hostileTarget, symlinkLedger);
  assert.throws(() => readTradeLedgerEvents(symlinkLedger), /regular file|symlink|secure/i);
  const hardlinkLedger = path.join(tempDir, "hardlink-ledger.jsonl");
  fs.linkSync(hostileTarget, hardlinkLedger);
  assert.throws(() => readTradeLedgerEvents(hardlinkLedger), /hard links/i);

  // A valid JSON object without its JSONL delimiter is still a failed/torn
  // append and must block both readers and later writers.
  const partialLedger = path.join(tempDir, "partial-ledger.jsonl");
  fs.writeFileSync(partialLedger, fs.readFileSync(ledgerPath, "utf8").trimEnd());
  assert.throws(() => readTradeLedgerEvents(partialLedger), /not newline terminated/i);

  const shortWriteLedger = new TradeLedger({
    filePath: path.join(tempDir, "short-write-ledger.jsonl"),
    fsImpl: shortWriteFs(),
    idFactory: () => "short-write-event",
  });
  shortWriteLedger.createLifecycle({
    lifecycle_id: "short-write",
    pool_address: "PoolShortWrite",
    expected_deposit_lamports: 1n,
  });
  assert.equal(shortWriteLedger.readEvents().length, 1, "short descriptor writes are retried to a complete record");

  // Two independent Node processes append distinct receipts at once.  The
  // durable lock serializes their read/validate/append cycles without losing
  // either receipt or emitting a torn final record.
  const concurrentPath = path.join(tempDir, "concurrent-ledger.jsonl");
  let concurrentEventSequence = 0;
  const concurrentLedger = new TradeLedger({
    filePath: concurrentPath,
    idFactory: () => `concurrent-event-${++concurrentEventSequence}`,
  });
  concurrentLedger.createLifecycle({
    lifecycle_id: "concurrent",
    pool_address: "PoolConcurrent",
    expected_deposit_lamports: 1n,
  });
  concurrentLedger.transitionLifecycle("concurrent", LIFECYCLE_STATES.BASIS_PENDING);
  await Promise.all([
    runConcurrentLedgerWriter(concurrentPath, "concurrent-signature-a"),
    runConcurrentLedgerWriter(concurrentPath, "concurrent-signature-b"),
  ]);
  assert.deepEqual(
    readTradeLedgerEvents(concurrentPath)
      .filter((event) => event.event_type === "transaction_recorded")
      .map((event) => event.signature)
      .sort(),
    ["concurrent-signature-a", "concurrent-signature-b"],
  );

  // The append lock may floor only a locally generated implicit timestamp.
  // Explicit historical evidence is immutable and must fail if it reverses
  // lifecycle chronology; an equal explicit timestamp remains valid.
  const timestampLedger = new TradeLedger({
    filePath: path.join(tempDir, "timestamp-ledger.jsonl"),
    durable: false,
    idFactory: (() => { let n = 0; return () => `timestamp-event-${++n}`; })(),
    now: () => new Date("2026-07-01T00:00:00.000Z"),
  });
  timestampLedger.createLifecycle({
    lifecycle_id: "timestamp-order",
    pool_address: "PoolTimestamp",
    expected_deposit_lamports: 1n,
    occurred_at: "2026-07-01T00:00:10.000Z",
  });
  timestampLedger.transitionLifecycle("timestamp-order", LIFECYCLE_STATES.BASIS_PENDING);
  assert.equal(timestampLedger.readEvents().at(-1).occurred_at, "2026-07-01T00:00:10.000Z", "implicit clock skew is floored after lock acquisition");
  assert.throws(() => timestampLedger.transitionLifecycle("timestamp-order", LIFECYCLE_STATES.CLOSING, {
    occurred_at: "2026-07-01T00:00:00.000Z",
  }), /Explicit occurred_at .* precedes existing lifecycle chronology/i);
  timestampLedger.transitionLifecycle("timestamp-order", LIFECYCLE_STATES.CLOSING, {
    occurred_at: "2026-07-01T00:00:10.000Z",
  });
  assert.equal(timestampLedger.readEvents().at(-1).occurred_at, "2026-07-01T00:00:10.000Z", "equal explicit lifecycle timestamps remain permitted");

  // A settlement mismatch is persistent and fail-closed.
  ledger.createLifecycle({
    lifecycle_id: "mismatch",
    pool_address: "PoolMismatch",
    expected_deposit_lamports: 1n,
  });
  ledger.transitionLifecycle("mismatch", LIFECYCLE_STATES.CLOSING, { reason: "cancel before deploy" });
  ledger.recordTransaction({
    lifecycle_id: "mismatch",
    signature: "sig-mismatch-fee",
    phase: "other",
    execution_status: "failed",
    amounts: {
      liquid_wallet_delta_lamports: -10n,
      tx_fee_lamports: 5n,
    },
  });
  const mismatch = ledger.finalizeSettlement({
    lifecycle_id: "mismatch",
    tolerance_lamports: 0n,
  });
  assert.equal(mismatch.outcome_state, LIFECYCLE_STATES.RECONCILIATION_REQUIRED);
  assert.equal(mismatch.reconciliation_error_lamports, "-5");
  assert.equal(ledger.getLifecycle("mismatch").state, LIFECYCLE_STATES.RECONCILIATION_REQUIRED);

  // Failed receipts may account for a charged network fee and wallet delta,
  // but never a token balance or provenance change. Reject that at the public
  // append boundary before a receipt can reach the journal.
  const failedTokenLedger = new TradeLedger({
    filePath: path.join(tempDir, "failed-token-append-ledger.jsonl"),
    durable: false,
    idFactory: () => `failed-token-event-${++eventSequence}`,
  });
  failedTokenLedger.createLifecycle({
    lifecycle_id: "failed-token-append",
    pool_address: "PoolFailedToken",
    expected_deposit_lamports: 1n,
  });
  failedTokenLedger.transitionLifecycle("failed-token-append", LIFECYCLE_STATES.CLOSING);
  assert.throws(() => failedTokenLedger.recordTransaction({
    lifecycle_id: "failed-token-append",
    signature: "sig-failed-token-append",
    phase: "other",
    execution_status: "failed",
    token_deltas: [{ mint: "TokenMintFailed", raw_amount: 1n }],
  }), /Failed transaction cannot record token_deltas/i);
  assert.throws(() => failedTokenLedger.recordTransaction({
    lifecycle_id: "failed-token-append",
    signature: "sig-failed-provenance-append",
    phase: "other",
    execution_status: "failed",
    metadata: {
      token_account_evidence: [{
        account: "TokenAccountFailed",
        mint: "TokenMintFailed",
        pre_raw_amount: "0",
        post_raw_amount: "1",
        raw_amount: "1",
      }],
    },
  }), /Failed transaction cannot record token_account_evidence/i);
  assert.throws(() => failedTokenLedger.recordTransaction({
    lifecycle_id: "failed-token-append",
    signature: "sig-failed-provenance-object-append",
    phase: "other",
    execution_status: "failed",
    metadata: { token_account_evidence: { forged: true } },
  }), /metadata\.token_account_evidence must be an array/i);
  assert.throws(() => failedTokenLedger.recordTransaction({
    lifecycle_id: "failed-token-append",
    signature: "sig-malformed-provenance-row-append",
    phase: "other",
    metadata: {
      token_account_evidence: [{
        account: "TokenAccountFailed",
        mint: "TokenMintFailed",
        pre_raw_amount: "0",
        post_raw_amount: "1",
      }],
    },
  }), /metadata\.token_account_evidence\[0\] has missing or unexpected fields/i);
  assert.equal(failedTokenLedger.readEvents().length, 2, "rejected failed token receipt is never appended");

  // Transaction receipts must match the lifecycle operation that can actually
  // be in progress. This checks direct append validation and all supported
  // deploy/claim/close/cleanup domains, including recovery after a latch.
  const phaseLedger = new TradeLedger({
    filePath: path.join(tempDir, "transaction-phase-domain-ledger.jsonl"),
    durable: false,
    idFactory: () => `phase-domain-event-${++eventSequence}`,
  });
  phaseLedger.createLifecycle({
    lifecycle_id: "phase-domain",
    pool_address: "PoolPhaseDomain",
    expected_deposit_lamports: 1n,
  });
  assert.throws(() => phaseLedger.recordTransaction({
    lifecycle_id: "phase-domain",
    signature: "premature-close",
    phase: "close",
  }), /Transaction phase close is not permitted.*PENDING_DEPLOY/i);
  phaseLedger.transitionLifecycle("phase-domain", LIFECYCLE_STATES.BASIS_PENDING);
  phaseLedger.recordTransaction({
    lifecycle_id: "phase-domain",
    signature: "phase-deploy",
    phase: "deploy",
    layer_id: "single",
    amounts: { deposit_lamports: 1n, liquid_wallet_delta_lamports: -1n },
  });
  phaseLedger.recordBasisObservation({ lifecycle_id: "phase-domain", source: "rpc", deposit_lamports: 1n });
  phaseLedger.recordBasisObservation({ lifecycle_id: "phase-domain", source: "rpc", deposit_lamports: 1n });
  phaseLedger.transitionLifecycle("phase-domain", LIFECYCLE_STATES.ACTIVE);
  phaseLedger.recordTransaction({ lifecycle_id: "phase-domain", signature: "active-claim", phase: "claim" });
  assert.throws(() => phaseLedger.recordTransaction({
    lifecycle_id: "phase-domain",
    signature: "active-close",
    phase: "close",
  }), /Transaction phase close is not permitted.*ACTIVE/i);
  phaseLedger.transitionLifecycle("phase-domain", LIFECYCLE_STATES.CLOSING);
  phaseLedger.recordTransaction({ lifecycle_id: "phase-domain", signature: "closing-claim", phase: "claim" });
  phaseLedger.recordTransaction({ lifecycle_id: "phase-domain", signature: "closing-close", phase: "close" });
  phaseLedger.transitionLifecycle("phase-domain", LIFECYCLE_STATES.CLEANUP_PENDING);
  phaseLedger.recordTransaction({ lifecycle_id: "phase-domain", signature: "cleanup-swap", phase: "swap" });
  phaseLedger.recordTransaction({ lifecycle_id: "phase-domain", signature: "cleanup-close-account", phase: "cleanup" });
  phaseLedger.transitionLifecycle("phase-domain", LIFECYCLE_STATES.RECONCILIATION_REQUIRED);
  phaseLedger.recordTransaction({ lifecycle_id: "phase-domain", signature: "recovery-cleanup", phase: "cleanup" });
  phaseLedger.recordTransaction({ lifecycle_id: "phase-domain", signature: "recovery-close", phase: "close" });

  // The same domain restriction is replay-time invariant, not only a public
  // API guard. A valid close event spliced after a newly-created lifecycle is
  // semantically impossible even though both individual records are exact.
  const phaseEvents = phaseLedger.readEvents({ lifecycle_id: "phase-domain" });
  const impossiblePhaseEvents = [
    {
      ...structuredClone(phaseEvents[0]),
      event_id: "phase-replay-created",
      lifecycle_id: "phase-replay-pending",
    },
    {
      ...structuredClone(phaseEvents.find((event) => event.signature === "closing-close")),
      event_id: "phase-replay-close",
      lifecycle_id: "phase-replay-pending",
    },
  ];
  const impossiblePhasePath = path.join(tempDir, "impossible-phase-replay.jsonl");
  fs.writeFileSync(impossiblePhasePath, `${impossiblePhaseEvents.map((event) => JSON.stringify(event)).join("\n")}\n`);
  assert.throws(() => readTradeLedgerEvents(impossiblePhasePath), /Transaction phase close is not permitted.*PENDING_DEPLOY/i);

  // The timestamp written to disk is assigned while the append lease is held.
  // A backward/skewed caller clock therefore serializes behind prior events
  // instead of making a valid append unreplayable.
  const skewedTimes = [
    "2026-07-24T00:00:10.000Z",
    "2026-07-24T00:00:05.000Z",
    "2026-07-24T00:00:00.000Z",
  ];
  const skewedLedger = new TradeLedger({
    filePath: path.join(tempDir, "skewed-clock-ledger.jsonl"),
    durable: false,
    now: () => new Date(skewedTimes.shift()),
    idFactory: () => `skewed-clock-event-${++eventSequence}`,
  });
  skewedLedger.createLifecycle({ lifecycle_id: "skewed-clock", pool_address: "PoolSkewedClock", expected_deposit_lamports: 1n });
  skewedLedger.transitionLifecycle("skewed-clock", LIFECYCLE_STATES.BASIS_PENDING);
  skewedLedger.recordTransaction({
    lifecycle_id: "skewed-clock",
    signature: "skewed-deploy",
    phase: "deploy",
    layer_id: "single",
    amounts: { deposit_lamports: 1n },
  });
  assert.deepEqual(
    skewedLedger.readEvents().map((event) => event.occurred_at),
    ["2026-07-24T00:00:10.000Z", "2026-07-24T00:00:10.000Z", "2026-07-24T00:00:10.000Z"],
    "the append-order timestamp floor prevents a backward caller clock from corrupting replay chronology",
  );

  const globalSignatureLedger = new TradeLedger({
    filePath: path.join(tempDir, "global-signature-append-ledger.jsonl"),
    durable: false,
    idFactory: () => `global-signature-event-${++eventSequence}`,
  });
  for (const lifecycleId of ["global-signature-first", "global-signature-second"]) {
    globalSignatureLedger.createLifecycle({
      lifecycle_id: lifecycleId,
      pool_address: `Pool${lifecycleId}`,
      expected_deposit_lamports: 1n,
    });
    globalSignatureLedger.transitionLifecycle(lifecycleId, LIFECYCLE_STATES.CLOSING);
  }
  globalSignatureLedger.recordTransaction({
    lifecycle_id: "global-signature-first",
    signature: "sig-global-signature",
    phase: "other",
  });
  assert.throws(() => globalSignatureLedger.recordTransaction({
    lifecycle_id: "global-signature-second",
    signature: "sig-global-signature",
    phase: "other",
  }), /Duplicate transaction signature in ledger/i);

  // Replay accepts only exact event-specific schemas. In particular, a
  // reconciliation_cleared record without its explicit reconciliation_id
  // must not remove a historical latch from an aggregate.
  ledger.clearReconciliationLatch("mismatch", {
    reconciliation_id: "manual:mismatch-schema-regression",
    reason: "isolated schema regression fixture",
  });
  const mismatchEvents = ledger.readEvents({ lifecycle_id: "mismatch" });
  const malformedClearEvents = structuredClone(mismatchEvents);
  const malformedClear = malformedClearEvents.find((event) => event.event_type === "reconciliation_cleared");
  delete malformedClear.reconciliation_id;
  const malformedClearPath = path.join(tempDir, "malformed-reconciliation-clear.jsonl");
  fs.writeFileSync(malformedClearPath, `${malformedClearEvents.map((event) => JSON.stringify(event)).join("\n")}\n`);
  assert.throws(() => readTradeLedgerEvents(malformedClearPath), /reconciliation_cleared event has missing or unexpected fields/i);
  assert.throws(() => aggregateLedgerEvents(malformedClearEvents, "mismatch"), /reconciliation_cleared event has missing or unexpected fields/i);

  // Replay validates the complete journal: a duplicate signature in otherwise
  // valid, independent lifecycles is a ledger-wide collision, not a detail to
  // defer until one lifecycle happens to be aggregated.
  const firstLifecycleEvents = readTradeLedgerEvents(ledgerPath)
    .filter((event) => event.lifecycle_id === "multi-layer-70-30");
  const duplicateSignatureEvents = [
    ...firstLifecycleEvents,
    ...structuredClone(firstLifecycleEvents).map((event, index) => ({
      ...event,
      event_id: `duplicate-signature-event-${index + 1}`,
      lifecycle_id: "duplicate-signature-lifecycle",
    })),
  ];
  const duplicateSignaturePath = path.join(tempDir, "duplicate-signature-replay.jsonl");
  fs.writeFileSync(duplicateSignaturePath, `${duplicateSignatureEvents.map((event) => JSON.stringify(event)).join("\n")}\n`);
  assert.throws(() => readTradeLedgerEvents(duplicateSignaturePath), /Duplicate transaction signature in ledger/i);

  // A syntactically exact record stream is still invalid when its append order
  // violates lifecycle causality or its per-lifecycle chronology.
  const causalReplayEvents = structuredClone(firstLifecycleEvents);
  [causalReplayEvents[0], causalReplayEvents[1]] = [causalReplayEvents[1], causalReplayEvents[0]];
  const causalReplayPath = path.join(tempDir, "causal-replay.jsonl");
  fs.writeFileSync(causalReplayPath, `${causalReplayEvents.map((event) => JSON.stringify(event)).join("\n")}\n`);
  assert.throws(() => readTradeLedgerEvents(causalReplayPath), /events before lifecycle_created/i);

  const prematureActivationEvents = structuredClone(firstLifecycleEvents);
  const activationIndex = prematureActivationEvents.findIndex((event) => event.to_state === LIFECYCLE_STATES.ACTIVE);
  const [activation] = prematureActivationEvents.splice(activationIndex, 1);
  activation.occurred_at = prematureActivationEvents[1].occurred_at;
  prematureActivationEvents.splice(2, 0, activation);
  const prematureActivationPath = path.join(tempDir, "premature-activation-replay.jsonl");
  fs.writeFileSync(prematureActivationPath, `${prematureActivationEvents.map((event) => JSON.stringify(event)).join("\n")}\n`);
  assert.throws(() => readTradeLedgerEvents(prematureActivationPath), /Cannot activate .*cost basis not ready/i);

  const chronologyReplayEvents = structuredClone(firstLifecycleEvents);
  chronologyReplayEvents[1].occurred_at = "2026-05-31T23:59:59.000Z";
  const chronologyReplayPath = path.join(tempDir, "chronology-replay.jsonl");
  fs.writeFileSync(chronologyReplayPath, `${chronologyReplayEvents.map((event) => JSON.stringify(event)).join("\n")}\n`);
  assert.throws(() => readTradeLedgerEvents(chronologyReplayPath), /Invalid replay chronology/i);

  // Replay and direct aggregation reject failed token deltas rather than
  // silently incorporating a failed transaction into token exposure.
  const failedTokenReplayEvents = structuredClone(mismatchEvents);
  failedTokenReplayEvents.find((event) => event.event_type === "transaction_recorded").token_deltas = [{
    mint: "TokenMintFailed",
    account: null,
    raw_amount: "1",
  }];
  const failedTokenReplayPath = path.join(tempDir, "failed-token-replay.jsonl");
  fs.writeFileSync(failedTokenReplayPath, `${failedTokenReplayEvents.map((event) => JSON.stringify(event)).join("\n")}\n`);
  assert.throws(() => readTradeLedgerEvents(failedTokenReplayPath), /Failed transaction cannot record token_deltas/i);
  assert.throws(() => aggregateLedgerEvents(failedTokenReplayEvents, "mismatch"), /Failed transaction cannot record token_deltas/i);

  const failedProvenanceReplayEvents = structuredClone(mismatchEvents);
  failedProvenanceReplayEvents.find((event) => event.event_type === "transaction_recorded").metadata.token_account_evidence = [{
    account: "TokenAccountFailed",
    mint: "TokenMintFailed",
    pre_raw_amount: "0",
    post_raw_amount: "1",
    raw_amount: "1",
  }];
  const failedProvenanceReplayPath = path.join(tempDir, "failed-provenance-replay.jsonl");
  fs.writeFileSync(failedProvenanceReplayPath, `${failedProvenanceReplayEvents.map((event) => JSON.stringify(event)).join("\n")}\n`);
  assert.throws(() => readTradeLedgerEvents(failedProvenanceReplayPath), /Failed transaction cannot record token_account_evidence/i);
  assert.throws(() => aggregateLedgerEvents(failedProvenanceReplayEvents, "mismatch"), /Failed transaction cannot record token_account_evidence/i);

  const failedProvenanceTypeReplayEvents = structuredClone(mismatchEvents);
  failedProvenanceTypeReplayEvents.find((event) => event.event_type === "transaction_recorded").metadata.token_account_evidence = { forged: true };
  const failedProvenanceTypeReplayPath = path.join(tempDir, "failed-provenance-type-replay.jsonl");
  fs.writeFileSync(failedProvenanceTypeReplayPath, `${failedProvenanceTypeReplayEvents.map((event) => JSON.stringify(event)).join("\n")}\n`);
  assert.throws(() => readTradeLedgerEvents(failedProvenanceTypeReplayPath), /metadata\.token_account_evidence must be an array/i);
  assert.throws(() => aggregateLedgerEvents(failedProvenanceTypeReplayEvents, "mismatch"), /metadata\.token_account_evidence must be an array/i);

  // State, transaction, basis, valuation, and settlement records each reject
  // a missing, extra, or malformed field rather than normalizing it during
  // read/replay. Settlement arithmetic is also recomputed from prior receipts.
  const schemaFixtures = [
    {
      name: "invalid-transition",
      event: { ...firstLifecycleEvents.find((item) => item.event_type === "state_transition"), to_state: LIFECYCLE_STATES.SETTLED },
      message: /Invalid lifecycle state transition/i,
    },
    {
      name: "transaction-extra-field",
      event: { ...firstLifecycleEvents.find((item) => item.event_type === "transaction_recorded"), unexpected: true },
      message: /transaction_recorded event has missing or unexpected fields/i,
    },
    {
      name: "basis-missing-commitment",
      event: (() => {
        const event = { ...firstLifecycleEvents.find((item) => item.event_type === "basis_observed") };
        delete event.commitment;
        return event;
      })(),
      message: /basis_observed event has missing or unexpected fields/i,
    },
    {
      name: "valuation-malformed-amount",
      event: { ...firstLifecycleEvents.find((item) => item.event_type === "valuation_recorded"), residual_token_value_lamports: 0 },
      message: /canonical integer string/i,
    },
  ];
  for (const fixture of schemaFixtures) {
    const fixturePath = path.join(tempDir, `${fixture.name}.jsonl`);
    fs.writeFileSync(fixturePath, `${JSON.stringify(fixture.event)}\n`);
    assert.throws(() => readTradeLedgerEvents(fixturePath), fixture.message, fixture.name);
  }
  const settlementMismatchEvents = structuredClone(firstLifecycleEvents);
  const settlementMismatch = settlementMismatchEvents.find((event) => event.event_type === "settlement_finalized");
  settlementMismatch.wallet_equity_net_lamports = "1";
  assert.throws(
    () => aggregateLedgerEvents(settlementMismatchEvents, "multi-layer-70-30"),
    /Settlement wallet_equity_net_lamports does not match lifecycle aggregate/i,
  );

  // Pure helpers use bigint and keep gross, cost attribution, wallet equity,
  // projections, and reconciliation as distinct concepts.
  assert.equal(calculateGrossPositionPnlLamports({
    deposit_lamports: 100n,
    withdrawal_lamports: 102n,
    claimed_fee_lamports: 1n,
    residual_token_value_lamports: 2n,
  }), 5n);
  assert.equal(calculateComponentEquityNetLamports({
    deposit_lamports: 100n,
    withdrawal_lamports: 102n,
    claimed_fee_lamports: 1n,
    residual_token_value_lamports: 2n,
    tx_fee_lamports: 3n,
    swap_cost_lamports: 1n,
    rent_created_lamports: 10n,
    rent_reclaimed_lamports: 10n,
  }), 1n);
  assert.equal(calculateRealizedEquityNetLamports({
    liquid_wallet_delta_lamports: -10n,
    residual_token_value_lamports: 2n,
  }), -8n);
  assert.equal(calculateProjectedEquityNetLamports({
    deployed_lamports: 120_000_000n,
    projected_withdrawal_lamports: 123_000_000n,
    projected_tx_cost_lamports: 15n,
    projected_cleanup_cost_lamports: 10n,
    rent_created_lamports: 40_000_000n,
    projected_rent_reclaimed_lamports: 40_000_000n,
  }), 2_999_975n);
  assert.deepEqual(reconcileLedgerAmounts({
    deposit_lamports: "100",
    withdrawal_lamports: "103",
    claimed_fee_lamports: "0",
    liquid_wallet_delta_lamports: "1",
    tx_fee_lamports: "2",
    swap_cost_lamports: "0",
    rent_created_lamports: "0",
    rent_reclaimed_lamports: "0",
  }, { tolerance_lamports: 0 }), {
    wallet_equity_net_lamports: "1",
    component_equity_net_lamports: "1",
    reconciliation_error_lamports: "0",
    reconciliation_error_abs_lamports: "0",
    tolerance_lamports: "0",
    reconciled: true,
  });

  // Reconciliation is append-only: a later authoritative receipt decoder can
  // replace the economic interpretation of one already-recorded successful
  // deploy without deleting or rewriting its original event.
  const receiptRepair = new TradeLedger({
    filePath: path.join(tempDir, "receipt-repair.jsonl"),
    durable: false,
    idFactory: (() => { let n = 0; return () => `repair-event-${++n}`; })(),
    now: (() => { let n = 0; return () => new Date(Date.parse("2026-07-02T00:00:00.000Z") + (++n * 1_000)); })(),
  });
  receiptRepair.createLifecycle({
    lifecycle_id: "native-receipt-repair",
    position_address: "NativeReceiptPosition",
    pool_address: "NativeReceiptPool",
    expected_deposit_lamports: 200_000_000n,
  });
  receiptRepair.transitionLifecycle("native-receipt-repair", LIFECYCLE_STATES.BASIS_PENDING);
  const originalRepairReceipt = receiptRepair.recordTransaction({
    lifecycle_id: "native-receipt-repair",
    signature: "native-receipt-signature",
    phase: "deploy",
    layer_id: "single",
    amounts: {
      deposit_lamports: 0n,
      liquid_wallet_delta_lamports: -259_490_158n,
      tx_fee_lamports: 10_000n,
      rent_created_lamports: 59_480_160n,
    },
  });
  receiptRepair.transitionLifecycle("native-receipt-repair", LIFECYCLE_STATES.RECONCILIATION_REQUIRED);
  receiptRepair.reconcileTransaction({
    lifecycle_id: "native-receipt-repair",
    signature: "native-receipt-signature",
    reconciliation_id: "native-receipt-v2-decoder",
    original_event_id: originalRepairReceipt.event_id,
    amounts: {
      deposit_lamports: 200_000_000n,
      liquid_wallet_delta_lamports: -259_490_158n,
      tx_fee_lamports: 10_000n,
      rent_created_lamports: 59_480_160n,
    },
    metadata: { evidence_source: "position_bound_atomic_native_sol_receipt" },
  });
  let repairedLifecycle = receiptRepair.getLifecycle("native-receipt-repair");
  assert.equal(repairedLifecycle.cost_basis.ready, true);
  assert.equal(repairedLifecycle.cost_basis.usable_basis_lamports, "200000000");
  assert.equal(repairedLifecycle.amounts.deposit_lamports, "200000000");
  assert.equal(receiptRepair.findTransaction("native-receipt-repair", "native-receipt-signature").reconciliation_id,
    "native-receipt-v2-decoder");
  receiptRepair.clearReconciliationLatch("native-receipt-repair", {
    reconciliation_id: "native-receipt-v2-decoder",
    reason: "receipt evidence re-decoded from the confirmed on-chain transaction",
  });
  receiptRepair.transitionLifecycle("native-receipt-repair", LIFECYCLE_STATES.ACTIVE);
  repairedLifecycle = receiptRepair.getLifecycle("native-receipt-repair");
  assert.equal(repairedLifecycle.state, LIFECYCLE_STATES.ACTIVE);
  assert.deepEqual(repairedLifecycle.reconciliation_history.map((entry) => entry.type), ["latched", "cleared"]);
  assert.equal(receiptRepair.readEvents({ lifecycle_id: "native-receipt-repair" }).at(2).amounts.deposit_lamports, "0",
    "the original invalid interpretation remains durable and unchanged");

  const closeRepair = new TradeLedger({
    filePath: path.join(tempDir, "close-repair.jsonl"),
    durable: false,
    idFactory: (() => { let n = 0; return () => `close-repair-event-${++n}`; })(),
  });
  closeRepair.createLifecycle({
    lifecycle_id: "close-receipt-repair",
    position_address: "CloseReceiptPosition",
    pool_address: "CloseReceiptPool",
    expected_deposit_lamports: 1n,
  });
  closeRepair.transitionLifecycle("close-receipt-repair", LIFECYCLE_STATES.CLOSING);
  const originalCloseReceipt = closeRepair.recordTransaction({
    lifecycle_id: "close-receipt-repair",
    signature: "close-receipt-signature",
    phase: "close",
    amounts: { withdrawal_lamports: 1n, liquid_wallet_delta_lamports: 2n },
  });
  closeRepair.transitionLifecycle("close-receipt-repair", LIFECYCLE_STATES.CLEANUP_PENDING);
  closeRepair.transitionLifecycle("close-receipt-repair", LIFECYCLE_STATES.RECONCILIATION_REQUIRED);
  closeRepair.reconcileTransaction({
    lifecycle_id: "close-receipt-repair",
    signature: "close-receipt-signature",
    reconciliation_id: "close-receipt-v2-accounting",
    original_event_id: originalCloseReceipt.event_id,
    amounts: { withdrawal_lamports: 2n, liquid_wallet_delta_lamports: 2n },
  });
  assert.equal(closeRepair.getLifecycle("close-receipt-repair").amounts.withdrawal_lamports, "2",
    "a close correction replaces, rather than adds to, its original economics");
  assert.equal(closeRepair.readEvents({ lifecycle_id: "close-receipt-repair" })
    .find((event) => event.event_id === originalCloseReceipt.event_id).amounts.withdrawal_lamports, "1");

  console.log("trade-ledger tests passed");
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
