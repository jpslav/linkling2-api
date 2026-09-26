# The Linkling service (ADR-0006): one Node 24 process serving Fastify, with SQLite on the
# /data volume. better-sqlite3 is native, so npm ci installs it here, for the image's own
# platform, and never copies a node_modules in from the host.

FROM node:24-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS build
WORKDIR /app
# better-sqlite3 compiles itself when it has no prebuilt binary for this Node and platform
# (linux/arm64 on Node 24 did not); the toolchain stays in this stage, not the image.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
ENV NODE_ENV=production LINKLING_DATA=/data PORT=8080
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# src/db/migrate.ts reads ../../migrations/ from dist/db/; without it start-up fails.
COPY migrations ./migrations
# A named volume mounted here starts out owned like this directory, so node can write it.
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 8080
CMD ["node", "dist/server.js"]
