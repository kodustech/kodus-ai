#!/usr/bin/env bash
# Cloud E2E entry point. Validates env, then exec's the matrix runner against
# the existing cloud QA target (no provisioning required — cloud is permanent).
#
# Required env:
#   TARGET_BASE_URL          e.g. https://api-qa.kodus.io
#   TARGET_WEB_URL           e.g. https://app-qa.kodus.io
#   CLOUD_TENANT_PAID_EMAIL  + _PASSWORD  (and FREE/TRIAL variants for those scenarios)
#   GH_TEST_TOKEN, GH_TEST_REPO, GH_TEST_PR_NUMBER (and equivalents for GL/BB/AZ)
#
# Optional env:
#   MATRIX_FILE              default: matrix/fast.yml

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
E2E_ROOT="${REPO_ROOT}/tests/e2e"
MATRIX_FILE="${MATRIX_FILE:-matrix/fast.yml}"

GREEN='\033[0;32m'; RED='\033[0;31m'; BLUE='\033[0;34m'; NC='\033[0m'
log()  { echo -e "${BLUE}[cloud-e2e]${NC} $*"; }
ok()   { echo -e "${GREEN}[ok]${NC}        $*"; }
err()  { echo -e "${RED}[err]${NC}       $*" >&2; }

: "${TARGET_BASE_URL:?set TARGET_BASE_URL to the cloud API base URL}"
: "${TARGET_WEB_URL:?set TARGET_WEB_URL to the cloud dashboard base URL}"

log "Cloud target: api=$TARGET_BASE_URL web=$TARGET_WEB_URL matrix=$MATRIX_FILE"

cd "$E2E_ROOT"
if [ ! -d node_modules ]; then
    log "Installing e2e deps..."
    npm install --silent || npm install
fi

ok "Exec matrix runner"
# --skip-missing-tokens matches `scripts/e2e/run.sh matrix` (the local
# entry point): cells without the required provider token are SKIPPED
# instead of failing the run. Keeps the CI workflow runnable when a token
# is genuinely missing (e.g. paid-only provider in a community fork) and
# matches the local validated behaviour. Override by exporting
# E2E_NO_SKIP_MISSING_TOKENS=1.
SKIP_FLAG="--skip-missing-tokens"
[ "${E2E_NO_SKIP_MISSING_TOKENS:-}" = "1" ] && SKIP_FLAG=""
exec ./node_modules/.bin/tsx cli/run-matrix.ts "$MATRIX_FILE" --target cloud $SKIP_FLAG
