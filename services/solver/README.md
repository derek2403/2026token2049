# SODA Intents solver bot

A solver for the `intents` program (HANDOVER §3.6). It watches open intents, prices them on a constant-product curve anchored to Pyth, and fills the ones that clear its price. It then delivers every pending Base payout itself through `BASE_RPC_URL`, and bumps gas on payouts that get stuck.

## What it does

| Step | How |
|---|---|
| Watch | `ProgramWatcher` (`watcher.ts`) polls `getSignaturesForAddress(intents program)` every `WATCH_MS` over `SOLANA_RPC_URL`, fetches each new successful transaction with `getTransaction` (oldest first) and decodes its events (`IntentOpened`, `IntentFilled`, `IntentCancelled`, `GasBumped`, `EthTxRequested`, `SolverWithdrew`). These events keep an in-memory index of open intents, filled intents awaiting delivery (with every gas price they were signed at) and withdrawal nonces. On start it replays the newest `BACKFILL_SIGS` signatures, then checks every indexed key with `getMultipleAccountsInfo`, which drops closed accounts and corrects statuses. A new `IntentOpened` triggers a fill attempt at once. Every `POLL_MS` the open intents are re-read by key. No event is dropped quietly: polls pass `minContextSlot` and cut off anything older than the cursor's slot; an empty page right after a full one is retried; a transaction the node cannot return yet holds the queue briefly (no backoff), then is retried in the background for 30 min; every `REWALK_MS` the newest 500 signatures are re-listed and any never seen are replayed. If a pool nonce between the mined nonce and `next_nonce` belongs to no indexed payout (after a restart, the stuck head's fill can be older than the backfill), the watcher pages further back through history until it finds that fill, up to `MAX_OLDER_SIGS`, and logs a WARNING if it cannot. Every method it uses is on Alchemy's free tier: no `getProgramAccounts` and no WebSocket. If `SOLANA_WS_URL` is set, `logsSubscribe` runs as well, as a faster path; events seen on both are handled once. |
| Price | Every `ANCHOR_MS` (60 s), it reads Pyth devnet `PriceUpdateV2` for SOL/USD and ETH/USD, its ledger balance and the Base gas price. It then sets virtual reserves `ETH = ledger × VIRTUAL_DEPTH` and `SOL = the same value at the oracle price`. A quote for `x` lamports works like this: <br>• subtract the SigRequest rent and fees from `x`, which gives `x'`<br>• take the curve output `y·x'/(X+x')`<br>• take `SPREAD_BPS` off that<br>• subtract `gas_price·21000 + l1_fee_buffer_wei`<br>Each fill moves the curve until the next re-anchor. |
| Fill | Every `TICK_MS` it reads the Clock sysvar, Config and its Solver account in a single call. For each open intent, `required = required_out(clock − 5 s)`. The bot fills only when `maxOut ≥ required` and the ledger covers the cost. It sends `fill(next_nonce, required, gas)` with a 300k CU limit, and the `sig_request` PDA comes from the payout RLP it rebuilds off-chain. On `NonceMoved` it re-reads Config and retries. `IntentNotOpen` means another solver won the race, so it moves on. If the recipient has code (`eth_getCode` ≠ `0x`), the intent is skipped. |
| Deliver | Every `DELIVER_MS` it reads the watcher's filled intents by key (`getMultipleAccountsInfo`, 100 per call) and compares each to the pool's mined Base nonce. For a payout still pending, it rebuilds every candidate (`lib/intents` `buildCandidates`, with older gas prices recovered from the intent's logs) and rebroadcasts the signed ones through `PayoutTracker`. Bumps happen only at the head of the pool's nonce queue:<br>• **Its own fills:** after 30 s unmined.<br>• **Any solver's fill:** after 60 s unmined, and once `filled_at + 60` has passed.<br>• **Expired signature request:** the committee will never sign it, so it is replaced.<br>The new gas price is `max(old × (1.1 + BUMP_EXTRA_BPS), market)`, capped at `max_gas_price`. |
| Quote | `GET /quote?inLamports=N` returns `{ solver, outWei, minOutWei, validUntil }`; amounts are decimal strings and `validUntil` is in unix seconds. `outWei` is what the bot would fill at right now. `minOutWei` is the same quote with Base gas doubled (capped at `max_gas_price`), a floor the bot still fills at if gas spikes. If it cannot quote (no prices, no inventory or paused), it returns 503 `{ error }`. `GET /health` reports state. |

## Run

From the repo root (the bot imports `lib/` and `idl/`):

```bash
npx tsx services/solver/src/index.ts      # or: npm run solver
npm run test:solver                       # offline tests
```

It reads `/.env` at the repo root if present; `NO_DOTENV=1` skips that. On first start it registers its `Solver` account if it is missing and `BOT_ID` is set, using BOT_ID's address as both `payout_addr` and `deposit_from` (BOT_ID signs the `deposit_from` proof).

Funding a solver:

```bash
npm run cli -- deposit --eth 0.05            # dry run: prints from/to/value/nonce/gas
npm run cli -- deposit --eth 0.05 --yes      # broadcast from the BOT_ID wallet to the pool
npm run cli -- credit-solver --solver <solver pubkey> --tx <deposit hash>   # admin; writes the Credit marker
```

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `SOLANA_RPC_URL` | `https://api.devnet.solana.com` | Keyed devnet HTTP RPC (Helius/Alchemy). It carries everything: discovery (`getSignaturesForAddress`, `getTransaction`, `getMultipleAccountsInfo`), reads and transactions. The public endpoint rate-limits. |
| `SOLANA_WS_URL` | off | Optional `logsSubscribe` WebSocket for faster discovery. Leave it unset, empty or `off` to rely on polling alone. Alchemy's WebSocket has no `logsSubscribe`, and keyless public ones answer 429 on shared IPs such as Railway's. |
| `WATCH_MS` | `1500` | How often the watcher polls the program's signatures. |
| `BACKFILL_SIGS` | `1000` | Program signatures replayed on start to rebuild the index. A pending payout whose fill is older than this is found later by paging back for its pool nonce (`MAX_OLDER_SIGS`). |
| `WATCHER_TX_PER_SEC` | `10` | Pace of the watcher's `getTransaction` calls (backfill included), to stay under free-tier per-second limits. `0` means unpaced. The watcher uses its own connection with web3.js 429 retries off, so a rate limit reaches its backoff. |
| `REWALK_MS` | `180000` | How often the newest 500 signatures are re-listed to catch any a poll missed. `0` turns it off. |
| `MAX_OLDER_SIGS` | `20000` | Cap on signatures replayed beyond the backfill while looking for an unindexed in-flight pool nonce. |
| `SOLVER_KEYPAIR_JSON` | | Solver authority keypair as a JSON array (Railway). |
| `SOL_KEY` | | Alternative: the solver authority as a base58 secret key. |
| `SOLVER_KEYPAIR_PATH` | | Alternative to the above: a path to a keypair file. |
| `INTENTS_PROGRAM_ID` | `BV9Kfz…8jXA` | The intents program. |
| `BASE_RPC_URL` | `https://sepolia.base.org` | Base Sepolia RPC for gas price, recipient checks, delivery and receipts. A keyed provider URL is recommended. |
| `BASE_RPC_TIMEOUT_MS` | `5000` | Timeout per Base RPC call. |
| `BOT_ID` | | The operator's Base wallet private key (0x hex). It is used only to derive `payout_addr`/`deposit_from` and for the CLI's `deposit`, and is never logged. |
| `SPREAD_BPS` | `30` | Spread under the oracle price. Run two bots with 30 and 60 to show a race. |
| `PORT` | `8080` | Quote server. |
| `PRICE_MAX_AGE_SEC` | `3600` | Maximum Pyth `publish_time` age. Devnet updates slowly. |
| `SOL_USD_FALLBACK`, `ETH_USD_FALLBACK` | | USD prices such as `150.25`, used when Pyth is missing or stale. |
| `VIRTUAL_DEPTH` | `10` | Virtual reserves as a multiple of ledger inventory. Higher means less slippage. |
| `GAS_MARGIN_BPS` | `2500` | Margin over `eth_gasPrice` for new payouts. |
| `GAS_FLOOR_WEI` | `1000000` | Minimum payout gas price (0.001 gwei). |
| `BUMP_EXTRA_BPS` | `1000` | A bump goes to at least the old price × (1.1 + this). |
| `PRIORITY_MICROLAMPORTS` | `0` | Solana priority fee on `fill`/`bump_gas`. |
| `INCLUDE_SIG_RENT` | `1` | Prices the 0.002413 SOL SigRequest rent into quotes. |
| `CHECK_RECIPIENT_CODE` | `1` | Skips intents whose recipient has code. |
| `AUTO_REGISTER` | `1` | Registers the Solver account on start when `BOT_ID` is set. |
| `TICK_MS`, `POLL_MS`, `DELIVER_MS`, `ANCHOR_MS` | `1000`, `10000`, `4000`, `60000` | Loop intervals. `POLL_MS` re-reads the indexed open intents by key. |

## Railway

Both bots run as Railway services built from the repo root with this Dockerfile; [`railway/README.md`](../../railway/README.md) has the service configs, variables and CLI steps. `package-lock.json` is committed and the image installs with `npm ci`, so builds are reproducible.

Without Docker, the start command is `npx tsx services/solver/src/index.ts`, run from the repo root after `npm ci`.

## Assumptions

- **Pyth layout:** the `PriceUpdateV2` layout was written from the receiver SDK's struct definitions, without the SDK at hand. The discriminator is checked, and the feed id is compared to the known SOL/USD and ETH/USD ids. A mismatch only logs a warning.
- **Withdrawal payouts:** each `solver_withdraw` keeps a `Withdrawal` account at `["withdrawal", nonce]`. The bot reads those in the pool's pending nonce range, rebroadcasts them, and bumps the head of the queue with `bump_withdrawal_gas`, the same as fills.
- **Full bump slots:** with four signatures and none landed, the bot reuses the slot of a request that expired unsigned (60 s past `expires_at`). If all four were signed, only the admin can re-sign (`bump_gas` with the slot to replace as a remaining account).
- **Fails closed:** no fills or quotes while the price anchor is older than 3 × `ANCHOR_MS`, while Base's `eth_gasPrice` is above `max_gas_price`, or while the recipient `eth_getCode` check cannot run. Base RPC calls time out after `BASE_RPC_TIMEOUT_MS` (5000).
