#!/usr/bin/env bash
# Build the billing service's private preview env from an allowlisted Stripe
# TEST config plus the per-preview secrets/datastore coordinates in kodus-ai.
set -euo pipefail

SOURCE="${1:?usage: materialize-billing-env.sh <stripe-env> <kodus-env> <output>}"
KODUS_ENV="${2:?usage: materialize-billing-env.sh <stripe-env> <kodus-env> <output>}"
OUTPUT="${3:?usage: materialize-billing-env.sh <stripe-env> <kodus-env> <output>}"

for file in "$SOURCE" "$KODUS_ENV"; do
    [ -f "$file" ] || { echo "missing preview env input: $file" >&2; exit 1; }
done

# This file comes from a GitHub environment secret. Refuse arbitrary keys and,
# most importantly, refuse a live Stripe key before anything reaches the VM.
invalid=$(grep -vE '^[[:space:]]*(#|$|STRIPE_(SECRET_KEY|WEBHOOK_SECRET|PRICE_ID(_[A-Z0-9_]+)?)=)' "$SOURCE" || true)
[ -z "$invalid" ] || { echo "PREVIEW_BILLING_ENV contains unsupported keys" >&2; exit 1; }
[ "$(grep -cE '^STRIPE_SECRET_KEY=' "$SOURCE")" = 1 ] || {
    echo "PREVIEW_BILLING_ENV must contain exactly one STRIPE_SECRET_KEY" >&2
    exit 1
}
! grep -qE 'sk_live_' "$SOURCE" || {
    echo "PREVIEW_BILLING_ENV contains a live Stripe key" >&2
    exit 1
}
grep -qE '^STRIPE_SECRET_KEY=sk_test_[^[:space:]]+$' "$SOURCE" || {
    echo "PREVIEW_BILLING_ENV must contain a Stripe test key (sk_test_)" >&2
    exit 1
}

read_env() {
    local key="$1"
    sed -n "s/^${key}=//p" "$KODUS_ENV" | tail -n 1
}

webhook_secret=$(read_env API_BILLING_WEBHOOK_SECRET)
[ -n "$webhook_secret" ] || { echo "API_BILLING_WEBHOOK_SECRET is missing" >&2; exit 1; }
credits_token=$(read_env API_CREDITS_SERVICE_TOKEN)
[ -n "$credits_token" ] || { echo "API_CREDITS_SERVICE_TOKEN is missing" >&2; exit 1; }

umask 077
{
    grep -E '^STRIPE_(SECRET_KEY|WEBHOOK_SECRET|PRICE_ID(_[A-Z0-9_]+)?)=' "$SOURCE"
    echo 'NODE_ENV=development'
    echo 'API_PORT=3992'
    echo 'PG_DB_HOST=db_postgres'
    echo 'PG_DB_PORT=5432'
    printf 'PG_DB_USERNAME=%s\n' "$(read_env API_PG_DB_USERNAME)"
    printf 'PG_DB_PASSWORD=%s\n' "$(read_env API_PG_DB_PASSWORD)"
    printf 'PG_DB_DATABASE=%s\n' "$(read_env API_PG_DB_DATABASE)"
    echo 'PG_DB_SCHEMA=billing'
    echo 'API_BILLING_NODE_ENV=development'
    echo 'API_DATABASE_ENV=development'
    echo 'API_BILLING_HOSTNAME_API_ORCHESTRATOR=kodus-api'
    echo 'API_BILLING_PORT_API_ORCHESTRATOR=3001'
    echo 'GLOBAL_API_CONTAINER_NAME=kodus-api'
    printf 'CLOUD_TOKEN_SECRET=%s\n' "$webhook_secret"
    printf 'ADMIN_TOKEN=%s\n' "$webhook_secret"
    printf 'KODUS_NOTIFICATION_WEBHOOK_SECRET=%s\n' "$webhook_secret"
    printf 'CREDITS_SERVICE_TOKEN=%s\n' "$credits_token"
} > "$OUTPUT"

chmod 600 "$OUTPUT"
echo "materialized billing preview configuration (Stripe test mode)"
