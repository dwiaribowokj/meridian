import { PublicKey } from "@solana/web3.js";

// This module is intentionally limited to argv validation. Do not import
// project modules here: a rejected command must not load configuration,
// secrets, wallets, executors, or SDK boundaries.
const TOKEN_MINTS = Object.freeze({
  SOL: "So11111111111111111111111111111111111111112",
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
});
const SWAP_SOURCE_DECIMALS = Object.freeze({ SOL: 9, USDC: 6, USDT: 6 });
const MAX_U64 = (1n << 64n) - 1n;

// Keep this list aligned with cli.js. Every option must be declared here so
// unrecognized switches fail before configuration, wallets, or executors load.
const VALUE_FLAGS = new Set([
  "pool", "amount", "position", "from", "to", "strategy", "query",
  "mint", "wallet", "timeframe", "reason", "bins-below", "bins-above",
  "amount-x", "amount-y", "bps", "limit",
]);
const BOOLEAN_FLAGS = new Set([
  "no-claim", "skip-swap", "dry-run", "silent", "single-sided-x",
  "allow-duplicate-pool", "help",
]);
const COMMANDS = new Set([
  "balance", "positions", "pnl", "candidates", "token-info", "token-holders",
  "token-narrative", "pool-detail", "search-pools", "active-bin", "wallet-positions",
  "deploy", "claim", "close", "swap", "screen", "manage", "config", "study",
  "start", "lessons", "pool-memory", "evolve", "blacklist", "performance",
  "discord-signals", "withdraw-liquidity", "add-liquidity", "help",
]);
const DECIMAL_NUMBER_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const INTEGER_RE = /^[+]?\d+$/;
// This is the positive subset of the legacy JavaScript decimal spellings the
// CLI accepted through parseFloat.  It deliberately includes `.5`, `1e-3`,
// `01`, and `1.`.  Conversion below is string/BigInt-only: this grammar must
// never be passed through Number before it becomes a token raw amount.
const EXACT_POSITIVE_DECIMAL_RE = /^\+?(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/;

function rejected(error) {
  return { ok: false, error };
}

// A CLI address is an authority token, not a user-friendly input field. It
// must already be the one canonical base58 encoding of exactly 32 bytes.
export function canonicalCliPublicKey(value) {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    return null;
  }
  try {
    const canonical = new PublicKey(value).toBase58();
    return canonical === value ? canonical : null;
  } catch {
    return null;
  }
}

function longFlagName(token) {
  if (!token.startsWith("--") || token === "--") return null;
  const equals = token.indexOf("=");
  return token.slice(2, equals === -1 ? undefined : equals);
}

function isKnownLongFlag(name) {
  return VALUE_FLAGS.has(name) || BOOLEAN_FLAGS.has(name);
}

function parseLongFlags(argv) {
  const flags = Object.create(null);
  const positionals = [];
  let separatorPositionals = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") {
      separatorPositionals = argv.slice(index + 1);
      positionals.push(...separatorPositionals);
      break;
    }
    if (!token.startsWith("-")) {
      positionals.push(token);
      continue;
    }

    if (!token.startsWith("--")) {
      return rejected(`Unknown CLI flag: ${token}`);
    }

    const equals = token.indexOf("=");
    const name = token.slice(2, equals === -1 ? undefined : equals);
    const inlineValue = equals === -1 ? undefined : token.slice(equals + 1);
    if (!name) return rejected("Unknown CLI flag: --?");
    if (Object.hasOwn(flags, name)) return rejected(`Duplicate CLI flag: --${name}`);

    if (!isKnownLongFlag(name)) return rejected(`Unknown CLI flag: --${name}`);

    if (BOOLEAN_FLAGS.has(name)) {
      // Keep parseArgs' established --flag=value shape. Only a bare flag is
      // truthy for CLI behavior, matching the former argv.includes checks.
      flags[name] = inlineValue === undefined ? true : inlineValue;
      continue;
    }

    if (VALUE_FLAGS.has(name)) {
      const value = inlineValue === undefined ? argv[index + 1] : inlineValue;
      // Numeric values such as -0.5 are values, not switches. Other option
      // tokens are never consumed as values, so an unknown flag cannot hide
      // behind a declared option. Lexically numeric negatives still reach the
      // receiving command's ordinary numeric policy.
      if (
        value === undefined
        || value === "--"
      ) {
        return rejected(`Missing value for --${name}`);
      }
      if (value.startsWith("--")) {
        const valueFlag = longFlagName(value);
        return rejected(
          valueFlag && isKnownLongFlag(valueFlag)
            ? `Missing value for --${name}`
            : `Unknown CLI flag: --${valueFlag || "?"}`,
        );
      }
      if (value.startsWith("-") && !DECIMAL_NUMBER_RE.test(value)) {
        return rejected(`Unknown CLI flag: ${value}`);
      }
      if (inlineValue === undefined) index += 1;
      if (value === "") return rejected(`Missing value for --${name}`);
      flags[name] = value;
      continue;
    }
  }

  return { ok: true, flags, positionals, separatorPositionals };
}

function requirePublicKey(value, label) {
  return canonicalCliPublicKey(value)
    ? null
    : `${label} must be one exact canonical Solana public key`;
}

function validateFlagPublicKeys(flags) {
  for (const name of ["pool", "position", "mint", "wallet"]) {
    if (!Object.hasOwn(flags, name)) continue;
    const error = requirePublicKey(flags[name], `--${name}`);
    if (error) return error;
  }
  return null;
}

function parseFiniteNumber(value, flag, { positive = false, nonnegative = false } = {}) {
  if (typeof value !== "string" || !DECIMAL_NUMBER_RE.test(value)) {
    return rejected(`${flag} must be a finite decimal number`);
  }
  const number = Number(value);
  if (!Number.isFinite(number)) return rejected(`${flag} must be a finite decimal number`);
  if (positive && number <= 0) return rejected(`${flag} must be greater than zero`);
  if (nonnegative && number < 0) return rejected(`${flag} must be zero or greater`);
  return { ok: true, number };
}

function validateNonnegativeInteger(value, flag, { maximum = null, minimum = 0 } = {}) {
  if (typeof value !== "string" || !INTEGER_RE.test(value)) {
    return rejected(`${flag} must be a non-negative whole number`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || (maximum !== null && number > maximum)) {
    return rejected(`${flag} must be a whole number from ${minimum}${maximum === null ? " upward" : ` to ${maximum}`}`);
  }
  return { ok: true, number };
}

function validateNumericFlags(command, flags) {
  if (Object.hasOwn(flags, "limit")) {
    const limit = validateNonnegativeInteger(flags.limit, "--limit");
    if (!limit.ok) return limit;
  }

  if (command === "deploy") {
    for (const name of ["amount", "amount-x", "amount-y"]) {
      if (!Object.hasOwn(flags, name)) continue;
      const amount = parseFiniteNumber(flags[name], `--${name}`, { positive: name === "amount", nonnegative: name !== "amount" });
      if (!amount.ok) return amount;
    }
    for (const name of ["bins-below", "bins-above"]) {
      if (!Object.hasOwn(flags, name)) continue;
      const bins = validateNonnegativeInteger(flags[name], `--${name}`);
      if (!bins.ok) return bins;
    }
  }

  if (command === "add-liquidity") {
    for (const name of ["amount-x", "amount-y"]) {
      if (!Object.hasOwn(flags, name)) continue;
      const amount = parseFiniteNumber(flags[name], `--${name}`, { nonnegative: true });
      if (!amount.ok) return amount;
    }
  }

  if (command === "withdraw-liquidity" && Object.hasOwn(flags, "bps")) {
    const bps = validateNonnegativeInteger(flags.bps, "--bps", { minimum: 1, maximum: 10000 });
    if (!bps.ok) return bps;
  }

  return { ok: true };
}

function validateIdentity({ flags, positionals, flag, label, usage, allowMissing = false }) {
  const extras = positionals.slice(1);
  if (extras.length > 1) return rejected(`Unexpected positional argument for ${label}`);
  const positional = extras[0];
  const flagValue = flags[flag];

  if (!flagValue && !positional) return allowMissing ? { ok: true } : rejected(usage);
  if (positional) {
    const positionalError = requirePublicKey(positional, label);
    if (positionalError) return rejected(positionalError);
  }
  if (flagValue && positional && canonicalCliPublicKey(flagValue) !== canonicalCliPublicKey(positional)) {
    return rejected(`Conflicting ${label} supplied by --${flag} and positional argument`);
  }
  return { ok: true };
}

function parseExactPositiveDecimalText(amountText) {
  if (typeof amountText !== "string") {
    return rejected("--amount must be a positive decimal number");
  }
  const match = EXACT_POSITIVE_DECIMAL_RE.exec(amountText);
  if (!match) return rejected("--amount must be a positive decimal number");

  const whole = match[1] ?? "0";
  const fraction = match[2] ?? match[3] ?? "";
  const digits = `${whole}${fraction}`.replace(/^0+/, "");
  if (!digits) return rejected("--amount must be greater than zero");

  return {
    ok: true,
    digits,
    fractionalDigits: BigInt(fraction.length),
    exponent: BigInt(match[4] ?? "0"),
  };
}

function exactRawAmountFromDecimalText(amountText, decimals) {
  const parsed = parseExactPositiveDecimalText(amountText);
  if (!parsed.ok) return parsed;
  if (!Number.isInteger(decimals) || decimals < 0) {
    return rejected("Source token decimals are invalid");
  }

  const scale = BigInt(decimals) + parsed.exponent - parsed.fractionalDigits;
  let rawText;
  if (scale < 0n) {
    const digitsToRemove = -scale;
    if (digitsToRemove > BigInt(parsed.digits.length)) {
      return rejected(`--amount supports at most ${decimals} fractional digits for this source token`);
    }
    const removeCount = Number(digitsToRemove);
    if (!parsed.digits.endsWith("0".repeat(removeCount))) {
      return rejected(`--amount supports at most ${decimals} fractional digits for this source token`);
    }
    rawText = parsed.digits.slice(0, parsed.digits.length - removeCount);
  } else {
    // No raw u64 can have more than 20 decimal digits. Check before turning
    // the exponent into a Number or allocating a large zero-filled string.
    if (BigInt(parsed.digits.length) + scale > 20n) {
      return rejected("--amount exceeds the maximum u64 token amount");
    }
    rawText = `${parsed.digits}${"0".repeat(Number(scale))}`;
  }

  const amountRaw = BigInt(rawText);
  if (amountRaw === 0n) return rejected("--amount must be greater than zero");
  if (amountRaw > MAX_U64) return rejected("--amount exceeds the maximum u64 token amount");
  return { ok: true, amount_raw: amountRaw.toString() };
}

function validateSwap(flags, positionals, { allowMissing = false } = {}) {
  if (positionals.length !== 1) return rejected("Unexpected positional argument for swap");
  const supplied = ["from", "to", "amount"].some((name) => Object.hasOwn(flags, name));
  if (!flags.from || !flags.to || !flags.amount) {
    return allowMissing && !supplied
      ? { ok: true }
      : rejected("Usage: meridian swap --from <SOL|USDC|USDT|base58_mint> --to <SOL|USDC|USDT|base58_mint> --amount <token_unit_decimal>");
  }

  const inputAliasDecimals = SWAP_SOURCE_DECIMALS[flags.from];
  const inputMint = inputAliasDecimals === undefined ? canonicalCliPublicKey(flags.from) : TOKEN_MINTS[flags.from];
  if (!inputMint) {
    return rejected("--from must be SOL, USDC, USDT, or one exact canonical Solana public key");
  }
  const outputMint = Object.hasOwn(TOKEN_MINTS, flags.to)
    ? TOKEN_MINTS[flags.to]
    : canonicalCliPublicKey(flags.to);
  if (!outputMint) {
    return rejected("--to must be SOL, USDC, USDT, or one exact canonical Solana public key");
  }
  if (inputMint === outputMint) return rejected("--from and --to must resolve to different mints");

  // Known aliases have authoritative decimals, so their exact raw u64 can be
  // bound before any protected import. An arbitrary canonical source mint
  // retains HEAD's token-unit semantics: preflight validates only the exact
  // decimal text, then wallet.js converts it after fetching the mint's
  // authoritative decimals during execution.
  const amount = inputAliasDecimals === undefined
    ? parseExactPositiveDecimalText(flags.amount)
    : exactRawAmountFromDecimalText(flags.amount, inputAliasDecimals);
  if (!amount.ok) return amount;
  return {
    ok: true,
    swapAuthority: Object.freeze({
      input_mint: inputMint,
      output_mint: outputMint,
      amount: flags.amount,
      ...(inputAliasDecimals === undefined ? {} : { amount_raw: amount.amount_raw }),
    }),
  };
}

function validateCommand(command, flags, positionals, { forHelp = false } = {}) {
  const publicKeyError = validateFlagPublicKeys(flags);
  if (publicKeyError) return rejected(publicKeyError);
  const numeric = validateNumericFlags(command, flags);
  if (!numeric.ok) return numeric;

  switch (command) {
    case "pnl":
      return validateIdentity({ flags, positionals, flag: "position", label: "position address", usage: "Usage: meridian pnl <position_address>", allowMissing: forHelp });
    case "token-holders":
    case "token-narrative":
      return validateIdentity({ flags, positionals, flag: "mint", label: "mint address", usage: `Usage: meridian ${command} --mint <addr>`, allowMissing: forHelp });
    case "wallet-positions":
      return validateIdentity({ flags, positionals, flag: "wallet", label: "wallet address", usage: "Usage: meridian wallet-positions --wallet <addr>", allowMissing: forHelp });
    case "deploy":
      if (!flags.pool && !forHelp) return rejected("Usage: meridian deploy --pool <addr> --amount <sol>");
      if (!forHelp && !flags.amount && !flags["amount-x"]) return rejected("--amount or --amount-x is required");
      if (!forHelp && !flags.amount && Number(flags["amount-x"]) <= 0) {
        return rejected("--amount or --amount-x is required");
      }
      return { ok: true };
    case "pool-detail":
    case "active-bin":
    case "study":
    case "pool-memory":
      return flags.pool || forHelp ? { ok: true } : rejected(`Usage: meridian ${command} --pool <addr>`);
    case "claim":
    case "close":
      return flags.position || forHelp ? { ok: true } : rejected(`Usage: meridian ${command} --position <addr>`);
    case "withdraw-liquidity":
    case "add-liquidity":
      if (forHelp && !flags.position && !flags.pool) return { ok: true };
      if (!flags.position) return rejected(`Usage: meridian ${command} --position <addr> --pool <addr>`);
      return flags.pool ? { ok: true } : rejected("--pool is required");
    case "blacklist":
      if (positionals[1] === "add" && !flags.mint && !forHelp) return rejected("Usage: meridian blacklist add --mint <addr> --reason <text>");
      return { ok: true };
    case "swap":
      return validateSwap(flags, positionals, { allowMissing: forHelp });
    case "token-info":
      if (flags.query && flags.mint) return rejected("Conflicting --query and --mint arguments");
      if (positionals.length > 2) return rejected("Unexpected positional argument for token-info");
      if ((flags.query || flags.mint) && positionals.length > 1) {
        return rejected("Conflicting token-info flag and positional argument");
      }
      return flags.query || flags.mint || positionals[1] || forHelp
        ? { ok: true }
        : rejected("Usage: meridian token-info --query <mint_or_symbol>");
    default:
      return { ok: true };
  }
}

function helpTarget(positionals) {
  if (positionals[0] === "help" && COMMANDS.has(positionals[1])) {
    return {
      command: positionals[1],
      positionals: [positionals[1], ...positionals.slice(2)],
    };
  }
  return COMMANDS.has(positionals[0]) && positionals[0] !== "help"
    ? { command: positionals[0], positionals }
    : null;
}

function mergeHelpFlags(primaryFlags, separatorFlags) {
  const merged = Object.assign(Object.create(null), primaryFlags);
  for (const [name, value] of Object.entries(separatorFlags)) {
    if (Object.hasOwn(merged, name)) return rejected(`Duplicate CLI flag: --${name}`);
    merged[name] = value;
  }
  return { ok: true, flags: merged };
}

function parseHelpSeparator(separatorPositionals) {
  if (separatorPositionals.length === 0) {
    return { ok: true, flags: Object.create(null), positionals: [] };
  }
  // A separator normally protects free-form command arguments. On a help
  // path it must not conceal authority-shaped input from preflight. Reparse
  // its contents as argv, retaining genuine positionals for the target
  // command's own validation.
  const parsed = parseLongFlags(separatorPositionals);
  if (!parsed.ok) return parsed;
  if (parsed.separatorPositionals.length > 0) {
    return rejected("Unexpected argument separator in help input");
  }
  return { ok: true, flags: parsed.flags, positionals: parsed.positionals };
}

function validateHelpSeparatorPositionals(command, separatorPositionals) {
  if (separatorPositionals.length === 0) return { ok: true };
  // These commands intentionally accept free-form positionals. Commands with
  // identity positionals are checked by validateCommand below; every other
  // command must fail closed rather than let `--` hide an authority-shaped
  // malformed argument.
  if (new Set([
    "pnl", "token-holders", "token-narrative", "wallet-positions", "token-info",
    "config", "lessons", "blacklist", "discord-signals",
  ]).has(command)) {
    return { ok: true };
  }
  return rejected(`Unexpected positional argument for ${command}`);
}

export function preflightCli(argv) {
  const parsed = parseLongFlags(argv);
  if (!parsed.ok) return parsed;
  const { flags, positionals, separatorPositionals } = parsed;
  const positionalsBeforeSeparator = separatorPositionals.length > 0
    ? positionals.slice(0, -separatorPositionals.length)
    : positionals;
  const command = positionalsBeforeSeparator[0];
  const help = !command || command === "help" || flags.help === true;

  if (help) {
    // Validate the target command before returning help, but do not turn an
    // ordinary `command --help` with no inputs into a usage failure.
    const target = helpTarget(positionalsBeforeSeparator);
    const separated = parseHelpSeparator(separatorPositionals);
    if (!separated.ok) return separated;
    const merged = mergeHelpFlags(flags, separated.flags);
    if (!merged.ok) return merged;
    if (target) {
      const positionalValidation = validateHelpSeparatorPositionals(target.command, separated.positionals);
      if (!positionalValidation.ok) return positionalValidation;
      const validation = validateCommand(
        target.command,
        merged.flags,
        [...target.positionals, ...separated.positionals],
        { forHelp: true },
      );
      if (!validation.ok) return validation;
    } else {
      // Bare help has no command grammar to lend meaning to separator
      // positionals, so reject them. Recognized authority/swap flags are
      // still parsed and validated first, never silently ignored.
      if (separated.positionals.length > 0) {
        return rejected("Unexpected positional argument for help");
      }
      const publicKeyError = validateFlagPublicKeys(merged.flags);
      if (publicKeyError) return rejected(publicKeyError);
      if (["from", "to", "amount"].some((name) => Object.hasOwn(merged.flags, name))) {
        const swap = validateSwap(merged.flags, ["swap"]);
        if (!swap.ok) return swap;
      }
    }
    return { ok: true, flags, positionals, command, help: true };
  }

  if (!COMMANDS.has(command)) return rejected(`Unknown command: ${command}. Run 'meridian help' for usage.`);
  const validation = validateCommand(command, flags, positionals);
  return validation.ok
    ? { ok: true, flags, positionals, command, help: false, swapAuthority: validation.swapAuthority }
    : validation;
}
