#!/usr/bin/env bash
# Materialize .env.billing for a dev runo env (.kodus/workspace.yaml): the
# Stripe TEST key from 1Password plus one price id per plan, run through the
# same materializer CI uses for previews, which refuses anything but sk_test_.
#
# Usage: scripts/env/pull-billing-env.sh   (reads .env: run scripts/env/pull.sh first)
#
# The key is read from the notes of the "kodus-service-billing QA ENV" item;
# RUNO_BILLING_STRIPE_REF points it elsewhere.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
REF="${RUNO_BILLING_STRIPE_REF:-op://Engineering/kodus-service-billing QA ENV/notesPlain}"

ENV_FILE="$REPO_ROOT/.env"

command -v op >/dev/null || { echo "the 1Password CLI (op) is required" >&2; exit 1; }
[ -f "$ENV_FILE" ] || { echo "no .env: run scripts/env/pull.sh first" >&2; exit 1; }

# The API and billing sign their calls to each other with these. The vault
# has no value for them, so a pulled .env ships them empty; any value works
# as long as both sides hold the same one. Mint it into .env, where the API
# reads it — which is also why re-pulling .env means re-running this.
for key in API_BILLING_WEBHOOK_SECRET API_CREDITS_SERVICE_TOKEN; do
    [ -n "$(sed -n "s/^${key}=//p" "$ENV_FILE" | tail -n 1)" ] && continue
    value="$(openssl rand -hex 32)"
    if grep -q "^${key}=" "$ENV_FILE"; then
        sed -i.bak "s|^${key}=.*|${key}=${value}|" "$ENV_FILE" && rm -f "$ENV_FILE.bak"
    else
        printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
    fi
    echo "minted ${key} into .env (the API and billing share it)"
done

key="$(op read "$REF" | sed -n 's/^[[:space:]]*STRIPE_SECRET_KEY[[:space:]]*=[[:space:]]*//p' | tr -d '"\r' | tail -n 1)"
[ -n "$key" ] || { echo "no STRIPE_SECRET_KEY at $REF" >&2; exit 1; }

stripe_env="$(mktemp)"
trap 'rm -f "$stripe_env"' EXIT
{
    printf 'STRIPE_SECRET_KEY=%s\n' "$key"
    # That test account predates per-plan prices. One distinct price per plan
    # is what lets the Checkout webhook tell which plan was bought
    # (getPlanTypeByPriceId in the billing repo); the amounts don't matter.
    echo 'STRIPE_PRICE_ID_TEAMS_MANAGED=price_1Qzp5HGfhWK4eBdcmumygono'
    echo 'STRIPE_PRICE_ID_TEAMS_BYOK=price_1RGkLsGfhWK4eBdckVEKzIpp'
    echo 'STRIPE_PRICE_ID_ENTERPRISE_MANAGED=price_1RGkIeGfhWK4eBdcTaxszygo'
    echo 'STRIPE_PRICE_ID_ENTERPRISE_BYOK=price_1RAzYEGfhWK4eBdclDtxFyaZ'
} > "$stripe_env"

"$REPO_ROOT/scripts/preview/materialize-billing-env.sh" \
    "$stripe_env" "$ENV_FILE" "$REPO_ROOT/.env.billing"
