# Demo plan: videos and live booth

This is the script for the two hackathon videos (Solana track, Chainlink CRE track) and the live booth demo. Every number quoted here comes from a run log in [`runs/`](runs/). The run logs record what happened; this file plans what to show.

- Live page: https://web-production-734ea.up.railway.app (Solana devnet → Base Sepolia, Phantom on **devnet**)
- Cross-chain signing page: `/demo`, ported from frontier. It runs at `http://localhost:3000/demo` under `npm run dev`, and at the live URL once `web` is redeployed.
- Committee coordinator: https://soda-mpc-coordinator-production.up.railway.app

---

## 1. The story (say this in the first 15 seconds)

**Move authority, not assets.** A bridge moves your tokens and wraps them along the way. SODA moves something else: it lets a Solana program control a native address on Base. The Solana program decides, an MPC committee signs, Solana checks the signature with `secp256k1_recover`, and Base sees an ordinary transfer from an address that has no private key anywhere. On top of that we built **SODA Intents**, which sells SOL for native ETH in one Solana transaction with no contract on Base. **Chainlink CRE carries the data in both directions:**
- **Witness** brings a Base fact *into* Solana, so solver deposits are credited without an admin deciding the amount.
- **Signer** drives the committee's signing that sends authority *out* to Base. CRE gets the 2-of-2 signature and finalizes it on Solana through Chainlink's forwarder.

---

## 2. What runs where (which parts are Chainlink)

| Component | Runs on | Chainlink? | Role in the demo |
|---|---|---|---|
| Swap page + `/api/quotes`, `/api/rfq` (RFQ relay), `/api/payout` | Railway `web` (off-chain) | No | UI, quote fan-out, RFQ message bus, status and timing |
| Solver A (`D5pw…`, 30 bps) / Solver B (`Cozg…`, 60 bps) | Railway `solver-a`, `solver-b` (off-chain) | No | Quote, fill, broadcast Base payouts, bump gas |
| Solver pricing | Pyth devnet SOL/USD and ETH/USD | **No (Pyth)** | Anchors each bot's curve every minute |
| `intents` program `BV9Kfz…` | Solana devnet | No | Dutch auction, RFQ `execute_signed_intent`, ledger, CPI into soda |
| `soda` program `CPAEf…` + Committee `9mX3…` | Solana devnet (prior work) | No | `request_signature`, `finalize_signature` (checks with `secp256k1_recover`) |
| MPC nodes p1, p2 + coordinator | Railway `pagecontrol-signing` (prior work) | No | 2-of-2 Lindell ECDSA, `POST /sign` |
| `soda-mpc-subscriber` | Railway `pagecontrol-signing` | No | **Default** signing trigger: sees `SigRequested`, calls `/sign`, finalizes |
| `soda-relayer` | Railway `pagecontrol-signing` | No | Broadcasts `/demo` (eth_demo) transactions to Base |
| `eth_demo` program `9JMr3T…` | Solana devnet (prior work) | No | `sign_eth_transfer` for the `/demo` page |
| **`cre/soda-witness` workflow** | **Chainlink CRE** (`cre workflow simulate`) | **Yes** | Reads a Base tx (identical consensus) and head (median), writes a `WitnessReport` |
| **`cre/soda-signer` workflow** | **Chainlink CRE** (`cre workflow simulate`) | **Yes** | Reads a pending `SigRequest`, calls the coordinator `/sign`, writes a `SignerReport` |
| **Chainlink mock forwarder** `7kuEAA3…` | Solana devnet, Chainlink-owned | **Yes** | Delivers CRE reports to our receivers (simulation always uses it) |
| `soda_witness` `5v97wL…` | Solana devnet | Chainlink **receiver** | `open_claim`, `on_report` → claim Recorded |
| `soda_cre_signer` `2cgtuK…` | Solana devnet | Chainlink **receiver** | `on_report` → CPI `soda::finalize_signature` |
| Pool address `0x7662…006C` | Base Sepolia | No (no contract at all) | Holds solver inventory; pays users with plain transfers |

Signing has two interchangeable triggers. Both call the same coordinator, and soda checks the result the same way:

```
SigRequest (pending)
  ├─ default:   Railway subscriber ─────────────────▶ coordinator /sign ─▶ soda.finalize_signature
  └─ Chainlink: CRE soda-signer ─▶ coordinator /sign ─▶ forwarder ─▶ soda_cre_signer ─▶ soda.finalize_signature
```

---

## 3. "The Auction filled immediately. Is that expected?"

Yes, with the default settings. The page sets `start_out` to the **best live solver quote**, so the price at second 0 already meets a solver's quote, and that solver fills on the next poll. The runs show this: filled 3.2 s after opening ([race](runs/intents-devnet.md#two-solvers-racing-both-at-30-bps)), and 5.9 s end to end on Railway ([hosted](runs/intents-devnet.md#hosted-on-railway)).

To make the Dutch auction *visible* in a video, start above the quote:

```bash
npm run cli -- trade --sol 0.05 --preset fast --start-premium-bps 100
```

`required_out(t)` falls linearly from `start_out` to `min_out`, and a solver fills when the curve crosses its quote. Assuming `min_out` stays at quote × (1 − tolerance), the fill lands about `premium / (premium + tolerance)` of the way through the auction. For Fast (30 s, 0.5% tolerance) with 100 bps, that is about 20 s. **Rehearse once and adjust**, because quotes move with Pyth.

---

## 4. Video 1: Solana track (≤ 3:00)

| Time | Segment |
|---|---|
| 0:00–0:15 | Story (section 1) |
| 0:15–1:10 | Auction trade + drawer timeline |
| 1:10–1:30 | Basescan: plain transfer from a keyless address |
| 1:30–2:25 | RFQ: quotes, sign a message, settled |
| 2:25–2:50 | Activity + 8× MATCH audit |
| 2:50–3:00 | Close |

**Auction (0:15–1:10)**
1. Open https://web-production-734ea.up.railway.app. Phantom is on devnet and connected.
2. Point at the header's **Auction | RFQ** switch. Stay on **Auction**.
3. Enter **0.05 SOL**. Recipient: your SODA-derived Base address (`0xDD8E…FaD7` in the runs).
4. Choose a preset. If the page has the start-premium control, set it to 100 bps so the price visibly ticks down. Otherwise, say "it starts at the best quote, so a solver fills right away" (section 3).
5. Click swap, then approve **one** Phantom transaction (`open_intent`).
6. Open the order drawer and narrate the timeline:
   - Intent opened: SOL is in escrow on Solana.
   - Solver filled: SOL goes to the solver, and the same tx asks SODA for a signature.
   - **Committee signing → Signature verified**: the drawer shows "≈N s (M slots)". Measured examples are ≈2.8 s (7 slots) and ≈5.2 s (13 slots) ([RFQ_INTEGRATION.md](app/RFQ_INTEGRATION.md), [live check](runs/intents-devnet.md#live-web-check-after-the-review-fixes-2026-10-07-2235-08)).
   - **ETH received on Base**, with a Basescan link.
7. Say: "Safe to close this tab. The user holds no secret, unlike Fusion+."

**Basescan (1:10–1:30)**
1. Click the Base receipt.
2. Show `from 0x7662920f66682D8996EC6B6D9E4ac9ed25a1006C`, a plain 21,000-gas transfer, and no contract.
3. Say: "This address has no private key. Only the `intents` program on Solana can make it sign. That proof lives on Solana, not on Base."

**RFQ (1:30–2:25)**
1. Switch to **RFQ**.
2. First trade only: deposit into the vault, for example 0.1 SOL. That is one transaction, and it was done once in the run ([deposit](runs/intents-devnet.md#rfq-near-intents-style-signed-intent-no-user-transaction-per-swap)). Pre-record it or do it before recording.
3. Enter 0.05 SOL. Quotes arrive from **both** Railway solvers, with the best highlighted (1.5–2.5 s in the runs).
4. Click sign. Phantom shows a readable **message**, not a transaction. Read the `SODA Intents v1 … receive at least … to 0x… on base-sepolia` lines aloud.
5. Settled: the winning solver submitted `execute_signed_intent`, and the program verified ed25519 on chain (1.9–2.0 s).
6. ETH on Base: 6.9 s and 7.5 s from publish in the two logged runs.

**Activity + audit (2:25–2:50)**
1. Open **Activity**. Rows show "· Auction" and "· RFQ".
2. Cut to a terminal with the pre-recorded audit:
   ```bash
   cd frontier
   VERIFY_REQUESTER=WtaezksvpBC1LGh4oV7xvURsdtdTv752z1A4NpLv7uS DEMO_CHAIN=base-sepolia pnpm verify <base tx hash>
   ```
   It prints **8 × MATCH**, ending "derived ETH address == tx.from: MATCH (no private key for this address exists anywhere)" ([log](runs/intents-devnet.md#independent-audit-frontier-pnpm-verify)).

**Close (2:50–3:00):** "One Solana transaction, native ETH on Base, no bridge token, no Base contract. Fusion-style auction or NEAR-style RFQ on the same settlement layer."

---

## 5. Video 2: Chainlink CRE track (≤ 3:00)

| Time | Segment |
|---|---|
| 0:00–0:15 | Story: CRE in both directions (section 1, plus the table in section 2) |
| 0:15–1:15 | (a) Witness: a Base deposit credited on Solana |
| 1:15–2:40 | (b) Signer: CRE drives the MPC committee |
| 2:40–3:00 | Trust model and close |

The CRE simulator compiles the workflow before it runs, so **pre-record each `simulate` and cut the wait**. Keep the Explorer tabs open in advance.

### (a) Witness: Base → Solana (0:15–1:15)

Commands come from [`runs/witness-devnet.md`](runs/witness-devnet.md) and [`cre/README.md`](cre/README.md).

1. Solver A's operator (`BOT_ID`, `0x3177…`, the solver's proven `deposit_from`) deposits to the pool on Base:
   ```bash
   npm run cli -- deposit --eth 0.01            # dry run
   npm run cli -- deposit --eth 0.01 --yes      # sends; prints the Base tx hash
   ```
2. Open a claim, signed by **solver A's key** (the requester must be the solver):
   ```bash
   npx tsx scripts/witness-cli.ts open-claim <base tx hash> --keypair <solver A keypair>
   ```
   It prints the claim PDA as **Pending** and rewrites `cre/payloads/claim.json`.
3. Wait for at least 3 Base confirmations, then run the workflow:
   ```bash
   cd cre
   cre workflow simulate soda-witness --target simulation-settings --non-interactive --trigger-index 0 \
     --http-payload ./payloads/claim.json --broadcast
   cd ..
   ```
   On screen: the DON reads the receipt and tx (identical consensus) and the head (median), counts confirmations, and writes the 106-byte report through the forwarder.
4. Show the claim:
   ```bash
   npx tsx scripts/witness-cli.ts show-claim <claim>
   ```
   It reads **Recorded** with from, to = pool, value, block and success.
5. Credit the solver from the claim:
   ```bash
   SOLANA_RPC_URL=https://solana-devnet.api.onfinality.io/public npm run cli -- balances   # ledger before
   npm run cli -- credit-from-claim --claim <claim>
   SOLANA_RPC_URL=https://solana-devnet.api.onfinality.io/public npm run cli -- balances   # ledger after
   ```
   The logged run raised the ledger from 0.993515 to **1.093515 ETH**, and a second credit was refused ([Phase 2](runs/witness-devnet.md#phase-2-a-solver-deposit-credited-from-a-witness-claim-links-both-builds)).
6. Say: "The program reads the claim itself and checks owner, Recorded, chain, to = pool, from = the solver's proven address, and requester. Because the mock forwarder has no DON signatures, the admin co-signs this step for now. With the production forwarder it becomes permissionless."

Fallback: play the recorded run. Claim `FwFu…6AsW`, [on_report](https://explorer.solana.com/tx/5ZqG2ZMLemTMAqBT3ZnMqvMCCpJoZCpNhxsUU9E37kxDXHjZUWorv944EXd27mq5YkdsU7cYL7CoD24kPKCGTGxN?cluster=devnet), [credit](https://explorer.solana.com/tx/CrGcrniDaRMessATxk81gYqJh83rrZYusgdudCoxEh61hguv9gzgXXBj86iGuBwcvpwDv8h5RQKmE2uJCfuEBBU?cluster=devnet).

### (b) Signer: CRE drives the MPC committee (1:15–2:40)

The model is the logged run ([`runs/cre-signer-devnet.md`](runs/cre-signer-devnet.md)): the subscriber was paused for 46 s, CRE got the signature from the coordinator in 3 s, and the finalize landed 5 s after the trigger.

1. Pause the default trigger:
   ```bash
   npm run demo:cre -- pause-subscriber
   ```
   Say: "The committee's own watcher is off. Nothing on our side will sign."
2. Make a trade. Use the page (RFQ is quickest), or the CLI:
   ```bash
   npm run cli -- rfq-trade --sol 0.05
   ```
   Alternatively, use a `/demo` transfer (section 6).
3. Show the drawer sitting at **Committee signing**: the SigRequest is pending.
4. Hand it to Chainlink, using either the CLI or the button:
   ```bash
   npm run demo:cre -- cre-sign <intent>
   ```
   The button needs `DEMO_LOCAL_CRE=1 npm run dev`. Open `localhost:3000/demo` and click **"Finalize with Chainlink CRE"**.

   Run `cre-sign` within about 30 s of the fill. If the solver bot bumps gas first, `cre-sign-payload` still picks the newest SigRequest.
5. Show the CRE logs:
   - `[USER LOG] Sign request: sigRequest=…`: the DON read the SigRequest (soda-owned, not completed).
   - `[USER LOG] Signature: r=… s=… recovery_id=…`: the coordinator returned the 2-of-2 signature.
   - `[USER LOG] Finalized …: tx=…`: the report was written through the forwarder.
6. Open that tx in Solana Explorer. Show the instruction chain **Forwarder `Report` → `soda_cre_signer::OnReport` → `soda::FinalizeSignature`**. The logged one is [here](https://explorer.solana.com/tx/4y9mewnHMssvSWuVQzQMSXU4XA94owrLjTkWxx1rZBVe7tZ9FVoqCFp8RVvXsS4R38Di7L8FXFoZ59Gm7AhBJuvq?cluster=devnet).
7. The drawer moves on: signature verified, then **ETH on Base**. The solver bot broadcasts it.
8. **Immediately:**
   ```bash
   npm run demo:cre -- resume-subscriber
   ```
9. Say why the mock forwarder is safe *here*: "The report carries a signature, not a claim about the world. soda recovers the secp256k1 key and checks it against the requester's derived key. A forged report fails on chain whoever sends it. The worst a caller can do is deliver a valid signature early."

### Close (2:40–3:00)

"Witness: Chainlink proves Base facts to Solana. Signer: Chainlink runs the committee's signing loop. Today both use `cre workflow simulate` and the mock forwarder, which Chainlink confirmed is fine for this hackathon. `config.production.json` and `set-config --forwarder production` are ready for a DON deployment."

---

## 6. The `/demo` cross-chain signing segment (from frontier)

This shows SODA by itself, without intents: **your Phantom wallet controls a Base address**. Use it at the booth and in Video 2 (b) as the "or a /demo transfer" option. It is the same pipeline frontier's demo page used: `eth_demo` `9JMr3T…`, soda `CPAEf…`, committee `9mX3…`, Base Sepolia.

1. **Connect** Phantom (devnet). This wallet is the *owner*.
2. **Derive your Ethereum address.** It is computed in the browser from the committee `group_pk` (from `/api/group-pk`), your pubkey and an optional path/salt: `tweak = sha256("SODA-v1" ‖ requester ‖ path ‖ chain)`, `address = keccak(group_pk + tweak·G)`. Change the salt to get a new address live. No transaction is involved.
3. **Fund.** `/api/fund` tops up the derived address from the sponsor key (`BOT_ID` here, capped, faucet-style) so gas is covered.
4. **Send ETH.** One Phantom approval of `eth_demo::sign_eth_transfer`. The program commits the exact unsigned RLP, and soda creates a SigRequest.
5. **Committee signs.** The default is the Railway subscriber, or CRE (below). `finalize_signature` is verified on Solana.
6. **Broadcast.** The assembled signed tx goes to Base, via the page's finalize route and/or the Railway `soda-relayer`. Show the Basescan tx `from` = the derived address.
7. Optional: **Aave V3**, deposit 0.0001 ETH, then borrow USDC against it, one approval each, if the Aave cards were ported. Say: "A Solana wallet holds a lending position on Base."

**Choosing the signer on `/demo`:**

| Mode | How | Who signs |
|---|---|---|
| Subscriber (default, production shape) | Nothing to do | Railway `soda-mpc-subscriber` → coordinator → `finalize_signature` |
| Page server (frontier's fallback) | Built in: if nothing finalizes within ~2.5 s, the route calls the coordinator itself | Same coordinator, finalized by the web server |
| **Chainlink CRE** | `npm run demo:cre -- pause-subscriber`, then `DEMO_LOCAL_CRE=1 npm run dev`, then the **"Finalize with Chainlink CRE"** button | CRE `soda-signer` → coordinator → forwarder → `soda_cre_signer` → soda |

- In CRE mode, confirm the page is **not** also self-finalizing through the fallback. Otherwise the page wins the race and CRE reports `AlreadyFinalized`. The badge and step label on `/demo` should say which signer finalized.
- Without the button, put `{"sigRequest":"<pda>"}` in `cre/payloads/sign.json`, then run `cd cre && cre workflow simulate soda-signer --target simulation-settings --non-interactive --trigger-index 0 --http-payload ./payloads/sign.json --broadcast`.
- The button only exists locally (`DEMO_LOCAL_CRE=1`), because it shells out to the `cre` CLI and `cre/.env`. The Railway page cannot run it.

---

## 7. Pre-flight checklist (T−30 min)

**Health**
```bash
curl -s https://web-production-734ea.up.railway.app/api/health          # {"ok":true,"solvers":2}
curl -s https://web-production-734ea.up.railway.app/api/group-pk        # group_pk 039e4c1a…c5c5
curl -s https://soda-mpc-coordinator-production.up.railway.app/health   # ok, p1 and p2 with the same groupPkXY
curl -s -X POST https://web-production-734ea.up.railway.app/api/rfq -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"quote","params":{"exact_amount_in":"50000000"}}'   # 2 quotes
```

**Balances**
```bash
SOLANA_RPC_URL=https://solana-devnet.api.onfinality.io/public npm run cli -- balances
#   pool on Base (ETH, nonce mined == pending == program next), BOT_ID wallet ETH,
#   both solvers' ledgers, open intents, "PAUSED" must NOT appear
npm run cli -- vault-info <phantom pubkey>      # RFQ vault ≥ 0.1 SOL
solana balance <phantom pubkey> -u devnet       # ≥ 0.3 SOL
solana balance 57Y6siThZ6JUjjpgQ7JT7JUFVk4e1xcAsCDRHJBQUXkE -u devnet   # admin/deployer (co-signs credit-from-claim)
solana balance D5pwjGzqvgvuFt4rtMVf1ta4RKXWyGGfG2ekh5KuDfZw -u devnet   # solver A fees
solana balance CozgNEdiG93qqo8cxXeXddvuT3F1Gh6zHr4VLro1sZ54 -u devnet   # solver B fees
```

**Tick before recording**
- [ ] Phantom on **devnet**, test wallet funded, vault deposited
- [ ] Both solver ledgers comfortably above the trade size; pool ETH ≥ total ledger
- [ ] `BOT_ID` has Base ETH for the Witness deposit and `/demo` top-ups
- [ ] The `CRE_SOLANA_PRIVATE_KEY` account has devnet SOL (it pays the forwarder write)
- [ ] `cre login` done; a dry run (no `--broadcast`) of each workflow passes
- [ ] `/demo` loads locally with `DEMO_LOCAL_CRE=1 npm run dev`, derives an address, and shows the CRE button
- [ ] The page's Chainlink / not-Chainlink labels show (section 2 table)
- [ ] frontier `pnpm verify` output captured for one fresh payout
- [ ] Explorer, Basescan and terminal tabs pre-opened, font size up
- [ ] **After any Signer segment: `npm run demo:cre -- resume-subscriber`**, then one RFQ trade that signs on its own (≈5 s)

**Dress rehearsal without Phantom** (proves both signers before recording; logged in `runs/cre-signer-devnet.md`):
```bash
npx next build && DEMO_LOCAL_CRE=1 npx next start -p 3200 &
MODE=subscriber npx tsx scripts/demo-rehearse.ts          # expect "Signed via SODA MPC subscriber", about 6 s
npm run demo:cre -- pause-subscriber
MODE=cre npx tsx scripts/demo-rehearse.ts                 # expect "Signed via Chainlink CRE → SODA MPC", about 15 s
npm run demo:cre -- resume-subscriber                     # ALWAYS run this
```

## 8. Fallback lines

| If… | Say / do |
|---|---|
| No quotes / "No solvers configured" | "Solvers are on Railway's private network." Check `/api/health` `solvers: 2`. Play the recorded trade. |
| Auction fills before the price ticks | "That's the expected path: we start at the best quote." See section 3. Show the premium run if recorded. |
| Drawer stuck at Committee signing (subscriber running) | Check the coordinator `/health`. As a last resort, `npm run demo:cre -- cre-sign <intent>`: "and this is exactly why CRE as a second trigger matters." |
| `NonceMoved` / B's fill rejected | "Two solvers raced; the program let exactly one win." `IntentNotOpen` is the run log's example. |
| CRE `simulate` slow or failing | Cut to the logged runs: `cre/runs/2026-10-07-broadcast-*.log`. |
| CRE `AlreadyFinalized` | The subscriber or the page fallback got there first. Pause the subscriber and retry with a new trade. |
| Witness "Only N confirmations" | Wait about 6 s (3 Base blocks) and rerun. |
| Phantom on mainnet / no SOL | Switch networks and use faucet.solana.com. Keep a second funded wallet ready. |
| Base payout slow | "Signed, not yet mined: the bot bumps gas after 30 s, at the same nonce." |

## 9. Booth flow (5 minutes, live)

1. The section 1 story, plus the section 2 table on a printed card (point at the Chainlink rows).
2. Auction trade on the live page (section 4), about 1 min.
3. RFQ trade, about 1 min.
4. `/demo`: derive your address from *their* Phantom, then send ETH (section 6), about 1.5 min.
5. If asked about Chainlink, run the Signer segment (section 5b) on `/demo` with the CRE button. **Resume the subscriber afterwards.**

Pausing the subscriber stops signing for **every** soda user, including frontier's live page. Keep pauses short (the logged one was 46 s) and always resume.
