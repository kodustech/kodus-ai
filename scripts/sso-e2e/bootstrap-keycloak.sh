#!/usr/bin/env bash
# Configure Keycloak as a SAML IdP for the SSO E2E test:
#   1. Realm `kodus-sso-e2e`
#   2. SAML client `kodus` (recipient: API callback)
#   3. Test user `sso-user@kodus-test.com` (password: TestSso!2026)
#
# Idempotent — re-running just no-ops if the realm/client/user already exist.
# Outputs `.tmp/sso-e2e-keycloak.json` with the IdP descriptor fields the
# Kodus SSO config expects: { entryPoint, idpIssuer, cert }.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
KC="${KC_URL:-http://localhost:8080}"
REALM="${SSO_E2E_REALM:-kodus-sso-e2e}"
# Must match the SP issuer Kodus puts in the SAMLRequest.
# saml-auth.strategy.ts:        ssoConfig.providerConfig.issuer || 'kodus-orchestrator'
# We don't set `issuer` on the providerConfig, so the default applies.
CLIENT_ID="${SSO_E2E_CLIENT_ID:-kodus-orchestrator}"
USER_EMAIL="${SSO_E2E_USER_EMAIL:-sso-user@kodus-test.com}"
# Local-only test password. The Keycloak it talks to is a fresh
# `start-dev` container with admin/admin credentials, ports exposed
# only on localhost, no persistence outside the docker volume that
# `down -v` wipes. Never touches anything production.
USER_PASSWORD="${SSO_E2E_USER_PASSWORD:-TestSso!2026}"
KODUS_ORG_ID_FILE="${REPO_ROOT}/.tmp/sso-e2e-org-id.txt"
OUTPUT="${REPO_ROOT}/.tmp/sso-e2e-keycloak.json"

mkdir -p "${REPO_ROOT}/.tmp"

# 1. Admin token
echo "==> obtaining admin token from ${KC}"
TOKEN=$(curl -sf -X POST "${KC}/realms/master/protocol/openid-connect/token" \
    -H "Content-Type: application/x-www-form-urlencoded" \
    -d "username=admin&password=admin&grant_type=password&client_id=admin-cli" \
    | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p')

if [ -z "${TOKEN}" ]; then
    echo "error: failed to obtain admin token — is Keycloak running on ${KC}?" >&2
    exit 1
fi

auth() { curl -sf -H "Authorization: Bearer ${TOKEN}" "$@"; }
authq() { curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer ${TOKEN}" "$@"; }

# 2. Realm (idempotent)
echo "==> ensuring realm ${REALM}"
status=$(authq "${KC}/admin/realms/${REALM}")
if [ "${status}" = "404" ]; then
    auth -X POST "${KC}/admin/realms" \
        -H "Content-Type: application/json" \
        -d "{\"realm\":\"${REALM}\",\"enabled\":true}"
    echo "    created"
else
    echo "    already exists (${status})"
fi

# 3. SAML client (idempotent)
# The callback URL must match what the API expects:
#   POST /auth/sso/saml/callback/<organizationId>
# The orgId is created by bootstrap-kodus.sh and persisted in the file
# below. If that file is missing, fall back to a wildcard so the realm
# still boots — bootstrap-kodus.sh re-runs this script after creating
# the org.
ORG_ID="*"
if [ -f "${KODUS_ORG_ID_FILE}" ]; then
    ORG_ID="$(cat "${KODUS_ORG_ID_FILE}")"
fi
SSO_E2E_DOMAIN="${SSO_E2E_DOMAIN:-kodus.lvh.me}"
CALLBACK_URL="https://api.${SSO_E2E_DOMAIN}/auth/sso/saml/callback/${ORG_ID}"

echo "==> ensuring SAML client ${CLIENT_ID} (callback: ${CALLBACK_URL})"
EXISTING_CLIENT=$(auth "${KC}/admin/realms/${REALM}/clients?clientId=${CLIENT_ID}" \
    | python3 -c "import json,sys; d=json.load(sys.stdin); print(d[0]['id'] if d else '', end='')")

CLIENT_PAYLOAD=$(cat <<EOF
{
    "clientId": "${CLIENT_ID}",
    "protocol": "saml",
    "enabled": true,
    "redirectUris": ["${CALLBACK_URL}"],
    "baseUrl": "${CALLBACK_URL}",
    "attributes": {
        "saml.assertion.signature": "true",
        "saml.client.signature": "false",
        "saml_assertion_consumer_url_post": "${CALLBACK_URL}",
        "saml_assertion_consumer_url_redirect": "${CALLBACK_URL}",
        "saml.signature.algorithm": "RSA_SHA256",
        "saml_force_name_id_format": "true",
        "saml_name_id_format": "email"
    },
    "protocolMappers": [
        {
            "name": "email",
            "protocol": "saml",
            "protocolMapper": "saml-user-property-mapper",
            "config": {
                "user.attribute": "email",
                "friendly.name": "email",
                "attribute.name": "email",
                "attribute.nameformat": "Basic"
            }
        }
    ]
}
EOF
)

if [ -z "${EXISTING_CLIENT}" ]; then
    auth -X POST "${KC}/admin/realms/${REALM}/clients" \
        -H "Content-Type: application/json" \
        -d "${CLIENT_PAYLOAD}"
    echo "    created"
else
    auth -X PUT "${KC}/admin/realms/${REALM}/clients/${EXISTING_CLIENT}" \
        -H "Content-Type: application/json" \
        -d "${CLIENT_PAYLOAD}"
    echo "    updated"
fi

# 4. Test user (idempotent)
echo "==> ensuring user ${USER_EMAIL}"
EXISTING_USER=$(auth "${KC}/admin/realms/${REALM}/users?email=${USER_EMAIL}" \
    | python3 -c "import json,sys; d=json.load(sys.stdin); print(d[0]['id'] if d else '', end='')")

if [ -z "${EXISTING_USER}" ]; then
    auth -X POST "${KC}/admin/realms/${REALM}/users" \
        -H "Content-Type: application/json" \
        -d "{
            \"username\":\"${USER_EMAIL}\",
            \"email\":\"${USER_EMAIL}\",
            \"enabled\":true,
            \"emailVerified\":true,
            \"firstName\":\"SSO\",\"lastName\":\"Tester\",
            \"credentials\":[{\"type\":\"password\",\"value\":\"${USER_PASSWORD}\",\"temporary\":false}]
        }"
    echo "    created"
else
    echo "    already exists"
fi

# 5. Extract IdP descriptor fields the Kodus SSO config expects.
echo "==> exporting IdP metadata to ${OUTPUT}"
ENTRY_POINT="${KC}/realms/${REALM}/protocol/saml"
IDP_ISSUER="${KC}/realms/${REALM}"
CERT=$(auth "${KC}/admin/realms/${REALM}/keys" \
    | python3 -c "
import json, sys
keys = json.load(sys.stdin).get('keys', [])
sig = next((k for k in keys if k.get('use') == 'SIG' and k.get('certificate')), None)
print(sig['certificate'] if sig else '', end='')
")

if [ -z "${CERT}" ]; then
    echo "error: failed to extract realm signing cert" >&2
    exit 1
fi

cat > "${OUTPUT}" <<EOF
{
    "entryPoint": "${ENTRY_POINT}",
    "idpIssuer": "${IDP_ISSUER}",
    "cert": "${CERT}",
    "userEmail": "${USER_EMAIL}",
    "userPassword": "${USER_PASSWORD}",
    "callbackUrl": "${CALLBACK_URL}"
}
EOF

echo "==> done. realm=${REALM}, client=${CLIENT_ID}, user=${USER_EMAIL}"
