#!/usr/bin/env bash
# Provision a Kodus self-hosted droplet wired for the SSO cookie-domain
# E2E test, then run the Playwright SAML round-trip against it.
#
# What this script does:
#   1. Re-uses scripts/selfhosted/provision.sh to provision the base
#      stack (api/web/worker/webhooks/mcp/postgres/mongo/rabbit) on a
#      DigitalOcean droplet — same path as every other E2E droplet,
#      so secrets live in one place (~/.kodus-dev/config).
#   2. Layers Caddy + Keycloak on top via docker/sso-e2e/droplet/compose.yml.
#      Caddy fronts three sslip.io hostnames:
#          api.<IP>.sslip.io  → api:3001
#          app.<IP>.sslip.io  → kodus-web-prod:3000
#          kc.<IP>.sslip.io   → kc-sso-e2e:8080
#      with Let's Encrypt auto-issued certs (HTTP-01 over port 80).
#   3. Rewrites the API_URL / API_FRONTEND_URL on the droplet to the
#      public sslip.io hostnames so deriveSsoCookieDomain sees the
#      production-shape host headers.
#   4. Bootstraps Keycloak (realm + SAML client + test user) ON the
#      droplet via SSH.
#   5. Signs up a Kodus tenant + POSTs /sso-config with the IdP
#      descriptor FROM the local Mac (uses the public API URL).
#   6. Re-runs Keycloak bootstrap once orgId is known, so the SAML
#      client's ACS URL is bound to the real org.
#   7. Runs the Playwright SAML round-trip + asserts cookie Domain.
#
# Variables you need to have set BEFORE running (all already used by
# the existing selfhosted scripts — nothing new):
#   DIGITALOCEAN_TOKEN          DO API token         (via ~/.kodus-dev/config)
#   API_OPEN_AI_API_KEY         LLM key              (via ~/.kodus-dev/config)
#   API_OPENAI_FORCE_BASE_URL   (optional, e.g. Moonshot)
#   API_LLM_PROVIDER_MODEL      (optional)
#   KODUS_INSTALLER_PATH        (optional; default ../kodus-installer)
#   SSO_E2E_DROPLET_NAME        (optional; default "sso-e2e")
#   CADDY_ACME_EMAIL            (optional; default "sso-e2e@kodus.io")
#   CADDY_ACME_CA               (optional; default LE production)
#
# Usage:
#   pnpm run sso-e2e:droplet:provision                 # provision + run test
#   pnpm run sso-e2e:droplet:provision --skip-test     # provision only
#   pnpm run sso-e2e:droplet:provision --reuse         # reuse existing droplet

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"

# Reuse the selfhosted scripts' config loader. _common.sh sources
# ~/.kodus-dev/config and scripts/selfhosted/.env in the right order.
# shellcheck disable=SC1091
. "${REPO_ROOT}/scripts/selfhosted/_common.sh"

# ---------- args ----------
NAME_RAW="${SSO_E2E_DROPLET_NAME:-sso-e2e}"
SKIP_TEST=0
REUSE=0
HEADLESS="${SSO_E2E_HEADLESS:-1}"
while [ $# -gt 0 ]; do
    case "$1" in
        --name) NAME_RAW="$2"; shift 2 ;;
        --name=*) NAME_RAW="${1#--name=}"; shift ;;
        --skip-test) SKIP_TEST=1; shift ;;
        --reuse) REUSE=1; shift ;;
        --headed) HEADLESS=0; shift ;;
        -h|--help)
            grep -E '^#( |$)' "$0" | sed 's/^# \?//'
            exit 0 ;;
        *) err "Unknown arg: $1"; exit 2 ;;
    esac
done
NAME=$(normalize_name "$NAME_RAW")
STATE_FILE=$(state_file_for "$NAME")
LOCAL_SSH_KEY=$(ssh_key_path_for "$NAME")

CADDY_ACME_EMAIL="${CADDY_ACME_EMAIL:-sso-e2e@kodus.io}"
CADDY_ACME_CA="${CADDY_ACME_CA:-https://acme-v02.api.letsencrypt.org/directory}"
# TLS strategy for the droplet's sslip.io hostnames:
#   internal (default) → Caddy's local CA (instant, no ACME). Reliable
#                        because sslip.io is one globally-shared registered
#                        domain that chronically hits Let's Encrypt's
#                        per-domain rate limit (429 "too many certificates
#                        already issued for sslip.io"), which leaves kc.
#                        with no cert and times out the Keycloak bootstrap.
#   acme              → public LE certs (only when the limit is clear).
# Internal-CA certs are untrusted, so the run sets IGNORE_TLS=1 and
# Playwright/bootstrap tolerate them. Override with SSO_E2E_TLS_MODE=acme.
SSO_E2E_TLS_MODE="${SSO_E2E_TLS_MODE:-internal}"

# ---------- step 1: base droplet ----------
if [ "${REUSE}" = "1" ] && state_exists "${NAME}"; then
    log "Reusing existing droplet '${NAME}'"
    SERVER_IP=$(state_get "${NAME}" .server_ip)
else
    if state_exists "${NAME}"; then
        warn "Droplet '${NAME}' already exists (IP $(state_get "${NAME}" .server_ip))."
        warn "Pass --reuse to reuse it, or destroy first: pnpm run sso-e2e:droplet:destroy --name ${NAME}"
        exit 1
    fi
    log "Provisioning base Kodus stack on a fresh droplet (~5 min)…"
    # This droplet runs the full Kodus stack PLUS Keycloak (Quarkus/Java,
    # memory-hungry) PLUS local image builds/extracts. The default
    # s-2vcpu-4gb OOM/thrashes during the rabbitmq build + image extraction
    # and hangs the provision. Default to 8GB here (overridable via DO_SIZE).
    export DO_SIZE="${DO_SIZE:-s-4vcpu-8gb}"
    log "  droplet size: ${DO_SIZE}"
    "${REPO_ROOT}/scripts/selfhosted/provision.sh" --name "${NAME}"
    SERVER_IP=$(state_get "${NAME}" .server_ip)
fi

if [ -z "${SERVER_IP}" ]; then
    err "Failed to resolve droplet IP from state file ${STATE_FILE}"
    exit 1
fi
ok "Droplet '${NAME}' at ${SERVER_IP}"

# Hostnames derived from the droplet's public IP via sslip.io wildcard DNS.
# sslip.io resolves *.<ip>.sslip.io → <ip> for any prefix — no DNS setup
# required. Cookie Domain expected on the handoff cookie:
#       .<IP>.sslip.io     (6 labels for a /32 IPv4)
SSO_E2E_BASE="${SERVER_IP}.sslip.io"
API_BASE_URL="https://api.${SSO_E2E_BASE}"
APP_BASE_URL="https://app.${SSO_E2E_BASE}"
KC_BASE_URL="https://kc.${SSO_E2E_BASE}"

ssh_vm() {
    ssh -i "${LOCAL_SSH_KEY}" \
        -o StrictHostKeyChecking=no \
        -o UserKnownHostsFile=/dev/null \
        -o LogLevel=ERROR \
        -o ConnectTimeout=10 \
        "root@${SERVER_IP}" "$@"
}

scp_vm() {
    scp -i "${LOCAL_SSH_KEY}" \
        -o StrictHostKeyChecking=no \
        -o UserKnownHostsFile=/dev/null \
        -o LogLevel=ERROR \
        "$@"
}

# Keycloak admin password: minted fresh on every provision and paired
# with a `down -v` of the kc-sso-e2e container so KC bootstraps from
# scratch with this exact password. Why not just reuse an existing
# password from .env: KC_BOOTSTRAP_ADMIN_PASSWORD is honored only at
# the very first container start (when the admin user is created).
# After that, the env var is ignored and the admin keeps whatever
# password the FIRST boot set. On --reuse, the .env and the running
# KC's admin can drift (e.g. a previous broken run wrote a different
# password). The bootstrap then fails with an empty token + cryptic
# JSON decode error in python. Wiping kc-sso-e2e-data + force-recreate
# is the cheapest robust fix: ~45s extra on --reuse, and the realm /
# SAML client / test user are re-seeded by bootstrap-keycloak-remote.sh
# (already idempotent).
KC_ADMIN_PASSWORD="$(openssl rand -base64 24 | tr -d '=+/' | head -c 28)"

log "Public hostnames:"
log "  API       ${API_BASE_URL}"
log "  Web       ${APP_BASE_URL}"
log "  Keycloak  ${KC_BASE_URL}"

# ---------- step 2: align base stack to public hostnames ----------
# The base provision baked API_URL/API_FRONTEND_URL pointing at the raw
# IP (http://<IP>:3001 / :3000). For the SSO test we need them to point
# at the public TLS hostnames so the cookie domain calculation sees the
# production-shape Host header. Rewrite .env + restart the affected
# services. The rest of the stack (db, worker, etc.) is untouched.
log "Aligning .env on droplet to public hostnames"
ssh_vm bash -s <<REMOTE_ENV
set -euo pipefail
cd /opt/kodus-installer
env_set() {
    local k=\$1 v=\$2
    if grep -qE "^\${k}=" .env; then
        sed -i "s|^\${k}=.*|\${k}=\${v}|" .env
    else
        echo "\${k}=\${v}" >> .env
    fi
}
env_set API_URL "${API_BASE_URL}"
env_set API_FRONTEND_URL "${APP_BASE_URL}"
env_set NEXTAUTH_URL "${APP_BASE_URL}"
# WEB_HOSTNAME_API is the upstream the web container's /api/proxy/api/*
# server-side handler talks to. It MUST resolve from inside the
# kodus-web container — i.e. the Docker-internal API name, not the
# public sslip.io URL. NAT loopback to the droplet's own public IP
# fails inside the container, so pointing this at the public URL
# breaks every browser fetch routed through the proxy (e.g. the
# sign-in form's /auth/sso/check call). The public API origin lives
# in API_URL above for cookie-domain / SAML purposes — those code
# paths read API_URL directly, not WEB_HOSTNAME_API.
# Use the compose SERVICE name `api` (Docker DNS always resolves it on the
# shared network) — NOT the literal `kodus-api`, which matches neither the
# service (`api`) nor the container (`kodus_api`, GLOBAL_API_CONTAINER_NAME's
# installer default) and so 502s every web→API server-side call.
env_set WEB_HOSTNAME_API "api"
env_set WEB_PORT_API "3001"
# kodus-installer defaults API_NODE_ENV to "development" for the
# self-hosted dev experience. The SSO cookie code path explicitly
# bails out under development (returns no Domain, omits Secure)
# so the handoff cookie ends up host-only on api.<IP>.sslip.io and
# the browser refuses to send it to app.<IP>.sslip.io — confirmed
# at provision time on 2026-05-19. Force production here so the
# Domain attribute (the thing under test) actually lands.
env_set API_NODE_ENV "production"
# SSO config (POST /sso-config) is gated by the enterprise-tier license
# guard — without a license the org is "not on a supported plan" and the
# bootstrap aborts with HTTP 403. The matrix droplets get the license via
# selfhosted/provision.sh; this script builds its own .env, so inject it
# here too. The var name is KODUS_LICENSE_KEY — the customer-facing name
# SelfHostedLicenseService reads (do NOT prefix with API_). run.sh's SSO
# precheck guarantees SH_LICENSE_KEY is non-empty here. (JWT is base64url —
# safe for the sed '|' delimiter in env_set.)
env_set KODUS_LICENSE_KEY "${SH_LICENSE_KEY:-}"
# Web container's SSR fetches go to API_BASE_URL directly. Caddy
# terminates TLS so the cert chain is whatever ACME issued; Node trusts
# the public LE roots out of the box. No NODE_EXTRA_CA_CERTS mount.
env_set SSO_E2E_BASE "${SSO_E2E_BASE}"
env_set SSO_E2E_KC_ADMIN_PASSWORD "${KC_ADMIN_PASSWORD}"
REMOTE_ENV

# ---------- step 3: ship Caddy + Keycloak overlay ----------
log "Shipping SSO E2E overlay compose + Caddyfile"
ssh_vm "mkdir -p /opt/sso-e2e"

# Substitute \${BASE}/\${CADDY_*} in Caddyfile.tpl with the actual values
# before shipping. envsubst would be cleaner, but droplet may not have
# it; sed handles three placeholders trivially.
TMP_CADDYFILE="$(mktemp)"
if [ "${SSO_E2E_TLS_MODE}" = "acme" ]; then
    log "TLS mode: acme (public Let's Encrypt — may 429 on sslip.io)"
    sed \
        -e "s|\${BASE}|${SSO_E2E_BASE}|g" \
        -e "s|\${CADDY_ACME_EMAIL}|${CADDY_ACME_EMAIL}|g" \
        -e "s|\${CADDY_ACME_CA}|${CADDY_ACME_CA}|g" \
        "${REPO_ROOT}/docker/sso-e2e/droplet/Caddyfile.tpl" > "${TMP_CADDYFILE}"
else
    log "TLS mode: internal (Caddy local CA — no ACME/rate-limit; Playwright ignores TLS)"
    # Internal-CA template only needs ${BASE} substituted.
    sed -e "s|\${BASE}|${SSO_E2E_BASE}|g" \
        "${REPO_ROOT}/docker/sso-e2e/droplet/Caddyfile.internal.tpl" > "${TMP_CADDYFILE}"
fi

scp_vm "${TMP_CADDYFILE}" "root@${SERVER_IP}:/opt/sso-e2e/Caddyfile"
scp_vm "${REPO_ROOT}/docker/sso-e2e/droplet/compose.yml" "root@${SERVER_IP}:/opt/sso-e2e/compose.yml"
scp_vm "${SCRIPT_DIR}/bootstrap-keycloak-remote.sh" "root@${SERVER_IP}:/opt/sso-e2e/bootstrap-keycloak.sh"
ssh_vm "chmod +x /opt/sso-e2e/bootstrap-keycloak.sh"
rm -f "${TMP_CADDYFILE}"

# ---------- step 4: restart api/web with new env, boot overlay ----------
# Use an explicit project name (-p kodus-installer) so the overlay
# compose layers ONTO the existing base stack instead of spinning up
# a parallel project called "opt" (which would happen if Docker derived
# the project name from the parent of the first -f flag).
log "Restarting api+web with new env, booting Caddy + Keycloak overlay"
ssh_vm bash -s <<'REMOTE_BOOT'
set -euo pipefail
cd /opt/kodus-installer

# Recreate api + web so they pick up the new API_URL / API_FRONTEND_URL.
# Service names in the installer compose: `api`, `kodus-web`.
docker compose -p kodus-installer up -d --force-recreate api kodus-web

# Wipe + recreate Keycloak so it bootstraps fresh with the password
# we just wrote to .env. KC_BOOTSTRAP_ADMIN_PASSWORD is only honored
# on the very first start (when the admin user is created), so if a
# prior run left an admin user with a stale password, subsequent
# admin-API calls fail with empty tokens. Cheapest robust fix: drop
# the kc-sso-e2e-data volume + force-recreate. The realm, SAML client
# and test user are re-seeded by bootstrap-keycloak.sh — idempotent
# by design — so wiping doesn't lose anything that survives a
# provision invocation anyway.
docker compose \
    -p kodus-installer \
    -f /opt/kodus-installer/docker-compose.yml \
    -f /opt/sso-e2e/compose.yml \
    --env-file /opt/kodus-installer/.env \
    rm -fsv kc-sso-e2e || true
docker volume rm -f kodus-installer_kc-sso-e2e-data 2>/dev/null || true

# Layer the overlay. Caddy stays (no-recreate); KC comes up fresh.
docker compose \
    -p kodus-installer \
    -f /opt/kodus-installer/docker-compose.yml \
    -f /opt/sso-e2e/compose.yml \
    --env-file /opt/kodus-installer/.env \
    up -d --no-recreate caddy-sso-e2e kc-sso-e2e
REMOTE_BOOT

# ---------- step 5: wait for Caddy TLS ----------
log "Waiting for Caddy to terminate TLS at ${API_BASE_URL}"
# Prime each host so Caddy provisions its cert (LE issuance or local CA).
CURL_DROP=(curl -sk -o /dev/null -w '%{http_code}')
for url in "${API_BASE_URL}/health" "${APP_BASE_URL}" "${KC_BASE_URL}/realms/master"; do
    "${CURL_DROP[@]}" "${url}" >/dev/null || true
done

if [ "${SSO_E2E_TLS_MODE}" = "acme" ]; then
    # Public LE: only consider TLS up once it validates WITHOUT -k.
    TLS_OK=0
    for i in $(seq 1 90); do
        api_code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 6 "${API_BASE_URL}/health" || echo 000)
        if [ "${api_code}" = "200" ]; then
            if curl -s --max-time 6 -o /dev/null "${API_BASE_URL}/health"; then
                TLS_OK=1
                break
            fi
        fi
        sleep 4
    done
    if [ "${TLS_OK}" = "0" ]; then
        warn "Public TLS not validated — Caddy likely fell back to its internal CA (LE rate limit?)."
        warn "Re-run with SSO_E2E_TLS_MODE=internal (the default) to skip ACME entirely."
        IGNORE_TLS=1
    else
        ok "Public TLS chain valid"
        IGNORE_TLS=0
    fi
else
    # Internal CA: Caddy mints a local-CA cert for each host immediately,
    # so there is no ACME/rate-limit step to wait on. Confirm the API
    # answers over TLS (accepting the self-signed cert with -k). The cert
    # is untrusted by design → Playwright ignores it (IGNORE_TLS=1) and the
    # bootstrap curls already use -k.
    TLS_OK=0
    for i in $(seq 1 90); do
        code=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 6 "${API_BASE_URL}/health" || echo 000)
        [ "${code}" = "200" ] && { TLS_OK=1; break; }
        sleep 4
    done
    if [ "${TLS_OK}" = "0" ]; then
        err "API never answered over Caddy internal-CA TLS at ${API_BASE_URL}"
        exit 1
    fi
    ok "Caddy internal-CA TLS up (untrusted — Playwright will ignore)"
    IGNORE_TLS=1
fi

# ---------- step 6: bootstrap Keycloak (pass 1, wildcard ACS) ----------
log "Bootstrapping Keycloak realm + SAML client (pass 1)"
KC_JSON_LOCAL="${REPO_ROOT}/.tmp/sso-e2e-droplet-keycloak.json"
mkdir -p "${REPO_ROOT}/.tmp"

ssh_vm "KC_BASE_URL='${KC_BASE_URL}' \
        KC_ADMIN_PASSWORD='${KC_ADMIN_PASSWORD}' \
        API_BASE_URL='${API_BASE_URL}' \
        ORG_ID='*' \
        bash /opt/sso-e2e/bootstrap-keycloak.sh" > "${KC_JSON_LOCAL}"

if [ ! -s "${KC_JSON_LOCAL}" ]; then
    err "bootstrap-keycloak (pass 1) produced empty output"
    exit 1
fi

# ---------- step 7: signup Kodus tenant + post SSO config ----------
log "Signing up Kodus tenant + posting SSO config"
ORG_ID=$(API_BASE_URL="${API_BASE_URL}" \
    KC_JSON_PATH="${KC_JSON_LOCAL}" \
    OUT_DIR="${REPO_ROOT}/.tmp" \
    bash "${SCRIPT_DIR}/bootstrap-kodus-sso.sh")

# ---------- step 8: bootstrap Keycloak (pass 2, real ACS) ----------
log "Re-bootstrapping Keycloak with real orgId=${ORG_ID}"
ssh_vm "KC_BASE_URL='${KC_BASE_URL}' \
        KC_ADMIN_PASSWORD='${KC_ADMIN_PASSWORD}' \
        API_BASE_URL='${API_BASE_URL}' \
        ORG_ID='${ORG_ID}' \
        bash /opt/sso-e2e/bootstrap-keycloak.sh" > "${KC_JSON_LOCAL}"

# ---------- step 9: persist state ----------
STATE_JSON="$(jq -n \
    --arg base "${SSO_E2E_BASE}" \
    --arg api "${API_BASE_URL}" \
    --arg app "${APP_BASE_URL}" \
    --arg kc "${KC_BASE_URL}" \
    --arg org "${ORG_ID}" \
    --arg ignore_tls "${IGNORE_TLS}" \
    '{
        base: $base,
        api_url: $api,
        app_url: $app,
        kc_url: $kc,
        org_id: $org,
        ignore_tls: $ignore_tls
    }')"
echo "${STATE_JSON}" > "${REPO_ROOT}/.tmp/sso-e2e-droplet.json"
ok "Saved test state to .tmp/sso-e2e-droplet.json"

cat <<EOF

══════════════════════════════════════════════════════════════════
 SSO E2E droplet ready
══════════════════════════════════════════════════════════════════
  Droplet     ${SERVER_IP} (name: ${NAME})
  API         ${API_BASE_URL}
  Web         ${APP_BASE_URL}
  Keycloak    ${KC_BASE_URL}  (admin / ${KC_ADMIN_PASSWORD})
  Org         ${ORG_ID}
  TLS chain   $( [ "${IGNORE_TLS}" = "0" ] && echo "Let's Encrypt (trusted)" || echo "Caddy internal — Playwright will ignore" )

  Test user   sso-user@kodus-test.com / TestSso!2026

  Run test    pnpm run sso-e2e:droplet:run
  Destroy     pnpm run sso-e2e:droplet:destroy --name ${NAME}

EOF

# ---------- step 10: run Playwright ----------
if [ "${SKIP_TEST}" = "1" ]; then
    log "Skipping Playwright (--skip-test). Run later: pnpm run sso-e2e:droplet:run"
    exit 0
fi

log "Running Playwright cookie-domain test against droplet"
cd "${REPO_ROOT}/tests/e2e/playwright"
if [ ! -d node_modules ]; then
    log "Installing Playwright (first run only)"
    npm install --no-audit --no-fund --silent
    npx playwright install chromium --with-deps 2>/dev/null \
        || npx playwright install chromium
fi

env \
    SSO_E2E_API_URL="${API_BASE_URL}" \
    SSO_E2E_APP_URL="${APP_BASE_URL}" \
    SSO_E2E_BASE="${SSO_E2E_BASE}" \
    SSO_E2E_ORG_ID="${ORG_ID}" \
    SSO_E2E_IGNORE_TLS="${IGNORE_TLS}" \
    SSO_E2E_HEADLESS="${HEADLESS}" \
    node sso-cookie-domain.mjs
