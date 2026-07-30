#!/usr/bin/env bash
# Run the SSO cookie-domain Playwright test against an already-provisioned
# droplet (no provisioning, no signup — just the test). Useful for
# iterating on the Playwright spec without paying the 5-min droplet
# spin-up tax every time.
#
# Reads droplet state from .tmp/sso-e2e-droplet.json, which provision.sh
# wrote on its successful run. If that file is missing, exit with a
# pointer to provision.sh.
#
# Usage:
#   pnpm run sso-e2e:droplet:run             # headless
#   pnpm run sso-e2e:droplet:run --headed    # visible Chromium window

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
STATE="${REPO_ROOT}/.tmp/sso-e2e-droplet.json"

HEADLESS="${SSO_E2E_HEADLESS:-1}"
while [ $# -gt 0 ]; do
    case "$1" in
        --headed) HEADLESS=0; shift ;;
        --headless) HEADLESS=1; shift ;;
        -h|--help)
            grep -E '^#( |$)' "$0" | sed 's/^# \?//'
            exit 0 ;;
        *) echo "Unknown arg: $1" >&2; exit 2 ;;
    esac
done

if [ ! -f "${STATE}" ]; then
    cat >&2 <<EOF
error: no droplet state at ${STATE}

Provision a droplet first:
    pnpm run sso-e2e:droplet:provision
EOF
    exit 1
fi

API_URL=$(jq -r .api_url "${STATE}")
APP_URL=$(jq -r .app_url "${STATE}")
BASE=$(jq -r .base "${STATE}")
ORG_ID=$(jq -r .org_id "${STATE}")
IGNORE_TLS=$(jq -r .ignore_tls "${STATE}")

cd "${REPO_ROOT}/tests/e2e/playwright"
if [ ! -d node_modules ]; then
    echo "==> installing Playwright (first run only)"
    npm install --no-audit --no-fund --silent
    npx playwright install chromium --with-deps 2>/dev/null \
        || npx playwright install chromium
fi

env \
    SSO_E2E_API_URL="${API_URL}" \
    SSO_E2E_APP_URL="${APP_URL}" \
    SSO_E2E_BASE="${BASE}" \
    SSO_E2E_ORG_ID="${ORG_ID}" \
    SSO_E2E_IGNORE_TLS="${IGNORE_TLS}" \
    SSO_E2E_HEADLESS="${HEADLESS}" \
    node sso-cookie-domain.mjs
