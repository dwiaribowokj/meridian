import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  cleanNetPnlPct,
  getPoolMemoryPolicy,
  isStopLossCloseReason,
  recomputeAggregates,
  recordPoolDeploy,
  recordSettledPoolOutcome,
} from "../pool-memory.js";

assert.equal(cleanNetPnlPct({
  position_sol_deployed: 0.2,
  wallet_sol_roundtrip_delta_after_autoswap: 0.002,
  position_sol_pnl_pct: 1.2,
}), 1);

assert.equal(cleanNetPnlPct({
  position_sol_deployed: 0.2,
  wallet_sol_roundtrip_delta_after_autoswap: null,
  position_sol_pnl_pct: 1.2,
}), null);

assert.equal(cleanNetPnlPct({
  position_sol_deployed: 0.2,
  wallet_sol_roundtrip_delta_after_autoswap: -0.02,
  position_sol_pnl_pct: 1.2,
}), null, "contaminated wallet deltas must be excluded");

const entry = {
  deploys: [
    {
      pnl_pct: 1.2,
      position_sol_pnl_pct: 1.2,
      position_sol_deployed: 0.2,
      wallet_sol_roundtrip_delta_after_autoswap: 0.002,
      close_reason: "take profit",
    },
    {
      pnl_pct: 0.4,
      position_sol_pnl_pct: 0.4,
      position_sol_deployed: 0.2,
      wallet_sol_roundtrip_delta_after_autoswap: -0.02,
      close_reason: "low yield",
    },
  ],
};

recomputeAggregates(entry);
assert.equal(entry.recent_net_sample_count, 1);
assert.equal(entry.recent_net_avg_pct, 1);
assert.equal(entry.recent_net_win_rate, 100);
assert.equal(entry.last_outcome, "low_yield");

const now = Date.parse("2026-07-13T00:00:00Z");
assert.match(getPoolMemoryPolicy({}, now), /advisory only/);
assert.match(getPoolMemoryPolicy({ cooldown_until: "2026-07-13T01:00:00Z" }, now), /hard block/);
assert.equal(isStopLossCloseReason("Net stop loss: projected equity-net -1.3%"), true);
assert.equal(isStopLossCloseReason("Rotation fee thesis failed after 20m"), true);
assert.equal(isStopLossCloseReason("Net take profit"), false);

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-pool-memory-net-"));
const storagePath = path.join(tempDir, "pool-memory.json");
const settlementNow = Date.parse("2026-08-28T00:00:00.000Z");
const policy = {
  badOutcomeCooldownEnabled: true,
  badOutcomeCooldownScope: "both",
  lowYieldCooldownHours: 4,
  stopLossCooldownHours: 12,
  settlementSmallLossFloorPct: -0.75,
  settlementSmallLossCooldownMinutes: 60,
  settlementSmallLossCooldownScope: "pool",
  oorCooldownTriggerCount: 99,
  oorCooldownHours: 12,
  repeatDeployCooldownEnabled: false,
  catastrophicStopPct: -2.5,
  breakerSingleLossPct: -2,
  catastrophicQuarantineHours: 168,
};

function settledOutcome({
  position,
  settlementId,
  poolAddress,
  baseMint,
  netLamports,
  closeReason,
  nowMs = settlementNow,
  policyOverride = {},
}) {
  return recordSettledPoolOutcome({
    position,
    lifecycleId: `lp:${position}`,
    settlementId,
    poolAddress,
    poolName: `${position}-SOL`,
    baseMint,
    strategy: "spot",
    closeReason,
    deployedAt: new Date(nowMs - 20 * 60_000).toISOString(),
    settledAt: new Date(nowMs).toISOString(),
    basisLamports: "200000000",
    walletEquityNetLamports: String(netLamports),
  }, { storagePath, nowMs, policy: { ...policy, ...policyOverride } });
}

const mild = settledOutcome({
  position: "MildLossPosition",
  settlementId: "mild-settlement",
  poolAddress: "MildLossPool",
  baseMint: "MildLossMint",
  netLamports: -1_000_000,
  closeReason: "manual risk exit",
});
assert.equal(mild.recorded, true);
assert.equal(mild.deploy.pnl_pct, -0.5);
assert.equal(mild.deploy.quarantine, undefined, "an ordinary mild loss is not a seven-day token judgment");

const ordinaryStop = settledOutcome({
  position: "OrdinaryStopPosition",
  settlementId: "ordinary-stop-settlement",
  poolAddress: "OrdinaryStopPool",
  baseMint: "OrdinaryStopMint",
  netLamports: -3_000_000,
  closeReason: "Net stop loss",
});
assert.equal(ordinaryStop.deploy.pnl_pct, -1.5);
assert.equal(ordinaryStop.deploy.quarantine, undefined, "a normal stop loss receives only its normal cooldown");
let memory = JSON.parse(fs.readFileSync(storagePath, "utf8"));
assert.equal(memory.OrdinaryStopPool.cooldown_until, new Date(settlementNow + 12 * 60 * 60_000).toISOString());
assert.equal(memory.OrdinaryStopPool.base_mint_cooldown_until, memory.OrdinaryStopPool.cooldown_until);

const smallSettledStop = settledOutcome({
  position: "SmallSettledStopPosition",
  settlementId: "small-settled-stop",
  poolAddress: "SmallSettledStopPool",
  baseMint: "SmallSettledStopMint",
  netLamports: -790_335,
  closeReason: "Net stop loss",
});
assert.equal(smallSettledStop.deploy.pnl_pct, -0.3951675);
assert.equal(smallSettledStop.deploy.cooldown.scope, "pool");
assert.equal(smallSettledStop.deploy.cooldown.minutes, 60);
memory = JSON.parse(fs.readFileSync(storagePath, "utf8"));
assert.equal(
  memory.SmallSettledStopPool.cooldown_until,
  new Date(settlementNow + 60 * 60_000).toISOString(),
);
assert.equal(memory.SmallSettledStopPool.base_mint_cooldown_until, undefined);

const legacyCooldownUntil = new Date(settlementNow + 12 * 60 * 60_000).toISOString();
memory.SmallSettledStopPool.cooldown_until = legacyCooldownUntil;
memory.SmallSettledStopPool.cooldown_reason = "bad outcome: stop loss";
memory.SmallSettledStopPool.base_mint_cooldown_until = legacyCooldownUntil;
memory.SmallSettledStopPool.base_mint_cooldown_reason = "bad outcome: stop loss";
delete memory.SmallSettledStopPool.deploys[0].cooldown;
memory.SmallSettledStopSiblingPool = {
  name: "SmallSettledStopSibling-SOL",
  base_mint: "SmallSettledStopMint",
  deploys: [],
  total_deploys: 0,
  base_mint_cooldown_until: legacyCooldownUntil,
  base_mint_cooldown_reason: "bad outcome: stop loss",
};
fs.writeFileSync(storagePath, JSON.stringify(memory, null, 2));
const migratedSmallStop = settledOutcome({
  position: "SmallSettledStopPosition",
  settlementId: "small-settled-stop",
  poolAddress: "SmallSettledStopPool",
  baseMint: "SmallSettledStopMint",
  netLamports: -790_335,
  closeReason: "Net stop loss",
});
assert.equal(migratedSmallStop.recorded, false);
assert.equal(migratedSmallStop.duplicate, true);
assert.equal(migratedSmallStop.cooldown_migrated, true);
memory = JSON.parse(fs.readFileSync(storagePath, "utf8"));
assert.equal(
  memory.SmallSettledStopPool.cooldown_until,
  new Date(settlementNow + 60 * 60_000).toISOString(),
  "startup replay shortens a legacy stop cooldown to the authoritative small-loss policy",
);
assert.match(memory.SmallSettledStopPool.cooldown_reason, /^small authoritative stop /);
assert.equal(memory.SmallSettledStopPool.base_mint_cooldown_until, undefined);
assert.equal(memory.SmallSettledStopSiblingPool.base_mint_cooldown_until, undefined);
assert.equal(memory.SmallSettledStopPool.deploys[0].cooldown.scope, "pool");

settledOutcome({
  position: "TokenScopedMigrationPosition",
  settlementId: "token-scoped-migration",
  poolAddress: "TokenScopedMigrationPool",
  baseMint: "TokenScopedMigrationMint",
  netLamports: -790_335,
  closeReason: "Net stop loss",
  policyOverride: { settlementSmallLossFloorPct: -0.1 },
});
const tokenScopedMigration = settledOutcome({
  position: "TokenScopedMigrationPosition",
  settlementId: "token-scoped-migration",
  poolAddress: "TokenScopedMigrationPool",
  baseMint: "TokenScopedMigrationMint",
  netLamports: -790_335,
  closeReason: "Net stop loss",
  policyOverride: { settlementSmallLossCooldownScope: "token" },
});
assert.equal(tokenScopedMigration.cooldown_migrated, true);
memory = JSON.parse(fs.readFileSync(storagePath, "utf8"));
assert.equal(memory.TokenScopedMigrationPool.cooldown_until, undefined);
assert.equal(
  memory.TokenScopedMigrationPool.base_mint_cooldown_until,
  new Date(settlementNow + 60 * 60_000).toISOString(),
);
assert.match(memory.TokenScopedMigrationPool.base_mint_cooldown_reason, /^small authoritative stop /);

settledOutcome({
  position: "PositiveSettledStopPosition",
  settlementId: "positive-settled-stop",
  poolAddress: "PositiveSettledStopPool",
  baseMint: "PositiveSettledStopMint",
  netLamports: 500_000,
  closeReason: "Net stop loss",
});
memory = JSON.parse(fs.readFileSync(storagePath, "utf8"));
assert.equal(memory.PositiveSettledStopPool.cooldown_until, undefined);
assert.equal(memory.PositiveSettledStopPool.base_mint_cooldown_until, undefined);

const catastrophic = settledOutcome({
  position: "CatastrophicPosition",
  settlementId: "catastrophic-settlement",
  poolAddress: "CatastrophicPool",
  baseMint: "CatastrophicMint",
  netLamports: -14_000_000,
  closeReason: "Net stop loss",
});
assert.equal(catastrophic.deploy.pnl_pct, -7);
assert.equal(catastrophic.deploy.quarantine.hours, 168);
memory = JSON.parse(fs.readFileSync(storagePath, "utf8"));
const catastrophicUntil = new Date(settlementNow + 168 * 60 * 60_000).toISOString();
assert.equal(memory.CatastrophicPool.cooldown_until, catastrophicUntil);
assert.equal(memory.CatastrophicPool.base_mint_cooldown_until, catastrophicUntil);
assert.match(memory.CatastrophicPool.cooldown_reason, /temporary execution-risk quarantine/);

const duplicate = settledOutcome({
  position: "CatastrophicPosition",
  settlementId: "catastrophic-settlement",
  poolAddress: "CatastrophicPool",
  baseMint: "CatastrophicMint",
  netLamports: -14_000_000,
  closeReason: "Net stop loss",
  nowMs: settlementNow + 60_000,
});
assert.equal(duplicate.recorded, false);
assert.equal(duplicate.duplicate, true);
memory = JSON.parse(fs.readFileSync(storagePath, "utf8"));
assert.equal(memory.CatastrophicPool.deploys.length, 1, "settlement retry is idempotent");

settledOutcome({
  position: "LaterOrdinaryStopPosition",
  settlementId: "later-ordinary-stop-settlement",
  poolAddress: "CatastrophicPool",
  baseMint: "CatastrophicMint",
  netLamports: -3_000_000,
  closeReason: "Net stop loss",
  nowMs: settlementNow + 60 * 60_000,
});
memory = JSON.parse(fs.readFileSync(storagePath, "utf8"));
assert.equal(memory.CatastrophicPool.cooldown_until, catastrophicUntil, "a later short cooldown cannot shorten quarantine");
assert.equal(memory.CatastrophicPool.base_mint_cooldown_until, catastrophicUntil);

recordPoolDeploy("UpgradePool", {
  position: "UpgradePosition",
  pool_name: "Upgrade-SOL",
  base_mint: "UpgradeMint",
  deployed_at: new Date(settlementNow - 10 * 60_000).toISOString(),
  closed_at: new Date(settlementNow - 30_000).toISOString(),
  pnl_pct: -0.4,
  pnl_sol: -0.0008,
  fees_earned_sol: 0.0003,
  close_reason: "Net stop loss",
  strategy: "spot",
}, { storagePath, nowMs: settlementNow - 30_000, policy });
const upgraded = settledOutcome({
  position: "UpgradePosition",
  settlementId: "upgrade-settlement",
  poolAddress: "UpgradePool",
  baseMint: "UpgradeMint",
  netLamports: -3_000_000,
  closeReason: "Net stop loss",
});
assert.equal(upgraded.recorded, true);
memory = JSON.parse(fs.readFileSync(storagePath, "utf8"));
assert.equal(memory.UpgradePool.deploys.length, 1, "authoritative settlement upgrades rather than duplicates a provisional close");
assert.equal(memory.UpgradePool.total_deploys, 1);
assert.equal(memory.UpgradePool.deploys[0].authoritative_settlement, true);
assert.equal(memory.UpgradePool.deploys[0].pnl_pct, -1.5);
assert.equal(memory.UpgradePool.deploys[0].fees_earned_sol, 0.0003, "non-authoritative diagnostic fields survive the upgrade");

const historicalSettlementAt = Date.parse("2026-08-01T00:00:00.000Z");
recordSettledPoolOutcome({
  position: "HistoricalCatastrophicPosition",
  lifecycleId: "lp:HistoricalCatastrophicPosition",
  settlementId: "historical-catastrophic-settlement",
  poolAddress: "HistoricalCatastrophicPool",
  poolName: "HistoricalCatastrophic-SOL",
  baseMint: "HistoricalCatastrophicMint",
  strategy: "spot",
  closeReason: "Catastrophic stop",
  deployedAt: new Date(historicalSettlementAt - 10 * 60_000).toISOString(),
  settledAt: new Date(historicalSettlementAt).toISOString(),
  basisLamports: "200000000",
  walletEquityNetLamports: "-14000000",
}, { storagePath, policy });
memory = JSON.parse(fs.readFileSync(storagePath, "utf8"));
assert.equal(
  memory.HistoricalCatastrophicPool.cooldown_until,
  new Date(historicalSettlementAt + 168 * 60 * 60_000).toISOString(),
  "startup replay anchors quarantine to settlement time rather than extending it from replay time",
);

fs.rmSync(tempDir, { recursive: true, force: true });

console.log("pool-memory net tests passed");
