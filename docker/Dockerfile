# syntax=docker/dockerfile:1.7
# `# syntax=...` on line 1 enables BuildKit features like `--mount=type=cache`
# and `--mount=type=secret`. Requires BuildKit (default in Docker 23+).

# Global ARG — must be declared before the first FROM so it can be used in
# the `oven/bun:${BUN_VERSION}-debian` stage below.
ARG BUN_VERSION=1.2.12

FROM docker.io/library/node:22.22.2-slim AS base
WORKDIR /usr/src/app

ARG API_CLOUD_MODE=false
ARG RELEASE_VERSION=local

ENV API_CLOUD_MODE=${API_CLOUD_MODE}
ENV API_DEVELOPMENT_MODE=false
ENV RELEASE_VERSION=${RELEASE_VERSION}
ENV SENTRY_RELEASE=${RELEASE_VERSION}

# pnpm's default fetch timeout (60s) can be tight for slow paths to
# registry.npmjs.org from the GitHub Actions runners; raise it globally.
# Inherited by `deps` and `prod-deps` since they FROM base.
ENV npm_config_fetch_timeout=600000

# apt cache mounts persist /var/cache/apt and /var/lib/apt across builds so
# repeated apt-get runs don't re-download the same .deb packages. The
# `docker-clean` apt hook (ships in debian-slim) would delete the cache
# after each install, defeating the mount — remove it first.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    rm -f /etc/apt/apt.conf.d/docker-clean \
  && apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates git python3 make g++ procps

RUN corepack disable \
  && npm i -g pnpm@10.34.1

FROM base AS deps
COPY package.json pnpm-lock.yaml .npmrc ./
COPY packages/kodus-common ./packages/kodus-common
COPY packages/kodus-flow ./packages/kodus-flow

# `--store-dir` points pnpm at a BuildKit cache mount so the
# content-addressable store survives across builds. pnpm's store is safe
# under concurrent access (atomic writes), so `sharing=shared` lets the
# parallel bake targets reuse it without lock waits.
#
# The `npmrc` BuildKit secret (optional) lets CI inject auth for the
# @kodus registry without the token ever landing in an image layer.
# Usage: `docker buildx build --secret id=npmrc,src=$HOME/.npmrc ...`.
# When the secret is absent (required=false), the repo-local .npmrc
# copied above stays in effect — today that file only holds registry
# URLs, no tokens, so builds still work unauthenticated.
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc,required=false \
    --mount=type=cache,target=/pnpm-store,sharing=shared \
    cd packages/kodus-common \
  && pnpm install --store-dir /pnpm-store \
  && pnpm run prepack
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc,required=false \
    --mount=type=cache,target=/pnpm-store,sharing=shared \
    cd packages/kodus-flow \
  && pnpm install --store-dir /pnpm-store \
  && pnpm run build

# Install dependencies and link local packages.
# github_token (optional) authenticates @vscode/ripgrep's postinstall
# download against the GitHub releases API — anonymous calls from shared
# CI runner IPs are rate-limited (403) and abort the whole install. Empty
# or absent secret → unauthenticated, same as a local build.
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc,required=false \
    --mount=type=secret,id=github_token,required=false \
    --mount=type=cache,target=/pnpm-store,sharing=shared \
    if [ -s /run/secrets/github_token ]; then export GITHUB_TOKEN="$(cat /run/secrets/github_token)"; fi \
 && pnpm install --frozen-lockfile --store-dir /pnpm-store
RUN rm -rf node_modules/@kodus/kodus-common && cp -r packages/kodus-common node_modules/@kodus/kodus-common
RUN rm -rf node_modules/@kodus/flow && cp -r packages/kodus-flow node_modules/@kodus/flow

FROM deps AS build
ARG API_CLOUD_MODE=false
ENV API_CLOUD_MODE=${API_CLOUD_MODE}

ARG RELEASE_VERSION=local
ENV RELEASE_VERSION=$RELEASE_VERSION
ENV SENTRY_RELEASE=$RELEASE_VERSION

COPY . .

# Generate environment.ts by replacing placeholders and removing declaration lines
RUN sed -e "s/__CLOUD_MODE__/${API_CLOUD_MODE}/g" \
        -e "s/__DEVELOPMENT_MODE__/false/g" \
        -e "/declare const/d" \
        libs/ee/configs/environment/environment.template.ts > libs/ee/configs/environment/environment.ts

# Persist webpack's incremental filesystem cache (node_modules/.cache/webpack,
# the default when cache.type='filesystem' with no cacheDirectory — see
# webpack.config.js) across builds via a BuildKit cache mount. Without this the
# `COPY . .` above invalidates the layer on every source change and webpack
# recompiles all 6 apps from scratch (~3min). With it, only the changed modules
# rebuild → seconds. sharing=locked because build:apps runs the 6 nest builds in
# parallel against one shared cache dir.
RUN --mount=type=cache,target=/usr/src/app/node_modules/.cache,sharing=locked \
    pnpm run build:apps && pnpm run build:migrations

# Install production dependencies only
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml .npmrc ./
COPY packages/kodus-common ./packages/kodus-common
COPY packages/kodus-flow ./packages/kodus-flow

RUN --mount=type=secret,id=npmrc,target=/root/.npmrc,required=false \
    --mount=type=cache,target=/pnpm-store,sharing=shared \
    cd packages/kodus-common \
  && pnpm install --store-dir /pnpm-store \
  && pnpm run prepack
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc,required=false \
    --mount=type=cache,target=/pnpm-store,sharing=shared \
    cd packages/kodus-flow \
  && pnpm install --store-dir /pnpm-store \
  && pnpm run build

# --prod skips devDependencies (TypeScript, Nest CLI, Jest, ESLint, etc.)
# since the `build` stage already produced the compiled output in
# ../build/usr/src/app/dist. The shared pnpm store means packages already
# downloaded by `deps` are hardlinked, not re-fetched.
# github_token: same ripgrep-postinstall rate-limit story as `deps` —
# this stage re-runs postinstall scripts on its own node_modules.
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc,required=false \
    --mount=type=secret,id=github_token,required=false \
    --mount=type=cache,target=/pnpm-store,sharing=shared \
    if [ -s /run/secrets/github_token ]; then export GITHUB_TOKEN="$(cat /run/secrets/github_token)"; fi \
 && pnpm install --frozen-lockfile --prod --store-dir /pnpm-store

# Link local packages. Drop the nested node_modules/src/test that were
# needed for `pnpm run prepack` but not at runtime — keeping them would
# duplicate ~450MB inside the final image for no benefit. `dist/` and
# `package.json` are what Node actually resolves.
RUN rm -rf packages/kodus-common/node_modules packages/kodus-flow/node_modules \
           packages/kodus-common/src packages/kodus-flow/src \
           packages/kodus-common/test packages/kodus-flow/test
RUN rm -rf node_modules/@kodus/kodus-common && cp -r packages/kodus-common node_modules/@kodus/kodus-common
RUN rm -rf node_modules/@kodus/flow && cp -r packages/kodus-flow node_modules/@kodus/flow

# Dedicated stage for the bun binary. Using the official oven/bun image
# instead of `curl bun.sh/install | bash` because:
#   - Docker Hub CDN is more reliable for tagged images than GitHub releases
#     (the install script's internal curl hit 504s on GitHub during builds).
#   - Buildx caches the pulled image; subsequent builds skip the download.
#   - Eliminates `curl`/`unzip` installed just to delete them later.
# BUN_VERSION is declared as a global ARG at the top of this file.
FROM docker.io/oven/bun:${BUN_VERSION}-debian AS bun-source

FROM docker.io/library/node:22.22.2-slim AS runtime-common
LABEL org.opencontainers.image.source="https://github.com/kodustech/kodus-ai"
WORKDIR /usr/src/app
ENV NODE_ENV=production

# Redeclare ARGs to make them available in this stage
ARG API_CLOUD_MODE=false
ARG RELEASE_VERSION=local
ARG KODUS_GRAPH_VERSION=0.2.19

# Set ENVs for runtime
ENV API_CLOUD_MODE=${API_CLOUD_MODE}
ENV API_DEVELOPMENT_MODE=false
ENV RELEASE_VERSION=${RELEASE_VERSION}
ENV SENTRY_RELEASE=${RELEASE_VERSION}
ENV PATH="/home/node/.bun/bin:${PATH}"

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    rm -f /etc/apt/apt.conf.d/docker-clean \
  && apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates procps git ripgrep

# Copy the bun binary from the official image.
COPY --from=bun-source /usr/local/bin/bun /usr/local/bin/bun

COPY --chown=1000:1000 --from=prod-deps /usr/src/app/node_modules ./node_modules
COPY --chown=1000:1000 --from=build /usr/src/app/dist ./dist
COPY --chown=1000:1000 --from=build /usr/src/app/libs/agents/skills ./libs/agents/skills
COPY --chown=1000:1000 --from=build /usr/src/app/package.json ./package.json
COPY --chown=1000:1000 --from=build /usr/src/app/default-kodus-config.yml ./default-kodus-config.yml
COPY --chown=1000:1000 --from=build /usr/src/app/kodus-config.yml ./kodus-config.yml
COPY --chown=1000:1000 --from=build /usr/src/app/scripts ./scripts
COPY --chown=1000:1000 --from=build /usr/src/app/tsconfig-paths-bootstrap.js ./tsconfig-paths-bootstrap.js

COPY --chmod=0755 docker/prod-entrypoint.sh /usr/local/bin/prod-entrypoint
COPY --chmod=0755 docker/prod-entrypoint-mcp-manager.sh /usr/local/bin/prod-entrypoint-mcp-manager

# Ensure the working directory is owned by user 1000 so Node can read
# the tree as a non-root user. The image no longer writes files into
# /usr/src/app at runtime (TypeORM CLI logs stream to stdout via
# ormconfig.ts `logger: 'advanced-console'`), so this is strictly an
# ownership fix for the non-root USER 1000 below — not a write path.
RUN chown 1000:1000 /usr/src/app

USER 1000

# Install kodus-graph for the runtime user so self-hosted worker images can
# find it through $HOME/.bun/bin after dropping root privileges.
RUN bun install -g @kodus/kodus-graph@${KODUS_GRAPH_VERSION}
USER root
RUN printf '%s\n' '#!/bin/sh' 'exec /home/node/.bun/bin/kodus-graph "$@"' > /usr/local/bin/kodus-graph \
  && chmod 0755 /usr/local/bin/kodus-graph
USER 1000

ENTRYPOINT ["/usr/local/bin/prod-entrypoint"]

FROM runtime-common AS api
CMD ["node", "dist/apps/api/main.js"]
FROM runtime-common AS webhooks
CMD ["node", "dist/apps/webhooks/main.js"]
FROM runtime-common AS worker
CMD ["node", "dist/apps/worker/main.js"]
FROM runtime-common AS mcp-manager
ENTRYPOINT ["/usr/local/bin/prod-entrypoint-mcp-manager"]
CMD ["node", "dist/apps/mcp-manager/main.js"]
