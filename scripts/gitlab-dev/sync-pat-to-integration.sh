#!/usr/bin/env bash
# After re-bootstrapping (which mints a fresh user PAT and revokes any
# previous one), the GitLab integration in Kodus is left holding an
# invalid token. Re-encrypts the current .tmp/gitlab-dev-pat.txt with
# the API_CRYPTO_KEY scheme and writes it into auth_integrations so
# the running stack picks it up on the next call.
#
# Skip this if you re-register the integration through the UI by hand
# after each re-bootstrap.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PAT_FILE="${REPO_ROOT}/.tmp/gitlab-dev-pat.txt"

if [ ! -f "${PAT_FILE}" ]; then
    echo "error: ${PAT_FILE} missing; run scripts/gitlab-dev/create-project.sh first." >&2
    exit 1
fi

CRYPTO_KEY="$(grep '^API_CRYPTO_KEY=' "${REPO_ROOT}/.env" | cut -d= -f2-)"
if [ -z "${CRYPTO_KEY}" ]; then
    echo "error: API_CRYPTO_KEY not in .env." >&2
    exit 1
fi

PAT="$(cat "${PAT_FILE}")"

# Encrypt with the same scheme libs/common/utils/crypto.ts uses:
# AES-256-CBC, 16-byte random IV, output is `<iv hex>:<ciphertext hex>`.
# Using openssl rather than python's `cryptography` so we don't need
# an extra dep on the host.
IV_HEX="$(openssl rand -hex 16)"
CIPHER_HEX="$(printf '%s' "${PAT}" | openssl enc -aes-256-cbc -K "${CRYPTO_KEY}" -iv "${IV_HEX}" 2>/dev/null | xxd -p | tr -d '\n')"

if [ -z "${CIPHER_HEX}" ]; then
    echo "error: encryption helper returned empty." >&2
    exit 1
fi

ENCRYPTED="${IV_HEX}:${CIPHER_HEX}"

echo "==> updating auth_integration accessToken for GITLAB"
docker exec -i db_postgres psql -U kodusdev -d kodus_db <<SQL
UPDATE auth_integrations
SET "authDetails" = jsonb_set("authDetails"::jsonb, '{accessToken}', to_jsonb('${ENCRYPTED}'::text), false)::json,
    "updatedAt" = NOW()
WHERE uuid IN (
    SELECT auth_integration_id FROM integrations WHERE platform = 'GITLAB' AND status = true
);
SQL

echo "done."
