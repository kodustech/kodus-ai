FROM docker.io/library/node:22.22.0-slim AS base
WORKDIR /usr/src/app

ARG API_CLOUD_MODE=false
ARG RELEASE_VERSION=local

ENV API_CLOUD_MODE=${API_CLOUD_MODE}
ENV API_DEVELOPMENT_MODE=false
ENV RELEASE_VERSION=${RELEASE_VERSION}
ENV SENTRY_RELEASE=${RELEASE_VERSION}

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates git python3 make g++ procps \
  && rm -rf /var/lib/apt/lists/*

RUN corepack disable \
  && npm i -g yarn@1.22.22

FROM base AS deps
COPY package.json yarn.lock .npmrc ./
COPY packages/kodus-common ./packages/kodus-common
COPY packages/kodus-flow ./packages/kodus-flow

# Build local packages first
RUN cd packages/kodus-common && yarn install && yarn prepack
RUN cd packages/kodus-flow && yarn install && yarn build

# Install dependencies and link local packages
RUN yarn install --frozen-lockfile
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

RUN yarn build:apps && yarn build:migrations

# Install production dependencies only
FROM base AS prod-deps
COPY package.json yarn.lock .npmrc ./
COPY packages/kodus-common ./packages/kodus-common
COPY packages/kodus-flow ./packages/kodus-flow

# Build local packages first
RUN cd packages/kodus-common && yarn install && yarn prepack
RUN cd packages/kodus-flow && yarn install && yarn build

# Install dependencies and link local packages
RUN yarn install --frozen-lockfile && yarn cache clean
RUN rm -rf node_modules/@kodus/kodus-common && cp -r packages/kodus-common node_modules/@kodus/kodus-common
RUN rm -rf node_modules/@kodus/flow && cp -r packages/kodus-flow node_modules/@kodus/flow

FROM docker.io/library/node:22.22.0-slim AS runtime-common
WORKDIR /usr/src/app
ENV NODE_ENV=production

# Redeclare ARGs to make them available in this stage
ARG API_CLOUD_MODE=false
ARG RELEASE_VERSION=local

# Set ENVs for runtime
ENV API_CLOUD_MODE=${API_CLOUD_MODE}
ENV API_DEVELOPMENT_MODE=false
ENV RELEASE_VERSION=${RELEASE_VERSION}
ENV SENTRY_RELEASE=${RELEASE_VERSION}

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates procps git ripgrep \
  && rm -rf /var/lib/apt/lists/*

COPY --chown=1000:1000 --from=prod-deps /usr/src/app/node_modules ./node_modules
COPY --chown=1000:1000 --from=build /usr/src/app/dist ./dist
COPY --chown=1000:1000 --from=build /usr/src/app/package.json ./package.json
COPY --chown=1000:1000 --from=build /usr/src/app/default-kodus-config.yml ./default-kodus-config.yml
COPY --chown=1000:1000 --from=build /usr/src/app/kodus-config.yml ./kodus-config.yml
COPY --chown=1000:1000 --from=build /usr/src/app/scripts ./scripts
COPY --chown=1000:1000 --from=build /usr/src/app/tsconfig-paths-bootstrap.js ./tsconfig-paths-bootstrap.js

COPY --chmod=0755 docker/prod-entrypoint.sh /usr/local/bin/prod-entrypoint

# Give ownership of working directory to user 1000 so they can create files (like ormlogs.log)
RUN chown 1000:1000 /usr/src/app

USER 1000

ENTRYPOINT ["/usr/local/bin/prod-entrypoint"]

FROM runtime-common AS api
CMD ["node", "dist/apps/api/main.js"]
FROM runtime-common AS webhooks
CMD ["node", "dist/apps/webhooks/main.js"]
FROM runtime-common AS worker
CMD ["node", "dist/apps/worker/main.js"]
