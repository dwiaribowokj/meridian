import assert from "node:assert/strict";
import fs from "node:fs";
import { classifyRelayCloseOrder } from "../tools/dlmm.js";

const empty = classifyRelayCloseOrder({});
assert.equal(empty.safe, false);
assert.equal(empty.reason, "relay_close_execution_disabled_unattributable");

const closeOnly = classifyRelayCloseOrder({
  order: { transactions: { close: ["close-transaction"], swap: [] } },
});
assert.equal(closeOnly.safe, false);
assert.equal(closeOnly.reason, "relay_close_execution_disabled_unattributable");
assert.deepEqual(closeOnly.closeTransactions, ["close-transaction"]);
assert.deepEqual(closeOnly.swapTransactions, []);

const swapBearing = classifyRelayCloseOrder({
  order: { transactions: { close: ["close-transaction"], swap: ["wallet-swap-transaction"] } },
});
assert.equal(swapBearing.safe, false);
assert.equal(swapBearing.reason, "relay_close_execution_disabled_unattributable");

const maliciousOrder = classifyRelayCloseOrder({
  order: {
    transactions: {
      close: ["attacker-controlled-close"],
      swap: ["attacker-controlled-wallet-swap"],
    },
  },
});
assert.equal(maliciousOrder.safe, false, "relay arrays are never safe to sign for close");
assert.deepEqual(maliciousOrder.closeTransactions, ["attacker-controlled-close"]);
assert.deepEqual(maliciousOrder.swapTransactions, ["attacker-controlled-wallet-swap"]);

// Close is now unconditionally local. Keep deploy's independently validated
// relay path out of this assertion by inspecting only closePosition's source.
const source = fs.readFileSync(new URL("../tools/dlmm.js", import.meta.url), "utf8");
const closeSource = source.slice(
  source.indexOf("export async function closePosition"),
  source.indexOf("// ─── Helpers", source.indexOf("export async function closePosition")),
);
assert.match(closeSource, /Using local Meteora SDK close path; relay close execution is disabled/);
assert.doesNotMatch(closeSource, /agentMeridianJson|signAndSimulateRelayTransactions|shouldUseLpAgentRelay|zap-out/);

console.log("relay close safety tests passed");
// dlmm.js owns cache intervals for production; this isolated synchronous test
// does not need to keep them alive after its assertions complete.
process.exit(0);
