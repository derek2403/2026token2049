# SODA Witness: CRE workflow

`soda-witness/` is a Chainlink CRE workflow. It takes `{ claim, txHash }`, reads that Base Sepolia transaction over JSON-RPC (the `BASE_RPC_URL` workflow secret), has the DON agree on the facts, and writes them into `soda_witness::on_report` on Solana devnet. The claim then moves from Pending to Recorded, holding from, to, value, block and success.

```
HTTP trigger {claim, txHash}
  -> Base Sepolia RPC (BASE_RPC_URL): eth_getTransactionReceipt, eth_getTransactionByHash (identical consensus)
                                      eth_blockNumber (median consensus), require >= minConfirmations
  -> WitnessReport (106-byte Borsh) -> forwarder -> soda_witness::on_report(config, claim)
```

The workflow is based on [cre-templates `solana-read-write-ts`](https://github.com/smartcontractkit/cre-templates/tree/main/building-blocks/solana-read-write/solana-read-write-ts) (MIT). It uses `@chainlink/cre-sdk` 1.23.0. The bindings in `soda-witness/contracts/solana/ts/generated/` were made by `cre generate-bindings solana` from `idl/soda_witness.json`.

## Trust caveat (read this first)

The hackathon runs CRE in **simulation only**. `cre workflow simulate` always writes through Chainlink's **mock forwarder** (`7kuEAA3…`, state `5Tipz3y…`), whatever the config says, and that forwarder:

- checks **no DON signatures** and has **no replay protection**;
- can be called by **anyone**, with any report and any metadata.

While `soda_witness` is configured for the mock forwarder, a Recorded claim proves only that *someone* sent a well-formed report. The workflow does read Base itself, but nothing on chain proves that the report came from it. Pinning `workflow_owner` and `workflow_name` doesn't help either, because the caller writes the metadata too. Production trust needs a deployed workflow, the production forwarder (`CXsKEJc…`, which checks f+1 DON signatures), and `set-config --forwarder production`.

Also:
- Base reads go to the URL in the `BASE_RPC_URL` secret (a keyed Alchemy Base Sepolia URL is fine; `https://sepolia.base.org` also works). It is a secret because a keyed URL carries its key in the path. The Solana write goes to `CRE_SOLANA_RPC_URL`.
- The program's replay guard is the claim state. A claim takes one report, then stays Recorded.

## Files

| Path | What |
|---|---|
| `project.yaml` | RPC for `solana-devnet`, read from `CRE_SOLANA_RPC_URL` so a keyed URL stays out of git |
| `secrets.yaml` | Workflow secret `BASE_RPC_URL`, read from env var `BASE_RPC_URL_ALL` |
| `.env.example` | Variable names for `cre/.env`, which is gitignored |
| `payloads/claim.json` | Trigger payload. `scripts/witness-cli.ts open-claim` rewrites it |
| `soda-witness/workflow.ts` | Handler logic |
| `soda-witness/main.ts` | Runner entry point |
| `soda-witness/workflow.test.ts` | `bun test`: the handler against the SDK test runtime, with the Base RPC and Solana mocked |
| `soda-witness/config.simulation.json` | Mock forwarder, receiver `5v97wLY…`, Config PDA `5Dxc9Y6…`, chain 84532, 3 confirmations |
| `soda-witness/config.production.json` | Production forwarder. Set `authorizedEvmKey` before deploying |
| `runs/` | Commit the `--broadcast` logs here |

## Steps

Run everything from the repo root unless a step says otherwise.

**0. Tools.** You need Bun, and CRE CLI 1.29 or later (1.37.0 tested).

```bash
cd cre/soda-witness && bun install && bun run typecheck && bun test && cd ../..
```

**1. Log in to CRE.**

```bash
cre login
```

On CLI 1.37.0, dry runs reached the workflow without a login. Log in anyway, because `--broadcast` and deploy may need it.

**2. Fill `cre/.env`.** Copy `cre/.env.example` and set:
- `CRE_SOLANA_RPC_URL`: a keyed devnet RPC is best. `https://api.devnet.solana.com` answered 429 to every call on 2026-10-07.
- `CRE_SOLANA_PRIVATE_KEY`: a path to a funded devnet keypair file, or a base58 secret.
- `CRE_ETH_PRIVATE_KEY`: any valid key.
- `BASE_RPC_URL_ALL`: a Base Sepolia JSON-RPC URL (https).

**3. Deploy and configure `soda_witness`.** Already done on devnet: program `5v97wLY…`, Config `5Dxc9Y6…` (see [`runs/witness-devnet.md`](../runs/witness-devnet.md)). For a fresh deployment, run `anchor build && anchor deploy --provider.cluster devnet` from `programs/`, then:

```bash
npx tsx scripts/witness-cli.ts init-config          # mock forwarder, owner/name checks off (zeros)
npx tsx scripts/witness-cli.ts show-config
```

**4. Open the claim.** The workflow can't create accounts, so the claim has to exist first.

```bash
npx tsx scripts/witness-cli.ts open-claim 0xb9d12a5ab63a10f508a1288e0fa6db38da7a46b50d25daf06125669aec2757d7
```

The requester is `--keypair`, `USER_KEYPAIR` or `~/.config/solana/id.json`, and it pays rent. The command prints the claim PDA and rewrites `cre/payloads/claim.json`. The example hash is a real Base Sepolia transfer: BOT `0x3177…` sends 1 ETH to the pool address `0x7662…` in block 47799710.

**5. Dry run.** This builds and simulates the Solana transaction without sending it.

```bash
cd cre
cre workflow simulate soda-witness --target simulation-settings --non-interactive --trigger-index 0 \
  --http-payload ./payloads/claim.json
```

**6. Broadcast.** This sends a real devnet transaction through the mock forwarder.

```bash
cre workflow simulate soda-witness --target simulation-settings --non-interactive --trigger-index 0 \
  --http-payload ./payloads/claim.json --broadcast 2>&1 | tee runs/$(date -u +%Y%m%dT%H%M%SZ)-broadcast.log
cd ..
npx tsx scripts/witness-cli.ts show-claim <claim>   # Pending -> Recorded with the facts
```

Commit the log and link the Solana Explorer transaction it prints.

**7. Optional: pin the workflow.** The transaction logs contain `metadata: <128 hex chars>`. Bytes `[32..42]` are the workflow name and bytes `[42..62]` are the owner. Pin them, then rerun steps 4 to 6 with a new transaction hash:

```bash
npx tsx scripts/witness-cli.ts set-config --workflow-owner 0x<20 bytes> --workflow-name <10 bytes hex>
```

**8. Production, if deploy access arrives.**
1. Set `authorizedEvmKey` in `config.production.json`.
2. Run `cre workflow deploy soda-witness --target production-settings`.
3. Pin the deployed workflow and switch forwarders in one step. The production forwarder lets any workflow's report target any receiver, so the owner pin is what keeps other workflows out. Take owner and name from the deployed workflow's metadata (its first `metadata:` log line), not from step 7: a simulation run's metadata probably differs.

```bash
npx tsx scripts/witness-cli.ts set-config --forwarder production --workflow-owner 0x<deployed owner> --workflow-name <deployed name hex>
```

`set-config` keeps the current owner and name when their flags are left out, and refuses `--forwarder production` with a zero owner.

After that switch, simulations fail with `MismatchedForwarderProgram`, which is expected.

**After every `anchor build`:**

```bash
cp programs/target/idl/soda_witness.json idl/soda_witness.json
cp idl/soda_witness.json cre/soda-witness/contracts/solana/src/idl/soda_witness.json
cd cre/soda-witness && cre generate-bindings solana --language typescript
```

## Errors you may hit

| Error | Meaning |
|---|---|
| `environment variable "CRE_SOLANA_RPC_URL" … is not set` | `cre/.env` is missing or incomplete |
| `CRE_SOLANA_PRIVATE_KEY is required` | Same |
| `BASE_RPC_URL secret must be an https URL` | `BASE_RPC_URL_ALL` in `cre/.env` is missing or not an https URL |
| `eth_getTransactionReceipt: HTTP 401` / `403` | The key in `BASE_RPC_URL_ALL` is wrong, or the provider has not enabled Base Sepolia for it |
| `Only N confirmations` | Wait for `minConfirmations` blocks |
| `on_report write failed: AccountNotFound` | The `CRE_SOLANA_PRIVATE_KEY` account is unfunded on devnet |
| `Custom:2007` | `ConstraintExecutable` in the forwarder: `soda_witness` isn't deployed |
| `Custom:6002` | Ambiguous: the mock forwarder's `InvalidAccountHash` (wrong account list) or the receiver's `InvalidForwarderState`. Check the error name in the logs |
| `MismatchedForwarderProgram` (6001) | The receiver is configured for production, but this is a simulation |
| `ClaimNotPending` (6009) | Already recorded; open a claim for another transaction |
| `ChainIdMismatch` / `TxHashMismatch` | The payload's claim was opened for a different transaction |

## Design notes

- **Handler checks.** Facts pass through identical consensus only after they are lowercased into strings. The head block takes a median, and confirmations are computed after consensus. The handler rejects a transaction whose `chainId` isn't `84532`. A contract creation records `to = 0x00…00`. Receipt status `0x1` becomes report status 1; any other status becomes 0.
- **Forwarder state is read-only.** The forwarder state is passed read-only, per the handover. The template marks it writable, but neither forwarder declares it `mut`, and the account hash covers only the keys.
- **WASM runtime limits.** The forwarder authority PDA comes from `@solana/web3.js` `findProgramAddressSync`, because `crypto.subtle` is missing. The `BASE_RPC_URL` secret is checked with a regex, because zod's `.url()` fails without the `URL` global.
- **Quota.** The handler makes 3 HTTP calls and 1 secret fetch per run, against limits of 15 and 5. Every request caches for 60 s.

## SODA Signer

`soda-signer/` is a second workflow. It takes `{ sigRequest }` (a pending soda `SigRequest`), and:

1. reads the account over Solana JSON-RPC (secret `SOLANA_RPC_URL`), with identical consensus on `{owner, completed}`, and refuses unless soda (`CPAEf…`) owns it and it is not completed;
2. calls the MPC coordinator `POST {coordinatorUrl}/sign` with `Authorization: Bearer <MPC_COORDINATOR_TOKEN>`, with identical consensus on `{r, s, v}`;
3. writes a 98-byte Borsh `SignerReport { ver, sig_request, signature r||s, recovery_id }` to `soda_cre_signer::on_report` (`2cgtuK2…`, Config PDA `3pf5T3w…`), which CPIs soda `finalize_signature` signed by its `["submitter"]` PDA.

```
HTTP trigger {sigRequest}
  -> Solana RPC getAccountInfo (identical consensus) -> coordinator /sign (identical consensus)
  -> SignerReport -> forwarder -> soda_cre_signer::on_report -> soda::finalize_signature
```

**Why the mock forwarder is not a trust issue here.** Unlike the witness, the report carries no facts that the chain has to take on trust. soda's `finalize_signature` recovers the secp256k1 public key from `signature` and `recovery_id` and checks it against the key stored in the `SigRequest`, so a forged or wrong signature fails on chain whoever sends it. The worst a caller of the mock forwarder can do is deliver a valid signature early, which is the outcome the workflow exists to produce. An already-completed request is a no-op (`AlreadyFinalized`).

Setup: add `SOLANA_RPC_URL_ALL` and `MPC_COORDINATOR_TOKEN_ALL` to `cre/.env`. Test with `cd cre/soda-signer && bun install && bun run typecheck && bun test`. Bindings come from `cre generate-bindings solana` over `idl/soda_cre_signer.json`.
