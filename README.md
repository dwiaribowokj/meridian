# Meridian

**Autonomous Meteora DLMM liquidity management agent for Solana, powered by LLMs.**

**Links:** [Website](https://agentmeridian.xyz) | [Telegram](https://t.me/agentmeridian) | [X](https://x.com/meridian_agent)

Meridian runs continuous screening and management cycles, deploying capital into high-quality Meteora DLMM pools and closing positions based on live PnL, yield, and range data. It learns from every position it closes.

---

## What it does

- **Screens pools** — scans Meteora DLMM pools against configurable thresholds (fee/TVL ratio, organic score, holder count, mcap, bin step) and surfaces high-quality opportunities
- **Manages positions** — monitors, claims fees, and closes LP positions autonomously; decides to STAY, CLOSE, or REDEPLOY based on live data
- **Reconciles every trade** — records position-bound deploy/close receipts, converts only lifecycle-attributed residue, and settles authoritative SOL economics in an append-only ledger
- **Fails closed at live boundaries** — locks canary sizing, serializes deploys, and latches a durable circuit breaker when accounting, lifecycle, or risk evidence is unsafe
- **Maintains learning primitives** — supports lessons, performance history, and threshold evolution; automatic learning is frozen during the locked shadow/canary rollout
- **Discord signals** — optional Discord listener watches LP Army channels for Solana token calls and queues them for screening
- **Telegram chat** — full agent chat via Telegram, plus cycle reports and OOR alerts
- **Claude Code integration** — run AI-powered screening and management directly from your terminal using Claude Code slash commands

---

## How it works

Meridian runs a **ReAct agent loop** — each cycle the LLM reasons over live data, calls tools, and acts. Two specialized agents run on independent cron schedules:

| Agent | Default interval | Role |
|---|---|---|
| **Screening Agent** | Every 30 min (1 min in the locked rotation canary) | Pool screening — finds and deploys into the best candidate |
| **Management Agent** | Every 10 min | Position management — evaluates each open position and acts |

A separate PnL poller watches deterministic SL, TP, and OOR conditions between
management cycles. In the live canary, deterministic admission and exit policy
remain authoritative; the LLM can veto a candidate but cannot bypass a safety
gate or enlarge the locked exposure.

### Agent harness

Meridian's agent harness is the runtime wrapper around every autonomous cycle. It gives both **main** and **experimental** agents the same control loop: load live state, inject relevant memory, expose only role-appropriate tools, execute tool calls, and return a readable cycle report.

The harness also keeps a structured decision log in `decision-log.json` for deployments, closes, skips, and no-deploy outcomes. Each entry records the actor, pool or position, summary, reason, key risks, metrics, and rejected alternatives. Recent decisions are injected back into the system prompt and are available through `get_recent_decisions`, so the agent can answer "why did you deploy?", "why did you close?", or "why did you skip?" without guessing after the fact.

**Data sources:**
- `@meteora-ag/dlmm` SDK — on-chain position data, active bin, deploy/close transactions
- Meteora DLMM PnL API — position yield, fee accrual, PnL
- Pool screening API — fee/TVL ratios, volume, organic scores, holder counts
- Jupiter API — token audit, mcap, launchpad, price stats

Agents are powered via **OpenRouter** and can be swapped for any compatible model.

---

## Requirements

- Node.js 18+
- [OpenRouter](https://openrouter.ai) API key
- Solana wallet (base58 private key)
- Solana RPC endpoint ([Helius](https://helius.xyz) recommended)
- Telegram bot token (optional)
- [Claude Code](https://claude.ai/code) CLI (optional, for terminal slash commands)

---

## Setup

### 1. Clone & install

```bash
git clone https://github.com/yunus-0x/meridian
cd meridian
npm install
```

### 2. Run the setup wizard

```bash
npm run setup
```

The wizard writes **both** files at the repo root:

| Goes in `.env` | Goes in `user-config.json` |
|---|---|
| `WALLET_PRIVATE_KEY`, `OPENROUTER_API_KEY`, `RPC_URL`, `HELIUS_API_KEY` | Risk preset, deploy size, max positions |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TELEGRAM_ALLOWED_USER_IDS` | Strategy, screening filters, exit rules, trailing TP |
| `DRY_RUN` compatibility mirror, `EMERGENCY_STOP` | Rollout request (`dryRun`, `rolloutMode`), position sizing, cycle intervals, per-role LLM models, `solMode` |

`TELEGRAM_CHAT_ID` only needs to live in `.env` — setup also copies it to `user-config.json` when provided. Takes about 2 minutes.

**Or set up manually:**

Create `.env`:

```env
WALLET_PRIVATE_KEY=your_base58_private_key
RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
OPENROUTER_API_KEY=sk-or-...
HELIUS_API_KEY=your_helius_key          # for wallet balance lookups
TELEGRAM_BOT_TOKEN=123456:ABC...        # optional — for notifications + chat
TELEGRAM_CHAT_ID=your_explicit_chat_id  # inbound auto-registration is disabled
DRY_RUN=true                            # compatibility/diagnostic mirror; user-config owns the rollout request
EMERGENCY_STOP=                         # set exactly true only to force a safe dry-run startup
```

> Never put your private key or API keys in `user-config.json` — use `.env` only. Both files are gitignored.

Optional encrypted `.env` flow:

```bash
cp .env .env.raw
printf "replace-with-a-long-local-key\n" > .envrypt
npm run env:encrypt
```

Meridian loads envrypt-style encrypted values automatically. Keep `.env.raw` and `.envrypt` local; both are gitignored.

Copy config and edit as needed:

```bash
cp user-config.example.json user-config.json
```

See [Config reference](#config-reference) below.

### 3. Run

```bash
npm run dev    # compatibility shortcut; still obeys the user-config rollout authority
npm start      # starts the effective configured mode (not automatically live)
```

Use this explicit safe configuration before the first start:

```json
{
  "dryRun": true,
  "rolloutMode": "dry_run"
}
```

`npm run dev` setting `DRY_RUN=true` does not override an already authorized
canary; the environment value is diagnostic only. Conversely, `npm start` does
not authorize live execution by itself. The runtime recomputes its effective
mode from `user-config.json` and raw rollout evidence, then logs either
`Effective mode: DRY RUN` or `Effective mode: LIVE CANARY`. When in doubt, set
`EMERGENCY_STOP=true` before startup; only that exact environment value can
force the rollout back to dry run.

The only live stage currently authorized is a locked canary: exactly `0.20
SOL`, at most one position, using strategy profile `rotation_live_v1`. A normal
canary start requires accepted historical and shadow source evidence. The
explicit `operatorLiveCanaryOverrideConfirmation` supported by
`user-config.json` bypasses source-readiness gates only; it cannot enlarge the
canary or bypass the ledger, cleanup, deploy guard, or circuit breaker. Inspect
the effective decision with `/opsstatus` before funding the wallet.

On startup Meridian fetches your wallet balance and open positions, runs
management first so pending lifecycle cleanup can retry, and then starts
screening.

### Run with persistent user systemd

For a host that must recover after reboot or a user-manager restart, install a
persistent user unit rather than using `systemd-run` (transient units disappear
when the user manager is recreated):

```bash
mkdir -p ~/.config/systemd/user
cp systemd/meridian-shadow.service.example ~/.config/systemd/user/meridian-shadow.service
# Edit WorkingDirectory and ExecStart for this host before enabling the unit.
${EDITOR:-vi} ~/.config/systemd/user/meridian-shadow.service
systemctl --user daemon-reload
systemctl --user enable --now meridian-shadow.service
loginctl enable-linger "$USER"
```

The tracked example deliberately contains placeholder repository and Node
paths. The installed `.service` is host-specific and ignored by Git so local
paths or emergency RPC failovers cannot be published accidentally. It uses
`Restart=always`, loads secrets through Meridian's normal `.env`/encrypted-env
bootstrap, and does not copy wallet secrets into the unit file.

### Run with PM2 (VPS / always-on)

PM2 is the recommended way to keep Telegram control online on a VPS. **Always start via the ecosystem file** so the working directory and script path stay pinned to the repo:

```bash
npm install
npm run pm2:start    # uses ecosystem.config.cjs — do NOT use "pm2 start index.js"
pm2 save
```

After `.env`, `user-config.json`, or code changes:

```bash
npm run pm2:restart  # re-reads .env on each restart
npm run pm2:logs
```

To update an existing PM2 install:

```bash
git pull
npm install
npm run pm2:restart
pm2 save
```

If a previous PM2 run was started incorrectly, reset it once:

```bash
pm2 delete meridian
npm run pm2:start
pm2 save
```

**PM2 vs `npm start`**

| | `npm start` | PM2 |
|---|---|---|
| Terminal | Interactive REPL | Headless daemon |
| Cron / Telegram | Starts after REPL banner | Starts immediately on boot |
| First screening | On cron schedule | May run one cycle right at startup |
| Best for | Local dev / testing | VPS / 24-7 operation |

On startup, logs show `Repo: ... | cwd: ... | PM2 id: ...`. **Repo and cwd must match.** If they differ, delete the process and use `npm run pm2:start` again.

**Common PM2 issues**

| Symptom | Likely cause | Fix |
|---|---|---|
| Crash loop after `git pull` | `npm install` skipped | `npm install && npm run pm2:restart` |
| Missing wallet / API keys | Started with `pm2 start index.js` from wrong directory | `pm2 delete meridian && npm run pm2:start` |
| `.env` changes ignored | Old PM2 env snapshot | `npm run pm2:restart` (`.env` now overrides stale PM2 env) |
| Telegram `401 Unauthorized` | Invalid `TELEGRAM_BOT_TOKEN` (not chat ID) | Fix token in `.env`; if encrypted, ensure `.envrypt` exists |
| Telegram commands ignored | Missing/wrong `TELEGRAM_CHAT_ID` | Set in `.env` (or `telegramChatId` in `user-config.json`) |
| Duplicate polling / 409 errors | `nohup node index.js` or second PM2 instance running | Kill stray processes; run only one PM2 app |
| Encrypted env crash at boot | `# encrypted` lines without `.envrypt` key | Add `.envrypt` or use plain `.env` values |

Avoid `nohup node index.js` — it runs outside PM2 and can leave a duplicate Telegram poller fighting the managed process.

---

## Running modes

### Autonomous agent

```bash
npm start
```

Starts the full autonomous agent with cron-based screening + management cycles and an interactive REPL. The prompt shows a live countdown to the next cycle:

```
[manage: 8m 12s | screen: 24m 3s]
>
```

REPL commands:

| Command | Description |
|---|---|
| `/status` | Wallet balance and open positions |
| `/candidates` | Re-screen and display top pool candidates |
| `/learn` | Study top LPers across all current candidate pools |
| `/learn <pool_address>` | Study top LPers for a specific pool |
| `/thresholds` | Current screening thresholds and performance stats |
| `/evolve` | Trigger threshold evolution from performance data (needs 5+ closed positions) |
| `/stop` | Graceful shutdown |
| `<anything>` | Free-form chat — ask the agent anything, request actions, analyze pools |

---

### Claude Code terminal (recommended)

Install [Claude Code](https://claude.ai/code) and use it from inside the meridian directory. Claude Code has built-in agents and slash commands that use the `meridian` CLI under the hood.

```bash
cd meridian
claude
```

#### Slash commands

| Command | What it does |
|---|---|
| `/screen` | Full AI screening cycle — checks Discord queue, reads config, fetches candidates, runs deep research, and deploys if a winner is found |
| `/manage` | Full AI management cycle — checks all positions, evaluates PnL, claims fees, closes OOR/losing positions |
| `/balance` | Check wallet SOL and token balances |
| `/positions` | List all open DLMM positions with range status |
| `/candidates` | Fetch and enrich top pool candidates (pool metrics + token audit + smart money) |
| `/study-pool` | Study top LPers on a specific pool |
| `/pool-ohlcv` | Fetch price/volume history for a pool |
| `/pool-compare` | Compare all Meteora DLMM pools for a token pair by APR, fee/TVL ratio, and volume |

#### Claude Code agents

Two specialized sub-agents run inside Claude Code:

**`screener`** — pool screening specialist. Invoke when you want to evaluate candidates, analyse token risk, or deploy a position. Has access to Jupiter token audit, smart-wallet checks, and all strategy logic.

**`manager`** — position management specialist. Invoke when reviewing open positions, assessing PnL, claiming fees, or closing positions.

To trigger an agent directly, just describe what you want:
```
> screen for new pools and deploy if you find something good
> review all my positions and close anything out of range
> what do you think of the SOL/BONK pool?
```

#### Loop mode

Run screening or management on a timer inside Claude Code:

```
/loop 30m /screen     # screen every 30 minutes
/loop 10m /manage     # manage every 10 minutes
```

---

### CLI (direct tool invocation)

The `meridian` CLI gives you direct access to every tool with JSON output — useful for scripting, debugging, or piping into other tools.

```bash
npm install -g .   # install globally (once)
meridian <command> [flags]
```

Or run without installing:

```bash
node cli.js <command> [flags]
```

**Positions & PnL**

```bash
meridian positions
meridian pnl <position_address>
meridian wallet-positions --wallet <addr>
```

**Screening**

```bash
meridian candidates --limit 5
meridian pool-detail --pool <addr> [--timeframe 5m]
meridian active-bin --pool <addr>
meridian search-pools --query <name_or_symbol>
meridian study --pool <addr> [--limit 4]
```

**Token research**

```bash
meridian token-info --query <mint_or_symbol>
meridian token-holders --mint <addr> [--limit 20]
meridian token-narrative --mint <addr>
```

**Deploy & manage**

```bash
meridian deploy --pool <addr> --amount <sol> [--bins-below 69] [--bins-above 0] [--strategy bid_ask|spot|curve] [--dry-run]
meridian claim --position <addr>
meridian close --position <addr> [--skip-swap] [--dry-run]
meridian swap --from <SOL|USDC|USDT|base58_mint> --to <SOL|USDC|USDT|base58_mint> --amount <token_unit_decimal> [--dry-run]
meridian add-liquidity --position <addr> --pool <addr> [--amount-x <n>] [--amount-y <n>] [--strategy spot]
meridian withdraw-liquidity --position <addr> --pool <addr> [--bps 10000]
```

For `swap`, `--amount` is always positive token-unit decimal text (including
legacy forms such as `.5`, `1e-3`, `01`, and `1.`). Meridian validates and
converts it internally without floating-point arithmetic using the source
mint's authoritative decimals. Destinations may use an alias or exact base58
mint. `close --skip-swap` remains accepted as a legacy no-op; close and claim
never perform a wallet-wide follow-up swap. A post-close lifecycle cleanup may
still convert residue to SOL, but only from position-attributed token accounts.

**Agent cycles**

```bash
meridian screen [--dry-run] [--silent]   # one AI screening cycle
meridian manage [--dry-run] [--silent]   # one AI management cycle
meridian start [--dry-run]               # start autonomous agent with cron jobs
```

**Config**

```bash
meridian config get
meridian config set <key> <value>
```

**Learning & memory**

```bash
meridian lessons
meridian lessons add "your lesson text"
meridian performance [--limit 200]
meridian evolve
meridian pool-memory --pool <addr>
```

**Blacklist**

```bash
meridian blacklist list
meridian blacklist add --mint <addr> --reason "reason"
```

**Discord signals**

```bash
meridian discord-signals
meridian discord-signals clear
```

**Balance**

```bash
meridian balance
```

**Flags**

| Flag | Effect |
|---|---|
| `--dry-run` | Compatibility request only; for a guaranteed safe autonomous run, set `dryRun=true`, `rolloutMode=dry_run`, or boot with `EMERGENCY_STOP=true` |
| `--silent` | Suppress Telegram notifications for this run |

---

## Live safety, lifecycle, and settlement

Every submitted live operation is isolated by a durable operation lease and
position-bound receipt evidence. A normal lifecycle progresses as follows:

```text
PENDING_DEPLOY → BASIS_PENDING → ACTIVE → CLOSING → CLEANUP_PENDING → SETTLED
                         ↘ RECONCILIATION_REQUIRED ↗
```

- `ACTIVE` requires decoded deploy receipts and an authoritative cost basis.
- A confirmed close enters `CLEANUP_PENDING`; close success alone is not final
  PnL.
- Automatic cleanup may swap or close only token accounts attributed to that
  lifecycle. It never sweeps unrelated wallet balances.
- Pending cleanup is retried automatically during management. It is visible in
  `/opsstatus` and is not, by itself, a blanket ban on screening or another
  otherwise-safe deploy.
- `SETTLED` requires zero economic residue and reconciled wallet/component
  equity within the configured lamport tolerance. Settlement PnL, rather than
  the pre-close API estimate, is the authoritative result.

The global live-canary deploy guard serializes the RPC position check and the
entire deploy outcome, preventing two concurrent requests from both observing
an empty slot. A retained or uncertain guard fails closed and is inspectable
with `/canaryguard`.

The circuit breaker is durable across restarts. With
`circuitAutomaticResume=true`, recoverable economic and operational latches
(`PROFIT_EXIT_BELOW_GLOBAL_FLOOR`, loss limits, canary drawdown, and consecutive
operational failures) start a fresh risk epoch automatically after the
configured cooldown. Recovery requires a fresh authoritative proof of RPC
positions `0`, tracked positions `0`, all lifecycles `SETTLED`, no pending
cleanup, and a free global deploy guard. Invalid cost basis, malformed data,
reconciliation mismatches, lifecycle anomalies, retained operation guards, and
breaker durability uncertainty remain fail-closed because the transaction
outcome is not yet known; they are never converted into permissive state.

Runtime records:

| Record | Purpose |
|---|---|
| `trade-ledger.jsonl` | Append-only lifecycle receipts, valuations, transitions, and settlement economics |
| `.meridian-lifecycle-operations/` | Per-operation journals and leases for deploy, close, claim, and cleanup |
| `~/.meridian-breaker-runtime/circuit-breaker.json` | Private durable breaker latch and resume audit state |
| `state.json` | Runtime position registry and paper/shadow observations |

Do not hand-edit these files while the service is running. Use `/opsstatus`,
`/cleanup`, `/breaker`, and `/canaryguard` for inspection and bounded recovery.

---

## Discord listener

The Discord listener watches configured channels (e.g. LP Army) for Solana token calls and queues them as signals for the screener agent.

### Setup

```bash
cd discord-listener
npm install
```

Add to your root `.env`:

```env
DISCORD_USER_TOKEN=your_discord_account_token   # from browser DevTools → Network
DISCORD_GUILD_ID=the_server_id
DISCORD_CHANNEL_IDS=channel1,channel2            # comma-separated
DISCORD_MIN_FEES_SOL=5                           # minimum pool fees to pass pre-check
```

> This uses a selfbot (personal account automation, not a bot token). Use responsibly.

### Run

```bash
cd discord-listener
npm start
```

Or run it in a separate terminal alongside the main agent. Signals are written to `discord-signals.json` and picked up automatically by `/screen` and `node cli.js screen`.

### Signal pipeline

Each incoming token address passes through a pre-check pipeline before being queued:
1. **Dedup** — ignores addresses seen in the last 10 minutes
2. **Blacklist** — rejects blacklisted token mints
3. **Pool resolution** — resolves the address to a Meteora DLMM pool
4. **Rug check** — checks deployer against `deployer-blacklist.json`
5. **Fees check** — rejects pools below `DISCORD_MIN_FEES_SOL`

Signals that pass all checks are queued with status `pending`. The screener picks up pending signals and processes them as priority candidates before running the normal screening cycle.

### Deployer blacklist

Add known rug/farm deployer wallet addresses to `deployer-blacklist.json`:

```json
{
  "_note": "Known farm/rug deployers — add addresses to auto-reject their pools",
  "addresses": [
    "WaLLeTaDDressHere"
  ]
}
```

---

## Telegram

### Setup

1. Create a bot via [@BotFather](https://t.me/BotFather) and copy the token
2. Add to `.env`:

```env
TELEGRAM_BOT_TOKEN=<token>
TELEGRAM_CHAT_ID=<your chat id>          # .env alone is enough; also saved to user-config by setup
TELEGRAM_ALLOWED_USER_IDS=<user id>    # required for group/supergroup control
```

Meridian does **not** auto-register the first chat for safety — you must set `TELEGRAM_CHAT_ID` explicitly. For groups, also set `TELEGRAM_ALLOWED_USER_IDS` or inbound commands are ignored.

`401 Unauthorized` in logs means a bad `TELEGRAM_BOT_TOKEN` (invalid, revoked, or encrypted without a working `.envrypt` key) — not a chat ID problem.

### Notifications

Meridian sends notifications automatically for:
- Management cycle reports (reasoning + decisions)
- Screening cycle reports (what it found, whether it deployed)
- OOR alerts when a position leaves range past `outOfRangeWaitMinutes`
- Deploy: pair, amount, position address, tx hash
- Close: pair and PnL

### Telegram commands

| Command | Action |
|---|---|
| `/status` | Wallet, positions, effective rollout, breaker, and ledger summary |
| `/opsstatus` | Rollout evidence, breaker, lifecycle counts, cleanup, and deploy-guard state without the wallet view |
| `/positions`, `/pool <n>` | List positions or inspect one open position |
| `/close <n>`, `/closeall` | Close one or all positions through the lifecycle-safe executor |
| `/closecooldown <n>` | Close one position and cooldown its pool/token |
| `/cleanup <position>` | Preview position-scoped economic cleanup without submitting a transaction |
| `/cleanup execute <position> …` | Execute scoped cleanup; the bot returns the exact confirmation phrase required |
| `/breaker` | Inspect the durable circuit-breaker latch and resume audit fields |
| `/resumebreaker` | Open a trip-bound confirmation button that safely resumes the current breaker latch |
| `/breaker resume …` | Manually resume an intact latch; does not itself submit a trade |
| `/breaker repair …` | Repair uncertain breaker durability into a safe, still-latched state |
| `/canaryguard` | Inspect the global live-canary deploy guard |
| `/canaryguard reconcile <operation_id> …` | Reconcile and release a retained guard after fresh authoritative evidence |
| `/screen`, `/candidates`, `/deploy <n>` | Refresh candidates, inspect the cache, or request a deterministic candidate deploy |
| `/pause`, `/resume` | Stop or restart cron cycles without changing the durable breaker |
| `/set <n> <note>` | Set a note or instruction on a position |

Mutation and recovery commands deliberately require explicit confirmation.
For the breaker, `/resumebreaker` provides a one-tap confirmation button bound
to the current trip, while the longer exact-text command remains available.
`/resume` restarts cron scheduling, whereas breaker resume changes entry
eligibility—these are intentionally separate controls.

You can also chat freely via Telegram using the same interface as the REPL.
Inbound polling continues while an earlier command is queued or waiting on an
RPC/model provider, and financial commands are dispatched serially. Only
allowed user IDs can issue commands in groups.

---

## Config reference

Edit `user-config.json`; `user-config.example.json` is an opinionated sample,
not a list of immutable defaults. The **base fallback** below is used when a
field is absent and the rotation overlay is inactive. The effective live
canary always uses the bounded rotation profile. The rotation columns show its
defaults; most profile parameters are clamped to safe code-defined ranges,
while `0.20 SOL` and one position are immutable. `/config` and `/opsstatus`
show the effective runtime view.

### Screening

| Field | Base fallback | Rotation default | Description |
|---|---:|---:|---|
| `minFeeActiveTvlRatio` | `0.05` | `1.0` | 30m fee/active-TVL floor; modeled cost coverage may raise admission further |
| `minTvl` / `minActiveTvl` | `10000` | `400` | Minimum pool and active TVL (USD) |
| `maxTvl` | `150000` | `300000` | Maximum active TVL (USD) |
| `minVolume` | `500` | `250` | Minimum timeframe volume (USD) |
| `maxVolatility` | none | `< 7.5` | Exclusive volatility ceiling |
| `minOrganic` | `60` | `70` | Minimum organic score (0–100) |
| `minHolders` | `500` | `500` | Minimum token holder count |
| `minMcap` | `150000` | `50000` | Minimum market cap (USD) |
| `maxMcap` | `10000000` | `50000000` | Maximum market cap (USD) |
| `minTokenFeesSol` | `30` | `80` | Minimum global fees paid in SOL |
| `maxBotHoldersPct` | `30` | `25` | Maximum bot-holder percentage |
| `maxTop10Pct` | `60` | `30` | Maximum top-10 holder concentration |
| Candidate confirmation | `2`, at least `2m` apart | `3`, at least `30s` apart | Fee/volume retention and, in rotation, price/bin stability |
| Token age | unbounded | `1h–72h` | Minimum and maximum token age |
| `minBinStep` / `maxBinStep` | `80` / `125` | same | Allowed DLMM bin step |
| `blockedLaunchpads` | `[]` | same | Launchpad names to reject |
| `extraSearchSymbols` | `[]` | same | Extra symbols merged into discovery |
| `extraSearchOnlySolPools` | `true` | same | Restrict extra discovery to SOL pairs |
| `avoidPvpSymbols` / `blockPvpSymbols` | `true` / `false` | configured | Detect same-symbol rival mints; when blocking is enabled, keep only the deterministic highest-scoring eligible pool per symbol |

### Management

| Field | Base fallback | Rotation default | Description |
|---|---:|---:|---|
| `deployAmountSol` | `0.5` | `0.20` | SOL requested per new position |
| `maxPositions` | `3` | `1` | Maximum simultaneous positions |
| `strategy` | `bid_ask` | `spot` | DLMM liquidity strategy |
| Range | minimum `35` bins below | `5 below + 0 above` | Locked rotation uses single-side SOL funding |
| `outOfRangeWaitMinutes` | `30` | `5` above-range exit | Time before an OOR exit is eligible |
| `stopLossPct` | `-50` | `-1` | Projected equity-net stop loss |
| `catastrophicStopPct` | `-2.5` | `-1.5` | Immediate catastrophic boundary |
| `takeProfitPct` | `5` | `0.5` | Projected equity-net take profit |
| `takeProfitExecutionBufferPct` | `0` | `0.75` | Additive projected-close reserve; rotation TP gate is therefore `1.25%` |
| `estimatedRoundTripCostPct` | `1.0` | `0.4` | Cost assumption used by admission/exit modeling |
| `minNetProfitPct` | `0.25` | `0.10` | Minimum modeled net-profit percentage |
| `minNetProfitSol` | `0.0005` | `0.00005` | Minimum modeled net-profit SOL |
| `maxHoldMinutes` | `360` | `90` | Maximum bounded hold time |

The base yield-hold entry policy requires 5m RSI at least `40` and 15m RSI at least `35`; the rotation defaults are `35` and `40`, respectively. Both reject overextended RSI (`75`/`80`). Fee admission uses the same conservative assumptions as paper valuation: 50% fee haircut, 25% participation, modeled round-trip cost, and at most a six-hour coverage horizon. A shadow stop-loss blocks the pool and base token for the remainder of that evidence epoch.

The locked rotation profile is a micro/trending-pool rollout shared by shadow and the only authorized live canary. It uses one sequential `0.20 SOL` position, a live-compatible single-side SOL `5 below + 0 above` spot range, 5m/15m trend continuation, three stability observations at least 30 seconds apart, and a position-notional cap of 2% of active TVL. Rotation candidates default to a 72-hour maximum token age, 1.0% minimum 30m fee/active-TVL, volatility below 7.5, 15m RSI of at least 40, and 5m RSI below 75. Stability includes fee, volume, and price: a peak-to-current drawdown of 1.5% or a consecutive downside move of two DLMM bins resets confirmation. When a qualified token has same-symbol rival mints, deterministic score ranking retains one canonical eligible pool rather than dropping the whole symbol. Open paper positions are observed by a read-only 15-second monitor; a catastrophic stop quarantines the pool and mint for seven days, while the run-level cooldown prevents repeat use in the same evidence epoch. Discovery still enforces mint/freeze authority, concentration, SOL-quote, blocklist, and bounded bot-holder audits. Evidence is labeled `rotation_live_v1` and every lifecycle must use exactly `0.20 SOL`; older `rotation_v1` balanced-proxy evidence cannot authorize this canary. Normally, live remains fail-closed until the historical, 24-hour heartbeat, five-settled-lifecycle, strictly positive net, profit factor of at least `1.2`, maximum single loss of at most `2.5%`, drawdown, reconciliation, cleanup, breaker, and exact-exposure gates all pass. An exact operator override can bypass source-readiness gates, but all transaction, exposure, lifecycle, cleanup, guard, and breaker boundaries remain enforced.

### Ledger, cleanup, and circuit breaker

| Field | Default | Description |
|---|---:|---|
| `ledgerEnabled` | `true` | Enable authoritative lifecycle accounting |
| `ledgerPath` | `trade-ledger.jsonl` | Append-only ledger path, relative to the repository unless absolute |
| `ledgerReconcileToleranceLamports` | `10000` | Maximum absolute settlement reconciliation error |
| `cleanupEnabled` | `true` | Enable position-scoped post-close cleanup and retry |
| `cleanupMaxPriceImpactPct` | `5` | Maximum cleanup swap price impact |
| `circuitBreakerEnabled` | `true` | Enable durable live-entry breaker |
| `circuitAutomaticResume` | `true` | Automatically recover economic/operational latches after clean zero-exposure proof |
| `circuitAutomaticResumeCooldownSeconds` | `60` | Minimum clean-state delay before a recoverable latch starts a fresh risk epoch |
| `circuitConsecutiveLosses` | `2` | Consecutive settled net losses before latching |
| `circuitSingleLossPct` | `-2` | Exclusive single-trade loss boundary |
| `circuitDailyLossMinSol` | `0.003` | Minimum rolling 24h loss limit |
| `circuitDailyLossPct` | `1.5` | Rolling loss limit as a percentage of equity |
| `circuitCanaryDrawdownPct` | `3` | Canary peak-to-current drawdown latch |

### Schedule

| Field | Base fallback | Rotation behavior | Description |
|---|---:|---:|---|
| `managementIntervalMin` | `10` | configured value | Management cycle frequency (minutes) |
| `screeningIntervalMin` | `30` | `1` | Screening cycle frequency (minutes) |
| `pnlPollIntervalSec` | `30` | configured value | Deterministic position observation frequency |
| `opportunityPollIntervalSec` | `45` | configured value | Lightweight trending-opportunity trigger frequency |

### Models

| Field | Default | Description |
|---|---|---|
| `managementModel` | `openrouter/healer-alpha` | LLM for management cycles |
| `screeningModel` | `openrouter/hunter-alpha` | LLM for screening veto/reports |
| `generalModel` | `openrouter/healer-alpha` | LLM for REPL / chat |

> Override model at runtime: `node cli.js config set screeningModel anthropic/claude-opus-4-5`

### Jupiter swap fee (referral)

Every direct token swap goes through **Jupiter Ultra**. Closing or claiming a position never triggers a wallet-wide follow-up swap. Jupiter's referral program lets a referral wallet collect a small fee, expressed in **basis points (bps)** — `1 bps = 0.01%`, so `50 bps = 0.5%`. Meridian ships with this enabled by default.

**Settings** (env only — *not* in `user-config.json`):

| Env var | Default | Description |
|---|---|---|
| `JUPITER_REFERRAL_ACCOUNT` | built-in account | A **Jupiter referral account** (not just any wallet). Create one on the Jupiter referral dashboard (`referral.jup.ag`) — it generates a referral account and the per-token fee accounts that actually collect the fee. Paste that referral account address here to collect the fee yourself. |
| `JUPITER_REFERRAL_FEE_BPS` | `50` | Fee in basis points. **Jupiter Ultra requires 50–255 bps** — values outside that range (or `0`) are ignored and the swap runs with no referral fee. |

```bash
# .env — collect the referral fee on your own Jupiter referral account
JUPITER_REFERRAL_ACCOUNT=<your-jupiter-referral-account>
JUPITER_REFERRAL_FEE_BPS=50
```

**To turn the referral off**, just remove/blank it — set `JUPITER_REFERRAL_ACCOUNT=` (empty) **or** `JUPITER_REFERRAL_FEE_BPS=0`. Either one drops the referral and the swap proceeds at Jupiter's normal rate. The referral is also silently dropped if the fee is below `50`, above `255`, or the account isn't a valid Solana address (`tools/wallet.js#getJupiterReferralParams`). **`50` is the minimum Jupiter allows and the Meridian default.**

> If you leave the referral enabled on the **built-in default account**, the fee goes toward **Meridian server maintenance** (HiveMind, Agent Meridian API, hosting). Override `JUPITER_REFERRAL_ACCOUNT` with your own Jupiter referral account to collect it yourself instead, or disable it entirely as above. Either way, on new tokens (<24h) it's the same 0.5% Jupiter charges regardless — so leaving the default on costs you nothing extra there.

> **Why 50 bps is effectively free on new tokens.** Jupiter's own platform fee already varies by pair — and for **new tokens (within 24h of token age) Jupiter charges 50 bps (0.5%)** on its UI regardless. So on those tokens the swap costs the same 0.5% **whether or not you attach a referral** — adding the referral just redirects that fee to your wallet instead of leaving it at Jupiter's default. (Jupiter's full platform-fee schedule: `0` bps buying Jupiter tokens / pegged LST-LST & stable-stable, `2` SOL-stable, `5` LST-stable, `10` everything else, `50` new tokens <24h.)

---

## How it learns

### Lessons

The repository retains manual lessons, performance-history, and top-LPer study
tools. During the locked dry-run/canary rollout, `learningFrozen=true`:
automatic close-performance writes, generated lessons, prompt injection,
HiveMind sharing, and threshold evolution are disabled so the evidence source
cannot mutate the policy being evaluated. Explicit operator lesson maintenance
remains available for later use.

Add a lesson manually:
```bash
node cli.js lessons add "Never deploy into pump.fun tokens under 2h old"
```

### Threshold evolution

Outside a frozen rollout, after 5+ compatible performance records, run:
```bash
node cli.js evolve
```

This analyzes performance history and adjusts screening thresholds in
`user-config.json`. In the current locked baseline it returns
`ROLLOUT_BASELINE_LEARNING_FROZEN` and performs no mutation.

---

## HiveMind

HiveMind integrations remain in the repository, but the current locked
shadow/canary baseline forces `hiveMindEnabled=false`. Startup therefore logs
`Disabled by the locked rollout baseline`; configured endpoints or API keys do
not reactivate it in this stage.

If a later adaptive rollout explicitly enables HiveMind, it uses Agent
Meridian at `https://api.agentmeridian.xyz` by default with the built-in public
key. Agents can then register, pull shared lessons/presets, and push learning
events without a separate registration flow.

**When enabled, what you get:**
- Shared lessons from other Meridian agents
- Strategy presets and crowd performance context
- Role-aware lessons injected into future screener/manager prompts when `hiveMindPullMode` is `auto`

**When enabled, what you share:**
- Lessons from `lessons.json`
- Closed-position performance events: pool, pool name, base mint, strategy, close reason, PnL, fees, and hold time
- Agent heartbeat metadata: agent ID, version, timestamp, and basic capability flags
- **Private keys and wallet balances are never sent**

HiveMind failures are non-blocking. If Agent Meridian is unavailable, the agent logs a warning and keeps running.

### Setup

No manual HiveMind registration command is required for the shared Agent
Meridian setup. In an enabled stage, `agentId` is generated automatically on
startup if it is missing.

To use a private HiveMind API key, check the Telegram announcement channel and set it as `hiveMindApiKey`.

Relevant config fields:

```json
{
  "agentId": "",
  "hiveMindUrl": "",
  "hiveMindApiKey": "",
  "hiveMindPullMode": "auto"
}
```

Blank `hiveMindUrl` and `hiveMindApiKey` values retain the Agent Meridian
fallbacks for a future enabled stage. They do not override the current locked
off switch.

### Disable

Do not rely on clearing URL/key fields to disable HiveMind; the current off
state comes from the immutable rollout baseline. A future stage should expose
an explicit, separately reviewed enable/disable transition.

---

## Using a local model (LM Studio)

```env
LLM_BASE_URL=http://localhost:1234/v1
LLM_API_KEY=lm-studio
LLM_MODEL=your-local-model-name
```

Any OpenAI-compatible endpoint works.

---

## Architecture

```
index.js            Main entry: REPL + cron orchestration + Telegram bot polling
agent.js            ReAct loop: LLM → tool call → repeat
config.js           Runtime config from user-config.json + .env (repo-root paths)
repo-root.js        Stable absolute repo path — used by PM2, state files, and .env loading
prompt.js           System prompt builder (SCREENER / MANAGER / GENERAL roles)
state.js            Position registry (state.json)
trade-ledger.js     Append-only lifecycle event model and settlement accounting
ledger-runtime.js   Receipt decoding, lifecycle transitions, operation leases, reconciliation
cleanup-runtime.js  Position-scoped residual scan, cleanup execution, and settlement finalization
circuit-breaker.js  Pure risk-breaker reducer and automatic-resume audit state
breaker-runtime.js  Private durable breaker storage and serialized controller
automatic-breaker-resume.js  Zero-exposure automatic recovery policy for economic/operational latches
durable-file.js     Descriptor-safe atomic files, locks, and durability markers
shadow-lifecycle.js Conservative paper lifecycle observation and settlement
rollout-evidence.js Append-only shadow heartbeat evidence and validation
decision-log.js     Structured decision log for deploy, close, skip, and no-deploy rationale
lessons.js          Learning engine: records performance, derives lessons, evolves thresholds
pool-memory.js      Per-pool deploy history + snapshots
strategy-library.js Saved LP strategies
telegram.js         Telegram bot: polling + notifications
hivemind.js         Agent Meridian HiveMind sync
smart-wallets.js    KOL/alpha wallet tracker
token-blacklist.js  Permanent token blacklist
cli.js              Direct CLI — every tool as a subcommand with JSON output

tools/
  definitions.js    Tool schemas (OpenAI format)
  executor.js       Tool dispatch + safety checks
  rollout-safety.js Effective dry-run/canary authorization and immutable canary limits
  token-cleanup.js  Scoped token-account cleanup planning and execution primitives
  dlmm.js           Meteora DLMM SDK wrapper
  screening.js      Pool discovery
  wallet.js         SOL/token balances + Jupiter swap
  token.js          Token info, holders, narrative
  study.js          Top LPer study via LPAgent API

discord-listener/
  index.js          Selfbot Discord listener
  pre-checks.js     Signal pre-check pipeline

.claude/
  agents/
    screener.md     Claude Code screener sub-agent
    manager.md      Claude Code manager sub-agent
  commands/
    screen.md       /screen slash command
    manage.md       /manage slash command
    balance.md      /balance slash command
    positions.md    /positions slash command
    candidates.md   /candidates slash command
    study-pool.md   /study-pool slash command
    pool-ohlcv.md   /pool-ohlcv slash command
    pool-compare.md /pool-compare slash command
```

---

## Disclaimer

This software is provided as-is, with no warranty. Running an autonomous trading agent carries real financial risk — you can lose funds. Always start with `dryRun=true` and `rolloutMode="dry_run"` in `user-config.json`, verify the startup log says `Effective mode: DRY RUN`, and use `EMERGENCY_STOP=true` when a one-way safe startup latch is required. Never deploy more capital than you can afford to lose. This is not financial advice.

The authors are not responsible for any losses incurred through use of this software.
