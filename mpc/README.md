# SODA MPC committee

This directory holds the threshold-signing committee behind SODA. It is the signer the intents app depends on: when a Solana program calls `soda::request_signature`, this committee produces the secp256k1 ECDSA signature that `soda::finalize_signature` checks on-chain with `secp256k1_recover`.

**Prior work.** This code is the SODA committee moved in from [github.com/derek2403/frontier](https://github.com/derek2403/frontier) (`apps/mpc-node`, `apps/mpc-coordinator`, `apps/mpc-subscriber`, `apps/relayer`). It was moved so this repo is self-contained. The protocol and the services are unchanged; only paths, imports and packaging differ (see [What changed in the move](#what-changed-in-the-move)).

## Services

| Directory | Package | What it does |
|---|---|---|
| `node/` | `mpc-node` | One party of a **2-of-2 Lindell 2017 two-party ECDSA** committee ([`@safeheron/two-party-ecdsa-js`](https://www.npmjs.com/package/@safeheron/two-party-ecdsa-js)). Run it twice, once as `p1` and once as `p2`, each with its own key share. Before it signs, a node reads the `SigRequest` account from **its own** Solana RPC, checks that the account is owned by the soda program, not completed and not expired, re-derives the tweak, and confirms that the derived key matches the stored `foreign_pk`. Callers pass only an account address, never a payload. The tweak is folded into the signed message (`m + r·t`, see `node/src/tweak.ts`), so the signature recovers to `group_pk + t·G`, the derived address. |
| `coordinator/` | `mpc-coordinator` | A stateless HTTP relay that drives the four protocol messages between p1 and p2 and returns `{ r, s, v }`, normalised to low-s. It never sees a share, a payload or a tweak, so a compromised coordinator can stall signing but cannot obtain a signature. |
| `subscriber/` | `mpc-subscriber` | A worker that subscribes to soda's `SigRequested` events (through `logsSubscribe`), asks the coordinator to sign the request, and submits `finalize_signature(signature, recovery_id)`. It is an untrusted trigger: it only names the account. |
| `relayer/` | `mpc-relayer` | A worker that caches `eth_demo::EthTxRequested` (and `sui_demo::SuiTxRequested`) events, and on `soda::SigCompleted` assembles the signed transaction (legacy RLP with EIP-155 `v`, or a Sui secp256k1 envelope) and broadcasts it. The intents solvers broadcast their own Base payouts, so the intents flow does not need the relayer. It is kept for the frontier demo programs. |
| `scripts/mpc-all-in-one.mjs` | | A supervisor that runs p1, p2 and the coordinator in one container (`Dockerfile.mpc-aio`). Both shares then sit on one filesystem, so use it for demos only. |
| `node/scripts/` | | `dkg.ts` (key generation), `update-committee.ts` (sets the on-chain `Committee.group_pk`; needs the committee authority's keypair) and `e2e-mpc.ts` (an end-to-end run against a validator running the soda program). |

### HTTP API

| Service | Route | Body or response |
|---|---|---|
| coordinator | `GET /health` | `{ ok, peers: { p1, p2 } }`. Each peer reports its role and `groupPkXY`. |
| coordinator | `POST /sign` | Takes `{ "sigRequestPubkey": "<SigRequest account>" }` and returns `{ r, s, v }` (hex, hex, 0 or 1). Requires `Authorization: Bearer $MPC_AUTH_TOKEN` when that variable is set. |
| node | `GET /health` | `{ ok, role, groupPkXY }`. Open even when a token is set, so platform health checks work. |
| node | `POST /sign/init`, `POST /sign/step` | Protocol messages, called by the coordinator only. Require `MPC_AUTH_TOKEN` when set. |

## Environment variables

All values are secrets or deployment-specific; only names are listed. `mpc/.env.example` and `node/.env.example` contain the non-secret defaults. The subscriber, the relayer and `update-committee.ts` also read `mpc/.env` (gitignored), not the intents app's root `.env`.

**node**

| Name | Purpose |
|---|---|
| `MPC_ROLE` | `p1` or `p2`. Must match the share. |
| `MPC_SHARE_PATH` | Path to the share file (default `/data/share-<role>.json`). |
| `MPC_SHARE_B64` | The share JSON as base64. Takes precedence over the path, for hosts that only have env vars (Railway). |
| `MPC_SHARE_JSON` | The share JSON verbatim. |
| `PORT` | Listen port (default 8001 for p1, 8002 for p2). |
| `MPC_BIND_HOST` | Bind address (default `0.0.0.0`; Railway uses `::` for IPv6 private networking). |
| `MPC_AUTH_TOKEN` | Bearer token the coordinator must present. Required on any public host. |
| `SOLANA_RPC_URL` | The node's own RPC for reading `SigRequest` accounts. |
| `SODA_PROGRAM_ID` | The soda program that must own the account. If unset, the node refuses every request. |
| `SODA_KNOWN_REQUESTERS` | Optional comma-separated fallback owners, for older requests keyed on a program id. |
| `MPC_ACCOUNT_WAIT_MS` | How long to wait for a just-created `SigRequest` to become readable (default 8000). |

**coordinator**

| Name | Purpose |
|---|---|
| `PORT` | Listen port (default 8000). |
| `MPC_NODE_P1_URL`, `MPC_NODE_P2_URL` | Peer URLs. |
| `MPC_NODE_AUTH_TOKEN` | Token presented to the nodes (their `MPC_AUTH_TOKEN`). |
| `MPC_AUTH_TOKEN` | Token callers of `/sign` must present. |
| `MPC_PEER_TIMEOUT_MS`, `MPC_HEALTH_TIMEOUT_MS`, `MPC_PREWARM_PEERS` | Timeouts, and whether to wake sleeping peers before signing (`0` turns this off). |

**subscriber**

| Name | Purpose |
|---|---|
| `SOLANA_RPC_URL` (or `SOLANA_DEVNET_RPC_URL`) | Must support `logsSubscribe`. |
| `MPC_COORDINATOR_URL`, `MPC_COORDINATOR_TOKEN` | The coordinator and its `MPC_AUTH_TOKEN`. |
| `ANCHOR_WALLET_JSON` or `ANCHOR_WALLET` | Fee payer for `finalize_signature`, as the keypair array inline or as a file path. |

**relayer**

| Name | Purpose |
|---|---|
| `SOLANA_RPC_URL` (or `SOLANA_DEVNET_RPC_URL`) | Event source. |
| `SEPOLIA_RPC_URL` | The EVM RPC it broadcasts to (any chain in `lib/soda/evm-chains.ts`). |
| `DEMO_CHAIN`, `SUI_CHAIN`, `SUI_TESTNET_GRAPHQL_URL`, `SUI_DEVNET_GRAPHQL_URL` | Chain selection and the Sui endpoint overrides. |
| `RELAYER_DEBUG` | Set to `1` to log every log batch. |

**all-in-one supervisor**: `PORT`, `MPC_AUTH_TOKEN`, `MPC_SHARE_P1_PATH`, `MPC_SHARE_P2_PATH`, `MPC_P1_PORT`, `MPC_P2_PORT`, plus the node variables `SOLANA_RPC_URL` and `SODA_PROGRAM_ID`, which pass through to both nodes.

## Running locally

`mpc/` is its own npm workspace with its own `node_modules`, so it does not touch the Next.js app's dependencies. Every command below runs from the repo root.

```bash
npm run mpc:install          # npm install inside mpc/
npm run mpc:typecheck        # tsc --noEmit for all four services
npm run mpc:test             # mpc-node Lindell 2PC + tweak tests (vitest), relayer decoder tests
```

1. **DKG.** Generate a throwaway key pair of shares. They are written to `mpc/node/shares/`, which is gitignored and dockerignored.

   ```bash
   npm run mpc:dkg            # prints group_pk.x / group_pk.y
   ```

2. **Nodes**, one terminal each:

   ```bash
   SOLANA_RPC_URL=https://api.devnet.solana.com SODA_PROGRAM_ID=CPAEfBXpMMsUrjLNhDYxaCH79DYvFHJFC27fttnxAL1J \
     npm --prefix mpc run node:p1
   SOLANA_RPC_URL=https://api.devnet.solana.com SODA_PROGRAM_ID=CPAEfBXpMMsUrjLNhDYxaCH79DYvFHJFC27fttnxAL1J \
     npm --prefix mpc run node:p2
   ```

3. **Coordinator:**

   ```bash
   npm run mpc:coordinator     # :8000, peers default to localhost:8001 / :8002
   curl localhost:8000/health
   ```

4. **Subscriber**, with `mpc/.env` filled in from `mpc/.env.example`:

   ```bash
   npm run mpc:subscriber
   ```

   A fresh DKG key is **not** the key in the on-chain `Committee` account. Unless you run `update-committee.ts` against a soda deployment whose authority you hold, `finalize_signature` rejects these signatures with `PubkeyMismatch`. The committee is also global to the soda program, so never rotate the shared devnet deployment just to test.

Alternatively, `docker compose -f mpc/docker-compose.mpc.yml up --build` runs steps 2 and 3 in containers, after step 1.

The nodes will not sign a raw payload; a `SigRequest` account must exist. For an offline check, point both nodes' `SOLANA_RPC_URL` at a stub JSON-RPC server that answers `getAccountInfo` with a hand-built `SigRequest` (layout in `node/src/authorize.ts`) owned by any `SODA_PROGRAM_ID`. Then `POST /sign` and recover the public key from `(payload, r, s, v)`. It must equal `group_pk + t·G`, where `t = sha256("SODA-v1" ‖ requester ‖ seeds ‖ chain_tag)`. This repo was checked that way when the code moved in.

## Dockerfiles

Every Dockerfile builds from the **repo root**, because the relayer and the subscriber need `lib/soda` and `idl/soda.json`:

```bash
docker build -f mpc/node/Dockerfile        -t soda-mpc-node .
docker build -f mpc/coordinator/Dockerfile -t soda-mpc-coordinator .
docker build -f mpc/subscriber/Dockerfile  -t soda-mpc-subscriber .
docker build -f mpc/relayer/Dockerfile     -t soda-mpc-relayer .
docker build -f mpc/Dockerfile.mpc-aio     -t soda-mpc-aio .
```

The images never contain a share or an `.env`: the root `.dockerignore` excludes `mpc/**/shares`, `share-p*.json`, `keyshare*.json` and every `.env*` except `.env.example`.

## Deployment (Railway, unchanged)

The live committee runs in the Railway project **`pagecontrol-signing`** (environment `production`). That project builds from `derek2403/frontier` on `main` using frontier's `apps/*/Dockerfile`, not from this directory. Moving the code here did **not** change the deployment, its keys or its URLs.

| Railway service | Role | Exposure |
|---|---|---|
| `soda-mpc-node-p1` | node, `MPC_ROLE=p1`, share from `MPC_SHARE_B64` | private network only, `:8001` |
| `soda-mpc-node-p2` | node, `MPC_ROLE=p2` | private network only, `:8002` |
| `soda-mpc-coordinator` | coordinator | public: `https://soda-mpc-coordinator-production.up.railway.app` (token required) |
| `soda-mpc-subscriber` | subscriber | worker, no port |
| `soda-relayer` | relayer | worker, no port |

The nodes answer on `SERVICE.railway.internal` over IPv6, which is why they bind `::`, and the coordinator's peer URLs use Railway variable references. The subscriber and the relayer use `https://api.devnet.solana.com`, because Alchemy's free tier has no `logsSubscribe`. To move the deployment onto this repo later, point each service's `RAILWAY_DOCKERFILE_PATH` at the matching `mpc/*/Dockerfile`, leave the root directory empty, and keep the existing variables. That is a separate, deliberate change.

On devnet, soda is `CPAEfBXpMMsUrjLNhDYxaCH79DYvFHJFC27fttnxAL1J` and the Committee PDA is `9mX3oHUmsrYvzXjCo35HhfXufrGZT3hjsLoC74xbA6SS`.

## Trust caveats

- **2-of-2, not a threshold with fault tolerance.** Both parties must be up to sign, and either one can stall signing. Production needs 2-of-3 or more.
- **One operator.** Both nodes, the coordinator and the subscriber run in one Railway project under one account. The protocol keeps each share on its own service, but the same person can read both. That is custody by one operator, not a decentralised committee.
- **Keys generated in one process.** `node/scripts/dkg.ts` runs both sides of key generation in a single process on a single machine, then writes both shares. Whoever ran it could have kept the joint key. A real ceremony runs each party on separate hardware.
- **The all-in-one image** (`Dockerfile.mpc-aio`) puts both shares on one filesystem. In that mode the committee is effectively a single-key signer.
- **Node-side authorization is the security boundary.** Each node signs only what a confirmed, unexpired, soda-owned `SigRequest` committed to, read from its own RPC. A node that is given a dishonest RPC endpoint can be fooled, so give each node an RPC you trust.

## What changed in the move

- **Packaging:** pnpm became npm workspaces (`mpc/package.json`, one lockfile in `mpc/package-lock.json`). Versions are pinned exactly to frontier's lockfile, except that `@noble/curves` and `@noble/hashes` are pinned to v1 (1.9.7 and 1.8.0, as at the repo root; the `Point`/`Fn` API the code uses exists in 1.9.7) and `tsx` is 4.23.15 (as at the root; 4.21 cannot import `lib/soda`'s CommonJS-scoped `.ts` files from an ESM package).
- **SDK:** `@soda-sdk/core` (`workspace:*`) was replaced by this repo's `lib/soda`. The relayer needed three files that were not there yet: `lib/soda/sui.ts` and `lib/soda/sui-ptb.ts` (copied verbatim) and `lib/soda/evm-chains.ts` (frontier's `chains.ts` cut down to the EVM registry and `chainById`). `lib/soda/index.ts` and its existing exports are unchanged.
- **IDLs:** the subscriber, the node scripts and the relayer read `idl/soda.json` at the repo root, which is identical to frontier's. The relayer's `eth_demo.json` and `sui_demo.json` are in `relayer/idl/`.
- **Not moved:** frontier's soda program itself (`contracts/`), the web app, the docs, `scripts/mpc-e2e-local.sh` (which needs a locally built `soda.so`), and the Render and AWS deploy scripts.
