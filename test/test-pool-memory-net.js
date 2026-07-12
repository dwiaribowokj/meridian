import assert from "node:assert/strict";
import { cleanNetPnlPct, recomputeAggregates } from "../pool-memory.js";

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

console.log("pool-memory net tests passed");
