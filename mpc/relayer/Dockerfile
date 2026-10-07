# SODA relayer container (worker, no port).
#
# Build from the REPO ROOT (the context needs mpc/, and some services lib/ and idl/):
#
#   docker build -f mpc/relayer/Dockerfile -t soda-mpc-relayer .
#
# Runtime: SOLANA_RPC_URL, SEPOLIA_RPC_URL (the EVM RPC it broadcasts to),
# DEMO_CHAIN, optional SUI_CHAIN.

FROM node:22-alpine AS deps
WORKDIR /repo/mpc
# Every workspace manifest is needed for `npm ci` to accept the lockfile;
# `-w mpc-relayer` then installs only this service's dependencies.
COPY mpc/package.json mpc/package-lock.json ./
COPY mpc/node/package.json node/
COPY mpc/coordinator/package.json coordinator/
COPY mpc/subscriber/package.json subscriber/
COPY mpc/relayer/package.json relayer/
RUN npm ci -w mpc-relayer --no-audit --no-fund

FROM node:22-alpine
WORKDIR /repo/mpc
COPY --from=deps /repo/mpc/node_modules ./node_modules
COPY mpc/package.json mpc/tsconfig.base.json ./
COPY mpc/relayer ./relayer
# lib/soda is source-only and imports @noble/*; Node resolves those from
# /repo/node_modules, so point that at the installed tree.
COPY lib/soda /repo/lib/soda
COPY idl/soda.json /repo/idl/soda.json
RUN ln -s /repo/mpc/node_modules /repo/node_modules
ENV NODE_ENV=production
WORKDIR /repo/mpc/relayer
CMD ["../node_modules/.bin/tsx", "src/index.ts"]
