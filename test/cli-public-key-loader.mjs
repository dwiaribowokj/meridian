const eventHelper = `
import fs from "node:fs";
const captureFile = process.env.MERIDIAN_CLI_TEST_CAPTURE_FILE;
function event(entry) {
  if (captureFile) fs.appendFileSync(captureFile, JSON.stringify(entry) + "\\n");
}
`;

function protectedModule(source, exports) {
  return `${eventHelper}
event({ kind: "module", source: ${JSON.stringify(source)} });
${exports}`;
}

function dispatchModule(source, exports) {
  return protectedModule(source, `function capture(name, args) {
  event({ kind: "dispatch", source: ${JSON.stringify(source)}, name, args });
  return { captured: true, source: ${JSON.stringify(source)}, name, args };
}
${exports}`);
}

const modules = new Map([
  ["./envcrypt.js", protectedModule("envcrypt", `export function loadEnv() {
  event({ kind: "call", source: "envcrypt", name: "loadEnv" });
  return { encryptedKeys: [] };
}`)],
  ["./config.js", protectedModule("config", `export const config = Object.freeze({});`)],
  ["./tools/executor.js", dispatchModule("executor", `
export async function executeTool(name, args) { return capture(name, args); }`)],
  ["./tools/dlmm.js", dispatchModule("dlmm", `
export async function getActiveBin(args) { return capture("getActiveBin", args); }
export async function getWalletPositions(args) { return capture("getWalletPositions", args); }
export async function getPositionPnl(args) { return capture("getPositionPnl", args); }
export async function getMyPositions(args) { return capture("getMyPositions", args); }
export async function withdrawLiquidity(args) { return capture("withdrawLiquidity", args); }
export async function addLiquidity(args) { return capture("addLiquidity", args); }
export async function searchPools(args) { return capture("searchPools", args); }`)],
  ["./tools/wallet.js", dispatchModule("wallet", `
export async function getWalletBalances(args) { return capture("getWalletBalances", args); }`)],
  ["./tools/token.js", dispatchModule("token", `
export async function getTokenInfo(args) { return capture("getTokenInfo", args); }
export async function getTokenHolders(args) { return capture("getTokenHolders", args); }
export async function getTokenNarrative(args) { return capture("getTokenNarrative", args); }`)],
  ["./tools/screening.js", dispatchModule("screening", `
export async function getPoolDetail(args) { return capture("getPoolDetail", args); }`)],
  ["./tools/study.js", dispatchModule("study", `
export async function studyTopLPers(args) { return capture("studyTopLPers", args); }`)],
  ["./pool-memory.js", dispatchModule("pool-memory", `
export function getPoolMemory(args) { return capture("getPoolMemory", args); }`)],
  ["./token-blacklist.js", dispatchModule("blacklist", `
export function addToBlacklist(args) { return capture("addToBlacklist", args); }
export function listBlacklist(args) { return capture("listBlacklist", args); }`)],
  ["./lessons.js", dispatchModule("lessons", `
export function addLesson(text, tags, options) { return capture("addLesson", { text, tags, options }); }
export function listLessons(args) { return capture("listLessons", args); }`)],
  ["./state.js", `export function getTrackedPosition() { return { pool: process.env.MERIDIAN_CLI_TEST_PUBLIC_KEY }; }`],
]);

export async function resolve(specifier, context, nextResolve) {
  if (modules.has(specifier) && context.parentURL?.startsWith("file:")) {
    return {
      url: `data:text/javascript,${encodeURIComponent(modules.get(specifier))}`,
      shortCircuit: true,
    };
  }
  return nextResolve(specifier, context);
}
