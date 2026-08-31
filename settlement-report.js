import path from "node:path";
import { config } from "./config.js";
import { repoPath } from "./repo-root.js";
import {
  aggregateLedgerEvents,
  LEDGER_EVENT_TYPES,
  LIFECYCLE_STATES,
  readTradeLedgerEvents,
} from "./trade-ledger.js";

const LAMPORTS_PER_SOL = 1_000_000_000n;
const CLOSED_STATES = new Set([
  LIFECYCLE_STATES.CLOSING,
  LIFECYCLE_STATES.CLEANUP_PENDING,
]);

export const SETTLEMENT_REPORT_SOURCE = "trade_ledger_wallet_equity_net";
export const SETTLEMENT_REPORT_TIME_ZONE = "Asia/Jakarta";

function ledgerPath(filePath = null) {
  if (filePath) return path.resolve(filePath);
  const configured = config.ledger?.path || "trade-ledger.jsonl";
  return path.isAbsolute(configured) ? configured : repoPath(configured);
}

function dateMs(value, field) {
  const parsed = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (!Number.isFinite(parsed)) throw new TypeError(`${field} must be a valid date`);
  return parsed;
}

function bigint(value, field) {
  try {
    return BigInt(value ?? 0);
  } catch {
    throw new TypeError(`${field} must be an integer`);
  }
}

function sol(lamports) {
  return Number(lamports) / Number(LAMPORTS_PER_SOL);
}

function pct(numerator, denominator) {
  if (denominator <= 0n) return null;
  return Number(numerator) / Number(denominator) * 100;
}

function latestCloseReason(events) {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event.event_type === LEDGER_EVENT_TYPES.STATE_TRANSITION &&
        event.to_state === LIFECYCLE_STATES.CLOSING) {
      return event.reason || null;
    }
  }
  return null;
}

function reconciledTransactions(events) {
  const transactions = new Map();
  for (const event of events) {
    if (event.event_type === LEDGER_EVENT_TYPES.TRANSACTION_RECORDED) {
      transactions.set(event.signature, event);
      continue;
    }
    if (event.event_type !== LEDGER_EVENT_TYPES.TRANSACTION_RECONCILED) continue;
    const original = transactions.get(event.signature);
    if (!original) continue;
    transactions.set(event.signature, {
      ...original,
      amounts: event.amounts,
      token_deltas: event.token_deltas,
      metadata: event.metadata,
      reconciliation_id: event.reconciliation_id,
      reconciled_at: event.occurred_at,
    });
  }
  return [...transactions.values()];
}

function sumTransactionDelta(transactions, predicate) {
  return transactions.reduce((total, transaction) => {
    if (!predicate(transaction)) return total;
    return total + bigint(
      transaction.amounts?.liquid_wallet_delta_lamports,
      "liquid_wallet_delta_lamports",
    );
  }, 0n);
}

function dateKeyParts(value, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return Object.fromEntries(
    formatter.formatToParts(new Date(value))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
}

export function settlementDateKey(value, timeZone = SETTLEMENT_REPORT_TIME_ZONE) {
  const parts = dateKeyParts(value, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function settlementRecord(lifecycle, events) {
  const settlement = lifecycle.settlement;
  if (!settlement || lifecycle.state !== LIFECYCLE_STATES.SETTLED || settlement.reconciled !== true) {
    return { excluded: "unreconciled" };
  }

  const basisLamports = bigint(lifecycle.cost_basis?.usable_basis_lamports, "usable_basis_lamports");
  if (lifecycle.cost_basis?.ready !== true || basisLamports <= 0n) {
    return { excluded: "invalid_basis" };
  }

  const residualLamports = bigint(settlement.residual_token_value_lamports, "residual_token_value_lamports");
  const reclaimableRentLamports = bigint(settlement.reclaimable_rent_lamports, "reclaimable_rent_lamports");
  if (residualLamports !== 0n || reclaimableRentLamports !== 0n) {
    return { excluded: "non_cash" };
  }

  const netLamports = bigint(settlement.wallet_equity_net_lamports, "wallet_equity_net_lamports");
  const transactions = reconciledTransactions(events);
  const deployWalletDeltaLamports = sumTransactionDelta(
    transactions,
    (transaction) => transaction.phase === "deploy",
  );
  const postDeployWalletDeltaLamports = sumTransactionDelta(
    transactions,
    (transaction) => transaction.phase !== "deploy",
  );
  if (deployWalletDeltaLamports + postDeployWalletDeltaLamports !== netLamports) {
    return { excluded: "wallet_flow_mismatch" };
  }

  const settledAt = settlement.occurred_at;
  const deployedAt = lifecycle.metadata?.deployed_at || lifecycle.created_at;
  const deployedAtMs = dateMs(deployedAt, "deployed_at");
  const settledAtMs = dateMs(settledAt, "settled_at");
  const finalLamports = basisLamports + netLamports;
  const txFeeLamports = bigint(lifecycle.amounts?.tx_fee_lamports, "tx_fee_lamports");
  const rentCreatedLamports = bigint(lifecycle.amounts?.rent_created_lamports, "rent_created_lamports");
  const rentReclaimedLamports = bigint(lifecycle.amounts?.rent_reclaimed_lamports, "rent_reclaimed_lamports");
  const swapCostLamports = bigint(lifecycle.amounts?.swap_cost_lamports, "swap_cost_lamports");

  return {
    record: {
      lifecycle_id: lifecycle.lifecycle_id,
      settlement_id: settlement.event_id,
      position: lifecycle.position_address,
      pool: lifecycle.pool_address,
      pool_name: lifecycle.metadata?.pool_name || lifecycle.pool_address?.slice(0, 8) || "unknown",
      base_mint: lifecycle.metadata?.base_mint || null,
      strategy: lifecycle.metadata?.strategy || null,
      close_reason: latestCloseReason(events),
      deployed_at: new Date(deployedAtMs).toISOString(),
      settled_at: new Date(settledAtMs).toISOString(),
      settled_day_jakarta: settlementDateKey(settledAtMs),
      minutes_held: Math.max(0, Math.round((settledAtMs - deployedAtMs) / 60_000)),
      principal_lamports: basisLamports.toString(),
      principal_sol: sol(basisLamports),
      final_lamports: finalLamports.toString(),
      final_sol: sol(finalLamports),
      pnl_lamports: netLamports.toString(),
      pnl_sol: sol(netLamports),
      pnl_pct: pct(netLamports, basisLamports),
      wallet_deploy_delta_lamports: deployWalletDeltaLamports.toString(),
      wallet_deploy_outflow_sol: sol(-deployWalletDeltaLamports),
      wallet_post_deploy_delta_lamports: postDeployWalletDeltaLamports.toString(),
      wallet_post_deploy_inflow_sol: sol(postDeployWalletDeltaLamports),
      tx_fee_lamports: txFeeLamports.toString(),
      tx_fee_sol: sol(txFeeLamports),
      swap_cost_lamports: swapCostLamports.toString(),
      swap_cost_sol: sol(swapCostLamports),
      rent_created_lamports: rentCreatedLamports.toString(),
      rent_created_sol: sol(rentCreatedLamports),
      rent_reclaimed_lamports: rentReclaimedLamports.toString(),
      rent_reclaimed_sol: sol(rentReclaimedLamports),
      transaction_count: transactions.length,
      reconciled: true,
      cash_settled: true,
      pnl_source: SETTLEMENT_REPORT_SOURCE,
    },
  };
}

export function readSettlementInventory({ filePath = null } = {}) {
  if (filePath == null && config.ledger?.enabled !== true) {
    throw new Error("Authoritative trade ledger is disabled; web/API PnL fallback is not allowed");
  }
  const events = readTradeLedgerEvents(ledgerPath(filePath));
  const eventsByLifecycle = new Map();
  for (const event of events) {
    const bucket = eventsByLifecycle.get(event.lifecycle_id) || [];
    bucket.push(event);
    eventsByLifecycle.set(event.lifecycle_id, bucket);
  }

  const records = [];
  const terminalExclusions = [];
  const status = {
    open_lifecycle_count: 0,
    settlement_pending_count: 0,
    excluded_unreconciled_count: 0,
  };

  for (const [lifecycleId, lifecycleEvents] of eventsByLifecycle) {
    const lifecycle = aggregateLedgerEvents(lifecycleEvents, lifecycleId);
    if (!lifecycle.settlement) {
      if (CLOSED_STATES.has(lifecycle.state)) status.settlement_pending_count += 1;
      else if (lifecycle.state === LIFECYCLE_STATES.RECONCILIATION_REQUIRED) {
        status.excluded_unreconciled_count += 1;
      } else if (lifecycle.state !== LIFECYCLE_STATES.SETTLED) {
        status.open_lifecycle_count += 1;
      }
      continue;
    }

    const result = settlementRecord(lifecycle, lifecycleEvents);
    if (result.record) {
      records.push(result.record);
      continue;
    }
    if (result.excluded === "unreconciled") {
      status.excluded_unreconciled_count += 1;
      continue;
    }
    terminalExclusions.push({
      reason: result.excluded,
      occurred_at: lifecycle.settlement?.occurred_at || lifecycle.created_at,
    });
  }

  return { records, status, terminalExclusions };
}

function dedupeSettlementRecords(records) {
  const deduped = new Map();
  for (const record of records) {
    const key = String(record?.lifecycle_id || record?.settlement_id || "").trim();
    if (!key) continue;
    const existing = deduped.get(key);
    if (!existing || dateMs(record.settled_at, "settled_at") > dateMs(existing.settled_at, "settled_at")) {
      deduped.set(key, record);
    }
  }
  return [...deduped.values()];
}

export function summarizeSettlementRecords(records) {
  const uniqueRecords = dedupeSettlementRecords(Array.isArray(records) ? records : []);
  let principalLamports = 0n;
  let finalLamports = 0n;
  let pnlLamports = 0n;
  let walletDeployOutflowLamports = 0n;
  let walletPostDeployInflowLamports = 0n;
  let txFeeLamports = 0n;
  let rentCreatedLamports = 0n;
  let rentReclaimedLamports = 0n;
  let wins = 0;
  let losses = 0;
  let breakeven = 0;

  for (const record of uniqueRecords) {
    const principal = bigint(record.principal_lamports, "principal_lamports");
    const pnl = bigint(record.pnl_lamports, "pnl_lamports");
    principalLamports += principal;
    finalLamports += bigint(record.final_lamports, "final_lamports");
    pnlLamports += pnl;
    walletDeployOutflowLamports += -bigint(record.wallet_deploy_delta_lamports, "wallet_deploy_delta_lamports");
    walletPostDeployInflowLamports += bigint(record.wallet_post_deploy_delta_lamports, "wallet_post_deploy_delta_lamports");
    txFeeLamports += bigint(record.tx_fee_lamports, "tx_fee_lamports");
    rentCreatedLamports += bigint(record.rent_created_lamports, "rent_created_lamports");
    rentReclaimedLamports += bigint(record.rent_reclaimed_lamports, "rent_reclaimed_lamports");
    if (pnl > 0n) wins += 1;
    else if (pnl < 0n) losses += 1;
    else breakeven += 1;
  }

  return {
    count: uniqueRecords.length,
    total_positions_settled: uniqueRecords.length,
    wins,
    losses,
    breakeven,
    win_rate_pct: uniqueRecords.length > 0 ? wins / uniqueRecords.length * 100 : null,
    total_principal_lamports: principalLamports.toString(),
    total_principal_sol: sol(principalLamports),
    total_final_lamports: finalLamports.toString(),
    total_final_sol: sol(finalLamports),
    total_pnl_lamports: pnlLamports.toString(),
    total_pnl_sol: sol(pnlLamports),
    total_pnl_pct: pct(pnlLamports, principalLamports),
    total_wallet_deploy_outflow_lamports: walletDeployOutflowLamports.toString(),
    total_wallet_deploy_outflow_sol: sol(walletDeployOutflowLamports),
    total_wallet_post_deploy_inflow_lamports: walletPostDeployInflowLamports.toString(),
    total_wallet_post_deploy_inflow_sol: sol(walletPostDeployInflowLamports),
    total_tx_fee_lamports: txFeeLamports.toString(),
    total_tx_fee_sol: sol(txFeeLamports),
    total_rent_created_lamports: rentCreatedLamports.toString(),
    total_rent_created_sol: sol(rentCreatedLamports),
    total_rent_reclaimed_lamports: rentReclaimedLamports.toString(),
    total_rent_reclaimed_sol: sol(rentReclaimedLamports),
  };
}

export function getSettlementPerformanceHistory({
  hours = 24,
  limit = 20,
  now = new Date(),
  from = null,
  to = null,
  filePath = null,
} = {}) {
  const nowMs = dateMs(now, "now");
  const toMs = to == null ? nowMs : dateMs(to, "to");
  const normalizedHours = hours == null ? null : Number(hours);
  if (normalizedHours != null && (!Number.isFinite(normalizedHours) || normalizedHours <= 0)) {
    throw new RangeError("hours must be a positive number or null");
  }
  const fromMs = from != null
    ? dateMs(from, "from")
    : normalizedHours == null
      ? Number.NEGATIVE_INFINITY
      : toMs - normalizedHours * 60 * 60 * 1000;
  if (fromMs >= toMs) throw new RangeError("from must be earlier than to");

  const inventory = readSettlementInventory({ filePath });
  const matching = dedupeSettlementRecords(inventory.records)
    .filter((record) => {
      const settledAtMs = dateMs(record.settled_at, "settled_at");
      return settledAtMs >= fromMs && settledAtMs < toMs;
    })
    .sort((left, right) => dateMs(right.settled_at, "settled_at") - dateMs(left.settled_at, "settled_at"));
  const matchingExclusions = inventory.terminalExclusions.filter((exclusion) => {
    const occurredAtMs = dateMs(exclusion.occurred_at, "exclusion.occurred_at");
    return occurredAtMs >= fromMs && occurredAtMs < toMs;
  });
  const exclusionCount = (reason) => matchingExclusions.filter((exclusion) => exclusion.reason === reason).length;
  const normalizedLimit = Math.max(0, Math.min(500, Math.floor(Number(limit) || 0)));

  return {
    source: SETTLEMENT_REPORT_SOURCE,
    authoritative: true,
    unit: "SOL",
    scope: "closed_cash_settlements_only",
    excludes: [
      "meteora_web_pnl",
      "lp_api_pnl",
      "unrelated_wallet_transfers",
      "open_position_estimates",
      "unreconciled_or_non_cash_settlements",
    ],
    time_zone: SETTLEMENT_REPORT_TIME_ZONE,
    hours: normalizedHours,
    period_from: Number.isFinite(fromMs) ? new Date(fromMs).toISOString() : null,
    period_to: new Date(toMs).toISOString(),
    ...summarizeSettlementRecords(matching),
    ...inventory.status,
    excluded_non_cash_count: exclusionCount("non_cash"),
    excluded_invalid_basis_count: exclusionCount("invalid_basis"),
    excluded_wallet_flow_mismatch_count: exclusionCount("wallet_flow_mismatch"),
    returned_count: Math.min(matching.length, normalizedLimit),
    positions: matching.slice(0, normalizedLimit),
  };
}

export function getSettlementPerformanceSummary(options = {}) {
  const report = getSettlementPerformanceHistory({
    ...options,
    hours: null,
    limit: 0,
  });
  const { positions, returned_count, ...summary } = report;
  return summary;
}
