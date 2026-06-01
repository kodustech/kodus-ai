#!/usr/bin/env bash
# Configures Keycloak as a SAML IdP for the SSO E2E droplet test.
#
# Runs ON THE DROPLET (provision.sh ships it over via SSH). Reaches
# Keycloak through the public Caddy URL so the SAML metadata that
# bootstrap-kodus-sso.sh later extracts already uses the public
# hostnames the API/web will redirect through.
#
# Inputs (env or args):
#   KC_BASE_URL            https://kc.<IP>.sslip.io       (required)
#   KC_ADMIN_PASSWORD      admin password                 (required)
#   API_BASE_URL           https://api.<IP>.sslip.io      (required — used in ACS URL)
#   ORG_ID                 Kodus org id (optional first pass; second pass after Kodus signup)
#   REALM                  default: kodus-sso-e2e
#   CLIENT_ID              default: kodus-orchestrator
#   USER_EMAIL             default: sso-user@kodus-test.com
#   USER_PASSWORD          default: TestSso!2026
#
# Outputs (printed as JSON to stdout):
#   { "entryPoint", "idpIssuer", "cert", "userEmail", "userPassword", "callbackUrl" }
#
# Idempotent — re-running just updates the SAML client ACS URL.

set -euo pipefail

KC_BASE_URL="${KC_BASE_URL:?missing KC_BASE_URL}"
KC_ADMIN_PASSWORD="${KC_ADMIN_PASSWORD:?missing KC_ADMIN_PASSWORD}"
API_BASE_URL="${API_BASE_URL:?missing API_BASE_URL}"
ORG_ID="${ORG_ID:-*}"
REALM="${REALM:-kodus-sso-e2e}"
CLIENT_ID="${CLIENT_ID:-kodus-orchestrator}"
USER_EMAIL="${USER_EMAIL:-sso-user@kodus-test.com}"
USER_PASSWORD="${USER_PASSWORD:-TestSso!2026}"

# Wait for Keycloak to come up behind Caddy. ACME issuance on a freshly
# booted droplet plus Keycloak's JVM warmup + realm import can take well
# past 4 min — observed 14 min on a cold droplet 2026-05-21 even though
# Caddy/Keycloak containers were both "Up" the whole time. 10 min gives
# slack for that worst-case without masking a genuine boot failure (which
# would either crash-loop the container or never reach the /realms/master
# endpoint regardless of how long we wait).
KC_WAIT_MAX="${KC_WAIT_MAX:-600}"
echo "==> waiting for Keycloak at ${KC_BASE_URL}/realms/master (up to ${KC_WAIT_MAX}s) ..." >&2
for i in $(seq 1 $((KC_WAIT_MAX / 2))); do
    code=$(curl -sk -o /dev/null -w '%{http_code}' "${KC_BASE_URL}/realms/master" || true)
    if [ "${code}" = "200" ]; then echo "    ready (HTTP ${code} after $((i * 2))s)" >&2; break; fi
    if [ "${i}" = $((KC_WAIT_MAX / 2)) ]; then
        echo "error: Keycloak did not respond at ${KC_BASE_URL} after ${KC_WAIT_MAX}s" >&2
        exit 1
    fi
    sleep 2
done

# Admin token. -k because LE may not yet have issued on first boot;
# Caddy falls back to its internal CA which curl doesn't trust by default.
TOKEN=$(curl -sfk -X POST "${KC_BASE_URL}/realms/master/protocol/openid-connect/token" \
    -H "Content-Type: application/x-www-form-urlencoded" \
    -d "username=admin&password=${KC_ADMIN_PASSWORD}&grant_type=password&client_id=admin-cli" \
    | python3 -c "import json,sys; print(json.load(sys.stdin).get('access_token',''), end='')")

if [ -z "${TOKEN}" ]; then
    echo "error: admin token request failed against ${KC_BASE_URL}" >&2
    exit 1
fi

auth()  { curl -sfk -H "Authorization: Bearer ${TOKEN}" "$@"; }
authq() { curl -sk  -o /dev/null -w '%{http_code}' -H "Authorization: Bearer ${TOKEN}" "$@"; }

# 1. Realm
status=$(authq "${KC_BASE_URL}/admin/realms/${REALM}")
if [ "${status}" = "404" ]; then
    auth -X POST "${KC_BASE_URL}/admin/realms" \
        -H "Content-Type: application/json" \
        -d "{\"realm\":\"${REALM}\",\"enabled\":true}"
    echo "==> created realm ${REALM}" >&2
else
    echo "==> realm ${REALM} exists (HTTP ${status})" >&2
fi

# 2. SAML client — ACS URL must match what `runtimeAuthOptions.callbackUrl`
#    in libs/ee/sso/strategies/saml-auth.strategy.ts produces:
#        ${API_URL}/auth/sso/saml/callback/${organizationId}
CALLBACK_URL="${API_BASE_URL}/auth/sso/saml/callback/${ORG_ID}"

CLIENT_PAYLOAD=$(python3 -c "
import json
print(json.dumps({
    'clientId': '${CLIENT_ID}',
    'protocol': 'saml',
    'enabled': True,
    'redirectUris': ['${CALLBACK_URL}'],
    'baseUrl': '${CALLBACK_URL}',
    'attributes': {
        'saml.assertion.signature': 'true',
        'saml.client.signature': 'false',
        'saml_assertion_consumer_url_post': '${CALLBACK_URL}',
        'saml_assertion_consumer_url_redirect': '${CALLBACK_URL}',
        'saml.signature.algorithm': 'RSA_SHA256',
        'saml_force_name_id_format': 'true',
        'saml_name_id_format': 'email',
    },
    'protocolMappers': [{
        'name': 'email',
        'protocol': 'saml',
        'protocolMapper': 'saml-user-property-mapper',
        'config': {
            'user.attribute': 'email',
            'friendly.name': 'email',
            'attribute.name': 'email',
            'attribute.nameformat': 'Basic',
        },
    }],
}))
")

EXISTING=$(auth "${KC_BASE_URL}/admin/realms/${REALM}/clients?clientId=${CLIENT_ID}" \
    | python3 -c "import json,sys; d=json.load(sys.stdin); print(d[0]['id'] if d else '', end='')")

if [ -z "${EXISTING}" ]; then
    auth -X POST "${KC_BASE_URL}/admin/realms/${REALM}/clients" \
        -H "Content-Type: application/json" -d "${CLIENT_PAYLOAD}"
    echo "==> created SAML client ${CLIENT_ID} (callback: ${CALLBACK_URL})" >&2
else
    auth -X PUT "${KC_BASE_URL}/admin/realms/${REALM}/clients/${EXISTING}" \
        -H "Content-Type: application/json" -d "${CLIENT_PAYLOAD}"
    echo "==> updated SAML client ${CLIENT_ID} (callback: ${CALLBACK_URL})" >&2
fi

# 3. Test user
EXISTING_USER=$(auth "${KC_BASE_URL}/admin/realms/${REALM}/users?email=${USER_EMAIL}" \
    | python3 -c "import json,sys; d=json.load(sys.stdin); print(d[0]['id'] if d else '', end='')")

if [ -z "${EXISTING_USER}" ]; then
    auth -X POST "${KC_BASE_URL}/admin/realms/${REALM}/users" \
        -H "Content-Type: application/json" \
        -d "{
            \"username\":\"${USER_EMAIL}\",
            \"email\":\"${USER_EMAIL}\",
            \"enabled\":true,
            \"emailVerified\":true,
            \"firstName\":\"SSO\",\"lastName\":\"Tester\",
            \"credentials\":[{\"type\":\"password\",\"value\":\"${USER_PASSWORD}\",\"temporary\":false}]
        }"
    echo "==> created user ${USER_EMAIL}" >&2
else
    echo "==> user ${USER_EMAIL} exists" >&2
fi

# 4. IdP descriptor (entry point + signing cert) for Kodus SSO config.
ENTRY_POINT="${KC_BASE_URL}/realms/${REALM}/protocol/saml"
IDP_ISSUER="${KC_BASE_URL}/realms/${REALM}"
# Extract the SAML signing cert from the realm's SAML descriptor XML
# rather than /admin/realms/<realm>/keys. /keys returns ALL realm keys
# including encryption (RSA-OAEP) and the SAML signing key — but
# Keycloak 26.5 sometimes uses a dedicated SAML signing key that isn't
# the same as the first RS256 SIG key returned by /keys. Parsing it
# from the descriptor matches what KC actually advertises as its SAML
# signing certificate to any SP — which is what Kodus's SAML strategy
# needs to validate signatures.
CERT=$(curl -sfk "${KC_BASE_URL}/realms/${REALM}/protocol/saml/descriptor" \
    | python3 -c "
import re, sys
xml = sys.stdin.read()
# Both <ds:X509Certificate> (signed) and the unprefixed form appear in
# the wild; KC 26 uses the ds: prefix. Match both for robustness.
m = re.search(r'<(?:ds:)?X509Certificate[^>]*>([^<]+)</(?:ds:)?X509Certificate>', xml)
print(m.group(1).strip() if m else '', end='')
")

if [ -z "${CERT}" ]; then
    echo "error: realm signing cert not found" >&2
    exit 1
fi

python3 -c "
import json
print(json.dumps({
    'entryPoint': '${ENTRY_POINT}',
    'idpIssuer': '${IDP_ISSUER}',
    'cert': '${CERT}',
    'userEmail': '${USER_EMAIL}',
    'userPassword': '${USER_PASSWORD}',
    'callbackUrl': '${CALLBACK_URL}',
}))
"
