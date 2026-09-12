#!/usr/bin/env bash
#
# Strips every vault-backed credential out of a preview environment's .env.
#
# A preview URL is public and this repository is public, so a preview must not
# boot with the credentials a developer's machine uses. `.env.template` already
# marks exactly which values come from 1Password (`KEY=op://...`) — that list is
# the input here, so a secret added to the template later is neutralized by
# default instead of leaking by default.
#
# Three treatments:
#   - secrets the app needs in order to WORK (cookie/JWT/crypto keys) get a
#     fresh random value per environment: a preview must never share a signing
#     key with anything else, and sharing the dev one would do exactly that;
#   - datastore URLs are emptied, which is what a developer's .env already does:
#     the stack addresses its databases through the discrete API_*_DB_* values
#     (container hostnames), while host-side tooling like migrations overrides
#     the host to localhost. A single URL cannot be right for both, and filling
#     one in points half the system at the wrong place;
#   - everything else — model providers, git app credentials, email, billing,
#     telemetry — becomes an obvious placeholder. A feature that needs one fails
#     loudly in the preview instead of quietly spending money or writing to a
#     real account.
#
# Usage: scripts/preview/neutralize-preview-env.sh [env-file] [template]
set -euo pipefail

ENV_FILE="${1:-.env}"
TEMPLATE="${2:-.env.template}"
PLACEHOLDER="preview-disabled"

[ -f "$ENV_FILE" ] || { echo "no such env file: $ENV_FILE" >&2; exit 1; }
[ -f "$TEMPLATE" ] || { echo "no such template: $TEMPLATE" >&2; exit 1; }

# Keys that must carry a usable secret rather than a placeholder. Anything not
# listed here is disabled, so forgetting to update this list degrades a preview
# feature — it never exposes a credential.
GENERATED="
API_CRYPTO_KEY
API_JWT_SECRET
API_JWT_REFRESH_SECRET
CODE_MANAGEMENT_SECRET
CODE_MANAGEMENT_WEBHOOK_TOKEN
API_MCP_MANAGER_ENCRYPTION_SECRET
API_BILLING_WEBHOOK_SECRET
API_CREDITS_SERVICE_TOKEN
WEB_ANALYTICS_SECRET
API_DOCS_BASIC_PASS
"


# NextAuth reads one and the app the other; they have to agree.
NEXTAUTH=$(openssl rand -base64 32)

OVERRIDES=$(mktemp)
KEYS=$(grep -oE '^[A-Z0-9_]+=op://' "$TEMPLATE" | cut -d= -f1 | sort -u)
count=0
for key in $KEYS; do
    case "$key" in
        DATABASE_URL | API_PG_DB_URL | MONGODB_URI | API_MG_DB_URI) value="" ;;
        NEXTAUTH_SECRET | WEB_NEXTAUTH_SECRET) value="$NEXTAUTH" ;;
        *)
            if echo "$GENERATED" | grep -qx "$key"; then
                # 32 bytes of hex: API_CRYPTO_KEY is parsed as a 32-byte key and
                # the others only need to be unguessable
                value=$(openssl rand -hex 32)
            else
                value="$PLACEHOLDER"
            fi
            ;;
    esac
    printf '%s=%s\n' "$key" "$value" >> "$OVERRIDES"
    count=$((count + 1))
done

# Drop the originals, then append the replacements — no in-place editing, so a
# value containing slashes or ampersands cannot corrupt the file.
PATTERN=$(echo "$KEYS" | paste -sd'|' -)
FILTERED=$(mktemp)
grep -vE "^($PATTERN)=" "$ENV_FILE" > "$FILTERED"
{
    cat "$FILTERED"
    echo ""
    echo "# --- neutralized for the preview environment (see scripts/preview/neutralize-preview-env.sh)"
    cat "$OVERRIDES"
} > "$ENV_FILE"
rm -f "$OVERRIDES" "$FILTERED"

echo "neutralized $count vault-backed values in $ENV_FILE"
