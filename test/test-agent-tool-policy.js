import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-agent-tool-policy-"));
process.env.MERIDIAN_USER_CONFIG_FILE = path.join(tmp, "user-config.json");
process.env.MERIDIAN_STATE_FILE = path.join(tmp, "state.json");
process.env.MERIDIAN_LESSONS_FILE = path.join(tmp, "lessons.json");
process.env.DRY_RUN = "true";
process.env.LLM_API_KEY = "test-only";
// The inert executor regression below must not inherit a developer wallet or
// Telegram route while importing the production modules.
delete process.env.WALLET_PRIVATE_KEY;
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.TELEGRAM_CHAT_ID;
fs.writeFileSync(process.env.MERIDIAN_USER_CONFIG_FILE, JSON.stringify({
  dryRun: true,
  rolloutMode: "dry_run",
  deployAmountSol: 0.2,
  shadowInitialEquitySol: 0.4,
}));
fs.writeFileSync(process.env.MERIDIAN_STATE_FILE, JSON.stringify({ positions: {} }));

try {
const {
  agentLoop,
  activeToolNamesFor,
  authorizeModelToolDispatch,
  bindDirectSwapToolArgs,
  getToolsForRole,
  hasPositiveDirectSwapIntent,
  isAllowedNoToolFinal,
  parseDirectSwapIntent,
  resolveAgentLoopRole,
  shouldForceInitialToolChoice,
  normalizeModelToolArgs,
} = await import("../agent.js");
const { buildSystemPrompt, resolvePromptRole } = await import("../prompt.js");
const { getLessonsForPrompt, resolveLessonPromptRole } = await import("../lessons.js");
const { config, isEffectiveDryRun } = await import("../config.js");
const { bindCliSwapAuthority, normalizeMint, swapToken } = await import("../tools/wallet.js");
const { checkDeployCircuitBreaker, executeTool } = await import("../tools/executor.js");

const screeningGoal = "Review live candidates, deploy the best pool, or report NO DEPLOY.";

assert.equal(shouldForceInitialToolChoice(screeningGoal, true, false, 0), true);
assert.equal(shouldForceInitialToolChoice(screeningGoal, true, true, 0), false);
assert.equal(shouldForceInitialToolChoice(screeningGoal, true, true, 1), false);

assert.equal(isAllowedNoToolFinal("⛔ NO DEPLOY\nNo valid entry.", true), true);
assert.equal(isAllowedNoToolFinal("🚀 DEPLOYED\nfebu-SOL", true), false);
assert.equal(isAllowedNoToolFinal("⛔ NO DEPLOY", false), false);

assert.ok(getToolsForRole("MANAGER").some((tool) => tool.function.name === "reconcile_cleanup"));
assert.ok(!getToolsForRole("MANAGER").some((tool) => tool.function.name === "swap_token"));
const reconcileTool = getToolsForRole("GENERAL", "preview cleanup reconciliation").find((tool) => tool.function.name === "reconcile_cleanup");
assert.deepEqual(reconcileTool.function.parameters.required, ["position"]);
assert.equal(Object.hasOwn(reconcileTool.function.parameters.properties, "execute"), false);
assert.deepEqual(normalizeModelToolArgs("reconcile_cleanup", { position: "p", execute: true, dependencies: { forged: true } }), { position: "p" });
const closeTools = getToolsForRole("GENERAL", "close this position");
assert.ok(closeTools.some((tool) => tool.function.name === "close_position"));
assert.ok(!closeTools.some((tool) => tool.function.name === "swap_token"));
assert.ok(!getToolsForRole("GENERAL", "please help with my portfolio").some((tool) => tool.function.name === "swap_token"));
const closeTool = closeTools.find((tool) => tool.function.name === "close_position");
const deployTool = getToolsForRole("GENERAL", "deploy a position").find((tool) => tool.function.name === "deploy_position");
const claimTool = getToolsForRole("GENERAL", "claim fees").find((tool) => tool.function.name === "claim_fees");
const configTool = getToolsForRole("GENERAL", "update config").find((tool) => tool.function.name === "update_config");
assert.ok(deployTool, "a canonical deploy command retains deploy authority");
assert.ok(closeTool, "a canonical close command retains close authority");
assert.ok(claimTool, "a canonical claim command retains claim authority");
assert.ok(configTool, "a canonical config command retains GENERAL authority");
assert.ok(!getToolsForRole("SCREENER", "deploy a position").some((tool) => tool.function.name === "deploy_position"), "SCREENER text alone cannot gain deploy authority");
assert.ok(getToolsForRole("MANAGER", "close this position").some((tool) => tool.function.name === "close_position"), "MANAGER retains close authority");
for (const [role, request, forbiddenTool] of [
  ["SCREENER", "close this position", "close_position"],
  ["SCREENER", "update config", "update_config"],
  ["MANAGER", "deploy a position", "deploy_position"],
  ["", "deploy a position", "deploy_position"],
  [null, "deploy a position", "deploy_position"],
  [undefined, "deploy a position", "deploy_position"],
  ["UNKNOWN", "deploy a position", "deploy_position"],
  ["screener", "deploy a position", "deploy_position"],
]) {
  assert.ok(!getToolsForRole(role, request).some((tool) => tool.function.name === forbiddenTool), `${String(role)} is denied ${forbiddenTool}`);
}
assert.ok(!getToolsForRole("GENERAL", "open positions").some((tool) => tool.function.name === "deploy_position"), "plural read-only positions never mean deploy");
assert.deepEqual(authorizeModelToolDispatch("not_a_registered_tool", activeToolNamesFor([closeTool])), {
  allowed: false,
  name: "not_a_registered_tool",
  reason: "UNKNOWN_TOOL",
});
assert.deepEqual(authorizeModelToolDispatch("close_position<provider-suffix>", activeToolNamesFor([closeTool])), {
  allowed: false,
  name: "close_position<provider-suffix>",
  reason: "UNKNOWN_TOOL",
});
assert.equal(Object.hasOwn(closeTool.function.parameters.properties, "skip_swap"), false);
assert.deepEqual(normalizeModelToolArgs("close_position", {
  position_address: "p",
  reason: "close rule",
  skip_swap: false,
  execute: true,
}), { position_address: "p", reason: "close rule" });
const directSwapGoal = "swap 10 USDC to SOL";
const directSwapIntent = Object.freeze({
  input_mint: config.tokens.USDC,
  output_mint: config.tokens.SOL,
  amount: 10,
  amount_raw: "10000000",
});
assert.deepEqual(parseDirectSwapIntent(directSwapGoal), directSwapIntent);
assert.deepEqual(parseDirectSwapIntent(`${directSwapGoal}.`), directSwapIntent, "terminal period is not part of the destination asset");

for (const { request, intent } of [
  { request: directSwapGoal, intent: directSwapIntent },
  {
    request: "please convert 000.5000 SOL into USDC.",
    intent: { input_mint: config.tokens.SOL, output_mint: config.tokens.USDC, amount: 0.5, amount_raw: "500000000" },
  },
  {
    request: "sell 2 USDT for SOL!",
    intent: { input_mint: config.tokens.USDT, output_mint: config.tokens.SOL, amount: 2, amount_raw: "2000000" },
  },
  {
    request: "exchange 010.5000 USDC to USDT.",
    intent: { input_mint: config.tokens.USDC, output_mint: config.tokens.USDT, amount: 10.5, amount_raw: "10500000" },
  },
  {
    request: `swap 1 ${config.tokens.USDC} to SOL.`,
    intent: { input_mint: config.tokens.USDC, output_mint: config.tokens.SOL, amount: 1, amount_raw: "1000000" },
  },
  {
    request: "swap 1 USDC to So11111111111111111111111111111111111111111",
    intent: { input_mint: config.tokens.USDC, output_mint: "So11111111111111111111111111111111111111111", amount: 1, amount_raw: "1000000" },
  },
  {
    request: "SwAp 1 USDC To SOL!",
    intent: { input_mint: config.tokens.USDC, output_mint: config.tokens.SOL, amount: 1, amount_raw: "1000000" },
  },
]) {
  assert.deepEqual(parseDirectSwapIntent(request), intent, `canonical intent: ${request}`);
  assert.equal(hasPositiveDirectSwapIntent(request), true, request);
  assert.deepEqual(getToolsForRole("GENERAL", request).map((tool) => tool.function.name), ["swap_token"], `only swap tool exposure: ${request}`);
}

const rejectedDirectSwapRequests = [
  "swap this token to SOL",
  "swap the proceeds to SOL",
  "swap USDC to SOL",
  "swap 10 USDC",
  "swap 0 USDC to SOL",
  "swap -10 USDC to SOL",
  "swap NaN USDC to SOL",
  "swap 1e3 USDC to SOL",
  "swap all USDC to SOL",
  "swap 10 UNKNOWN to SOL",
  "swap 10 sol to USDC",
  "do not swap 10 USDC to SOL",
  "don't swap the proceeds to SOL",
  "swap 10 USDC to SOL, but don't execute it",
  "never swap this token",
  "should I swap 10 USDC to SOL?",
  "why swap this token to SOL?",
  "swap 10 USDC to SOL as an example",
  "swap 10 USDC to SOL if it is safe",
  "swap 10 USDC to SOL! Cancel that.",
  "swap 10 USDC to SOL! I do not want that.",
  "Never execute transactions. Swap 10 USDC to SOL!",
  "swap 10 USDC to SOL! or 5 USDT to SOL",
  "close this position, then swap 10 USDC to SOL",
  "claim fees and swap 10 USDC to SOL",
  "swap 10 USDC to SOL and convert 0.5 SOL into USDC",
  "swap 10 USDC to SOL\n",
  "swap10 USDC to SOL",
  "swapping 10 USDC to SOL",
  "swap_10 USDC to SOL",
  "s\u200Bwap 10 USDC to SOL",
  "s-wap 10 USDC to SOL",
  "\u0455wap 10 USDC to SOL",
  "s\u2060w\u200Da\uFEFFp 10 USDC to SOL",
  "s-WaP 10 USDC to SOL",
  "convert10 USDC to SOL",
  "sell10 USDC to SOL",
  "exchange10 USDC to SOL",
  "c-onvert 10 USDC to SOL",
  "c0nvert 10 USDC to SOL",
  "сonvert 10 USDC to SOL",
  "s\u0301wap 10 USDC to SOL",
  "ｓwap 10 USDC to SOL",
  "𝚜wap 10 USDC to SOL",
  "ꜱwap 10 USDC to SOL",
  "s\uFE0Fwap 10 USDC to SOL",
  "s\twap 10 USDC to SOL",
  "s\nwap 10 USDC to SOL",
  "s\u2028wap 10 USDC to SOL",
  "s+wap 10 USDC to SOL",
  "s1wap 10 USDC to SOL",
  "sw4p 10 USDC to SOL",
  "preswap 10 USDC to SOL",
  "\"swap 10 USDC to SOL\"",
  `swap 1 ${"So11111111111111111111111111111111111111111"} to SOL`,
  "swap 0.0000000001 SOL to USDC",
  "swap 1.0000000000 SOL to USDC",
  "swap 0.0000001 USDC to SOL",
  "swap 18446744073710 USDC to SOL",
  "swap 9007199254740995 USDC to SOL",
  "swap 9007199254740992 USDC to SOL",
  "swap 1.000000000000000001 USDC to SOL",
];
for (const request of rejectedDirectSwapRequests) {
  assert.equal(hasPositiveDirectSwapIntent(request), false, request);
  assert.equal(parseDirectSwapIntent(request), null, `no canonical intent: ${request}`);
  assert.deepEqual(
    getToolsForRole("GENERAL", request).map((tool) => tool.function.name),
    [],
    `fail closed without tool exposure: ${request}`,
  );
}
assert.deepEqual(
  getToolsForRole("GENERAL", "swap this asset to USDC").map((tool) => tool.function.name),
  [],
  "a rejected swap intent must not fall through to the broad GENERAL tool set",
);
assert.deepEqual(
  getToolsForRole("GENERAL", "close this position, then swap 10 USDC to SOL").map((tool) => tool.function.name),
  [],
  "a compound close-plus-swap request is rejected as a whole",
);
const normalGeneralTools = getToolsForRole("GENERAL", "show my wallet balance and open positions");
assert.ok(normalGeneralTools.some((tool) => tool.function.name === "get_wallet_balance"));
assert.ok(normalGeneralTools.some((tool) => tool.function.name === "get_my_positions"));
assert.ok(!normalGeneralTools.some((tool) => tool.function.name === "swap_token"));

const directSwapTool = getToolsForRole("GENERAL", directSwapGoal).find((tool) => tool.function.name === "swap_token");
assert.ok(directSwapTool);
assert.equal(Object.hasOwn(directSwapTool.function.parameters.properties, "amount_raw"), false, "providers never receive raw swap authority in the schema");
assert.deepEqual(
  authorizeModelToolDispatch("swap_token", activeToolNamesFor([directSwapTool]), directSwapIntent, "GENERAL"),
  { allowed: true, name: "swap_token", reason: null },
);
assert.deepEqual(
  authorizeModelToolDispatch("swap_token", activeToolNamesFor([directSwapTool]), null, "GENERAL"),
  { allowed: false, name: "swap_token", reason: "DIRECT_SWAP_INTENT_REQUIRED" },
);
assert.deepEqual(
  bindDirectSwapToolArgs(directSwapIntent, {
    input_mint: directSwapIntent.input_mint,
    output_mint: directSwapIntent.output_mint,
    amount: directSwapIntent.amount,
  }),
  { allowed: true, args: { ...directSwapIntent }, reason: null },
);
for (const args of [
  { input_mint: config.tokens.USDT, output_mint: directSwapIntent.output_mint, amount: directSwapIntent.amount },
  { input_mint: directSwapIntent.input_mint, output_mint: config.tokens.USDC, amount: directSwapIntent.amount },
  { input_mint: directSwapIntent.input_mint, output_mint: directSwapIntent.output_mint, amount: 9.99 },
  { input_mint: directSwapIntent.input_mint, output_mint: directSwapIntent.output_mint, amount: 0 },
  { input_mint: directSwapIntent.input_mint, output_mint: directSwapIntent.output_mint, amount: "10" },
  { ...directSwapIntent },
]) {
  assert.deepEqual(
    bindDirectSwapToolArgs(directSwapIntent, args),
    { allowed: false, args: null, reason: "SWAP_INTENT_ARGUMENT_MISMATCH" },
  );
}

function providerReturningSwapTool() {
  const requests = [];
  let calls = 0;
  return {
    requests,
    client: {
      chat: {
        completions: {
          create: async (request) => {
            requests.push(request);
            calls += 1;
            if (calls === 1) {
              return {
                choices: [{
                  message: {
                    role: "assistant",
                    tool_calls: [{
                      id: "untrusted-swap-call",
                      type: "function",
                      // Deliberately malformed: authorization must happen
                      // before provider-controlled arguments are parsed.
                      function: { name: "swap_token", arguments: "{" },
                    }],
                  },
                }],
              };
            }
            return { choices: [{ message: { role: "assistant", content: "The unauthorized tool was blocked." } }] };
          },
        },
      },
    },
  };
}

async function assertUnadvertisedSwapDoesNotDispatch(toolsOverride) {
  const provider = providerReturningSwapTool();
  let executorCalls = 0;
  let startCallbacks = 0;
  let finishCallbacks = 0;
  const response = await agentLoop("close this position", 2, [], "GENERAL", null, null, {
    toolsOverride,
    clientOverride: provider.client,
    executeToolOverride: async () => {
      executorCalls += 1;
      throw new Error("unadvertised tool must not reach executor");
    },
    promptContext: { portfolio: {}, positions: [] },
    onToolStart: async () => { startCallbacks += 1; },
    onToolFinish: async () => { finishCallbacks += 1; },
  });
  assert.equal(response.content, "The unauthorized tool was blocked.");
  assert.equal(executorCalls, 0);
  assert.equal(startCallbacks, 0, "blocked provider calls are not executed actions");
  assert.equal(finishCallbacks, 0, "blocked provider calls are not executed actions");
  const toolResult = provider.requests[1].messages.find((message) => message.role === "tool");
  assert.deepEqual(JSON.parse(toolResult.content), {
    success: false,
    blocked: true,
    reason: "TOOL_NOT_ACTIVE_FOR_REQUEST",
  });
}

// A provider can ignore both an empty override and a close-only advertised
// list. Dispatch must still block swap_token before parsing or execution.
await assertUnadvertisedSwapDoesNotDispatch([]);
await assertUnadvertisedSwapDoesNotDispatch([closeTool]);

function providerReturningToolCalls(toolCalls) {
  const requests = [];
  let calls = 0;
  return {
    requests,
    client: {
      chat: {
        completions: {
          create: async (request) => {
            requests.push(request);
            calls += 1;
            if (calls === 1) {
              return { choices: [{ message: { role: "assistant", tool_calls: toolCalls } }] };
            }
            return { choices: [{ message: { role: "assistant", content: "Swap request handled." } }] };
          },
        },
      },
    },
  };
}

function argsForPolicyTool(functionName) {
  if (functionName === "update_config") return { changes: { minTvl: 1 }, reason: "policy test" };
  if (functionName === "deploy_position") return { pool_address: "policy-pool" };
  return { position_address: "policy-position" };
}

async function runPolicyDispatch({
  role,
  request,
  functionName,
  tool,
  toolsOverride = [tool],
  onToolStart = null,
  onToolFinish = null,
}) {
  const provider = providerReturningToolCalls([{
    id: `policy-${String(role)}-${functionName}`,
    type: "function",
    function: { name: functionName, arguments: JSON.stringify(argsForPolicyTool(functionName)) },
  }]);
  const dispatched = [];
  const response = await agentLoop(request, 2, [], role, null, null, {
    toolsOverride,
    clientOverride: provider.client,
    executeToolOverride: async (name) => {
      dispatched.push(name);
      return { success: true };
    },
    promptContext: { portfolio: {}, positions: [] },
    onToolStart,
    onToolFinish,
  });
  const toolResult = JSON.parse(provider.requests[1].messages.find((message) => message.role === "tool").content);
  return { dispatched, provider, response, toolResult };
}

const writeLikeToolNames = new Set([
  "deploy_position", "close_position", "claim_fees", "swap_token", "self_update", "update_config",
  "add_to_blacklist", "remove_from_blacklist", "block_deployer", "unblock_deployer",
  "add_pool_note", "set_position_note", "add_smart_wallet", "remove_smart_wallet",
  "add_lesson", "pin_lesson", "unpin_lesson", "clear_lessons",
  "add_strategy", "remove_strategy", "set_active_strategy",
]);

function advertisedWriteNames(role, request) {
  return getToolsForRole(role, request)
    .map((tool) => tool.function.name)
    .filter((name) => writeLikeToolNames.has(name));
}

async function assertWriteRequestIsDenied({ role = "GENERAL", request, functionName, tool }) {
  assert.deepEqual(
    getToolsForRole(role, request)
      .map((candidate) => candidate.function.name)
      .filter((name) => writeLikeToolNames.has(name)),
    [],
    `no write is advertised: ${request}`,
  );
  const result = await runPolicyDispatch({ role, request, functionName, tool });
  assert.deepEqual(result.dispatched, [], `forged ${functionName} dispatch is blocked: ${request}`);
  assert.equal(result.provider.requests[0].tools, undefined, `no write is sent to the provider: ${request}`);
  assert.equal(result.toolResult.reason, "TOOL_NOT_ACTIVE_FOR_REQUEST");
}

// Canonical single-line actions may carry one write intent only. Multiword
// close synonyms, adverbs, punctuation, newlines, and every write family must
// fail closed instead of letting the first full-command matcher win.
for (const { request, functionName, tool } of [
  { request: "shut down this position then claim fees", functionName: "close_position", tool: closeTool },
  { request: "shut down this position then deploy a position", functionName: "close_position", tool: closeTool },
  { request: "shut down this position, then update config", functionName: "close_position", tool: closeTool },
  { request: "shut down this position. Afterwards, claim fees", functionName: "close_position", tool: closeTool },
  { request: "close this position\nThen claim fees", functionName: "close_position", tool: closeTool },
  { request: "close this position then add this token to the blacklist", functionName: "close_position", tool: closeTool },
  { request: "close this position then add this smart wallet", functionName: "close_position", tool: closeTool },
  { request: "close this position then add a lesson", functionName: "close_position", tool: closeTool },
  { request: "close this position then set the active strategy", functionName: "close_position", tool: closeTool },
  { request: "Review the risk and then close", functionName: "close_position", tool: closeTool },
  { request: "Please immediately close", functionName: "close_position", tool: closeTool },
  { request: "Then cl\u043ese", functionName: "close_position", tool: closeTool },
  { request: "self-update, then update config", functionName: "self_update", tool: getToolsForRole("GENERAL", "self-update").find((tool) => tool.function.name === "self_update") },
  { request: "add smart wallet then remove it", functionName: "add_smart_wallet", tool: getToolsForRole("GENERAL", "add smart wallet").find((tool) => tool.function.name === "add_smart_wallet") },
  { request: "add smart wallet and remove it", functionName: "add_smart_wallet", tool: getToolsForRole("GENERAL", "add smart wallet").find((tool) => tool.function.name === "add_smart_wallet") },
  { request: "add lesson; pin it", functionName: "add_lesson", tool: getToolsForRole("GENERAL", "add lesson").find((tool) => tool.function.name === "add_lesson") },
  { request: "add to blacklist then add smart wallet", functionName: "add_to_blacklist", tool: getToolsForRole("GENERAL", "add to blacklist").find((tool) => tool.function.name === "add_to_blacklist") },
  { request: "add lesson then set active strategy", functionName: "add_lesson", tool: getToolsForRole("GENERAL", "add lesson").find((tool) => tool.function.name === "add_lesson") },
]) {
  assert.ok(tool, `canonical fixture exposes ${functionName}`);
  await assertWriteRequestIsDenied({ request, functionName, tool });
}

// Exact role ceilings are enforced at actual provider dispatch, not merely
// when building the advertised tool list.
for (const { role, request, functionName, tool } of [
  { role: "SCREENER", request: "close this position", functionName: "close_position", tool: closeTool },
  { role: "SCREENER", request: "update config", functionName: "update_config", tool: configTool },
  { role: "MANAGER", request: "deploy a position", functionName: "deploy_position", tool: deployTool },
  { role: "", request: "deploy a position", functionName: "deploy_position", tool: deployTool },
  { role: null, request: "deploy a position", functionName: "deploy_position", tool: deployTool },
  { role: undefined, request: "deploy a position", functionName: "deploy_position", tool: deployTool },
  { role: "UNKNOWN", request: "deploy a position", functionName: "deploy_position", tool: deployTool },
  { role: "screener", request: "deploy a position", functionName: "deploy_position", tool: deployTool },
]) {
  const result = await runPolicyDispatch({ role, request, functionName, tool });
  assert.deepEqual(result.dispatched, [], `${String(role)} must not dispatch ${functionName}`);
  assert.equal(result.provider.requests[0].tools, undefined, `${String(role)} does not advertise ${functionName}`);
  assert.deepEqual(result.toolResult, {
    success: false,
    blocked: true,
    reason: "ROLE_CEILING_DENIED",
  });
}

for (const { request, functionName, tool } of [
  { request: "deploy a position", functionName: "deploy_position", tool: deployTool },
  { request: "close this position", functionName: "close_position", tool: closeTool },
  { request: "claim fees", functionName: "claim_fees", tool: claimTool },
  { request: "update config", functionName: "update_config", tool: configTool },
]) {
  const result = await runPolicyDispatch({ role: "GENERAL", request, functionName, tool });
  assert.deepEqual(result.dispatched, [functionName], `GENERAL preserves canonical ${functionName} dispatch`);
}

// Every canonical write command exposes exactly its one mutating tool. A
// provider that forges a sibling write is stopped at dispatch even if an
// accidental active set contains both names.
const exactWriteAuthorityCases = [
  ["deploy a position", "deploy_position", "close_position"],
  ["close this position", "close_position", "claim_fees"],
  ["claim fees", "claim_fees", "close_position"],
  ["self-update", "self_update", "update_config"],
  ["update config", "update_config", "self_update"],
  ["add a smart wallet", "add_smart_wallet", "remove_smart_wallet"],
  ["remove a smart wallet", "remove_smart_wallet", "add_smart_wallet"],
  ["add token to blacklist", "add_to_blacklist", "remove_from_blacklist"],
  ["remove token from blacklist", "remove_from_blacklist", "add_to_blacklist"],
  ["add a lesson", "add_lesson", "clear_lessons"],
  ["pin a lesson", "pin_lesson", "unpin_lesson"],
  ["unpin a lesson", "unpin_lesson", "pin_lesson"],
  ["clear lessons", "clear_lessons", "add_lesson"],
  ["add a strategy", "add_strategy", "remove_strategy"],
  ["remove a strategy", "remove_strategy", "add_strategy"],
  ["set the active strategy", "set_active_strategy", "remove_strategy"],
  ["add a pool note", "add_pool_note", "set_position_note"],
  ["set a position note", "set_position_note", "add_pool_note"],
  ["block a deployer", "block_deployer", "unblock_deployer"],
  ["unblock a deployer", "unblock_deployer", "block_deployer"],
];
for (const [request, functionName, siblingName] of exactWriteAuthorityCases) {
  const exactTool = getToolsForRole("GENERAL", request).find((tool) => tool.function.name === functionName);
  assert.ok(exactTool, `canonical request exposes ${functionName}: ${request}`);
  assert.deepEqual(advertisedWriteNames("GENERAL", request), [functionName], `only ${functionName} is advertised: ${request}`);
  const allowed = await runPolicyDispatch({ role: "GENERAL", request, functionName, tool: exactTool });
  assert.deepEqual(allowed.dispatched, [functionName], `exact ${functionName} dispatches once: ${request}`);
  const forgedSibling = await runPolicyDispatch({ role: "GENERAL", request, functionName: siblingName, tool: exactTool });
  assert.deepEqual(forgedSibling.dispatched, [], `forged sibling ${siblingName} does not dispatch: ${request}`);
  assert.equal(forgedSibling.toolResult.reason, "TOOL_NOT_ACTIVE_FOR_REQUEST");
  assert.deepEqual(
    authorizeModelToolDispatch(siblingName, new Set([functionName, siblingName]), null, "GENERAL", functionName),
    { allowed: false, name: siblingName, reason: "TOOL_NOT_ACTIVE_FOR_REQUEST" },
    `dispatch binding retains exact ${functionName} authority`,
  );
}

assert.deepEqual(
  authorizeModelToolDispatch("deploy_position", new Set(["deploy_position"]), null, "MANAGER"),
  { allowed: false, name: "deploy_position", reason: "ROLE_CEILING_DENIED" },
  "the dispatch recheck rejects a forged active set that exceeds MANAGER's ceiling",
);
assert.deepEqual(
  authorizeModelToolDispatch("deploy_position", new Set(["deploy_position"]), null, undefined),
  { allowed: false, name: "deploy_position", reason: "ROLE_CEILING_DENIED" },
  "an explicit undefined dispatch role never widens to GENERAL",
);

// Compatibility is intentionally limited to calls that truly omit argument
// four; every explicit invalid value resolves to the one READ_ONLY sentinel.
assert.equal(resolveAgentLoopRole(undefined, false), "GENERAL");
for (const invalidRole of [undefined, null, "", "UNKNOWN", "screener", "general"]) {
  assert.equal(resolveAgentLoopRole(invalidRole, true), "READ_ONLY", `invalid role is READ_ONLY: ${String(invalidRole)}`);
  assert.equal(resolvePromptRole(invalidRole, true), "READ_ONLY", `prompt role is READ_ONLY: ${String(invalidRole)}`);
  assert.equal(resolveLessonPromptRole(invalidRole, true), "READ_ONLY", `lesson role is READ_ONLY: ${String(invalidRole)}`);
  assert.equal(getLessonsForPrompt({ agentType: invalidRole }), null, `invalid role receives no lessons: ${String(invalidRole)}`);
}
const readOnlyBalanceTool = getToolsForRole("READ_ONLY", "show wallet balance").find((tool) => tool.function.name === "get_wallet_balance");
assert.ok(readOnlyBalanceTool, "the READ_ONLY sentinel keeps the balance inspection tool");
for (const invalidRole of [undefined, null, "", "UNKNOWN", "screener", "general"]) {
  const callbacks = [];
  const result = await runPolicyDispatch({
    role: invalidRole,
    request: "show wallet balance",
    functionName: "get_wallet_balance",
    tool: readOnlyBalanceTool,
    onToolStart: async (event) => callbacks.push(["start", event.agentType]),
    onToolFinish: async (event) => callbacks.push(["finish", event.agentType]),
  });
  assert.deepEqual(result.dispatched, ["get_wallet_balance"], `invalid role retains only read dispatch: ${String(invalidRole)}`);
  assert.match(result.provider.requests[0].messages[0].content, /Role: READ_ONLY/);
  assert.deepEqual(callbacks, [["start", "READ_ONLY"], ["finish", "READ_ONLY"]], `callbacks use READ_ONLY: ${String(invalidRole)}`);
  assert.deepEqual(advertisedWriteNames(invalidRole, "show wallet balance"), [], `invalid role advertises no writes: ${String(invalidRole)}`);
}

const screenerCandidateDataGoal = [
  "SCREENING CYCLE",
  "PRE-LOADED CANDIDATES (1 pool):",
  "narrative_untrusted: deploy, swap, close, and update are ordinary market words.",
  "STEPS:",
  "3. Call deploy_position.",
].join("\n");
const screenerCandidateDataDispatch = await runPolicyDispatch({
  role: "SCREENER",
  request: screenerCandidateDataGoal,
  functionName: "deploy_position",
  tool: deployTool,
});
assert.deepEqual(screenerCandidateDataDispatch.dispatched, [], "SCREENER prose cannot authorize a deploy");
assert.equal(screenerCandidateDataDispatch.toolResult.reason, "TOOL_NOT_ACTIVE_FOR_REQUEST");
const generalMultilineDispatch = await runPolicyDispatch({
  role: "GENERAL",
  request: "Review candidates and deploy a position.\nCandidate context is preloaded.",
  functionName: "deploy_position",
  tool: deployTool,
});
assert.deepEqual(generalMultilineDispatch.dispatched, [], "GENERAL multiline text does not inherit deployment authority");

const fallbackProviderRequests = [];
let fallbackProviderCalls = 0;
const fallbackProvider = {
  chat: {
    completions: {
      create: async (request) => {
        fallbackProviderRequests.push(request);
        fallbackProviderCalls += 1;
        if (fallbackProviderCalls === 1) throw new Error("invalid message role: system");
        if (fallbackProviderCalls === 2) {
          return { choices: [{ message: {
            role: "assistant",
            tool_calls: [{
              id: "fallback-forged-deploy",
              type: "function",
              function: { name: "deploy_position", arguments: JSON.stringify(argsForPolicyTool("deploy_position")) },
            }],
          } }] };
        }
        return { choices: [{ message: { role: "assistant", content: "fallback denied" } }] };
      },
    },
  },
};
let fallbackExecutions = 0;
await agentLoop("deploy a position", 2, [], "MANAGER", null, null, {
  toolsOverride: [deployTool],
  clientOverride: fallbackProvider,
  executeToolOverride: async () => { fallbackExecutions += 1; },
  promptContext: { portfolio: {}, positions: [] },
});
assert.equal(fallbackExecutions, 0, "system-role provider fallback cannot widen MANAGER authority");
assert.equal(fallbackProviderRequests[1].tools, undefined, "fallback retry still advertises no forbidden tool");

for (const functionName of ["Deploy_Position", "unknown_provider_tool"]) {
  const result = await runPolicyDispatch({
    role: "GENERAL",
    request: "deploy a position",
    functionName,
    tool: deployTool,
  });
  assert.deepEqual(result.dispatched, [], `case-variant or unknown provider tool is denied: ${functionName}`);
  assert.equal(result.toolResult.reason, "UNKNOWN_TOOL");
}

async function assertRejectedSwapOverrideCannotDispatch(request) {
  const provider = providerReturningToolCalls([{
    id: `forged-close-${request}`,
    type: "function",
    function: { name: "close_position", arguments: JSON.stringify({ position_address: "forged", reason: "forged" }) },
  }]);
  let executions = 0;
  const response = await agentLoop(request, 2, [], "GENERAL", null, null, {
    toolsOverride: [closeTool],
    clientOverride: provider.client,
    executeToolOverride: async () => { executions += 1; },
    promptContext: { portfolio: {}, positions: [] },
  });
  assert.equal(response.content, "Swap request handled.");
  assert.equal(executions, 0, `rejected swap-shaped input cannot gain close authority: ${request}`);
  assert.equal(provider.requests[0].tools, undefined, `rejected swap-shaped input exposes zero tools: ${request}`);
  assert.deepEqual(JSON.parse(provider.requests[1].messages.filter((message) => message.role === "tool")[0].content), {
    success: false,
    blocked: true,
    reason: "TOOL_NOT_ACTIVE_FOR_REQUEST",
  });
}

for (const request of [
  "swap10 USDC to SOL",
  "swapping 10 USDC to SOL",
  "swap_10 USDC to SOL",
  "s\u200Bwap 10 USDC to SOL",
  "s-wap 10 USDC to SOL",
  "\u0455wap 10 USDC to SOL",
  "s\u2060w\u200Da\uFEFFp 10 USDC to SOL",
  "s-WaP 10 USDC to SOL",
  "convert10 USDC to SOL",
  "sell10 USDC to SOL",
  "exchange10 USDC to SOL",
  "c-onvert 10 USDC to SOL",
  "c0nvert 10 USDC to SOL",
  "сonvert 10 USDC to SOL",
  "\"swap 10 USDC to SOL\"",
  "swap 10 UNKNOWN to SOL",
  "swap 10 USDC to SOL if it is safe",
  "close this position, then swap 10 USDC to SOL",
  "swap 10 USDC to SOL! Cancel that.",
]) {
  await assertRejectedSwapOverrideCannotDispatch(request);
}

const reviewerSwapBypassShapes = [
  "s\u0301wap 1 USDC to SOL",
  "ｓwap 1 USDC to SOL",
  "𝚜wap 1 USDC to SOL",
  "ꜱwap 1 USDC to SOL",
  "s\uFE0Fwap 1 USDC to SOL",
  "s\twap 1 USDC to SOL",
  "s\nwap 1 USDC to SOL",
  "s\u2028wap 1 USDC to SOL",
  "s+wap 1 USDC to SOL",
  "s1wap 1 USDC to SOL",
  "sw4p 1 USDC to SOL",
  "c0nvert 1 USDC to SOL",
  "сonvert 1 USDC to SOL",
  "preswap 1 USDC to SOL",
];

async function assertForgedWriteIsBlocked(request, tool, functionName, agentType = "GENERAL") {
  const provider = providerReturningToolCalls([{
    id: `forged-${functionName}`,
    type: "function",
    function: { name: functionName, arguments: JSON.stringify({ position_address: "forged" }) },
  }]);
  let executions = 0;
  const response = await agentLoop(request, 2, [], agentType, null, null, {
    toolsOverride: [tool],
    clientOverride: provider.client,
    executeToolOverride: async () => { executions += 1; return { success: true }; },
    promptContext: { portfolio: {}, positions: [] },
  });
  assert.equal(response.content, "Swap request handled.");
  assert.equal(executions, 0, `forged ${functionName} is blocked: ${request}`);
  assert.equal(provider.requests[0].tools, undefined, `no tools are advertised: ${request}`);
  assert.deepEqual(JSON.parse(provider.requests[1].messages.filter((message) => message.role === "tool")[0].content), {
    success: false,
    blocked: true,
    reason: "TOOL_NOT_ACTIVE_FOR_REQUEST",
  });
}

for (const malformedSwap of reviewerSwapBypassShapes) {
  for (const { prefix, tool, functionName } of [
    { prefix: "deploy a position then", tool: deployTool, functionName: "deploy_position" },
    { prefix: "close this position then", tool: closeTool, functionName: "close_position" },
    { prefix: "claim fees then", tool: claimTool, functionName: "claim_fees" },
  ]) {
    const request = `${prefix} ${malformedSwap}`;
    assert.deepEqual(getToolsForRole("GENERAL", request), [], `malformed swap compound is denial-only: ${request}`);
    await assertForgedWriteIsBlocked(request, tool, functionName);
  }
  for (const agentType of ["GENERAL", "MANAGER", "SCREENER"]) {
    assert.deepEqual(getToolsForRole(agentType, `deploy a position then ${malformedSwap}`), [], `${agentType} cannot bypass malformed-swap denial`);
  }
  await assertForgedWriteIsBlocked(`deploy a position then ${malformedSwap}`, deployTool, "deploy_position", "SCREENER");
  assert.deepEqual(
    getToolsForRole("GENERAL", `show my wallet balance and ${malformedSwap}`),
    [],
    `a malformed swap compound suppresses even read tools: ${malformedSwap}`,
  );
}

for (const { prompt, tool, functionName } of [
  { prompt: "show my wallet balance and open positions", tool: deployTool, functionName: "deploy_position" },
  { prompt: "tampilkan saldo dompet dan posisi saya", tool: claimTool, functionName: "claim_fees" },
  { prompt: "muestra mi saldo de billetera y posiciones abiertas", tool: closeTool, functionName: "close_position" },
  { prompt: "ウォレット残高と保有ポジションを表示して", tool: deployTool, functionName: "deploy_position" },
]) {
  const readOnlyTools = getToolsForRole("GENERAL", prompt);
  const readOnlyNames = readOnlyTools.map((candidate) => candidate.function.name);
  assert.ok(readOnlyNames.includes("get_wallet_balance"), `wallet balance is available for: ${prompt}`);
  assert.ok(readOnlyNames.includes("get_my_positions"), `positions are available for: ${prompt}`);
  for (const destructiveName of ["deploy_position", "close_position", "claim_fees", "swap_token", "update_config", "self_update", "reconcile_cleanup"]) {
    assert.ok(!readOnlyNames.includes(destructiveName), `read-only prompt has no ${destructiveName}: ${prompt}`);
  }
  await assertForgedWriteIsBlocked(prompt, tool, functionName);
}

function modelArgsForDirectSwap(intent = directSwapIntent) {
  return {
    input_mint: intent.input_mint,
    output_mint: intent.output_mint,
    amount: intent.amount,
  };
}

async function runDirectSwapProviderCall(args, toolCalls = null, executor = null) {
  const provider = providerReturningToolCalls(toolCalls || [{
    id: "direct-swap-call",
    type: "function",
    function: { name: "swap_token", arguments: JSON.stringify(args) },
  }]);
  const dispatched = [];
  let starts = 0;
  let finishes = 0;
  const response = await agentLoop(directSwapGoal, 2, [], "GENERAL", null, null, {
    clientOverride: provider.client,
    executeToolOverride: async (name, dispatchedArgs) => {
      dispatched.push({ name, args: dispatchedArgs });
      return executor ? executor(name, dispatchedArgs) : { success: true };
    },
    promptContext: { portfolio: {}, positions: [] },
    onToolStart: async () => { starts += 1; },
    onToolFinish: async () => { finishes += 1; },
  });
  assert.equal(response.content, "Swap request handled.");
  assert.ok(
    provider.requests[0].tools.some((tool) => tool.function.name === "swap_token"),
    "only a canonical direct user intent advertises swap_token",
  );
  const toolMessages = provider.requests[1].messages.filter((message) => message.role === "tool");
  return { dispatched, starts, finishes, toolMessages };
}

const exactSwap = await runDirectSwapProviderCall(modelArgsForDirectSwap());
assert.deepEqual(exactSwap.dispatched, [{ name: "swap_token", args: { ...directSwapIntent } }]);
assert.equal(exactSwap.starts, 1);
assert.equal(exactSwap.finishes, 1);
assert.deepEqual(JSON.parse(exactSwap.toolMessages[0].content), { success: true });

const exactBoundWalletSwap = await runDirectSwapProviderCall(
  modelArgsForDirectSwap(),
  null,
  async (_name, boundArgs) => swapToken(boundArgs),
);
assert.deepEqual(exactBoundWalletSwap.dispatched, [{ name: "swap_token", args: { ...directSwapIntent } }]);
assert.deepEqual(JSON.parse(exactBoundWalletSwap.toolMessages[0].content).would_swap, {
  input_mint: directSwapIntent.input_mint,
  output_mint: directSwapIntent.output_mint,
  amount: directSwapIntent.amount,
  amount_raw: directSwapIntent.amount_raw,
}, "direct-swap dispatch reaches wallet dry-run with the canonical mints and exact bound raw amount");

for (const args of [
  { ...modelArgsForDirectSwap(), input_mint: config.tokens.USDT },
  { ...modelArgsForDirectSwap(), output_mint: config.tokens.USDC },
  { ...modelArgsForDirectSwap(), amount: 9.99 },
  { ...modelArgsForDirectSwap(), amount: 0 },
  { ...modelArgsForDirectSwap(), amount_raw: "10000000" },
]) {
  const blockedSwap = await runDirectSwapProviderCall(args);
  assert.equal(blockedSwap.dispatched.length, 0, "mismatched swap arguments must not reach the executor");
  assert.equal(blockedSwap.starts, 0);
  assert.equal(blockedSwap.finishes, 0);
  assert.deepEqual(JSON.parse(blockedSwap.toolMessages[0].content), {
    success: false,
    blocked: true,
    reason: "SWAP_INTENT_ARGUMENT_MISMATCH",
  });
}

const duplicateSwap = await runDirectSwapProviderCall({ ...directSwapIntent }, [
  {
    id: "first-direct-swap-call",
    type: "function",
    function: { name: "swap_token", arguments: JSON.stringify(modelArgsForDirectSwap()) },
  },
  {
    id: "duplicate-direct-swap-call",
    type: "function",
    function: { name: "swap_token", arguments: JSON.stringify(modelArgsForDirectSwap()) },
  },
]);
assert.equal(duplicateSwap.dispatched.length, 1, "one user amount can execute only once per provider response");
assert.equal(duplicateSwap.starts, 1);
assert.equal(duplicateSwap.finishes, 2, "the duplicate is reported as blocked without executing");
assert.match(JSON.parse(duplicateSwap.toolMessages[1].content).reason, /already attempted this session/);

// An override is a test seam only. Even a provider that ignores an empty
// advertised-tool list cannot turn a valid user command into a dispatch.
const overriddenSwapProvider = providerReturningToolCalls([{
  id: "override-direct-swap-call",
  type: "function",
  function: { name: "swap_token", arguments: JSON.stringify(modelArgsForDirectSwap()) },
}]);
let overriddenSwapExecutions = 0;
const overriddenSwapResponse = await agentLoop(directSwapGoal, 2, [], "GENERAL", null, null, {
  toolsOverride: [],
  clientOverride: overriddenSwapProvider.client,
  executeToolOverride: async () => { overriddenSwapExecutions += 1; },
  promptContext: { portfolio: {}, positions: [] },
});
assert.equal(overriddenSwapResponse.content, "Swap request handled.");
assert.equal(overriddenSwapExecutions, 0);
assert.equal(overriddenSwapProvider.requests[0].tools, undefined);
assert.deepEqual(JSON.parse(overriddenSwapProvider.requests[1].messages.filter((message) => message.role === "tool").at(-1).content), {
  success: false,
  blocked: true,
  reason: "TOOL_NOT_ACTIVE_FOR_REQUEST",
});

const widenedOverrideProvider = providerReturningToolCalls([{
  id: "override-close-call",
  type: "function",
  function: { name: "close_position", arguments: JSON.stringify({ position_address: "forged", reason: "forged" }) },
}]);
let widenedOverrideExecutions = 0;
await agentLoop(directSwapGoal, 2, [], "GENERAL", null, null, {
  toolsOverride: [directSwapTool, closeTool],
  clientOverride: widenedOverrideProvider.client,
  executeToolOverride: async () => { widenedOverrideExecutions += 1; },
  promptContext: { portfolio: {}, positions: [] },
});
assert.equal(widenedOverrideExecutions, 0, "toolsOverride cannot add close authority to a direct swap command");
assert.deepEqual(widenedOverrideProvider.requests[0].tools.map((tool) => tool.function.name), ["swap_token"]);
assert.equal(
  JSON.parse(widenedOverrideProvider.requests[1].messages.filter((message) => message.role === "tool").at(-1).content).reason,
  "TOOL_NOT_ACTIVE_FOR_REQUEST",
);

function providerReturningSerialSwapRetries() {
  const requests = [];
  let calls = 0;
  const directToolCall = (id) => ({
    id,
    type: "function",
    function: { name: "swap_token", arguments: JSON.stringify(modelArgsForDirectSwap()) },
  });
  return {
    requests,
    client: {
      chat: {
        completions: {
          create: async (request) => {
            requests.push(request);
            calls += 1;
            if (calls === 1) return { choices: [{ message: { role: "assistant", tool_calls: [directToolCall("first-swap-attempt")] } }] };
            if (calls === 2) return { choices: [{ message: { role: "assistant", tool_calls: [directToolCall("serial-swap-retry")] } }] };
            return { choices: [{ message: { role: "assistant", content: "Stopped after the first swap attempt." } }] };
          },
        },
      },
    },
  };
}

async function assertSerialSwapRetryIsBlocked(executeToolOverride, expectedFirstResult) {
  const provider = providerReturningSerialSwapRetries();
  let executions = 0;
  const response = await agentLoop(directSwapGoal, 3, [], "GENERAL", null, null, {
    clientOverride: provider.client,
    executeToolOverride: async (...args) => {
      executions += 1;
      return executeToolOverride(...args);
    },
    promptContext: { portfolio: {}, positions: [] },
  });
  assert.equal(response.content, "Stopped after the first swap attempt.");
  assert.equal(executions, 1, "a serial provider retry must never reach the executor");
  assert.deepEqual(JSON.parse(provider.requests[1].messages.filter((message) => message.role === "tool")[0].content), expectedFirstResult);
  const retryResult = JSON.parse(provider.requests[2].messages.filter((message) => message.role === "tool").at(-1).content);
  assert.equal(retryResult.blocked, true);
  assert.match(retryResult.reason, /swap_token already attempted this session/);
}

await assertSerialSwapRetryIsBlocked(
  async () => ({ success: false, error: "EXECUTOR_REJECTED" }),
  { success: false, error: "EXECUTOR_REJECTED" },
);
await assertSerialSwapRetryIsBlocked(
  async () => { throw new Error("executor transport failure"); },
  { success: false, error: "TOOL_EXECUTION_FAILED" },
);

async function runUpdateConfigSession(toolCalls, executeToolOverride) {
  const provider = providerReturningToolCalls(toolCalls);
  const dispatched = [];
  const response = await agentLoop("update config", 3, [], "GENERAL", null, null, {
    clientOverride: provider.client,
    executeToolOverride: async (...args) => {
      dispatched.push(args[0]);
      return executeToolOverride(...args);
    },
    promptContext: { portfolio: {}, positions: [] },
  });
  return { provider, dispatched, response };
}

const updateConfigArgs = JSON.stringify({ changes: { minTvl: 1 }, reason: "duplicate policy test" });
const duplicateConfigSession = await runUpdateConfigSession([
  { id: "first-config", type: "function", function: { name: "update_config", arguments: updateConfigArgs } },
  { id: "duplicate-config", type: "function", function: { name: "update_config", arguments: updateConfigArgs } },
], async () => ({ success: true }));
assert.deepEqual(duplicateConfigSession.dispatched, ["update_config"], "concurrent duplicate update_config calls execute at most once");
const duplicateConfigToolResults = duplicateConfigSession.provider.requests[1].messages.filter((message) => message.role === "tool");
assert.equal(duplicateConfigToolResults.length, 2);
assert.match(JSON.parse(duplicateConfigToolResults[1].content).reason, /update_config already attempted this session/);

const serialConfigProvider = (() => {
  const requests = [];
  let calls = 0;
  const updateCall = (id) => ({ id, type: "function", function: { name: "update_config", arguments: updateConfigArgs } });
  return {
    requests,
    client: {
      chat: {
        completions: {
          create: async (request) => {
            requests.push(request);
            calls += 1;
            if (calls === 1) return { choices: [{ message: { role: "assistant", tool_calls: [updateCall("config-throws")] } }] };
            if (calls === 2) return { choices: [{ message: { role: "assistant", tool_calls: [updateCall("config-retry")] } }] };
            return { choices: [{ message: { role: "assistant", content: "config retry denied" } }] };
          },
        },
      },
    },
  };
})();
let serialConfigExecutions = 0;
const serialConfigResponse = await agentLoop("update config", 3, [], "GENERAL", null, null, {
  clientOverride: serialConfigProvider.client,
  executeToolOverride: async () => {
    serialConfigExecutions += 1;
    throw new Error("config transport failure");
  },
  promptContext: { portfolio: {}, positions: [] },
});
assert.equal(serialConfigResponse.content, "config retry denied");
assert.equal(serialConfigExecutions, 1, "an update_config exception remains locked against provider retry");
assert.deepEqual(JSON.parse(serialConfigProvider.requests[1].messages.filter((message) => message.role === "tool")[0].content), {
  success: false,
  error: "TOOL_EXECUTION_FAILED",
});
assert.match(
  JSON.parse(serialConfigProvider.requests[2].messages.filter((message) => message.role === "tool").at(-1).content).reason,
  /update_config already attempted this session/,
);

const closeExceptionProvider = providerReturningToolCalls([{
  id: "close-throws-once",
  type: "function",
  function: { name: "close_position", arguments: JSON.stringify({ position_address: "close-once", reason: "test" }) },
}]);
let closeExceptionExecutions = 0;
await assert.rejects(
  agentLoop("close this position", 3, [], "GENERAL", null, null, {
    clientOverride: closeExceptionProvider.client,
    executeToolOverride: async () => {
      closeExceptionExecutions += 1;
      throw new Error("close transport failure");
    },
    promptContext: { portfolio: {}, positions: [] },
  }),
  /close transport failure/,
  "non-swap executor exceptions retain propagation semantics",
);
assert.equal(closeExceptionExecutions, 1, "a throwing close executes exactly once before the loop terminates");
assert.equal(closeExceptionProvider.requests.length, 1, "a close exception never reaches the provider retry turn");

const managerPrompt = buildSystemPrompt("MANAGER", {}, []);
const generalPrompt = buildSystemPrompt("GENERAL", {}, []);
for (const systemPrompt of [managerPrompt, generalPrompt]) {
  assert.doesNotMatch(systemPrompt, /swap_token\s+is\s+mandatory/i);
  assert.doesNotMatch(systemPrompt, /after\s+(?:any\s+)?close[^\n]*\bswap\b/i);
  assert.doesNotMatch(systemPrompt, /swap\s+all\s+to\s+sol/i);
}
assert.match(generalPrompt, /do not initiate wallet-wide token swaps after a close or claim/i);

// The immutable effective state remains dry even if a mutable process
// environment mirror is changed after startup. swapToken must return before
// loading a wallet, making a network request, or preparing a transaction.
assert.equal(isEffectiveDryRun(), true);
process.env.DRY_RUN = "false";
assert.equal(isEffectiveDryRun(), true);
const solPrefixedPublicKey = "So11111111111111111111111111111111111111111";
assert.equal(normalizeMint("SOL"), config.tokens.SOL);
assert.equal(normalizeMint("native"), config.tokens.SOL);
assert.equal(normalizeMint(config.tokens.SOL), config.tokens.SOL);
assert.equal(normalizeMint(solPrefixedPublicKey), solPrefixedPublicKey, "a non-wrapped So1-prefixed public key is not rewritten");
const swapPreview = await swapToken({
  ...directSwapIntent,
});
assert.equal(swapPreview.dry_run, true);
assert.equal(swapPreview.message, "DRY RUN — no transaction sent");
assert.deepEqual(swapPreview.would_swap, {
  input_mint: directSwapIntent.input_mint,
  output_mint: directSwapIntent.output_mint,
  amount: directSwapIntent.amount,
  amount_raw: directSwapIntent.amount_raw,
}, "wallet dry-run preserves the canonical bound mints and raw amount");
for (const amount_raw of [undefined, "0", "0001", "1.5", "18446744073709551616"]) {
  const invalidRawSwap = await swapToken({
    input_mint: config.tokens.USDC,
    output_mint: config.tokens.SOL,
    amount: 1,
    amount_raw,
  });
  assert.equal(invalidRawSwap.success, false, `wallet rejects non-exact raw amount: ${String(amount_raw)}`);
}

assert.deepEqual(
  bindCliSwapAuthority({ from: "USDC", to: "SOL", amountText: "1.000001" }),
  {
    allowed: true,
    args: {
      input_mint: config.tokens.USDC,
      output_mint: config.tokens.SOL,
      amount: "1.000001",
      amount_raw: "1000001",
    },
  },
  "CLI binds the original decimal text to an exact raw authority without parseFloat",
);
assert.deepEqual(
  bindCliSwapAuthority({ from: "SOL", to: "So11111111111111111111111111111111111111111", amountText: "0.000000001" }),
  {
    allowed: true,
    args: {
      input_mint: config.tokens.SOL,
      output_mint: "So11111111111111111111111111111111111111111",
      amount: "0.000000001",
      amount_raw: "1",
    },
  },
  "CLI keeps arbitrary base58 destinations while deriving SOL raw units exactly",
);
assert.deepEqual(
  bindCliSwapAuthority({ from: "USDC", to: "11111111111111111111111111111111", amountText: "0001.000001" }),
  {
    allowed: true,
    args: {
      input_mint: config.tokens.USDC,
      output_mint: "11111111111111111111111111111111",
      amount: "0001.000001",
      amount_raw: "1000001",
    },
  },
  "CLI accepts an arbitrary valid 32-byte destination and preserves the original decimal text",
);
assert.deepEqual(
  bindCliSwapAuthority({ from: "USDC", to: "SOL", amountText: "18446744073709.551615" }),
  {
    allowed: true,
    args: {
      input_mint: config.tokens.USDC,
      output_mint: config.tokens.SOL,
      amount: "18446744073709.551615",
      amount_raw: "18446744073709551615",
    },
  },
  "CLI accepts the exact u64 boundary without Number rounding",
);
for (const authorityRequest of [
  { from: "usdc", to: "SOL", amountText: "1" },
  { from: "So11111111111111111111111111111111111111111", to: "SOL", amountText: "1" },
  { from: "USDC", to: "SOL", amountText: "0.0000001" },
  { from: "SOL", to: "USDC", amountText: "0.0000000001" },
  { from: "USDC", to: "SOL", amountText: "18446744073710" },
  { from: "USDC", to: "SOL", amountText: "18446744073709.551616" },
  { from: "USDC", to: "SOL", amountText: "1e3" },
  { from: "USDC", to: "SOL", amountText: "0" },
  { from: "USDC", to: "z".repeat(32), amountText: "1" },
]) {
  assert.equal(bindCliSwapAuthority(authorityRequest).allowed, false, `CLI rejects unsafe swap authority: ${JSON.stringify(authorityRequest)}`);
}

assert.equal((await checkDeployCircuitBreaker({ dryRun: true, entryAllowed: async () => {
  throw new Error("dry run must not consult or mutate breaker");
} })).pass, true);
const breakerBlocked = await checkDeployCircuitBreaker({ dryRun: false, entryAllowed: async () => false });
assert.equal(breakerBlocked.pass, false);
assert.match(breakerBlocked.reason, /Circuit breaker/);

// A screening boundary supplies an exact deeply frozen request. Fresh market
// data may enrich only the executor's internal copy: the same mutable object
// must reach both safety validation and the tool implementation unchanged from
// the caller's perspective.
const frozenDeployRequest = Object.freeze({
  pool_address: "frozen-enrichment-pool",
  amount_y: 0.2,
  amount_x: 0,
  bins_below: 35,
  bins_above: 0,
  base_mint: "frozen-enrichment-mint",
  policy_snapshot: Object.freeze({
    rank: 1,
    audit: Object.freeze({ pvp: false }),
  }),
});
const frozenDeploySnapshot = JSON.parse(JSON.stringify(frozenDeployRequest));
let safetyArgs = null;
let implementationArgs = null;
const frozenDeployResult = await executeTool("deploy_position", frozenDeployRequest, {
  getPaperDeploymentGate: () => ({ pass: true }),
  validateDeployPoolThresholds: async (candidateArgs) => {
    safetyArgs = candidateArgs;
    assert.notEqual(candidateArgs, frozenDeployRequest);
    assert.equal(Object.isFrozen(candidateArgs), false);
    assert.equal(Object.isFrozen(candidateArgs.policy_snapshot), false);
    assert.equal(Object.isFrozen(candidateArgs.policy_snapshot.audit), false);
    return {
      pass: true,
      entryMarketData: {
        entry_mcap: 1_500_000,
        entry_tvl: 80_000,
        entry_volume: 8_000,
        entry_holders: 8_000,
      },
    };
  },
  toolMap: {
    deploy_position: async (candidateArgs) => {
      implementationArgs = candidateArgs;
      return { success: true, dry_run: true, paper_position: "paper-frozen-enrichment" };
    },
  },
});
assert.equal(frozenDeployResult.success, true);
assert.equal(frozenDeployResult.paper_position, "paper-frozen-enrichment");
assert.equal(implementationArgs, safetyArgs, "safety and execution share one internal mutable request");
assert.equal(implementationArgs.entry_mcap, 1_500_000);
assert.equal(implementationArgs.entry_tvl, 80_000);
assert.deepEqual(frozenDeployRequest, frozenDeploySnapshot);
assert.equal(Object.isFrozen(frozenDeployRequest), true);
assert.equal(Object.isFrozen(frozenDeployRequest.policy_snapshot), true);
assert.equal(Object.isFrozen(frozenDeployRequest.policy_snapshot.audit), true);

// JSON may contain own __proto__ keys. The executor must preserve those as
// data, not turn them into inherited authority on its working copy (including
// nested objects and objects within arrays).
const prototypePayload = JSON.parse(`{
  "pool_address": "prototype-safe-pool",
  "amount_y": 0.2,
  "amount_x": 0,
  "bins_below": 35,
  "bins_above": 0,
  "constructor": { "source": "untrusted-json" },
  "policy_snapshot": { "__proto__": { "entry_mcap": 999999, "execute": true } },
  "signals": [{ "__proto__": { "amount_y": 999, "execute": true } }],
  "__proto__": {
    "pool_address": "attacker-pool",
    "amount_y": 999,
    "entry_mcap": 999999,
    "entry_tvl": 999999,
    "execute": true
  }
}`);
assert.equal(Object.hasOwn(prototypePayload, "__proto__"), true);
assert.equal(Object.getPrototypeOf(prototypePayload), Object.prototype);
let prototypeSafetyArgs = null;
let prototypeImplementationArgs = null;
const prototypeResult = await executeTool("deploy_position", prototypePayload, {
  getPaperDeploymentGate: () => ({ pass: true }),
  validateDeployPoolThresholds: async (candidateArgs) => {
    prototypeSafetyArgs = candidateArgs;
    assert.equal(Object.getPrototypeOf(candidateArgs), Object.prototype);
    assert.equal(Object.hasOwn(candidateArgs, "__proto__"), true);
    assert.deepEqual(candidateArgs.__proto__, prototypePayload.__proto__);
    assert.deepEqual(candidateArgs.constructor, { source: "untrusted-json" });
    assert.equal(Object.hasOwn(candidateArgs, "constructor"), true);
    assert.equal(candidateArgs.pool_address, "prototype-safe-pool");
    assert.equal(candidateArgs.entry_mcap, undefined, "safety cannot read inherited economic fields");
    assert.equal(candidateArgs.entry_tvl, undefined, "safety cannot read inherited economic fields");
    assert.equal(candidateArgs.execute, undefined, "safety cannot read inherited execution fields");
    assert.equal(Object.getPrototypeOf(candidateArgs.policy_snapshot), Object.prototype);
    assert.equal(Object.hasOwn(candidateArgs.policy_snapshot, "__proto__"), true);
    assert.equal(candidateArgs.policy_snapshot.entry_mcap, undefined);
    assert.equal(Array.isArray(candidateArgs.signals), true);
    assert.equal(Object.getPrototypeOf(candidateArgs.signals[0]), Object.prototype);
    assert.equal(Object.hasOwn(candidateArgs.signals[0], "__proto__"), true);
    assert.equal(candidateArgs.signals[0].execute, undefined);
    return { pass: true };
  },
  toolMap: {
    deploy_position: async (candidateArgs) => {
      prototypeImplementationArgs = candidateArgs;
      assert.equal(candidateArgs.entry_mcap, undefined, "tool cannot read inherited economic fields");
      assert.equal(candidateArgs.entry_tvl, undefined, "tool cannot read inherited economic fields");
      assert.equal(candidateArgs.execute, undefined, "tool cannot read inherited execution fields");
      return { success: true, dry_run: true, paper_position: "paper-prototype-safe" };
    },
  },
});
assert.equal(prototypeResult.success, true);
assert.equal(prototypeImplementationArgs, prototypeSafetyArgs, "safety and execution retain one safe working object");
assert.equal(Object.getPrototypeOf(prototypePayload), Object.prototype, "caller JSON remains unchanged");
assert.equal(Object.hasOwn(prototypePayload, "__proto__"), true);

console.log("agent tool-policy tests passed");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
