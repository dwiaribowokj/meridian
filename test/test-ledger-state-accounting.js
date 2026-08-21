import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-ledger-state-"));
process.env.MERIDIAN_STATE_FILE = path.join(tempDir, "state.json");
process.env.MERIDIAN_USER_CONFIG_FILE = path.join(tempDir, "user-config.json");
process.env.MERIDIAN_LESSONS_FILE = path.join(tempDir, "lessons.json");
fs.writeFileSync(process.env.MERIDIAN_USER_CONFIG_FILE, JSON.stringify({ dryRun: true, rolloutMode: "dry_run" }));

try {
  const {
    confirmPeak,
    getTrackedPosition,
    registerExitSignal,
    trackPosition,
    updatePnlAndCheckExits,
    updatePositionAccounting,
  } = await import("../state.js");
  const { config } = await import("../config.js");
  const { getMyPositions } = await import("../tools/dlmm.js");
  const { resolveTrackedCostBasisSol } = await import("../tools/pnl.js");
  const { currentTrackedExposureSol } = await import("../tools/executor.js");

  trackPosition({
    position: "PendingPosition",
    pool: "Pool",
    base_mint: "PendingMint111111111111111111111111111111",
    amount_sol: 0.5,
    local_cost_basis_lamports: 500_000_000,
    basis_status: "PENDING",
  });
  let pending = getTrackedPosition("PendingPosition");
  assert.equal(
    pending.base_mint,
    "PendingMint111111111111111111111111111111",
    "trackPosition preserves the base mint needed for lifecycle-scoped cleanup",
  );
  assert.equal(pending.local_cost_basis_lamports, null, "a requested amount is never persisted as an actual basis");
  assert.equal(pending.requested_deploy_lamports, 500_000_000);
  assert.equal(pending.risk_reserved_lamports, 500_000_000);
  assert.deepEqual(resolveTrackedCostBasisSol({ tracked: pending }), {
    deposits_sol: 0,
    local_basis_ready: false,
    legacy_state_basis_sol: 0,
    basis_valid: false,
  }, "PENDING has no PnL basis even when it has a conservative reservation");

  const legacyBasis = resolveTrackedCostBasisSol({
    tracked: {
      amount_sol: 0.5,
      local_cost_basis_lamports: 900_000_000,
      requested_deploy_lamports: 700_000_000,
      risk_reserved_lamports: 800_000_000,
    },
    meteoraDepositsSol: 0.7,
  });
  assert.deepEqual(legacyBasis, {
    deposits_sol: 0.5,
    local_basis_ready: false,
    legacy_state_basis_sol: 0.5,
    basis_valid: true,
  }, "pre-ledger records without basis_status retain their amount_sol compatibility basis");

  for (const basisStatus of [null, undefined, "", "PENDING", "INVALID"]) {
    const statusBearing = {
      amount_sol: 0.5,
      local_cost_basis_lamports: 900_000_000,
      requested_deploy_lamports: 700_000_000,
      risk_reserved_lamports: 800_000_000,
      basis_status: basisStatus,
    };
    assert.equal(Object.hasOwn(statusBearing, "basis_status"), true);
    assert.deepEqual(resolveTrackedCostBasisSol({
      tracked: statusBearing,
      meteoraDepositsSol: 0.7,
    }), {
      deposits_sol: 0,
      local_basis_ready: false,
      legacy_state_basis_sol: 0,
      basis_valid: false,
    }, `own basis_status=${String(basisStatus)} cannot use request, stale local, reservation, or Meteora basis`);
  }

  assert.deepEqual(resolveTrackedCostBasisSol({
    tracked: {
      amount_sol: 0.5,
      local_cost_basis_lamports: 400_000_000,
      risk_reserved_lamports: 800_000_000,
      basis_status: "READY",
    },
    meteoraDepositsSol: 0.7,
  }), {
    deposits_sol: 0.4,
    local_basis_ready: true,
    legacy_state_basis_sol: 0,
    basis_valid: true,
  }, "READY retains its exact local ledger basis");

  // Reproduce the RPC failure -> Meteora portfolio fallback path entirely
  // locally. A plausible 2% fallback PnL must be invalid/suspicious for the
  // tracked PENDING receipt and cannot move a peak or confirm an exit.
  const priorFetch = globalThis.fetch;
  const priorPnlSource = config.pnl.source;
  const priorPnlRpcUrl = config.pnl.rpcUrl;
  try {
    config.pnl.source = "rpc";
    config.pnl.rpcUrl = "https://rpc-unavailable.invalid";
    globalThis.fetch = async (url) => {
      const target = String(url);
      if (target.includes("/portfolio/open?")) {
        return {
          ok: true,
          json: async () => ({
            pools: [{
              poolAddress: "FallbackPool",
              listPositions: ["PendingPosition"],
              tokenX: "TOKEN",
              tokenY: "SOL",
              tokenXMint: "FallbackToken",
              outOfRange: false,
            }],
          }),
        };
      }
      if (target.includes("/positions/FallbackPool/pnl?")) {
        return {
          ok: true,
          json: async () => ({
            positions: [{
              positionAddress: "PendingPosition",
              pnlPctChange: 2,
              pnlSolPctChange: 2,
              pnlUsd: 2,
              pnlSol: 0.01,
              lowerBinId: -1,
              upperBinId: 1,
              poolActiveBinId: 0,
              isOutOfRange: false,
              feePerTvl24h: 10,
              createdAt: 1,
              unrealizedPnl: {
                balances: 1,
                balancesSol: 1,
                unclaimedFeeTokenX: { usd: 0, amountSol: 0 },
                unclaimedFeeTokenY: { usd: 0, amountSol: 0 },
              },
              allTimeFees: { total: { usd: 0, sol: 0 } },
            }],
          }),
        };
      }
      throw new Error("simulated RPC unavailable");
    };

    const fallback = await getMyPositions({
      force: true,
      silent: true,
      wallet_address: "11111111111111111111111111111111",
    });
    assert.equal(fallback.source, "meteora", "a failed RPC read uses the mocked Meteora portfolio fallback");
    const fallbackPosition = fallback.positions.find((position) => position.position === "PendingPosition");
    assert.equal(fallbackPosition.pnl_basis_valid, false, "PENDING fallback PnL cannot claim a valid basis");
    assert.equal(fallbackPosition.pnl_pct_suspicious, true, "PENDING fallback PnL is always suspicious");
    assert.equal(confirmPeak("PendingPosition", fallbackPosition.pnl_pct, 1), false);
    assert.equal(updatePnlAndCheckExits("PendingPosition", fallbackPosition, {
      netExitPolicyEnabled: true,
      takeProfitPct: 1,
    }), null);
    assert.deepEqual(registerExitSignal("PendingPosition", "TAKE_PROFIT", 1), {
      fire: false,
      action: null,
      count: 0,
    });
    const afterFallback = getTrackedPosition("PendingPosition");
    assert.equal(afterFallback.peak_pnl_pct, 0, "PENDING fallback PnL cannot move the confirmed peak");
    assert.equal(afterFallback.pending_exit_action, null, "PENDING fallback PnL cannot arm an exit");

    // A missing PnL basis must not disable the independent bin/range safety
    // path. Exact active/lower/upper bins can still establish a durable OOR
    // timer and fire after its configured time/depth threshold.
    const pendingOorState = JSON.parse(fs.readFileSync(process.env.MERIDIAN_STATE_FILE, "utf8"));
    pendingOorState.positions.PendingPosition.out_of_range_since = new Date(Date.now() - 21 * 60_000).toISOString();
    fs.writeFileSync(process.env.MERIDIAN_STATE_FILE, JSON.stringify(pendingOorState));
    const pendingOorExit = updatePnlAndCheckExits("PendingPosition", {
      ...fallbackPosition,
      in_range: false,
      active_bin: -12,
      lower_bin: -1,
      upper_bin: 1,
      pnl_pct: -99,
      pnl_pct_suspicious: true,
      pnl_basis_valid: false,
    }, {
      netExitPolicyEnabled: true,
      outOfRangeBinsToClose: 10,
      outOfRangeWaitMinutes: 20,
      stopLossPct: -1.5,
    });
    assert.equal(pendingOorExit.action, "OUT_OF_RANGE", "receipt uncertainty pauses PnL exits but not exact-bin OOR safety");
    assert.match(pendingOorExit.reason, /Below range by 11 bins for 21m/);
    assert.deepEqual(registerExitSignal("PendingPosition", "OUT_OF_RANGE", 2), {
      fire: false,
      action: "OUT_OF_RANGE",
      count: 1,
    });
    assert.deepEqual(registerExitSignal("PendingPosition", "OUT_OF_RANGE", 2), {
      fire: true,
      action: "OUT_OF_RANGE",
      count: 2,
    }, "the fast poller may confirm an exact-bin OOR exit while PnL rules remain paused");
  } finally {
    globalThis.fetch = priorFetch;
    config.pnl.source = priorPnlSource;
    config.pnl.rpcUrl = priorPnlRpcUrl;
  }

  // Pre-ledger records intentionally retain their historic policy path.
  const persistedState = JSON.parse(fs.readFileSync(process.env.MERIDIAN_STATE_FILE, "utf8"));
  persistedState.positions.LegacyPosition = {
    position: "LegacyPosition",
    pool: "LegacyPool",
    closed: false,
    peak_pnl_pct: 0,
    pending_peak_pnl_pct: null,
    pending_peak_confirm_count: 0,
    pending_peak_started_at: null,
    pending_exit_action: null,
    pending_exit_count: 0,
    pending_exit_started_at: null,
  };
  persistedState.positions.BufferedTpPosition = {
    position: "BufferedTpPosition",
    pool: "BufferedTpPool",
    closed: false,
    basis_status: "READY",
    local_cost_basis_lamports: 200_000_000,
    peak_pnl_pct: 0,
    pending_peak_pnl_pct: null,
    pending_peak_confirm_count: 0,
    pending_peak_started_at: null,
    pending_exit_action: null,
    pending_exit_count: 0,
    pending_exit_started_at: null,
  };
  fs.writeFileSync(process.env.MERIDIAN_STATE_FILE, JSON.stringify(persistedState));

  const bufferedTpConfig = {
    netExitPolicyEnabled: true,
    solMode: true,
    takeProfitPct: 0.5,
    takeProfitExecutionBufferPct: 0.75,
    costAwareTakeProfitEnabled: true,
    estimatedRoundTripCostPct: 0.4,
    minNetProfitPct: 0.1,
    minNetProfitSol: 0.00005,
  };
  for (const [label, projectedPct] of [
    ["App-like projection", 0.74],
    ["Niles-like projection", 0.54],
    ["just below effective gate", 1.24],
  ]) {
    assert.equal(updatePnlAndCheckExits("BufferedTpPosition", {
      projected_net_pnl_pct: projectedPct,
      projected_net_pnl_sol: 0.2 * projectedPct / 100,
      pnl_pct_suspicious: false,
      pnl_basis_valid: true,
      in_range: true,
    }, bufferedTpConfig), null, `${label} cannot trigger a false-positive TP`);
  }
  const bufferedTpExit = updatePnlAndCheckExits("BufferedTpPosition", {
    projected_net_pnl_pct: 1.25,
    projected_net_pnl_sol: 0.0025,
    pnl_pct_suspicious: false,
    pnl_basis_valid: true,
    in_range: true,
  }, bufferedTpConfig);
  assert.equal(bufferedTpExit.action, "TAKE_PROFIT");
  assert.match(bufferedTpExit.reason, /effective gate 1\.25% \(execution reserve 0\.75pp\)/);

  assert.equal(confirmPeak("LegacyPosition", 2, 1), true, "old records without basis_status retain compatibility behavior");
  assert.equal(updatePnlAndCheckExits("LegacyPosition", {
    pnl_pct: 2,
    projected_net_pnl_sol: 0.01,
    pnl_pct_suspicious: false,
  }, {
    netExitPolicyEnabled: true,
    takeProfitPct: 1,
  }).action, "TAKE_PROFIT", "legacy policy branch remains intentionally available");

  updatePositionAccounting("PendingPosition", {
    basis_status: "INVALID",
    ledger_status: "RECONCILIATION_REQUIRED",
    local_cost_basis_lamports: 123,
  });
  const invalid = getTrackedPosition("PendingPosition");
  assert.equal(invalid.local_cost_basis_lamports, null, "INVALID clears actual basis instead of retaining stale local data");
  assert.equal(resolveTrackedCostBasisSol({ tracked: invalid }).basis_valid, false);

  updatePositionAccounting("PendingPosition", {
    basis_status: "READY",
    ledger_status: "ACTIVE",
    local_cost_basis_lamports: 400_000_000,
  });
  const ready = getTrackedPosition("PendingPosition");
  assert.equal(ready.local_cost_basis_lamports, 400_000_000);
  assert.equal(resolveTrackedCostBasisSol({ tracked: ready }).deposits_sol, 0.4);

  assert.ok(Math.abs(currentTrackedExposureSol([
    { basis_status: "READY", local_cost_basis_lamports: 400_000_000, risk_reserved_lamports: 500_000_000 },
    { basis_status: "PENDING", local_cost_basis_lamports: 999_000_000, risk_reserved_lamports: 200_000_000 },
    { basis_status: "INVALID", local_cost_basis_lamports: 999_000_000, requested_deploy_lamports: 300_000_000 },
    { basis_status: "PENDING", local_cost_basis_lamports: 999_000_000, amount_sol: 999 },
  ]) - 0.9) < 1e-12, "sizing uses actual READY basis or explicit reservations only");

  console.log("ledger state accounting tests passed");
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
