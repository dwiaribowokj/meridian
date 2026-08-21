import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-cli-public-key-"));
const home = path.join(tmp, "home");
const captureFile = path.join(tmp, "capture.jsonl");
const here = path.dirname(fileURLToPath(import.meta.url));
const loader = path.join(here, "cli-public-key-loader.mjs");
const repo = path.join(here, "..");
const key = "So11111111111111111111111111111111111111111";
const alternateKey = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const protectedSources = new Set(["envcrypt", "config", "wallet", "executor", "dlmm"]);

function homeFiles(dir = home, prefix = "") {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const relative = path.join(prefix, entry.name);
    return entry.isDirectory() ? homeFiles(path.join(dir, entry.name), relative) : [relative];
  }).sort();
}

try {
  fs.mkdirSync(home, { recursive: true });

  function runCli(args) {
    fs.rmSync(captureFile, { force: true });
    fs.rmSync(path.join(home, ".meridian"), { recursive: true, force: true });
    const beforeHomeFiles = homeFiles();
    // Deliberately equivalent to env -i: no ambient repository, wallet, or
    // dotenv variables are inherited by this isolated subprocess.
    const result = spawnSync(process.execPath, ["--no-warnings", "--experimental-loader", loader, "cli.js", ...args], {
      cwd: repo,
      encoding: "utf8",
      env: {
        HOME: home,
        TMPDIR: tmp,
        MERIDIAN_CLI_TEST_CAPTURE_FILE: captureFile,
        MERIDIAN_CLI_TEST_PUBLIC_KEY: key,
      },
    });
    const events = fs.existsSync(captureFile)
      ? fs.readFileSync(captureFile, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
      : [];
    const afterHomeFiles = homeFiles();
    return {
      ...result,
      events,
      dispatches: events.filter((event) => event.kind === "dispatch"),
      protectedEvaluations: events.filter((event) => event.kind === "module" && protectedSources.has(event.source)),
      homeChanges: afterHomeFiles.filter((file) => !beforeHomeFiles.includes(file)),
    };
  }

  function assertRejectedInPreflight(args, description, error = /./) {
    const result = runCli(args);
    assert.equal(result.status, 1, description);
    assert.match(result.stderr, error, description);
    assert.deepEqual(result.dispatches, [], `${description}: no command was dispatched`);
    assert.deepEqual(result.protectedEvaluations, [], `${description}: no envcrypt/config/wallet/executor/DLMM module was evaluated`);
    assert.deepEqual(result.homeChanges, [], `${description}: rejected argv created no HOME files`);
    assert.equal(fs.existsSync(path.join(home, ".meridian", "SKILL.md")), false, `${description}: no SKILL.md was written`);
    assert.equal(fs.existsSync(path.join(home, ".meridian", ".env")), false, `${description}: no home .env was created`);
    return result;
  }

  function assertPureHelp(args, description) {
    const result = runCli(args);
    assert.equal(result.status, 0, description);
    assert.match(result.stdout, /meridian — Solana DLMM LP Agent CLI/, description);
    assert.deepEqual(result.dispatches, [], `${description}: help did not dispatch a command`);
    assert.deepEqual(result.protectedEvaluations, [], `${description}: help evaluated no protected module`);
    assert.deepEqual(result.homeChanges, [], `${description}: help created no HOME files`);
    assert.equal(fs.existsSync(path.join(home, ".meridian", "SKILL.md")), false, `${description}: help wrote no SKILL.md`);
    return result;
  }

  // Invalid authority-bearing values are rejected before every protected
  // boundary and before the former ~/.meridian/SKILL.md side effect.
  for (const [args, description, error] of [
    [["deploy", "--pool", "bad-key", "--amount", "0.1", "--dry-run"], "invalid pool", /exact canonical Solana public key/],
    [["deploy", "--pool", key, "--amount", "0.1not-a-number", "--dry-run"], "invalid deploy amount", /finite decimal number/],
    [["token-holders", "--mint", "bad-key"], "invalid mint", /exact canonical Solana public key/],
    [["claim", "--position", "bad-key", "--dry-run"], "invalid position", /exact canonical Solana public key/],
    [["wallet-positions", "--wallet", "bad-key"], "invalid wallet", /exact canonical Solana public key/],
    [["deploy", "--pool", "bad-key", "--help"], "invalid authority cannot hide behind help", /exact canonical Solana public key/],
    [["help", "deploy", "--", "--pool", "bad-key", "--amount", "0.1"], "help target validates separator authority", /exact canonical Solana public key/],
    [["deploy", "--help", "--", "--pool", "bad-key", "--amount", "0.1"], "command help validates separator authority", /exact canonical Solana public key/],
    [["--help", "--", "--pool", "bad-key"], "bare help validates separator authority", /exact canonical Solana public key/],
    [["balance", "--future-flag"], "unknown long flag is rejected before imports", /Unknown CLI flag/],
    [["balance", "-x"], "unknown short flag is rejected before imports", /Unknown CLI flag/],
    [["help", "balance", "--", "--future-flag"], "help target rejects unknown long flag after separator", /Unknown CLI flag/],
    [["balance", "--help", "--", "-x"], "command help rejects unknown short flag after separator", /Unknown CLI flag/],
    [["token-info", "--query", "--future-flag"], "unknown long flag cannot become a declared flag value", /Unknown CLI flag/],
  ]) {
    assertRejectedInPreflight(args, description, error);
  }

  // Swap authority is now fully grammar-checked before wallet or executor
  // imports, including aliases, destination keys, and exact raw amount limits.
  for (const [args, description] of [
    [["swap", "--from", "native", "--to", "USDC", "--amount", "0.1"], "invalid swap source alias"],
    [["swap", "--from", "SOL", "--to", "bad-key", "--amount", "0.1"], "invalid swap destination"],
    [["swap", "--from", "USDC", "--to", "SOL", "--amount", "0.0000001"], "invalid swap precision"],
    [["swap", "--from", "SOL", "--to", "USDC", "--amount", "0"], "zero swap amount"],
  ]) {
    assertRejectedInPreflight(args, description);
  }

  // Help validates every supplied command-specific authority input before it
  // can take the otherwise pure, side-effect-free help path.
  for (const [args, description, error] of [
    [["swap", "--from", "native", "--to", "USDC", "--amount", "0.1", "--help"], "help rejects invalid swap source", /--from must be/],
    [["swap", "--from", "SOL", "--to", "bad-key", "--amount", "0.1", "--help"], "help rejects invalid swap destination", /--to must be/],
    [["swap", "--from", "USDC", "--to", "SOL", "--amount", "0.0000001", "--help"], "help rejects invalid swap precision", /fractional digits/],
    [["swap", "--from", "SOL", "--to", "USDC", "--amount", "0", "--help"], "help rejects zero swap", /greater than zero/],
    [["pnl", "bad-key", "--help"], "help rejects malformed positional position", /exact canonical Solana public key/],
    [["token-holders", "bad-key", "--help"], "help rejects malformed positional mint", /exact canonical Solana public key/],
    [["wallet-positions", "bad-key", "--help"], "help rejects malformed positional wallet", /exact canonical Solana public key/],
    [["help", "pnl", "bad-key"], "help target rejects malformed positional position", /exact canonical Solana public key/],
    [["pnl", key, "--position", alternateKey, "--help"], "help rejects conflicting positional position", /Conflicting/],
    [["token-holders", key, "--mint", alternateKey, "--help"], "help rejects conflicting positional mint", /Conflicting/],
    [["wallet-positions", key, "--wallet", alternateKey, "--help"], "help rejects conflicting positional wallet", /Conflicting/],
  ]) {
    assertRejectedInPreflight(args, description, error);
  }

  for (const [args, description] of [
    [["--help"], "bare help is pure"],
    [["help", "balance"], "help target is pure"],
    [["swap", "--help"], "command help with no swap inputs is pure"],
    [["lessons", "add", "--help"], "free-form command help is pure"],
  ]) {
    assertPureHelp(args, description);
  }

  // Repeated flags are never last-value-wins, even when one or both values
  // are otherwise valid. A flag value cannot be another flag either.
  for (const args of [
    ["deploy", "--pool", "bad-key", "--pool", key, "--amount", "0.1"],
    ["deploy", "--pool", key, "--pool", "bad-key", "--amount", "0.1"],
    ["deploy", "--pool", key, "--pool", key, "--amount", "0.1"],
    ["deploy", "--pool", key, "--amount", "0.1", "--amount", "0.2"],
    ["deploy", "--pool", "--amount", "0.1"],
    ["deploy", "--pool", key, "--amount=0.1", "--amount=0.2"],
  ]) {
    assertRejectedInPreflight(args, `ambiguous argv ${args[0]}`, /Duplicate CLI flag|Missing value/);
  }

  // Values that begin with '-' are parsed as values and then rejected by the
  // command's real numeric semantics, rather than being mistaken for flags.
  for (const [args, description, error] of [
    [["deploy", "--pool", key, "--amount", "-0.5"], "negative deploy amount", /greater than zero/],
    [["deploy", "--pool", key, "--amount", "0.1", "--bins-below", "-1"], "negative bins below", /non-negative whole number/],
    [["withdraw-liquidity", "--position", key, "--pool", key, "--bps", "-1"], "negative bps", /non-negative whole number/],
    [["token-holders", "--mint", key, "--limit", "-1"], "negative limit", /non-negative whole number/],
  ]) {
    assertRejectedInPreflight(args, description, error);
  }

  // Commands that support identity positionals cannot silently prefer a flag.
  for (const args of [
    ["pnl", key, "--position", alternateKey],
    ["token-holders", key, "--mint", alternateKey],
    ["wallet-positions", key, "--wallet", alternateKey],
  ]) {
    assertRejectedInPreflight(args, `flag/positional conflict for ${args[0]}`, /Conflicting/);
  }

  // Whitespace, controls, lookalikes, Unicode, noncanonical suffixes, and
  // 64-byte private-key encodings are all rejected without echoing input.
  for (const invalidKey of [
    "1".repeat(31),
    "1".repeat(64),
    "0".repeat(32),
    ` ${key}`,
    `${key}\n`,
    `${key}\u0001`,
    `${key}\u200B`,
    `${key.replace("S", "Ѕ")}`,
    `${key}x`,
  ]) {
    const result = assertRejectedInPreflight(
      ["deploy", "--pool", invalidKey, "--amount", "0.1", "--dry-run"],
      "deploy rejects malformed canonical key",
      /exact canonical Solana public key/,
    );
    assert.equal(result.stderr.includes(invalidKey), false, "validation must not echo the rejected authority input");
  }

  // Canonical public keys reach the implementation boundary exactly once. The
  // loader also proves envcrypt is evaluated only after valid preflight.
  for (const { args, source, name, field } of [
    { args: ["pnl", key], source: "dlmm", name: "getPositionPnl", field: "position_address" },
    { args: ["token-info", "--mint", key], source: "token", name: "getTokenInfo", field: "query" },
    { args: ["token-holders", "--mint", key], source: "token", name: "getTokenHolders", field: "mint" },
    { args: ["token-narrative", "--mint", key], source: "token", name: "getTokenNarrative", field: "mint" },
    { args: ["pool-detail", "--pool", key], source: "screening", name: "getPoolDetail", field: "pool_address" },
    { args: ["active-bin", "--pool", key], source: "dlmm", name: "getActiveBin", field: "pool_address" },
    { args: ["wallet-positions", "--wallet", key], source: "dlmm", name: "getWalletPositions", field: "wallet_address" },
    { args: ["deploy", "--pool", key, "--amount", "0.1", "--dry-run"], source: "executor", name: "deploy_position", field: "pool_address" },
    { args: ["claim", "--position", key, "--dry-run"], source: "executor", name: "claim_fees", field: "position_address" },
    { args: ["close", "--position", key, "--dry-run"], source: "executor", name: "close_position", field: "position_address" },
    { args: ["study", "--pool", key], source: "study", name: "studyTopLPers", field: "pool_address" },
    { args: ["pool-memory", "--pool", key], source: "pool-memory", name: "getPoolMemory", field: "pool_address" },
    { args: ["blacklist", "add", "--mint", key, "--reason", "test"], source: "blacklist", name: "addToBlacklist", field: "mint" },
    { args: ["withdraw-liquidity", "--position", key, "--pool", key], source: "dlmm", name: "withdrawLiquidity", field: "position_address" },
    { args: ["add-liquidity", "--position", key, "--pool", key], source: "dlmm", name: "addLiquidity", field: "position_address" },
  ]) {
    const result = runCli(args);
    assert.equal(result.status, 0, `${args[0]} accepts a canonical key`);
    assert.equal(result.dispatches.length, 1, `${args[0]} dispatches exactly once`);
    assert.ok(result.protectedEvaluations.some((event) => event.source === "envcrypt"), `${args[0]} evaluates envcrypt only after a valid preflight`);
    const [capture] = result.dispatches;
    assert.equal(capture.source, source);
    assert.equal(capture.name, name);
    assert.equal(capture.args[field], key, `${args[0]} dispatches canonical base58 only`);
    if (["withdrawLiquidity", "addLiquidity"].includes(name)) {
      assert.equal(capture.args.pool_address, key, `${args[0]} canonicalizes both pool and position`);
    }
  }

  // parseArgs historically accepted normal JavaScript decimal spellings for
  // non-swap amounts. These forms remain compatible and dispatch exactly once.
  for (const [amountText, amount] of [[".5", 0.5], ["1e-3", 0.001], ["01", 1], ["1.", 1]]) {
    const result = runCli(["deploy", `--pool=${key}`, `--amount=${amountText}`, "--dry-run"]);
    assert.equal(result.status, 0, `deploy accepts legacy numeric spelling ${amountText}`);
    assert.equal(result.dispatches.length, 1, `deploy ${amountText} dispatches exactly once`);
    assert.equal(result.dispatches[0].name, "deploy_position");
    assert.equal(result.dispatches[0].args.pool_address, key);
    assert.equal(result.dispatches[0].args.amount_y, amount);
  }

  // The separator preserves literal free-form lesson text instead of trying
  // to parse its flag-looking words as CLI options.
  const lesson = runCli(["lessons", "add", "--", "keep", "--literal-flag", "text"]);
  assert.equal(lesson.status, 0, "lessons add accepts a separator");
  assert.deepEqual(lesson.dispatches, [{
    kind: "dispatch",
    source: "lessons",
    name: "addLesson",
    args: { text: "keep --literal-flag text", tags: [], options: { pinned: false, role: null } },
  }]);

  // --skip-swap remains accepted and observable to legacy callers, while the
  // underlying close path remains the already-established no-auto-swap path.
  const closeWithSkip = runCli(["close", "--position", key, "--skip-swap", "--dry-run"]);
  assert.equal(closeWithSkip.status, 0, "legacy --skip-swap is accepted");
  assert.deepEqual(closeWithSkip.dispatches, [{
    kind: "dispatch",
    source: "executor",
    name: "close_position",
    args: { position_address: key, skip_swap: true },
  }]);
  const closeWithLegacySkipValue = runCli(["close", "--position", key, "--skip-swap=legacy-value", "--dry-run"]);
  assert.deepEqual(closeWithLegacySkipValue.dispatches, [{
    kind: "dispatch",
    source: "executor",
    name: "close_position",
    args: { position_address: key, skip_swap: "legacy-value" },
  }], "--skip-swap=<value> retains the legacy flags['skip-swap'] ?? false dispatch shape");

  const swap = runCli(["swap", "--from", "SOL", "--to", "USDC", "--amount", "0.1", "--dry-run"]);
  assert.equal(swap.status, 0, "supported swap passes preflight");
  assert.equal(swap.dispatches.length, 1, "supported swap dispatches exactly once");
  assert.deepEqual(swap.dispatches[0], {
    kind: "dispatch",
    source: "executor",
    name: "swap_token",
    args: {
      input_mint: "So11111111111111111111111111111111111111112",
      output_mint: alternateKey,
      amount: "0.1",
      amount_raw: "100000000",
    },
  });
  assert.deepEqual(swap.protectedEvaluations.map((event) => event.source).sort(), ["envcrypt", "executor"]);

  // An arbitrary canonical source mint preserves HEAD's token-unit contract:
  // CLI authority retains its exact user text instead of silently treating it
  // as a raw amount.
  const sourceMintSwap = runCli(["swap", "--from", key, "--to", "USDC", "--amount", "42", "--dry-run"]);
  assert.equal(sourceMintSwap.status, 0, "canonical source mint accepts token-unit amount");
  assert.deepEqual(sourceMintSwap.dispatches, [{
    kind: "dispatch",
    source: "executor",
    name: "swap_token",
    args: {
      input_mint: key,
      output_mint: alternateKey,
      amount: "42",
    },
  }]);
  // Both source forms retain the legacy numeric spellings. Known aliases bind
  // their raw u64 in pure preflight; arbitrary canonical mints retain text for
  // the authoritative-decimals conversion above.
  for (const [amountText, expectedRaw] of [[".5", "500000000"], ["1e-3", "1000000"], ["01", "1000000000"], ["1.", "1000000000"]]) {
    const alias = runCli(["swap", "--from", "SOL", "--to", "USDC", "--amount", amountText, "--dry-run"]);
    assert.equal(alias.status, 0, `SOL accepts legacy swap amount ${amountText}`);
    assert.equal(alias.dispatches[0].args.amount_raw, expectedRaw, `${amountText} is bound without Number conversion`);
  }
  for (const [args, description, error] of [
    [["swap", "--from", key, "--to", "USDC", "--amount", "0"], "canonical source mint rejects zero token amount", /greater than zero/],
    [["swap", "--from", `${key}x`, "--to", "USDC", "--amount", "42"], "noncanonical source mint is rejected", /--from must be/],
  ]) {
    assertRejectedInPreflight(args, description, error);
  }

  // The source mint's decimals are authoritative only at execution. Exercise
  // the real wallet converter with an injected authoritative value in an
  // isolated safe runtime; it does not open a wallet, RPC, or transaction path.
  process.env.MERIDIAN_USER_CONFIG_FILE = path.join(tmp, "wallet-conversion-user-config.json");
  process.env.MERIDIAN_STATE_FILE = path.join(tmp, "wallet-conversion-state.json");
  process.env.MERIDIAN_LESSONS_FILE = path.join(tmp, "wallet-conversion-lessons.json");
  process.env.DRY_RUN = "true";
  fs.writeFileSync(process.env.MERIDIAN_USER_CONFIG_FILE, JSON.stringify({ dryRun: true, rolloutMode: "dry_run" }));
  fs.writeFileSync(process.env.MERIDIAN_STATE_FILE, JSON.stringify({ positions: {} }));
  const { rawAmountFromTokenUnits, swapToken } = await import("../tools/wallet.js");
  assert.equal(
    rawAmountFromTokenUnits(sourceMintSwap.dispatches[0].args.amount, 6),
    "42000000",
    "the actual CLI-dispatched arbitrary source amount converts through wallet code with injected decimals",
  );
  for (const [amountText, expectedRaw] of [
    ["42", "42000000"],
    [".5", "500000"],
    ["1e-3", "1000"],
    ["01", "1000000"],
    ["1.", "1000000"],
  ]) {
    assert.equal(rawAmountFromTokenUnits(amountText, 6), expectedRaw, `${amountText} converts with injected authoritative decimals`);
  }
  for (const [amountText, error] of [
    ["1.0000001", /fractional digits/],
    ["0", /greater than zero/],
    ["18446744073710", /maximum u64/],
  ]) {
    assert.throws(() => rawAmountFromTokenUnits(amountText, 6), error, `${amountText} is rejected before a route can be requested`);
  }

  // Exercise the real arbitrary-mint execution wiring without a wallet, RPC,
  // signature, route provider, or broadcast. The optional second argument is
  // an internal dependency seam, not part of CLI/provider swap authority.
  const splTokenOwner = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
  const validMintAccount = (decimals = 6, owner = splTokenOwner) => ({
    executable: false,
    owner,
    data: { parsed: { type: "mint", info: { decimals } } },
  });
  function inertSwapRuntime(account) {
    const calls = { mintLookup: 0, wallet: 0, routes: [], signing: 0, broadcast: 0 };
    return {
      calls,
      dependencies: {
        isDryRun: () => false,
        getConnection: () => ({
          getParsedAccountInfo: async () => {
            calls.mintLookup += 1;
            return { value: account };
          },
        }),
        getWallet: () => {
          calls.wallet += 1;
          return { publicKey: { toString: () => alternateKey } };
        },
        fetch: async (url) => {
          const requestUrl = String(url);
          if (requestUrl.endsWith("/execute")) {
            calls.broadcast += 1;
            return { ok: false, status: 500, text: async () => "unexpected execute" };
          }
          calls.routes.push(requestUrl);
          return { ok: false, status: 400, text: async () => "inert order rejection" };
        },
        deserializeTransaction: () => {
          calls.signing += 1;
          throw new Error("signing must not be reached in this inert route test");
        },
        log: () => {},
      },
    };
  }

  const wiredSwap = inertSwapRuntime(validMintAccount(6));
  const wiredResult = await swapToken({
    input_mint: key,
    output_mint: alternateKey,
    amount: "1e-3",
  }, wiredSwap.dependencies);
  assert.equal(wiredResult.success, false, "the inert order response stops the real swap before signing");
  assert.equal(wiredSwap.calls.mintLookup, 1, "an arbitrary source obtains authoritative mint metadata");
  assert.equal(wiredSwap.calls.wallet, 1, "a valid mint reaches route construction");
  assert.equal(wiredSwap.calls.routes.length, 1, "a valid mint constructs one route request");
  assert.equal(new URL(wiredSwap.calls.routes[0]).searchParams.get("amount"), "1000", "route construction receives the exact authoritative raw amount");
  assert.equal(wiredSwap.calls.signing, 0, "the inert order test never signs");
  assert.equal(wiredSwap.calls.broadcast, 0, "the inert order test never broadcasts");

  const token2022Swap = inertSwapRuntime(validMintAccount(6, "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"));
  await swapToken({ input_mint: key, output_mint: alternateKey, amount: ".5" }, token2022Swap.dependencies);
  assert.equal(token2022Swap.calls.routes.length, 1, "a Token-2022 mint reaches route construction");
  assert.equal(new URL(token2022Swap.calls.routes[0]).searchParams.get("amount"), "500000", "a Token-2022 mint uses its authoritative decimals");

  for (const { description, account, amount, error, mintLookup } of [
    { description: "missing source account", account: null, amount: "1", error: /account does not exist/, mintLookup: 1 },
    { description: "executable source account", account: { ...validMintAccount(), executable: true }, amount: "1", error: /cannot be executable/, mintLookup: 1 },
    { description: "wrong source account owner", account: { ...validMintAccount(), owner: "11111111111111111111111111111111" }, amount: "1", error: /supported SPL token program/, mintLookup: 1 },
    { description: "non-mint parsed source account", account: { ...validMintAccount(), data: { parsed: { type: "account", info: { decimals: 6 } } } }, amount: "1", error: /not a parsed mint/, mintLookup: 1 },
    { description: "malformed source account data", account: { ...validMintAccount(), data: { parsed: { type: "mint" } } }, amount: "1", error: /not a parsed mint/, mintLookup: 1 },
    { description: "invalid source mint decimals", account: validMintAccount("6"), amount: "1", error: /decimals are invalid/, mintLookup: 1 },
    { description: "out-of-range source mint decimals", account: validMintAccount(256), amount: "1", error: /decimals are invalid/, mintLookup: 1 },
    { description: "precision-excess amount", account: validMintAccount(), amount: "1.0000001", error: /fractional digits/, mintLookup: 1 },
    { description: "zero amount", account: validMintAccount(), amount: "0", error: /greater than zero/, mintLookup: 0 },
    { description: "u64-overflow amount", account: validMintAccount(), amount: "18446744073710", error: /maximum u64/, mintLookup: 1 },
  ]) {
    const failedSwap = inertSwapRuntime(account);
    const result = await swapToken({ input_mint: key, output_mint: alternateKey, amount }, failedSwap.dependencies);
    assert.equal(result.success, false, `${description} is rejected`);
    assert.match(result.error, error, `${description} returns the validation error`);
    assert.equal(failedSwap.calls.mintLookup, mintLookup, `${description} performs only its required mint lookup`);
    assert.equal(failedSwap.calls.wallet, 0, `${description} never loads a wallet`);
    assert.deepEqual(failedSwap.calls.routes, [], `${description} never requests a route`);
    assert.equal(failedSwap.calls.signing, 0, `${description} never signs`);
    assert.equal(failedSwap.calls.broadcast, 0, `${description} never broadcasts`);
  }

  console.log("cli public-key preflight policy tests passed");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
