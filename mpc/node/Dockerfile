# SODA mpc-node container (one party of the 2-of-2 committee).
#
# Build from the REPO ROOT (the context needs mpc/, and some services lib/ and idl/):
#
#   docker build -f mpc/node/Dockerfile -t soda-mpc-node .
#
# At runtime give it its share and role, e.g. one of:
#   MPC_ROLE=p1  MPC_SHARE_PATH=/data/share-p1.json   (mount /data read-only)
#   MPC_ROLE=p1  MPC_SHARE_B64=<base64 share JSON>     (platform secret)
# plus SOLANA_RPC_URL, SODA_PROGRAM_ID and MPC_AUTH_TOKEN. The image never
# contains a share: mpc/**/shares is in .dockerignore.

FROM node:22-alpine AS deps
WORKDIR /repo/mpc
# Every workspace manifest is needed for `npm ci` to accept the lockfile;
# `-w mpc-node` then installs only this service's dependencies.
COPY mpc/package.json mpc/package-lock.json ./
COPY mpc/node/package.json node/
COPY mpc/coordinator/package.json coordinator/
COPY mpc/subscriber/package.json subscriber/
COPY mpc/relayer/package.json relayer/
RUN npm ci -w mpc-node --no-audit --no-fund

FROM node:22-alpine
WORKDIR /repo/mpc
COPY --from=deps /repo/mpc/node_modules ./node_modules
COPY mpc/package.json mpc/tsconfig.base.json ./
COPY mpc/node ./node

ENV NODE_ENV=production
WORKDIR /repo/mpc/node
EXPOSE 8001 8002
CMD ["../node_modules/.bin/tsx", "src/server.ts"]
