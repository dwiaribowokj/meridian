import assert from "node:assert/strict";
import { buildLayerPlan } from "../tools/dlmm.js";

const strategyMap = {
  spot: 0,
  curve: 1,
  bid_ask: 2,
};

function plan(strategyConfig, extra = {}) {
  return buildLayerPlan({
    activeStrategy: "bid_ask",
    finalAmountX: 0,
    finalAmountY: 0.3,
    strategyMap,
    strategyConfig,
    ...extra,
  });
}

{
  const result = plan({ multiLayerEnabled: false });
  assert.equal(result.multiLayer, false);
  assert.equal(result.effectiveStrategy, "bid_ask");
  assert.deepEqual(result.layers.map((layer) => layer.strategy), ["bid_ask"]);
}

{
  const result = plan({
    multiLayerEnabled: true,
    multiLayerMode: "same_position",
    multiLayerLayers: [
      { strategy: "bid_ask", pct: 70 },
      { strategy: "spot", pct: 30 },
    ],
    multiLayerMinLayerSol: 0.05,
  });
  assert.equal(result.multiLayer, true);
  assert.equal(result.effectiveStrategy, "multi_layer");
  assert.deepEqual(result.layers.map((layer) => layer.strategy), ["bid_ask", "spot"]);
  assert.deepEqual(result.layers.map((layer) => layer.amount_y), [0.21, 0.09]);
}

{
  const result = plan({
    multiLayerEnabled: true,
    multiLayerMode: "same_position",
    multiLayerLayers: [
      { strategy: "bid_ask", pct: 50 },
      { strategy: "spot", pct: 25 },
      { strategy: "bid_ask", pct: 25 },
    ],
    multiLayerMinLayerSol: 0.05,
  });
  assert.equal(result.multiLayer, true);
  assert.deepEqual(result.layers.map((layer) => layer.amount_y), [0.15, 0.075, 0.075]);
}

{
  const result = plan({
    multiLayerEnabled: true,
    multiLayerMode: "same_position",
    multiLayerLayers: [
      { strategy: "bid_ask", pct: 70 },
      { strategy: "spot", pct: 20 },
    ],
  });
  assert.equal(result.multiLayer, false);
  assert.match(result.fallbackReason, /total 100/);
}

{
  const result = plan({
    multiLayerEnabled: true,
    multiLayerMode: "same_position",
    multiLayerLayers: [
      { strategy: "bid_ask", pct: 90 },
      { strategy: "spot", pct: 10 },
    ],
    multiLayerMinLayerSol: 0.05,
  });
  assert.equal(result.multiLayer, false);
  assert.match(result.fallbackReason, /below minimum/);
}

{
  const result = plan({
    multiLayerEnabled: true,
    multiLayerMode: "same_position",
    multiLayerLayers: [
      { strategy: "bid_ask", pct: 70 },
      { strategy: "spot", pct: 30 },
    ],
  }, { allowMultiLayer: false });
  assert.equal(result.multiLayer, false);
  assert.equal(result.fallbackReason, null);
}

console.log("multi-layer planner tests passed");
process.exit(0);
