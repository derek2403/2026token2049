# Handover: SODA Witness and SODA Intents

Written 2026-10-07 for the TOKEN2049 Origins hackathon (Oct 6–8, 2026). Read this before writing code in this repo.

This repo builds two things on top of **SODA**, an existing system that lives in a separate repo ([github.com/derek2403/frontier](https://github.com/derek2403/frontier), checked out at `~/Developer/frontier`). Judges assess only what is built here, so keep everything new in this repo and list SODA as prior work in the README.

| Build | Submitted to | What it is |
|---|---|---|
| **SODA Witness** | Chainlink CRE track, NOWNodes track | A CRE workflow reads a Base Sepolia transaction through NOWNodes, reaches consensus, and writes a signed report into a new Solana program. It closes SODA's missing inbound direction. |
| **SODA Intents** | Solana track | Users sell SOL on Solana and receive native ETH on Base. Solvers compete in an on-chain Dutch auction, one Solana transaction settles, and SODA signs the Base payout. Includes a swap page modeled on 1inch Fusion+. |

The pitch for both: users can already move assets between chains; they cannot move authority. SODA moves authority. A Solana account, wallet or program, controls a native address on another chain. The committee signs, Solana verifies, and the destination chain sees an ordinary transaction. Witness brings facts back. Intents is the product this makes possible.

---

## 1. What SODA already gives you

You do not build or change any of this. You call it.

### 1.1 How SODA works

1. A Solana account (the **requester**, a wallet or a PDA) calls `soda::request_signature` with a 32-byte payload (for EVM: `keccak256` of the unsigned RLP).
2. soda derives the requester's foreign public key on-chain and stores a `SigRequest` account. It emits `SigRequested`.
3. The `mpc-subscriber` service sees the event and asks the coordinator to sign. Two MPC nodes (P1, P2) run Lindell 2017 two-party ECDSA. Neither ever holds the key.
4. The subscriber submits `soda::finalize_signature`. soda runs `secp256k1_recover` and accepts only if the recovered key equals the stored foreign key. It emits `SigCompleted`.
5. The `relayer` service assembles the signed transaction and broadcasts it on the destination chain.

Address derivation, computed on-chain by `request_signature` and off-chain by the SDK:

```
tweak      = sha256("SODA-v1" || requester (32 bytes) || derivation_seeds || chain_tag (32 bytes))
foreign_pk = group_pk + tweak·G
eth_addr   = keccak256(foreign_pk uncompressed, without 0x04)[12..32]
```

`chain_tag` for every EVM chain is `"evm"` zero-padded to 32 bytes, so one requester has the same address on Base Sepolia and Ethereum Sepolia. EIP-155 chain ids stop cross-chain replay.

### 1.2 Live deployment (Solana devnet)

| Item | Value |
|---|---|
| soda program | `CPAEfBXpMMsUrjLNhDYxaCH79DYvFHJFC27fttnxAL1J` |
| eth_demo (reference only) | `9JMr3TNHk2Mh7TQsaoxkfDmLFE3naYcAwcsgkKv3BBXx` |
| vault_demo (reference only) | `2Cx2nBHzK38diq52pdLphnbfVzDUFZJBn3GpdjAQ18kE` |
| Committee PDA | `9mX3oHUmsrYvzXjCo35HhfXufrGZT3hjsLoC74xbA6SS` (seeds `["committee"]` under soda) |
| Committee `group_pk` | `039e4c1ac3a50367eefb5d05d1a18620037b20f2f52fc434bb7c7363081e21c5c5` |
| Committee authority | `D5pwjGzqvgvuFt4rtMVf1ta4RKXWyGGfG2ekh5KuDfZw` |
| Coordinator | `https://soda-mpc-coordinator-production.up.railway.app` (`GET /health` is open; `POST /sign` needs a Bearer token) |
| Railway project | `pagecontrol-signing`, environment `production`. Services: `soda-mpc-node-p1`, `soda-mpc-node-p2`, `soda-mpc-coordinator`, `soda-mpc-subscriber`, `soda-relayer`, `soda-web` |

**Do not use** soda `2YDHaX2f…` or eth_demo `GfAuUesz…`. They are older deployments that still exist on devnet. Parts of frontier's `CLAUDE.md` still name them, and also wrongly say `foreign_pk` is computed off-chain and that `/sign` takes `{payloadHex, tweakHex}`. Trust this document and the code over that file.

### 1.3 `request_signature`, exactly

Instruction discriminator: `19e1704a525eb91d`. Arguments, Borsh, in this order:

| Arg | Type | Rule |
|---|---|---|
| `derivation_seeds` | `Vec<u8>` | at most 64 bytes, else `SeedsTooLong` (6004) |
| `payload` | `[u8; 32]` | the digest to sign |
| `chain_tag` | `[u8; 32]` | `"evm"` zero-padded |
| `domain_id` | `u32` | must be `0`, else `UnsupportedDomain` (6009) |

Accounts, in this order:

| # | Name | Flags | Notes |
|---|---|---|---|
| 1 | `committee` | read | `9mX3oHUm…` |
| 2 | `sig_request` | writable | created by soda at seeds `["sig", requester, payload]` |
| 3 | `requester` | **signer**, read | owner of the foreign address; a PDA signs through `invoke_signed` |
| 4 | `payer` | signer, writable | pays rent |
| 5 | `system_program` | | |

The requester PDA needs no lamports; the payer pays. soda sets `expires_at = now + 300`.

### 1.4 `SigRequest` account and events

`SigRequest`: 347 bytes, discriminator `3617d2807be9f1e9`. Borsh fields after the discriminator:

```
bump u8 | requester Pubkey | committee Pubkey | foreign_pk_xy [u8;64] (X||Y, no 0x04)
| derivation_seeds Vec<u8> | payload [u8;32] | chain_tag [u8;32] | domain_id u32
| expires_at i64 | completed bool | signature [u8;64] (r||s) | recovery_id u8
```

Rent is 2,413,000 lamports (0.002413 SOL) per request. soda has no close instruction, so this is never refunded.

Events, emitted as `Program data: base64(discriminator || borsh)`:

| Event | Discriminator | Fields |
|---|---|---|
| `SigRequested` | `f241344e28e151b6` | `sig_request Pubkey, requester Pubkey, foreign_pk_xy [u8;64], payload [u8;32], chain_tag [u8;32], derivation_seeds Vec<u8>, domain_id u32` |
| `SigCompleted` | `94bd9d74adf0ca17` | `sig_request Pubkey, signature [u8;64], recovery_id u8` |
| `EthTxRequested` (eth_demo's; copy it) | `b19f579d04a22205` | `sig_request Pubkey, chain_id u64, unsigned_rlp Vec<u8>` |

soda error codes: 6000 `AlreadyCompleted`, 6001 `PubkeyMismatch`, 6002 `Expired` (unused), 6003 `InvalidRecoveryId`, 6004 `SeedsTooLong`, 6005 `InvalidGroupPk`, 6006 `InvalidTweak`, 6007 `DerivationFailed`, 6008 `RecoverFailed`, 6009 `UnsupportedDomain`.

### 1.5 What the services do with your program's requests

- **The subscriber signs every `SigRequested` from any program.** Your policy must live in your program, before the CPI. The MPC nodes only check that the request is a real soda account, not completed, under 300 s old, `domain_id == 0`, and that the stored foreign key derives from `SigRequest.requester`.
- **The relayer broadcasts only events named exactly `EthTxRequested`** with layout `(Pubkey, u64, Vec<u8>)`. It matches by discriminator, which Anchor computes from the event name alone, and it listens to soda's logs, which include any transaction that CPIs soda. So a new program that emits an event with that exact name and layout, in the same transaction as the CPI, gets broadcast for free.
- The relayer has **one** EVM RPC (`SEPOLIA_RPC_URL`, today pointed at Base Sepolia). It refuses events whose `chain_id` differs. Its cache is in memory and lost on restart.
- 300 s after `request_signature`, the committee will never sign that request. Expiry is enforced only off-chain by the nodes.

### 1.6 Reusing SODA code in this repo

| What | Where in frontier | How to use here |
|---|---|---|
| soda IDL | `apps/web/lib/idl/soda.json` | Copy to `idl/soda.json`. Check its `address` is `CPAEf…`. |
| RLP encoder (Rust) | `contracts/programs/eth_demo/src/eth_rlp.rs` | Copy into each program that builds EVM transactions. Credit it. |
| PDA-requester CPI | `contracts/programs/vault_demo/src/lib.rs:94-142` | Pattern to follow. |
| Derivation, RLP, EthRpc (TS) | `packages/soda-sdk/src/{derive,rlp,sepolia}.ts` and `EVM_CHAIN_TAG` from `chains.ts` | Copy into `lib/soda/`. `chains.ts` imports `./aave`, `./sui`, `./sui-ptb`; copy only the parts you need. |
| Audit tool | `apps/demo/src/verify.ts` | Run from frontier: `VERIFY_REQUESTER=<pool PDA> pnpm verify <base tx hash>` (needs `DEMO_CHAIN=base-sepolia`). |

**Do not install `@soda-sdk/core` from npm.** Version 0.1.0 is stale: no `EVM_CHAIN_TAG`, and the old tweak keying. TS runtime deps for the copied files are only `@noble/curves` and `@noble/hashes`, **pinned to v1**: `npm i @noble/curves@^1.6.0 @noble/hashes@^1.5.0`. The copied code uses the v1 API (`secp256k1.ProjectivePoint`, extensionless subpath imports); v2 breaks it.

**Do not depend on the soda crate.** Build the CPI by hand (§3.4). frontier's lockfile pins `solana-program` 2.3.0 under Anchor 0.32.1 with Rust 1.84 and resolver 2, and pulling the crate across repos invites version conflicts.

TS SDK signatures you will use:

```ts
computeTweak(owner: Uint8Array /*32B*/, path: Uint8Array, chainTag: Uint8Array /*32B*/): Uint8Array
deriveEthAddress(groupPkCompressed, owner, path, chainTag): { tweak, foreignPk, ethAddress }
encodeUnsignedLegacy(tx: LegacyTx): Uint8Array            // byte-identical to eth_rlp.rs
encodeSignedLegacy(base: Omit<LegacyTx,"chainId">, v: bigint, r: Uint8Array, s: Uint8Array): Uint8Array
eip155V(recoveryId: number, chainId: bigint): bigint      // recoveryId + 35 + 2*chainId
decodeUnsignedLegacy(rlp: Uint8Array): LegacyTx
new EthRpc(url)  // call, getBalance, getNonce("pending"), getGasPrice, sendRawTransaction, ethCall, estimateGas
type LegacyTx = { nonce: bigint; gasPriceWei: bigint; gasLimit: bigint; to: Uint8Array; valueWeiBe: Uint8Array; data: Uint8Array; chainId: bigint }
```

`EthRpc` sends no custom headers. For NOWNodes, either add an optional headers argument when you copy it, or use the key-in-path URL form.

---

## 2. Repo layout

This repo is a Next.js 16 app (App Router, React 19, Tailwind 4, npm). Add the rest beside it:

```
2026token2049/
  app/                          Next.js: the swap page and API routes (§5)
  lib/soda/                     copied TS from soda-sdk (derive, rlp, sepolia, tag constants)
  lib/intents/                  PDAs, account decoders, status machine, auction math (shared by app + solver)
  idl/                          soda.json (copied), intents.json, soda_witness.json (built)
  programs/                     Anchor workspace
    Anchor.toml  Cargo.toml  Cargo.lock
    programs/intents/           Solana track (§3)
    programs/soda_witness/      CRE receiver (§4)
  cre/                          CRE project (Bun)
    project.yaml  secrets.yaml  .env.example
    soda-witness/               the workflow (§4.3)
  services/solver/              AMM solver bot (§3.6), deployed to Railway
  scripts/                      verify-nownodes.ts, e2e scripts, judge script
  HANDOVER.md                   this file
  README.md                     prior work, program IDs, links, trust model
```

**Toolchain to match frontier:** Anchor 0.32.1, Solana CLI 3.1.10 (Anchor.toml `solana_version`), `rust-version = "1.84"`, edition 2021, workspace `resolver = "2"`. Commit `Cargo.lock`. Release profile `overflow-checks = true`. In `Anchor.toml`, add a real `[programs.devnet]` block and set `cluster = "devnet"`; frontier only has localnet entries, which has caused confusion.

**Devnet SOL:** `solana airdrop` no longer works. Use faucet.solana.com (sign in with GitHub for more). Keep about 2 SOL spare for `solana program extend`.

---

## 3. Build A: SODA Intents (Solana track)

### 3.1 What the user experiences

1. Connect Phantom. The page shows the user's own SODA-derived Base address as the default recipient.
2. Enter SOL to sell, pick a speed preset, and see "You receive ≈ X ETH" and "at least Y ETH".
3. Approve **one** Phantom transaction: `open_intent`. The SOL moves into escrow on Solana.
4. Solver bots watch the on-chain auction. The required output falls from the start amount to the minimum over the auction; the first solver whose price meets it fills.
5. The fill transaction pays the solver the escrowed SOL, debits the solver's Base balance, and asks SODA to sign the payout from the pool address.
6. The committee signs, Solana verifies, and ETH arrives at the recipient on Base. The page shows each step with measured times and explorer links.

There is no secret held by the browser, unlike Fusion+, so the user can close the tab.

### 3.2 Scope

**In:** SOL on Solana devnet to native ETH on Base Sepolia (chain 84532). On-chain Dutch auction. Solver ledger. Gas bump for stuck payouts. Solver withdrawals. The swap page. One or two solver bots.

**Out, and say so in the README:**
- ETH to SOL. Solana would need to learn that ETH arrived on Base; that is Witness, wired in as Phase 2 (§3.7).
- Automatic refund when a signed payout never lands on Base.
- Bitcoin, Sui, mainnet, solver bonds and slashing.
- Off-chain signed intents (gasless) are a stretch goal (§3.8).

**Why this direction needs no oracle:** the program already knows every payout it asks SODA to sign, so the user's SOL and an irrevocable Base payout signature change hands in one Solana transaction.

### 3.3 Program `intents`: accounts

Constants: `CHAIN_ID = 84532`, `EVM_CHAIN_TAG = "evm"` zero-padded to 32, `GAS_LIMIT = 21_000` (plain ETH transfer, empty calldata), `POOL_SEEDS_ARG = []` (the `derivation_seeds` passed to soda).

| Account | Seeds | Fields |
|---|---|---|
| `Config` | `["config"]` | `admin Pubkey`, `pool_bump u8`, `pool_evm_addr [u8;20]` (display only; derived off-chain at init with the SDK and checked in tests), `next_nonce u64`, `max_gas_price u64`, `l1_fee_buffer_wei u64`, `paused bool`, `witness_program Pubkey` (Phase 2), `min_gas_price u64` (floor for every signed payout) |
| `Pool` | `["pool"]` | **No data.** A PDA used only as the SODA requester through `invoke_signed`. It never needs lamports. Its derived Base address holds all solver inventory. |
| `Solver` | `["solver", authority]` | `authority Pubkey`, `payout_addr [u8;20]`, `deposit_from [u8;20]` (Phase 2), `balance_wei u128`, `fills u64`, `bump u8` |
| `Intent` | `["intent", user, intent_id_le]` | `user Pubkey`, `intent_id u64`, `in_lamports u64` (held as lamports in this account above rent), `recipient [u8;20]`, `start_out_wei u128`, `min_out_wei u128`, `auction_start i64`, `auction_duration u32`, `expires_at i64`, `status u8` (Open, Filled, Cancelled), `solver Pubkey`, `out_wei u128`, `base_nonce u64`, `gas_price u64`, `filled_at i64`, `sig_requests [Pubkey; 4]` (the original payout plus up to 3 gas bumps), `sig_request_count u8`, `bump u8` |
| `Withdrawal` | `["withdrawal", base_nonce_le]` | `solver Pubkey`, `payout_addr [u8;20]`, `amount_wei u128`, `base_nonce u64`, `gas_price u64`, `created_at i64`, `sig_requests [Pubkey; 4]`, `sig_request_count u8`, `bump u8`. Keeps a withdrawal payout re-signable, like an Intent does for a fill. |

`Config.admin`, `Solver.authority` and `Intent.user` all sit at offset 8, so any `getProgramAccounts` query must also filter on the account discriminator.

Required output at time `t`, the Fusion-style linear Dutch auction:

```
t <= auction_start                       → start_out_wei
t >= auction_start + auction_duration    → min_out_wei
otherwise  start_out_wei − (start_out_wei − min_out_wei) · (t − auction_start) / auction_duration
```

### 3.4 Program `intents`: instructions

| Instruction | Signer | Checks and effects |
|---|---|---|
| `init_config(pool_evm_addr, max_gas_price, l1_fee_buffer_wei, min_gas_price)` | admin | Creates `Config`. `0 < min_gas_price <= max_gas_price`. |
| `register_solver(payout_addr, deposit_from, deposit_sig)` | solver | `deposit_sig` is an EIP-191 personal_sign by `deposit_from` over `"intents register" ‖ program_id ‖ authority` (80 bytes), checked with `secp256k1_recover`; otherwise `DepositFromNotProven`. Creates `Solver` with zero balance. |
| `credit_solver(amount_wei, tx_hash)` | admin | Adds to a solver's balance after the admin checks its deposit `tx_hash` to `pool_evm_addr` on Basescan. Inits the same `Credit` PDA `["credit", tx_hash]` as Phase 2 (`claim` = default), so a deposit credits once by either path. Amount 0 only writes the marker. Ignores pause. **Trusted; disclosed.** |
| `open_intent(intent_id, in_lamports, recipient, start_out_wei, min_out_wei, auction_duration, expires_at)` | user | Not paused. `start_out_wei >= min_out_wei > 0`. `expires_at > now + auction_duration`. Transfers `in_lamports` into the `Intent` account. Sets `auction_start = now`. Emits `IntentOpened`. |
| `cancel_intent` | user | Status Open. Allowed any time before a fill, like Fusion's maker cancel. Moves the escrowed `in_lamports` back to the user and sets status Cancelled. The account stays so the page can show the refund; `close_intent` reclaims its rent. Emits `IntentCancelled`. |
| `close_intent` | user (Cancelled) or admin (Filled) | The user closes a Cancelled intent. A Filled intent holds the only state that can re-sign its payout, so only the admin closes it, once `now > filled_at + 600` and the payout is seen on Basescan. Either way the rent (about 0.0025 SOL) goes to the user. |
| `fill(expected_nonce, out_wei, gas_price)` | solver | Status Open, `now < expires_at`, `out_wei >= required_out(now)`, `min_gas_price <= gas_price <= max_gas_price`, `expected_nonce == config.next_nonce` (else `NonceMoved`, so a solver that lost a race fails with a named error before soda's seed check), and `balance_wei >= cost` where `cost = out_wei + gas_price·GAS_LIMIT + l1_fee_buffer_wei`. Then, all in this instruction: debit `cost` from the ledger; move `in_lamports` from the intent account to `solver_authority` (the signer's wallet; a direct lamport edit, allowed because the program owns the intent account and the intent stays rent-exempt); take `nonce = next_nonce++`; build the RLP; keccak it; CPI `request_signature` with the pool PDA as requester and the solver as payer; store `out_wei`, `base_nonce`, `gas_price`, `filled_at`, and `sig_requests[0]`; status Filled. Emit `EthTxRequested` and `IntentFilled`. |
| `bump_gas(new_gas_price)` | the filling solver, the admin, or anyone once `now > filled_at + 60` | Status Filled, a free slot (`sig_request_count < 4`, else see below), `new_gas_price >= gas_price · 110 / 100` (Base's mempool rejects a same-nonce replacement under a 10% bump) and within `[min_gas_price, max_gas_price]`. When all 4 slots are taken, the caller passes SigRequests as remaining accounts: anyone may reuse the slot of one that is unsigned and more than 60 s past its `expires_at` (it can never land); the admin may reuse any slot. Re-signs the **same** payout at the **same** `base_nonce`: new RLP, new payload, so a new `SigRequest`. Debits the extra gas from the **filling** solver's ledger, whoever calls. Appends to `sig_requests`. Emits `EthTxRequested` and `GasBumped`. Only one transaction per nonce can land, so this is safe without reading Base. Letting anyone bump after 60 s means one offline solver cannot block every later payout from the shared pool address. |
| `solver_withdraw(expected_nonce, amount_wei, gas_price)` | solver | `amount_wei > 0`, gas within `[min_gas_price, max_gas_price]`, `expected_nonce == next_nonce`. Debits `amount_wei + gas_price·GAS_LIMIT + l1_fee_buffer_wei` (the withdrawal's gas also comes out of the pool), takes `next_nonce++`, signs a transfer from the pool to `payout_addr`, and creates the `Withdrawal` at that nonce (solver pays rent). Emits `EthTxRequested` and `SolverWithdrew`. |
| `bump_withdrawal_gas(new_gas_price)` | the withdrawing solver, the admin, or anyone once `now > created_at + 60` | `bump_gas` for a `Withdrawal`, with the same price and slot rules; the withdrawing solver's ledger pays. Emits `EthTxRequested` and `WithdrawalGasBumped`. Without it, one unlanded withdrawal would block the pool's nonce queue for good. |
| `set_paused`, `set_max_gas_price`, `set_min_gas_price` | admin | Raising `max_gas_price` is the escape hatch when a payout is stuck at the cap; raising `min_gas_price` keeps new payouts above Base's basefee. Both keep `0 < min <= max`. |

Errors to define: `Paused`, `IntentNotOpen`, `IntentExpired`, `BelowRequiredOut`, `GasPriceTooHigh`, `InsufficientSolverBalance`, `NonceMoved`, `NotFillingSolver`, `BumpTooSmall`, `TooManyBumps`, `BadAuctionParams`, `NotClosable`, `MathOverflow`, `GasPriceTooLow`, `ZeroAmount`, `BadGasConfig`.

**Building the payout** (copy `encode_unsigned_legacy` from frontier's `eth_rlp.rs`; keep calldata empty, since that encoder silently corrupts calldata over 255 bytes in release builds):

```rust
use solana_program::keccak;   // needs a direct dependency, see below

let unsigned_rlp = eth_rlp::encode_unsigned_legacy(
    nonce, gas_price, GAS_LIMIT, &intent.recipient, &out_wei.to_be_bytes(), &[], CHAIN_ID);
let payload = keccak::hashv(&[&unsigned_rlp]).to_bytes();
```

`anchor_lang::solana_program` has no `keccak` module in Anchor 0.32.1. Add `solana-program = "2.1.14"` (it resolves to 2.3.0, as in frontier's lock) to the program's `Cargo.toml`, the same way vault_demo does.

**The CPI, hand-built** (no soda crate):

```rust
use anchor_lang::solana_program::{instruction::Instruction, program::invoke_signed};

const REQUEST_SIGNATURE_DISC: [u8; 8] = [0x19, 0xe1, 0x70, 0x4a, 0x52, 0x5e, 0xb9, 0x1d];

let mut data = REQUEST_SIGNATURE_DISC.to_vec();
(Vec::<u8>::new()).serialize(&mut data)?;      // derivation_seeds: empty
data.extend_from_slice(&payload);              // [u8;32]
data.extend_from_slice(&EVM_CHAIN_TAG);        // [u8;32]
data.extend_from_slice(&0u32.to_le_bytes());   // domain_id

let ix = Instruction {
    program_id: SODA_PROGRAM_ID,
    accounts: vec![
        AccountMeta::new_readonly(committee.key(), false),
        AccountMeta::new(sig_request.key(), false),
        AccountMeta::new_readonly(pool.key(), true),     // requester, signs via seeds
        AccountMeta::new(solver_authority.key(), true),  // payer
        AccountMeta::new_readonly(system_program::ID, false),
    ],
    data,
};
let bump = [ctx.accounts.config.pool_bump];
let pool_seeds: &[&[u8]] = &[b"pool", &bump];
invoke_signed(&ix, &[
    ctx.accounts.committee.to_account_info(),
    ctx.accounts.sig_request.to_account_info(),
    ctx.accounts.pool.to_account_info(),
    ctx.accounts.solver_authority.to_account_info(),
    ctx.accounts.system_program.to_account_info(),
    ctx.accounts.soda_program.to_account_info(),
], &[pool_seeds])?;
```

Accounts for `fill`: `solver_authority` (signer, mut), `solver` (mut), `config` (mut), `intent` (mut), `committee` (address = `9mX3oHUm…`), `sig_request` (mut, unchecked; soda creates it at `["sig", pool, payload]` under soda), `pool` (unchecked PDA), `soda_program` (address = `CPAEf…`), `system_program`. The client derives `sig_request` from the payload it computes off-chain with the same RLP. Set a compute budget of about 300k CU, since soda runs sha256 plus one `secp256k1_recover`.

**Events:** define `EthTxRequested { sig_request: Pubkey, chain_id: u64, unsigned_rlp: Vec<u8> }` with exactly that name and field order so frontier's relayer broadcasts it. Also `IntentOpened`, `IntentFilled`, `IntentCancelled`, `GasBumped`, `SolverCredited`, `SolverWithdrew`.

**Base nonce ordering.** Every payout comes from one pool address, so nonces must land in order, and a stuck payout blocks all later ones. The solver bot rebroadcasts signed payouts (fills and withdrawals) until mined and calls `bump_gas` / `bump_withdrawal_gas` after 30 seconds; anyone may bump after 60. Every nonce therefore keeps an on-chain record that can re-sign it (`Intent` or `Withdrawal`), the user cannot delete a Filled intent's record, and full bump slots can be reused, so no nonce is left with no way to land.

**Recipients must be plain addresses.** `GAS_LIMIT` is 21,000, so a payout to a contract with a non-trivial receive function runs out of gas and reverts after the user's SOL has gone to the solver. The page and its API reject any recipient where `eth_getCode` is not `0x`.

**Tests:**
- Pool address parity with `deriveEthAddress(group_pk, poolPda, [], EVM_CHAIN_TAG)`.
- RLP parity with `encodeUnsignedLegacy`.
- `required_out` at start, middle and end.
- `fill` rejects below required, after expiry, over max gas price and over balance. Double fill fails. `cancel_intent` refunds escrow plus rent.
- Verify early on devnet that an uninitialised PDA can act as soda's `requester` signer. vault_demo used an initialised account. If it fails, create a tiny `Pool` account at init.

### 3.5 Base payout tracking (shared by bot and page)

Once a `SigRequest` is `completed`, anyone can compute its Base transaction hash without waiting for the relayer:

1. Rebuild the unsigned transaction from the intent fields and that request's gas price (or `decodeUnsignedLegacy` the `unsigned_rlp` from its `EthTxRequested`).
2. `v = eip155V(recovery_id, 84532n)`, `r = signature[0..32]`, `s = signature[32..64]`.
3. `signed = encodeSignedLegacy(base, v, r, s)`; tx hash = `keccak256(signed)`.

Do this for **every** entry in `Intent.sig_requests`, not just the newest: after a gas bump, either transaction can be the one mined. The payout is delivered when any candidate hash has a receipt. Rebroadcast each completed candidate with `eth_sendRawTransaction`; "already known" means keep waiting. "Nonce too low" means some transaction used the nonce, so look up the receipts of the candidates; never treat it alone as delivered.

Put this in `lib/intents/payout.ts` and use it in both the bot and the page's server route.

### 3.6 Solver bot (`services/solver/`, TypeScript)

1. **Watch.** `onLogs` on the intents program for `IntentOpened`, with `getProgramAccounts` polling (Intent discriminator plus status Open) as a fallback. Subscribe over `wss://api.devnet.solana.com`, because Alchemy's free tier has no `logsSubscribe`. Send HTTP reads and transactions through a keyed devnet RPC (Helius or Alchemy): the public endpoint returned 429 on two back-to-back calls during research.
2. **Price.** Constant-product curve over virtual reserves of its own inventory, re-anchored every minute to Pyth devnet SOL/USD `7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE` and ETH/USD `42amVS4KgzR9rA28tkVYqVXjq9Qa8dcZQMbH5EYFX6XC` (shard 0, checked live 2026-10-07; devnet updates slowly, so allow a large max age). Subtract `SPREAD_BPS` and the Base gas plus L1 buffer.
3. **Fill.** Each tick, compute `required_out` for each open intent using the **cluster's** time (read the Clock sysvar), minus 5 seconds, so the amount is never below what the program computes when the transaction lands. Fill when `my_max_out >= required_out` and balance covers it. Read `Config.next_nonce`, build the payout RLP off-chain to derive the `sig_request` address, and send `fill(expected_nonce, out_wei = required_out, gas_price)` with a compute budget instruction. On `NonceMoved`, re-read and retry.
4. **Quote.** Serve `GET /quote?inLamports=` → `{ solver, outWei, minOutWei, validUntil }` for the page.
5. **Deliver.** On `SigCompleted` for its fills, assemble and broadcast through NOWNodes (§3.5), independent of frontier's relayer. Rebroadcast until mined. Call `bump_gas` (at least +10%) after 30 s unmined. Also watch other solvers' fills and every pending `Withdrawal` (read by PDA for nonces from the pool's mined count up to `next_nonce`), and bump any that stay unmined for 60 s, since a stuck nonce blocks everyone. Do not fill while Base's `eth_gasPrice` is above `max_gas_price`, while the price anchor is stale, or while the recipient check cannot run.
6. **Competition.** Run two instances with different `SPREAD_BPS` so the demo shows two solvers racing.

Deploy both instances as Railway services so a judge never starts them.

| Env var | Purpose |
|---|---|
| `SOLANA_RPC_URL` | keyed devnet HTTP RPC (Helius or Alchemy) |
| `SOLANA_WS_URL` | `wss://api.devnet.solana.com` |
| `SOLVER_KEYPAIR_JSON` | solver authority keypair as a JSON array |
| `INTENTS_PROGRAM_ID` | |
| `BASE_RPC_URL` | `https://base-sepolia.nownodes.io` |
| `NOWNODES_API_KEY` | sent as the `api-key` header |
| `SPREAD_BPS` | e.g. 30 and 60 for the two bots |
| `PORT` | quote endpoint |

### 3.7 Phase 2: trustless solver deposits (links both builds)

`credit_solver_from_claim(tx_hash)` credits a deposit from a witness claim; `credit_solver` stays as the admin fallback.
- Accounts: `payer` (signer; pays the Credit rent), `admin` (optional signer), `config`, `solver` (mut), `claim` (a `soda_witness` `Claim`, §4.2), `witness_config` (the soda_witness `Config` PDA, owner `config.witness_program`), `credit` (init), `system_program`.
- Admin gate: unless `witness_config` shows `forwarder_program == CXsKEJc…` (production) and a non-zero `workflow_owner`, `config.admin` must co-sign (`UntrustedWitness`). On devnet today (mock forwarder) every claim credit needs the admin; it becomes permissionless after the `set_config` switch in §4.
- The program parses the claim itself: owner is `config.witness_program`, discriminator `sha256("account:Claim")[..8]`, then status Recorded with `success`, `chain_id == 84532`, `to == pool_evm_addr`, `from == solver.deposit_from`, `claim.requester == solver.authority`, `value_wei > 0`, and `claim.tx_hash == tx_hash`. It does not trust the claim's own expectations. Refused while paused.
- A `Credit` PDA at `["credit", tx_hash]` makes each deposit credit once. It is keyed by the deposit rather than the claim: claims are per requester, so two solvers sharing a `deposit_from` could otherwise each credit the same deposit.
- Adds `claim.value_wei` to the solver's balance and emits `SolverCreditedFromClaim`.
- The claim must be opened with the solver's own key (`witness-cli open-claim <tx> --solver-key`). Then run the CRE workflow, then `intents-cli credit-from-claim --claim <pda>`.
- Both credit paths init the same `Credit`, so one deposit can never be credited twice, in either order.
- Trust: under `cre workflow simulate` the claim is written through the mock forwarder, which checks no DON signatures and can be called by anyone. Without the admin gate, anyone could register a solver, forge a Recorded claim for any value, credit it and `solver_withdraw` the pool's Base ETH ahead of honest solvers. The admin co-signature is what stops that; pausing only reacts after the fact.
- `deposit_from` must be proven in `register_solver` (signature above), so nobody can register another solver's Base wallet, claim its deposits and withdraw them. Solvers A and B (registered before the proof) share `0x3177…`, which one operator controls.
- Upgrade rollout (the devnet program predates all three checks): `set-paused true`; `solana program extend BV9K… 33000` (the new `.so` is 447,296 bytes, the live ProgramData holds 414,344), then upgrade; backfill markers for the two admin-credited deposits, `credit-solver --solver D5pw… --wei 0 --tx-hash 0xb9d12a5a…2757d7` and `credit-solver --solver Cozg… --wei 0 --tx-hash 0xaa9bf7dc…62623d`; `set-paused false`. Until the backfill the CLI refuses those two hashes.

Now SODA signs authority out and Witness brings the deposit fact in: no admin step. This is also the start of the ETH to SOL direction.

### 3.8 Stretch: off-chain signed intents

Users deposit once, then sign intents in Phantom with no transaction each time. The fill carries an Ed25519 program instruction (`Ed25519SigVerify111111111111111111111111111`), and `fill` reads it from the instructions sysvar. Check `num_signatures == 1` and that all three instruction indices equal `u16::MAX` (the known bypass; see the [Asymmetric Research write-up](https://blog.asymmetric.re/wrong-offset-bypassing-signature-verification-in-relay/) and [anza's reference](https://github.com/anza-xyz/solana-sdk/blob/c654e5f556ad3e22679fe9757da1bf5c9486e2f1/ed25519-program/src/lib.rs#L79)). Test first that Phantom's `signMessage` signs the raw bytes with no prefix.

---

## 4. Build B: SODA Witness (Chainlink CRE and NOWNodes tracks)

### 4.1 What it does

1. Anyone calls `soda_witness::open_claim(chain_id, tx_hash)`. It creates a `Claim` PDA in Pending state, keyed on the caller, who pays. **Accounts cannot be created inside `on_report`**, because no payer reaches the receiver.
2. The client submits `{ claim, txHash }` to the workflow. In simulation that is `cre workflow simulate … --http-payload <json>` (or `--listen`, which serves on local port 2000). A deployed workflow is triggered by POSTing `workflows.execute` to the CRE gateway with a JWT signed by an EVM key listed in `trigger({ authorizedKeys: [{ type: "KEY_TYPE_ECDSA_EVM", publicKey }] })`, at most once per 30 s; `trigger({})` works only in simulation.
3. The workflow reads the transaction from Base Sepolia through NOWNodes, and the DON agrees on the result.
4. CRE writes a report through Chainlink's Keystone forwarder into `soda_witness::on_report`, which checks the forwarder and records the facts: from, to, value, block and success. Consumers such as Intents (§3.7) judge the facts themselves.

The demo story: SODA makes a Base address act (an existing Aave deposit, or an Intents payout), then Witness proves to Solana that it landed.

### 4.2 Program `soda_witness`

| Account | Seeds | Fields |
|---|---|---|
| `Config` | `["config"]` | `admin`, `forwarder_program Pubkey`, `forwarder_state Pubkey`, `workflow_owner [u8;20]`, `workflow_name [u8;10]` (zeros = skip), `bump` |
| `Claim` | `["claim", requester, chain_id_le, tx_hash]` | `requester`, `chain_id u64`, `tx_hash [u8;32]`, `status u8` (Pending, Recorded), `from [u8;20]`, `to [u8;20]`, `value_wei u128`, `block u64`, `success bool`, `recorded_at i64`, `bump` |

Keying the claim on its requester means nobody can open someone else's claim and poison it with wrong expectations.

| Instruction | Signer | Checks |
|---|---|---|
| `init_config` / `set_config` | admin | Set the forwarder pair and workflow owner. Switch between mock and production with `set_config`. |
| `open_claim(chain_id, tx_hash)` | anyone (pays) | Creates the caller's claim, Pending. Emits `ClaimOpened`. |
| `on_report(metadata: Vec<u8>, report: Vec<u8>)` | `forwarder_authority` | See below. |

`on_report` is called by the forwarder with discriminator `[214,173,18,221,173,148,151,208]` (= `sha256("global:on_report")[..8]`; an Anchor instruction named `on_report` produces it automatically). Accounts, in order: `state` (UncheckedAccount, the forwarder state), `forwarder_authority` (Signer), then yours: `config` (read), `claim` (writable). Checks:

1. `*state.owner == config.forwarder_program` and `state.key() == config.forwarder_state`.
2. `forwarder_authority.key() == find_program_address(&[b"forwarder", state.key().as_ref(), crate::ID.as_ref()], &config.forwarder_program).0`.
3. `metadata.len() == 64`. `msg!` the metadata first. Then, unless `config.workflow_owner` is all zeros (skip; used for the first simulation run), require `metadata[42..62] == config.workflow_owner`. Metadata layout: `workflow_cid[0..32] | workflow_name[32..42] | workflow_owner[42..62] | report_id[62..64]`.
4. Decode the report. `claim.status == Pending`, `report.chain_id == claim.chain_id`, `report.tx_hash == claim.tx_hash`.
5. Store all fields, set `success = (report.status == 1)` and status Recorded. A replayed report fails because the claim is no longer Pending.

Report, Borsh, 106 bytes (the payload budget is about 200 bytes with two receiver accounts):

```rust
pub struct WitnessReport { ver: u8, chain_id: u64, tx_hash: [u8;32], from: [u8;20], to: [u8;20], value_wei: u128, block: u64, status: u8 }
```

Add `#[event] pub struct WitnessRecorded { pub report: WitnessReport }`. Anchor only puts a struct in the IDL's `types` when something references it, and without it `cre generate-bindings` will not generate `writeReportFromWitnessReport`.

The workflow owner that simulation writes into metadata is not documented; it is probably the address of `CRE_ETH_PRIVATE_KEY`. On the first `--broadcast`, `msg!` the metadata, then `set_config`.

| Forwarder | Program | State |
|---|---|---|
| Mock, devnet (all simulations) | `7kuEAA3mSC1Tz8gQjnvH7bKFda9xSPRRin9SZbH49cNK` | `5Tipz3yhTBdVsDbaBxZkrp7Gjf3brGq5SKkxReefPMP7` |
| Production, devnet (deployed workflows) | `CXsKEJcs25TQEYU2e5jZ8QTPE3ffMLZhH6BWHrdcCCB5` | `8QoomCQyPSkJ8WopJbX9B4HyvrFzziwvJdU8hZE6DCr9` |

`cre workflow simulate` always writes through the mock forwarder, whatever the config says. The mock checks **no** DON signatures and has no replay protection. Production checks f+1 secp256k1 signatures from the DON. Say this plainly in the README.

### 4.3 CRE workflow `cre/soda-witness/`

**Setup:**

```bash
curl -sSL https://app.chain.link/cre/install.sh | bash
cre version           # need >= 1.29 for TS Solana bindings; 1.37.0 is current
cre login             # required even to simulate
cre account access    # request DON deploy access on day one; approval timing is unknown
cre templates list    # find the building-blocks/solana-read-write template id
```

TypeScript workflows need **Bun**. Start from `github.com/smartcontractkit/cre-templates/tree/main/building-blocks/solana-read-write/solana-read-write-ts`. `@chainlink/cre-sdk` is at 1.23.0 (the template pins 1.17.0).

**Files:**

```yaml
# cre/project.yaml
simulation-settings:
  rpcs:
    - chain-name: solana-devnet
      url: https://api.devnet.solana.com
production-settings:
  rpcs:
    - chain-name: solana-devnet
      url: https://api.devnet.solana.com
```

```yaml
# cre/secrets.yaml
secretsNames:
  NOWNODES_API_KEY:
    - NOWNODES_API_KEY_ALL
```

```yaml
# cre/soda-witness/workflow.yaml
simulation-settings:
  user-workflow: { workflow-name: "soda-witness", deployment-registry: "private" }
  workflow-artifacts: { workflow-path: "./main.ts", config-path: "./config.simulation.json", secrets-path: "../secrets.yaml" }
production-settings:
  user-workflow: { workflow-name: "soda-witness", deployment-registry: "private" }
  workflow-artifacts: { workflow-path: "./main.ts", config-path: "./config.production.json", secrets-path: "../secrets.yaml" }
```

```json
{ "chainSelector": "16423721717087811551",
  "receiverProgramId": "<soda_witness program id>",
  "forwarderProgramId": "7kuEAA3mSC1Tz8gQjnvH7bKFda9xSPRRin9SZbH49cNK",
  "forwarderState": "5Tipz3yhTBdVsDbaBxZkrp7Gjf3brGq5SKkxReefPMP7",
  "witnessConfig": "<soda_witness Config PDA>",
  "nownodesUrl": "https://base-sepolia.nownodes.io",
  "chainId": 84532, "minConfirmations": 3 }
```

```
# cre/.env (gitignored)
CRE_SOLANA_PRIVATE_KEY=<64-byte base58 keypair, funded on devnet>   # pays the write; required even for dry runs
CRE_ETH_PRIVATE_KEY=0x<any valid key>                               # required even for Solana-only workflows
NOWNODES_API_KEY_ALL=<key>
```

**Handler logic.** Only one HTTP trigger is allowed per workflow; branch on a `kind` field if you add more.

1. `decodeJson(payload.input)` → `{ claim, txHash }`.
2. `const key = runtime.getSecret({ id: "NOWNODES_API_KEY" }).result().value`.
3. Three NOWNodes JSON-RPC calls with `httpClient.sendRequest(runtime, fn, aggregation)(...).result()`. Each uses `multiHeaders: { "api-key": { values: [key] }, "content-type": { values: ["application/json"] } }`, a base64 body, `timeout: "8s"` and `cacheSettings: { store: true, maxAge: "60s" }` (the field names in `@chainlink/cre-sdk` 1.23.0; the docs' `readFromCache`/`maxAgeMs` are stale and are rejected):
   - `eth_getTransactionReceipt` → identical aggregation on `{ status, blockNumber, from, to }` (lowercase hex).
   - `eth_getTransactionByHash` → identical on `{ value, chainId }`.
   - `eth_blockNumber` → `consensusMedianAggregation<bigint>()`.
4. `confirmations = head − block` outside node mode; require `>= minConfirmations`. Never pass "latest"-dependent values through identical aggregation.
5. Build `WitnessReport`. `remainingAccounts = [forwarderState (ro), forwarderAuthority (ro), witnessConfig (ro), claim (writable)]`. The forwarder authority is `PublicKey.findProgramAddressSync([Buffer.from("forwarder"), state.toBytes(), receiver.toBytes()], forwarderProgram)`.
6. `new SodaWitness(new SolanaClient(BigInt(cfg.chainSelector)), cfg.receiverProgramId).writeReportFromWitnessReport(runtime, report, remainingAccounts, { computeLimit: 200_000 })`. A `computeLimit` is mandatory in simulation. Throw unless `txStatus === 2`, and log the base58 Solana signature.

After each `anchor build`, copy `programs/target/idl/soda_witness.json` to `cre/soda-witness/contracts/solana/src/idl/soda_witness.json`, then run `cre generate-bindings solana` from `cre/soda-witness/`.

**WASM runtime rules:** use `runtime.now()`, never `Date.now()`. `crypto.subtle` is unavailable, so `@solana/addresses`' PDA helper throws; use `@solana/web3.js` `PublicKey.findProgramAddressSync`. No elliptic-curve maths in the workflow. Quotas: 15 HTTP calls, 5 secret fetches, 5 minutes per execution; HTTP trigger at most once per 30 s.

**Prove it:**

```bash
cd cre
cre workflow simulate soda-witness --target simulation-settings --non-interactive --trigger-index 0 \
  --http-payload ./payloads/claim.json                 # dry run
cre workflow simulate soda-witness --target simulation-settings --non-interactive --trigger-index 0 \
  --http-payload ./payloads/claim.json --broadcast     # real devnet transaction via the mock forwarder
```

Commit the `--broadcast` log under `cre/runs/` and link the Solana Explorer transaction in the README. If deploy access arrives: `cre workflow deploy soda-witness --target production-settings`, then `set_config` to the production forwarder.

Errors you may hit: `Custom:6002` wrong account list or forwarder pair (`InvalidAccountHash`); `MismatchedForwarderProgram` when a receiver configured for production is hit by a simulation.

### 4.4 NOWNodes

| Use | Endpoint | Methods |
|---|---|---|
| Witness reads (CRE) | `https://base-sepolia.nownodes.io`, `api-key` header from CRE secrets | `eth_blockNumber`, `eth_getTransactionByHash`, `eth_getTransactionReceipt` |
| Solver delivery and page receipts | same, from server code only | `eth_sendRawTransaction`, `eth_getTransactionReceipt`, `eth_getTransactionCount`, `eth_gasPrice` |
| Optional: committee broadcast (frontier's Railway relayer) | point its `SEPOLIA_RPC_URL` at `https://base-sepolia.nownodes.io/<KEY>` only after hour 0 confirms the path form works on `base-sepolia`. It changes prior work, so it does not count toward this repo's NOWNodes usage, and a bad URL silently stops the live site's broadcasts. | `eth_sendRawTransaction` |
| Fallback chain | `https://eth-sepolia.nownodes.io` (documented), chain 11155111 | same |
| Usage proof | `scripts/verify-nownodes.ts` | one call per endpoint used |

Facts and limits:
- **No Solana devnet and no Sui testnet on NOWNodes.** All Solana traffic stays on `api.devnet.solana.com`. Say so in the README.
- `base-sepolia` exists but is not in NOWNodes' docs; another team was told it is enabled for hackathon keys. Confirm with your key at hour 0.
- Free plan: 100,000 requests a month, one key, no WebSocket. A deployed CRE workflow calls NOWNodes from every DON node unless the cache hits.
- Missing key returns `422 Missing API_key`.
- The starter kit's `npm run verify:nownodes` checks Solana mainnet, BTC mainnet and Cardano, and fails with a testnet-only key. Fork it into `scripts/verify-nownodes.ts` (credit it) and check `base-sepolia eth_chainId == 0x14a34`, `eth-sepolia == 0xaa36a7`, and `btcbook-testnet4 /api/status`.
- Never send the key to the browser. The page calls Next.js API routes, which call NOWNodes.

---

## 5. Build C: the swap page (modeled on 1inch Fusion+)

### 5.1 What to copy from Fusion+, and what to beat

From 1inch's help center, blog and `cross-chain-sdk` source ([help: Fusion+](https://help.1inch.com/en/articles/9842591-what-is-1inch-fusion-and-how-does-it-work), [help: Solana to EVM](https://help.1inch.com/en/articles/12034805-what-is-the-solana-to-evm-cross-chain-swap-and-how-does-it-work), [SDK order types](https://raw.githubusercontent.com/1inch/cross-chain-sdk/master/src/api/orders/types.ts)):

- **Documented by 1inch, copy:** a token and chain selector for each side; a destination address prefilled when known and required otherwise; a quote showing rate, costs and the minimum you will receive; gas covered by the resolver and priced into the rate; a Pending order with progress; Cancel in history.
- **Inferred, confirm with screenshots before copying:** the exact "You pay" / "You receive" card labels, whether Fusion+ shows the Fast / Fair / Auction preset picker (documented only for single-chain Fusion), a per-step stepper with explorer links, the button labels, and the expired-order copy. In SODA an expired intent needs the user to send `cancel_intent`, so do not call it free.
- **Beat:** Fusion+ shows "DO NOT CLOSE THE TAB" because the browser must reveal a secret. SODA has no user secret. Show **"Safe to close this tab. Track it in Activity."**
- **Note:** 1inch's own Solana to EVM flow is also one on-chain Solana transaction that creates an escrow, the same shape as `open_intent`.

The 1inch app could not be rendered during research, so layout details are reconstructed from text. Before polishing, do one real Solana to Base swap on app.1inch.io and screenshot each screen.

### 5.2 Swap form (`app/page.tsx`)

| Element | Content |
|---|---|
| You pay | SOL amount, USD value, balance, Max. Chain badge "Solana". Keep the user's SOL for fees and rent (about 0.003 SOL) out of Max. |
| You receive | "≈ X ETH" from the best live quote (`start_out_wei`), USD value. Chain badge "Base". |
| Recipient | Prefilled with the user's own SODA-derived Base address (`deriveEthAddress(group_pk, wallet, [], EVM_CHAIN_TAG)`), labelled "Your Base address (owned by this Phantom wallet)". Editable, with checksum validation. |
| Speed preset | Fast, Fair, Auction. SODA's own durations, short because Solana is fast: Fast 30 s, Fair 60 s, Auction 120 s. `expires_at = now + duration + 60 s`. |
| Quote details (expandable) | Rate "1 SOL = X ETH"; "You receive at least" `min_out_wei`; auction start and end amounts; "Base gas: Free (paid by solver)"; "Solana fee + account rent ≈ 0.0025 SOL (returned when you close the intent)"; route "Solver → SODA committee → Base". |
| Benefits line | "No bridge · No wrapped tokens · Native ETH on Base · Settled on Solana" |
| Primary button | Connect wallet → Enter amount → Insufficient SOL → Open intent → (opens the order drawer) |

Quote source: `GET /api/quotes?inLamports=` fans out to `SOLVER_URLS` and returns the best `outWei`. `start_out_wei` = best quote; `min_out_wei` = best quote × (1 − preset tolerance), e.g. Fast 0.5%, Fair 1%, Auction 2%.

### 5.3 Order drawer and status machine

Status enum, mirroring Fusion+'s shape:

```
open → matched → signing → signed → broadcast → completed
side paths: expired → cancelled (refunded); bump_gas is a sub-state of broadcast
```

| Status | Source of truth | Shown as | Fusion+ equivalent |
|---|---|---|---|
| `open` | `Intent.status == Open` | "SOL locked in escrow. Finding a solver…" with the current required amount and a countdown to auction end | `pending` (auction) |
| `matched` | `IntentFilled` / `Intent.status == Filled` | "Solver matched: delivering X ETH" + Solana Explorer link to `fill` | resolver fills, escrows created |
| `signing` | `SigRequest` exists, not completed | "Committee signing the Base payout" | `dst_escrow_created` |
| `signed` | `SigRequest.completed` | "Signature verified on Solana (secp256k1_recover)" + "Safe to close this tab" | secret submitted (user's job in Fusion+, nobody's here) |
| `broadcast` | Base tx hash computed (§3.5), not yet mined | "ETH sent on Base" + Basescan link; after 30 s "Speeding up" when the bot bumps gas | `withdrawn` on destination |
| `completed` | Base receipt status 1 | "Received X ETH (+Y above minimum)" | `executed` + `positiveSurplus` |
| `expired` | `now > expires_at`, still Open | "No solver filled in time. Cancel to get your SOL back." | `expired` |
| `cancelled` | `Intent.status == Cancelled` | "SOL refunded" + Explorer link, then "Close to reclaim rent" | `refunded` |

Each step stores `{ txHash, chain, timestamp }` and shows the measured time from the previous step. Show Solana steps in milliseconds. Alpenglow is live on devnet, but quote only the numbers you measure.

Show a toast on submit, on Base arrival (with amount and Basescan link), and on expiry (with a Cancel action).

### 5.4 Activity panel

List the user's intents with `getProgramAccounts(intents)` filtered on the Intent discriminator (`sha256("account:Intent")[..8]` at offset 0) **and** the user at offset 8. Closed intents disappear from this query; show them from `IntentOpened` / `IntentCancelled` logs if you want full history. Columns: time, "SOL → ETH", amounts, status pill, Explorer and Basescan links. Open intents get Cancel. This replaces 1inch's `order/maker/{address}` history.

### 5.5 Stack and API routes

- Wallet: `@solana/wallet-adapter-react` with Phantom, or `@solana/kit` with wallet-standard. Phantom's devnet token display is unreliable, so never rely on the wallet showing balances.
- Program client: `@coral-xyz/anchor` 0.32 with `idl/intents.json`.
- Shared logic from `lib/intents/` and `lib/soda/`.

| Route | Does |
|---|---|
| `GET /api/quotes?inLamports=` | Fans out to solver quote endpoints, returns the best |
| `GET /api/payout?intent=` | Reads the intent and its `SigRequest`, computes the Base tx hash (§3.5), fetches the receipt from NOWNodes, returns the status |
| `GET /api/group-pk` | Reads the soda Committee account and returns `group_pk`, so the page derives addresses from the live key |

| Env var (Next.js) | Purpose |
|---|---|
| `NEXT_PUBLIC_SOLANA_RPC_URL` | keyed devnet HTTP RPC (the public endpoint rate-limits) |
| `NEXT_PUBLIC_SOLANA_WS_URL` | `wss://api.devnet.solana.com` |
| `NEXT_PUBLIC_INTENTS_PROGRAM_ID` | |
| `NEXT_PUBLIC_SODA_PROGRAM_ID` | `CPAEfBXpMMsUrjLNhDYxaCH79DYvFHJFC27fttnxAL1J` |
| `NOWNODES_API_KEY` | server only |
| `BASE_RPC_URL` | `https://base-sepolia.nownodes.io` |
| `SOLVER_URLS` | comma-separated solver quote endpoints |

---

## 6. Plan

About 20 hours, two people. Person A: Rust and Solana. Person B: TypeScript and CRE.

| Hours | Person A | Person B |
|---|---|---|
| 0–1 | Hour-0 checks (§7). Scaffold the Anchor workspace. | Hour-0 checks. `cre login`, `cre account access`, run the template with `--broadcast`. |
| 1–7 | `intents`: config, solver, `open_intent`, `fill` with the CPI, events. Unit tests. | Solver bot: watcher, pricing, fill, delivery via NOWNodes. |
| 7–10 | Deploy to devnet. End-to-end with B: one real Base payout. | End to end with A. Deploy both bots to Railway. |
| **10** | **Cut line. Must exist: `intents` on devnet, one SOL to ETH trade with a Basescan payout, driven from a CLI.** | |
| 10–12 | `soda_witness` program, deploy, `init_config`, hand B the IDL. | Swap page: form, quotes, `open_intent`. |
| 12–15 | `bump_gas`, `solver_withdraw`, `cancel_intent`, `close_intent`, more tests. | CRE `soda-witness` workflow, bindings, `--broadcast` into `on_report`. |
| 15–17 | Activity panel, README, judge script, `verify-nownodes.ts`; Phase 2 credit if time allows. | Order drawer and status machine. |
| 17–19 | Both: two 3-minute videos (Solana; CRE and NOWNodes), dry run on a clean clone. | |
| 19–20 | Both: submit. | |

If the end-to-end run slips past hour 10, drop the page and demo from the CLI. Witness still fits after it.

**Acceptance criteria:**
- [ ] `intents` deployed on devnet; program ID in the README; Explorer links for `open_intent`, `fill`, a rejected fill, `cancel_intent` and `finalize_signature`
- [ ] A trade from the page lands native ETH at the user's SODA-derived Base address; `pnpm verify` in frontier with `VERIFY_REQUESTER=<pool PDA>` prints every check MATCH
- [ ] Two solvers race; the loser's fill fails with `IntentNotOpen`
- [ ] `soda_witness` deployed; a committed `--broadcast` log; a claim on Explorer moves Pending → Recorded with the right facts
- [ ] `verify-nownodes.ts` passes on a clean clone; every Base read and broadcast in this repo goes through NOWNodes
- [ ] README: prior work table (what came from frontier), program IDs, links, trust model, what NOWNodes and CRE do

---

## 7. Hour-0 checks

- [ ] Coordinator healthy: `curl https://soda-mpc-coordinator-production.up.railway.app/health` shows both peers with `groupPkXY.x` = `9e4c1ac3a50367eefb5d05d1a18620037b20f2f52fc434bb7c7363081e21c5c5` (the x-coordinate of `039e4c1ac3…`; `/health` prints raw coordinates with no prefix).
- [ ] A new program's PDA gets signed. No program PDA has requested a signature since the committee moved to the Railway key on 2026-09-18. The first `fill` on devnet is the test; frontier's `demo-vault.ts` signs with the old dev key and will fail, so do not use it as the check.
- [ ] frontier's relayer broadcasts your `EthTxRequested` (it should, by discriminator). The solver bot delivers on its own anyway.
- [ ] The NOWNodes key answers on `base-sepolia` (header and path forms), plus its rate limit and batch support.
- [ ] CRE CLI ≥ 1.29, template `--broadcast` succeeds, Bun installed.
- [ ] Base Sepolia ETH for the pool address (solver inventory) and devnet SOL from faucet.solana.com.
- [ ] Ask at the booths: does the Solana track accept a better take on NEAR Intents; does a mock-forwarder simulation qualify for CRE; is `base-sepolia` on NOWNodes hackathon keys; NOWNodes prize criteria.

---

## 8. Rules that will save you hours

- Use soda `CPAEfBX…`, never `2YDHa…`.
- Every Solana subscription uses `wss://api.devnet.solana.com`; Alchemy's free tier returns `-32601` for `logsSubscribe`. HTTP reads and transactions go through a keyed RPC, because the public endpoint rate-limits with 429s.
- One payload per requester, ever: `SigRequest` seeds are `["sig", requester, payload]`. Retrying means changing the nonce or gas price.
- EVM calldata must stay at or under 255 bytes; the Rust RLP encoder corrupts longer data silently in release builds. Only legacy (type-0) transactions are supported.
- Program-data accounts are sized to the first binary. Before upgrading a larger program, run `solana program extend <id> 50000 --url devnet` (about 0.25 SOL).
- Rotating the committee key moves every derived address. Never rotate during the hackathon.
- Vendor IDLs and check their `address`. Stale IDLs caused four separate bugs in frontier.
- CRE: one HTTP trigger per workflow; accounts must exist before `on_report`; `computeLimit` is mandatory in simulation; simulation always uses the mock forwarder.
- Keep the NOWNodes key server-side.

## 9. Trust model (state it, do not hide it)

- The committee is 2-of-2: no fault tolerance, both nodes run by one operator, and its key was generated in one process on one laptop. v1 needs 2-of-3 or more (GG20 or CGGMP21), separate operators, and enclave-wrapped shares.
- Intents: Solana knows a payout was **signed**, not that it **landed**. `bump_gas` handles a stuck payout. Verified delivery and refunds come from Witness.
- Solver deposits are admin-credited until Phase 2.
- Witness under simulation goes through the mock forwarder, which checks no DON signatures.
- Every signature request locks 0.002413 SOL of rent that is never refunded. The solver's spread covers it.

## 10. Prior art to name in the pitch

| Protocol | Settlement | Trust |
|---|---|---|
| [NEAR Intents](https://docs.near.org/chain-abstraction/chain-signatures) | Verifier contract on NEAR; Solana assets bridge in | Bridges plus NEAR's MPC network |
| [Mayan Swift](https://docs.mayan.finance/architecture/swift-v2) | Auction on Solana; solver pays on the destination; a message unlocks funds | Messaging layer, curated solvers |
| [deBridge DLN](https://docs.debridge.finance/dln-the-debridge-liquidity-network-protocol/protocol-overview) | Source escrow; validators sign the unlock | deBridge validators |
| [Relay](https://docs.relay.link/references/protocol/how-it-works) | Solana depository; oracle attests; hub reimburses | Oracle, allocator, security council |
| [Across](https://docs.across.to/reference/contract-addresses/solana) | Relayers fill, repaid in bundles | UMA optimistic oracle |
| [Ika](https://solana-pre-alpha.ika.xyz/getting-started/concepts) | Signing primitive on Solana, not an intent protocol | Solana pre-alpha uses one mock signer |
| [1inch Fusion+](https://help.1inch.com/en/articles/9842591-what-is-1inch-fusion-and-how-does-it-work) | Escrows on both chains tied by a secret hash | Resolvers plus the user's browser revealing the secret |

Our line: escrow intent protocols (Mayan, deBridge, Across, Fusion+) need a contract on both ends and a cross-chain message, and oracle designs (Relay) add a trusted attester. SODA Intents settles in one Solana transaction with no destination contract and no fill message, because the payout is an ordinary Base transaction from an address a Solana program owns. NEAR Chain Signatures has the same shape, but settles on NEAR, not where Solana's users are. SODA's committee runs real Lindell 2017 two-party signing today, though its key generation ran on one machine (disclosed in §9), unlike Ika's single mock signer on Solana.
