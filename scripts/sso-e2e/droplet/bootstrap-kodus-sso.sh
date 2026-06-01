#!/usr/bin/env bash
# Sign up a Kodus tenant on the SSO E2E droplet, then configure SSO with
# the Keycloak IdP descriptor produced by bootstrap-keycloak-remote.sh.
#
# Runs FROM the local Mac (provision.sh calls this with the public
# droplet hostnames). Idempotent: signup that returns 4xx because the
# user already exists falls through to login.
#
# Inputs (env):
#   API_BASE_URL    https://api.<IP>.sslip.io                    (required)
#   KC_JSON_PATH    path to bootstrap-keycloak-remote.sh output  (required)
#   ADMIN_EMAIL     default: sso-user@kodus-test.com (matches SAML user)
#   ADMIN_PASSWORD  default: TestSso!2026
#   ADMIN_NAME      default: SSO Tester
#
# Outputs:
#   prints orgId on stdout, writes <state-dir>/sso-e2e-org-id.txt.

set -euo pipefail

API_BASE_URL="${API_BASE_URL:?missing API_BASE_URL}"
KC_JSON_PATH="${KC_JSON_PATH:?missing KC_JSON_PATH}"
ADMIN_EMAIL="${ADMIN_EMAIL:-sso-user@kodus-test.com}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-TestSso!2026}"
ADMIN_NAME="${ADMIN_NAME:-SSO Tester}"
OUT_DIR="${OUT_DIR:-$(pwd)/.tmp}"
mkdir -p "${OUT_DIR}"

if [ ! -f "${KC_JSON_PATH}" ]; then
    echo "error: KC_JSON_PATH=${KC_JSON_PATH} not found" >&2
    exit 1
fi

# `-k` because the Caddy ACME cert may briefly be Caddy-internal on
# first boot; we explicitly do NOT want to fail on TLS validation here.
# The Domain= attribute on the cookie (the actual subject under test)
# is independent of which CA signed the leaf.
curl_api() { curl -sk "$@"; }

# 1. Signup. Tolerant of 4xx — bug-for-bug compatible with the local
#    bootstrap-kodus.sh which also no-ops on conflict.
SIGNUP_CODE=$(curl_api -o /dev/null -w '%{http_code}' \
    -X POST "${API_BASE_URL}/auth/signUp" \
    -H "Content-Type: application/json" \
    -d "{\"name\":\"${ADMIN_NAME}\",\"email\":\"${ADMIN_EMAIL}\",\"password\":\"${ADMIN_PASSWORD}\"}")
echo "==> signup HTTP ${SIGNUP_CODE}" >&2

# 2. Login → access token
LOGIN_BODY=$(curl_api -X POST "${API_BASE_URL}/auth/login" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"${ADMIN_EMAIL}\",\"password\":\"${ADMIN_PASSWORD}\"}")
ACCESS_TOKEN=$(echo "${LOGIN_BODY}" | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    print('', end=''); sys.exit(0)
# Either { accessToken } or { data: { accessToken } } depending on API version.
tok = d.get('accessToken') or (d.get('data') or {}).get('accessToken') or ''
print(tok, end='')
")

if [ -z "${ACCESS_TOKEN}" ]; then
    echo "error: login at ${API_BASE_URL}/auth/login produced no accessToken" >&2
    echo "${LOGIN_BODY}" | head -c 600 >&2
    exit 1
fi

# 3. orgId — prefer the JWT payload (deterministic), fall back to /user/info.
JWT_BODY=$(echo "${ACCESS_TOKEN}" | awk -F. '{print $2}' | tr '_-' '/+')
PAD=$(( 4 - ${#JWT_BODY} % 4 )); [ $PAD -lt 4 ] && JWT_BODY="${JWT_BODY}$(printf '=%.0s' $(seq 1 $PAD))"
ORG_ID=$(printf '%s' "${JWT_BODY}" | base64 -d 2>/dev/null \
    | python3 -c "import json,sys; print((json.load(sys.stdin).get('organizationId') or ''), end='')")

if [ -z "${ORG_ID}" ]; then
    USER_INFO=$(curl_api "${API_BASE_URL}/user/info" -H "Authorization: Bearer ${ACCESS_TOKEN}")
    ORG_ID=$(echo "${USER_INFO}" | python3 -c "
import json, sys
def walk(o):
    if isinstance(o, dict):
        if o.get('organization', {}).get('uuid'):
            return o['organization']['uuid']
        if o.get('organizationId'):
            return o['organizationId']
        for v in o.values():
            r = walk(v)
            if r: return r
    return None
print(walk(json.load(sys.stdin)) or '', end='')
")
fi

if [ -z "${ORG_ID}" ]; then
    echo "error: orgId not resolvable from JWT or /user/info" >&2
    exit 1
fi
echo "==> orgId=${ORG_ID}" >&2
echo -n "${ORG_ID}" > "${OUT_DIR}/sso-e2e-org-id.txt"

# 4. SSO config (upsert).
DOMAIN="$(echo "${ADMIN_EMAIL}" | cut -d@ -f2)"

# Fetch any existing SSO config for the org. The createOrUpdate
# endpoint only updates when `uuid` is present in the body; without
# it, it CREATES a new row instead. Re-running provision would then
# leave multiple sso_config rows for the same org with stale certs
# from prior runs, and the SAML strategy might validate against the
# wrong one ("Invalid document signature" at /sso-callback). Always
# resolve the existing uuid first when present.
EXISTING_UUID=$(curl_api "${API_BASE_URL}/sso-config" \
    -H "Authorization: Bearer ${ACCESS_TOKEN}" \
    | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
def walk(o):
    if isinstance(o, dict):
        if o.get('uuid') and (o.get('protocol') or o.get('providerConfig')):
            return o['uuid']
        for v in o.values():
            r = walk(v)
            if r: return r
    if isinstance(o, list):
        for item in o:
            r = walk(item)
            if r: return r
    return None
print(walk(d) or '', end='')
")
if [ -n "${EXISTING_UUID}" ]; then
    echo "==> found existing SSO config uuid=${EXISTING_UUID} — will update in place" >&2
fi

PAYLOAD=$(EXISTING_UUID="${EXISTING_UUID}" KC_JSON_PATH="${KC_JSON_PATH}" DOMAIN="${DOMAIN}" python3 -c "
import json, os
kc = json.load(open(os.environ['KC_JSON_PATH']))
body = {
    'protocol': 'saml',
    'providerConfig': {
        'entryPoint': kc['entryPoint'],
        'idpIssuer': kc['idpIssuer'],
        'cert': kc['cert'],
    },
    'domains': [os.environ['DOMAIN']],
    # active=false matches bootstrap-kodus.sh: the API rejects
    # active=true without a prior /sso-config/test session, which
    # this fixture doesn't exercise. The cookie-domain code path
    # at /auth/sso/login/<orgId> works the same either way.
    'active': False,
}
if os.environ.get('EXISTING_UUID'):
    body['uuid'] = os.environ['EXISTING_UUID']
print(json.dumps(body))
")

SSO_RESP=$(curl_api -w '\n%{http_code}' -X POST "${API_BASE_URL}/sso-config" \
    -H "Authorization: Bearer ${ACCESS_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "${PAYLOAD}")
HTTP_CODE=$(echo "${SSO_RESP}" | tail -1)
SSO_BODY=$(echo "${SSO_RESP}" | sed '$d')

if [[ ! "${HTTP_CODE}" =~ ^2 ]]; then
    echo "error: POST /sso-config returned HTTP ${HTTP_CODE}" >&2
    echo "${SSO_BODY}" | head -c 600 >&2
    exit 1
fi
echo "==> POST /sso-config HTTP ${HTTP_CODE} (uuid=${EXISTING_UUID:-<new>})" >&2

echo "${ORG_ID}"
