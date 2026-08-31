const BPS_SCALE = 10_000n;

function canonicalInteger(value, field, { positive = false } = {}) {
  const text = String(value ?? "");
  if (!/^\d+$/.test(text)) {
    throw new TypeError(`${field} must be a non-negative integer string`);
  }
  const amount = BigInt(text);
  if (positive && amount <= 0n) {
    throw new RangeError(`${field} must be greater than zero`);
  }
  return amount;
}

function nonNegativeNumber(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function quoteOutputRaw(quote) {
  try {
    return canonicalInteger(quote?.worstOutLamports, "quote.worstOutLamports", { positive: true });
  } catch {
    return null;
  }
}

function quoteNetLamports(quote) {
  try {
    return canonicalInteger(quote?.worstNetLamports, "quote.worstNetLamports");
  } catch {
    return null;
  }
}

function quoteImpactBps(quote) {
  try {
    return Number(canonicalInteger(quote?.priceImpactBps, "quote.priceImpactBps"));
  } catch {
    return null;
  }
}

function compactQuote(quote) {
  return {
    routeFound: quote?.routeFound === true,
    worstOutRaw: /^\d+$/.test(String(quote?.worstOutLamports ?? ""))
      ? String(quote.worstOutLamports)
      : null,
    networkFeeLamports: /^\d+$/.test(String(quote?.networkFeeLamports ?? ""))
      ? String(quote.networkFeeLamports)
      : null,
    worstNetLamports: /^\d+$/.test(String(quote?.worstNetLamports ?? ""))
      ? String(quote.worstNetLamports)
      : null,
    priceImpactBps: quoteImpactBps(quote),
    error: quote?.error ? String(quote.error).replace(/[\r\n]+/g, " ").slice(0, 300) : null,
  };
}

export function solAmountToLamports(amountSol) {
  const amount = Number(amountSol);
  const lamports = Math.round(amount * 1e9);
  if (!Number.isFinite(amount) || amount <= 0 || !Number.isSafeInteger(lamports) || lamports <= 0) {
    throw new TypeError("Deploy SOL amount must be a positive lamport-representable number");
  }
  if (Math.abs(lamports / 1e9 - amount) > Number.EPSILON) {
    throw new RangeError("Deploy SOL amount cannot be represented exactly in lamports");
  }
  return String(lamports);
}

export function evaluateExecutableRoundTrip({
  deployLamports,
  buyQuote,
  sellQuote,
  quotedAtMs = Date.now(),
  quoteSlippageBps = null,
  maxPriceImpactBps = 100,
  maxRoundTripLossPct = 1,
} = {}) {
  let input;
  try {
    input = canonicalInteger(deployLamports, "deployLamports", { positive: true });
  } catch (error) {
    return { pass: false, code: "INVALID_EXECUTABLE_ADMISSION_AMOUNT", reason: error.message };
  }

  const buy = compactQuote(buyQuote);
  const sell = compactQuote(sellQuote);
  const requestedSlippageBps = nonNegativeNumber(quoteSlippageBps, null);
  const baseEvidence = {
    source: "jupiter_swap_v2_quote",
    quotedAtMs,
    ...(requestedSlippageBps != null
      ? { quoteSlippageBps: Math.max(1, Math.min(500, Math.round(requestedSlippageBps))) }
      : {}),
    inputSolLamports: input.toString(),
  };
  const modeledTokenRaw = quoteOutputRaw(buyQuote);
  if (buyQuote?.routeFound !== true || modeledTokenRaw == null) {
    return {
      pass: false,
      code: "EXECUTABLE_BUY_ROUTE_UNAVAILABLE",
      reason: `Executable admission could not model SOL-to-token inventory${buy.error ? `: ${buy.error}` : "."}`,
      evidence: { ...baseEvidence, buy, sell },
    };
  }

  const sellNet = quoteNetLamports(sellQuote);
  if (sellQuote?.routeFound !== true || sellNet == null) {
    return {
      pass: false,
      code: "EXECUTABLE_SELL_ROUTE_UNAVAILABLE",
      reason: `Executable admission found no usable token-to-SOL route for the modeled inventory${sell.error ? `: ${sell.error}` : "."}`,
      evidence: {
        ...baseEvidence,
        modeledTokenRaw: modeledTokenRaw.toString(),
        buy,
        sell,
      },
    };
  }

  const buyImpactBps = quoteImpactBps(buyQuote);
  const sellImpactBps = quoteImpactBps(sellQuote);
  const maximumImpactBps = Math.max(0, Math.round(nonNegativeNumber(maxPriceImpactBps, 100)));
  const maximumLossBps = Math.max(0, Math.round(nonNegativeNumber(maxRoundTripLossPct, 1) * 100));
  const recoveryBps = Number((sellNet * BPS_SCALE) / input);
  const lossBps = Math.max(0, Number(BPS_SCALE) - recoveryBps);
  const evidence = {
    ...baseEvidence,
    modeledTokenRaw: modeledTokenRaw.toString(),
    executableRecoveryLamports: sellNet.toString(),
    recoveryBps,
    roundTripLossBps: lossBps,
    maxPriceImpactBps: maximumImpactBps,
    maxRoundTripLossBps: maximumLossBps,
    buy,
    sell,
  };

  if (buyImpactBps == null || sellImpactBps == null) {
    return {
      pass: false,
      code: "EXECUTABLE_PRICE_IMPACT_UNAVAILABLE",
      reason: "Executable admission quote did not include valid price-impact evidence.",
      evidence,
    };
  }
  if (buyImpactBps > maximumImpactBps || sellImpactBps > maximumImpactBps) {
    return {
      pass: false,
      code: "EXECUTABLE_PRICE_IMPACT_ABOVE_MAXIMUM",
      reason: `Executable admission price impact ${Math.max(buyImpactBps, sellImpactBps)} bps exceeds ${maximumImpactBps} bps.`,
      evidence,
    };
  }
  if (lossBps > maximumLossBps) {
    return {
      pass: false,
      code: "EXECUTABLE_ROUND_TRIP_LOSS_ABOVE_MAXIMUM",
      reason: `Executable admission round-trip loss ${(lossBps / 100).toFixed(2)}% exceeds ${(maximumLossBps / 100).toFixed(2)}%.`,
      evidence,
    };
  }

  return { pass: true, code: "EXECUTABLE_LIQUIDITY_CONFIRMED", evidence };
}

export async function collectExecutableRoundTripEvidence({
  baseMint,
  deployLamports,
  quoteSwap,
  solMint = "So11111111111111111111111111111111111111112",
  slippageBps = 25,
  maxPriceImpactBps = 100,
  maxRoundTripLossPct = 1,
  now = Date.now,
} = {}) {
  if (!baseMint || typeof quoteSwap !== "function") {
    return {
      pass: false,
      code: "EXECUTABLE_ADMISSION_DEPENDENCY_MISSING",
      reason: "Executable admission requires a base mint and quote provider.",
    };
  }
  let buyQuote;
  try {
    buyQuote = await quoteSwap({
      input_mint: solMint,
      output_mint: baseMint,
      amount_raw: String(deployLamports),
      use_referral: false,
      slippage_bps: slippageBps,
    });
  } catch (error) {
    buyQuote = { routeFound: false, error: error.message };
  }

  const modeledTokenRaw = quoteOutputRaw(buyQuote);
  let sellQuote = null;
  if (buyQuote?.routeFound === true && modeledTokenRaw != null) {
    try {
      sellQuote = await quoteSwap({
        input_mint: baseMint,
        output_mint: solMint,
        amount_raw: modeledTokenRaw.toString(),
        use_referral: false,
        slippage_bps: slippageBps,
      });
    } catch (error) {
      sellQuote = { routeFound: false, error: error.message };
    }
  }

  return evaluateExecutableRoundTrip({
    deployLamports,
    buyQuote,
    sellQuote,
    quotedAtMs: now(),
    quoteSlippageBps: slippageBps,
    maxPriceImpactBps,
    maxRoundTripLossPct,
  });
}

export function evaluateExecutableTokenQuote({
  tokenRaw,
  quote,
  quotedAtMs,
  nowMs = Date.now(),
  maxAgeMs = 15_000,
} = {}) {
  let raw;
  try {
    raw = canonicalInteger(tokenRaw, "tokenRaw");
  } catch (error) {
    return { pass: false, code: "INVALID_TOKEN_INVENTORY", reason: error.message };
  }
  if (raw === 0n) {
    return {
      pass: true,
      code: "NO_TOKEN_INVENTORY",
      valueLamports: "0",
      evidence: { source: "native_sol_only", quotedAtMs: null, ageMs: 0, tokenRaw: "0" },
    };
  }

  const timestamp = Number(quotedAtMs);
  const ageMs = Number(nowMs) - timestamp;
  const maximumAgeMs = Math.max(0, Number(maxAgeMs));
  if (!Number.isFinite(timestamp) || !Number.isFinite(ageMs) || ageMs < 0 || ageMs > maximumAgeMs) {
    return {
      pass: false,
      code: "EXECUTABLE_TOKEN_QUOTE_STALE",
      reason: "Positive token inventory has no fresh executable valuation quote.",
    };
  }

  const net = quoteNetLamports(quote);
  if (quote?.routeFound !== true || net == null) {
    return {
      pass: false,
      code: "EXECUTABLE_TOKEN_ROUTE_UNAVAILABLE",
      reason: `Positive token inventory has no executable token-to-SOL route${quote?.error ? `: ${String(quote.error).slice(0, 300)}` : "."}`,
    };
  }

  return {
    pass: true,
    code: "EXECUTABLE_TOKEN_VALUE_CONFIRMED",
    valueLamports: net.toString(),
    evidence: {
      source: "jupiter_swap_v2_quote",
      quotedAtMs: timestamp,
      ageMs,
      tokenRaw: raw.toString(),
      ...compactQuote(quote),
    },
  };
}
