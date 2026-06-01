#!/usr/bin/env bash
# Bootstrap a Kodus tenant for the SSO E2E test:
#   1. Sign up `sso-user@kodus-test.com` (creates user + organization).
#   2. Login → access token.
#   3. Read the new organization id from /user/info.
#   4. POST /sso-config with the Keycloak IdP descriptor produced by
#      bootstrap-keycloak.sh.
#
# Idempotent in spirit: signup that fails because the user already
# exists falls through to login, and the SSO config endpoint is
# upsert-style.
#
# Outputs `.tmp/sso-e2e-org-id.txt` with the orgId — bootstrap-keycloak.sh
# reads this on its second pass to write the correct ACS callback URL.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SSO_E2E_DOMAIN="${SSO_E2E_DOMAIN:-kodus.lvh.me}"
API="${API_URL:-https://api.${SSO_E2E_DOMAIN}}"
# mkcert installs a local CA; if `sudo mkcert -install` was run, curl
# trusts the cert via the system trust store. Otherwise we point curl
# at the mkcert CA root explicitly via this wrapper.
CAROOT="${MKCERT_CAROOT:-$(mkcert -CAROOT 2>/dev/null || true)}"
api_curl() {
    if [ -n "${CAROOT}" ] && [ -f "${CAROOT}/rootCA.pem" ]; then
        curl --cacert "${CAROOT}/rootCA.pem" "$@"
    else
        curl "$@"
    fi
}
KC_OUTPUT="${REPO_ROOT}/.tmp/sso-e2e-keycloak.json"
ORG_ID_FILE="${REPO_ROOT}/.tmp/sso-e2e-org-id.txt"

# Local-only test fixtures. `kodus-test.com` is a fictitious domain
# (does not exist in DNS); the password is shared with bootstrap-keycloak.sh
# so the same credential opens both ends of the test fixture. Both
# stacks live entirely inside docker compose volumes that `down -v`
# wipes. Override via env if you want different fixtures, but never
# put real-org credentials here.
ADMIN_EMAIL="${SSO_E2E_ADMIN_EMAIL:-sso-user@kodus-test.com}"
ADMIN_PASSWORD="${SSO_E2E_ADMIN_PASSWORD:-TestSso!2026}"
ADMIN_NAME="${SSO_E2E_ADMIN_NAME:-SSO Tester}"

if [ ! -f "${KC_OUTPUT}" ]; then
    echo "error: ${KC_OUTPUT} not found — run bootstrap-keycloak.sh first" >&2
    exit 1
fi

# 1. Signup (HTTP 4xx if user already exists — that's fine, we'll login below)
echo "==> signing up ${ADMIN_EMAIL}"
SIGNUP_RESPONSE=$(api_curl -s -o /dev/null -w "%{http_code}" \
    -X POST "${API}/auth/signUp" \
    -H "Content-Type: application/json" \
    -d "{\"name\":\"${ADMIN_NAME}\",\"email\":\"${ADMIN_EMAIL}\",\"password\":\"${ADMIN_PASSWORD}\"}")
echo "    HTTP ${SIGNUP_RESPONSE}"

# 2. Login → access token
echo "==> logging in ${ADMIN_EMAIL}"
LOGIN_BODY=$(api_curl -sf -X POST "${API}/auth/login" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"${ADMIN_EMAIL}\",\"password\":\"${ADMIN_PASSWORD}\"}")
ACCESS_TOKEN=$(echo "${LOGIN_BODY}" | sed -n 's/.*"accessToken":"\([^"]*\)".*/\1/p')

if [ -z "${ACCESS_TOKEN}" ]; then
    echo "error: failed to obtain access token from login response" >&2
    echo "${LOGIN_BODY}" >&2
    exit 1
fi

# 3. orgId from /user/info
echo "==> fetching user info"
USER_INFO=$(api_curl -sf "${API}/user/info" -H "Authorization: Bearer ${ACCESS_TOKEN}")
ORG_ID=$(echo "${USER_INFO}" \
    | python3 -c "
import json, sys
data = json.load(sys.stdin)
# Walk the response shape — varies a bit; try the common locations.
def find_uuid(obj):
    if isinstance(obj, dict):
        if obj.get('organization', {}).get('uuid'):
            return obj['organization']['uuid']
        for v in obj.values():
            found = find_uuid(v)
            if found:
                return found
    return None
print(find_uuid(data) or '', end='')
")

if [ -z "${ORG_ID}" ]; then
    echo "error: could not find organization uuid in /user/info response" >&2
    echo "${USER_INFO}" >&2
    exit 1
fi
echo "    orgId=${ORG_ID}"
echo -n "${ORG_ID}" > "${ORG_ID_FILE}"

# 4. Cadastrar SSO config — upsert style
echo "==> creating SSO config"
DOMAIN="$(echo "${ADMIN_EMAIL}" | cut -d@ -f2)"

# Use python to build the JSON payload, since `cert` from Keycloak
# contains characters bash interpolation handles awkwardly.
# `active: false` is intentional. The API rejects `active: true` with
# SSO_TEST_REQUIRED unless a prior connection-test session succeeded —
# a production safeguard not worth replicating in this E2E setup. The
# frontend's SSO-detection branch (apps/web/src/app/(auth)/components/
# user-auth-form.tsx) only checks `ssoAvailable?.organizationId`, so
# the redirect into the SAML flow still happens with `active: false`,
# which is all this test needs to exercise the cookie-domain code path.
PAYLOAD=$(KC_OUTPUT="${KC_OUTPUT}" DOMAIN="${DOMAIN}" python3 -c "
import json, os
kc = json.load(open(os.environ['KC_OUTPUT']))
print(json.dumps({
    'protocol': 'saml',
    'providerConfig': {
        'entryPoint': kc['entryPoint'],
        'idpIssuer': kc['idpIssuer'],
        'cert': kc['cert'],
    },
    'domains': [os.environ['DOMAIN']],
    'active': False,
}))
")

SSO_RESPONSE=$(api_curl -s -w "\n%{http_code}" -X POST "${API}/sso-config" \
    -H "Authorization: Bearer ${ACCESS_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "${PAYLOAD}")
HTTP_CODE=$(echo "${SSO_RESPONSE}" | tail -1)
SSO_BODY=$(echo "${SSO_RESPONSE}" | sed '$d')

if [[ ! "${HTTP_CODE}" =~ ^2 ]]; then
    echo "error: POST /sso-config returned HTTP ${HTTP_CODE}" >&2
    echo "${SSO_BODY}" >&2
    exit 1
fi
echo "    HTTP ${HTTP_CODE}"

echo "==> done. orgId=${ORG_ID}, domain=${DOMAIN}"
