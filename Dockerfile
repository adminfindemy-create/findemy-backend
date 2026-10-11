# syntax=docker/dockerfile:1
# One image, two processes: the API (default CMD) and the BullMQ worker, which the ECS worker
# service starts with:  node dist/workers/index.js
# Build context is the monorepo root:  docker build -t findemy-api .

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# openssl: Prisma's query engine needs it on Debian slim.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable
WORKDIR /app

# Manifests only — keeps the dependency layer cached until a package.json or the lockfile changes.
FROM base AS manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY api/package.json api/
COPY shared/types/package.json shared/types/
COPY shared/config/package.json shared/config/

# ---- build: full install (dev deps for tsc), generate Prisma client, compile ----
FROM manifests AS build
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile
COPY shared shared
COPY api api
RUN pnpm --filter @findemy/api exec prisma generate \
 && pnpm --filter @findemy/types build \
 && pnpm --filter @findemy/api build

# ---- runtime: prod dependencies only + compiled output ----
FROM manifests AS runtime
ENV NODE_ENV=production
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter "@findemy/api..."
# prisma/ is needed for `prisma generate` here and for `prisma migrate deploy` at release time.
COPY api/prisma api/prisma
RUN pnpm --filter @findemy/api exec prisma generate
COPY --from=build /app/shared/types/dist shared/types/dist
COPY --from=build /app/api/dist api/dist

USER node
WORKDIR /app/api
EXPOSE 8080
CMD ["node", "dist/server.js"]
