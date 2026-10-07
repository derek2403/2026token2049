# Railway deployment

This repo runs as three Railway services, all built from the repo root (leave **Root Directory** empty: the images need `lib/` and `idl/`). Put them in a new Railway project. The SODA MPC committee's project (`pagecontrol-signing`) is separate and stays untouched.

| Service | Config file | Image | Healthcheck | Networking |
|---|---|---|---|---|
| `web` | `/railway/web/railway.json` | `Dockerfile.web` (Next.js standalone, Node 22, non-root) | `GET /api/health` (no RPC calls) | Public domain |
| `solver-a` | `/railway/solver-a/railway.json` | `services/solver/Dockerfile` | `GET /health` | Private only (`solver-a.railway.internal:8080`) |
| `solver-b` | `/railway/solver-b/railway.json` | `services/solver/Dockerfile` | `GET /health` | Private only (`solver-b.railway.internal:8080`) |

The page calls the solvers server-side (`/api/quotes` fans out to `SOLVER_URLS`), so the solvers need no public domain.

`package-lock.json` is committed and both images install with `npm ci`. `.dockerignore` keeps `.env`, keypairs, `node_modules` and `.next` out of the build context.

## Variables

Names only. **Secret** means a key or a keyed URL: set it as a service variable and never commit it.

### `web`

| Variable | Secret | Value |
|---|---|---|
| `SOLVER_URLS` | no | `http://solver-a.railway.internal:8080,http://solver-b.railway.internal:8080` |
| `SOLANA_RPC_URL` | **yes** | Keyed Alchemy devnet HTTP URL. Used by `/api/group-pk`, `/api/payout` and `/api/prices`. |
| `BASE_RPC_URL` | **yes** | Keyed Alchemy Base Sepolia URL. Used by `/api/payout` and `/api/recipient-check`. Defaults to `https://sepolia.base.org`. |
| `NEXT_PUBLIC_SOLANA_RPC_URL` | no, build time | `https://solana-devnet.api.onfinality.io/public`. This URL ends up in the browser bundle, so it must not carry a key. It must also serve `getProgramAccounts`, which the Activity panel uses. This is the Dockerfile default. |
| `NEXT_PUBLIC_SOLANA_WS_URL` | no, build time | `wss://solana-devnet.api.onfinality.io/public-ws` (the Dockerfile default). |
| `NEXT_PUBLIC_INTENTS_PROGRAM_ID`, `NEXT_PUBLIC_SODA_PROGRAM_ID` | no, build time | Optional. Leave them unset to use the deployed devnet programs. |

`PORT` is set by Railway, and the server listens on `0.0.0.0:$PORT`. The `NEXT_PUBLIC_*` values are compiled in when the image is built: Railway passes service variables to the Dockerfile's `ARG`s, so after you change one, redeploy.

### `solver-a` and `solver-b`

| Variable | Secret | `solver-a` | `solver-b` |
|---|---|---|---|
| Solver authority key | **yes** | `SOL_KEY`: a base58 secret key for `D5pwjGzqvgvuFt4rtMVf1ta4RKXWyGGfG2ekh5KuDfZw` | `SOLVER_KEYPAIR_JSON`: a 64-byte JSON array for `CozgNEdiG93qqo8cxXeXddvuT3F1Gh6zHr4VLro1sZ54` |
| `SPREAD_BPS` | no | `30` | `60` |
| `PORT` | no | `8080` | `8080` |
| `SOLANA_RPC_URL` | **yes** | Keyed Alchemy devnet HTTP URL | same |
| `BASE_RPC_URL` | **yes** | Keyed Alchemy Base Sepolia URL | same |
| `AUTO_REGISTER` | no | `0` | `0` |
| `SOLANA_WS_URL` | no | Leave unset (off). The bot finds intents by polling the program's signatures over `SOLANA_RPC_URL`, using only methods on Alchemy's free tier. OnFinality's public WebSocket and HTTP answer 429 from Railway's shared IPs. | same |
| `WATCH_MS`, `BACKFILL_SIGS`, `WATCHER_TX_PER_SEC`, `REWALK_MS`, `MAX_OLDER_SIGS` | no | Optional. These default to `1500`, `1000`, `10`, `180000` and `20000`. | same |
| `SOL_USD_FALLBACK`, `ETH_USD_FALLBACK` | no | Optional. These are used only when Pyth is stale. | same |

Set exactly one key variable on each solver. The code checks `SOLVER_KEYPAIR_JSON` first, then `SOL_KEY`. `PORT` is pinned so that the private URLs in `SOLVER_URLS` stay valid.

`BOT_ID` (the operator's Base wallet key) is not needed. Both solvers are already registered, and payouts are rebroadcast from committee-signed transactions, so leave it off Railway. With `AUTO_REGISTER=0`, a missing `Solver` account fails loudly and is never registered.

**Before the Railway solvers start, stop the local ones.** They hold the same authority keys, so both copies would race each other for every fill and bump.

## Deploy with the CLI

Run from the repo root. `railway up` uploads the working tree minus `.gitignore`d files, so `.env` is not sent. The variable commands below read secrets from files, so the values never appear on screen.

```bash
npm i -g @railway/cli        # or: brew install railway
railway login                # opens a browser; use --browserless over SSH
railway init --name soda-intents   # new project (or: railway link, then pick it)

railway add --service solver-a
railway add --service solver-b
railway add --service web
```

In the dashboard, open each service and go to **Settings → Config-as-code → Railway config file**. Set it to the path in the table above, for example `/railway/web/railway.json`. This sets the Dockerfile and the healthcheck. The `RAILWAY_DOCKERFILE_PATH` variables below select the right Dockerfile even if this step is skipped.

```bash
# solver-a: SOL_KEY copied from the local .env without printing it
railway variables --service solver-a \
  --set "RAILWAY_DOCKERFILE_PATH=services/solver/Dockerfile" \
  --set "SOL_KEY=$(grep '^SOL_KEY=' .env | cut -d= -f2-)" \
  --set "SPREAD_BPS=30" --set "PORT=8080" --set "AUTO_REGISTER=0" \
  --set "SOLANA_RPC_URL=$(grep '^SOLANA_RPC_URL=' .env | cut -d= -f2-)" \
  --set "BASE_RPC_URL=$(grep '^BASE_RPC_URL=' .env | cut -d= -f2-)"

# solver-b: the keypair file's JSON array
railway variables --service solver-b \
  --set "RAILWAY_DOCKERFILE_PATH=services/solver/Dockerfile" \
  --set "SOLVER_KEYPAIR_JSON=$(cat <path to solver B keypair>.json)" \
  --set "SPREAD_BPS=60" --set "PORT=8080" --set "AUTO_REGISTER=0" \
  --set "SOLANA_RPC_URL=$(grep '^SOLANA_RPC_URL=' .env | cut -d= -f2-)" \
  --set "BASE_RPC_URL=$(grep '^BASE_RPC_URL=' .env | cut -d= -f2-)"

# web: NEXT_PUBLIC_* must be set before the first build
railway variables --service web \
  --set "RAILWAY_DOCKERFILE_PATH=Dockerfile.web" \
  --set "SOLVER_URLS=http://solver-a.railway.internal:8080,http://solver-b.railway.internal:8080" \
  --set "NEXT_PUBLIC_SOLANA_RPC_URL=https://solana-devnet.api.onfinality.io/public" \
  --set "NEXT_PUBLIC_SOLANA_WS_URL=wss://solana-devnet.api.onfinality.io/public-ws" \
  --set "SOLANA_RPC_URL=$(grep '^SOLANA_RPC_URL=' .env | cut -d= -f2-)" \
  --set "BASE_RPC_URL=$(grep '^BASE_RPC_URL=' .env | cut -d= -f2-)"

railway up --service solver-a --detach
railway up --service solver-b --detach
railway up --service web --detach
railway domain --service web   # prints the public https://…up.railway.app URL
```

As an alternative, connect the GitHub repo to each service in the dashboard. Set the same config file path and variables, then push to deploy. This needs the lockfile, `Dockerfile.web`, `.dockerignore` and `railway/` committed first. The `watchPatterns` in each config keep a page-only change from redeploying the bots, and a bot-only change from redeploying the page.

## Check

```bash
railway logs --service solver-a          # expect: "quote server on :8080", spread 30 bps
railway logs --service solver-b          # spread 60 bps
WEB=https://<web domain>
curl -s $WEB/api/health                  # {"ok":true,"solvers":2}
curl -s $WEB/api/group-pk                # groupPk 039e4c1a…
curl -s "$WEB/api/quotes?inLamports=50000000"   # best = solver A (narrower spread), failed: []
curl -s "$WEB/api/payout?intent=FxXuGJTEYkYd1xhGPAeCuf6rDXxGDx46RRn9AcPeBNPH"   # status completed
```

If `/api/quotes` lists `solver-*.railway.internal` under `failed`, check that `PORT=8080` is set on that solver and that it is in the same project and environment as `web`.
