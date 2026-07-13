import assert from "node:assert/strict";

process.env.LLM_API_KEY = "test-only";
const { isAllowedNoToolFinal, shouldForceInitialToolChoice } = await import("../agent.js");

const screeningGoal = "Review live candidates, deploy the best pool, or report NO DEPLOY.";

assert.equal(shouldForceInitialToolChoice(screeningGoal, true, false, 0), true);
assert.equal(shouldForceInitialToolChoice(screeningGoal, true, true, 0), false);
assert.equal(shouldForceInitialToolChoice(screeningGoal, true, true, 1), false);

assert.equal(isAllowedNoToolFinal("⛔ NO DEPLOY\nNo valid entry.", true), true);
assert.equal(isAllowedNoToolFinal("🚀 DEPLOYED\nfebu-SOL", true), false);
assert.equal(isAllowedNoToolFinal("⛔ NO DEPLOY", false), false);

console.log("agent tool-policy tests passed");
process.exit(0);
