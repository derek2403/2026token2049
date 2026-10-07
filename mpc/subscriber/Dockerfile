# SODA mpc-subscriber container (worker, no port).
#
# Build from the REPO ROOT (the context needs mpc/, and some services lib/ and idl/):
#
#   docker build -f mpc/subscriber/Dockerfile -t soda-mpc-subscriber .
#
# Runtime: SOLANA_RPC_URL (must serve logsSubscribe), MPC_COORDINATOR_URL,
# MPC_COORDINATOR_TOKEN, ANCHOR_WALLET_JSON (fee payer keypair array).

FROM node:22-alpine AS deps
WORKDIR /repo/mpc
# Every workspace manifest is needed for `npm ci` to accept the lockfile;
# `-w mpc-subscriber` then installs only this service's dependencies.
COPY mpc/package.json mpc/package-lock.json ./
COPY mpc/node/package.json node/
COPY mpc/coordinator/package.json coordinator/
COPY mpc/subscriber/package.json subscriber/
COPY mpc/relayer/package.json relayer/
RUN npm ci -w mpc-subscriber --no-audit --no-fund

FROM node:22-alpine
WORKDIR /repo/mpc
COPY --from=deps /repo/mpc/node_modules ./node_modules
COPY mpc/package.json mpc/tsconfig.base.json ./
COPY mpc/subscriber ./subscriber
# The committed soda IDL (program id + event discriminators).
COPY idl/soda.json /repo/idl/soda.json
ENV NODE_ENV=production
WORKDIR /repo/mpc/subscriber
CMD ["../node_modules/.bin/tsx", "src/index.ts"]
