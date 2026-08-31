import OpenAI from "openai";
import { jsonrepair } from "jsonrepair";
import { buildSystemPrompt } from "./prompt.js";
import { executeTool, isToolExecutionSuccess } from "./tools/executor.js";
import { tools } from "./tools/definitions.js";

const MANAGER_TOOLS  = new Set(["close_position", "claim_fees", "reconcile_cleanup", "get_position_pnl", "get_my_positions", "get_wallet_balance"]);
const SCREENER_TOOLS = new Set(["deploy_position", "get_active_bin", "get_top_candidates", "check_smart_wallets_on_pool", "get_token_holders", "get_token_narrative", "get_token_info", "search_pools", "get_pool_memory", "get_wallet_balance", "get_my_positions"]);
const WRITE_LIKE_TOOL_NAMES = new Set([
  "deploy_position",
  "close_position",
  "claim_fees",
  "swap_token",
  "self_update",
  "update_config",
  "add_to_blacklist",
  "remove_from_blacklist",
  "block_deployer",
  "unblock_deployer",
  "add_pool_note",
  "set_position_note",
  "add_smart_wallet",
  "remove_smart_wallet",
  "add_lesson",
  "pin_lesson",
  "unpin_lesson",
  "clear_lessons",
  "add_strategy",
  "remove_strategy",
  "set_active_strategy",
]);

const KNOWN_TOOL_NAMES = new Set(tools
  .map((tool) => tool?.function?.name)
  .filter((name) => typeof name === "string" && name));
const READ_ONLY_TOOL_NAMES = new Set([...KNOWN_TOOL_NAMES]
  .filter((name) => !WRITE_LIKE_TOOL_NAMES.has(name)));
// Role names are capabilities, not display labels. Only these exact strings
// receive a write ceiling; every other value falls back to read-only tools.
// GENERAL is still constrained by the request-specific canonical intent below.
const ROLE_TOOL_CEILINGS = Object.freeze({
  GENERAL: new Set(KNOWN_TOOL_NAMES),
  MANAGER: new Set(MANAGER_TOOLS),
  SCREENER: new Set(SCREENER_TOOLS),
});
const SAFE_READ_ONLY_FALLBACK_CEILING = new Set(READ_ONLY_TOOL_NAMES);
const BASE58_MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
// Direct authority accepts an intentionally small ASCII grammar. Any control,
// Unicode separator, compatibility form, or added prose is rejected instead
// of being normalized into an actionable request.
const DIRECT_SWAP_COMMAND_RE = /^(?:please )?(?:swap|convert|sell|exchange) +(\d+(?:\.\d+)?) +(SOL|USDC|USDT|[1-9A-HJ-NP-Za-km-z]{32,44}) +(?:to|for|into) +(SOL|USDC|USDT|[1-9A-HJ-NP-Za-km-z]{32,44})[.!]?$/i;
const SWAP_TOKEN_ARGUMENT_KEYS = new Set(["input_mint", "output_mint", "amount"]);
const MAX_TOKEN_RAW_AMOUNT = (1n << 64n) - 1n;

function freezeBoundDeployValue(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(freezeBoundDeployValue));
  if (value && typeof value === "object") {
    return Object.freeze(Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [key, freezeBoundDeployValue(nestedValue)]),
    ));
  }
  return value;
}

/**
 * Create the one-use authority used only by one deterministic screening
 * decision. The capability and request are object identities, not values that
 * candidate text, an LLM, callbacks, or tool arguments can forge.
 *
 * runScreeningCycle creates this boundary only after its deterministic
 * selection and AI veto. The injected executor seam is solely for local tests.
 */
export function createScreeningDeployBoundary(deployRequest, { executeToolOverride = executeTool } = {}) {
  if (!deployRequest || typeof deployRequest !== "object" || Array.isArray(deployRequest)) {
    throw new TypeError("SCREENING_DEPLOY_REQUEST_MUST_BE_AN_OBJECT");
  }
  if (typeof executeToolOverride !== "function") {
    throw new TypeError("SCREENING_DEPLOY_EXECUTOR_MUST_BE_A_FUNCTION");
  }

  const capability = Object.freeze({});
  const request = freezeBoundDeployValue(deployRequest);
  let dispatched = false;

  async function dispatchScreeningDeploy(candidateCapability, candidateRequest) {
    if (candidateCapability !== capability) {
      return { success: false, blocked: true, reason: "SCREENING_DEPLOY_CAPABILITY_DENIED" };
    }
    if (candidateRequest !== request) {
      return { success: false, blocked: true, reason: "SCREENING_DEPLOY_REQUEST_MISMATCH" };
    }
    if (dispatched) {
      return { success: false, blocked: true, reason: "SCREENING_DEPLOY_ALREADY_DISPATCHED" };
    }
    dispatched = true;
    return executeToolOverride("deploy_position", request);
  }

  return Object.freeze({ capability, request, dispatchScreeningDeploy });
}

// Conversation text is handled by GENERAL's canonical exact-write authority.
// SCREENER remains a read/review role and never carries autonomous deploy
// authority into a provider request.
export function resolveTelegramConversationRoute() {
  return Object.freeze({ agentRole: "GENERAL", agentModel: config.llm.generalModel });
}

export function resolveInteractiveDeployRoute(input, candidateCount = 0) {
  const text = String(input ?? "").trim();
  if (/^[1-9]\d*$/.test(text)) {
    const index = Number(text) - 1;
    if (Number.isSafeInteger(index) && index >= 0 && index < candidateCount) {
      return Object.freeze({ kind: "OPERATOR_CANDIDATE", index });
    }
  }
  if (text.toLowerCase() === "auto") return Object.freeze({ kind: "AUTONOMOUS_SCREENING" });
  return null;
}

/**
 * Keep the TTY's operator pick and autonomous auto request explicit and
 * mockable. Callers supply their production actions; neither receives or
 * reuses the autonomous screening boundary's private capability.
 */
export async function dispatchInteractiveDeployInput(input, candidateCount, {
  deployLatestCandidateOverride,
  runScreeningCycleOverride,
} = {}) {
  const route = resolveInteractiveDeployRoute(input, candidateCount);
  if (!route) return null;
  if (route.kind === "OPERATOR_CANDIDATE") {
    if (typeof deployLatestCandidateOverride !== "function") {
      throw new TypeError("OPERATOR_CANDIDATE_DISPATCH_REQUIRED");
    }
    return { route, value: await deployLatestCandidateOverride(route.index) };
  }
  if (typeof runScreeningCycleOverride !== "function") {
    throw new TypeError("AUTONOMOUS_SCREENING_DISPATCH_REQUIRED");
  }
  return { route, value: await runScreeningCycleOverride({ silent: true }) };
}

// GENERAL is deny-by-default for writes. These read-only sets are the only
// possible broad fallback; every destructive tool is attached to a narrow
// complete-command recognizer below.
const READ_ONLY_INTENT_TOOLS = {
  decisions:   new Set(["get_recent_decisions"]),
  reconcile:   new Set(["reconcile_cleanup", "get_my_positions", "get_wallet_balance"]),
  balance:     new Set(["get_wallet_balance", "get_my_positions", "get_wallet_positions"]),
  positions:   new Set(["get_my_positions", "get_position_pnl", "get_wallet_balance", "get_wallet_positions"]),
  strategy:    new Set(["list_strategies", "get_strategy"]),
  screen:      new Set(["get_top_candidates", "get_token_holders", "get_token_narrative", "get_token_info", "search_pools", "check_smart_wallets_on_pool", "get_pool_detail", "get_my_positions", "discover_pools"]),
  memory:      new Set(["get_pool_memory", "list_blacklist"]),
  smartwallet: new Set(["list_smart_wallets", "check_smart_wallets_on_pool"]),
  study:       new Set(["study_top_lpers", "get_top_lpers", "get_pool_detail", "search_pools", "get_token_info", "discover_pools", "list_smart_wallets"]),
  performance: new Set(["get_performance_history", "get_my_positions", "get_position_pnl"]),
  lessons:     new Set(["list_lessons"]),
};

const READ_ONLY_INTENT_PATTERNS = [
  { intent: "decisions",   re: /\b(why did you|why'd you|why was (?:this|that|it)|what made you|what was the reason|why no deploy|why didn't you deploy|why did you close|why did you deploy|why did you skip)\b/i },
  { intent: "reconcile",   re: /\b(reconcile|cleanup|settlement)\b/i },
  { intent: "balance",     re: /\b(balance|wallet|sol|how much|saldo|dompet|billetera|cartera)\b|(?:残高|ウォレット)/iu },
  { intent: "positions",   re: /\b(position|positions|portfolio|pnl|yield|range|posisi|posiciones)\b|(?:ポジション|保有)/iu },
  { intent: "strategy",    re: /\b(strategy|strategies)\b/i },
  { intent: "screen",      re: /\b(screen|candidate|find pool|search|research|token)\b/i },
  { intent: "memory",      re: /\b(memory|pool history|note|remember)\b/i },
  { intent: "smartwallet", re: /\b(smart wallet|kol|whale|watch.?list|list wallet|tracked wallet|check pool|who.?s in|wallets in)\b/i },
  { intent: "study",       re: /\b(study top|top lpers?|best lpers?|who.?s lping|lp behavior|lpers?)\b/i },
  { intent: "performance", re: /\b(performance|history|how.?s the bot|how.?s it doing|stats|report)\b/i },
  { intent: "lessons",     re: /\b(lesson|learned|teach|what did you learn)\b/i },
];

// A whole request can authorize at most one write tool.  These command
// recognizers intentionally return a tool identifier rather than a broad
// family, so "add smart wallet" can never expose remove_smart_wallet (and
// likewise for every other sibling write operation).
const CANONICAL_WRITE_AUTHORITIES = [
  { tool: "deploy_position", readTools: ["get_top_candidates", "get_active_bin", "get_pool_memory", "check_smart_wallets_on_pool", "get_token_holders", "get_token_narrative", "get_token_info", "search_pools", "get_wallet_balance", "get_my_positions"], re: /^(?:please )?(?:deploy(?: [a-z0-9_:/(),.$#=-]+)*|open (?:a |the )?(?:new )?position(?: [a-z0-9_:/(),.$#=-]+)*|add liquidity(?: [a-z0-9_:/(),.$#=-]+)*|lp into(?: [a-z0-9_:/(),.$#=-]+)*|invest in(?: [a-z0-9_:/(),.$#=-]+)*)[.!]?$/i },
  { tool: "close_position", readTools: ["reconcile_cleanup", "get_my_positions", "get_position_pnl", "get_wallet_balance"], re: /^(?:please )?(?:close|exit|withdraw|remove liquidity|shut down)(?: [a-z0-9_:/(),.$#=-]+)*[.!]?$/i },
  { tool: "claim_fees", readTools: ["get_my_positions", "get_position_pnl", "get_wallet_balance"], re: /^(?:please )?(?:claim|harvest|collect) fees(?: [a-z0-9_:/(),.$#=-]+)*[.!]?$/i },
  { tool: "self_update", readTools: [], re: /^(?:please )?(?:self[ -]?update|git pull|pull latest|update (?:the )?(?:bot|agent)|update yourself)[.!]?$/i },
  { tool: "update_config", readTools: [], re: /^(?:please )?(?:update|set|change) (?:the )?(?:config(?:uration)?|settings?|thresholds?)(?: [a-z0-9_:/(),.$#=-]+)*[.!]?$/i },
  { tool: "add_to_blacklist", readTools: ["list_blacklist"], re: /^(?:please )?add(?: [a-z0-9_:/(),.$#=-]+){0,4} to (?:the )?blacklist[.!]?$/i },
  { tool: "remove_from_blacklist", readTools: ["list_blacklist"], re: /^(?:please )?remove(?: [a-z0-9_:/(),.$#=-]+){0,4} from (?:the )?blacklist[.!]?$/i },
  { tool: "block_deployer", readTools: ["list_blocked_deployers"], re: /^(?:please )?block (?:a )?(?:deployer|developer|dev)(?: [a-z0-9_:/(),.$#=-]+)*[.!]?$/i },
  { tool: "unblock_deployer", readTools: ["list_blocked_deployers"], re: /^(?:please )?unblock (?:a )?(?:deployer|developer|dev)(?: [a-z0-9_:/(),.$#=-]+)*[.!]?$/i },
  { tool: "add_pool_note", readTools: ["get_pool_memory"], re: /^(?:please )?add (?:a )?(?:pool )?note(?: [a-z0-9_:/(),.$#=-]+)*[.!]?$/i },
  { tool: "set_position_note", readTools: ["get_my_positions"], re: /^(?:please )?set (?:a )?position note(?: [a-z0-9_:/(),.$#=-]+)*[.!]?$/i },
  { tool: "add_smart_wallet", readTools: ["list_smart_wallets"], re: /^(?:please )?add (?:a )?(?:smart )?wallet(?: [a-z0-9_:/(),.$#=-]+)*[.!]?$/i },
  { tool: "remove_smart_wallet", readTools: ["list_smart_wallets"], re: /^(?:please )?remove (?:a )?(?:smart )?wallet(?: [a-z0-9_:/(),.$#=-]+)*[.!]?$/i },
  { tool: "add_lesson", readTools: ["list_lessons"], re: /^(?:please )?add (?:a )?lesson(?: [a-z0-9_:/(),.$#=-]+)*[.!]?$/i },
  { tool: "pin_lesson", readTools: ["list_lessons"], re: /^(?:please )?pin (?:a )?lesson(?: [a-z0-9_:/(),.$#=-]+)*[.!]?$/i },
  { tool: "unpin_lesson", readTools: ["list_lessons"], re: /^(?:please )?unpin (?:a )?lesson(?: [a-z0-9_:/(),.$#=-]+)*[.!]?$/i },
  { tool: "clear_lessons", readTools: ["list_lessons"], re: /^(?:please )?clear (?:(?:all|the|my) )?lessons?[.!]?$/i },
  { tool: "add_strategy", readTools: ["list_strategies", "get_strategy"], re: /^(?:please )?add (?:a )?strategy(?: [a-z0-9_:/(),.$#=-]+)*[.!]?$/i },
  { tool: "remove_strategy", readTools: ["list_strategies", "get_strategy"], re: /^(?:please )?remove (?:a )?strategy(?: [a-z0-9_:/(),.$#=-]+)*[.!]?$/i },
  { tool: "set_active_strategy", readTools: ["list_strategies", "get_strategy"], re: /^(?:please )?set (?:the )?active strategy(?: [a-z0-9_:/(),.$#=-]+)*[.!]?$/i },
];
// Match complete write-action phrases, including tool identifiers and the
// multiword close synonym. These are used only to reject a compound command;
// the canonical whole-command grammar below still decides which one action
// may receive authority.
const WRITE_ACTION_MENTION_PATTERNS = [
  { intent: "deploy", re: /\bdeploy(?:_position)?\b/gi },
  { intent: "deploy", re: /\bopen\s+(?:a\s+|the\s+)?(?:new\s+)?position\b/gi },
  { intent: "deploy", re: /\badd\s+liquidity\b/gi },
  { intent: "deploy", re: /\blp\s+into\b/gi },
  { intent: "deploy", re: /\binvest\s+in\b/gi },
  { intent: "close", re: /\bclose(?:_position)?\b/gi },
  { intent: "close", re: /\bexit\b/gi },
  { intent: "close", re: /\bwithdraw\b/gi },
  { intent: "close", re: /\bremove\s+liquidity\b/gi },
  { intent: "close", re: /\bshut\s+down\b/gi },
  { intent: "claim", re: /\b(?:claim(?:_fees)?|harvest|collect)\b/gi },
  { intent: "swap", re: /\b(?:swap(?:_token)?|convert|sell|exchange)\b/gi },
  { intent: "selfupdate", re: /\b(?:self[ _-]?update|git\s+pull|pull\s+latest|update\s+(?:the\s+)?(?:bot|agent)|update\s+yourself)\b/gi },
  { intent: "config", re: /\b(?:update_config|(?:update|set|change)\s+(?:(?:the|this|my)\s+)?(?:config(?:uration)?|settings?|thresholds?))\b/gi },
  { intent: "blocklist", re: /\b(?:add_to_blacklist|remove_from_blacklist|block_deployer|unblock_deployer|add(?:\s+[a-z0-9_-]+){0,4}\s+to\s+(?:the\s+)?blacklist|remove(?:\s+[a-z0-9_-]+){0,4}\s+from\s+(?:the\s+)?blacklist|block\s+(?:(?:a|the|this)\s+)?(?:deployer|developer|dev)|unblock\s+(?:(?:a|the|this)\s+)?(?:deployer|developer|dev))\b/gi },
  { intent: "poolnote", re: /\b(?:add_pool_note|set_position_note|add\s+(?:(?:a|the|this|my)\s+)?(?:pool\s+)?note|set\s+(?:(?:a|the|this|my)\s+)?position\s+note)\b/gi },
  { intent: "smartwallet", re: /\b(?:add_smart_wallet|remove_smart_wallet|(?:add|remove)\s+(?:(?:a|an|the|this|that|my)\s+)?(?:smart\s+)?wallet)\b/gi },
  { intent: "lessons", re: /\b(?:add_lesson|pin_lesson|unpin_lesson|clear_lessons?|add\s+(?:(?:a|the|this|my)\s+)?lesson|pin\s+(?:(?:a|the|this|my)\s+)?lesson|unpin\s+(?:(?:a|the|this|my)\s+)?lesson|clear\s+(?:(?:all|the|my)\s+)?lessons?)\b/gi },
  { intent: "strategy", re: /\b(?:add_strategy|remove_strategy|set_active_strategy|add\s+(?:(?:a|the|this|my)\s+)?strategy|remove\s+(?:(?:a|the|this|my)\s+)?strategy|set\s+(?:(?:the|this|my)\s+)?active\s+strategy)\b/gi },
];
const FOLLOW_UP_WRITE_ACTION_RE = /(?:[;,!.?]\s*|\s+\b(?:and|then|afterwards|finally|next)\s+)(?:please\s+)?(?:deploy|open|add|close|exit|withdraw|remove|shut\s+down|claim|harvest|collect|swap|convert|sell|exchange|self[ _-]?update|update|set|change|block|unblock|pin|unpin|clear|pull)\b/gi;

function writeActionMentions(text = "") {
  const source = String(text ?? "");
  const mentions = [];
  for (const { intent, re } of WRITE_ACTION_MENTION_PATTERNS) {
    for (const match of source.matchAll(re)) {
      mentions.push({ intent, index: match.index, length: match[0].length });
    }
  }
  // A follow-up may use a pronoun ("then remove it") and therefore omit the
  // noun that identifies its write family. After an explicit compound boundary
  // it is still a second write intent and must not fall through to the first
  // command's permissive trailing-argument grammar.
  for (const match of source.matchAll(FOLLOW_UP_WRITE_ACTION_RE)) {
    mentions.push({ intent: "followup", index: match.index, length: match[0].length });
  }
  // The patterns are intentionally mostly disjoint. Keep this overlap guard
  // so a future synonym cannot turn one phrase into two write actions.
  mentions.sort((left, right) => left.index - right.index || right.length - left.length);
  const nonOverlapping = [];
  for (const mention of mentions) {
    const overlaps = nonOverlapping.some((existing) => (
      mention.index < existing.index + existing.length &&
      existing.index < mention.index + mention.length
    ));
    if (!overlaps) nonOverlapping.push(mention);
  }
  return nonOverlapping;
}

function canonicalSwapAsset(asset) {
  if (asset === "SOL" || asset === "USDC" || asset === "USDT") {
    const knownMint = config.tokens?.[asset];
    return typeof knownMint === "string" && BASE58_MINT_RE.test(knownMint) ? knownMint : null;
  }
  return typeof asset === "string" && BASE58_MINT_RE.test(asset) ? asset : null;
}

// NFKD handles compatibility characters (fullwidth/math alphabets), and mark
// removal catches combining and variation marks. The small mapping preserves
// the previously supported Greek/Cyrillic lookalikes; it is defense in depth,
// not the only recognition mechanism. Dropping every remaining non-ASCII
// character makes controls, separators, punctuation splits, and compounds
// visible to the action-keyword detector without ever granting authority.
const SWAP_SKELETON_CONFUSABLES = new Map([
  ["0", "o"], ["1", ""], ["3", "e"], ["4", "a"], ["5", "s"], ["7", "t"],
  ["\u0405", "s"], ["\u0455", "s"], ["\uA731", "s"],
  ["\u051C", "w"], ["\u051D", "w"],
  ["\u0391", "a"], ["\u03B1", "a"], ["\u0410", "a"], ["\u0430", "a"],
  ["\u0392", "b"], ["\u03B2", "b"], ["\u0412", "b"], ["\u0432", "b"],
  ["\u03BF", "o"], ["\u041E", "o"], ["\u043E", "o"],
  ["\u03F2", "c"], ["\u0421", "c"], ["\u0441", "c"],
  ["\u0395", "e"], ["\u03B5", "e"], ["\u0415", "e"], ["\u0435", "e"],
  ["\u0397", "h"], ["\u03B7", "h"], ["\u041D", "h"], ["\u043D", "h"],
  ["\u0399", "i"], ["\u03B9", "i"], ["\u0406", "i"], ["\u0456", "i"],
  ["\u039A", "k"], ["\u03BA", "k"], ["\u041A", "k"], ["\u043A", "k"],
  ["\u039C", "m"], ["\u03BC", "m"], ["\u041C", "m"], ["\u043C", "m"],
  ["\u03A1", "p"], ["\u03C1", "p"], ["\u0420", "p"], ["\u0440", "p"],
  ["\u03A4", "t"], ["\u03C4", "t"], ["\u0422", "t"], ["\u0442", "t"],
  ["\u03A5", "y"], ["\u03C5", "y"], ["\u0423", "y"], ["\u0443", "y"],
  ["\u03A7", "x"], ["\u03C7", "x"], ["\u0425", "x"], ["\u0445", "x"],
]);

function swapIntentSkeleton(goal = "") {
  const compatibilityNormalized = String(goal ?? "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "");
  return Array.from(compatibilityNormalized, (character) => (
    SWAP_SKELETON_CONFUSABLES.has(character)
      ? SWAP_SKELETON_CONFUSABLES.get(character)
      : character
  ))
    .join("")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function hasSwapShapedMention(goal = "") {
  // Intentionally no word boundary: `preswap`, `swapping`, and other joined
  // compounds cannot fall through to a nearby destructive intent.
  return /(?:swap|convert|sell|exchange)/.test(swapIntentSkeleton(goal));
}

function canonicalActionAuthority(goal = "") {
  const text = String(goal ?? "");
  // Canonical action commands have printable ASCII only. This rejects tabs,
  // line/paragraph separators, bidi and zero-width controls, marks, and every
  // Unicode compatibility form before matching intent.
  if (!/^[\x20-\x7E]+$/.test(text)) return null;
  const command = text.trim();
  if (!command) return null;

  // A recognized command may contain exactly one complete write-action
  // phrase. This catches multiword synonyms such as "shut down" as well as
  // tool names, punctuation-led compounds, and the state-changing utility
  // actions that share generic verbs such as add, set, or update.
  if (writeActionMentions(command).length !== 1) return null;
  return CANONICAL_WRITE_AUTHORITIES.find(({ re }) => re.test(command)) || null;
}

function canonicalizePlainDecimal(amountText) {
  const [wholeText, fractionalText = ""] = amountText.split(".");
  const whole = wholeText.replace(/^0+(?=\d)/, "");
  const fractional = fractionalText.replace(/0+$/, "");
  return fractional ? `${whole}.${fractional}` : whole;
}

function sourceDecimalsForDirectSwap(inputMint) {
  if (inputMint === config.tokens?.SOL) return 9;
  if (inputMint === config.tokens?.USDC || inputMint === config.tokens?.USDT) return 6;
  return null;
}

function rawAmountFromDecimalText(amountText, decimals) {
  const [wholeText, fractionalText = ""] = amountText.split(".");
  // Exact source-unit authority: no excess decimal places, even if they are
  // zero. The raw token amount is constrained to Solana's u64 token amount.
  if (fractionalText.length > decimals) return null;
  const rawText = `${wholeText}${fractionalText.padEnd(decimals, "0")}`.replace(/^0+/, "") || "0";
  const rawAmount = BigInt(rawText);
  if (rawAmount <= 0n || rawAmount > MAX_TOKEN_RAW_AMOUNT) return null;
  return rawAmount.toString();
}

function canonicalDecimalFromNumber(amount) {
  const numberText = amount.toString();
  if (!/[eE]/.test(numberText)) return canonicalizePlainDecimal(numberText);

  const [coefficient, exponentText] = numberText.toLowerCase().split("e");
  const exponent = Number(exponentText);
  const [whole, fractional = ""] = coefficient.split(".");
  const digits = `${whole}${fractional}`;
  const decimalIndex = whole.length + exponent;
  const expanded = decimalIndex <= 0
    ? `0.${"0".repeat(-decimalIndex)}${digits}`
    : decimalIndex >= digits.length
      ? `${digits}${"0".repeat(decimalIndex - digits.length)}`
      : `${digits.slice(0, decimalIndex)}.${digits.slice(decimalIndex)}`;
  return canonicalizePlainDecimal(expanded);
}

/**
 * The provider schema still uses a Number, but the executor never uses that
 * Number for unit conversion. Bind a positive, exact raw token amount from
 * the original user text first and reject a value the schema cannot echo.
 */
function parseExactSwapAmount(amountText, sourceDecimals) {
  const amount_raw = rawAmountFromDecimalText(amountText, sourceDecimals);
  if (!amount_raw) return null;
  const canonicalText = canonicalizePlainDecimal(amountText);
  const amount = Number(canonicalText);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  if (canonicalDecimalFromNumber(amount) !== canonicalText) return null;
  if (!canonicalText.includes(".") && !Number.isSafeInteger(amount)) return null;
  return { amount, amount_raw };
}

/**
 * Parse exactly one affirmative direct swap into the executor's canonical
 * schema. User symbols are mapped only through the fixed configured mint map;
 * arbitrary symbols never give the provider a choice of mint.
 */
export function parseDirectSwapIntent(goal = "") {
  const text = String(goal ?? "");
  const match = DIRECT_SWAP_COMMAND_RE.exec(text);
  if (!match) return null;

  const [, amountText, inputAsset, outputAsset] = match;
  const input_mint = canonicalSwapAsset(inputAsset);
  const output_mint = canonicalSwapAsset(outputAsset);
  // Direct swaps fail closed for arbitrary source mints because their decimals
  // are not locally authoritative. Arbitrary exact base58 output mints remain
  // allowed when the source is SOL, USDC, or USDT.
  const sourceDecimals = sourceDecimalsForDirectSwap(input_mint);
  const parsedAmount = sourceDecimals === null ? null : parseExactSwapAmount(amountText, sourceDecimals);
  if (!parsedAmount || !input_mint || !output_mint || input_mint === output_mint) return null;

  return Object.freeze({ input_mint, output_mint, ...parsedAmount });
}

/**
 * Restrict direct swaps to a complete, affirmative, unambiguous user command.
 */
export function hasPositiveDirectSwapIntent(goal = "") {
  return parseDirectSwapIntent(goal) !== null;
}

export function activeToolNamesFor(toolsForRequest = []) {
  return new Set((Array.isArray(toolsForRequest) ? toolsForRequest : [])
    .map((tool) => tool?.function?.name)
    .filter((name) => typeof name === "string" && name));
}

function roleToolCeiling(agentType) {
  return typeof agentType === "string" && Object.hasOwn(ROLE_TOOL_CEILINGS, agentType)
    ? ROLE_TOOL_CEILINGS[agentType]
    : SAFE_READ_ONLY_FALLBACK_CEILING;
}

export function resolveAgentLoopRole(agentType, roleArgumentProvided) {
  if (!roleArgumentProvided) return "GENERAL";
  return typeof agentType === "string" && Object.hasOwn(ROLE_TOOL_CEILINGS, agentType)
    ? agentType
    : "READ_ONLY";
}

export function authorizeModelToolDispatch(functionName, activeToolNames, directSwapIntent = null, agentType, authorizedWriteTool = null) {
  // Tool names are identifiers, not free-form provider text: no trimming or
  // suffix normalization may turn an unadvertised name into an allowed one.
  const name = typeof functionName === "string" ? functionName : "";
  if (!name || !KNOWN_TOOL_NAMES.has(name)) {
    return { allowed: false, name, reason: "UNKNOWN_TOOL" };
  }
  if (!roleToolCeiling(agentType).has(name)) {
    return { allowed: false, name, reason: "ROLE_CEILING_DENIED" };
  }
  if (!activeToolNames?.has(name)) {
    return { allowed: false, name, reason: "TOOL_NOT_ACTIVE_FOR_REQUEST" };
  }
  if (name === "swap_token" && !directSwapIntent) {
    return { allowed: false, name, reason: "DIRECT_SWAP_INTENT_REQUIRED" };
  }
  // The advertised set is necessary but not sufficient. A dispatch carries
  // the exact write identity selected from the original request, so a forged
  // sibling remains blocked even if a future caller accidentally supplies a
  // wider active set.
  const expectedWriteTool = directSwapIntent ? "swap_token" : authorizedWriteTool;
  if (WRITE_LIKE_TOOL_NAMES.has(name) && name !== expectedWriteTool) {
    return { allowed: false, name, reason: "TOOL_NOT_ACTIVE_FOR_REQUEST" };
  }
  return { allowed: true, name, reason: null };
}

/**
 * Accept only schema-shaped swap arguments that exactly represent the
 * canonical intent derived from the original user goal. The returned object is
 * the only swap argument object that may reach the executor.
 */
export function bindDirectSwapToolArgs(directSwapIntent, args = {}) {
  if (!directSwapIntent) return { allowed: false, args: null, reason: "DIRECT_SWAP_INTENT_REQUIRED" };
  if (
    !args ||
    typeof args !== "object" ||
    Array.isArray(args) ||
    Object.keys(args).length !== SWAP_TOKEN_ARGUMENT_KEYS.size ||
    Object.keys(args).some((key) => !SWAP_TOKEN_ARGUMENT_KEYS.has(key)) ||
    typeof args.input_mint !== "string" ||
    typeof args.output_mint !== "string" ||
    typeof args.amount !== "number" ||
    !Number.isFinite(args.amount) ||
    args.amount <= 0 ||
    args.input_mint !== directSwapIntent.input_mint ||
    args.output_mint !== directSwapIntent.output_mint ||
    args.amount !== directSwapIntent.amount
  ) {
    return { allowed: false, args: null, reason: "SWAP_INTENT_ARGUMENT_MISMATCH" };
  }

  return {
    allowed: true,
    args: {
      input_mint: directSwapIntent.input_mint,
      output_mint: directSwapIntent.output_mint,
      amount: directSwapIntent.amount,
      // This is derived only from the original user decimal text after source
      // decimal validation. It is intentionally absent from the model schema.
      amount_raw: directSwapIntent.amount_raw,
    },
    reason: null,
  };
}

function readOnlyToolNamesForRole(agentType) {
  return new Set([...roleToolCeiling(agentType)].filter((name) => READ_ONLY_TOOL_NAMES.has(name)));
}

function toolDefinitionsForNames(names, roleCeiling) {
  return tools.filter((tool) => {
    const name = tool?.function?.name;
    return names.has(name) && roleCeiling.has(name);
  });
}

function resolveRequestToolAuthority(agentType, goal = "", directSwapIntent = parseDirectSwapIntent(goal)) {
  const roleCeiling = roleToolCeiling(agentType);
  // A direct command exposes only its one authorized mutating tool. Any other
  // swap-bearing input is fail-closed as a whole: it cannot use a nearby
  // close/claim intent to turn a rejected compound command into another action.
  if (directSwapIntent) {
    return {
      tools: toolDefinitionsForNames(new Set(["swap_token"]), roleCeiling),
      writeTool: roleCeiling.has("swap_token") ? "swap_token" : null,
    };
  }
  if (hasSwapShapedMention(goal)) return { tools: [], writeTool: null };

  const actionAuthority = canonicalActionAuthority(goal);
  if (actionAuthority) {
    // SCREENER never exposes deploy_position to a provider. Autonomous
    // screening dispatches through index.js's local bound-request boundary;
    // candidate/report text and user-shaped commands cannot activate it.
    const writeAllowed = roleCeiling.has(actionAuthority.tool) && !(
      agentType === "SCREENER" && actionAuthority.tool === "deploy_position"
    );
    const allowedNames = new Set(actionAuthority.readTools);
    if (writeAllowed) allowedNames.add(actionAuthority.tool);
    return {
      tools: toolDefinitionsForNames(allowedNames, roleCeiling),
      writeTool: writeAllowed ? actionAuthority.tool : null,
    };
  }

  // Every role combines only read-only intent sets unless the whole request
  // passed a canonical action recognizer above. An unknown or ambiguous
  // request may be served by read tools, but it can never obtain write power.
  const allowedReadTools = readOnlyToolNamesForRole(agentType);
  const matched = new Set();
  for (const { intent, re } of READ_ONLY_INTENT_PATTERNS) {
    if (re.test(goal)) {
      for (const t of READ_ONLY_INTENT_TOOLS[intent]) {
        if (allowedReadTools.has(t)) matched.add(t);
      }
    }
  }

  return {
    tools: matched.size === 0
      ? toolDefinitionsForNames(allowedReadTools, roleCeiling)
      : toolDefinitionsForNames(matched, roleCeiling),
    writeTool: null,
  };
}

export function getToolsForRole(agentType, goal = "", directSwapIntent = parseDirectSwapIntent(goal)) {
  return resolveRequestToolAuthority(agentType, goal, directSwapIntent).tools;
}

// Cleanup remains preview-only to the model, and close arguments outside the
// model schema are stripped before dispatch.
export function normalizeModelToolArgs(functionName, args = {}) {
  if (functionName === "reconcile_cleanup") return { position: args?.position };
  if (functionName === "close_position") {
    return { position_address: args?.position_address, reason: args?.reason };
  }
  return args;
}
import { getWalletBalances } from "./tools/wallet.js";
import { getMyPositions } from "./tools/dlmm.js";
import { log } from "./logger.js";
import { config } from "./config.js";
import { getStateSummary } from "./state.js";
import { getLessonsForPrompt } from "./lessons.js";
import { getSettlementPerformanceSummary } from "./settlement-report.js";
import { getDecisionSummary } from "./decision-log.js";

// Supports OpenRouter (default) or any OpenAI-compatible local server (e.g. LM Studio)
// To use LM Studio: set LLM_BASE_URL=http://localhost:1234/v1 and LLM_API_KEY=lm-studio in .env
const client = new OpenAI({
  baseURL: process.env.LLM_BASE_URL || "https://openrouter.ai/api/v1",
  apiKey: process.env.LLM_API_KEY || process.env.OPENROUTER_API_KEY,
  timeout: 5 * 60 * 1000,
});
const INTERACTIVE_PROVIDER_TIMEOUT_MS = (() => {
  const configured = Number(process.env.INTERACTIVE_LLM_TIMEOUT_MS);
  return Number.isFinite(configured) && configured >= 5_000 && configured <= 120_000
    ? Math.round(configured)
    : 45_000;
})();

const DEFAULT_MODEL = process.env.LLM_MODEL || "openrouter/healer-alpha";

const MUTATING_TOOL_INTENTS = /\b(deploy|open position|add liquidity|lp into|invest in|close|exit|withdraw|remove liquidity|claim|harvest|collect|swap|convert|sell|exchange|reconcile|cleanup|settlement|block|unblock|blacklist|add smart wallet|remove smart wallet|add wallet|remove wallet|pin|unpin|clear lesson|add lesson|set active strategy|remove strategy|add strategy|set |change |update |self.?update|pull latest|git pull|update yourself)\b/i;
const LIVE_DATA_TOOL_INTENTS = /\b(balance|wallet|position|portfolio|pnl|yield|range|show positions|open positions|screen|candidate|find pool|search|research|analyze|check pool|token holders|narrative|study top|top lpers?|lp behavior|who.?s lping|performance|history|stats|report|list smart wallets|list blacklist|list blocked deployers|list lessons)\b/i;
const CONFIG_READ_ONLY_INTENTS = /\b(check|show|what(?:'s| is)?|review|inspect|see)\b.*\b(config|settings?|thresholds?)\b/i;
const DECISION_EXPLANATION_INTENTS = /\b(why did you|why'd you|why was (?:this|that|it)|what made you|what was the reason|why no deploy|why didn't you deploy|why did you close|why did you deploy|why did you skip)\b/i;

function shouldRequireRealToolUse(goal, agentType, interactive = false) {
  if (agentType === "MANAGER") return false;
  if (DECISION_EXPLANATION_INTENTS.test(goal)) return false;
  if (CONFIG_READ_ONLY_INTENTS.test(goal)) return false;
  if (MUTATING_TOOL_INTENTS.test(goal)) return true;
  return interactive && LIVE_DATA_TOOL_INTENTS.test(goal);
}

export function isAllowedNoToolFinal(content, allowNoToolFinal = false) {
  return allowNoToolFinal === true && /⛔\s*NO DEPLOY/i.test(String(content || ""));
}

export function shouldForceInitialToolChoice(goal, mustUseRealTool, allowNoToolFinal = false, step = 0) {
  const actionIntent = /\b(deploy|open|add liquidity|close|exit|withdraw|claim|swap|reconcile|cleanup|block|unblock)\b/i;
  return step === 0 && allowNoToolFinal !== true && (actionIntent.test(goal) || mustUseRealTool);
}

function buildMessages(systemPrompt, sessionHistory, goal, providerMode = "system") {
  if (providerMode === "user_embedded") {
    return [
      ...sessionHistory,
      {
        role: "user",
        content: `[SYSTEM INSTRUCTIONS]\n${systemPrompt}\n\n[USER REQUEST]\n${goal}`,
      },
    ];
  }

  return [
    { role: "system", content: systemPrompt },
    ...sessionHistory,
    { role: "user", content: goal },
  ];
}

function isSystemRoleError(error) {
  const message = String(error?.message || error?.error?.message || error || "");
  return /invalid message role:\s*system/i.test(message);
}

function isToolChoiceRequiredError(error) {
  const message = String(error?.message || error?.error?.message || error || "");
  return /tool_choice/i.test(message) && /required/i.test(message);
}

function isThinkingModeToolChoiceError(error) {
  const message = String(error?.message || error?.error?.message || error || "");
  return /thinking mode does not support/i.test(message) && /tool_choice/i.test(message);
}

/**
 * Core ReAct agent loop.
 *
 * @param {string} goal - The task description for the agent
 * @param {number} maxSteps - Safety limit on iterations (default 20)
 * @returns {string} - The agent's final text response
 */
export async function agentLoop(goal, maxSteps = config.llm.maxSteps, sessionHistory = [], agentType, model = null, maxOutputTokens = null, options = {}) {
  // Keep the historical GENERAL behavior only when the role argument is
  // genuinely omitted. An explicit undefined/null/empty/unknown role is an
  // untrusted capability label and must stay within the read-only ceiling.
  const effectiveAgentType = resolveAgentLoopRole(agentType, arguments.length >= 4);
  const {
    interactive = false,
    onToolStart = null,
    onToolFinish = null,
    allowNoToolFinal = false,
    toolsOverride = null,
    // Test-only seams keep dispatch authorization verifiable without a live
    // provider, wallet lookup, or executor invocation.
    clientOverride = client,
    executeToolOverride = executeTool,
    promptContext = null,
  } = options;
  // Build dynamic system prompt with current portfolio state. Tests can inject
  // an inert prompt context so no RPC-like read is needed to exercise dispatch.
  let portfolio;
  let positions;
  let stateSummary;
  let lessons;
  let perfSummary;
  let weightsSummary;
  let decisionSummary;
  if (promptContext) {
    ({ portfolio = {}, positions = [], stateSummary = null, lessons = null, perfSummary = null, weightsSummary = null, decisionSummary = null } = promptContext);
  } else {
    [portfolio, positions] = await Promise.all([getWalletBalances(), getMyPositions()]);
    stateSummary = getStateSummary();
    lessons = getLessonsForPrompt({ agentType: effectiveAgentType });
    try {
      const settlementSummary = getSettlementPerformanceSummary();
      perfSummary = {
        source: settlementSummary.source,
        authoritative: settlementSummary.authoritative,
        unit: settlementSummary.unit,
        total_positions_settled: settlementSummary.total_positions_settled,
        total_pnl_sol: settlementSummary.total_pnl_sol,
        total_pnl_pct: settlementSummary.total_pnl_pct,
        win_rate_pct: settlementSummary.win_rate_pct,
        settlement_pending_count: settlementSummary.settlement_pending_count,
        excluded_non_cash_count: settlementSummary.excluded_non_cash_count,
      };
    } catch (error) {
      perfSummary = {
        source: "trade_ledger_wallet_equity_net",
        authoritative: false,
        unavailable: true,
        error: error.message,
      };
    }
    decisionSummary = getDecisionSummary();
    weightsSummary = null;
    if (effectiveAgentType === "SCREENER") {
      try {
        const { getWeightsSummary } = await import("./signal-weights.js");
        const { config } = await import("./config.js");
        if (config.darwin?.enabled) weightsSummary = getWeightsSummary();
      } catch { /* signal-weights not critical */ }
    }
  }
  const systemPrompt = buildSystemPrompt(effectiveAgentType, portfolio, positions, stateSummary, lessons, perfSummary, weightsSummary, decisionSummary);

  let providerMode = "system";
  let messages = buildMessages(systemPrompt, sessionHistory, goal, providerMode);

  // Track write tools fired this session — prevent the model from calling the same
  // destructive tool twice in one session
  // Models may repeat a tool call within one response or after a failed tool
  // result. State-changing tools therefore reserve their name before callback
  // or executor entry. Read-only tools remain freely repeatable.
  const ONCE_PER_SESSION = new Set(WRITE_LIKE_TOOL_NAMES);
  const NO_RETRY_TOOLS = new Set(WRITE_LIKE_TOOL_NAMES);
  // These two operations must report a bounded failure back to the provider so
  // the pre-reserved no-retry guard can reject a follow-up call in the same
  // session. Other executor exceptions retain their existing propagation.
  const PROVIDER_VISIBLE_FAILURE_TOOLS = new Set(["swap_token", "update_config"]);
  const firedOnce = new Set();
  const inFlightOnce = new Set();
  const directSwapIntent = parseDirectSwapIntent(goal);
  const requestToolAuthority = resolveRequestToolAuthority(
    effectiveAgentType,
    goal,
    directSwapIntent,
  );
  const policyTools = requestToolAuthority.tools;
  const authorizedWriteTool = requestToolAuthority.writeTool;
  const overrideToolNames = activeToolNamesFor(toolsOverride);
  // An override is a narrowing test seam only. Always advertise the canonical
  // policy definitions, never provider/test-supplied definitions, and never
  // let an override widen a rejected or direct-swap request.
  const activeTools = Array.isArray(toolsOverride)
    ? policyTools.filter((tool) => overrideToolNames.has(tool?.function?.name))
    : policyTools;
  const activeToolNames = activeToolNamesFor(activeTools);
  const mustUseRealTool = activeTools.length > 0 && shouldRequireRealToolUse(goal, effectiveAgentType, interactive);
  let sawToolCall = false;
  let noToolRetryCount = 0;
  // Stays true for the whole run once a thinking-mode provider rejects tool_choice
  let omitToolChoice = false;

  let emptyStreak = 0;
  for (let step = 0; step < maxSteps; step++) {
    log("agent", `Step ${step + 1}/${maxSteps}`);

    try {
      const activeModel = model || DEFAULT_MODEL;

      // Retry up to 3 times on transient provider errors (502, 503, 529)
      const FALLBACK_MODEL = "stepfun/step-3.5-flash:free";
      let response;
      let usedModel = activeModel;
      // Force a tool call on step 0 for action intents — prevents the model from inventing deploy/close outcomes
      let toolChoice = shouldForceInitialToolChoice(goal, mustUseRealTool, allowNoToolFinal, step)
        ? "required"
        : "auto";

      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const reqParams = {
            model: usedModel,
            messages,
            temperature: config.llm.temperature,
            max_tokens: maxOutputTokens ?? config.llm.maxTokens,
          };
          if (activeTools.length > 0) reqParams.tools = activeTools;
          if (activeTools.length > 0 && !omitToolChoice) reqParams.tool_choice = toolChoice;
          // Telegram conversations need a bounded provider wait so a stalled
          // model cannot leave the live status/typing indicator active for
          // several minutes. This bounds only the provider request; tool and
          // transaction execution retain their own durable safety boundaries.
          const requestOptions = interactive
            ? { timeout: INTERACTIVE_PROVIDER_TIMEOUT_MS, maxRetries: 0 }
            : undefined;
          response = await clientOverride.chat.completions.create(reqParams, requestOptions);
        } catch (error) {
          if (providerMode === "system" && isSystemRoleError(error)) {
            providerMode = "user_embedded";
            messages = buildMessages(systemPrompt, sessionHistory, goal, providerMode);
            log("agent", "Provider rejected system role — retrying with embedded system instructions");
            attempt -= 1;
            continue;
          }
          if (toolChoice === "required" && isToolChoiceRequiredError(error)) {
            toolChoice = "auto";
            log("agent", "Provider rejected tool_choice=required — retrying with tool_choice=auto");
            attempt -= 1;
            continue;
          }
          if (!omitToolChoice && isThinkingModeToolChoiceError(error)) {
            omitToolChoice = true;
            log("agent", "Provider thinking mode does not support tool_choice — retrying without it");
            attempt -= 1;
            continue;
          }
          throw error;
        }
        if (response.choices?.length) break;
        const errCode = response.error?.code;
        if (errCode === 502 || errCode === 503 || errCode === 529) {
          const wait = (attempt + 1) * 5000;
          if (attempt === 1 && usedModel !== FALLBACK_MODEL) {
            usedModel = FALLBACK_MODEL;
            log("agent", `Switching to fallback model ${FALLBACK_MODEL}`);
          } else {
            log("agent", `Provider error ${errCode}, retrying in ${wait / 1000}s (attempt ${attempt + 1}/3)`);
            await new Promise((r) => setTimeout(r, wait));
          }
        } else {
          break;
        }
      }

      if (!response.choices?.length) {
        log("error", `Bad API response: ${JSON.stringify(response).slice(0, 200)}`);
        throw new Error(`API returned no choices: ${response.error?.message || JSON.stringify(response)}`);
      }
      const msg = response.choices[0].message;
      const invalidToolArgErrors = new Map();
      // Keep tool-call history API-valid, but never execute unrecoverable args.
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          // Do not parse, repair, or otherwise process arguments for a tool
          // that was not advertised for this request. Normalizing its raw
          // history keeps the follow-up completion protocol-valid only.
          if (!authorizeModelToolDispatch(tc?.function?.name, activeToolNames, directSwapIntent, effectiveAgentType, authorizedWriteTool).allowed) {
            if (tc?.function) tc.function.arguments = "{}";
            continue;
          }
          if (tc.function?.arguments) {
            try {
              JSON.parse(tc.function.arguments);
            } catch {
              try {
                tc.function.arguments = JSON.stringify(JSON.parse(jsonrepair(tc.function.arguments)));
                log("warn", `Repaired malformed JSON args for ${tc.function.name}`);
              } catch {
                tc.function.arguments = "{}";
                const error = `Invalid tool arguments for ${tc.function.name}`;
                invalidToolArgErrors.set(tc.id, error);
                log("error", `${error}: could not repair JSON`);
              }
            }
          }
        }
      }
      messages.push(msg);

      // If the model didn't call any tools, it's done
      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        // Hermes sometimes returns null content — pop the empty message and retry once
        if (!msg.content) {
          messages.pop(); // remove the empty assistant message
          log("agent", "Empty response, retrying...");
          continue;
        }
        if (mustUseRealTool && !sawToolCall && !isAllowedNoToolFinal(msg.content, allowNoToolFinal)) {
          noToolRetryCount += 1;
          messages.pop();
          log("agent", `Rejected no-tool final answer (${noToolRetryCount}/2) for tool-required request`);
          if (noToolRetryCount >= 2) {
            return {
              content: "I couldn't complete that reliably because no tool call was made. Please retry after checking the logs.",
              userMessage: goal,
            };
          }
          messages.push({
            role: providerMode === "system" ? "system" : "user",
            content: providerMode === "system"
              ? "You have not used any tool yet. This request requires real tool execution or live tool-backed data. Do not answer from memory or inference. Call the appropriate tool first, then report only the real result."
              : "[SYSTEM REMINDER]\nYou have not used any tool yet. This request requires real tool execution or live tool-backed data. Do not answer from memory or inference. Call the appropriate tool first, then report only the real result.",
          });
          continue;
        }
        log("agent", "Final answer reached");
        log("agent", msg.content);
        return { content: msg.content, userMessage: goal };
      }
      sawToolCall = true;

      // Execute each tool call in parallel
      const toolResults = await Promise.all(msg.tool_calls.map(async (toolCall) => {
        const dispatchAuthorization = authorizeModelToolDispatch(
          toolCall?.function?.name,
          activeToolNames,
          directSwapIntent,
          effectiveAgentType,
          authorizedWriteTool,
        );
        const functionName = dispatchAuthorization.name || "unknown";
        let functionArgs;

        // Providers are untrusted: advertised tools are a hard allowlist at
        // dispatch, not merely a hint sent in the completion request. This
        // runs before arguments, callbacks, or executeTool.
        if (!dispatchAuthorization.allowed) {
          const result = {
            success: false,
            blocked: true,
            reason: dispatchAuthorization.reason,
          };
          log("warn", `Blocked provider tool call ${functionName}: ${result.reason}`);
          return {
            role: "tool",
            tool_call_id: toolCall.id,
            content: JSON.stringify(result),
          };
        }

        if (invalidToolArgErrors.has(toolCall.id)) {
          const result = {
            success: false,
            error: invalidToolArgErrors.get(toolCall.id),
            blocked: true,
          };
          await onToolFinish?.({ name: functionName, args: {}, result, success: false, step, agentType: effectiveAgentType });
          return {
            role: "tool",
            tool_call_id: toolCall.id,
            content: JSON.stringify(result),
          };
        }

        try {
          functionArgs = JSON.parse(toolCall.function.arguments);
        } catch {
          try {
            functionArgs = JSON.parse(jsonrepair(toolCall.function.arguments));
            log("warn", `Repaired malformed JSON args for ${functionName}`);
          } catch (parseError) {
            log("error", `Failed to parse args for ${functionName}: ${parseError.message}`);
            const result = {
              success: false,
              error: `Invalid tool arguments for ${functionName}`,
              blocked: true,
            };
            await onToolFinish?.({ name: functionName, args: {}, result, success: false, step, agentType: effectiveAgentType });
            return {
              role: "tool",
              tool_call_id: toolCall.id,
              content: JSON.stringify(result),
            };
          }
        }

        if (functionName === "swap_token") {
          const swapBinding = bindDirectSwapToolArgs(directSwapIntent, functionArgs);
          if (!swapBinding.allowed) {
            const result = { success: false, blocked: true, reason: swapBinding.reason };
            log("warn", `Blocked provider swap_token call: ${result.reason}`);
            return {
              role: "tool",
              tool_call_id: toolCall.id,
              content: JSON.stringify(result),
            };
          }
          functionArgs = swapBinding.args;
        } else {
          functionArgs = normalizeModelToolArgs(functionName, functionArgs);
        }

        // Block once-per-session tools from firing a second time. In-flight
        // reservation also prevents two parallel provider calls from spending
        // the same user-authorized amount twice in one response.
        if (ONCE_PER_SESSION.has(functionName) && (firedOnce.has(functionName) || inFlightOnce.has(functionName))) {
          log("agent", `Blocked duplicate ${functionName} call — already executed this session`);
          await onToolFinish?.({
            name: functionName,
            args: functionArgs,
            result: { blocked: true, reason: `${functionName} already attempted this session — do not retry. If it failed, report the error and stop.` },
            success: false,
            step,
            agentType: effectiveAgentType,
          });
          return {
            role: "tool",
            tool_call_id: toolCall.id,
            content: JSON.stringify({ blocked: true, reason: `${functionName} already attempted this session — do not retry. If it failed, report the error and stop.` }),
          };
        }

        if (ONCE_PER_SESSION.has(functionName)) {
          inFlightOnce.add(functionName);
          // Reserve all state writes before callbacks or executor entry so a
          // failure, throw, or serial provider retry cannot duplicate them.
          if (NO_RETRY_TOOLS.has(functionName)) firedOnce.add(functionName);
        }
        try {
          await onToolStart?.({ name: functionName, args: functionArgs, step, agentType: effectiveAgentType });
          let result;
          if (PROVIDER_VISIBLE_FAILURE_TOOLS.has(functionName)) {
            try {
              result = await executeToolOverride(functionName, functionArgs);
            } catch {
              // The attempt is already locked. A provider-visible failure lets
              // the loop continue without opening a retry opportunity.
              log("error", `${functionName} execution threw; attempt remains locked`);
              result = { success: false, error: "TOOL_EXECUTION_FAILED" };
            }
          } else {
            // Preserve the prior propagation semantics for every non-swap
            // tool. In particular, a close exception terminates the loop and
            // cannot become a provider-visible retry opportunity.
            result = await executeToolOverride(functionName, functionArgs);
          }
          const executionSuccess = isToolExecutionSuccess(functionName, result);
          await onToolFinish?.({
            name: functionName,
            args: functionArgs,
            result,
            success: executionSuccess,
            step,
            agentType: effectiveAgentType,
          });

          return {
            role: "tool",
            tool_call_id: toolCall.id,
            content: JSON.stringify(result),
          };
        } finally {
          if (ONCE_PER_SESSION.has(functionName)) inFlightOnce.delete(functionName);
        }
      }));

      messages.push(...toolResults);
    } catch (error) {
      log("error", `Agent loop error at step ${step}: ${error.message}`);

      // If it's a rate limit, wait and retry
      if (error.status === 429) {
        log("agent", "Rate limited, waiting 30s...");
        await sleep(30000);
        continue;
      }

      // For other errors, break the loop
      throw error;
    }
  }

  log("agent", "Max steps reached without final answer");
  return { content: "Max steps reached. Review logs for partial progress.", userMessage: goal };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
