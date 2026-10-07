# Solver bot image. Build context is the repo root (it needs lib/ and idl/):
#   docker build -f services/solver/Dockerfile .
FROM node:22-slim
WORKDIR /app

# package-lock.json is committed: npm ci installs exactly what it pins.
COPY package.json package-lock.json ./
# Dev deps are needed: the bot runs TypeScript through tsx.
RUN npm ci --ignore-scripts --no-audit --no-fund

COPY tsconfig.json ./
COPY lib ./lib
COPY idl ./idl
COPY services/solver ./services/solver

# Configuration comes from the service's variables, never a baked-in .env.
ENV NODE_ENV=production NO_DOTENV=1
USER node
CMD ["npx", "tsx", "services/solver/src/index.ts"]
