#!/usr/bin/env bash
# Make a checkout (usually a fresh git worktree) able to run the test suite.
# Idempotent and cheap when everything is already in place: each step only
# acts when its artifact is missing.
#
# Runs from the pre-push hook and as the Orca repo setup script. Husky's
# hooks live in .husky/_, which is gitignored and created by `pnpm install`,
# so a brand-new worktree has no hooks until this has run once.

set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

ENV_DIR=libs/ee/configs/environment
if [[ ! -f "$ENV_DIR/environment.ts" ]]; then
    echo "[bootstrap] creating $ENV_DIR/environment.ts from environment.dev.ts"
    cp "$ENV_DIR/environment.dev.ts" "$ENV_DIR/environment.ts"
fi

if [[ ! -d node_modules ]]; then
    echo "[bootstrap] installing root dependencies"
    pnpm install --frozen-lockfile
fi

# apps/web is an isolated pnpm project with its own lockfile.
if [[ ! -d apps/web/node_modules ]]; then
    echo "[bootstrap] installing apps/web dependencies"
    pnpm web:install --frozen-lockfile
fi
