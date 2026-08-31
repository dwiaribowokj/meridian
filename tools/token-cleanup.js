import { PublicKey } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createBurnCheckedInstruction,
  createCloseAccountInstruction,
} from "@solana/spl-token";

export const WRAPPED_SOL_MINT = "So11111111111111111111111111111111111111112";
export const PROTECTED_STABLECOIN_MINTS = Object.freeze([
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // native USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // native USDT
]);

export const TOKEN_PROGRAMS = Object.freeze({
  token: TOKEN_PROGRAM_ID.toBase58(),
  token2022: TOKEN_2022_PROGRAM_ID.toBase58(),
});

// Lamport values are strings so policy/config previews remain JSON serializable.
export const DEFAULT_CLEANUP_POLICY = Object.freeze({
  minSwapNetLamports: "100000",
  maxSwapNetworkFeeLamports: "100000",
  maxSwapPriceImpactBps: "500",
  maxBurnMarkedValueLamportsPerMint: "500000",
  minBurnRentAdvantageLamports: "1000000",
  maxBurnMarkedValueLamportsPerSweep: "2000000",
  defaultBurnCloseFeeLamports: "20000",
  noRouteMinAgeMs: 24 * 60 * 60 * 1000,
  maxBurnClosePerBatch: 10,
  maxCloseOnlyPerBatch: 20,
  maxSerializedBytes: 1100,
  maxBatchFeeLamports: "20000",
  confirmationReads: 2,
  confirmationDelayMs: 2000,
  protectedMints: PROTECTED_STABLECOIN_MINTS,
  // ImmutableOwner is present on ordinary Token-2022 ATAs and does not alter burn semantics.
  supportedToken2022BurnExtensions: Object.freeze(["immutableowner"]),
});

const BIGINT_POLICY_FIELDS = [
  "minSwapNetLamports",
  "maxSwapNetworkFeeLamports",
  "maxSwapPriceImpactBps",
  "maxBurnMarkedValueLamportsPerMint",
  "minBurnRentAdvantageLamports",
  "maxBurnMarkedValueLamportsPerSweep",
  "defaultBurnCloseFeeLamports",
  "maxBatchFeeLamports",
];

const INTEGER_POLICY_FIELDS = [
  "noRouteMinAgeMs",
  "maxBurnClosePerBatch",
  "maxCloseOnlyPerBatch",
  "maxSerializedBytes",
  "confirmationReads",
  "confirmationDelayMs",
];

function rawInteger(value, field, { allowZero = true } = {}) {
  let parsed;
  if (typeof value === "bigint") {
    parsed = value;
  } else if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new TypeError(`${field} must be a safe integer or integer string`);
    }
    parsed = BigInt(value);
  } else if (typeof value === "string" && /^\d+$/.test(value)) {
    parsed = BigInt(value);
  } else {
    throw new TypeError(`${field} must be a non-negative integer`);
  }
  if (parsed < 0n || (!allowZero && parsed === 0n)) {
    throw new RangeError(`${field} must be ${allowZero ? "non-negative" : "positive"}`);
  }
  return parsed;
}

export function parseRawInteger(value, field = "value") {
  return rawInteger(value, field);
}

function strictInteger(value, field, { min = 0 } = {}) {
  if (!Number.isSafeInteger(value) || value < min) {
    throw new TypeError(`${field} must be a safe integer >= ${min}`);
  }
  return value;
}

export function makeCleanupPolicy(overrides = {}) {
  const merged = { ...DEFAULT_CLEANUP_POLICY, ...overrides };
  for (const field of BIGINT_POLICY_FIELDS) {
    merged[field] = rawInteger(merged[field], field).toString();
  }
  for (const field of INTEGER_POLICY_FIELDS) {
    merged[field] = strictInteger(merged[field], field, {
      min: field === "confirmationDelayMs" || field === "noRouteMinAgeMs" ? 0 : 1,
    });
  }
  if (!Array.isArray(merged.protectedMints)) {
    throw new TypeError("protectedMints must be an array");
  }
  if (!Array.isArray(merged.supportedToken2022BurnExtensions)) {
    throw new TypeError("supportedToken2022BurnExtensions must be an array");
  }
  merged.protectedMints = Object.freeze([...new Set(merged.protectedMints.map(String))]);
  merged.supportedToken2022BurnExtensions = Object.freeze(
    [...new Set(merged.supportedToken2022BurnExtensions.map(normalizeExtensionName))],
  );
  return Object.freeze(merged);
}

function publicKeyString(value) {
  if (value instanceof PublicKey) return value.toBase58();
  if (value && typeof value.toBase58 === "function") return value.toBase58();
  return value == null ? "" : String(value);
}

export function normalizeTokenProgram(value) {
  const program = publicKeyString(value).trim();
  const lowered = program.toLowerCase();
  if (program === TOKEN_PROGRAMS.token || ["token", "spl-token", "legacy"].includes(lowered)) {
    return { kind: "token", programId: TOKEN_PROGRAMS.token };
  }
  if (program === TOKEN_PROGRAMS.token2022 || ["token-2022", "token2022", "spl-token-2022"].includes(lowered)) {
    return { kind: "token2022", programId: TOKEN_PROGRAMS.token2022 };
  }
  return null;
}

function normalizeExtensionName(value) {
  if (value === 7 || value === "7") return "immutableowner";
  return String(value).replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function unsupportedToken2022Extensions(account, policy) {
  if (Array.isArray(account.unsupportedExtensions) && account.unsupportedExtensions.length > 0) {
    return account.unsupportedExtensions.map(String);
  }
  if (!Array.isArray(account.extensions)) return ["uninspected"];
  const supported = new Set(policy.supportedToken2022BurnExtensions);
  return account.extensions
    .map(normalizeExtensionName)
    .filter((extension) => extension && extension !== "uninitialized" && !supported.has(extension));
}

function accountAddress(account) {
  return publicKeyString(account.tokenAccount ?? account.address ?? account.account).trim();
}

function mintAddress(account) {
  return publicKeyString(account.mint).trim();
}

function exclusiveLifecycleBalanceProvenance(account, rawAmount) {
  const provenance = account.provenance;
  if (!provenance || typeof provenance !== "object") {
    return { valid: false, reason: "unknown_provenance" };
  }
  const evidenceAddress = publicKeyString(provenance.accountAddress).trim();
  const attributable = rawInteger(provenance.attributableRawAmount, "provenance.attributableRawAmount");
  const current = rawInteger(provenance.currentRawAmount, "provenance.currentRawAmount");
  const initial = rawInteger(provenance.initialRawAmount, "provenance.initialRawAmount");
  const matches = provenance.source === "bot_lifecycle" &&
    Boolean(provenance.lifecycleId) &&
    provenance.evidence === "confirmed_lifecycle_token_delta" &&
    Boolean(evidenceAddress) &&
    evidenceAddress === accountAddress(account) &&
    (provenance.exclusive === (initial === 0n));
  if (!matches) return { valid: false, reason: "provenance_ambiguity" };
  if (current !== rawAmount || initial + attributable !== current) {
    return {
      valid: false,
      reason: "provenance_balance_mismatch",
      attributableRawAmount: attributable.toString(),
      currentRawAmount: current.toString(),
    };
  }
  return { valid: true, provenance, attributableRawAmount: attributable, initialRawAmount: initial };
}

function timestampMs(value) {
  if (Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function jsonLamports(value) {
  return value == null ? null : value.toString();
}

function baseAction(account, sourceIndex, program, rawAmount) {
  return {
    sourceIndex,
    tokenAccount: accountAddress(account),
    mint: mintAddress(account),
    program: program?.kind ?? null,
    programId: program?.programId ?? (publicKeyString(account.programId ?? account.tokenProgram) || null),
    rawAmount: rawAmount == null ? null : rawAmount.toString(),
    decimals: Number.isSafeInteger(account.decimals) ? account.decimals : null,
    owner: publicKeyString(account.owner).trim() || null,
    closeAuthority: publicKeyString(account.closeAuthority).trim() || null,
    provenance: account.provenance || null,
  };
}

function keepAction(base, reason, details = {}) {
  return {
    ...base,
    action: "keep",
    reason,
    alert: base.rawAmount !== "0",
    ...details,
  };
}

function normalizeQuote(quote) {
  if (!quote || typeof quote !== "object" || typeof quote.routeFound !== "boolean") {
    throw new TypeError("quote must explicitly provide routeFound");
  }
  if (!quote.routeFound) return { routeFound: false };

  const worstOut = rawInteger(quote.worstOutLamports, "quote.worstOutLamports");
  const networkFee = rawInteger(quote.networkFeeLamports, "quote.networkFeeLamports");
  const priceImpactBps = rawInteger(quote.priceImpactBps, "quote.priceImpactBps");
  const calculatedNet = worstOut > networkFee ? worstOut - networkFee : 0n;
  const suppliedNet = quote.worstNetLamports == null
    ? calculatedNet
    : rawInteger(quote.worstNetLamports, "quote.worstNetLamports");
  // Never trust an adapter's net figure when it is more optimistic than raw output minus fees.
  const worstNet = suppliedNet < calculatedNet ? suppliedNet : calculatedNet;
  return {
    routeFound: true,
    worstOutLamports: worstOut,
    networkFeeLamports: networkFee,
    priceImpactBps,
    worstNetLamports: worstNet,
  };
}

async function evaluateAccount(account, sourceIndex, dependencies, policy, now) {
  const address = accountAddress(account);
  const mint = mintAddress(account);
  const program = normalizeTokenProgram(account.programId ?? account.tokenProgram);

  let rawAmount;
  try {
    rawAmount = rawInteger(account.rawAmount, "rawAmount");
  } catch (error) {
    return keepAction(baseAction(account, sourceIndex, program, null), "invalid_raw_amount", {
      error: error.message,
    });
  }

  const base = baseAction(account, sourceIndex, program, rawAmount);
  if (!address || !mint) return keepAction(base, "missing_account_or_mint");
  if (!program) return keepAction(base, "unsupported_token_program");
  if (account.ownerIsWallet === false) return keepAction(base, "wallet_not_token_owner");
  if (account.closeAuthority && account.closeAuthorityIsWallet === false) {
    return keepAction(base, "wallet_not_close_authority");
  }
  if (rawInteger(account.withheldAmountRaw ?? 0, "withheldAmountRaw") > 0n) {
    return keepAction(base, "token_2022_withheld_fee_requires_harvest");
  }

  let provenance;
  try {
    provenance = exclusiveLifecycleBalanceProvenance(account, rawAmount);
  } catch (error) {
    return keepAction(base, "provenance_ambiguity", { error: error.message });
  }
  if (!provenance.valid) {
    return keepAction(base, provenance.reason, {
      attributableRawAmount: provenance.attributableRawAmount,
      currentRawAmount: provenance.currentRawAmount,
    });
  }
  const lifecycleRawAmount = provenance.attributableRawAmount;
  const lifecycleBase = {
    ...base,
    rawAmount: lifecycleRawAmount.toString(),
    accountRawAmount: rawAmount.toString(),
  };
  if (lifecycleRawAmount === 0n && provenance.initialRawAmount > 0n) {
    return keepAction(lifecycleBase, "lifecycle_delta_settled_baseline_retained");
  }
  if (account.frozen === true || String(account.state || "").toLowerCase() === "frozen") {
    return keepAction(lifecycleBase, "frozen_account");
  }
  if (account.delegate || account.delegated === true) {
    return keepAction(lifecycleBase, "delegated_account");
  }
  if (account.inUseByOpenPosition === true || account.pendingLifecycleAction === true) {
    return keepAction(lifecycleBase, "account_in_use_by_open_position");
  }
  if (lifecycleRawAmount === 0n) {
    return { ...lifecycleBase, action: "close", reason: "zero_balance", alert: false };
  }
  // A positive balance is economic property. Even a lifecycle account stays
  // untouched unless its exact current raw balance is exclusively proven.
  if (mint === WRAPPED_SOL_MINT) {
    return provenance.initialRawAmount > 0n
      ? keepAction(lifecycleBase, "shared_account_unwrap_forbidden")
      : { ...lifecycleBase, action: "unwrap", reason: "wrapped_sol", alert: false };
  }

  if (typeof dependencies.quoteSwap !== "function") {
    return keepAction(lifecycleBase, "quote_unavailable");
  }

  let quote;
  try {
    quote = normalizeQuote(await dependencies.quoteSwap({
      tokenAccount: address,
      mint,
      programId: program.programId,
      rawAmount: lifecycleRawAmount.toString(),
      decimals: base.decimals,
    }));
  } catch (error) {
    return keepAction(lifecycleBase, "quote_unavailable", { error: error.message });
  }

  if (quote.routeFound) {
    const minNet = BigInt(policy.minSwapNetLamports);
    const maxFee = BigInt(policy.maxSwapNetworkFeeLamports);
    const maxImpact = BigInt(policy.maxSwapPriceImpactBps);
    const quotePreview = {
      routeFound: true,
      worstOutLamports: jsonLamports(quote.worstOutLamports),
      networkFeeLamports: jsonLamports(quote.networkFeeLamports),
      priceImpactBps: quote.priceImpactBps.toString(),
      worstNetLamports: jsonLamports(quote.worstNetLamports),
    };
    if (
      quote.worstNetLamports >= minNet &&
      quote.networkFeeLamports <= maxFee &&
      quote.priceImpactBps <= maxImpact
    ) {
      return {
        ...lifecycleBase,
        action: "swap_then_close",
        reason: "economic_swap",
        alert: false,
        quote: quotePreview,
      };
    }
    lifecycleBase.quote = quotePreview;
  } else {
    lifecycleBase.quote = { routeFound: false };
  }

  if (provenance.initialRawAmount > 0n) {
    return keepAction(lifecycleBase, "shared_account_non_swap_cleanup_forbidden");
  }

  if (policy.protectedMints.includes(mint)) {
    return keepAction(base, "protected_mint_no_economic_swap");
  }
  if (program.kind === "token2022") {
    const unsupportedExtensions = unsupportedToken2022Extensions(account, policy);
    if (unsupportedExtensions.length > 0) {
      return keepAction(base, "token_2022_unsupported_extensions", { unsupportedExtensions });
    }
  }

  let markedValue;
  let rent;
  let cleanupFee;
  try {
    markedValue = rawInteger(account.markedValueLamports, "markedValueLamports");
    rent = rawInteger(account.rentLamports, "rentLamports");
    cleanupFee = rawInteger(
      account.burnCloseFeeLamports ?? policy.defaultBurnCloseFeeLamports,
      "burnCloseFeeLamports",
    );
  } catch (error) {
    return keepAction(base, "missing_burn_economics", { error: error.message });
  }

  const rentAdvantage = rent > markedValue + cleanupFee ? rent - markedValue - cleanupFee : 0n;
  if (rentAdvantage < BigInt(policy.minBurnRentAdvantageLamports)) {
    return keepAction(base, "burn_rent_advantage_too_low", {
      markedValueLamports: markedValue.toString(),
      rentAdvantageLamports: rentAdvantage.toString(),
    });
  }

  if (!quote.routeFound) {
    const markedAt = timestampMs(account.markedAt);
    if (markedAt == null || now - markedAt < policy.noRouteMinAgeMs) {
      return keepAction(base, "no_route_residue_too_young", {
        markedValueLamports: markedValue.toString(),
        markedAt: markedAt == null ? null : new Date(markedAt).toISOString(),
      });
    }
  }

  return {
    ...base,
    action: "burn_candidate",
    reason: quote.routeFound ? "uneconomic_route_dust" : "aged_no_route_dust",
    alert: false,
    markedValueLamports: markedValue.toString(),
    rentLamports: rent.toString(),
    cleanupFeeLamports: cleanupFee.toString(),
    rentAdvantageLamports: rentAdvantage.toString(),
  };
}

function finalizeBurnCandidates(actions, policy) {
  const maxPerMint = BigInt(policy.maxBurnMarkedValueLamportsPerMint);
  const maxPerSweep = BigInt(policy.maxBurnMarkedValueLamportsPerSweep);
  const groups = new Map();

  for (const action of actions) {
    if (action.action !== "burn_candidate") continue;
    const group = groups.get(action.mint) || { mint: action.mint, value: 0n, actions: [] };
    group.value += BigInt(action.markedValueLamports);
    group.actions.push(action);
    groups.set(action.mint, group);
  }

  const eligible = [];
  for (const group of groups.values()) {
    if (group.value > maxPerMint) {
      for (const action of group.actions) {
        action.action = "keep";
        action.reason = "burn_value_cap_exceeded_per_mint";
        action.alert = true;
        action.mintMarkedValueLamports = group.value.toString();
      }
    } else {
      eligible.push(group);
    }
  }

  eligible.sort((a, b) => {
    if (a.value !== b.value) return a.value < b.value ? -1 : 1;
    return a.mint.localeCompare(b.mint);
  });

  let sweepValue = 0n;
  for (const group of eligible) {
    if (sweepValue + group.value > maxPerSweep) {
      for (const action of group.actions) {
        action.action = "keep";
        action.reason = "burn_sweep_cap_exceeded";
        action.alert = true;
      }
      continue;
    }
    sweepValue += group.value;
    for (const action of group.actions) action.action = "burn_then_close";
  }
  return sweepValue;
}

/**
 * Build a JSON-safe, fail-closed cleanup preview. Positive balances are never
 * rounded through UI decimals: quote and decision adapters receive raw amounts.
 */
export async function planTokenCleanup(accounts, {
  quoteSwap,
  now = Date.now(),
  policy: policyOverrides = {},
} = {}) {
  if (!Array.isArray(accounts)) throw new TypeError("accounts must be an array");
  const policy = makeCleanupPolicy(policyOverrides);
  const nowMs = strictInteger(now, "now");
  const actions = await Promise.all(accounts.map((account, index) =>
    evaluateAccount(account || {}, index, { quoteSwap }, policy, nowMs)));
  const burnMarkedValue = finalizeBurnCandidates(actions, policy);

  const counts = {};
  for (const action of actions) counts[action.action] = (counts[action.action] || 0) + 1;
  return {
    createdAt: new Date(nowMs).toISOString(),
    policy,
    actions,
    summary: {
      accountCount: actions.length,
      counts,
      burnMarkedValueLamports: burnMarkedValue.toString(),
      requiresExecution: actions.some((action) => action.action !== "keep"),
    },
  };
}

export const buildTokenCleanupPlan = planTokenCleanup;

function measurementValue(measurement, field) {
  if (!measurement || typeof measurement !== "object") {
    throw new TypeError("measureBatch must return an object");
  }
  return rawInteger(measurement[field], `measurement.${field}`);
}

function initialChunks(actions, size) {
  const chunks = [];
  for (let index = 0; index < actions.length; index += size) {
    chunks.push(actions.slice(index, index + size));
  }
  return chunks;
}

/** Pack burn and close operations separately, enforcing count, bytes and fee caps. */
export async function planCleanupBatches(actions, {
  measureBatch,
  policy: policyOverrides = {},
} = {}) {
  if (!Array.isArray(actions)) throw new TypeError("actions must be an array");
  if (typeof measureBatch !== "function") throw new TypeError("measureBatch dependency is required");
  const policy = makeCleanupPolicy(policyOverrides);
  const burn = actions.filter((action) => action.action === "burn_then_close");
  const close = actions.filter((action) => action.action === "close" || action.action === "unwrap");
  const queue = [
    ...initialChunks(burn, policy.maxBurnClosePerBatch),
    ...initialChunks(close, policy.maxCloseOnlyPerBatch),
  ];
  const batches = [];
  const rejected = [];

  while (queue.length > 0) {
    const candidate = queue.shift();
    const measurement = await measureBatch(candidate);
    const serializedBytes = measurementValue(measurement, "serializedBytes");
    const feeLamports = measurementValue(measurement, "feeLamports");
    const fits = serializedBytes <= BigInt(policy.maxSerializedBytes) &&
      feeLamports <= BigInt(policy.maxBatchFeeLamports);
    if (fits) {
      batches.push({
        kind: candidate[0]?.action === "burn_then_close" ? "burn_then_close" : "close_only",
        actions: candidate,
        serializedBytes: serializedBytes.toString(),
        feeLamports: feeLamports.toString(),
      });
    } else if (candidate.length > 1) {
      const middle = Math.ceil(candidate.length / 2);
      queue.unshift(candidate.slice(0, middle), candidate.slice(middle));
    } else {
      rejected.push({
        action: candidate[0],
        reason: serializedBytes > BigInt(policy.maxSerializedBytes)
          ? "serialized_size_cap_exceeded"
          : "batch_fee_cap_exceeded",
        serializedBytes: serializedBytes.toString(),
        feeLamports: feeLamports.toString(),
      });
    }
  }

  return { batches, rejected };
}

function key(value, field) {
  try {
    return value instanceof PublicKey ? value : new PublicKey(value);
  } catch {
    throw new TypeError(`${field} must be a valid Solana public key`);
  }
}

/** Build SPL instructions; transaction construction/signing stays in the injected adapter. */
export function buildTokenCleanupInstructions(action, {
  owner = action.owner,
  closeAuthority = action.closeAuthority || owner,
  destination = owner,
} = {}) {
  const program = normalizeTokenProgram(action.programId ?? action.program);
  if (!program) throw new TypeError("action has an unsupported token program");
  const programId = key(program.programId, "programId");
  const tokenAccount = key(action.tokenAccount, "tokenAccount");
  const closeDestination = key(destination, "destination");
  const closeOwner = key(closeAuthority, "closeAuthority");
  const closeInstruction = () => createCloseAccountInstruction(
    tokenAccount,
    closeDestination,
    closeOwner,
    [],
    programId,
  );

  if (action.action === "close" || action.action === "unwrap") return [closeInstruction()];
  if (action.action !== "burn_then_close") {
    throw new TypeError(`cannot build SPL cleanup instructions for ${action.action}`);
  }
  if (!Number.isSafeInteger(action.decimals) || action.decimals < 0 || action.decimals > 255) {
    throw new TypeError("burn action requires integer decimals in [0, 255]");
  }
  const burnOwner = key(owner, "owner");
  const mint = key(action.mint, "mint");
  const amount = rawInteger(action.rawAmount, "rawAmount", { allowZero: false });
  return [
    createBurnCheckedInstruction(tokenAccount, mint, burnOwner, amount, action.decimals, [], programId),
    closeInstruction(),
  ];
}

function normalizeAccountRead(value) {
  if (value == null || value === false || value?.exists === false) {
    return {
      exists: false,
      rawAmount: null,
      tokenAccount: "",
      owner: "",
      mint: "",
      programId: "",
    };
  }
  const raw = typeof value === "object" ? value.rawAmount : value;
  const object = typeof value === "object" ? value : {};
  return {
    exists: true,
    rawAmount: rawInteger(raw, "readAccount.rawAmount"),
    // Execution adapters must report the identity they read. In particular,
    // never infer this from the requested action: that would turn an
    // aggregate/mint-level observation into a false source-account proof.
    tokenAccount: publicKeyString(object.tokenAccount ?? object.address ?? object.account).trim(),
    owner: publicKeyString(object.owner).trim(),
    mint: publicKeyString(object.mint).trim(),
    programId: publicKeyString(object.programId ?? object.tokenProgram ?? object.program).trim(),
  };
}

async function readStableAccount(action, dependencies, policy) {
  const reads = [];
  for (let index = 0; index < policy.confirmationReads; index++) {
    reads.push(normalizeAccountRead(await dependencies.readAccount(action)));
    if (index + 1 < policy.confirmationReads) {
      await dependencies.wait(policy.confirmationDelayMs);
    }
  }
  const first = reads[0];
  const stable = reads.every((read) =>
    read.exists === first.exists &&
    read.rawAmount === first.rawAmount &&
    read.tokenAccount === first.tokenAccount &&
    read.owner === first.owner &&
    read.mint === first.mint &&
    read.programId === first.programId);
  if (!stable) throw new Error(`account ${action.tokenAccount} did not reach a stable confirmed state`);
  return first;
}

function successful(result) {
  if (result === true) return true;
  if (!result || typeof result !== "object") return false;
  return result.success !== false && result.ok !== false && !result.error;
}

async function confirmAndCheckpointResult(result, {
  confirmTransaction,
  onTransactionConfirmed,
  phase,
  action = null,
  actions = null,
} = {}) {
  const signatures = result?.signatures || (result?.signature ? [result.signature] : []);
  if (signatures.length === 0) {
    throw new Error(`${phase || "cleanup"} execution did not return a signature for confirmation`);
  }
  if (typeof confirmTransaction !== "function") {
    throw new TypeError(`${phase || "cleanup"} execution requires confirmTransaction before it can be accepted`);
  }
  for (const signature of signatures) {
    await confirmTransaction(signature);
    // executeBatch may already perform confirmed submission (as the default
    // adapter does). Either way, do this before any subsequent account read or
    // another executable action so a later failure cannot lose the signature.
    if (typeof onTransactionConfirmed === "function") {
      await onTransactionConfirmed({ signature, phase, action, actions, result });
    }
  }
}

function requiredDependency(dependencies, name) {
  if (typeof dependencies[name] !== "function") {
    throw new TypeError(`${name} dependency is required for execution`);
  }
}

function assertBoundedLifecycleAction(action) {
  try {
    const lifecycleRawAmount = rawInteger(action?.rawAmount, "action.rawAmount");
    const accountRawAmount = rawInteger(
      action?.accountRawAmount ?? action?.provenance?.currentRawAmount,
      "action.accountRawAmount",
    );
    const provenance = exclusiveLifecycleBalanceProvenance(action || {}, accountRawAmount);
    if (!provenance.valid) throw new Error(provenance.reason);
    if (provenance.attributableRawAmount !== lifecycleRawAmount) {
      throw new Error("provenance_attributable_amount_mismatch");
    }
  } catch (error) {
    throw new TypeError(`cleanup action ${action?.tokenAccount || "unknown"} lacks exclusive bounded provenance: ${error.message}`);
  }
}

function exactSwapSource(action, account, walletPublicKey, { rawAmount = action.provenance?.currentRawAmount ?? action.rawAmount } = {}) {
  const expectedAccount = accountAddress(action);
  const expectedMint = mintAddress(action);
  const expectedProgram = normalizeTokenProgram(action.programId ?? action.program);
  const expectedOwner = publicKeyString(walletPublicKey).trim();
  const expectedRaw = rawInteger(rawAmount, "action.rawAmount");
  if (!expectedAccount || !expectedMint || !expectedProgram || !expectedOwner) {
    throw new TypeError("swap action lacks an exact source-account, mint, token program, or signing wallet");
  }
  if (!account.exists) throw new Error(`source token account ${expectedAccount} no longer exists`);
  if (account.tokenAccount !== expectedAccount) {
    throw new Error(`source account read returned ${account.tokenAccount || "no address"}, not ${expectedAccount}`);
  }
  if (account.owner !== expectedOwner) {
    throw new Error(`source account ${expectedAccount} is owned by ${account.owner || "unknown"}, not the signing wallet`);
  }
  if (account.mint !== expectedMint) {
    throw new Error(`source account ${expectedAccount} mint changed from ${expectedMint} to ${account.mint || "unknown"}`);
  }
  const actualProgram = normalizeTokenProgram(account.programId);
  if (!actualProgram || actualProgram.programId !== expectedProgram.programId) {
    throw new Error(`source account ${expectedAccount} token program does not match the planned ${expectedProgram.kind} program`);
  }
  if (account.rawAmount !== expectedRaw) {
    throw new Error(`source account ${expectedAccount} raw balance changed from ${expectedRaw} to ${account.rawAmount}`);
  }
}

function assertEconomicSwapPolicy(action, policy) {
  let quote;
  try {
    quote = normalizeQuote(action.quote);
  } catch (error) {
    throw new TypeError(`swap action ${action.tokenAccount} lacks a valid economic quote: ${error.message}`);
  }
  if (!quote.routeFound) throw new Error(`swap action ${action.tokenAccount} has no executable route`);
  if (quote.worstNetLamports < BigInt(policy.minSwapNetLamports)) {
    throw new Error(`swap action ${action.tokenAccount} no longer meets the minimum net-output policy`);
  }
  if (quote.networkFeeLamports > BigInt(policy.maxSwapNetworkFeeLamports)) {
    throw new Error(`swap action ${action.tokenAccount} exceeds the network-fee policy`);
  }
  if (quote.priceImpactBps > BigInt(policy.maxSwapPriceImpactBps)) {
    throw new Error(`swap action ${action.tokenAccount} exceeds the price-impact policy`);
  }
  return quote;
}

/**
 * A successful adapter must return an audit made from the locally constructed
 * or locally decoded instruction path. A remote provider's amount/mint quote,
 * a serialized transaction, or an assertion that it used the right account is
 * not enough. The audit makes the execution boundary reject any additional
 * wallet-token debit or SOL transfer before it accepts a signature. The audit
 * must also enumerate every writable account in the prepared message and mark
 * each one safe through local instruction/account inspection.
 */
function assertLocallyInspectedSwapAudit(action, preparation, policy, quote) {
  const audit = preparation?.sourceAccountAudit;
  if (!audit || audit.inspection !== "local_instruction_inspection") {
    throw new Error("swap adapter did not provide a locally inspected source-account audit");
  }
  const expectedProgram = normalizeTokenProgram(action.programId ?? action.program);
  if (
    publicKeyString(audit.sourceTokenAccount).trim() !== accountAddress(action) ||
    publicKeyString(audit.sourceMint).trim() !== mintAddress(action) ||
    publicKeyString(audit.sourceTokenProgram).trim() !== expectedProgram?.programId ||
    rawInteger(audit.inputRawAmount, "sourceAccountAudit.inputRawAmount") !== rawInteger(action.rawAmount, "action.rawAmount")
  ) {
    throw new Error("locally inspected swap audit is not bound to the planned source account, mint, program, and raw amount");
  }

  const debits = Array.isArray(audit.walletTokenDebits) ? audit.walletTokenDebits : null;
  const writableWalletTokens = Array.isArray(audit.writableWalletTokenAccounts)
    ? audit.writableWalletTokenAccounts.map((item) => publicKeyString(item).trim())
    : null;
  const writableAccounts = Array.isArray(audit.writableAccounts) ? audit.writableAccounts : null;
  if (!debits || !writableWalletTokens || !writableAccounts || writableAccounts.length === 0) {
    throw new Error("locally inspected swap audit must enumerate every writable account and wallet token debit");
  }
  if (writableAccounts.some((item) =>
    !publicKeyString(item?.address).trim() || item?.safe !== true || !String(item?.role || "").trim())) {
    throw new Error("locally inspected swap audit contains an unproven writable account");
  }
  const expectedSource = accountAddress(action);
  if (
    debits.length !== 1 ||
    publicKeyString(debits[0]?.tokenAccount).trim() !== expectedSource ||
    rawInteger(debits[0]?.rawAmount, "sourceAccountAudit.walletTokenDebits[0].rawAmount") !== rawInteger(action.rawAmount, "action.rawAmount") ||
    writableWalletTokens.length !== 1 ||
    new Set(writableWalletTokens).size !== 1 ||
    writableWalletTokens[0] !== expectedSource ||
    writableAccounts.filter((item) => publicKeyString(item.address).trim() === expectedSource && item.role === "wallet_source_token").length !== 1 ||
    writableAccounts.some((item) => item.walletOwnedTokenAccount === true && publicKeyString(item.address).trim() !== expectedSource)
  ) {
    throw new Error("locally inspected swap audit found an unrelated wallet token debit or writable token account");
  }

  const directSolTransfers = rawInteger(
    audit.directSolTransfersLamports ?? 0,
    "sourceAccountAudit.directSolTransfersLamports",
  );
  if (directSolTransfers !== 0n) {
    throw new Error("locally inspected swap audit contains a direct SOL transfer");
  }
  const networkFee = rawInteger(audit.networkFeeLamports, "sourceAccountAudit.networkFeeLamports");
  const rent = rawInteger(audit.rentLamports ?? 0, "sourceAccountAudit.rentLamports");
  const preparedEconomics = preparation?.economicAudit;
  if (!preparedEconomics || typeof preparedEconomics !== "object") {
    throw new Error("locally inspected swap audit omitted prepared-order economics");
  }
  const preparedWorstOut = rawInteger(
    preparedEconomics.worstOutLamports,
    "economicAudit.worstOutLamports",
  );
  if (
    rawInteger(preparedEconomics.networkFeeLamports, "economicAudit.networkFeeLamports") !== networkFee ||
    rawInteger(preparedEconomics.rentLamports, "economicAudit.rentLamports") !== rent
  ) {
    throw new Error("locally inspected swap audit economics do not match the prepared order");
  }
  const walletSetupRent = rawInteger(
    audit.walletSetupRentLamports ?? rent,
    "sourceAccountAudit.walletSetupRentLamports",
  );
  if (walletSetupRent > rent) {
    throw new Error("locally inspected swap audit found wallet setup rent above the provider-declared rent bound");
  }
  if (networkFee + rent > BigInt(policy.maxSwapNetworkFeeLamports)) {
    throw new Error("locally inspected swap audit exceeds the cleanup network-fee/rent policy");
  }
  // The quote adapter and prepared-order auditor are separate reads of a
  // moving priority-fee market. Accept only a newer order that is no more
  // expensive than the same absolute cleanup cap; never inherit a stale,
  // lower quote as an execution ceiling.
  const preparedWorstNet = preparedWorstOut > networkFee + rent
    ? preparedWorstOut - networkFee - rent
    : 0n;
  if (preparedWorstNet < BigInt(policy.minSwapNetLamports)) {
    throw new Error("locally inspected swap audit no longer meets the minimum net-output policy");
  }
}

/**
 * Execute an approved preview through injected wallet/RPC adapters. Execution is
 * opt-in, preflights raw balances, simulates every batch, halves failed batches,
 * and verifies two stable reads after swaps and closes.
 */
export async function executeTokenCleanup(plan, dependencies = {}, {
  execute = false,
  policy: policyOverrides = {},
  onTransactionConfirmed = null,
} = {}) {
  if (!plan || !Array.isArray(plan.actions)) throw new TypeError("a cleanup plan is required");
  if (!execute) {
    return { executed: false, preview: true, actions: plan.actions };
  }

  const actionable = plan.actions.filter((action) => action.action !== "keep");
  if (actionable.length === 0) return { executed: true, swaps: [], batches: [], failures: [] };
  const supportedActions = new Set(["close", "unwrap", "swap_then_close", "burn_then_close"]);
  const unsupported = actionable.find((action) => !supportedActions.has(action.action));
  if (unsupported) throw new TypeError(`unsupported cleanup action: ${unsupported.action}`);
  for (const action of actionable) assertBoundedLifecycleAction(action);

  requiredDependency(dependencies, "readAccount");
  const wait = typeof dependencies.wait === "function"
    ? dependencies.wait
    : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const deps = { ...dependencies, wait };
  const swapActions = actionable.filter((action) => action.action === "swap_then_close");
  const swapWalletPublicKey = publicKeyString(deps.walletPublicKey).trim();
  if (swapActions.length > 0) {
    requiredDependency(deps, "prepareSwap");
    requiredDependency(deps, "submitPreparedSwap");
    if (!swapWalletPublicKey) {
      throw new TypeError("walletPublicKey dependency is required to verify a cleanup swap source account");
    }
  }
  // A successful swap can always produce a source-account close, so batch adapters
  // are required whenever any action is executable.
  requiredDependency(deps, "measureBatch");
  requiredDependency(deps, "simulateBatch");
  requiredDependency(deps, "executeBatch");

  const policy = makeCleanupPolicy({ ...plan.policy, ...policyOverrides });
  const failures = [];
  const swaps = [];
  let batchActions = actionable.filter((action) => action.action !== "swap_then_close");

  // Swap sources are checked immediately before build and again before submit.
  // Avoid an earlier identical stable read that only delays post-close conversion.
  for (const action of batchActions) {
    const before = await readStableAccount(action, deps, policy);
    if (!before.exists) {
      failures.push({ action, stage: "preflight", error: "token account no longer exists" });
      continue;
    }
    const expectedAccountRaw = BigInt(action.provenance?.currentRawAmount ?? action.rawAmount);
    const validRaw = action.action === "close"
      ? before.rawAmount === 0n
      : before.rawAmount === expectedAccountRaw;
    if (!validRaw) {
      failures.push({
        action,
        stage: "preflight",
        error: `raw balance changed from ${expectedAccountRaw} to ${before.rawAmount}`,
      });
      continue;
    }
  }
  batchActions = batchActions.filter((action) => !failures.some((failure) => failure.action === action));

  for (const action of swapActions) {
    if (failures.some((failure) => failure.action === action)) continue;
    let failureStage = "preflight";
    try {
      // A prior preflight is only advisory. Re-read the exact account just
      // before invoking the adapter so no intervening balance/owner/mint/program
      // change can be swapped or signed over.
      const sourceImmediatelyBeforeBuild = await readStableAccount(action, deps, policy);
      exactSwapSource(action, sourceImmediatelyBeforeBuild, swapWalletPublicKey);
      const quote = assertEconomicSwapPolicy(action, policy);
      failureStage = "swap";
      const preparation = await deps.prepareSwap(action);
      if (!successful(preparation)) {
        const error = new Error(preparation?.error || "swap preparation failed");
        error.blocked = preparation?.blocked || null;
        throw error;
      }
      if (!preparation?.preparedSwap) throw new Error("swap adapter did not return a locally prepared swap for submission");
      assertLocallyInspectedSwapAudit(action, preparation, policy, quote);
      // A route may take time to construct. Re-read immediately before
      // submission, not merely before construction, so a changed source can
      // never be submitted under an earlier account observation.
      const sourceImmediatelyBeforeSubmit = await readStableAccount(action, deps, policy);
      exactSwapSource(action, sourceImmediatelyBeforeSubmit, swapWalletPublicKey);
      const result = await deps.submitPreparedSwap(preparation.preparedSwap, action);
      if (!successful(result)) {
        const error = new Error(result?.error || "swap execution failed");
        error.blocked = result?.blocked || null;
        throw error;
      }
      await confirmAndCheckpointResult(result, {
        confirmTransaction: deps.confirmTransaction,
        onTransactionConfirmed,
        phase: "swap",
        action,
      });
      const after = await readStableAccount(action, deps, policy);
      const retainedBaseline = BigInt(action.provenance?.initialRawAmount ?? 0);
      if (after.exists) {
        exactSwapSource(action, after, swapWalletPublicKey, { rawAmount: retainedBaseline.toString() });
      }
      if (after.exists && after.rawAmount !== retainedBaseline) {
        throw new Error(`swap left ${after.rawAmount} raw units; expected retained baseline ${retainedBaseline}`);
      }
      swaps.push({ action, result });
      if (after.exists && retainedBaseline === 0n) {
        batchActions.push({
          ...action,
          action: "close",
          reason: "post_swap_zero_balance",
          rawAmount: "0",
          // The source amount was bounded by confirmed lifecycle evidence and
          // the stable post-swap read above proved this exact account is zero.
          provenance: {
            ...action.provenance,
            attributableRawAmount: "0",
            currentRawAmount: "0",
            cleanupSwapRawAmount: action.rawAmount,
          },
        });
      }
    } catch (error) {
      failures.push({
        action,
        stage: failureStage,
        error: error.message,
        ...(error?.blocked ? { blocked: error.blocked } : {}),
      });
    }
  }

  const packed = await planCleanupBatches(batchActions, {
    measureBatch: deps.measureBatch,
    policy,
  });
  for (const rejected of packed.rejected) {
    failures.push({ action: rejected.action, stage: "batch_plan", error: rejected.reason });
  }

  const queue = [...packed.batches];
  const batches = [];
  while (queue.length > 0) {
    const batch = queue.shift();
    let simulation;
    try {
      simulation = await deps.simulateBatch(batch.actions);
    } catch (error) {
      simulation = { success: false, error: error.message };
    }
    if (!successful(simulation)) {
      if (batch.actions.length > 1) {
        const middle = Math.ceil(batch.actions.length / 2);
        const splitBatches = [];
        for (const half of [batch.actions.slice(0, middle), batch.actions.slice(middle)]) {
          const split = await planCleanupBatches(half, {
            measureBatch: deps.measureBatch,
            policy,
          });
          splitBatches.push(...split.batches);
          for (const rejected of split.rejected) {
            failures.push({ action: rejected.action, stage: "batch_plan", error: rejected.reason });
          }
        }
        queue.unshift(...splitBatches);
      } else {
        failures.push({
          action: batch.actions[0],
          stage: "simulation",
          error: simulation?.error || "simulation failed",
        });
      }
      continue;
    }

    try {
      const result = await deps.executeBatch(batch.actions);
      if (!successful(result)) throw new Error(result?.error || "batch execution failed");
      await confirmAndCheckpointResult(result, {
        confirmTransaction: deps.confirmTransaction,
        onTransactionConfirmed,
        phase: "cleanup",
        actions: batch.actions,
      });
      const verification = [];
      for (const action of batch.actions) {
        const after = await readStableAccount(action, deps, policy);
        if (after.exists) throw new Error(`account ${action.tokenAccount} still exists after cleanup`);
        verification.push(action.tokenAccount);
      }
      batches.push({ ...batch, result, verifiedClosed: verification });
    } catch (error) {
      for (const action of batch.actions) {
        failures.push({ action, stage: "batch_execution", error: error.message });
      }
    }
  }

  return { executed: true, swaps, batches, failures };
}

export const executeCleanupPlan = executeTokenCleanup;
