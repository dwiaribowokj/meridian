import assert from "node:assert/strict";
import { getEffectiveTakeProfitPct } from "../index.js";

assert.equal(getEffectiveTakeProfitPct({
  takeProfitPct: 1.0,
  costAwareTakeProfitEnabled: true,
  estimatedRoundTripCostPct: 1.0,
  minNetProfitPct: 0.25,
}), 1.25);

assert.equal(getEffectiveTakeProfitPct({
  takeProfitPct: 1.5,
  costAwareTakeProfitEnabled: true,
  estimatedRoundTripCostPct: 1.0,
  minNetProfitPct: 0.25,
}), 1.5);

assert.equal(getEffectiveTakeProfitPct({
  takeProfitPct: 0.8,
  costAwareTakeProfitEnabled: false,
}), 0.8);

assert.equal(getEffectiveTakeProfitPct({
  takeProfitPct: 0.5,
  costAwareTakeProfitEnabled: true,
  estimatedRoundTripCostPct: 0.4,
  minNetProfitPct: 0.1,
  takeProfitExecutionBufferPct: 0.75,
}), 1.25, "rotation TP includes the additive execution uncertainty reserve");

console.log("cost-aware take-profit tests passed");
process.exit(0);
