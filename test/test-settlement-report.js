import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LIFECYCLE_STATES, TradeLedger } from "../trade-ledger.js";
import {
  getSettlementPerformanceHistory,
  settlementDateKey,
  summarizeSettlementRecords,
} from "../settlement-report.js";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-settlement-report-"));
const filePath = path.join(tempDir, "trade-ledger.jsonl");
let sequence = 0;
const ledger = new TradeLedger({
  filePath,
  durable: false,
  idFactory: () => `settlement-report-event-${++sequence}`,
});

function createCotSettlement() {
  const lifecycleId = "lp:CotPosition";
  ledger.createLifecycle({
    lifecycle_id: lifecycleId,
    position_address: "CotPosition",
    pool_address: "CotPool",
    expected_deposit_lamports: 200_000_000n,
    required_stable_basis_reads: 0,
    occurred_at: "2026-08-30T21:41:18.255Z",
    metadata: {
      pool_name: "COT-SOL",
      strategy: "spot",
      deployed_at: "2026-08-30T21:41:18.143Z",
      unrelated_wallet_transfer_lamports: "1",
    },
  });
  ledger.transitionLifecycle(lifecycleId, LIFECYCLE_STATES.BASIS_PENDING, {
    occurred_at: "2026-08-30T21:41:18.298Z",
  });
  ledger.recordTransaction({
    lifecycle_id: lifecycleId,
    signature: "cot-deploy",
    phase: "deploy",
    layer_id: "single",
    occurred_at: "2026-08-30T21:41:18.643Z",
    amounts: {
      deposit_lamports: 200_000_000n,
      liquid_wallet_delta_lamports: -259_490_160n,
      tx_fee_lamports: 10_000n,
      rent_created_lamports: 59_480_160n,
    },
  });
  ledger.transitionLifecycle(lifecycleId, LIFECYCLE_STATES.ACTIVE, {
    occurred_at: "2026-08-30T21:41:18.721Z",
  });
  ledger.transitionLifecycle(lifecycleId, LIFECYCLE_STATES.CLOSING, {
    reason: "projected stop estimate",
    occurred_at: "2026-08-30T21:45:58.926Z",
  });
  ledger.recordTransaction({
    lifecycle_id: lifecycleId,
    signature: "cot-close",
    phase: "close",
    occurred_at: "2026-08-30T21:46:07.484Z",
    amounts: {
      withdrawal_lamports: 15_795_836n,
      liquid_wallet_delta_lamports: 73_196_916n,
      tx_fee_lamports: 5_000n,
      rent_reclaimed_lamports: 57_406_080n,
    },
    token_deltas: [{ mint: "CotMint", raw_amount: "98274432844" }],
  });
  ledger.transitionLifecycle(lifecycleId, LIFECYCLE_STATES.CLEANUP_PENDING, {
    occurred_at: "2026-08-30T21:46:07.552Z",
  });
  ledger.recordTransaction({
    lifecycle_id: lifecycleId,
    signature: "cot-swap",
    phase: "swap",
    occurred_at: "2026-08-30T21:46:45.410Z",
    amounts: {
      withdrawal_lamports: 189_952_385n,
      liquid_wallet_delta_lamports: 189_945_758n,
      tx_fee_lamports: 6_627n,
    },
    token_deltas: [{ mint: "CotMint", raw_amount: "-98274432844" }],
  });
  ledger.recordTransaction({
    lifecycle_id: lifecycleId,
    signature: "cot-cleanup",
    phase: "cleanup",
    occurred_at: "2026-08-30T21:46:46.031Z",
    amounts: {
      liquid_wallet_delta_lamports: 2_069_080n,
      tx_fee_lamports: 5_000n,
      rent_reclaimed_lamports: 2_074_080n,
    },
  });
  ledger.recordValuation({
    lifecycle_id: lifecycleId,
    source: "economic-cleanup-reconciliation",
    residual_token_value_lamports: 0n,
    reclaimable_rent_lamports: 0n,
    occurred_at: "2026-08-30T21:46:54.683Z",
  });
  ledger.finalizeSettlement({
    lifecycle_id: lifecycleId,
    tolerance_lamports: 0n,
    occurred_at: "2026-08-30T21:46:54.723Z",
  });
}

function createPendingSettlement() {
  const lifecycleId = "lp:PendingPosition";
  ledger.createLifecycle({
    lifecycle_id: lifecycleId,
    position_address: "PendingPosition",
    pool_address: "PendingPool",
    expected_deposit_lamports: 100_000_000n,
    required_stable_basis_reads: 0,
    occurred_at: "2026-08-30T22:00:00.000Z",
  });
  ledger.transitionLifecycle(lifecycleId, LIFECYCLE_STATES.BASIS_PENDING, {
    occurred_at: "2026-08-30T22:00:01.000Z",
  });
  ledger.recordTransaction({
    lifecycle_id: lifecycleId,
    signature: "pending-deploy",
    phase: "deploy",
    layer_id: "single",
    occurred_at: "2026-08-30T22:00:02.000Z",
    amounts: {
      deposit_lamports: 100_000_000n,
      liquid_wallet_delta_lamports: -100_005_000n,
      tx_fee_lamports: 5_000n,
    },
  });
  ledger.transitionLifecycle(lifecycleId, LIFECYCLE_STATES.ACTIVE, {
    occurred_at: "2026-08-30T22:00:03.000Z",
  });
  ledger.transitionLifecycle(lifecycleId, LIFECYCLE_STATES.CLOSING, {
    occurred_at: "2026-08-30T22:00:04.000Z",
  });
}

function createNonCashSettlement() {
  const lifecycleId = "lp:ResidualPosition";
  ledger.createLifecycle({
    lifecycle_id: lifecycleId,
    position_address: "ResidualPosition",
    pool_address: "ResidualPool",
    expected_deposit_lamports: 100_000_000n,
    required_stable_basis_reads: 0,
    occurred_at: "2026-08-30T20:00:00.000Z",
  });
  ledger.transitionLifecycle(lifecycleId, LIFECYCLE_STATES.BASIS_PENDING, {
    occurred_at: "2026-08-30T20:00:01.000Z",
  });
  ledger.recordTransaction({
    lifecycle_id: lifecycleId,
    signature: "residual-deploy",
    phase: "deploy",
    layer_id: "single",
    occurred_at: "2026-08-30T20:00:02.000Z",
    amounts: {
      deposit_lamports: 100_000_000n,
      liquid_wallet_delta_lamports: -159_490_160n,
      tx_fee_lamports: 10_000n,
      rent_created_lamports: 59_480_160n,
    },
  });
  ledger.transitionLifecycle(lifecycleId, LIFECYCLE_STATES.ACTIVE, {
    occurred_at: "2026-08-30T20:00:03.000Z",
  });
  ledger.transitionLifecycle(lifecycleId, LIFECYCLE_STATES.CLOSING, {
    occurred_at: "2026-08-30T20:00:04.000Z",
  });
  ledger.recordTransaction({
    lifecycle_id: lifecycleId,
    signature: "residual-close",
    phase: "close",
    occurred_at: "2026-08-30T20:05:00.000Z",
    amounts: {
      withdrawal_lamports: 50_000_000n,
      liquid_wallet_delta_lamports: 107_401_080n,
      tx_fee_lamports: 5_000n,
      rent_reclaimed_lamports: 57_406_080n,
    },
  });
  ledger.transitionLifecycle(lifecycleId, LIFECYCLE_STATES.CLEANUP_PENDING, {
    occurred_at: "2026-08-30T20:05:01.000Z",
  });
  ledger.recordValuation({
    lifecycle_id: lifecycleId,
    source: "residual-token-quote",
    residual_token_value_lamports: 50_000_000n,
    reclaimable_rent_lamports: 0n,
    occurred_at: "2026-08-30T20:09:00.000Z",
  });
  ledger.finalizeSettlement({
    lifecycle_id: lifecycleId,
    tolerance_lamports: 0n,
    occurred_at: "2026-08-30T20:10:00.000Z",
  });
}

function createUnreconciledSettlement() {
  const lifecycleId = "lp:UnreconciledPosition";
  ledger.createLifecycle({
    lifecycle_id: lifecycleId,
    position_address: "UnreconciledPosition",
    pool_address: "UnreconciledPool",
    expected_deposit_lamports: 100_000_000n,
    required_stable_basis_reads: 0,
    occurred_at: "2026-08-30T19:00:00.000Z",
  });
  ledger.transitionLifecycle(lifecycleId, LIFECYCLE_STATES.BASIS_PENDING, {
    occurred_at: "2026-08-30T19:00:01.000Z",
  });
  ledger.recordTransaction({
    lifecycle_id: lifecycleId,
    signature: "unreconciled-deploy",
    phase: "deploy",
    layer_id: "single",
    occurred_at: "2026-08-30T19:00:02.000Z",
    amounts: {
      deposit_lamports: 100_000_000n,
      liquid_wallet_delta_lamports: -100_005_000n,
      tx_fee_lamports: 5_000n,
    },
  });
  ledger.transitionLifecycle(lifecycleId, LIFECYCLE_STATES.ACTIVE, {
    occurred_at: "2026-08-30T19:00:03.000Z",
  });
  ledger.transitionLifecycle(lifecycleId, LIFECYCLE_STATES.CLOSING, {
    occurred_at: "2026-08-30T19:05:00.000Z",
  });
  ledger.recordTransaction({
    lifecycle_id: lifecycleId,
    signature: "unreconciled-close",
    phase: "close",
    occurred_at: "2026-08-30T19:05:01.000Z",
    amounts: {
      withdrawal_lamports: 91_000_000n,
      liquid_wallet_delta_lamports: 89_995_000n,
      tx_fee_lamports: 5_000n,
    },
  });
  ledger.transitionLifecycle(lifecycleId, LIFECYCLE_STATES.CLEANUP_PENDING, {
    occurred_at: "2026-08-30T19:05:02.000Z",
  });
  ledger.recordValuation({
    lifecycle_id: lifecycleId,
    source: "economic-cleanup-reconciliation",
    residual_token_value_lamports: 0n,
    reclaimable_rent_lamports: 0n,
    occurred_at: "2026-08-30T19:06:00.000Z",
  });
  ledger.finalizeSettlement({
    lifecycle_id: lifecycleId,
    tolerance_lamports: 0n,
    occurred_at: "2026-08-30T19:06:01.000Z",
  });
}

try {
  createCotSettlement();
  createPendingSettlement();
  createNonCashSettlement();
  createUnreconciledSettlement();

  const report = getSettlementPerformanceHistory({
    filePath,
    hours: 24,
    limit: 10,
    now: "2026-08-31T08:00:00+07:00",
  });

  assert.equal(report.source, "trade_ledger_wallet_equity_net");
  assert.equal(report.total_positions_settled, 1);
  assert.equal(report.settlement_pending_count, 1);
  assert.equal(report.excluded_unreconciled_count, 1);
  assert.equal(report.excluded_non_cash_count, 1);
  assert.equal(report.total_principal_lamports, "200000000");
  assert.equal(report.total_final_lamports, "205721594");
  assert.equal(report.total_pnl_lamports, "5721594");
  assert.equal(report.total_wallet_deploy_outflow_lamports, "259490160");
  assert.equal(report.total_wallet_post_deploy_inflow_lamports, "265211754");
  assert.equal(report.total_tx_fee_lamports, "26627");
  assert.equal(report.positions[0].pnl_pct, 2.860797);
  assert.equal(report.positions[0].transaction_count, 4);
  assert.equal(report.positions[0].pnl_lamports, "5721594",
    "lifecycle transaction deltas exclude unrelated wallet transfers in metadata or wallet history");

  const deduped = summarizeSettlementRecords([report.positions[0], report.positions[0]]);
  assert.equal(deduped.total_positions_settled, 1);
  assert.equal(deduped.total_pnl_lamports, "5721594");

  assert.equal(settlementDateKey("2026-08-30T16:59:59.999Z"), "2026-08-30");
  assert.equal(settlementDateKey("2026-08-30T17:00:00.000Z"), "2026-08-31");

  console.log("settlement-report tests passed");
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
