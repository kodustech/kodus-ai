#!/usr/bin/env bash
# Orchestrates the sso-multi-user E2E:
#   1. Ensures the sso-e2e droplet is up (provision.sh --reuse).
#   2. Seeds the 2 extra Keycloak users + flips sso_config.active=true
#      via bootstrap-multi-user.sh.
#   3. Runs the Playwright spec.
#
# Usage:
#   pnpm run sso-e2e:droplet:multi-user             # headless
#   pnpm run sso-e2e:droplet:multi-user --headed    # visible Chromium

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"

HEADLESS="${SSO_E2E_HEADLESS:-1}"
NAME="${SSO_E2E_DROPLET_NAME:-sso-e2e}"
while [ $# -gt 0 ]; do
    case "$1" in
        --headed) HEADLESS=0; shift ;;
        --headless) HEADLESS=1; shift ;;
        --name) NAME="$2"; shift 2 ;;
        --name=*) NAME="${1#--name=}"; shift ;;
        -h|--help)
            grep -E '^#( |$)' "$0" | sed 's/^# \?//'
            exit 0 ;;
        *) echo "Unknown arg: $1" >&2; exit 2 ;;
    esac
done

# Step 1: ensure droplet alive + base SSO config posted.
"${SCRIPT_DIR}/provision.sh" --name "${NAME}" --reuse --skip-test

# Step 2: seed extra users + flip active=true.
SSO_E2E_DROPLET_NAME="${NAME}" \
    bash "${SCRIPT_DIR}/bootstrap-multi-user.sh"

# Step 3: read state + run Playwright.
STATE="${REPO_ROOT}/.tmp/sso-e2e-droplet.json"
MULTI_STATE="${REPO_ROOT}/.tmp/sso-e2e-multi-user.json"

API_URL=$(jq -r .api_url "${STATE}")
APP_URL=$(jq -r .app_url "${STATE}")
BASE=$(jq -r .base "${STATE}")
ORG_ID=$(jq -r .org_id "${STATE}")
IGNORE_TLS=$(jq -r .ignore_tls "${STATE}")
NEWBIE=$(jq -r .newbie "${MULTI_STATE}")
REMOVED=$(jq -r .removed "${MULTI_STATE}")
USER_PASSWORD=$(jq -r .password "${MULTI_STATE}")

cd "${REPO_ROOT}/tests/e2e/playwright"
if [ ! -d node_modules ]; then
    echo "==> installing Playwright (first run only)"
    npm install --no-audit --no-fund --silent
    npx playwright install chromium --with-deps 2>/dev/null \
        || npx playwright install chromium
fi

env_extra=()
if [ "${IGNORE_TLS}" = "1" ]; then
    env_extra+=(NODE_TLS_REJECT_UNAUTHORIZED=0)
fi

env \
    "${env_extra[@]+"${env_extra[@]}"}" \
    SSO_E2E_API_URL="${API_URL}" \
    SSO_E2E_APP_URL="${APP_URL}" \
    SSO_E2E_BASE="${BASE}" \
    SSO_E2E_ORG_ID="${ORG_ID}" \
    SSO_E2E_NEWBIE_EMAIL="${NEWBIE}" \
    SSO_E2E_REMOVED_EMAIL="${REMOVED}" \
    SSO_E2E_USER_PASSWORD="${USER_PASSWORD}" \
    SSO_E2E_IGNORE_TLS="${IGNORE_TLS}" \
    SSO_E2E_HEADLESS="${HEADLESS}" \
    node sso-multi-user.mjs
