# SODA Intents and SODA Witness

TOKEN2049 Origins, October 2026.

| Build | Track | One line |
|---|---|---|
| **SODA Intents** | Solana | Sell SOL on Solana and receive native ETH on Base. Solvers race in an on-chain Dutch auction, one Solana transaction settles the trade, and a threshold committee signs the Base payout. |
| **SODA Witness** | Chainlink CRE | A CRE workflow reads a Base Sepolia transaction, the nodes agree on what happened, and the facts are written into a Solana program as a `Claim`. |

**Live page:** https://web-production-734ea.up.railway.app (Solana devnet → Base Sepolia; connect Phantom set to devnet). The two solver bots run next to it on Railway.

**Move authority, not assets.** Bridges move tokens between chains and wrap them on the way. SODA lets a Solana account, whether a wallet or a program PDA, control a native address on another chain. A Solana program decides, an MPC committee signs, Solana checks the signature with `secp256k1_recover`, and Base sees an ordinary transaction from an address that has no private key anywhere. Intents is the product this enables: the user's SOL and an irrevocable Base payout signature change hands in a single Solana transaction, with no contract on Base and no cross-chain message. Witness carries information the other way, bringing a Base fact back to Solana. Phase 2 uses it to credit solver deposits without an admin.

---

## What is new in this repo

SODA itself is prior work from [github.com/derek2403/frontier](https://github.com/derek2403/frontier). Everything in the "New" column was built for this hackathon.

| Prior work (SODA, frontier) | New here |
|---|---|
| `soda` program `CPAEfBX…` (`request_signature`, `finalize_signature`, on-chain address derivation) | `programs/programs/intents`: Dutch auction, escrow, solver ledger, payout signing by CPI into soda, gas bumps, withdrawals |
| 2-of-2 MPC committee (Lindell 2017 two-party ECDSA), coordinator and subscriber, hosted on Railway and unchanged | `programs/programs/soda_witness`: the CRE receiver (`open_claim`, `on_report`) |
| frontier's relayer (broadcasts `EthTxRequested`) | `cre/soda-witness`: the CRE workflow (TypeScript, `@chainlink/cre-sdk`) |
| SDK files copied into `lib/soda/` (derive, rlp, EthRpc, EVM chain tag), each marked at the top of the file | `services/solver`: an AMM solver bot that prices from Pyth, fills, delivers Base payouts itself, and bumps stuck ones |
| `eth_rlp.rs`, copied into `programs/programs/intents/src/` and credited | `app/`: a swap page modelled on 1inch Fusion+, with an order drawer and an Activity panel |
| frontier's `pnpm verify` audit tool (used to check our payouts, not copied) | `lib/intents`: PDAs, decoders, auction math, the status machine and payout tracking, shared by the page, the bot and the CLIs |
| | `scripts/`: `intents-cli.ts`, `witness-cli.ts`, `demo-rejected-fill.ts` |

The workflow started from Chainlink's [`solana-read-write-ts` template](https://github.com/smartcontractkit/cre-templates/tree/main/building-blocks/solana-read-write/solana-read-write-ts) (MIT).

## Live deployments (Solana devnet and Base Sepolia)

| Item | Address |
|---|---|
| `intents` program | [`BV9KfzKwXPp9hQZEyhoVm9STbDy7gCGCmKcKpCDr8jXA`](https://explorer.solana.com/address/BV9KfzKwXPp9hQZEyhoVm9STbDy7gCGCmKcKpCDr8jXA?cluster=devnet) |
| Pool PDA (the SODA requester) | [`WtaezksvpBC1LGh4oV7xvURsdtdTv752z1A4NpLv7uS`](https://explorer.solana.com/address/WtaezksvpBC1LGh4oV7xvURsdtdTv752z1A4NpLv7uS?cluster=devnet) |
| Pool's Base Sepolia address (holds all solver inventory) | [`0x7662920f66682D8996EC6B6D9E4ac9ed25a1006C`](https://sepolia.basescan.org/address/0x7662920f66682D8996EC6B6D9E4ac9ed25a1006C) |
| Solver A / Solver B | `D5pwjGzqvgvuFt4rtMVf1ta4RKXWyGGfG2ekh5KuDfZw` / `CozgNEdiG93qqo8cxXeXddvuT3F1Gh6zHr4VLro1sZ54` |
| `soda_witness` program | [`5v97wLYgMzyfQfpZWGQ6uPXTHh4JsJitUXPReYy2uuTp`](https://explorer.solana.com/address/5v97wLYgMzyfQfpZWGQ6uPXTHh4JsJitUXPReYy2uuTp?cluster=devnet) |
| `soda_witness` Config | [`5Dxc9Y6sWUwvcLUhatWAHmBwVnKfUXPu5cuWccZZCNRY`](https://explorer.solana.com/address/5Dxc9Y6sWUwvcLUhatWAHmBwVnKfUXPu5cuWccZZCNRY?cluster=devnet), set to the Chainlink **mock** forwarder `7kuEAA3mSC1Tz8gQjnvH7bKFda9xSPRRin9SZbH49cNK` |
| `soda` (prior work) / Committee PDA | `CPAEfBXpMMsUrjLNhDYxaCH79DYvFHJFC27fttnxAL1J` / `9mX3oHUmsrYvzXjCo35HhfXufrGZT3hjsLoC74xbA6SS` |

The devnet `intents` build includes Phase 2: `credit_solver_from_claim`, the per-deposit `Credit` record and the `deposit_from` proof. It was upgraded in place, and its rollout is logged in [`runs/witness-devnet.md`](runs/witness-devnet.md#phase-2-a-solver-deposit-credited-from-a-witness-claim-links-both-builds).

## Demo evidence

Full logs with every link: [`runs/intents-devnet.md`](runs/intents-devnet.md), [`runs/witness-devnet.md`](runs/witness-devnet.md), [`cre/runs/2026-10-07-broadcast-deposit-claim.log`](cre/runs/2026-10-07-broadcast-deposit-claim.log) and [`cre/runs/2026-10-07-broadcast-phase2-claim.log`](cre/runs/2026-10-07-broadcast-phase2-claim.log).

### First trade: 0.05 SOL for native ETH on Base, Fast preset

The recipient is the user's own SODA-derived Base address, `0xDD8E…FaD7`, which is controlled by their Solana wallet.

| Step | Elapsed | Link |
|---|---|---|
| `open_intent` confirmed | 2.3 s | [tx](https://explorer.solana.com/tx/2nyFxscjyCNnKMeRmgKLazRQ9dvuy9Nw3FqTxj9CTkGy47foEiXJxBVdCbnKf6c9FKusMDyMdgXamSuRxxtZaphE?cluster=devnet) |
| Solver `fill`: SOL goes to the solver and a SODA signature is requested | 13.8 s | [tx](https://explorer.solana.com/tx/2FU8v9fFPCQcu2ibg3G8R2SSWbx9Z7ur4HwNQfyvTrvrUPc7xV3fcWGcrVT7QHy8FZueYNJ947zirSw5QcVqR6Db?cluster=devnet) |
| Committee signs and soda verifies with `secp256k1_recover` | 15.6 s | [SigRequest](https://explorer.solana.com/account/GXRGBBc7EdDAE5qnH2AxV6PzJ42KjVRiBLHkawY1FjUC?cluster=devnet) |
| 0.002138 ETH arrives on Base (nonce 0) | 15.6 s | [Basescan](https://sepolia.basescan.org/tx/0x353d5150b40bdf90042905b7eb76a8f51feb6a77204f6e52f8f3096750159609) |

Most of the gap before the fill came from the bot's 10-second fallback poll; the public WebSocket was being rate-limited at the time.

We then audited the payout independently with frontier's `pnpm verify` (`VERIFY_REQUESTER=<pool PDA>`). All 8 checks returned MATCH, including that the signature on Solana equals the Base transaction's `(r,s)`, that the recovered key equals the stored foreign key, and that the derived address equals `tx.from`. The pool's Base address has no private key; only the `intents` program controls it.

### Two solvers race

Both bots quoted 0.002141 ETH for intent `FxXu…NPH`. Solver A filled it 3.2 s after it opened ([fill](https://explorer.solana.com/tx/3hCi6rDPgEUub9wPzXo9bEYBCm42aStfSEKxnCZiAkk4akgFrXBeoMhW1KN5td6cntKeoHKEYjxbEjVkp61MsvHk?cluster=devnet)), and the ETH was paid on Base **6.4 s end to end**. Solver B's fill for the same intent was rejected on chain with `IntentNotOpen` (6001): [tx](https://explorer.solana.com/tx/3d6ARGnfbv5gMxD5sj5w3AduHT1v9aEQKjHjNmdrPkjssTy69juDw6Qdc9C9i6LMuiXyzpUyj4GN7caZ4EWQQA95?cluster=devnet). You can reproduce the rejection with `npx tsx scripts/demo-rejected-fill.ts <intent> --keypair <solver B>`.

We also ran the maker's cancel path: `open_intent`, then `cancel_intent` (the 0.01 SOL escrow is refunded), then `close_intent` (the rent is returned). The links are in the run log.

### Witness: a Base deposit recorded on Solana

1. `open_claim(84532, 0xb9d1…57d7)` created claim [`2LHe…oEmF`](https://explorer.solana.com/address/2LHehzzCpXXMHpWhDMZRTCsZGXTsF5kzSVJDXfjGoEmF?cluster=devnet), Pending ([tx](https://explorer.solana.com/tx/3VKKmCEefgmihjfwAkC4dr9C3RM9e9qeQ2pnS84n23eFA4N7oQ4Mgim3tFZNb8kb4ePEAVVBatLwNfQvoZ1THnt8?cluster=devnet)). The transaction is the 1 ETH solver deposit into the pool.
2. `cre workflow simulate soda-witness … --broadcast` read the receipt and the transaction (identical consensus) and the chain head (median consensus) from Base Sepolia. It counted 899 confirmations against a minimum of 3, then wrote the 106-byte report through the mock forwarder: [`on_report` tx](https://explorer.solana.com/tx/23541hZLtRNbaJyrrZgDT4ExxMgJyUYeeetUdZF2x51Z5ZqiJcZgV4HFf4saUYsNyBJdZt2JXyLRkH1arfG81b2u?cluster=devnet).
3. The claim is now **Recorded** with `from 0x3177…be7b`, `to 0x7662…006c` (the pool), `value 1 ETH`, `block 47799710` and `success true`.

---

## How it works

### Intents

```
user ── open_intent ──▶ Intent PDA (SOL in escrow, Dutch auction starts)
solver ── fill ──▶ intents program:
                     check price ≥ required_out(now), nonce, gas bounds, solver ledger
                     debit the ledger, send the escrowed SOL to the solver
                     build the Base payout RLP (pool → recipient, nonce = next_nonce++)
                     CPI soda::request_signature with the pool PDA as requester
                     emit EthTxRequested + IntentFilled
committee ── finalize_signature ──▶ soda checks secp256k1_recover == the pool's foreign key
solver bot ── eth_sendRawTransaction ──▶ Base: ETH arrives from the pool address
```

- **Auction.** This is the linear Dutch auction used by Fusion. `required_out(t)` equals `start_out` before `auction_start` and `min_out` after the auction ends. In between it is `start_out − (start_out − min_out)·(t − auction_start)/duration`. The page offers three presets: Fast (30 s, 0.5% tolerance), Fair (60 s, 1%) and Auction (120 s, 2%). `start_out` is the best live solver quote.
- **One-transaction settlement.** The program knows every payout it asks SODA to sign, so `fill` swaps the user's SOL for an irrevocable Base signature on its own. No oracle is needed in this direction.
- **Nonce ordering.** Every payout comes from one pool address, so `fill` and `solver_withdraw` take `expected_nonce == next_nonce`. A solver that lost a race gets a named `NonceMoved` error. Each nonce keeps an on-chain record (an `Intent` or a `Withdrawal`) that can re-sign it.
- **Gas bumps.** `bump_gas` and `bump_withdrawal_gas` re-sign the same payout at the same nonce with at least 10% more gas, since Base's mempool rejects a smaller replacement. The filling solver or the admin can bump at any time, and anyone can bump once 60 s have passed, so one offline solver cannot stall the queue. The bot bumps its own payouts after 30 s unmined. There are four signature slots per nonce, and expired, unsigned slots can be reused. Only one transaction per nonce can ever land.
- **Payout tracking** (`lib/intents/payout.ts`). Once a `SigRequest` completes, anyone can rebuild the signed transaction and its hash: `v = recovery_id + 35 + 2·84532`. The bot and the page's `/api/payout` do this for every candidate, rebroadcast, and report delivery when any candidate has a receipt.
- **Solver bot.** It prices on a constant-product curve over virtual reserves of its own inventory, re-anchored every minute to Pyth devnet SOL/USD and ETH/USD, minus `SPREAD_BPS` and gas. It fails closed when prices are stale, gas is over the cap, or the recipient check cannot run. Recipients must be plain addresses (`eth_getCode == 0x`), because payouts use 21,000 gas.

### Witness

```
open_claim(chain_id, tx_hash) ──▶ Claim PDA, Pending (keyed on the requester, who pays)
HTTP trigger {claim, txHash} ──▶ CRE workflow:
    eth_getTransactionReceipt + eth_getTransactionByHash  → identical consensus
    eth_blockNumber                                       → median consensus
    require head − block ≥ 3, chainId == 84532
    WitnessReport (106-byte Borsh) ──▶ forwarder ──▶ soda_witness::on_report
on_report: forwarder program and state match Config, authority PDA matches,
           claim Pending, report chain_id and tx_hash match the claim  →  Recorded
```

Base is read through the `BASE_RPC_URL` workflow secret. `on_report` records facts (from, to, value, block, success) and does not judge them; each consumer applies its own rules. A claim accepts exactly one report.

### Phase 2: solver deposits credited from Witness claims

`credit_solver_from_claim` connects the two builds. A solver deposits ETH into the pool on Base, opens a claim with its own key, and runs the workflow. The `intents` program then reads the `Claim` account itself and checks, in order:

- the owner is `soda_witness`;
- the claim is Recorded and `success` is true;
- the chain is 84532;
- `to` is the pool;
- `from` is the solver's proven `deposit_from`;
- the requester is the solver;
- the value is greater than 0.

If every check passes, it credits the solver's ledger. A `Credit` PDA at `["credit", tx_hash]`, shared with the admin `credit_solver` path, means a deposit can be credited only once, by either path. `register_solver` now requires an EIP-191 signature from `deposit_from`, so nobody can register another solver's Base wallet and take its deposits. While the witness Config points at the mock forwarder, the admin must co-sign every claim credit (`UntrustedWitness`). It becomes permissionless only once the witness uses the production forwarder with a pinned workflow owner.

**Status: live on devnet.** Solver A's operator deposited 0.1 ETH to the pool ([Basescan](https://sepolia.basescan.org/tx/0xb3997391723ebddc8b0514b4604e5dbff942115dd952d041cba4e14753c5c08c)) and opened claim `FwFu…6AsW` with the solver's key. The CRE simulation recorded it with `--broadcast` ([on_report](https://explorer.solana.com/tx/5ZqG2ZMLemTMAqBT3ZnMqvMCCpJoZCpNhxsUU9E37kxDXHjZUWorv944EXd27mq5YkdsU7cYL7CoD24kPKCGTGxN?cluster=devnet), [log](cre/runs/2026-10-07-broadcast-phase2-claim.log)). `credit_solver_from_claim` then raised the solver's ledger from 0.993515 to 1.093515 ETH ([tx](https://explorer.solana.com/tx/CrGcrniDaRMessATxk81gYqJh83rrZYusgdudCoxEh61hguv9gzgXXBj86iGuBwcvpwDv8h5RQKmE2uJCfuEBBU?cluster=devnet)). A second credit of the same deposit is refused.

## Prior art

| Protocol | How it settles | What you trust |
|---|---|---|
| [NEAR Intents](https://docs.near.org/chain-abstraction/chain-signatures) | Verifier contract on NEAR; Solana assets bridge in | Bridges plus NEAR's MPC network |
| [Mayan Swift](https://docs.mayan.finance/architecture/swift-v2) | Auction on Solana; a message unlocks funds | Messaging layer, curated solvers |
| [deBridge DLN](https://docs.debridge.finance/dln-the-debridge-liquidity-network-protocol/protocol-overview) | Source escrow; validators sign the unlock | deBridge validators |
| [Relay](https://docs.relay.link/references/protocol/how-it-works) | Solana depository; an oracle attests | Oracle, allocator, security council |
| [Across](https://docs.across.to/reference/contract-addresses/solana) | Relayers fill and are repaid in bundles | UMA optimistic oracle |
| [1inch Fusion+](https://help.1inch.com/en/articles/9842591-what-is-1inch-fusion-and-how-does-it-work) | Escrows on both chains, tied by a secret hash | Resolvers, plus the user's browser revealing the secret |
| [Ika](https://solana-pre-alpha.ika.xyz/getting-started/concepts) | A signing primitive on Solana, not an intent protocol | The Solana pre-alpha uses one mock signer |

Escrow designs need a contract on both chains and a cross-chain message, and oracle designs add a trusted attester. SODA Intents settles in one Solana transaction, with no contract on Base and no fill message. NEAR Chain Signatures has the same shape but settles on NEAR. Fusion+ tells users "do not close the tab" because the browser holds a secret; with SODA the user holds no secret, so the page says "Safe to close this tab."

## Trust model

- **The committee is 2-of-2, run by one operator.** It has no fault tolerance, and its key was generated in one process on one machine. Production needs 2-of-3 or more, independent operators and protected key shares.
- **Signed is not the same as landed.** Solana knows a payout was signed, not that it reached Base. Gas bumps handle stuck payouts, but there is no automatic refund if a signed payout never lands.
- **Solver deposits.** Both solvers' first deposits were credited by the admin (`credit_solver`, a trusted step). Since the Phase 2 upgrade, deposits are credited from Witness claims instead. While the witness is on the mock forwarder, that path still needs the admin's co-signature in place of DON signatures.
- **CRE runs in simulation only, and Chainlink confirmed that is acceptable for this hackathon.** `cre workflow simulate` always writes through the mock forwarder, which checks no DON signatures, has no replay protection and can be called by anyone. A Recorded claim on devnet therefore shows that a well-formed report arrived, not that a DON produced it. For this reason Phase 2 requires the admin to co-sign until the witness is switched to the production forwarder (`CXsKEJc…`, which checks f+1 DON signatures). See [`cre/README.md`](cre/README.md).
- **Signature request rent.** Each payout locks 0.002413 SOL in soda's `SigRequest`, and soda has no way to close it. The solver's quote prices this in.
- **Solvers A and B were registered before the `deposit_from` proof existed.** They share `deposit_from 0x3177…`, which one operator controls. New registrations must prove the address with an EIP-191 signature.

## Run it yourself

You need Node 22 and npm. For the programs you also need Anchor 0.32.1 and Solana CLI 3.1.10; for the workflow, Bun and CRE CLI 1.29 or later (1.37.0 tested).

```bash
npm ci
cp .env.example .env        # names only; fill in the values
```

| Variable | Used by | Notes |
|---|---|---|
| `SOLANA_RPC_URL` | bot, CLIs, server routes | A keyed devnet HTTP RPC (we use Alchemy). The default is `https://api.devnet.solana.com`, which rate-limits. |
| `SOLANA_WS_URL` | bot (optional), `witness-cli` | The bot polls `getSignaturesForAddress` when this is unset. `witness-cli` confirms over `wss://solana-devnet.api.onfinality.io/public-ws` by default. |
| `BASE_RPC_URL` | bot, CLIs, server routes | Base Sepolia JSON-RPC (a keyed Alchemy URL works). The default is `https://sepolia.base.org`. Server only. |
| `NEXT_PUBLIC_SOLANA_RPC_URL`, `NEXT_PUBLIC_SOLANA_WS_URL` | browser | Use `https://solana-devnet.api.onfinality.io/public` and `wss://solana-devnet.api.onfinality.io/public-ws`. These end up in the bundle, so they must not carry a key, and the RPC must serve `getProgramAccounts` for the Activity panel. |
| `SOLVER_URLS` | `/api/quotes`, CLI quotes | Comma-separated solver quote endpoints, for example `http://localhost:8081,http://localhost:8082`. |
| `SOLVER_KEYPAIR_JSON` / `SOLVER_KEYPAIR_PATH` / `SOL_KEY` | bot | The solver authority key. |
| `BOT_ID` | CLI `deposit`, `register-solver` | The operator's Base wallet key. Secret. |
| `SPREAD_BPS`, `PORT` | bot | For example 30 and 60 for two competing bots. |

```bash
npm run dev                                   # swap page on :3000
PORT=8081 SPREAD_BPS=30 npm run solver        # one solver bot (GET /quote, GET /health)

npm run cli -- help
npm run cli -- trade --sol 0.05 --preset fast # open an intent and follow it until ETH lands on Base
npm run cli -- status <intent>
npm run cli -- cancel <intent>
npm run cli -- pool-address
SOLANA_RPC_URL=https://solana-devnet.api.onfinality.io/public npm run cli -- balances   # needs getProgramAccounts

npx tsx scripts/witness-cli.ts show-config
npx tsx scripts/witness-cli.ts open-claim <base tx hash>      # writes cre/payloads/claim.json
npx tsx scripts/witness-cli.ts show-claim <claim>
```

The user keypair comes from `--keypair`, `USER_KEYPAIR` or `~/.config/solana/id.json`, and it needs devnet SOL from faucet.solana.com.

**CRE workflow.** Copy `cre/.env.example` to `cre/.env` and fill in `CRE_SOLANA_RPC_URL`, `CRE_SOLANA_PRIVATE_KEY`, `CRE_ETH_PRIVATE_KEY` and `BASE_RPC_URL_ALL`. Then:

```bash
cd cre
cre workflow simulate soda-witness --target simulation-settings --non-interactive --trigger-index 0 \
  --http-payload ./payloads/claim.json               # dry run
cre workflow simulate soda-witness --target simulation-settings --non-interactive --trigger-index 0 \
  --http-payload ./payloads/claim.json --broadcast    # real devnet write through the mock forwarder
```

**Tests** (all offline):

```bash
cd programs && anchor build && cargo test -p intents && cd ..   # Rust unit tests
npm run test:programs     # LiteSVM: both programs, including every Phase 2 check
npm run test:lib          # lib/intents, including decoding the live claim's bytes
npm run test:solver       # services/solver
cd cre/soda-witness && bun install && bun test                  # the workflow against the CRE SDK test runtime
npm run typecheck         # next typegen (route types), then tsc
```

**Hosting.** The page and both bots run as three Railway services (`web`, `solver-a`, `solver-b`) in the `soda-intents` project. The page is at https://web-production-734ea.up.railway.app, and the bots are reachable only on Railway's private network. [`railway/README.md`](railway/README.md) has the variables and steps. The SODA committee runs in its own Railway project. The bots find intents by polling `getSignaturesForAddress` on the program through a keyed RPC, so they need neither WebSockets nor `getProgramAccounts`.

## Repo layout

```
app/                    Next.js 16 swap page and API routes (quotes, payout, group-pk, prices, recipient-check, health)
lib/intents/            shared client code: PDAs, decoders, auction math, status machine, payout tracking, witness claim decoder
lib/soda/               SDK files copied from frontier (prior work)
idl/                    soda.json (copied), intents.json and soda_witness.json (built)
programs/               Anchor workspace: programs/intents, programs/soda_witness, LiteSVM tests
cre/                    CRE project: soda-witness workflow, payloads, broadcast logs in runs/
services/solver/        solver bot (Dockerfile, README)
scripts/                intents-cli, witness-cli, demo-rejected-fill
railway/                Railway service configs
runs/                   devnet evidence logs
HANDOVER.md             full design spec
```

## Known limitations and out of scope

- **ETH to SOL.** Not built. Phase 2 (a Base deposit proven to Solana) is the first step in that direction.
- **Automatic refund** when a signed payout never lands on Base. Gas bumps are the only remedy today.
- **Mainnet**, solver bonds and slashing, and assets other than SOL and ETH.
- **CRE deployment.** The workflow has run only under `cre workflow simulate`. `config.production.json` and `witness-cli set-config --forwarder production` are prepared for a DON deployment.
- **Payout calldata is empty** and payouts use 21,000 gas, so recipients must be plain addresses. The page and the bot both check this.
