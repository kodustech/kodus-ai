#!/bin/sh
set -eu

# Point pnpm at a named-volume store mounted AT pnpm's natural store path
# (`<project>/.pnpm-store`), declared in docker-compose.dev.yml and shared
# across services so one install populates the store once (pnpm's
# content-addressable store is safe under concurrent access).
#
# Why this exact path and not a separate mount like /pnpm-store: pnpm derives
# the store location from the project root's drive and, when an explicit
# store-dir sits on a DIFFERENT filesystem, falls back to `<root>/.pnpm-store`.
# On macOS the project root is a bind mount (FUSE/virtiofs), so that fallback
# put the store's index.db on the bind mount — where finalizing it HANGS the
# pnpm process on exit (it never releases the dependency-install lock, and
# every other service then waits forever). Mounting the fast named volume at
# `.pnpm-store` keeps pnpm's chosen path off the bind mount. Cross-volume vs
# node_modules means copy (not hardlink), which the +x-restore step below fixes.
export npm_config_store_dir=/usr/src/app/.pnpm-store
mkdir -p "$npm_config_store_dir"

echo "▶ dev-entrypoint: starting (NODE_ENV=${NODE_ENV:-})"

# ----------------------------------------------------------------
# Dynamic Environment Configuration
# ----------------------------------------------------------------
# Generates the environment.ts file at runtime based on ENV vars.
# This allows changing CLOUD_MODE/DEV_MODE without rebuilding.
# ----------------------------------------------------------------
CLOUD_MODE=${API_CLOUD_MODE:-false}
DEV_MODE=${API_DEVELOPMENT_MODE:-true}

echo "▶ Configuring Environment..."
echo "  - API_CLOUD_MODE: $CLOUD_MODE"
echo "  - API_DEVELOPMENT_MODE: $DEV_MODE"

sed -e "s/__CLOUD_MODE__/${CLOUD_MODE}/g" \
    -e "s/__DEVELOPMENT_MODE__/${DEV_MODE}/g" \
    -e "/declare const/d" \
    libs/ee/configs/environment/environment.template.ts > libs/ee/configs/environment/environment.ts

# Fingerprint of dependency manifests used to detect stale node_modules volume.
DEPS_FINGERPRINT=$(node -e "const fs=require('fs'); const crypto=require('crypto'); const h=crypto.createHash('sha256'); h.update(fs.readFileSync('package.json')); h.update('\\n'); h.update(fs.readFileSync('pnpm-lock.yaml')); process.stdout.write(h.digest('hex'));")
DEPS_STAMP_FILE="node_modules/.deps-fingerprint"
DEPS_LOCK_DIR="node_modules/.deps-install.lock"

acquire_deps_lock() {
  mkdir -p node_modules
  WAIT_SECONDS=0
  until mkdir "$DEPS_LOCK_DIR" 2>/dev/null; do
    WAIT_SECONDS=$((WAIT_SECONDS + 2))
    if [ "$WAIT_SECONDS" -ge 360 ]; then
      echo "✖ Timeout waiting for dependency install lock ($DEPS_LOCK_DIR)"
      exit 1
    fi
    echo "▶ Waiting for dependency lock... (${WAIT_SECONDS}s)"
    sleep 2
  done
}

release_deps_lock() {
  rm -rf "$DEPS_LOCK_DIR"
}

install_deps() {
  FORCE_CLEAN="${1:-false}"
  acquire_deps_lock
  trap 'release_deps_lock' EXIT INT TERM

  # Another service may have installed deps while we were waiting for the lock.
  if [ "$FORCE_CLEAN" != "true" ] && [ -x node_modules/.bin/nest ] && [ -f "$DEPS_STAMP_FILE" ]; then
    LOCKED_INSTALLED_FINGERPRINT=$(cat "$DEPS_STAMP_FILE" || true)
    if [ "$LOCKED_INSTALLED_FINGERPRINT" = "$DEPS_FINGERPRINT" ]; then
      echo "▶ Dependencies already synchronized by another service."
      release_deps_lock
      trap - EXIT INT TERM
      return
    fi
  fi

  if [ "$FORCE_CLEAN" = "true" ]; then
    rm -rf node_modules
    mkdir -p node_modules
  fi

  echo "▶ Installing deps (pnpm install --frozen-lockfile)…"
  # pnpm 11 refuses to purge node_modules non-interactively when the
  # manifests drift (e.g. after a branch switch), aborting with
  # ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY. This entrypoint never runs
  # against a TTY, so tell pnpm to skip the confirmation and just sync.
  CI=true pnpm install --frozen-lockfile --config.confirm-modules-purge=false

  # pnpm's hoisted node-linker copies packages into node_modules, and the
  # /pnpm-store cache lives on a SEPARATE docker volume (different filesystem),
  # so pnpm can't hardlink — it copies, and the copy drops the +x bit on bin
  # targets. Shebang execs (ts-node, nest, typeorm…) then die with
  # "Permission denied". Restore +x on every file the .bin symlinks point to.
  echo "▶ Restoring executable bit on node_modules/.bin targets…"
  find node_modules/.bin -maxdepth 1 -type l 2>/dev/null | while read -r link; do
    target=$(readlink -f "$link" 2>/dev/null) || continue
    [ -f "$target" ] && chmod +x "$target" 2>/dev/null || true
  done
  mkdir -p node_modules
  printf "%s" "$DEPS_FINGERPRINT" > "$DEPS_STAMP_FILE"

  release_deps_lock
  trap - EXIT INT TERM
}

# 1. Install dependencies if necessary
if [ ! -x node_modules/.bin/nest ]; then
  install_deps
fi

# 1a. Install deps when package.json or yarn.lock changed since last successful install.
if [ -f "$DEPS_STAMP_FILE" ]; then
  INSTALLED_FINGERPRINT=$(cat "$DEPS_STAMP_FILE" || true)
else
  INSTALLED_FINGERPRINT=""
fi
if [ "$INSTALLED_FINGERPRINT" != "$DEPS_FINGERPRINT" ]; then
  echo "▶ Dependency manifests changed; syncing node_modules..."
  install_deps
fi

# 1b. Ensure @nestjs/common exports are valid (guard against broken node_modules)
if ! node -e "const { Module } = require('@nestjs/common'); process.exit(typeof Module === 'function' ? 0 : 1)"; then
  echo "▶ @nestjs/common export invalid; reinstalling deps..."
  install_deps true
fi

# 1c. Ensure zod v4 runtime files are present (guard against partial/broken installs)
if [ ! -f node_modules/zod/v4/core/util.js ]; then
  echo "▶ zod runtime files missing; reinstalling deps..."
  install_deps true
fi

# 2. Run Migrations and Seeds (if configured)
RUN_MIGRATIONS="${RUN_MIGRATIONS:-false}"
RUN_SEEDS="${RUN_SEEDS:-false}"

if [ "$RUN_MIGRATIONS" = "true" ]; then
  echo "▶ Running OLTP migrations..."
  npm run migration:run:internal
  # TypeORM tries to create its `migrations` tracking table inside the
  # configured schema BEFORE running any migration. The first analytics
  # migration creates the schema, so the tracking table create dies with
  # `schema "analytics" does not exist`. This fallback handles existing
  # volumes (dev/CI) where the initdb create_analytics_schema.sql didn't
  # run. Idempotent.
  echo "▶ Ensuring analytics schema exists..."
  npm run analytics:ensure-schema
  echo "▶ Running analytics warehouse migrations..."
  # Same Postgres host in self-hosted / dev; the loader cascades from
  # ANALYTICS_PG_DB_* to API_PG_DB_* when the dedicated host is unset.
  npm run analytics:migration:run:internal
  # MCP manager owns its own schema and runs ensure-schema +
  # migrations from its own service command (see docker-compose.dev.yml).
else
  echo "▶ Skipping Migrations (RUN_MIGRATIONS=$RUN_MIGRATIONS)"
fi

if [ "$RUN_SEEDS" = "true" ]; then
  echo "▶ Running Seeds..."
  npm run seed:internal
else
  echo "▶ Skipping Seeds (RUN_SEEDS=$RUN_SEEDS)"
fi

# 4. Execute container command (Full flexibility)
# If no command is passed, use nodemon as fallback
if [ $# -eq 0 ]; then
    echo "▶ No command specified, defaulting to nodemon..."
    exec nodemon --config nodemon.json
else
    echo "▶ Executing command: $@"
    exec "$@"
fi
