import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-wallet-balance-integrity-"));
process.env.MERIDIAN_USER_CONFIG_FILE = path.join(tmp, "user-config.json");
process.env.MERIDIAN_STATE_FILE = path.join(tmp, "state.json");
process.env.MERIDIAN_LESSONS_FILE = path.join(tmp, "lessons.json");
fs.writeFileSync(process.env.MERIDIAN_USER_CONFIG_FILE, JSON.stringify({
  dryRun: true,
  rolloutMode: "dry_run",
  heliusApiKey: "test-key",
}));

try {
  const { config } = await import("../config.js");
  const { getWalletBalances, normalizeWalletBalanceSnapshot } = await import("../tools/wallet.js");
  const wallet = "11111111111111111111111111111111";
  const data = {
    totalUsdValue: 100,
    balances: [
      { mint: config.tokens.SOL, symbol: "SOL", balance: 99, pricePerToken: 75, usdValue: 7425 },
      { mint: config.tokens.USDC, symbol: "USDC", balance: 16.073572, usdValue: 16.0700626 },
      { mint: config.tokens.USDT, symbol: "USDT", balance: 0.655841, usdValue: 0.6551458 },
    ],
  };

  const normalized = normalizeWalletBalanceSnapshot({ walletAddress: wallet, nativeSol: 0.355697682, data });
  assert.equal(normalized.sol, 0.355697682, "RPC native balance must override a stale Helius SOL row");
  assert.equal(normalized.native_sol_source, "rpc");
  assert.equal(normalized.usdc, 16.073572);
  assert.equal(normalized.usdt, 0.655841);
  assert.equal(normalized.error, undefined);

  const missingSolRow = normalizeWalletBalanceSnapshot({
    walletAddress: wallet,
    nativeSol: 0.42,
    data: { totalUsdValue: 16, balances: data.balances.slice(1) },
  });
  assert.equal(missingSolRow.sol, 0.42, "missing Helius SOL must never become a real zero balance");
  assert.ok(missingSolRow.warnings.includes("HELIUS_NATIVE_SOL_ROW_MISSING_RPC_BALANCE_USED"));
  assert.match(missingSolRow.error, /SOL price is unavailable/i);

  const liveRead = await getWalletBalances({
    walletPublicKey: wallet,
    connection: { getBalance: async () => 355_697_682 },
    fetchImpl: async () => ({ ok: true, json: async () => data }),
  });
  assert.equal(liveRead.sol, 0.355697682);
  assert.equal(liveRead.native_sol_source, "rpc");

  const providerFailure = await getWalletBalances({
    walletPublicKey: wallet,
    connection: { getBalance: async () => 355_697_682 },
    fetchImpl: async () => ({ ok: false, status: 503, statusText: "Service Unavailable" }),
  });
  assert.equal(providerFailure.sol, 0.355697682, "provider failure must retain the authoritative RPC balance");
  assert.match(providerFailure.error, /Helius wallet API failed: HTTP 503/);

  let rpcAttempts = 0;
  const retriedRpc = await getWalletBalances({
    walletPublicKey: wallet,
    connection: {
      getBalance: async () => {
        rpcAttempts += 1;
        if (rpcAttempts < 3) throw new Error("failed to get balance of account: 503 Service Unavailable with provider internals");
        return 355_697_682;
      },
    },
    fetchImpl: async () => ({ ok: true, json: async () => data }),
  });
  assert.equal(rpcAttempts, 3);
  assert.equal(retriedRpc.sol, 0.355697682);

  console.log("wallet balance integrity tests passed");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
