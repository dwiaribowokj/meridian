import assert from "node:assert/strict";
import {
  collectExecutableRoundTripEvidence,
  evaluateExecutableRoundTrip,
  evaluateExecutableTokenQuote,
  solAmountToLamports,
} from "../executable-liquidity.js";
import { deriveExecutableInventoryValuation } from "../tools/pnl.js";
import { buildExecutableSwapQuote, quoteTokenSwap } from "../tools/wallet.js";

assert.equal(solAmountToLamports(0.2), "200000000");

const buyQuote = {
  routeFound: true,
  worstOutLamports: "1000000",
  networkFeeLamports: "5000",
  worstNetLamports: "995000",
  priceImpactBps: "10",
};
const sellQuote = {
  routeFound: true,
  worstOutLamports: "199000000",
  networkFeeLamports: "1000000",
  worstNetLamports: "198000000",
  priceImpactBps: "20",
};
const accepted = evaluateExecutableRoundTrip({
  deployLamports: "200000000",
  buyQuote,
  sellQuote,
  maxPriceImpactBps: 100,
  maxRoundTripLossPct: 1,
  quotedAtMs: 1_000,
});
assert.equal(accepted.pass, true);
assert.equal(accepted.evidence.roundTripLossBps, 100);
assert.equal(accepted.evidence.modeledTokenRaw, "1000000");

assert.equal(evaluateExecutableRoundTrip({
  deployLamports: "200000000",
  buyQuote,
  sellQuote: { routeFound: false, error: "no route" },
}).code, "EXECUTABLE_SELL_ROUTE_UNAVAILABLE");

assert.equal(evaluateExecutableRoundTrip({
  deployLamports: "200000000",
  buyQuote,
  sellQuote: { ...sellQuote, priceImpactBps: "101" },
  maxPriceImpactBps: 100,
}).code, "EXECUTABLE_PRICE_IMPACT_ABOVE_MAXIMUM");

assert.equal(evaluateExecutableRoundTrip({
  deployLamports: "200000000",
  buyQuote,
  sellQuote: { ...sellQuote, worstNetLamports: "197000000" },
  maxRoundTripLossPct: 1,
}).code, "EXECUTABLE_ROUND_TRIP_LOSS_ABOVE_MAXIMUM");

const quoteCalls = [];
const collected = await collectExecutableRoundTripEvidence({
  baseMint: "Mint111",
  deployLamports: "200000000",
  quoteSwap: async (request) => {
    quoteCalls.push(request);
    return quoteCalls.length === 1 ? buyQuote : sellQuote;
  },
  maxPriceImpactBps: 100,
  maxRoundTripLossPct: 1,
  now: () => 2_000,
});
assert.equal(collected.pass, true);
assert.equal(collected.evidence.source, "jupiter_swap_v2_quote");
assert.equal(collected.evidence.quoteSlippageBps, 25);
assert.deepEqual(quoteCalls.map((call) => [call.input_mint, call.output_mint, call.amount_raw, call.slippage_bps]), [
  ["So11111111111111111111111111111111111111112", "Mint111", "200000000", 25],
  ["Mint111", "So11111111111111111111111111111111111111112", "1000000", 25],
]);

const originalFetch = globalThis.fetch;
let requestedQuoteUrl = null;
try {
  globalThis.fetch = async (url) => {
    requestedQuoteUrl = new URL(String(url));
    return {
      ok: true,
      json: async () => ({
        inputMint: "So11111111111111111111111111111111111111112",
        outputMint: "Mint111",
        inAmount: "200000000",
        outAmount: "1000000",
        otherAmountThreshold: "997500",
        priceImpactPct: "0.1",
      }),
    };
  };
  const balanceIndependentQuote = await quoteTokenSwap({
    input_mint: "SOL",
    output_mint: "Mint111",
    amount_raw: "200000000",
    use_referral: false,
    slippage_bps: 25,
  });
  assert.equal(requestedQuoteUrl.pathname, "/swap/v2/quote");
  assert.equal(requestedQuoteUrl.searchParams.get("slippageBps"), "25");
  assert.equal(requestedQuoteUrl.searchParams.has("taker"), false, "modeled admission quotes must not require a funded taker");
  assert.equal(balanceIndependentQuote.routeFound, true, "quote responses need no transaction payload");
  assert.equal(balanceIndependentQuote.worstOutLamports, "997500", "quote uses the slippage-protected threshold");
} finally {
  globalThis.fetch = originalFetch;
}

const executableValue = evaluateExecutableTokenQuote({
  tokenRaw: "1000000",
  quote: sellQuote,
  quotedAtMs: 10_000,
  nowMs: 12_000,
  maxAgeMs: 5_000,
});
assert.equal(executableValue.pass, true);
assert.equal(executableValue.valueLamports, "198000000");
assert.equal(executableValue.evidence.priceImpactBps, 20);

assert.equal(evaluateExecutableTokenQuote({
  tokenRaw: "1000000",
  quote: sellQuote,
  quotedAtMs: 10_000,
  nowMs: 20_001,
  maxAgeMs: 10_000,
}).code, "EXECUTABLE_TOKEN_QUOTE_STALE");
assert.equal(evaluateExecutableTokenQuote({
  tokenRaw: "1",
  quote: { routeFound: false },
  quotedAtMs: 10_000,
  nowMs: 10_001,
}).code, "EXECUTABLE_TOKEN_ROUTE_UNAVAILABLE");
assert.equal(evaluateExecutableTokenQuote({ tokenRaw: "0" }).valueLamports, "0");

const sellOrder = buildExecutableSwapQuote({
  outAmount: "205000000",
  otherAmountThreshold: "200000000",
  signatureFeeLamports: "5000",
  prioritizationFeeLamports: "10000",
  rentFeeLamports: "0",
  priceImpactPct: "0.25",
}, {
  inputMint: "Mint111",
  outputMint: "So11111111111111111111111111111111111111112",
  amountRaw: "1000",
  quotedAtMs: 50_000,
});
assert.equal(sellOrder.worstOutLamports, "200000000", "slippage threshold, not optimistic outAmount, is the executable mark");
assert.equal(sellOrder.worstNetLamports, "199985000", "native-output valuation deducts executable network fees");
assert.equal(sellOrder.priceImpactBps, "25");

const buyOrder = buildExecutableSwapQuote({
  outAmount: "1000",
  otherAmountThreshold: "950",
  signatureFeeLamports: "5000",
  priceImpactPct: "0.1",
}, {
  inputMint: "So11111111111111111111111111111111111111112",
  outputMint: "Mint111",
  amountRaw: "200000000",
});
assert.equal(buyOrder.worstNetLamports, "950", "SOL-denominated fees are never subtracted from raw token output units");

const inventory = deriveExecutableInventoryValuation({
  xRaw: "900",
  feeXRaw: "100",
  yRaw: "50000000",
  feeYRaw: "10000000",
  decY: 9,
  quote: {
    routeFound: true,
    worstOutLamports: "101000000",
    worstNetLamports: "100000000",
    networkFeeLamports: "1000000",
    priceImpactBps: "20",
  },
  quotedAtMs: 10_000,
  nowMs: 11_000,
  maxQuoteAgeMs: 5_000,
});
assert.equal(inventory.pass, true);
assert.equal(inventory.tokenPrincipalValueLamports, "90000000");
assert.equal(inventory.tokenFeeValueLamports, "10000000");
assert.equal(inventory.balancesSol, 0.14);
assert.equal(inventory.claimableSol, 0.02);
assert.equal(inventory.totalLiquidationSol, 0.16);

const unquotedInventory = deriveExecutableInventoryValuation({
  xRaw: "1",
  feeXRaw: "0",
  yRaw: "50000000",
  feeYRaw: "0",
  decY: 9,
  quote: { routeFound: false },
  quotedAtMs: 10_000,
  nowMs: 11_000,
});
assert.equal(unquotedInventory.pass, false);
assert.equal(unquotedInventory.code, "EXECUTABLE_TOKEN_ROUTE_UNAVAILABLE");

const incompleteInventory = deriveExecutableInventoryValuation({
  xRaw: null,
  feeXRaw: "0",
  yRaw: "50000000",
  feeYRaw: "0",
});
assert.equal(incompleteInventory.pass, false, "missing on-chain amounts must never be treated as zero inventory");
assert.equal(incompleteInventory.code, "INVALID_ON_CHAIN_POSITION_AMOUNTS");

console.log("executable liquidity tests passed");
