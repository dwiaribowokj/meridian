import { Connection, PublicKey } from "@solana/web3.js";
import { config } from "../config.js";
import { log } from "../logger.js";
import {
  getTrackedPosition,
  markOutOfRange,
  markInRange,
  minutesOutOfRange,
} from "../state.js";

// ─── Public-infra PnL engine ───────────────────────────────────
// Live position value (current liquidity + claimable fees) is read ON-CHAIN
// via the Meteora DLMM SDK on a public RPC (pump.helius). For locally tracked
// positions, cost basis comes only from the confirmed local transaction ledger;
// Meteora deposit fields are advisory diagnostics and are never authoritative.
// Token
// USD prices come from Jupiter. No LPAgent / agentmeridian dependency, so the
// poller can run aggressively on fully public resources.

const JUP_SEARCH = "https://datapi.jup.ag/v1/assets/search";
const METEORA_PNL = "https://dlmm.datapi.meteora.ag/positions";

// Lazy SDK load — mirrors tools/dlmm.js (CJS dir-imports break in ESM at import time).
let _DLMM = null;
async function loadDlmmSdk() {
  if (!_DLMM) {
    const mod = await import("@meteora-ag/dlmm");
    _DLMM = mod.default;
  }
  return _DLMM;
}

let _pnlConnection = null;
export function getPnlConnection() {
  if (!_pnlConnection) {
    _pnlConnection = new Connection(config.pnl.rpcUrl, "confirmed");
  }
  return _pnlConnection;
}

function safeNum(value) {
  const n = parseFloat(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}
function maybeNum(value) {
  if (value == null || value === "") return null;
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : null;
}
function fallbackDepositSol(tracked) {
  const amountSol = Number(tracked?.amount_sol);
  return Number.isFinite(amountSol) && amountSol > 0 ? amountSol : 0;
}

export function resolveTrackedCostBasisSol({ tracked = null, meteoraDepositsSol = 0 } = {}) {
  const fallbackDepositsSol = fallbackDepositSol(tracked);
  const localBasisLamports = Number(tracked?.local_cost_basis_lamports);
  const localBasisReady = tracked?.basis_status === "READY" && Number.isFinite(localBasisLamports) && localBasisLamports > 0;
  const ledgerTracked = tracked != null && Object.hasOwn(tracked, "basis_status");
  const localBasisSol = localBasisReady ? localBasisLamports / 1e9 : 0;
  // An old record without accounting status may retain its historical request
  // compatibility behavior. Once a record owns a status, only READY may use
  // a local ledger basis; every other value has no PnL economics.
  const legacyStateBasisSol = !ledgerTracked ? fallbackDepositsSol : 0;
  const depositsSol = localBasisSol > 0
    ? localBasisSol
    : legacyStateBasisSol > 0
      ? legacyStateBasisSol
      : !tracked && Number(meteoraDepositsSol) > 0
        ? Number(meteoraDepositsSol)
        : 0;
  return {
    deposits_sol: depositsSol,
    local_basis_ready: localBasisReady,
    legacy_state_basis_sol: legacyStateBasisSol,
    basis_valid: depositsSol > 0 && (!ledgerTracked || localBasisReady),
  };
}
function pnlOutlierReason({ pnlPct, reportedPct, pnlPctDiff, ageMinutes }) {
  if (!Number.isFinite(pnlPct)) return null;
  const absPnl = Math.abs(pnlPct);
  const newPositionMinutes = Number(config.management.pnlNewPositionOutlierMinutes ?? 3);
  const newPositionMaxPct = Number(config.management.pnlNewPositionOutlierMaxPct ?? 5);
  const outlierMaxPct = Number(config.management.pnlOutlierMaxPct ?? 20);
  const maxDiffPct = Number(config.management.pnlSanityMaxDiffPct ?? 5);
  const divergenceMinPct = Number(config.management.pnlDivergenceGateMinPct ?? 3);

  if (
    Number.isFinite(ageMinutes) &&
    Number.isFinite(newPositionMinutes) &&
    Number.isFinite(newPositionMaxPct) &&
    ageMinutes < newPositionMinutes &&
    absPnl >= newPositionMaxPct
  ) {
    return `new-position outlier ${pnlPct.toFixed(2)}% at ${ageMinutes}m`;
  }
  if (
    Number.isFinite(outlierMaxPct) &&
    Number.isFinite(maxDiffPct) &&
    absPnl >= outlierMaxPct &&
    (reportedPct == null || pnlPctDiff == null || pnlPctDiff > maxDiffPct)
  ) {
    return `absolute outlier ${pnlPct.toFixed(2)}%`;
  }
  if (
    Number.isFinite(maxDiffPct) &&
    Number.isFinite(divergenceMinPct) &&
    pnlPctDiff != null &&
    pnlPctDiff > maxDiffPct &&
    absPnl >= divergenceMinPct
  ) {
    return `reported/derived divergence ${pnlPctDiff.toFixed(2)}%`;
  }
  return null;
}
function round(value, decimals = 4) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}
function unique(arr) {
  return [...new Set(arr.filter(Boolean))];
}

// ─── Meteora /pnl per pool (deposit history) ────────────────────
// Exported because tools/dlmm.js (getPositionPnl + the Meteora fallback path)
// also reads it.
export async function fetchDlmmPnlForPool(poolAddress, walletAddress) {
  const url = `${METEORA_PNL}/${poolAddress}/pnl?user=${walletAddress}&status=open&pageSize=100&page=1`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      log("pnl_api", `HTTP ${res.status} for pool ${poolAddress.slice(0, 8)}: ${body.slice(0, 120)}`);
      return {};
    }
    const data = await res.json();
    const positions = data.positions || data.data || [];
    const byAddress = {};
    for (const p of positions) {
      const addr = p.positionAddress || p.address || p.position;
      if (addr) byAddress[addr] = p;
    }
    return byAddress;
  } catch (e) {
    log("pnl_api", `Fetch error for pool ${poolAddress.slice(0, 8)}: ${e.message}`);
    return {};
  }
}

// ─── Jupiter prices (never cached) ──────────────────────────────
async function getJupiterPrices(mints) {
  const list = unique(mints.map((m) => String(m).trim()));
  if (!list.length) return {};
  try {
    const res = await fetch(`${JUP_SEARCH}?query=${list.join(",")}`, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`Jupiter ${res.status}`);
    const assets = await res.json();
    const out = {};
    for (const a of assets) out[a.id] = maybeNum(a.usdPrice);
    return out;
  } catch (e) {
    log("pnl_price", `Jupiter price fetch failed: ${e.message}`);
    return {};
  }
}

// ─── Deposit-history cache (sig-invalidated + TTL) ──────────────
// Deposits/withdrawals/claimed fees change only on a position tx; feePerTvl24h
// is a slow 24h pool stat. Cache per pool, refetch when any position's latest
// signature changes or the TTL lapses.
const _meteoraCache = new Map(); // pool -> { at, byPosition, sigByPosition }
let _pollCount = 0;

async function getLatestSig(conn, addr) {
  try {
    const sigs = await conn.getSignaturesForAddress(new PublicKey(addr), { limit: 1 });
    return sigs?.[0]?.signature ?? null;
  } catch {
    return null;
  }
}

async function getMeteoraData(conn, walletAddress, flat) {
  const ttlMs = Math.max(0, Number(config.pnl.depositCacheTtlSec ?? 300)) * 1000;
  const positionsByPool = new Map();
  for (const f of flat) {
    if (!positionsByPool.has(f.pool)) positionsByPool.set(f.pool, []);
    positionsByPool.get(f.pool).push(f.position);
  }

  const byPosition = {};
  await Promise.all([...positionsByPool.entries()].map(async ([pool, positionAddrs]) => {
    const cached = _meteoraCache.get(pool);
    const sigByPosition = {};
    await Promise.all(positionAddrs.map(async (addr) => { sigByPosition[addr] = await getLatestSig(conn, addr); }));

    const ageOk = cached && Date.now() - cached.at < ttlMs;
    const sigsMatch = cached && positionAddrs.every((a) => cached.sigByPosition?.[a] === sigByPosition[a]);

    let data;
    if (ageOk && sigsMatch) {
      data = cached.byPosition;
    } else {
      data = await fetchDlmmPnlForPool(pool, walletAddress);
      _meteoraCache.set(pool, { at: Date.now(), byPosition: data, sigByPosition });
    }
    for (const addr of positionAddrs) byPosition[addr] = data[addr] || null;
  }));

  return byPosition;
}

function mapEntries(map) {
  return map instanceof Map ? [...map.entries()] : Object.entries(map || {});
}

// ─── Build the shaped position object (matches getMyPositions output) ──
function buildPosition(f, prices, solUsd, meteora, solMode) {
  const tracked = getTrackedPosition(f.position);
  const priceX = f.baseMint ? (prices[f.baseMint] ?? 0) : 0;

  const xHuman = safeNum(f.xRaw) / 10 ** f.decX;
  const yHuman = safeNum(f.yRaw) / 10 ** f.decY;
  const balancesUsd = xHuman * priceX + yHuman * (solUsd ?? 0);
  const balancesSol = solUsd ? balancesUsd / solUsd : yHuman;

  const feeXHuman = safeNum(f.feeXRaw) / 10 ** f.decX;
  const feeYHuman = safeNum(f.feeYRaw) / 10 ** f.decY;
  const claimableUsd = feeXHuman * priceX + feeYHuman * (solUsd ?? 0);
  const claimableSol = solUsd ? claimableUsd / solUsd : feeYHuman;

  const meteoraDepositsUsd = safeNum(meteora?.allTimeDeposits?.total?.usd);
  const meteoraDepositsSol = safeNum(meteora?.allTimeDeposits?.total?.sol);
  const resolvedBasis = resolveTrackedCostBasisSol({ tracked, meteoraDepositsSol });
  const depositsSol = resolvedBasis.deposits_sol;
  const localBasisReady = resolvedBasis.local_basis_ready;
  const legacyStateBasisSol = resolvedBasis.legacy_state_basis_sol;
  const ledgerTracked = tracked != null && Object.hasOwn(tracked, "basis_status");
  const depositsUsd = depositsSol > 0 && solUsd > 0
    ? depositsSol * solUsd
    : !tracked && meteoraDepositsUsd > 0
      ? meteoraDepositsUsd
      : 0;
  const withdrawUsd = safeNum(meteora?.allTimeWithdrawals?.total?.usd);
  const withdrawSol = safeNum(meteora?.allTimeWithdrawals?.total?.sol);
  const claimedUsd = safeNum(meteora?.allTimeFees?.total?.usd);
  const claimedSol = safeNum(meteora?.allTimeFees?.total?.sol);

  const pnlUsd = balancesUsd + withdrawUsd + claimableUsd + claimedUsd - depositsUsd;
  const pnlSol = balancesSol + withdrawSol + claimableSol + claimedSol - depositsSol;
  const pctUsd = depositsUsd > 0 ? (pnlUsd / depositsUsd) * 100 : 0;
  const pctSol = depositsSol > 0 ? (pnlSol / depositsSol) * 100 : 0;

  const ourPct = solMode ? pctSol : pctUsd;

  const deployOutflowSol = tracked?.wallet_sol_before_deploy != null && tracked?.wallet_sol_after_deploy != null
    ? Math.max(0, Number(tracked.wallet_sol_before_deploy) - Number(tracked.wallet_sol_after_deploy))
    : depositsSol;
  const deployTxCount = Array.isArray(tracked?.transaction_signatures) ? tracked.transaction_signatures.length : 1;
  const deployTxFeesSol = Number.isFinite(Number(tracked?.deploy_tx_fees_lamports))
    ? Number(tracked.deploy_tx_fees_lamports) / 1e9
    : Math.max(1, deployTxCount) * 0.000005;
  const observedSetupOutflowSol = Math.max(0, deployOutflowSol - depositsSol);
  const projectedRentReclaimSol = Number.isFinite(Number(tracked?.rent_created_lamports))
    ? Number(tracked.rent_created_lamports) / 1e9
    : Math.max(0, observedSetupOutflowSol - deployTxFeesSol);
  const projectedExitCostSol = Math.max(
    0.00001,
    Number(tracked?.projected_exit_cost_lamports ?? 0) / 1e9,
  );
  const projectedCloseInflowSol = balancesSol + withdrawSol + claimableSol + claimedSol + projectedRentReclaimSol;
  const projectedNetPnlSol = deployOutflowSol > 0
    ? projectedCloseInflowSol - deployOutflowSol - projectedExitCostSol
    : pnlSol - projectedExitCostSol;
  const projectedNetPnlPct = depositsSol > 0 ? projectedNetPnlSol / depositsSol * 100 : null;

  // pnl_pct_diff is the gap vs Meteora's precomputed pct — kept ONLY as a logged
  // diagnostic. It is NOT used to gate exits: Meteora's pct comes from the
  // deposit cache (stale up to depositCacheTtlSec) while ourPct is fresh every
  // poll, so on a fast move the gap inflates and would falsely suppress
  // STOP_LOSS / TRAILING_TP exactly when they matter.
  const reportedPct = solMode ? maybeNum(meteora?.pnlSolPctChange) : maybeNum(meteora?.pnlPctChange);
  const pnlPctDiff = reportedPct != null ? Math.abs(ourPct - reportedPct) : null;

  // On-chain amounts are authoritative; a tick is "suspicious" (don't act on it)
  // only when we couldn't price it. Guards against:
  //  - Jupiter outage → solUsd/priceX missing → balances collapse → false STOP_LOSS
  //  - missing Meteora deposits → 0 cost basis → garbage pnl / inflated value
  const holdsTokenX = xHuman > 0 || feeXHuman > 0;
  const priceMissing = !(solUsd > 0) || (holdsTokenX && !!f.baseMint && !(priceX > 0));
  const depositsMissing = (solMode ? depositsSol : depositsUsd) <= 0 || (ledgerTracked && !localBasisReady);
  const ageFromState = tracked?.deployed_at
    ? Math.floor((Date.now() - new Date(tracked.deployed_at).getTime()) / 60000)
    : null;
  const ageMinutes = meteora?.createdAt ? Math.floor((Date.now() - meteora.createdAt * 1000) / 60000) : ageFromState;
  const outlierReason = pnlOutlierReason({
    pnlPct: ourPct,
    reportedPct,
    pnlPctDiff,
    ageMinutes,
  });
  // Once a tracked position has an exact local ledger basis, a large positive
  // move or lagging Meteora percentage is not by itself invalid: balances,
  // claimable fees, prices and basis are all independently available. Keep the
  // outlier veto for untracked/legacy positions and for every missing-input
  // case, where it still prevents false exits from provider anomalies.
  const actionableOutlierReason = localBasisReady ? null : outlierReason;
  const pnlPctSuspicious = priceMissing || depositsMissing || !!actionableOutlierReason;
  if (pnlPctSuspicious) {
    log("pnl_warn", `${f.position.slice(0, 8)} suspicious tick — priceMissing=${priceMissing} depositsMissing=${depositsMissing} outlier=${actionableOutlierReason || false} (solUsd=${solUsd}, priceX=${priceX})`);
  } else if (outlierReason) {
    log("pnl_warn", `${f.position.slice(0, 8)} ledger-basis tick accepted with diagnostic outlier=${outlierReason} (solUsd=${solUsd}, priceX=${priceX})`);
  }

  const inRange = f.active != null && f.lower != null && f.upper != null
    ? f.active >= f.lower && f.active <= f.upper
    : (meteora ? !meteora.isOutOfRange : true);

  if (inRange) markInRange(f.position);
  else markOutOfRange(f.position);

  return {
    position:           f.position,
    pool:               f.pool,
    pair:               tracked?.pool_name || (meteora ? `${meteora.tokenX ?? "?"}/${meteora.tokenY ?? "SOL"}` : "?/SOL"),
    base_mint:          f.baseMint,
    lower_bin:          f.lower ?? tracked?.bin_range?.min ?? null,
    upper_bin:          f.upper ?? tracked?.bin_range?.max ?? null,
    active_bin:         f.active ?? tracked?.bin_range?.active ?? null,
    in_range:           inRange,
    unclaimed_fees_usd: round(solMode ? claimableSol : claimableUsd),
    unclaimed_fees_sol: round(claimableSol, 9),
    unclaimed_fees_true_usd: round(claimableUsd),
    total_value_usd:    round(solMode ? balancesSol : balancesUsd),
    total_value_true_usd: round(balancesUsd),
    collected_fees_usd: round(solMode ? claimedSol : claimedUsd),
    collected_fees_true_usd: round(claimedUsd),
    pnl_usd:            round(solMode ? pnlSol : pnlUsd),
    pnl_true_usd:       round(pnlUsd),
    pnl_pct:            round(ourPct, 2),
    projected_net_pnl_sol: round(projectedNetPnlSol, 9),
    projected_net_pnl_pct: projectedNetPnlPct != null ? round(projectedNetPnlPct, 2) : null,
    projected_exit_cost_sol: round(projectedExitCostSol, 9),
    projected_rent_reclaim_sol: round(projectedRentReclaimSol, 9),
    pnl_basis_valid: !depositsMissing,
    pnl_pct_derived:    round(ourPct, 2),
    pnl_pct_diff:       pnlPctDiff != null ? round(pnlPctDiff, 2) : null,
    pnl_pct_suspicious: !!pnlPctSuspicious,
    pnl_cost_basis_source: localBasisReady
      ? "local_ledger"
      : legacyStateBasisSol > 0
        ? "legacy_state"
        : (!tracked && (meteoraDepositsUsd > 0 || meteoraDepositsSol > 0) ? "meteora_untracked" : null),
    fee_per_tvl_24h:    meteora ? Math.round(safeNum(meteora.feePerTvl24h) * 100) / 100 : null,
    age_minutes:        ageMinutes,
    minutes_out_of_range: minutesOutOfRange(f.position),
    instruction:        tracked?.instruction ?? null,
  };
}

// ─── Main entry: compute positions from public infra ────────────
// Returns the same shape as getMyPositions, or throws so the caller can
// fall back to the Meteora-API path.
export async function computePositions(walletAddress) {
  const solMode = !!config.management?.solMode;
  const SOL_MINT = config.tokens.SOL;
  const conn = getPnlConnection();
  const DLMM = await loadDlmmSdk();

  const map = await DLMM.getAllLbPairPositionsByUser(conn, new PublicKey(walletAddress));
  _pollCount++;
  if (_pollCount % 20 === 1) {
    const n = [...mapEntries(map)].reduce((s, [, i]) => s + (i?.lbPairPositionsData?.length ?? 0), 0);
    log("pnl_tick", `poller alive — ${n} position(s) tracked (tick #${_pollCount})`);
  }

  const flat = [];
  for (const [lbPairKey, info] of mapEntries(map)) {
    const decX = info?.tokenX?.mint?.decimals ?? 9;
    const decY = info?.tokenY?.mint?.decimals ?? 9;
    const baseMint = info?.tokenX?.mint?.address?.toString?.() ?? null;
    const active = info?.lbPair?.activeId ?? null;
    for (const p of info?.lbPairPositionsData || []) {
      const d = p.positionData || {};
      flat.push({
        position: p.publicKey.toString(),
        pool: lbPairKey,
        baseMint,
        decX,
        decY,
        active,
        lower: d.lowerBinId ?? null,
        upper: d.upperBinId ?? null,
        xRaw: d.totalXAmount,
        yRaw: d.totalYAmount,
        feeXRaw: d.feeX?.toString?.() ?? d.feeX ?? 0,
        feeYRaw: d.feeY?.toString?.() ?? d.feeY ?? 0,
      });
    }
  }

  if (flat.length === 0) {
    return { wallet: walletAddress, total_positions: 0, positions: [], source: "rpc" };
  }

  const [prices, meteoraByPosition] = await Promise.all([
    getJupiterPrices([SOL_MINT, ...flat.map((f) => f.baseMint)]),
    getMeteoraData(conn, walletAddress, flat),
  ]);
  const solUsd = prices[SOL_MINT] ?? null;

  const positions = flat.map((f) => buildPosition(f, prices, solUsd, meteoraByPosition[f.position], solMode));

  return { wallet: walletAddress, total_positions: positions.length, positions, source: "rpc" };
}
