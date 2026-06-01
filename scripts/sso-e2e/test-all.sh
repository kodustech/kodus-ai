#!/usr/bin/env bash
# Runs every layer of the SSO regression test in a single command.
#
# Layers
#   1. Unit tests for the cookie-domain derivation (16 cases)
#   2. Controller integration tests with the real wiring (12 cases)
#   3. Smoke test of the prod web image in two host shapes
#      simultaneously (SaaS + Dmitry-style self-hosted)
#   4. (--e2e only) Full SAML round-trip via Keycloak + Caddy + browser
#
# Layers 1-3 are CI-safe (no network beyond local docker, no manual
# steps). Layer 4 is opt-in because it requires mkcert+sudo on the
# host and a manual browser interaction.
#
# Exit codes
#   0  all selected layers passed
#   1  a test failed; failure is printed inline above the summary
#   2  prerequisite missing (eg. docker not running)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

WITH_E2E=false
SKIP_BUILD=false
for arg in "$@"; do
    case "$arg" in
        --e2e)        WITH_E2E=true ;;
        --skip-build) SKIP_BUILD=true ;;
        --help|-h)
            cat <<EOF
Usage: $0 [--e2e] [--skip-build]

  --e2e         Also run the full SAML round-trip in a browser.
                Requires \`brew install mkcert && sudo mkcert -install\`
                on the host.
  --skip-build  Don't (re)build the kodus-web:test image even if
                missing. Use when you've just built it manually.
EOF
            exit 0
            ;;
        *)
            echo "error: unknown flag: ${arg}" >&2
            exit 2
            ;;
    esac
done

# ─────────────────────────────────────────────────────────────────
# Output helpers
# ─────────────────────────────────────────────────────────────────
RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; DIM=$'\033[2m'; BOLD=$'\033[1m'; RESET=$'\033[0m'

step()  { printf '\n%s━━━ %s ━━━%s\n' "${BOLD}" "$*" "${RESET}"; }
ok()    { printf '%s✓%s %s\n' "${GREEN}" "${RESET}" "$*"; }
fail()  { printf '%s✗%s %s\n' "${RED}"   "${RESET}" "$*"; }
info()  { printf '%s%s%s\n'   "${DIM}"   "$*"        "${RESET}"; }

# ─────────────────────────────────────────────────────────────────
# Cleanup smoke containers on any exit path
# ─────────────────────────────────────────────────────────────────
trap 'docker rm -f sso-smoke-cloud sso-smoke-selfhosted 2>/dev/null || true' EXIT

cd "${REPO_ROOT}"

# ─────────────────────────────────────────────────────────────────
# Step 0: prerequisites
# ─────────────────────────────────────────────────────────────────
if ! docker info >/dev/null 2>&1; then
    fail "docker is not running"
    exit 2
fi

# ─────────────────────────────────────────────────────────────────
# Step 1: unit + integration tests
# ─────────────────────────────────────────────────────────────────
step "Step 1/3 — unit + integration tests"
info "  apps/api/src/utils/__tests__/derive-sso-cookie-domain.spec.ts (16 cases)"
info "  apps/api/src/controllers/__tests__/auth.controller.sso-cookie.spec.ts (12 cases)"

if API_NODE_ENV=test node ./node_modules/.bin/jest --config jest.config.ts \
        apps/api/src/utils/__tests__/derive-sso-cookie-domain.spec.ts \
        apps/api/src/controllers/__tests__/auth.controller.sso-cookie.spec.ts \
        2>&1 | tail -8; then
    ok "unit + integration tests passed"
else
    fail "unit + integration tests failed"
    exit 1
fi

# ─────────────────────────────────────────────────────────────────
# Step 2: build kodus-web:test if missing
# ─────────────────────────────────────────────────────────────────
step "Step 2/3 — prod web image"
if docker image inspect kodus-web:test >/dev/null 2>&1; then
    ok "kodus-web:test already built"
elif [ "${SKIP_BUILD}" = "true" ]; then
    fail "kodus-web:test missing and --skip-build was passed"
    exit 1
else
    info "  building kodus-web:test via docker buildx bake"
    if WEB_TAGS=kodus-web:test RELEASE_VERSION=test \
            docker buildx bake -f docker-bake.hcl web 2>&1 | tail -3; then
        ok "kodus-web:test built"
    else
        fail "build failed"
        exit 1
    fi
fi

# ─────────────────────────────────────────────────────────────────
# Step 3: smoke test in two shapes
# ─────────────────────────────────────────────────────────────────
step "Step 3/3 — runtime smoke test (cloud + self-hosted shapes)"

# Same image, two containers, two shapes — proves the runtime config
# layer reads envs at request time (Bug 1 / force-dynamic) and that
# the URL builder produces the right apiPublicUrl for each topology.

docker rm -f sso-smoke-cloud sso-smoke-selfhosted 2>/dev/null || true

docker run -d --rm --name sso-smoke-cloud -p 33010:3000 \
    -e WEB_HOSTNAME_API=api.kodus.io \
    -e WEB_NODE_ENV=production \
    -e RELEASE_VERSION=smoke-cloud \
    kodus-web:test >/dev/null

docker run -d --rm --name sso-smoke-selfhosted -p 33011:3000 \
    -e WEB_HOSTNAME_API=kodus-api-dev.web.scorpion.co \
    -e WEB_NODE_ENV=production \
    -e RELEASE_VERSION=smoke-selfhosted \
    kodus-web:test >/dev/null

info "  waiting for both containers to serve /sign-in"
for i in $(seq 1 30); do
    # `|| true` because `set -e` would otherwise abort on curl exit 7
    # (connection refused) while the Next.js standalone server is
    # still starting up.
    cs=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:33010/sign-in || true)
    ss=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:33011/sign-in || true)
    if [ "${cs}" = "200" ] && [ "${ss}" = "200" ]; then
        break
    fi
    if [ $i -eq 30 ]; then
        fail "containers did not become ready in 60s (cloud=${cs} selfhosted=${ss})"
        exit 1
    fi
    sleep 2
done

# Pull the apiPublicUrl out of the inline runtime config script the
# layout writes into the HTML.
extract_api_url() {
    curl -s "http://localhost:$1/sign-in" \
        | grep -oE 'apiPublicUrl":"[^"]*"' \
        | head -1 \
        | sed 's/apiPublicUrl":"\([^"]*\)"/\1/'
}

cloud_url=$(extract_api_url 33010)
self_url=$(extract_api_url 33011)

info "  cloud shape       apiPublicUrl=${cloud_url}"
info "  self-hosted shape apiPublicUrl=${self_url}"

failures=0
if [ "${cloud_url}" = "https://api.kodus.io" ]; then
    ok "cloud shape resolves to https://api.kodus.io"
else
    fail "cloud shape: expected https://api.kodus.io, got '${cloud_url}'"
    failures=$((failures + 1))
fi

if [ "${self_url}" = "https://kodus-api-dev.web.scorpion.co" ]; then
    ok "self-hosted shape resolves to https://kodus-api-dev.web.scorpion.co"
else
    fail "self-hosted shape: expected https://kodus-api-dev.web.scorpion.co, got '${self_url}'"
    failures=$((failures + 1))
fi

if [ ${failures} -gt 0 ]; then
    exit 1
fi

# ─────────────────────────────────────────────────────────────────
# Step 4 (optional): full SAML round-trip
# ─────────────────────────────────────────────────────────────────
if [ "${WITH_E2E}" = "true" ]; then
    step "Step 4/4 — full SAML round-trip (browser, manual)"
    info "  delegating to scripts/sso-e2e/run.sh"
    bash "${HERE}/run.sh"
fi

# ─────────────────────────────────────────────────────────────────
# Summary
# ─────────────────────────────────────────────────────────────────
echo
printf '%s═══════════════════════════════════════════════════════════%s\n' "${GREEN}" "${RESET}"
printf '%s All SSO regression layers passed%s\n' "${GREEN}${BOLD}" "${RESET}"
printf '%s═══════════════════════════════════════════════════════════%s\n' "${GREEN}" "${RESET}"
echo "  Layer 1: unit + integration tests           28 cases"
echo "  Layer 2: kodus-web:test image               built"
echo "  Layer 3: runtime smoke (cloud + self-hosted) 2 shapes"
if [ "${WITH_E2E}" = "true" ]; then
echo "  Layer 4: full SAML round-trip               passed (manual verification)"
else
echo
echo "  ${YELLOW}skipped:${RESET} layer 4 (full browser SAML round-trip)"
echo "  rerun with --e2e to include it"
fi
