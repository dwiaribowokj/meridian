import crypto from "node:crypto";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAccount,
  getExtensionTypes,
  getTransferFeeAmount,
} from "@solana/spl-token";
import bs58 from "bs58";
import { config, isEffectiveDryRun } from "./config.js";
import { getTrackedPositions } from "./state.js";
import {
  CLEANUP_SWAP_SOURCE_BINDING_BLOCKER,
  prepareSourceAccountBoundCleanupSwap,
  submitPreparedSourceAccountBoundCleanupSwap,
  getWalletBalances,
  getWalletPublicKey,
  quoteTokenSwap,
} from "./tools/wallet.js";
import {
  checkpointCleanupExecution,
  acquireLifecycleOperation,
  checkpointLifecycleOperationSignature,
  completeLifecycleOperation,
  finalizeLifecycle,
  finalizeLifecycleOperation,
  getCheckpointedCleanupTransactions,
  getCloseLifecycleReason,
  getLifecycleOperationRecoveryEvidence,
  getTradeLedger,
  lifecycleIdForPosition,
  recordLifecycleTransactions,
  reconcileConfirmedManualCleanupSwap,
  releaseLifecycleOperation,
} from "./ledger-runtime.js";
import { recordCircuitBreakerEvent } from "./breaker-runtime.js";
import { settlementCircuitBreakerEventId } from "./circuit-breaker.js";
import {
  buildTokenCleanupInstructions,
  executeTokenCleanup,
  planTokenCleanup,
} from "./tools/token-cleanup.js";
import { log } from "./logger.js";

let connection = null;
let signer = null;
let cleanupExecutionCapability = null;

function assertCapabilityObject(capability, label) {
  if (!capability || typeof capability !== "object") {
    throw new TypeError(`${label} must be a non-null object capability`);
  }
}

/**
 * Bind the one in-process authority allowed to request cleanup execution.
 * The executor owns the object; this runtime retains only its identity.
 */
export function registerCleanupExecutionCapability(capability) {
  assertCapabilityObject(capability, "Cleanup execution capability");
  if (cleanupExecutionCapability == null) {
    cleanupExecutionCapability = capability;
    return;
  }
  if (cleanupExecutionCapability !== capability) {
    throw new Error("Cleanup execution capability is already registered and cannot be replaced");
  }
}

function hasCleanupExecutionCapability(capability) {
  return cleanupExecutionCapability != null && capability === cleanupExecutionCapability;
}

function cleanupExecutionCapabilityBlocked() {
  return {
    success: false,
    blocked: "CLEANUP_EXECUTION_CAPABILITY_REQUIRED",
    execution: { executed: false, blocked: "CLEANUP_EXECUTION_CAPABILITY_REQUIRED" },
    reconciliation: { complete: false, blocked: "CLEANUP_EXECUTION_CAPABILITY_REQUIRED" },
  };
}

function cleanupDryRunBlocked() {
  return {
    success: false,
    blocked: "DRY_RUN_NO_CLEANUP_EXECUTION",
    execution: { executed: false, dry_run: true },
    reconciliation: { complete: false, blocked: "DRY_RUN_NO_CLEANUP_EXECUTION" },
  };
}

function getConnection() {
  if (!connection) connection = new Connection(process.env.RPC_URL || config.pnl.rpcUrl, "confirmed");
  return connection;
}

function getSigner() {
  if (!signer) {
    if (!process.env.WALLET_PRIVATE_KEY) throw new Error("WALLET_PRIVATE_KEY not set");
    signer = Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY));
  }
  return signer;
}

function cleanupPolicy() {
  return {
    minSwapNetLamports: String(config.cleanup.minSwapNetLamports),
    maxSwapNetworkFeeLamports: String(config.cleanup.maxNetworkFeeLamports),
    maxSwapPriceImpactBps: String(Math.round(config.cleanup.maxPriceImpactPct * 100)),
    maxBurnMarkedValueLamportsPerMint: String(config.cleanup.burnCapPerMintLamports),
    minBurnRentAdvantageLamports: String(config.cleanup.minRentRecoveryLamports),
    maxBurnMarkedValueLamportsPerSweep: String(config.cleanup.burnCapPerSweepLamports),
    maxBatchFeeLamports: String(config.cleanup.maxBatchFeeLamports),
    maxBurnClosePerBatch: config.cleanup.maxBurnClosePerBatch,
    maxCloseOnlyPerBatch: config.cleanup.maxCloseOnlyPerBatch,
    maxSerializedBytes: config.cleanup.maxSerializedBytes,
  };
}

function liveCleanupPolicyFromDependencies(dependencies = {}) {
  return { ...cleanupPolicy(), ...(dependencies.policy || {}) };
}

function liveCleanupExecutionDependencies(dependencies = null) {
  return dependencies
    ? { ...defaultExecutionDependencies(), ...dependencies }
    : defaultExecutionDependencies();
}

function lifecycleContexts({
  store = getTradeLedger(),
  getPositions = getTrackedPositions,
} = {}) {
  const contexts = [];
  for (const position of getPositions(false) || []) {
    const mint = position.base_mint || position.signal_snapshot?.base_mint;
    if (!position?.position || !mint) continue;
    const lifecycle = store.getLifecycle(lifecycleIdForPosition(position.position));
    if (!lifecycle || !["CLEANUP_PENDING", "RECONCILIATION_REQUIRED"].includes(lifecycle.state)) continue;
    contexts.push({
      position: position.position,
      mint: String(mint),
      lifecycleId: lifecycle.lifecycle_id,
      lifecycleState: lifecycle.state,
      closedAt: position.closed_at || lifecycle.created_at,
    });
  }
  return contexts;
}

/**
 * Return only lifecycle rows that routine automation may safely revisit.
 * RECONCILIATION_REQUIRED and latched rows always remain operator-owned.
 */
export function listPendingCleanupLifecycles({ store = getTradeLedger() } = {}) {
  const lifecycles = store.listLifecycles();
  if (!Array.isArray(lifecycles)) throw new TypeError("Trade ledger lifecycle listing is unavailable");
  return lifecycles
    .filter((lifecycle) => (
      lifecycle?.state === "CLEANUP_PENDING" &&
      lifecycle?.reconciliation_latched === false
    ))
    .map((lifecycle) => ({
      lifecycle_id: String(lifecycle.lifecycle_id || ""),
      position: String(lifecycle.position_address || ""),
      created_at: lifecycle.created_at || null,
      state: lifecycle.state,
      reconciliation_latched: lifecycle.reconciliation_latched,
    }))
    .sort((left, right) => (
      String(left.created_at || "").localeCompare(String(right.created_at || "")) ||
      left.position.localeCompare(right.position)
    ));
}

function openPositionMints({ getPositions = getTrackedPositions } = {}) {
  return new Set((getPositions(true) || []).map((position) =>
    position.base_mint || position.signal_snapshot?.base_mint).filter(Boolean).map(String));
}

function rawTokenAmount(value) {
  const text = String(value ?? "");
  if (!/^\d+$/.test(text)) return null;
  return BigInt(text);
}

function signedRawTokenAmount(value) {
  const text = String(value ?? "");
  if (!/^-?\d+$/.test(text)) return null;
  return BigInt(text);
}

function lifecycleReference(references, accountAddress, lifecycleId) {
  const address = String(accountAddress || "");
  if (!address) return null;
  const reference = references.get(address) || {
    lifecycleIds: new Set(),
    evidenceByLifecycle: new Map(),
    incompleteLifecycleIds: new Set(),
  };
  reference.lifecycleIds.add(String(lifecycleId));
  references.set(address, reference);
  return reference;
}

function exactEvidenceFromEvent(event, evidence) {
  const account = String(evidence?.account || "");
  const mint = String(evidence?.mint || "");
  const pre = rawTokenAmount(evidence?.pre_raw_amount);
  const post = rawTokenAmount(evidence?.post_raw_amount);
  const raw = signedRawTokenAmount(evidence?.raw_amount);
  if (!account || !mint || pre == null || post == null || raw == null || post - pre !== raw) return null;
  const matchingDeltas = (event.token_deltas || []).filter((delta) =>
    String(delta?.account || "") === account && String(delta?.mint || "") === mint);
  // A non-zero observation must exactly match the normalized authoritative
  // delta. A zero observation is valid only if no conflicting delta exists.
  if ((raw === 0n && matchingDeltas.length > 0) ||
      (raw !== 0n && !matchingDeltas.some((delta) => signedRawTokenAmount(delta?.raw_amount) === raw))) {
    return null;
  }
  return { account, mint, pre, post, raw };
}

/**
 * Build an exact lifecycle balance invariant from confirmed ledger entries.
 * A token account is actionable only when all recorded observations start at
 * zero, form an uninterrupted sequence, and end at its current raw balance.
 * Address occurrence, mint equality, historical ledger entries without raw
 * pre/post evidence, and any multi-lifecycle reference all fail closed.
 */
export function lifecycleAccountProvenance(contexts = [], store = getTradeLedger()) {
  const contextById = new Map(contexts.map((context) => [context.lifecycleId, context]));
  const references = new Map();
  const events = store.readEvents();
  for (let eventIndex = 0; eventIndex < events.length; eventIndex++) {
    const event = events[eventIndex];
    if (event.event_type !== "transaction_recorded") continue;
    const lifecycleId = String(event.lifecycle_id || "");
    if (!lifecycleId) continue;
    const detailedAddresses = new Set();
    for (const evidence of event.metadata?.token_account_evidence || []) {
      const address = String(evidence?.account || "");
      if (!address) continue;
      detailedAddresses.add(address);
      const reference = lifecycleReference(references, address, lifecycleId);
      const exact = exactEvidenceFromEvent(event, evidence);
      if (!exact || !["confirmed", "finalized"].includes(event.commitment)) {
        reference.incompleteLifecycleIds.add(lifecycleId);
        continue;
      }
      const observations = reference.evidenceByLifecycle.get(lifecycleId) || [];
      observations.push({
        ...exact,
        signature: String(event.signature || ""),
        eventIndex,
      });
      reference.evidenceByLifecycle.set(lifecycleId, observations);
    }
    // Old ledger entries contain only delta/address fields. They must still
    // count as a lifecycle reference (including conflicts), but can never
    // establish exact ownership after this hardening.
    for (const delta of event.token_deltas || []) {
      const address = String(delta?.account || "");
      if (!address) continue;
      const reference = lifecycleReference(references, address, lifecycleId);
      if (!detailedAddresses.has(address)) reference.incompleteLifecycleIds.add(lifecycleId);
    }
  }
  return {
    forAccount(address, { mint, rawAmount } = {}) {
      const accountAddress = String(address || "");
      const lifecycleReferenceForAccount = references.get(accountAddress);
      const current = rawTokenAmount(rawAmount);
      if (current == null) {
        return {
          provenance: null,
          ambiguity: { reason: "INVALID_CURRENT_RAW_BALANCE", lifecycleIds: [] },
        };
      }
      if (!lifecycleReferenceForAccount) {
        return {
          provenance: null,
          ambiguity: { reason: "NO_CONFIRMED_LIFECYCLE_TOKEN_EVIDENCE", lifecycleIds: [] },
        };
      }
      const lifecycleIds = lifecycleReferenceForAccount.lifecycleIds;
      const eligibleLifecycleIds = [...lifecycleIds].filter((id) => contextById.has(id));
      if (eligibleLifecycleIds.length !== 1) {
        return {
          provenance: null,
          ambiguity: {
            reason: eligibleLifecycleIds.length > 1
              ? "MULTIPLE_CLEANUP_ELIGIBLE_LIFECYCLE_REFERENCES"
              : "LIFECYCLE_NOT_CLEANUP_ELIGIBLE",
            lifecycleIds: [...lifecycleIds].sort(),
          },
        };
      }
      const lifecycleId = eligibleLifecycleIds[0];
      const context = contextById.get(lifecycleId);
      // Historical settled lifecycles may share the wallet ATA and form the
      // retained baseline. They are not competing cleanup owners, but every
      // reference still needs exact confirmed evidence before it can be
      // treated as harmless history.
      if ([...lifecycleIds].some((id) => lifecycleReferenceForAccount.incompleteLifecycleIds.has(id))) {
        return {
          provenance: null,
          ambiguity: {
            reason: "INCOMPLETE_CONFIRMED_TOKEN_EVIDENCE",
            lifecycleIds: [...lifecycleIds].sort(),
          },
        };
      }
      const observations = lifecycleReferenceForAccount.evidenceByLifecycle.get(lifecycleId) || [];
      if (observations.length === 0 || observations.some((item) => item.mint !== String(mint || ""))) {
        return {
          provenance: null,
          ambiguity: { reason: "TOKEN_MINT_EVIDENCE_MISMATCH", lifecycleIds: [lifecycleId] },
        };
      }
      const initial = observations[0].pre;
      let expected = initial;
      let attributable = 0n;
      for (const observation of observations) {
        if (observation.pre !== expected) {
          return {
            provenance: null,
            ambiguity: {
              reason: "NONCONTIGUOUS_LIFECYCLE_TOKEN_EVIDENCE",
              lifecycleIds: [lifecycleId],
            },
          };
        }
        attributable += observation.raw;
        if (attributable < 0n) {
          return {
            provenance: null,
            ambiguity: {
              reason: observation === observations[0]
                ? "PREEXISTING_OR_UNOBSERVED_BALANCE"
                : "LIFECYCLE_DELTA_OVERDRAWN",
              lifecycleIds: [lifecycleId],
            },
          };
        }
        expected = observation.post;
      }
      if (expected !== current || initial + attributable !== current) {
        return {
          provenance: null,
          ambiguity: {
            reason: "CURRENT_BALANCE_NOT_EXACTLY_ATTRIBUTABLE",
            lifecycleIds: [lifecycleId],
            attributableRawAmount: attributable.toString(),
            currentRawAmount: current.toString(),
          },
        };
      }
      return {
        provenance: {
          source: "bot_lifecycle",
          lifecycleId,
          evidence: "confirmed_lifecycle_token_delta",
          accountAddress,
          mint: String(mint),
          initialRawAmount: initial.toString(),
          attributableRawAmount: attributable.toString(),
          currentRawAmount: current.toString(),
          exclusive: initial === 0n,
          transactionSignatures: [...new Set(observations.map((item) => item.signature).filter(Boolean))],
        },
        ambiguity: null,
      };
    },
  };
}

async function token2022Inspection(address, { connection: rpc = getConnection() } = {}) {
  try {
    const account = await getAccount(rpc, new PublicKey(address), "confirmed", TOKEN_2022_PROGRAM_ID);
    return {
      inspected: true,
      extensions: getExtensionTypes(account.tlvData || new Uint8Array()).map(String),
      withheldAmountRaw: String(getTransferFeeAmount(account)?.withheldAmount || 0n),
    };
  } catch {
    return { inspected: false, extensions: ["uninspected"], withheldAmountRaw: "0" };
  }
}

function tokenValueMark(walletToken, wallet, rawAmount, decimals) {
  wallet ||= {};
  const aggregateBalance = Number(walletToken?.balance || 0);
  const aggregateValueSol = wallet.sol_price > 0 && Number.isFinite(Number(walletToken?.usd_raw))
    ? Number(walletToken.usd_raw) / wallet.sol_price
    : null;
  const humanAmount = Number(rawAmount) / 10 ** decimals;
  if (!(aggregateBalance > 0) || !(aggregateValueSol >= 0) || !Number.isFinite(humanAmount)) {
    return { markedValueLamports: "0", valuationAvailable: false };
  }
  return {
    markedValueLamports: String(Math.max(0, Math.round(aggregateValueSol * (humanAmount / aggregateBalance) * 1e9))),
    valuationAvailable: true,
  };
}

function cleanupWalletPublicKey(walletPublicKey = null) {
  const candidate = walletPublicKey || process.env.WALLET_PUBLIC_KEY || null;
  if (candidate) {
    try {
      return candidate instanceof PublicKey ? candidate : new PublicKey(candidate);
    } catch {
      throw new TypeError("WALLET_PUBLIC_KEY must be a valid Solana public key");
    }
  }
  // Signing authority is a fallback for execution compatibility only. Preview
  // callers can provide an address above and never load a private key.
  return getSigner().publicKey;
}

/**
 * Scan both SPL Token programs using an explicit public owner when supplied.
 * Dependencies are injectable so previews and provenance tests do not require
 * a signer or make live RPC calls.
 */
export async function scanCleanupAccounts({
  walletPublicKey = null,
  dependencies = {},
} = {}) {
  const owner = cleanupWalletPublicKey(walletPublicKey || dependencies.walletPublicKey);
  const rpc = dependencies.connection || getConnection();
  const readWalletBalances = dependencies.getWalletBalances || getWalletBalances;
  const getPositions = dependencies.getTrackedPositions || getTrackedPositions;
  const store = dependencies.store || getTradeLedger();
  const inspectToken2022 = dependencies.inspectToken2022 || ((address) => token2022Inspection(address, { connection: rpc }));
  const now = typeof dependencies.now === "function" ? dependencies.now : () => new Date().toISOString();
  const programs = [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID];
  const [wallet, ...programResults] = await Promise.all([
    readWalletBalances(owner.toString()),
    ...programs.map((programId) => rpc.getParsedTokenAccountsByOwner(owner, { programId }, "confirmed")),
  ]);
  const walletTokenByMint = new Map((wallet?.tokens || []).map((token) => [token.mint, token]));
  const contexts = lifecycleContexts({ store, getPositions });
  const accountProvenance = lifecycleAccountProvenance(contexts, store);
  const openMints = openPositionMints({ getPositions });
  const accounts = [];

  for (let programIndex = 0; programIndex < programResults.length; programIndex++) {
    const programId = programs[programIndex];
    for (const entry of programResults[programIndex].value || []) {
      const parsed = entry.account.data?.parsed?.info || {};
      const tokenAmount = parsed.tokenAmount || {};
      const mint = String(parsed.mint || "");
      const rawAmount = String(tokenAmount.amount || "0");
      const decimals = Number(tokenAmount.decimals ?? 0);
      const attribution = accountProvenance.forAccount(entry.pubkey.toString(), { mint, rawAmount });
      const provenance = attribution.provenance;
      const context = provenance ? contexts.find((candidate) => candidate.lifecycleId === provenance.lifecycleId) : null;
      const closeAuthority = parsed.closeAuthority || null;
      const mark = tokenValueMark(walletTokenByMint.get(mint), wallet, rawAmount, decimals);
      const token2022 = programId.equals(TOKEN_2022_PROGRAM_ID)
        ? await inspectToken2022(entry.pubkey)
        : { inspected: true, extensions: [], withheldAmountRaw: "0" };
      accounts.push({
        tokenAccount: entry.pubkey.toString(),
        mint,
        programId: programId.toString(),
        rawAmount,
        decimals,
        owner: parsed.owner || null,
        ownerIsWallet: parsed.owner === owner.toString(),
        closeAuthority,
        closeAuthorityIsWallet: !closeAuthority || closeAuthority === owner.toString(),
        delegate: parsed.delegate || null,
        // Positive Token-2022 balances require a supported extension
        // inspection before they can be burned.
        frozen: String(parsed.state || "").toLowerCase() === "frozen" || !token2022.inspected,
        state: parsed.state,
        withheldAmountRaw: token2022.withheldAmountRaw,
        extensions: token2022.extensions,
        inUseByOpenPosition: openMints.has(mint),
        pendingLifecycleAction: false,
        provenance,
        provenanceAmbiguity: attribution.ambiguity,
        markedValueLamports: mark.markedValueLamports,
        markedAt: context?.closedAt || now(),
        valuationAvailable: mark.valuationAvailable,
        rentLamports: String(entry.account.lamports || 0),
        burnCloseFeeLamports: String(config.cleanup.maxBatchFeeLamports),
      });
    }
  }
  return {
    wallet: owner.toString(),
    accounts,
    lifecycleContexts: contexts,
    scannedPrograms: ["token", "token2022"],
    scannedAt: now(),
  };
}

function lifecyclePreviewContext(snapshot, position) {
  const context = snapshot.lifecycleContexts.find((candidate) => candidate.position === position);
  if (!context) return { context: null, accounts: [], blocked: "CLEANUP_LIFECYCLE_NOT_PENDING" };
  const provenanceAmbiguity = snapshot.accounts.find((account) =>
    account.provenanceAmbiguity?.lifecycleIds?.includes(context.lifecycleId));
  if (provenanceAmbiguity) {
    return {
      context,
      accounts: [],
      blocked: "CLEANUP_PROVENANCE_AMBIGUITY",
      tokenAccount: provenanceAmbiguity.tokenAccount,
      provenanceAmbiguity: provenanceAmbiguity.provenanceAmbiguity,
    };
  }
  // A positive account sharing this lifecycle mint without the exact balance
  // invariant cannot be assigned to the lifecycle merely because the mint is
  // equal. Keep it untouched and refuse to settle past the ambiguity.
  const unknownPositive = snapshot.accounts.find((account) =>
    account.mint === context.mint &&
    String(account.rawAmount) !== "0" &&
    account.provenance?.lifecycleId !== context.lifecycleId);
  if (unknownPositive) {
    return {
      context,
      accounts: [],
      blocked: "UNATTRIBUTED_POSITIVE_LIFECYCLE_MINT_ACCOUNT",
      tokenAccount: unknownPositive.tokenAccount,
    };
  }
  return {
    context,
    accounts: snapshot.accounts.filter((account) => account.provenance?.lifecycleId === context.lifecycleId),
    blocked: null,
  };
}

function quoteCacheAdapter(quoteSwap = quoteTokenSwap) {
  const cache = new Map();
  return async ({ mint, rawAmount }) => {
    const key = `${mint}:${rawAmount}`;
    if (!cache.has(key)) {
      cache.set(key, quoteSwap({ input_mint: mint, output_mint: "SOL", amount_raw: rawAmount, use_referral: false }));
    }
    const quote = await cache.get(key);
    return quote.routeFound === true ? quote : { routeFound: false };
  };
}

/** A preview never submits a transaction. Supplying position scopes the plan to
 * one ledger lifecycle so a cleanup transaction can never be attributed to
 * multiple positions. */
export async function previewEconomicCleanup({
  position = null,
  walletPublicKey = null,
  dependencies = {},
} = {}) {
  const snapshot = await scanCleanupAccounts({ walletPublicKey, dependencies });
  const scope = position ? lifecyclePreviewContext(snapshot, position) : {
    context: null,
    accounts: snapshot.accounts,
    blocked: null,
  };
  if (scope.blocked) return { ...snapshot, ...scope, plan: null };
  const planOptions = {
    policy: dependencies.policy || cleanupPolicy(),
    quoteSwap: quoteCacheAdapter(dependencies.quoteSwap || quoteTokenSwap),
  };
  if (dependencies.nowMs != null) planOptions.now = dependencies.nowMs;
  const plan = await planTokenCleanup(scope.accounts, planOptions);
  return { ...snapshot, ...scope, plan };
}

function pendingCleanupAccountEquity(action, account, {
  conservativeCloseFeeLamports,
  walletCountedMints,
} = {}) {
  const rawAmount = rawLamports(account?.rawAmount, "account.rawAmount");
  const rent = rawLamports(account?.rentLamports, "account.rentLamports");
  const closeFee = rawLamports(conservativeCloseFeeLamports, "conservativeCloseFeeLamports");
  const mint = String(account?.mint || action?.mint || "");
  let tokenValue = 0n;
  let reserveCloseFee = false;

  switch (action?.action) {
    case "swap_then_close":
      if (action.quote?.routeFound !== true || action.quote?.worstNetLamports == null) {
        return { ok: false, reason: "SWAP_RESIDUE_QUOTE_UNAVAILABLE" };
      }
      tokenValue = rawLamports(action.quote.worstNetLamports, "action.quote.worstNetLamports");
      reserveCloseFee = true;
      break;
    case "unwrap":
      // Wrapped SOL raw units are lamports. Its token value is not part of the
      // native wallet balance used by calculateCanaryEquitySol.
      tokenValue = rawAmount;
      reserveCloseFee = true;
      break;
    case "burn_then_close":
    case "close":
      // A burn plan deliberately treats the token mark as expendable. Count
      // only the rent that its successful cleanup can return to native SOL.
      reserveCloseFee = true;
      break;
    case "keep":
      if (rawAmount > 0n && !walletCountedMints.has(mint)) {
        if (action.quote?.routeFound !== true || action.quote?.worstNetLamports == null) {
          return { ok: false, reason: "RETAINED_RESIDUE_VALUE_NOT_DEFENSIBLE" };
        }
        tokenValue = rawLamports(action.quote.worstNetLamports, "action.quote.worstNetLamports");
      }
      // Keep actions may settle with defensibly marked residue still present,
      // so no hypothetical close fee is charged to them.
      break;
    default:
      return { ok: false, reason: `UNSUPPORTED_CLEANUP_ACTION_${String(action?.action || "MISSING").toUpperCase()}` };
  }

  const gross = tokenValue + rent;
  const fee = reserveCloseFee ? closeFee : 0n;
  return {
    ok: true,
    valueLamports: gross > fee ? gross - fee : 0n,
    tokenValueLamports: tokenValue,
    rentLamports: rent,
    reservedCloseFeeLamports: fee,
  };
}

/**
 * Convert one fresh scoped cleanup plan into a conservative native-SOL mark.
 * Unknown positive residue never becomes a zero: callers receive transient
 * valuation uncertainty and must avoid persisting it as a financial loss.
 */
export function derivePendingCleanupEquity({
  accounts = [],
  plan,
  conservativeCloseFeeLamports = String(config.cleanup.maxBatchFeeLamports),
  walletCountedMints = [config.tokens.USDC, config.tokens.USDT],
} = {}) {
  if (!Array.isArray(accounts) || !plan || !Array.isArray(plan.actions)) {
    return { ok: false, reason: "CLEANUP_PREVIEW_REQUIRED" };
  }
  if (accounts.length !== plan.actions.length) {
    return { ok: false, reason: "CLEANUP_PLAN_ACCOUNT_MISMATCH" };
  }
  const accountsByAddress = new Map(accounts.map((account) => [String(account?.tokenAccount || ""), account]));
  const countedMints = new Set((walletCountedMints || []).filter(Boolean).map(String));
  let total = 0n;
  const values = [];
  for (const action of plan.actions) {
    const tokenAccount = String(action?.tokenAccount || "");
    const account = accountsByAddress.get(tokenAccount);
    if (!tokenAccount || !account) {
      return { ok: false, reason: "CLEANUP_PLAN_ACCOUNT_MISMATCH", token_account: tokenAccount || null };
    }
    let value;
    try {
      value = pendingCleanupAccountEquity(action, account, {
        conservativeCloseFeeLamports,
        walletCountedMints: countedMints,
      });
    } catch (error) {
      return { ok: false, reason: `INVALID_CLEANUP_ECONOMICS: ${error.message}`, token_account: tokenAccount };
    }
    if (!value.ok) return { ...value, token_account: tokenAccount, action: action.action };
    total += value.valueLamports;
    values.push({
      token_account: tokenAccount,
      mint: String(action.mint || account.mint || ""),
      action: action.action,
      value_lamports: value.valueLamports.toString(),
      token_value_lamports: value.tokenValueLamports.toString(),
      rent_lamports: value.rentLamports.toString(),
      reserved_close_fee_lamports: value.reservedCloseFeeLamports.toString(),
    });
  }
  return { ok: true, total_lamports: total.toString(), accounts: values };
}

/**
 * Scan both SPL programs once, then build a fresh lifecycle-scoped quote and
 * conservative equity mark for every eligible CLEANUP_PENDING lifecycle.
 */
export async function previewPendingCleanupEquity({
  walletPublicKey = null,
  lifecycles = null,
  dependencies = {},
} = {}) {
  const store = dependencies.store || getTradeLedger();
  const eligible = lifecycles ?? listPendingCleanupLifecycles({ store });
  if (!Array.isArray(eligible)) return { ok: false, reason: "PENDING_CLEANUP_LIFECYCLES_UNAVAILABLE" };
  if (eligible.length === 0) {
    return { ok: true, total_lamports: "0", total_sol: 0, lifecycle_count: 0, positions: [] };
  }
  const malformed = eligible.find((lifecycle) => !String(lifecycle?.position || ""));
  if (malformed) return { ok: false, reason: "PENDING_CLEANUP_POSITION_UNAVAILABLE" };

  const snapshot = await scanCleanupAccounts({ walletPublicKey, dependencies });
  const quoteSwap = quoteCacheAdapter(dependencies.quoteSwap || quoteTokenSwap);
  const positions = [];
  let total = 0n;
  for (const lifecycle of eligible) {
    const scope = lifecyclePreviewContext(snapshot, lifecycle.position);
    if (scope.blocked) {
      return {
        ok: false,
        reason: `${scope.blocked} for ${lifecycle.position}`,
        blocked: scope.blocked,
        position: lifecycle.position,
      };
    }
    const planOptions = {
      policy: dependencies.policy || cleanupPolicy(),
      quoteSwap,
    };
    if (dependencies.nowMs != null) planOptions.now = dependencies.nowMs;
    const plan = await planTokenCleanup(scope.accounts, planOptions);
    const equity = derivePendingCleanupEquity({
      accounts: scope.accounts,
      plan,
      conservativeCloseFeeLamports: String(
        dependencies.conservativeCloseFeeLamports ?? config.cleanup.maxBatchFeeLamports,
      ),
    });
    if (!equity.ok) {
      return {
        ...equity,
        reason: `${equity.reason} for ${lifecycle.position}`,
        position: lifecycle.position,
      };
    }
    const value = BigInt(equity.total_lamports);
    total += value;
    positions.push({
      lifecycle_id: lifecycle.lifecycle_id,
      position: lifecycle.position,
      value_lamports: value.toString(),
      accounts: equity.accounts,
    });
  }
  return {
    ok: true,
    total_lamports: total.toString(),
    total_sol: Number(total) / 1e9,
    lifecycle_count: positions.length,
    positions,
    scanned_at: snapshot.scannedAt,
    scanned_programs: snapshot.scannedPrograms,
  };
}

function rawLamports(value, field) {
  const text = String(value ?? "");
  if (!/^\d+$/.test(text)) throw new TypeError(`${field} must be a non-negative integer lamport string`);
  return BigInt(text);
}

/**
 * Build terminal valuation only from a fresh, per-lifecycle scan. Positive
 * residue may be retained only when a current conservative swap quote values
 * it; unknown, blocked, or executable residue leaves the lifecycle pending.
 */
export function deriveCleanupTerminalEconomics({
  accounts = [],
  plan,
  execution = null,
  scannedPrograms = ["token", "token2022"],
  scannedAt = new Date().toISOString(),
} = {}) {
  if (!plan || !Array.isArray(plan.actions)) {
    return { complete: false, blocked: "CLEANUP_PLAN_REQUIRED" };
  }
  if (!Array.isArray(accounts)) return { complete: false, blocked: "CLEANUP_ACCOUNT_SNAPSHOT_REQUIRED" };
  const relevantFailures = (execution?.failures || []).filter((failure) =>
    accounts.some((account) => account.tokenAccount === failure?.action?.tokenAccount));
  if (execution?.executed === true && relevantFailures.length > 0) {
    return { complete: false, blocked: "CLEANUP_EXECUTION_FAILED" };
  }

  const actions = new Map(plan.actions.map((action) => [action.tokenAccount, action]));
  const actionable = plan.actions.filter((action) => action.action !== "keep");
  if (actionable.length > 0 && execution?.executed !== true) {
    return { complete: false, blocked: "CLEANUP_EXECUTION_REQUIRED", actionable: actionable.length };
  }

  let residual = 0n;
  let reclaimableRent = 0n;
  const retained = [];
  for (const account of accounts) {
    const action = actions.get(account.tokenAccount);
    if (!action) return { complete: false, blocked: "CLEANUP_PLAN_ACCOUNT_MISMATCH" };
    const rawAmount = rawLamports(account.rawAmount, "account.rawAmount");
    if (action.action !== "keep") {
      return { complete: false, blocked: "ACTIONABLE_ACCOUNT_REMAINS", tokenAccount: account.tokenAccount };
    }
    if (rawAmount === 0n) {
      return { complete: false, blocked: "ZERO_BALANCE_ACCOUNT_NOT_CLOSED", tokenAccount: account.tokenAccount };
    }
    const quote = action.quote;
    if (quote?.routeFound !== true || quote.worstNetLamports == null) {
      return { complete: false, blocked: "RESIDUAL_VALUE_NOT_DEFENSIBLE", tokenAccount: account.tokenAccount, reason: action.reason };
    }
    const markedValue = rawLamports(quote.worstNetLamports, "action.quote.worstNetLamports");
    const rent = rawLamports(account.rentLamports, "account.rentLamports");
    residual += markedValue;
    reclaimableRent += rent;
    retained.push({
      tokenAccount: account.tokenAccount,
      mint: account.mint,
      raw_amount: rawAmount.toString(),
      marked_value_lamports: markedValue.toString(),
      reclaimable_rent_lamports: rent.toString(),
      reason: action.reason,
    });
  }

  const executionState = execution?.executed === true ? "completed" : "not_required";
  return {
    complete: true,
    residualTokenValueLamports: residual.toString(),
    reclaimableRentLamports: reclaimableRent.toString(),
    retained,
    terminalEconomics: {
      source: "economic_cleanup_reconciliation",
      snapshot_at: scannedAt,
      scanned_programs: [...new Set(scannedPrograms.map(String))],
      execution_state: executionState,
      economic_complete: true,
      residual_account_count: retained.length,
      residual_token_value_lamports: residual.toString(),
      reclaimable_rent_lamports: reclaimableRent.toString(),
    },
  };
}

async function buildBatchTransaction(actions) {
  const wallet = getSigner();
  const transaction = new Transaction();
  for (const action of actions) {
    transaction.add(...buildTokenCleanupInstructions(action, {
      owner: wallet.publicKey,
      closeAuthority: action.closeAuthority || wallet.publicKey,
      destination: wallet.publicKey,
    }));
  }
  transaction.feePayer = wallet.publicKey;
  transaction.recentBlockhash = (await getConnection().getLatestBlockhash("confirmed")).blockhash;
  return transaction;
}

function defaultExecutionDependencies() {
  const wallet = getSigner();
  return {
    walletPublicKey: wallet.publicKey.toBase58(),
    readAccount: async (action) => {
      const info = await getConnection().getParsedAccountInfo(new PublicKey(action.tokenAccount), "confirmed");
      if (!info.value) return { exists: false };
      const parsed = info.value.data?.parsed?.info || {};
      return {
        exists: true,
        tokenAccount: action.tokenAccount,
        rawAmount: parsed.tokenAmount?.amount || "0",
        owner: parsed.owner || "",
        mint: parsed.mint || "",
        programId: info.value.owner?.toBase58?.() || String(info.value.owner || ""),
      };
    },
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    // The provider selects by mint, but the locally decoded message and its
    // RPC simulation must prove the exact lifecycle source account before the
    // adapter returns anything signable. Execution still re-reads that source
    // immediately before submit.
    prepareSwap: (action) => prepareSourceAccountBoundCleanupSwap(action, {
      connection: getConnection(),
      wallet,
    }),
    submitPreparedSwap: (preparedSwap) => submitPreparedSourceAccountBoundCleanupSwap(preparedSwap, { wallet }),
    measureBatch: async (actions) => {
      const tx = await buildBatchTransaction(actions);
      const message = tx.compileMessage();
      const fee = await getConnection().getFeeForMessage(message, "confirmed");
      const serializedBytes = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length;
      return { serializedBytes, feeLamports: fee.value ?? 5_000 };
    },
    simulateBatch: async (actions) => {
      const tx = await buildBatchTransaction(actions);
      tx.sign(wallet);
      const result = await getConnection().simulateTransaction(tx, [wallet]);
      return result.value.err ? { success: false, error: JSON.stringify(result.value.err) } : { success: true };
    },
    executeBatch: async (actions) => {
      const tx = await buildBatchTransaction(actions);
      const signature = await sendAndConfirmTransaction(getConnection(), tx, [wallet], { commitment: "confirmed" });
      return { success: true, signature };
    },
    confirmTransaction: async (signature) => {
      const latest = await getConnection().getLatestBlockhash("confirmed");
      await getConnection().confirmTransaction({ signature, ...latest }, "confirmed");
    },
  };
}

function resultSignatures(result) {
  const candidates = result?.signatures || (result?.signature ? [result.signature] : []);
  return [...new Set(candidates.filter((signature) => typeof signature === "string" && signature))];
}

function cleanupTransactions(execution) {
  const transactions = [];
  for (const swap of execution?.swaps || []) {
    for (const signature of resultSignatures(swap.result)) {
      transactions.push({ signature, phase: "swap", ownedAccounts: [swap.action?.tokenAccount] });
    }
  }
  for (const batch of execution?.batches || []) {
    const ownedAccounts = (batch.actions || []).map((action) => action.tokenAccount);
    for (const signature of resultSignatures(batch.result)) {
      transactions.push({ signature, phase: "cleanup", ownedAccounts });
    }
  }
  return transactions;
}

function cleanupExecutionId(position, transactions) {
  return `cleanup-submit:${crypto.createHash("sha256").update(JSON.stringify({ position, transactions })).digest("hex")}`;
}

function checkpointConfirmedCleanupTransaction(position, {
  signature,
  phase,
  action = null,
  actions = null,
} = {}) {
  if (!signature) return null;
  const ownedAccounts = (actions || (action ? [action] : []))
    .map((item) => item?.tokenAccount)
    .filter(Boolean);
  const transaction = { signature, phase: phase || "cleanup", ownedAccounts };
  return checkpointCleanupExecution(position, {
    // Per-signature ids permit durable checkpointing after every confirmation;
    // a batch with multiple signatures cannot cause the first one to hide the
    // others behind one idempotency key.
    cleanupExecutionId: cleanupExecutionId(position, [transaction]),
    transactions: [transaction],
  });
}

function reconciliationId(position, terminal) {
  const payload = JSON.stringify({
    position,
    residual: terminal.residualTokenValueLamports,
    reclaimableRent: terminal.reclaimableRentLamports,
    retained: terminal.retained,
  });
  return `cleanup:${crypto.createHash("sha256").update(payload).digest("hex")}`;
}

async function recoverUncheckpointedCleanupSwap({
  position,
  walletPublicKey,
  preview,
  dependencies = {},
} = {}) {
  if (dependencies.recoverUncheckpointedSwap === false) return null;
  const actions = preview?.plan?.actions || [];
  const accounts = preview?.accounts || [];
  if (actions.length !== 1 || accounts.length !== 1) return null;
  const action = actions[0];
  const account = accounts[0];
  if (action.action !== "close" || String(action.rawAmount) !== "0" || String(account.rawAmount) !== "0") return null;
  const expectedRaw = String(account.provenance?.attributableRawAmount ?? "");
  if (!/^\d+$/.test(expectedRaw) || BigInt(expectedRaw) <= 0n) return null;

  const listSignatures = dependencies.getSignaturesForAddress;
  const rpc = dependencies.connection || getConnection();
  const candidates = listSignatures
    ? await listSignatures(action.tokenAccount, { limit: 20, commitment: "confirmed" })
    : await rpc.getSignaturesForAddress(new PublicKey(action.tokenAccount), { limit: 20 }, "confirmed");
  const signatureRows = Array.isArray(candidates) ? candidates : candidates?.value || [];
  const lifecycle = (dependencies.store || getTradeLedger()).getLifecycle(lifecycleIdForPosition(position));
  const known = new Set(lifecycle?.signatures || []);
  const recovered = [];
  for (const row of signatureRows) {
    const signature = String(row?.signature || "");
    if (!signature || row?.err != null || known.has(signature)) continue;
    try {
      await (dependencies.reconcileConfirmedManualCleanupSwap || reconcileConfirmedManualCleanupSwap)({
        position,
        signature,
        sourceTokenAccount: action.tokenAccount,
        mint: action.mint,
        tokenProgram: action.programId,
        expectedRawAmount: expectedRaw,
        walletAddress: String(walletPublicKey || dependencies.walletPublicKey || getWalletPublicKey()),
        ...(dependencies.inspectTransaction ? { inspectTransaction: dependencies.inspectTransaction } : {}),
        ...(dependencies.store ? { store: dependencies.store } : {}),
      });
      recovered.push(signature);
      break;
    } catch {
      // Historical close/deploy and unrelated transactions are expected. Only
      // the strict lifecycle-bound reconciliation primitive can accept one.
    }
  }
  return recovered.length > 0 ? { signatures: recovered } : null;
}

function lamportsToSol(value) {
  return Number(value) / 1e9;
}

function isProfitExit(reason) {
  return /(?:profit|take[ _-]?profit|trailing|\btp\b|target)/i.test(String(reason || ""));
}

async function recordBreakerSafely(event) {
  try {
    return await recordCircuitBreakerEvent(event);
  } catch (error) {
    log("circuit_breaker_error", `Could not persist ${event.type}: ${error.message}`);
    return null;
  }
}

export function buildSettlementBreakerEvents(finalization, reason, atMs = Date.now()) {
  if (!finalization?.lifecycle) return [];
  const lifecycle = finalization.lifecycle;
  const settlement = finalization.settlement || lifecycle.settlement;
  if (!settlement) return [];
  const stableSettlementId = settlement.metadata?.reconciliation_id || settlement.event_id;
  if (!stableSettlementId) return [];
  const eventId = (type) => settlementCircuitBreakerEventId(lifecycle.lifecycle_id, stableSettlementId, type);
  const errorSol = lamportsToSol(settlement.reconciliation_error_lamports);
  const events = [{ type: "reconciliation_checked", eventId: eventId("reconciliation_checked"), errorSol, atMs }];
  if (lifecycle.state !== "SETTLED") return events;
  const deployedSol = lamportsToSol(lifecycle.cost_basis.usable_basis_lamports);
  const netProfitSol = lamportsToSol(lifecycle.wallet_equity_net_lamports);
  events.push({
    type: "trade_settled",
    eventId: eventId("trade_settled"),
    netProfitSol,
    deployedSol,
    atMs,
  });
  if (isProfitExit(reason)) {
    events.push({
      type: "profit_exit",
      eventId: eventId("profit_exit"),
      netProfitSol,
      deployedSol,
      atMs,
    });
  }
  return events;
}

async function recordSettlementBreakerEvents(finalization, reason) {
  for (const event of buildSettlementBreakerEvents(finalization, reason)) {
    await recordBreakerSafely(event);
  }
}

/**
 * Per-position cleanup + reconciliation entry point. `execute: false` is
 * preview-only; `execute: true` additionally requires the executor's private
 * capability and is used by the operator boundary or confirmed-close hook.
 */
export async function reconcileLifecycleCleanup({
  position,
  execute = false,
  walletPublicKey = null,
  dependencies = null,
  executionCapability = null,
  lifecycleOperation = null,
} = {}) {
  if (!position) throw new TypeError("position is required for lifecycle cleanup reconciliation");
  // Only the boolean literal true grants transaction authority. This keeps a
  // malformed/manual CLI value such as "true" in preview mode.
  const executeRequested = execute === true;
  // Authorization must precede signer construction, scans, quotes, and any
  // transaction work. The public preview path remains capability-free.
  if (executeRequested && !hasCleanupExecutionCapability(executionCapability)) {
    return cleanupExecutionCapabilityBlocked();
  }
  // Immutable startup authority is the first execution boundary after the
  // side-effect-free capability check. A mutable process.env.DRY_RUN mirror
  // must never enable or disable cleanup after boot; this returns before
  // signer construction, scans, quotes, or RPC work.
  if (executeRequested && isEffectiveDryRun()) return cleanupDryRunBlocked();
  if (executeRequested && config.cleanup?.enabled !== true) {
    return {
      success: false,
      execution: { executed: false, blocked: "CLEANUP_DISABLED" },
      reconciliation: { complete: false, blocked: "CLEANUP_DISABLED" },
    };
  }
  // Read-only previews accept a public identity. Any execution path, even
  // with injected adapters, must prove that signing authority is configured.
  if (executeRequested) getSigner();
  if (executeRequested && lifecycleOperation == null) {
    throw new TypeError("Cleanup execution requires a durable lifecycle-operation lease");
  }
  // Keep the public wallet identity and read-only adapters stable across the
  // initial and post-execution scans. In particular, a preview must not load
  // signing material merely to discover its owner or quote cleanup actions.
  const previewRequest = {
    position,
    walletPublicKey,
    dependencies: dependencies || {},
  };
  const preview = await previewEconomicCleanup(previewRequest);
  if (preview.blocked) {
    return { success: false, ...preview, reconciliation: { complete: false, blocked: preview.blocked } };
  }
  if (!executeRequested) {
    const reconciliation = deriveCleanupTerminalEconomics({
      accounts: preview.accounts,
      plan: preview.plan,
      execution: { executed: false, preview: true },
      scannedPrograms: preview.scannedPrograms,
      scannedAt: preview.scannedAt,
    });
    return { success: true, ...preview, execution: { executed: false, preview: true }, reconciliation };
  }

  const recoveredSwap = await recoverUncheckpointedCleanupSwap({
    position,
    walletPublicKey,
    preview,
    dependencies: dependencies || {},
  });
  if (recoveredSwap) {
    const recoveryPreview = await previewEconomicCleanup(previewRequest);
    if (recoveryPreview.blocked) {
      return { success: false, ...recoveryPreview, reconciliation: { complete: false, blocked: recoveryPreview.blocked } };
    }
    preview.accounts = recoveryPreview.accounts;
    preview.plan = recoveryPreview.plan;
    preview.recoveredUncheckpointedSwap = recoveredSwap;
  }

  let execution;
  let operationRecovery = lifecycleOperation
    ? getLifecycleOperationRecoveryEvidence(lifecycleOperation)
    : { checkpoints: [], completions: [] };
  try {
    const durableOperationTransactions = operationRecovery.checkpoints.map((checkpoint) => ({
      signature: checkpoint.signature,
      phase: checkpoint.phase,
      ownedAccounts: checkpoint.metadata?.ownedAccounts || [],
    }));
    const checkpointed = durableOperationTransactions.length > 0
      ? durableOperationTransactions
      : getCheckpointedCleanupTransactions(position);
    if (checkpointed.length > 0) {
      await recordLifecycleTransactions({
        position,
        walletAddress: getWalletPublicKey(),
        transactions: checkpointed,
      });
      // Re-plan only after the confirmed receipt is ledger-attributed. A
      // confirmed swap may safely leave a zero source that still needs its
      // account closed, but it must never authorize a second positive-balance
      // swap. Likewise, an incomplete confirmed cleanup batch is a manual
      // reconciliation condition rather than an automatic resubmit.
      const recoveryPreview = await previewEconomicCleanup(previewRequest);
      if (recoveryPreview.blocked) {
        return {
          success: false,
          ...recoveryPreview,
          blocked: recoveryPreview.blocked,
          execution: { executed: true, replayed: true, swaps: [], batches: [], failures: [] },
          reconciliation: { complete: false, blocked: recoveryPreview.blocked },
        };
      }
      const remainingActions = recoveryPreview.plan.actions.filter((action) => action.action !== "keep");
      const hasSwapCheckpoint = checkpointed.some((transaction) => transaction.phase === "swap");
      const hasCleanupCheckpoint = checkpointed.some((transaction) => transaction.phase === "cleanup");
      if (hasSwapCheckpoint && remainingActions.some((action) => action.action === "swap_then_close")) {
        return {
          success: false,
          ...recoveryPreview,
          blocked: "CONFIRMED_CLEANUP_SWAP_LEFT_POSITIVE_RESIDUE",
          execution: { executed: true, replayed: true, swaps: [], batches: [], failures: [] },
          reconciliation: { complete: false, blocked: "CONFIRMED_CLEANUP_SWAP_LEFT_POSITIVE_RESIDUE" },
        };
      }
      if (hasCleanupCheckpoint && remainingActions.length > 0) {
        return {
          success: false,
          ...recoveryPreview,
          blocked: "CONFIRMED_CLEANUP_BATCH_LEFT_ACTIONABLE_RESIDUE",
          execution: { executed: true, replayed: true, swaps: [], batches: [], failures: [] },
          reconciliation: { complete: false, blocked: "CONFIRMED_CLEANUP_BATCH_LEFT_ACTIONABLE_RESIDUE" },
        };
      }
      const remainingExecution = remainingActions.length > 0
        ? await executeTokenCleanup(recoveryPreview.plan, liveCleanupExecutionDependencies(dependencies), {
          execute: true,
          policy: liveCleanupPolicyFromDependencies(dependencies || {}),
          onTransactionConfirmed: async (confirmed) => {
            if (lifecycleOperation) {
              const ownedAccounts = (confirmed.actions || (confirmed.action ? [confirmed.action] : []))
                .map((item) => item?.tokenAccount)
                .filter(Boolean);
              checkpointLifecycleOperationSignature(lifecycleOperation, {
                position,
                phase: confirmed.phase,
                signature: confirmed.signature,
                metadata: { ownedAccounts },
              });
            }
            checkpointConfirmedCleanupTransaction(position, confirmed);
          },
        })
        : { executed: true, swaps: [], batches: [], failures: [] };
      execution = { ...remainingExecution, replayed: true };
    } else {
      execution = await executeTokenCleanup(preview.plan, liveCleanupExecutionDependencies(dependencies), {
        execute: true,
        policy: liveCleanupPolicyFromDependencies(dependencies || {}),
        onTransactionConfirmed: async (confirmed) => {
          if (lifecycleOperation) {
            const ownedAccounts = (confirmed.actions || (confirmed.action ? [confirmed.action] : []))
              .map((item) => item?.tokenAccount)
              .filter(Boolean);
            checkpointLifecycleOperationSignature(lifecycleOperation, {
              position,
              phase: confirmed.phase,
              signature: confirmed.signature,
              metadata: { ownedAccounts },
            });
          }
          checkpointConfirmedCleanupTransaction(position, confirmed);
        },
      });
    }
  } catch (error) {
    await recordBreakerSafely({ type: "operation_failure", operation: "cleanup", atMs: Date.now() });
    throw error;
  }
  if (execution.failures.length > 0) {
    await recordBreakerSafely({ type: "operation_failure", operation: "cleanup", atMs: Date.now() });
    const preciseBlocker = execution.failures.find((failure) =>
      failure.blocked === CLEANUP_SWAP_SOURCE_BINDING_BLOCKER)?.blocked || "CLEANUP_EXECUTION_FAILED";
    return {
      success: false,
      ...preview,
      blocked: preciseBlocker,
      execution,
      reconciliation: { complete: false, blocked: preciseBlocker },
    };
  }

  try {
    const transactions = cleanupTransactions(execution);
    if (transactions.length > 0) {
      checkpointCleanupExecution(position, {
        cleanupExecutionId: cleanupExecutionId(position, transactions),
        transactions,
      });
      await recordLifecycleTransactions({
        position,
        walletAddress: getWalletPublicKey(),
        transactions,
      });
    }
    const finalPreview = await previewEconomicCleanup(previewRequest);
    if (finalPreview.blocked) {
      await recordBreakerSafely({ type: "operation_failure", operation: "cleanup", atMs: Date.now() });
      return { success: false, ...finalPreview, execution, reconciliation: { complete: false, blocked: finalPreview.blocked } };
    }
    const reconciliation = deriveCleanupTerminalEconomics({
      accounts: finalPreview.accounts,
      plan: finalPreview.plan,
      execution,
      scannedPrograms: finalPreview.scannedPrograms,
      scannedAt: finalPreview.scannedAt,
    });
    if (!reconciliation.complete) {
      await recordBreakerSafely({ type: "operation_failure", operation: "cleanup", atMs: Date.now() });
      return { success: false, ...finalPreview, execution, reconciliation };
    }
    const id = reconciliationId(position, reconciliation);
    reconciliation.terminalEconomics.reconciliation_id = id;
    const finalization = finalizeLifecycle(position, {
      residualTokenValueLamports: reconciliation.residualTokenValueLamports,
      reclaimableRentLamports: reconciliation.reclaimableRentLamports,
      terminalEconomics: reconciliation.terminalEconomics,
      reconciliationId: id,
      metadata: { cleanup_execution: execution.executed, retained_residual_accounts: reconciliation.retained },
    });
    if (finalization?.blocked === "COST_BASIS_NOT_READY") {
      await recordBreakerSafely({ type: "basis_invalid", atMs: Date.now() });
    }
    await recordSettlementBreakerEvents(finalization, getCloseLifecycleReason(position));
    const settled = finalization?.lifecycle?.state === "SETTLED";
    const finalizationBlocked = finalization?.blocked || (settled ? null : "RECONCILIATION_REQUIRED");
    await recordBreakerSafely({
      type: finalizationBlocked ? "operation_failure" : "operation_success",
      operation: "cleanup",
      atMs: Date.now(),
    });
    if (lifecycleOperation && !finalizationBlocked) {
      const operationTransactions = getLifecycleOperationRecoveryEvidence(lifecycleOperation).checkpoints
        .map((checkpoint) => ({ phase: checkpoint.phase, signature: checkpoint.signature }));
      if (operationTransactions.length > 0) {
        completeLifecycleOperation(lifecycleOperation, {
          position,
          phase: "cleanup",
          expectedTransactions: operationTransactions,
        });
      } else if (operationRecovery.completions.some((item) => item.phase === "cleanup")) {
        // Already completed before restart; only the final marker was missing.
      } else {
        // A close can return entirely native SOL and leave no token account to
        // mutate. There is no transaction to checkpoint, so the empty lease is
        // simply released after the ledger settlement below.
      }
      if (operationTransactions.length > 0 || operationRecovery.completions.some((item) => item.phase === "cleanup")) {
        finalizeLifecycleOperation(lifecycleOperation, { position });
      }
    }
    log("cleanup", `Lifecycle cleanup ${position}: ${finalization?.lifecycle?.state || finalization?.blocked || "not recorded"}`);
    return {
      success: !finalizationBlocked,
      ...(finalizationBlocked ? { blocked: finalizationBlocked } : {}),
      ...finalPreview,
      execution,
      reconciliation,
      finalization,
    };
  } catch (error) {
    await recordBreakerSafely({ type: "operation_failure", operation: "cleanup", atMs: Date.now() });
    throw error;
  }
}

/**
 * Compatibility wrapper for an explicit cleanup invocation. A global sweep is
 * preview-only because its batched signatures cannot be attributed safely to a
 * single ledger lifecycle.
 */
export async function executeEconomicCleanup({
  position = null,
  execute = false,
  walletPublicKey = null,
  dependencies = null,
  executionCapability = null,
  lifecycleOperation = null,
} = {}) {
  // This exported runtime entry point may be imported by arbitrary in-process
  // callers. Refuse an execution request before its global preview can scan
  // accounts or load a signer unless the executor supplied the registered
  // object-identity capability.
  if (execute === true && !hasCleanupExecutionCapability(executionCapability)) {
    return cleanupExecutionCapabilityBlocked();
  }
  if (execute === true && isEffectiveDryRun()) return cleanupDryRunBlocked();
  if (!position) {
    const preview = await previewEconomicCleanup({
      walletPublicKey,
      dependencies: dependencies || {},
    });
    if (execute === true) throw new Error("Explicit cleanup execution requires a position so ledger economics stay attributable");
    return { success: true, ...preview, execution: { executed: false, preview: true } };
  }
  return reconcileLifecycleCleanup({
    position,
    execute,
    walletPublicKey,
    dependencies,
    executionCapability,
    lifecycleOperation,
  });
}

/**
 * Serialize operator and post-close cleanup through one durable per-position
 * lease. A confirmed receipt is checkpointed before any later RPC read. If the
 * process stops after confirmation, reacquisition recovers the exact receipt
 * and never submits the stale preview again.
 */
export async function executeLeasedLifecycleCleanup({
  position,
  walletPublicKey = null,
  dependencies = null,
  executionCapability = null,
} = {}) {
  if (!position) throw new TypeError("position is required for leased lifecycle cleanup");
  if (!hasCleanupExecutionCapability(executionCapability)) return cleanupExecutionCapabilityBlocked();
  if (isEffectiveDryRun()) return cleanupDryRunBlocked();
  if (config.cleanup?.enabled !== true) {
    return {
      success: false,
      execution: { executed: false, blocked: "CLEANUP_DISABLED" },
      reconciliation: { complete: false, blocked: "CLEANUP_DISABLED" },
    };
  }
  const operation = acquireLifecycleOperation({ operation: "cleanup", position });
  try {
    return await executeEconomicCleanup({
      position,
      execute: true,
      walletPublicKey,
      dependencies,
      executionCapability,
      lifecycleOperation: operation,
    });
  } finally {
    releaseLifecycleOperation(operation);
  }
}
