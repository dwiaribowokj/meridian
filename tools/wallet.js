import crypto from "node:crypto";
import {
  Connection,
  PublicKey,
  LAMPORTS_PER_SOL,
  VersionedTransaction,
  Keypair,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  unpackAccount,
} from "@solana/spl-token";
import bs58 from "bs58";
import { log } from "../logger.js";
import { config, isEffectiveDryRun } from "../config.js";

let _connection = null;
let _wallet = null;

function getConnection() {
  if (!_connection) _connection = new Connection(process.env.RPC_URL, "confirmed");
  return _connection;
}

function getWallet() {
  if (!_wallet) {
    if (!process.env.WALLET_PRIVATE_KEY) throw new Error("WALLET_PRIVATE_KEY not set");
    _wallet = Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY));
  }
  return _wallet;
}

export function getWalletPublicKey() {
  return getWallet().publicKey.toString();
}

const JUPITER_PRICE_API = "https://api.jup.ag/price/v3";
const JUPITER_SWAP_V2_API = "https://api.jup.ag/swap/v2";
const READ_ONLY_HTTP_TIMEOUT_MS = 15_000;
const DEFAULT_JUPITER_API_KEY = "b15d42e9-e0e4-4f90-a424-ae41ceeaa382";
const HELIUS_NATIVE_SOL_MINT = "So11111111111111111111111111111111111111111";

export const CLEANUP_SWAP_SOURCE_BINDING_BLOCKER =
  "JUPITER_SWAP_V2_SOURCE_ACCOUNT_AUDIT_FAILED";

const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
const TOKEN_PROGRAM_IDS = new Set([
  TOKEN_PROGRAM_ID.toBase58(),
  TOKEN_2022_PROGRAM_ID.toBase58(),
]);

function cleanupRawAmount(value, field = "rawAmount") {
  const text = String(value ?? "");
  if (!/^\d+$/.test(text) || BigInt(text) <= 0n) {
    throw new TypeError(`${field} must be a positive integer string`);
  }
  return text;
}

function cleanupPublicKey(value, field) {
  try {
    return value instanceof PublicKey ? value : new PublicKey(value);
  } catch {
    throw new TypeError(`${field} must be a valid Solana public key`);
  }
}

function integerField(value, field) {
  const text = String(value ?? "");
  if (!/^\d+$/.test(text)) throw new TypeError(`${field} must be a non-negative integer`);
  return BigInt(text);
}

function sha256Hex(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function cleanupSwapBlocked(error) {
  const message = String(error?.message || error || "cleanup swap source-account audit failed")
    .replace(/[\r\n]+/g, " ")
    .slice(0, 1_000);
  return {
    success: false,
    blocked: CLEANUP_SWAP_SOURCE_BINDING_BLOCKER,
    error: `${CLEANUP_SWAP_SOURCE_BINDING_BLOCKER}: ${message}`,
  };
}

async function resolveVersionedMessageAccounts(message, connection) {
  const lookupAccounts = [];
  for (const lookup of message.addressTableLookups || []) {
    const response = await connection.getAddressLookupTable(lookup.accountKey, { commitment: "confirmed" });
    if (!response?.value) throw new Error(`address lookup table ${lookup.accountKey.toBase58()} is unavailable`);
    lookupAccounts.push(response.value);
  }
  const accountKeys = message.getAccountKeys({ addressLookupTableAccounts: lookupAccounts });
  return Array.from({ length: accountKeys.length }, (_, index) => {
    const key = accountKeys.get(index);
    if (!key) throw new Error(`prepared transaction account index ${index} is unresolved`);
    return key;
  });
}

function parsedTransferDetails(instruction) {
  if (!instruction?.parsed || !TOKEN_PROGRAM_IDS.has(instruction.programId?.toBase58?.())) return null;
  const type = String(instruction.parsed.type || "");
  if (!new Set(["transfer", "transferChecked", "transferCheckedWithFee"]).has(type)) return null;
  const info = instruction.parsed.info || {};
  const rawAmount = info.amount ?? info.tokenAmount?.amount;
  const source = String(info.source || "");
  const destination = String(info.destination || "");
  if (!source || !destination || !/^\d+$/.test(String(rawAmount ?? ""))) {
    throw new Error("simulation returned a malformed token transfer");
  }
  return {
    programId: instruction.programId.toBase58(),
    source,
    destination,
    mint: info.mint ? String(info.mint) : null,
    authority: info.authority ? String(info.authority) : null,
    rawAmount: String(rawAmount),
  };
}

function parsedWalletSystemDebit(instruction, walletAddress) {
  if (instruction?.programId?.toBase58?.() !== SYSTEM_PROGRAM_ID || !instruction?.parsed) return 0n;
  const type = String(instruction.parsed.type || "");
  const info = instruction.parsed.info || {};
  if (type === "createAccount") {
    return String(info.source || "") === walletAddress ? integerField(info.lamports, "createAccount.lamports") : 0n;
  }
  if (type === "transfer" || type === "transferWithSeed") {
    return String(info.source || "") === walletAddress ? integerField(info.lamports, "transfer.lamports") : 0n;
  }
  // Any other wallet-authored System action is not part of a token-to-SOL
  // cleanup route that this adapter knows how to value safely.
  if ([info.source, info.fromPubkey, info.accountPubkey, info.base].some((value) => String(value || "") === walletAddress)) {
    throw new Error(`unsupported wallet SystemProgram action ${type || "unknown"}`);
  }
  return 0n;
}

function outerInstructions(transaction, accountKeys) {
  return (transaction.message.compiledInstructions || []).map((instruction) => {
    const programId = accountKeys[instruction.programIdIndex];
    if (!programId) throw new Error("prepared transaction has an unresolved outer program id");
    return {
      programId,
      accounts: [...instruction.accountKeyIndexes].map((index) => {
        const account = accountKeys[index];
        if (!account) throw new Error("prepared transaction has an unresolved outer instruction account");
        return account.toBase58();
      }),
      data: Buffer.from(instruction.data),
    };
  });
}

function assertNoOuterWalletTokenMutation(transaction, accountKeys, walletTokenAccounts, sourceAddress, walletAddress) {
  for (const instruction of outerInstructions(transaction, accountKeys)) {
    if (!TOKEN_PROGRAM_IDS.has(instruction.programId.toBase58())) continue;
    const discriminator = instruction.data[0];
    const touchedWalletAccounts = instruction.accounts.filter((address) => walletTokenAccounts.has(address));
    const touchesSource = touchedWalletAccounts.includes(sourceAddress);
    if (touchedWalletAccounts.some((address) => address !== sourceAddress)) {
      throw new Error("prepared transaction has an outer mutation of an unrelated wallet token account");
    }
    // Router swaps normally debit through CPI, not direct outer token
    // instructions. Permit only a source transfer (3/12), source close (9),
    // or temporary WSOL close authorized by this wallet. Authority changes,
    // approvals, burns, freezes and extension instructions fail closed.
    if (touchesSource && !new Set([3, 9, 12]).has(discriminator)) {
      throw new Error(`prepared transaction has unsupported outer source-token instruction ${discriminator}`);
    }
    if (discriminator === 9 && instruction.accounts[2] !== walletAddress) {
      throw new Error("prepared transaction has a token-account close with an unrelated authority");
    }
  }
}

function directWalletSolTransfers(transaction, accountKeys, walletAddress) {
  let total = 0n;
  for (const instruction of outerInstructions(transaction, accountKeys)) {
    if (instruction.programId.toBase58() !== SYSTEM_PROGRAM_ID) continue;
    if (instruction.data.length < 4) throw new Error("prepared transaction has a malformed outer SystemProgram instruction");
    const discriminator = instruction.data.readUInt32LE(0);
    if (discriminator === 2) {
      if (instruction.data.length !== 12 || instruction.accounts.length < 2) {
        throw new Error("prepared transaction has a malformed direct SOL transfer");
      }
      if (instruction.accounts[0] === walletAddress) total += instruction.data.readBigUInt64LE(4);
      continue;
    }
    if (instruction.accounts.includes(walletAddress)) {
      throw new Error(`prepared transaction has unsupported wallet SystemProgram instruction ${discriminator}`);
    }
  }
  return total;
}

async function inspectPreparedCleanupSwap({
  transaction,
  accountKeys,
  sourceTokenAccount,
  sourceMint,
  sourceTokenProgram,
  inputRawAmount,
  wallet,
  connection,
  order,
}) {
  const walletAddress = wallet.publicKey.toBase58();
  if (transaction.message.header.numRequiredSignatures !== 1 || !accountKeys[0]?.equals(wallet.publicKey)) {
    throw new Error("prepared transaction has an unexpected signer set or fee payer");
  }
  for (let index = 0; index < accountKeys.length; index++) {
    if (transaction.message.isAccountSigner(index) && !accountKeys[index].equals(wallet.publicKey)) {
      throw new Error(`prepared transaction requires an unrelated signer ${accountKeys[index].toBase58()}`);
    }
  }

  const sourceIndex = accountKeys.findIndex((key) => key.equals(sourceTokenAccount));
  if (sourceIndex < 0 || !transaction.message.isAccountWritable(sourceIndex)) {
    throw new Error("prepared transaction does not make the exact lifecycle source account writable");
  }
  const directSolTransfersLamports = directWalletSolTransfers(transaction, accountKeys, walletAddress);
  if (directSolTransfersLamports !== 0n) {
    throw new Error("prepared transaction contains a direct wallet SOL transfer");
  }

  const infos = await connection.getMultipleAccountsInfo(accountKeys, "confirmed");
  if (!Array.isArray(infos) || infos.length !== accountKeys.length) {
    throw new Error("RPC did not return the complete prepared-transaction account set");
  }
  const walletTokenAccounts = new Map();
  for (let index = 0; index < infos.length; index++) {
    const info = infos[index];
    if (!info || !TOKEN_PROGRAM_IDS.has(info.owner.toBase58())) continue;
    let token;
    try {
      token = unpackAccount(accountKeys[index], info, info.owner);
    } catch {
      continue;
    }
    if (token.owner.equals(wallet.publicKey)) {
      walletTokenAccounts.set(accountKeys[index].toBase58(), {
        address: accountKeys[index].toBase58(),
        mint: token.mint.toBase58(),
        programId: info.owner.toBase58(),
        rawAmount: token.amount.toString(),
        writable: transaction.message.isAccountWritable(index),
      });
    }
  }
  const source = walletTokenAccounts.get(sourceTokenAccount.toBase58());
  if (!source || source.mint !== sourceMint.toBase58() || source.programId !== sourceTokenProgram.toBase58() ||
      source.rawAmount !== inputRawAmount || source.writable !== true) {
    throw new Error("prepared transaction source account no longer matches the exact lifecycle mint, program, amount, and owner");
  }
  const writableWalletTokenAccounts = [...walletTokenAccounts.values()].filter((account) => account.writable);
  if (writableWalletTokenAccounts.length !== 1 || writableWalletTokenAccounts[0].address !== source.address) {
    throw new Error("prepared transaction makes an unrelated existing wallet token account writable");
  }
  assertNoOuterWalletTokenMutation(
    transaction,
    accountKeys,
    walletTokenAccounts,
    source.address,
    walletAddress,
  );

  const simulatedAddresses = [...new Set([walletAddress, ...walletTokenAccounts.keys()])];
  const simulation = await connection.simulateTransaction(transaction, {
    commitment: "confirmed",
    sigVerify: false,
    replaceRecentBlockhash: true,
    innerInstructions: true,
    accounts: { encoding: "base64", addresses: simulatedAddresses },
  });
  if (simulation.value.err != null) {
    throw new Error(`prepared transaction simulation failed: ${JSON.stringify(simulation.value.err)}`);
  }
  if (!Array.isArray(simulation.value.innerInstructions) || !Array.isArray(simulation.value.accounts)) {
    throw new Error("prepared transaction simulation omitted inner-instruction or post-account evidence");
  }

  const transfers = [];
  let walletSystemDebits = 0n;
  const closedWalletTokenAccounts = new Set();
  for (const instruction of outerInstructions(transaction, accountKeys)) {
    if (!TOKEN_PROGRAM_IDS.has(instruction.programId.toBase58())) continue;
    // CloseAccount has the same single-byte discriminator in Token and
    // Token-2022. Account[0] is the token account and account[2] its authority.
    if (instruction.data.length === 1 && instruction.data[0] === 9 &&
        instruction.accounts.length >= 3 && instruction.accounts[2] === walletAddress) {
      closedWalletTokenAccounts.add(instruction.accounts[0]);
    }
  }
  for (const group of simulation.value.innerInstructions) {
    for (const instruction of group.instructions || []) {
      if (instruction?.parsed && TOKEN_PROGRAM_IDS.has(instruction.programId?.toBase58?.())) {
        const info = instruction.parsed.info || {};
        const referencedWalletAccounts = [
          info.account,
          info.source,
          info.destination,
          info.mint,
        ].map(String).filter((address) => walletTokenAccounts.has(address));
        if (referencedWalletAccounts.some((address) => address !== source.address)) {
          throw new Error("simulation found an unrelated wallet token-account mutation");
        }
        if ([info.owner, info.authority].some((authority) => String(authority || "") === walletAddress) &&
            !new Set([
              "transfer", "transferChecked", "transferCheckedWithFee",
              "closeAccount", "initializeAccount", "initializeAccount2",
              "initializeAccount3", "initializeImmutableOwner", "getAccountDataSize",
            ]).has(String(instruction.parsed.type || ""))) {
          throw new Error(`simulation found unsupported wallet-authorized token instruction ${instruction.parsed.type || "unknown"}`);
        }
      }
      const transfer = parsedTransferDetails(instruction);
      if (transfer) transfers.push(transfer);
      walletSystemDebits += parsedWalletSystemDebit(instruction, walletAddress);
      if (instruction?.parsed?.type === "closeAccount" &&
          TOKEN_PROGRAM_IDS.has(instruction.programId?.toBase58?.()) &&
          String(instruction.parsed.info?.owner || "") === walletAddress) {
        closedWalletTokenAccounts.add(String(instruction.parsed.info?.account || ""));
      }
    }
  }
  const sourceDebits = transfers.filter((transfer) => transfer.source === source.address);
  if (sourceDebits.length !== 1 || sourceDebits[0].rawAmount !== inputRawAmount ||
      sourceDebits[0].programId !== sourceTokenProgram.toBase58() ||
      (sourceDebits[0].mint != null && sourceDebits[0].mint !== sourceMint.toBase58()) ||
      (sourceDebits[0].authority != null && sourceDebits[0].authority !== walletAddress)) {
    throw new Error("simulation did not prove one exact wallet-authorized lifecycle source debit");
  }
  const unrelatedWalletDebits = transfers.filter((transfer) =>
    walletTokenAccounts.has(transfer.source) && transfer.source !== source.address);
  if (unrelatedWalletDebits.length > 0) {
    throw new Error("simulation found an unrelated wallet token debit");
  }

  const postSourceInfo = simulation.value.accounts[simulatedAddresses.indexOf(source.address)];
  if (!postSourceInfo) throw new Error("simulation omitted the lifecycle source post-account state");
  const postSource = unpackAccount(sourceTokenAccount, {
    data: Buffer.from(postSourceInfo.data[0], "base64"),
    executable: postSourceInfo.executable === true,
    lamports: postSourceInfo.lamports,
    owner: new PublicKey(postSourceInfo.owner),
    rentEpoch: postSourceInfo.rentEpoch ?? 0,
  }, sourceTokenProgram);
  if (postSource.amount !== 0n || !postSource.mint.equals(sourceMint) || !postSource.owner.equals(wallet.publicKey)) {
    throw new Error("simulation did not reduce the exact lifecycle source account to zero");
  }

  const createdWalletTokenAccounts = new Set();
  for (const group of simulation.value.innerInstructions) {
    for (const instruction of group.instructions || []) {
      const info = instruction?.parsed?.info || {};
      if (String(instruction?.parsed?.type || "").startsWith("initializeAccount") &&
          TOKEN_PROGRAM_IDS.has(instruction.programId?.toBase58?.()) &&
          String(info.owner || "") === walletAddress) {
        createdWalletTokenAccounts.add(String(info.account || ""));
      }
    }
  }
  if ([...createdWalletTokenAccounts].some((address) => !address || !closedWalletTokenAccounts.has(address))) {
    throw new Error("prepared transaction creates a wallet token account that is not closed atomically");
  }
  // Temporary ATA/WSOL setup can debit rent and reclaim it later in the same
  // transaction. Only setup that survives the transaction is an economic rent
  // cost; the all-created-accounts-closed invariant above proves this is zero.
  walletSystemDebits = 0n;

  const fee = await connection.getFeeForMessage(transaction.message, "confirmed");
  if (fee?.value == null || !Number.isSafeInteger(fee.value) || fee.value < 0) {
    throw new Error("RPC could not determine the prepared transaction fee");
  }
  const orderSignatureFee = integerField(order.signatureFeeLamports ?? 0, "order.signatureFeeLamports");
  const orderPriorityFee = integerField(order.prioritizationFeeLamports ?? 0, "order.prioritizationFeeLamports");
  const rentLamports = integerField(order.rentFeeLamports ?? 0, "order.rentFeeLamports");
  if (BigInt(fee.value) < orderSignatureFee + orderPriorityFee) {
    throw new Error("RPC fee is below the provider-declared signature and priority fee");
  }

  const writableAccounts = accountKeys.flatMap((key, index) => {
    if (!transaction.message.isAccountWritable(index)) return [];
    const address = key.toBase58();
    const walletToken = walletTokenAccounts.get(address);
    return [{
      address,
      role: address === source.address
        ? "wallet_source_token"
        : address === walletAddress
          ? "wallet_fee_payer_and_sol_destination"
          : walletToken
            ? "unrelated_wallet_token"
            : "provider_route_account",
      walletOwnedTokenAccount: Boolean(walletToken),
      safe: address === source.address || address === walletAddress || !walletToken,
    }];
  });
  if (writableAccounts.some((item) => item.safe !== true)) {
    throw new Error("prepared transaction contains an unsafe writable wallet token account");
  }

  return {
    inspection: "local_instruction_inspection",
    sourceTokenAccount: source.address,
    sourceMint: source.mint,
    sourceTokenProgram: source.programId,
    inputRawAmount,
    walletTokenDebits: [{ tokenAccount: source.address, rawAmount: inputRawAmount }],
    writableWalletTokenAccounts: [source.address],
    writableAccounts,
    directSolTransfersLamports: directSolTransfersLamports.toString(),
    walletSetupRentLamports: walletSystemDebits.toString(),
    networkFeeLamports: String(fee.value),
    rentLamports: rentLamports.toString(),
    simulationUnitsConsumed: simulation.value.unitsConsumed ?? null,
  };
}

export async function prepareSourceAccountBoundCleanupSwap({
  tokenAccount,
  mint,
  rawAmount,
  programId,
} = {}, dependencies = {}) {
  const runtime = {
    connection: dependencies.connection ?? getConnection(),
    wallet: dependencies.wallet ?? getWallet(),
    fetch: dependencies.fetch ?? fetch,
    deserializeTransaction: dependencies.deserializeTransaction ?? VersionedTransaction.deserialize,
  };
  try {
    const sourceTokenAccount = cleanupPublicKey(tokenAccount, "tokenAccount");
    const sourceMint = cleanupPublicKey(mint, "mint");
    const sourceTokenProgram = cleanupPublicKey(programId, "programId");
    const inputRawAmount = cleanupRawAmount(rawAmount);
    if (!TOKEN_PROGRAM_IDS.has(sourceTokenProgram.toBase58())) {
      throw new Error("cleanup source uses an unsupported token program");
    }
    const search = new URLSearchParams({
      inputMint: sourceMint.toBase58(),
      outputMint: config.tokens.SOL,
      amount: inputRawAmount,
      taker: runtime.wallet.publicKey.toBase58(),
    });
    const apiKey = getJupiterApiKey();
    const response = await runtime.fetch(`${JUPITER_SWAP_V2_API}/order?${search}`, {
      headers: apiKey ? { "x-api-key": apiKey } : {},
      signal: AbortSignal.timeout(READ_ONLY_HTTP_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Jupiter order ${response.status}: ${await response.text()}`);
    const order = await response.json();
    if (order.errorCode || order.errorMessage || !order.transaction || !order.requestId) {
      throw new Error(order.errorMessage || order.errorCode || order.error || "Jupiter returned no executable transaction");
    }
    if (String(order.inAmount ?? "") !== inputRawAmount || String(order.inputMint ?? "") !== sourceMint.toBase58() ||
        String(order.outputMint ?? "") !== config.tokens.SOL || String(order.taker ?? "") !== runtime.wallet.publicKey.toBase58() ||
        String(order.swapMode ?? "") !== "ExactIn") {
      throw new Error("Jupiter order does not match the exact cleanup input, output, taker, and ExactIn mode");
    }
    const outAmount = integerField(order.outAmount, "order.outAmount");
    const threshold = integerField(order.otherAmountThreshold, "order.otherAmountThreshold");
    if (outAmount <= 0n || threshold <= 0n || threshold > outAmount) {
      throw new Error("Jupiter order has an invalid conservative output threshold");
    }
    const transactionBytes = Buffer.from(order.transaction, "base64");
    const transaction = runtime.deserializeTransaction(transactionBytes);
    const accountKeys = await resolveVersionedMessageAccounts(transaction.message, runtime.connection);
    const sourceAccountAudit = await inspectPreparedCleanupSwap({
      transaction,
      accountKeys,
      sourceTokenAccount,
      sourceMint,
      sourceTokenProgram,
      inputRawAmount,
      wallet: runtime.wallet,
      connection: runtime.connection,
      order,
    });
    return {
      success: true,
      preparedSwap: Object.freeze({
        transactionBase64: transactionBytes.toString("base64"),
        transactionHash: sha256Hex(transactionBytes),
        requestId: String(order.requestId),
        sourceTokenAccount: sourceTokenAccount.toBase58(),
        sourceMint: sourceMint.toBase58(),
        sourceTokenProgram: sourceTokenProgram.toBase58(),
        inputRawAmount,
      }),
      sourceAccountAudit,
      economicAudit: {
        worstOutLamports: threshold.toString(),
        networkFeeLamports: sourceAccountAudit.networkFeeLamports,
        rentLamports: sourceAccountAudit.rentLamports,
      },
    };
  } catch (error) {
    return cleanupSwapBlocked(error);
  }
}

export const executeSourceAccountBoundCleanupSwap = prepareSourceAccountBoundCleanupSwap;

export async function submitPreparedSourceAccountBoundCleanupSwap(preparedSwap, dependencies = {}) {
  const runtime = {
    wallet: dependencies.wallet ?? getWallet(),
    fetch: dependencies.fetch ?? fetch,
    deserializeTransaction: dependencies.deserializeTransaction ?? VersionedTransaction.deserialize,
  };
  try {
    if (!preparedSwap || typeof preparedSwap !== "object") throw new TypeError("preparedSwap is required");
    const bytes = Buffer.from(String(preparedSwap.transactionBase64 || ""), "base64");
    const hash = sha256Hex(bytes);
    if (!bytes.length || hash !== preparedSwap.transactionHash) {
      throw new Error("prepared cleanup transaction hash changed before signing");
    }
    const transaction = runtime.deserializeTransaction(bytes);
    transaction.sign([runtime.wallet]);
    const signedTransaction = Buffer.from(transaction.serialize()).toString("base64");
    const apiKey = getJupiterApiKey();
    const response = await runtime.fetch(`${JUPITER_SWAP_V2_API}/execute`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { "x-api-key": apiKey } : {}),
      },
      body: JSON.stringify({ signedTransaction, requestId: preparedSwap.requestId }),
    });
    if (!response.ok) throw new Error(`Jupiter execute ${response.status}: ${await response.text()}`);
    const result = await response.json();
    if (result.status === "Failed" || !result.signature) {
      throw new Error(`Jupiter cleanup swap failed: ${result.code ?? result.error ?? result.status ?? "missing signature"}`);
    }
    return {
      success: true,
      signature: result.signature,
      inputAmountResult: result.inputAmountResult ?? null,
      outputAmountResult: result.outputAmountResult ?? null,
    };
  } catch (error) {
    return cleanupSwapBlocked(error);
  }
}

function buildHeliusUrl(path, params = {}) {
  const baseUrl = String(config.helius.baseUrl).replace(/\/+$/, "");
  const url = new URL(`${baseUrl}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value != null && value !== "") url.searchParams.set(key, value);
  }
  return url.toString();
}

function getJupiterApiKey() {
  return config.jupiter.apiKey || process.env.JUPITER_API_KEY || DEFAULT_JUPITER_API_KEY;
}

function getJupiterReferralParams() {
  const referralAccount = String(config.jupiter.referralAccount || "").trim();
  const referralFee = Number(config.jupiter.referralFeeBps || 0);
  if (!referralAccount || !Number.isFinite(referralFee) || referralFee <= 0) {
    return null;
  }
  if (referralFee < 50 || referralFee > 255) {
    log("swap_warn", `Ignoring Jupiter referral fee ${referralFee}; Ultra requires 50-255 bps`);
    return null;
  }
  try {
    new PublicKey(referralAccount);
  } catch {
    log("swap_warn", "Ignoring invalid Jupiter referral account");
    return null;
  }
  return { referralAccount, referralFee: Math.round(referralFee) };
}

/**
 * Get current wallet balances: SOL, USDC, and all SPL tokens using Helius Wallet API.
 * Returns USD-denominated values provided by Helius.
 */
async function getWalletBalancesLegacy() {
  let walletAddress;
  try {
    walletAddress = getWallet().publicKey.toString();
  } catch {
    return { wallet: null, sol: 0, sol_price: 0, sol_usd: 0, usdc: 0, tokens: [], total_usd: 0, error: "Wallet not configured" };
  }

  const HELIUS_KEY = config.helius.apiKey || process.env.HELIUS_API_KEY;
  if (!HELIUS_KEY) {
    log("wallet_error", "HELIUS_API_KEY not set in .env");
    return { wallet: walletAddress, sol: 0, sol_price: 0, sol_usd: 0, usdc: 0, tokens: [], total_usd: 0, error: "Helius API key missing" };
  }

  try {
    const url = buildHeliusUrl(`/v1/wallet/${walletAddress}/balances`, { "api-key": HELIUS_KEY });
    const res = await fetch(url);
    
    if (!res.ok) {
      throw new Error(`Helius API error: ${res.status} ${res.statusText}`);
    }

    const data = await res.json();
    const balances = data.balances || [];

    // ─── Find SOL and USDC ────────────────────────────────────
    const solEntry = balances.find(b => b.mint === config.tokens.SOL || b.symbol === "SOL");
    const usdcEntry = balances.find(b => b.mint === config.tokens.USDC || b.symbol === "USDC");

    const solBalance = solEntry?.balance || 0;
    const solPrice = solEntry?.pricePerToken || 0;
    const solUsd = solEntry?.usdValue || 0;
    const usdcBalance = usdcEntry?.balance || 0;

    // ─── Map all tokens ───────────────────────────────────────
    const enrichedTokens = balances.map(b => ({
      mint: b.mint,
      symbol: b.symbol || b.mint.slice(0, 8),
      balance: b.balance,
      usd: b.usdValue ? Math.round(b.usdValue * 100) / 100 : null,
      usd_raw: Number.isFinite(Number(b.usdValue)) ? Number(b.usdValue) : null,
    }));

    return {
      wallet: walletAddress,
      sol: Math.round(solBalance * 1e6) / 1e6,
      sol_price: Math.round(solPrice * 100) / 100,
      sol_usd: Math.round(solUsd * 100) / 100,
      usdc: Math.round(usdcBalance * 100) / 100,
      tokens: enrichedTokens,
      total_usd: Math.round((data.totalUsdValue || 0) * 100) / 100,
    };
  } catch (error) {
    log("wallet_error", error.message);
    return {
      wallet: walletAddress,
      sol: 0,
      sol_price: 0,
      sol_usd: 0,
      usdc: 0,
      tokens: [],
      total_usd: 0,
      error: error.message,
    };
  }
}

/**
 * Normalize the Helius portfolio response around an authoritative native-SOL
 * balance read from RPC. A partial indexer response must never turn a missing
 * SOL row into a genuine zero balance and trip the live canary breaker.
 */
export function normalizeWalletBalanceSnapshot({ walletAddress, nativeSol, data } = {}) {
  const authoritativeSol = Number(nativeSol);
  if (!Number.isFinite(authoritativeSol) || authoritativeSol < 0) {
    throw new Error("Authoritative RPC SOL balance is unavailable or invalid");
  }
  if (!data || !Array.isArray(data.balances)) {
    throw new Error("Helius wallet response is missing the balances array");
  }

  const balances = data.balances;
  const solEntry = balances.find((entry) => (
    entry?.mint === config.tokens.SOL || entry?.mint === HELIUS_NATIVE_SOL_MINT
  ));
  const usdcEntry = balances.find((entry) => entry?.mint === config.tokens.USDC);
  const usdtEntry = balances.find((entry) => entry?.mint === config.tokens.USDT);
  const solPrice = Number(solEntry?.pricePerToken);
  const usableSolPrice = Number.isFinite(solPrice) && solPrice > 0 ? solPrice : 0;
  const solUsdRaw = usableSolPrice > 0 ? authoritativeSol * usableSolPrice : 0;
  const usdcBalance = Number(usdcEntry?.balance);
  const usdtBalance = Number(usdtEntry?.balance);

  const enrichedTokens = balances.map((entry) => {
    const isSol = entry === solEntry;
    const balance = isSol ? authoritativeSol : Number(entry?.balance);
    const usdRaw = isSol ? solUsdRaw : Number(entry?.usdValue);
    return {
      mint: entry?.mint,
      symbol: entry?.symbol || String(entry?.mint || "unknown").slice(0, 8),
      balance: Number.isFinite(balance) && balance >= 0 ? balance : 0,
      usd: Number.isFinite(usdRaw) && usdRaw > 0 ? Math.round(usdRaw * 100) / 100 : null,
      usd_raw: Number.isFinite(usdRaw) && usdRaw >= 0 ? usdRaw : null,
    };
  });

  const reportedTotalUsd = Number(data.totalUsdValue);
  const reportedSolUsd = Number(solEntry?.usdValue);
  const adjustedTotalUsd = Number.isFinite(reportedTotalUsd) && reportedTotalUsd >= 0
    ? Math.max(0, reportedTotalUsd - (Number.isFinite(reportedSolUsd) ? Math.max(0, reportedSolUsd) : 0)) + solUsdRaw
    : enrichedTokens.reduce((sum, token) => sum + (Number(token.usd_raw) || 0), 0);
  const warnings = [];
  if (!solEntry) warnings.push("HELIUS_NATIVE_SOL_ROW_MISSING_RPC_BALANCE_USED");
  if (usableSolPrice <= 0) warnings.push("HELIUS_SOL_PRICE_MISSING");

  return {
    wallet: walletAddress,
    sol: Math.round(authoritativeSol * 1e9) / 1e9,
    sol_price: Math.round(usableSolPrice * 100) / 100,
    sol_usd: Math.round(solUsdRaw * 100) / 100,
    usdc: Number.isFinite(usdcBalance) && usdcBalance >= 0 ? Math.round(usdcBalance * 1e6) / 1e6 : 0,
    usdt: Number.isFinite(usdtBalance) && usdtBalance >= 0 ? Math.round(usdtBalance * 1e6) / 1e6 : 0,
    tokens: enrichedTokens,
    total_usd: Math.round(adjustedTotalUsd * 100) / 100,
    native_sol_source: "rpc",
    warnings,
    ...(usableSolPrice > 0 ? {} : {
      error: "Helius SOL price is unavailable; live sizing and equity valuation are blocked for this cycle",
    }),
  };
}

function unavailableWalletBalance(walletAddress, error, nativeSol = null) {
  const usableNativeSol = Number.isFinite(Number(nativeSol)) && Number(nativeSol) >= 0
    ? Number(nativeSol)
    : 0;
  return {
    wallet: walletAddress,
    sol: Math.round(usableNativeSol * 1e9) / 1e9,
    sol_price: 0,
    sol_usd: 0,
    usdc: 0,
    usdt: 0,
    tokens: [],
    total_usd: 0,
    native_sol_source: nativeSol == null ? null : "rpc",
    error,
  };
}

function conciseWalletProviderError(error) {
  const message = String(error?.message || error || "wallet provider unavailable");
  const status = message.match(/\b(?:HTTP\s*)?(4\d\d|5\d\d)\b/);
  if (/failed to get balance of account/i.test(message)) {
    return `RPC native SOL balance failed${status ? `: HTTP ${status[1]}` : ""}`;
  }
  if (/Helius API error/i.test(message)) {
    return `Helius wallet API failed${status ? `: HTTP ${status[1]}` : ""}`;
  }
  return message
    .replace(/https?:\/\/[^\s"']+/gi, "[provider-url-redacted]")
    .replace(/[A-Za-z0-9_-]{24,}/g, "[provider-detail-redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

async function getNativeBalanceWithRetry(connection, publicKey, attempts = 3) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await connection.getBalance(publicKey, "confirmed");
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 250));
      }
    }
  }
  throw lastError || new Error("RPC native SOL balance failed");
}

/**
 * Native SOL comes from RPC; Helius supplies SPL balances and USD marks.
 * Provider uncertainty remains explicit so live entry can fail closed for the
 * current cycle without fabricating a zero-equity loss.
 */
export async function getWalletBalances({
  connection = null,
  fetchImpl = fetch,
  walletPublicKey = null,
} = {}) {
  let walletAddress;
  let publicKey;
  try {
    publicKey = walletPublicKey == null ? getWallet().publicKey : new PublicKey(walletPublicKey);
    walletAddress = publicKey.toString();
  } catch {
    return unavailableWalletBalance(null, "Wallet not configured");
  }

  const HELIUS_KEY = config.helius.apiKey || process.env.HELIUS_API_KEY;
  const nativeBalancePromise = Promise.resolve().then(() => (
    getNativeBalanceWithRetry(connection ?? getConnection(), publicKey)
  ));
  try {
    const nativeLamports = await nativeBalancePromise;
    const nativeSol = Number(nativeLamports) / LAMPORTS_PER_SOL;
    if (!Number.isFinite(nativeSol) || nativeSol < 0) {
      throw new Error("RPC returned an invalid native SOL balance");
    }
    if (!HELIUS_KEY) {
      const error = "Helius API key missing";
      log("wallet_error", error);
      return unavailableWalletBalance(walletAddress, error, nativeSol);
    }

    const url = buildHeliusUrl(`/v1/wallet/${walletAddress}/balances`, { "api-key": HELIUS_KEY });
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(READ_ONLY_HTTP_TIMEOUT_MS) });
    if (!res.ok) {
      throw new Error(`Helius API error: ${res.status} ${res.statusText}`);
    }
    const data = await res.json();
    return normalizeWalletBalanceSnapshot({ walletAddress, nativeSol, data });
  } catch (error) {
    const safeError = conciseWalletProviderError(error);
    log("wallet_error", safeError);
    let nativeSol = null;
    try {
      nativeSol = Number(await nativeBalancePromise) / LAMPORTS_PER_SOL;
    } catch {
      // Preserve the primary provider/RPC diagnostic below.
    }
    return unavailableWalletBalance(walletAddress, safeError, nativeSol);
  }
}

/**
 * Swap tokens via Jupiter Swap API V2 (order → sign → execute).
 */
const SOL_MINT = "So11111111111111111111111111111111111111112";
const SOL_MINT_ALIASES = new Set(["SOL", "native"]);
const MAX_TOKEN_RAW_AMOUNT = (1n << 64n) - 1n;
const BASE58_MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const CLI_SWAP_SOURCE_DECIMALS = Object.freeze({ SOL: 9, USDC: 6, USDT: 6 });
const EXACT_POSITIVE_DECIMAL_RE = /^\+?(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/;
const SPL_TOKEN_PROGRAM_OWNERS = new Set([
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
]);

// Map only explicit native-SOL aliases and the exact wrapped-SOL mint. A
// public key that merely resembles the wrapped mint remains its own mint.
export function normalizeMint(mint) {
  if (!mint) return mint;
  return mint === SOL_MINT || SOL_MINT_ALIASES.has(mint) ? SOL_MINT : mint;
}

function canonicalSolanaPublicKey(value) {
  if (typeof value !== "string" || !BASE58_MINT_RE.test(value)) return null;
  try {
    // PublicKey verifies the decoded value has Solana's exact 32-byte width.
    // Returning its base58 form also removes alternate/non-canonical encodings
    // before authority reaches Jupiter.
    return new PublicKey(value).toBase58();
  } catch {
    return null;
  }
}

function exactPositiveRawAmount(amount_raw) {
  if (typeof amount_raw !== "string" || !/^[1-9]\d*$/.test(amount_raw)) {
    throw new TypeError("amount_raw must be a positive canonical integer string");
  }
  const rawAmount = BigInt(amount_raw);
  if (rawAmount > MAX_TOKEN_RAW_AMOUNT) {
    throw new RangeError("amount_raw exceeds the maximum u64 token amount");
  }
  return amount_raw;
}

function rawAmountFromPlainDecimalText(amountText, decimals) {
  if (typeof amountText !== "string" || !/^\d+(?:\.\d+)?$/.test(amountText)) {
    throw new TypeError("--amount must be a positive plain decimal value");
  }
  const [wholeText, fractionalText = ""] = amountText.split(".");
  if (fractionalText.length > decimals) {
    throw new RangeError(`--amount supports at most ${decimals} fractional digits for this source token`);
  }
  const rawText = `${wholeText}${fractionalText.padEnd(decimals, "0")}`.replace(/^0+/, "") || "0";
  if (rawText === "0") throw new RangeError("--amount must be greater than zero");
  return exactPositiveRawAmount(rawText);
}

function parseExactPositiveDecimalText(amountText) {
  if (typeof amountText !== "string") {
    throw new TypeError("--amount must be a positive decimal number");
  }
  const match = EXACT_POSITIVE_DECIMAL_RE.exec(amountText);
  if (!match) throw new TypeError("--amount must be a positive decimal number");

  const whole = match[1] ?? "0";
  const fraction = match[2] ?? match[3] ?? "";
  const digits = `${whole}${fraction}`.replace(/^0+/, "");
  if (!digits) throw new RangeError("--amount must be greater than zero");
  return {
    digits,
    fractionalDigits: BigInt(fraction.length),
    exponent: BigInt(match[4] ?? "0"),
  };
}

// Converts the legacy CLI token-unit spelling to raw u64 units without a
// Number/parseFloat/Math.pow round-trip. `decimals` comes from the source mint
// account at execution time when it was not known at preflight.
function rawAmountFromExactDecimalText(amountText, decimals) {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new TypeError("Source token decimals are invalid");
  }
  const parsed = parseExactPositiveDecimalText(amountText);
  const scale = BigInt(decimals) + parsed.exponent - parsed.fractionalDigits;
  let rawText;

  if (scale < 0n) {
    const digitsToRemove = -scale;
    if (digitsToRemove > BigInt(parsed.digits.length)) {
      throw new RangeError(`--amount supports at most ${decimals} fractional digits for this source token`);
    }
    const removeCount = Number(digitsToRemove);
    if (!parsed.digits.endsWith("0".repeat(removeCount))) {
      throw new RangeError(`--amount supports at most ${decimals} fractional digits for this source token`);
    }
    rawText = parsed.digits.slice(0, parsed.digits.length - removeCount);
  } else {
    // A u64 has at most 20 base-10 digits. Bound the exponent before Number()
    // or repeat(), so malicious exponent text cannot allocate large strings.
    if (BigInt(parsed.digits.length) + scale > 20n) {
      throw new RangeError("--amount exceeds the maximum u64 token amount");
    }
    rawText = `${parsed.digits}${"0".repeat(Number(scale))}`;
  }

  return exactPositiveRawAmount(rawText);
}

// Kept public for callers that already hold an authoritative SPL mint-decimal
// value. It is intentionally pure so validation remains exact and testable
// without opening a wallet, RPC connection, or transaction path.
export function rawAmountFromTokenUnits(amountText, decimals) {
  return rawAmountFromExactDecimalText(amountText, decimals);
}

async function authoritativeMintDecimals(connection, mint) {
  const mintInfo = await connection.getParsedAccountInfo(new PublicKey(mint));
  const account = mintInfo?.value;
  if (!account) {
    throw new Error("Invalid source mint account: account does not exist");
  }
  if (account.executable) {
    throw new Error("Invalid source mint account: mint accounts cannot be executable");
  }
  const owner = typeof account.owner === "string"
    ? account.owner
    : account.owner?.toBase58?.();
  if (!SPL_TOKEN_PROGRAM_OWNERS.has(owner)) {
    throw new Error("Invalid source mint account: owner is not a supported SPL token program");
  }
  const parsed = account.data?.parsed;
  if (!parsed || parsed.type !== "mint" || !parsed.info || typeof parsed.info !== "object") {
    throw new Error("Invalid source mint account: account data is not a parsed mint");
  }
  const decimals = parsed.info.decimals;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new Error("Invalid source mint account: decimals are invalid");
  }
  return decimals;
}

/**
 * Bind the documented CLI swap command to canonical mints and an exact raw
 * u64 amount. The original CLI text is the only source of raw authority;
 * amount is retained solely as display metadata for existing swap results.
 */
export function bindCliSwapAuthority({ from, to, amountText } = {}) {
  const sourceAsset = typeof from === "string" ? from : "";
  const sourceDecimals = CLI_SWAP_SOURCE_DECIMALS[sourceAsset];
  if (sourceDecimals === undefined) {
    return { allowed: false, reason: "--from must be exactly SOL, USDC, or USDT" };
  }

  const input_mint = canonicalSolanaPublicKey(config.tokens?.[sourceAsset]);
  if (!input_mint) {
    return { allowed: false, reason: `Configured ${sourceAsset} mint is invalid` };
  }

  const outputAsset = typeof to === "string" ? to : "";
  const output_mint = canonicalSolanaPublicKey(
    Object.hasOwn(CLI_SWAP_SOURCE_DECIMALS, outputAsset)
      ? config.tokens?.[outputAsset]
      : outputAsset,
  );
  if (!output_mint) {
    return { allowed: false, reason: "--to must be SOL, USDC, USDT, or a valid 32-byte Solana public key" };
  }
  if (input_mint === output_mint) {
    return { allowed: false, reason: "--from and --to must resolve to different mints" };
  }

  try {
    const amount_raw = rawAmountFromPlainDecimalText(amountText, sourceDecimals);
    return {
      allowed: true,
      args: Object.freeze({ input_mint, output_mint, amount: amountText, amount_raw }),
    };
  } catch (error) {
    return { allowed: false, reason: error.message };
  }
}

export async function swapToken({
  input_mint,
  output_mint,
  amount,
  amount_raw,
  use_referral = true,
}, dependencies = {}) {
  // The optional second argument is an internal test seam. It is separate
  // from provider/CLI arguments, so untrusted swap authority cannot override
  // wallet, network, signing, or dry-run dependencies.
  const runtime = {
    isDryRun: dependencies.isDryRun ?? isEffectiveDryRun,
    getConnection: dependencies.getConnection ?? getConnection,
    getWallet: dependencies.getWallet ?? getWallet,
    fetch: dependencies.fetch ?? fetch,
    deserializeTransaction: dependencies.deserializeTransaction ?? VersionedTransaction.deserialize,
    log: dependencies.log ?? log,
  };
  input_mint  = normalizeMint(input_mint);
  output_mint = normalizeMint(output_mint);
  const hasBoundRawAmount = amount_raw !== undefined && amount_raw !== null;
  let amountStr;
  try {
    // CLI aliases bind raw u64 in preflight. An arbitrary canonical source
    // mint retains the legacy token-unit contract: validate its original text
    // before this point, then resolve the source mint decimals authoritatively
    // only on the execution path.
    if (hasBoundRawAmount) {
      amountStr = exactPositiveRawAmount(amount_raw);
    } else {
      parseExactPositiveDecimalText(amount);
    }
  } catch (error) {
    return { success: false, error: error.message };
  }

  if (runtime.isDryRun()) {
    return {
      dry_run: true,
      would_swap: {
        input_mint,
        output_mint,
        amount,
        ...(hasBoundRawAmount ? { amount_raw: amountStr } : {}),
      },
      message: "DRY RUN — no transaction sent",
    };
  }

  try {
    if (!hasBoundRawAmount) {
      const decimals = await authoritativeMintDecimals(runtime.getConnection(), input_mint);
      amountStr = rawAmountFromTokenUnits(amount, decimals);
    }
    runtime.log("swap", `${amount_raw != null ? `${amount_raw} raw` : amount} of ${input_mint} → ${output_mint}`);
    const wallet = runtime.getWallet();

    // ─── Get Swap V2 order (unsigned tx + requestId) ───────────
    const search = new URLSearchParams({
      inputMint: input_mint,
      outputMint: output_mint,
      amount: amountStr,
      taker: wallet.publicKey.toString(),
    });
    const referralParams = use_referral ? getJupiterReferralParams() : null;
    if (referralParams) {
      search.set("referralAccount", referralParams.referralAccount);
      search.set("referralFee", String(referralParams.referralFee));
    }
    const orderUrl = `${JUPITER_SWAP_V2_API}/order?${search.toString()}`;
    const jupiterApiKey = getJupiterApiKey();

    const orderRes = await runtime.fetch(orderUrl, {
      headers: jupiterApiKey ? { "x-api-key": jupiterApiKey } : {},
    });
    if (!orderRes.ok) {
      const body = await orderRes.text();
      throw new Error(`Swap V2 order failed: ${orderRes.status} ${body}`);
    }

    const order = await orderRes.json();
    if (order.errorCode || order.errorMessage) {
      throw new Error(`Swap V2 order error: ${order.errorMessage || order.errorCode}`);
    }

    const { transaction: unsignedTx, requestId } = order;

    // ─── Deserialize and sign ─────────────────────────────────
    const tx = runtime.deserializeTransaction(Buffer.from(unsignedTx, "base64"));
    tx.sign([wallet]);
    const signedTx = Buffer.from(tx.serialize()).toString("base64");

    // ─── Execute ───────────────────────────────────────────────
    const execRes = await runtime.fetch(`${JUPITER_SWAP_V2_API}/execute`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(jupiterApiKey ? { "x-api-key": jupiterApiKey } : {}),
      },
      body: JSON.stringify({ signedTransaction: signedTx, requestId }),
    });
    if (!execRes.ok) {
      throw new Error(`Swap V2 execute failed: ${execRes.status} ${await execRes.text()}`);
    }

    const result = await execRes.json();
    if (result.status === "Failed") {
      throw new Error(`Swap failed on-chain: code=${result.code}`);
    }

    runtime.log("swap", `SUCCESS tx: ${result.signature}`);
    if (referralParams && order.feeBps !== referralParams.referralFee) {
      runtime.log(
        "swap_warn",
        `Jupiter referral fee requested ${referralParams.referralFee} bps but order applied ${order.feeBps ?? "unknown"} bps`,
      );
    }

    return {
      success: true,
      tx: result.signature,
      input_mint,
      output_mint,
      amount_in: result.inputAmountResult,
      amount_out: result.outputAmountResult,
      amount_raw_in_requested: amountStr,
      referral_account: referralParams?.referralAccount || null,
      referral_fee_bps_requested: referralParams?.referralFee || 0,
      fee_bps_applied: order.feeBps ?? null,
      fee_mint: order.feeMint ?? null,
    };
  } catch (error) {
    runtime.log("swap_error", error.message);
    return { success: false, error: error.message };
  }
}

export async function quoteTokenSwap({
  input_mint,
  output_mint = "SOL",
  amount_raw,
  use_referral = false,
}) {
  input_mint = normalizeMint(input_mint);
  output_mint = normalizeMint(output_mint);
  const raw = String(amount_raw ?? "");
  if (!/^\d+$/.test(raw) || BigInt(raw) <= 0n) throw new Error("amount_raw must be a positive integer string");
  const wallet = getWallet();
  const search = new URLSearchParams({
    inputMint: input_mint,
    outputMint: output_mint,
    amount: raw,
    taker: wallet.publicKey.toString(),
  });
  const referralParams = use_referral ? getJupiterReferralParams() : null;
  if (referralParams) {
    search.set("referralAccount", referralParams.referralAccount);
    search.set("referralFee", String(referralParams.referralFee));
  }
  const apiKey = getJupiterApiKey();
  const response = await fetch(`${JUPITER_SWAP_V2_API}/order?${search}`, {
    headers: apiKey ? { "x-api-key": apiKey } : {},
    signal: AbortSignal.timeout(READ_ONLY_HTTP_TIMEOUT_MS),
  });
  if (!response.ok) {
    return { routeFound: false, error: `Jupiter order ${response.status}: ${await response.text()}` };
  }
  const order = await response.json();
  if (order.errorCode || order.errorMessage || !order.transaction) {
    return { routeFound: false, error: order.errorMessage || order.errorCode || "No executable route" };
  }
  const worstOutLamports = String(order.outAmount ?? order.outputAmount ?? order.otherAmountThreshold ?? "0");
  const signatureFeeLamports = BigInt(String(order.signatureFeeLamports ?? 5_000));
  const prioritizationFeeLamports = BigInt(String(order.prioritizationFeeLamports ?? 0));
  const rentFeeLamports = BigInt(String(order.rentFeeLamports ?? 0));
  const networkFeeLamports = signatureFeeLamports + prioritizationFeeLamports + rentFeeLamports;
  const impact = Number(order.priceImpactPct ?? 0);
  return {
    routeFound: BigInt(worstOutLamports) > 0n,
    worstOutLamports,
    networkFeeLamports: networkFeeLamports.toString(),
    priceImpactBps: String(Math.max(0, Math.round(impact * 100))),
    worstNetLamports: (BigInt(worstOutLamports) > networkFeeLamports ? BigInt(worstOutLamports) - networkFeeLamports : 0n).toString(),
    rawOrder: order,
  };
}
