#!/usr/bin/env bash
# Seed extra Keycloak users and activate the existing Kodus SSO config so
# the sso-multi-user Playwright spec can drive sub-flows #2-#4 (sign-in
# button, new-user signup via SSO, removed-user rejection).
#
# Pre-conditions:
#   - provision.sh already ran for the droplet named SSO_E2E_DROPLET_NAME
#     (default "sso-e2e") and the seeded admin (sso-user@kodus-test.com)
#     posted /sso-config with active=false.
#
# What this script does on the droplet (via SSH):
#   1. Read KC admin password from /opt/kodus-installer/.env.
#   2. Create 2 extra Keycloak users via the admin REST API:
#         newbie-sso@kodus-test.com   (signup-via-SSO target)
#         removed-sso@kodus-test.com  (removed-user target)
#      Both have the same password as the existing test user.
#   3. UPDATE sso_config SET active = true WHERE organization_id = ORG_ID.
#      Plain SQL bypass — the API's create-or-update use case gates
#      active=true behind a successful /sso-config/test ceremony +
#      domain verification. Both have their own unit coverage; we only
#      need the runtime state (active=true) for the sign-in / signup
#      flows under test here.
#
# Idempotent: safe to re-run on the same droplet.
#
# Inputs (env):
#   SSO_E2E_DROPLET_NAME   default: sso-e2e
#   SSO_E2E_USER_PASSWORD  default: TestSso!2026  (matches bootstrap)
#
# Inputs (files under repo .tmp/):
#   sso-e2e-droplet.json   org_id + base URLs (written by provision.sh)
#
# Outputs:
#   .tmp/sso-e2e-multi-user.json   { newbie, removed, password }

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
# shellcheck disable=SC1091
. "${REPO_ROOT}/scripts/selfhosted/_common.sh"

NAME=$(normalize_name "${SSO_E2E_DROPLET_NAME:-sso-e2e}")
STATE_FILE=$(state_file_for "${NAME}")
LOCAL_SSH_KEY=$(ssh_key_path_for "${NAME}")

DROPLET_STATE="${REPO_ROOT}/.tmp/sso-e2e-droplet.json"
if [ ! -f "${DROPLET_STATE}" ]; then
    err "Missing ${DROPLET_STATE}. Run: pnpm run sso-e2e:droplet:provision --reuse"
    exit 1
fi
SERVER_IP=$(state_get "${NAME}" .server_ip)
ORG_ID=$(jq -r .org_id "${DROPLET_STATE}")
KC_BASE_URL=$(jq -r .kc_url "${DROPLET_STATE}")

if [ -z "${ORG_ID}" ] || [ "${ORG_ID}" = "null" ]; then
    err "org_id missing from ${DROPLET_STATE}"
    exit 1
fi

USER_PASSWORD="${SSO_E2E_USER_PASSWORD:-TestSso!2026}"
NEWBIE_EMAIL="newbie-sso@kodus-test.com"
REMOVED_EMAIL="removed-sso@kodus-test.com"

ssh_vm() {
    ssh -i "${LOCAL_SSH_KEY}" \
        -o StrictHostKeyChecking=no \
        -o UserKnownHostsFile=/dev/null \
        -o LogLevel=ERROR \
        -o ConnectTimeout=10 \
        "root@${SERVER_IP}" "$@"
}

log "Reading droplet config + seeding 2 extra Keycloak users"
ssh_vm \
    KC_BASE_URL="${KC_BASE_URL}" \
    NEWBIE_EMAIL="${NEWBIE_EMAIL}" \
    REMOVED_EMAIL="${REMOVED_EMAIL}" \
    USER_PASSWORD="${USER_PASSWORD}" \
    ORG_ID="${ORG_ID}" \
    bash -s <<'REMOTE'
set -euo pipefail

# Repair WEB_HOSTNAME_API / WEB_PORT_API on droplets provisioned
# before 2026-05-20: earlier provision.sh set WEB_HOSTNAME_API to the
# public sslip.io URL, which the kodus-web container can't reach via
# NAT loopback — every fetch through /api/proxy/api/* 500'd. The
# correct value is the Docker-internal API container address.
# Idempotent: if the values are already right, the sed is a no-op.
env_set() {
    local k=$1 v=$2
    if grep -qE "^${k}=" /opt/kodus-installer/.env; then
        sed -i "s|^${k}=.*|${k}=${v}|" /opt/kodus-installer/.env
    else
        echo "${k}=${v}" >> /opt/kodus-installer/.env
    fi
}
CURR_HOSTNAME=$(grep -E '^WEB_HOSTNAME_API=' /opt/kodus-installer/.env | head -1 | cut -d= -f2-)
if [ "${CURR_HOSTNAME}" != "api" ]; then
    echo "==> repairing WEB_HOSTNAME_API (was '${CURR_HOSTNAME}') -> api" >&2
    env_set WEB_HOSTNAME_API "api"
    env_set WEB_PORT_API "3001"
    cd /opt/kodus-installer && docker compose -p kodus-installer -f docker-compose.yml up -d --force-recreate kodus-web
fi
REMOTE

ssh_vm \
    KC_BASE_URL="${KC_BASE_URL}" \
    NEWBIE_EMAIL="${NEWBIE_EMAIL}" \
    REMOVED_EMAIL="${REMOVED_EMAIL}" \
    USER_PASSWORD="${USER_PASSWORD}" \
    ORG_ID="${ORG_ID}" \
    bash -s <<'REMOTE'
set -euo pipefail

KC_ADMIN_PASSWORD=$(grep -E '^SSO_E2E_KC_ADMIN_PASSWORD=' /opt/kodus-installer/.env | head -1 | cut -d= -f2-)
if [ -z "${KC_ADMIN_PASSWORD:-}" ]; then
    echo "error: SSO_E2E_KC_ADMIN_PASSWORD not present in /opt/kodus-installer/.env" >&2
    exit 1
fi

# Get admin token from master realm. Capture body + status separately
# so we can surface the actual KC failure (4xx, network) instead of an
# opaque "empty token" downstream.
TOKEN_RESP=$(curl -sk -o /tmp/kc-token.body -w '%{http_code}' \
    -X POST "${KC_BASE_URL}/realms/master/protocol/openid-connect/token" \
    -H "Content-Type: application/x-www-form-urlencoded" \
    -d "username=admin&password=${KC_ADMIN_PASSWORD}&grant_type=password&client_id=admin-cli")
if [ "${TOKEN_RESP}" != "200" ]; then
    echo "error: KC admin token HTTP ${TOKEN_RESP}" >&2
    head -c 500 /tmp/kc-token.body >&2
    echo >&2
    exit 1
fi
TOKEN=$(python3 -c "import json,sys; print(json.load(open('/tmp/kc-token.body'))['access_token'], end='')")
if [ -z "${TOKEN}" ]; then
    echo "error: empty admin token from Keycloak" >&2
    exit 1
fi

REALM="kodus-sso-e2e"
auth() { curl -sfk -H "Authorization: Bearer ${TOKEN}" "$@"; }

create_user() {
    local email=$1
    local existing
    existing=$(auth "${KC_BASE_URL}/admin/realms/${REALM}/users?email=${email}" \
        | python3 -c "import json,sys; d=json.load(sys.stdin); print(d[0]['id'] if d else '', end='')")
    if [ -z "${existing}" ]; then
        auth -X POST "${KC_BASE_URL}/admin/realms/${REALM}/users" \
            -H "Content-Type: application/json" \
            -d "{
                \"username\":\"${email}\",
                \"email\":\"${email}\",
                \"enabled\":true,
                \"emailVerified\":true,
                \"firstName\":\"SSO\",\"lastName\":\"Tester\",
                \"credentials\":[{\"type\":\"password\",\"value\":\"${USER_PASSWORD}\",\"temporary\":false}]
            }"
        echo "==> created KC user ${email}" >&2
    else
        echo "==> KC user ${email} exists" >&2
    fi
}

create_user "${NEWBIE_EMAIL}"
create_user "${REMOVED_EMAIL}"

# Activate the SSO config row directly. The create-or-update use case
# rejects active=true without a successful /sso-config/test session +
# verified domains — both have unit coverage. Sign-in / SSO check only
# reads `active` from the row.
echo "==> activating sso_config for org ${ORG_ID}" >&2

# Discover the postgres container + connection from the installer .env
# rather than hardcoding. The kodus-installer's compose names it
# `db_kodus_postgres` today but that's an implementation detail of
# the installer chart, not a contract.
PG_CONTAINER=$(docker ps --format '{{.Names}}' | grep -E '_postgres$|kodus[_-]postgres' | head -1)
PG_USER=$(grep -E '^API_PG_DB_USERNAME=' /opt/kodus-installer/.env | head -1 | cut -d= -f2-)
PG_DB=$(grep -E '^API_PG_DB_DATABASE=' /opt/kodus-installer/.env | head -1 | cut -d= -f2-)
if [ -z "${PG_CONTAINER}" ] || [ -z "${PG_USER}" ] || [ -z "${PG_DB}" ]; then
    echo "error: could not resolve PG container/user/db (container='${PG_CONTAINER}' user='${PG_USER}' db='${PG_DB}')" >&2
    exit 1
fi
echo "==> using ${PG_CONTAINER} as ${PG_USER}@${PG_DB}" >&2

docker exec -i "${PG_CONTAINER}" psql -U "${PG_USER}" -d "${PG_DB}" -v ON_ERROR_STOP=1 <<SQL
UPDATE sso_config
SET active = true
WHERE organization_id = '${ORG_ID}';
SQL

# Smoke check.
ACTIVE=$(docker exec -i "${PG_CONTAINER}" psql -U "${PG_USER}" -d "${PG_DB}" -At -c \
    "SELECT active FROM sso_config WHERE organization_id = '${ORG_ID}';")
if [ "${ACTIVE}" != "t" ]; then
    echo "error: sso_config.active is '${ACTIVE}' after update (expected 't')" >&2
    exit 1
fi
echo "==> sso_config.active = ${ACTIVE}" >&2
REMOTE

OUT="${REPO_ROOT}/.tmp/sso-e2e-multi-user.json"
jq -n \
    --arg newbie "${NEWBIE_EMAIL}" \
    --arg removed "${REMOVED_EMAIL}" \
    --arg password "${USER_PASSWORD}" \
    '{ newbie: $newbie, removed: $removed, password: $password }' \
    > "${OUT}"
ok "Wrote ${OUT}"
