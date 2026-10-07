# SODA mpc-coordinator container.
#
# Build from the REPO ROOT (the context needs mpc/, and some services lib/ and idl/):
#
#   docker build -f mpc/coordinator/Dockerfile -t soda-mpc-coordinator .
#
# Runtime: MPC_NODE_P1_URL, MPC_NODE_P2_URL, MPC_NODE_AUTH_TOKEN, MPC_AUTH_TOKEN.

FROM node:22-alpine AS deps
WORKDIR /repo/mpc
# Every workspace manifest is needed for `npm ci` to accept the lockfile;
# `-w mpc-coordinator` then installs only this service's dependencies.
COPY mpc/package.json mpc/package-lock.json ./
COPY mpc/node/package.json node/
COPY mpc/coordinator/package.json coordinator/
COPY mpc/subscriber/package.json subscriber/
COPY mpc/relayer/package.json relayer/
RUN npm ci -w mpc-coordinator --no-audit --no-fund

FROM node:22-alpine
WORKDIR /repo/mpc
COPY --from=deps /repo/mpc/node_modules ./node_modules
COPY mpc/package.json mpc/tsconfig.base.json ./
COPY mpc/coordinator ./coordinator

ENV NODE_ENV=production
WORKDIR /repo/mpc/coordinator
EXPOSE 8000
CMD ["../node_modules/.bin/tsx", "src/server.ts"]
