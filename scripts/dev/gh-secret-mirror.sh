#!/usr/bin/env bash
# Mirror secrets into a GitHub environment, pulling from local sources first.
#
# Source order per secret:
#   1. ~/.kodus-dev/config           (KEY=VALUE lines)
#   2. ~/.aws/credentials            (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY)
#   3. ~/.kodus-dev/cloud-tenants.json (CLOUD_TENANT_{FREE,TRIAL,PAID}_{EMAIL,PASSWORD})
#   4. ~/.kodus-dev/license-seats1.jwt (SH_LICENSE_KEY_PAID — file contents)
#   5. 1Password CLI                 (op read from known paths)
#   6. Interactive prompt            (hidden input)
#
# Usage:
#   bash scripts/dev/migrate-secrets-to-hotfix-env.sh                       # interactive, default target=production-hotfix
#   bash scripts/dev/migrate-secrets-to-hotfix-env.sh --env production-hotfix
#   bash scripts/dev/migrate-secrets-to-hotfix-env.sh --env QA --only AWS_QA_HOST,AWS_QA_KEY_SSH
#   bash scripts/dev/migrate-secrets-to-hotfix-env.sh --dry-run             # show plan, no writes

set -euo pipefail

REPO="kodustech/kodus-ai"
TARGET_ENV="production-hotfix"
DRY_RUN=0
ONLY_FILTER=""

# Default secret list = the 11 in production env. Override with --only.
DEFAULT_SECRETS=(
    AWS_ACCESS_KEY_ID
    AWS_SECRET_ACCESS_KEY
    AWS_REGION
    AWS_SECURITY_GROUP
    AWS_PROD_HOST
    AWS_PROD_USERNAME
    AWS_PROD_KEY_SSH
    AWS_ROLE_TO_ASSUME
    DISCORD_WEBHOOK
    DISCORD_WEBHOOK_SELFHOSTED
    INFRA_GITHUB_APP_PRIVATE_KEY
)

KODUS_CONFIG="${HOME}/.kodus-dev/config"
AWS_CREDS="${HOME}/.aws/credentials"
TENANTS_JSON="${HOME}/.kodus-dev/cloud-tenants.json"
LICENSE_JWT="${HOME}/.kodus-dev/license-seats1.jwt"

while [ $# -gt 0 ]; do
    case "$1" in
        --env) TARGET_ENV="$2"; shift 2 ;;
        --only) ONLY_FILTER="$2"; shift 2 ;;
        --dry-run) DRY_RUN=1; shift ;;
        -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
        *) echo "unknown arg: $1" >&2; exit 2 ;;
    esac
done

# Load ~/.kodus-dev/config into env (carefully — many KEY=VALUE lines, may have shell-special chars)
if [ -f "$KODUS_CONFIG" ]; then
    set -a
    # shellcheck source=/dev/null
    . "$KODUS_CONFIG"
    set +a
fi

# ── value sourcing helpers ───────────────────────────────────────────────

src_kodus_config() {
    # Whatever key exported from ~/.kodus-dev/config — also handle GH↔config name mapping.
    # Bash indirect expansion (${!var}) avoids eval — important because $1 ultimately
    # traces back to --only user input.
    local key="$1"
    [ "$key" = "SH_LICENSE_KEY_PAID" ] && key="SH_LICENSE_KEY"
    printf '%s' "${!key:-}"
}

src_aws_credentials() {
    [ -f "$AWS_CREDS" ] || { echo ""; return; }
    case "$1" in
        AWS_ACCESS_KEY_ID)
            awk -F= '/^aws_access_key_id/{gsub(/[ \t]/, "", $2); print $2; exit}' "$AWS_CREDS"
            ;;
        AWS_SECRET_ACCESS_KEY)
            awk -F= '/^aws_secret_access_key/{gsub(/[ \t]/, "", $2); print $2; exit}' "$AWS_CREDS"
            ;;
        *) echo "" ;;
    esac
}

src_cloud_tenants() {
    [ -f "$TENANTS_JSON" ] || { echo ""; return; }
    local key="$1"
    if [[ "$key" =~ ^CLOUD_TENANT_(FREE|TRIAL|PAID)_(EMAIL|PASSWORD)$ ]]; then
        local tier_lc="${BASH_REMATCH[1]}"
        local field_lc="${BASH_REMATCH[2]}"
        # Convert to lowercase via awk for portability (bash 3 on macOS has no ${var,,})
        tier_lc=$(echo "$tier_lc" | tr '[:upper:]' '[:lower:]')
        field_lc=$(echo "$field_lc" | tr '[:upper:]' '[:lower:]')
        python3 -c "
import json,sys
try:
    d = json.load(open('$TENANTS_JSON'))
    for t in d:
        if (t.get('license') or '').lower() == '$tier_lc':
            v = t.get('$field_lc', '')
            if v:
                sys.stdout.write(v)
                break
except Exception:
    pass
"
    fi
}

src_license_file() {
    case "$1" in
        SH_LICENSE_KEY_PAID)
            [ -f "$LICENSE_JWT" ] && cat "$LICENSE_JWT" || echo ""
            ;;
        *) echo "" ;;
    esac
}

src_op() {
    command -v op >/dev/null 2>&1 || { echo ""; return; }
    op account list >/dev/null 2>&1 || { echo ""; return; }
    local key="$1"
    local path=""
    case "$key" in
        DIGITALOCEAN_TOKEN)       path="op://Engineering/kodus-self-hosted-dev/do-token" ;;
        SH_LICENSE_KEY_PAID)      path="op://Engineering/kodus-self-hosted-dev/license-paid" ;;
        GH_TEST_TOKEN)            path="op://Engineering/kodus-self-hosted-dev/gh-bot-token" ;;
        # Add more known op refs as discovered
        *) return ;;
    esac
    op read "$path" 2>/dev/null || true
}

# ── orchestrator ─────────────────────────────────────────────────────────

resolve_value() {
    local key="$1"
    local v src=""

    v=$(src_kodus_config "$key");      [ -n "$v" ] && { echo "kodus-dev/config|$v"; return; }
    v=$(src_aws_credentials "$key");   [ -n "$v" ] && { echo "aws/credentials|$v"; return; }
    v=$(src_cloud_tenants "$key");     [ -n "$v" ] && { echo "cloud-tenants.json|$v"; return; }
    v=$(src_license_file "$key");      [ -n "$v" ] && { echo "license-seats1.jwt|$v"; return; }
    v=$(src_op "$key");                [ -n "$v" ] && { echo "1Password|$v"; return; }
    echo "|"
}

# Build secret list
if [ -n "$ONLY_FILTER" ]; then
    IFS=',' read -ra SECRETS <<< "$ONLY_FILTER"
else
    SECRETS=("${DEFAULT_SECRETS[@]}")
fi

# Pre-flight: confirm target env exists
echo ""
echo "╔════════════════════════════════════════════════════════════════╗"
echo "║ Target env: $TARGET_ENV"
echo "║ Repo:       $REPO"
echo "║ Secrets:    ${#SECRETS[@]} (dry-run=$DRY_RUN)"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""

# Phase 1: resolve all sources (no writes, no prompts)
declare -a TO_WRITE_NAME=()
declare -a TO_WRITE_SRC=()
declare -a TO_WRITE_VAL=()
declare -a NEED_PROMPT=()

printf "%-35s %-25s %s\n" "SECRET" "SOURCE" "PREVIEW"
printf "%-35s %-25s %s\n" "──────" "──────" "───────"
for name in "${SECRETS[@]}"; do
    pair=$(resolve_value "$name")
    src="${pair%%|*}"
    val="${pair#*|}"
    if [ -z "$val" ]; then
        printf "%-35s %-25s %s\n" "$name" "(prompt)" "—"
        NEED_PROMPT+=("$name")
    else
        # Preview: first 6 chars + last 4, with len
        preview=$(printf '%s' "$val" | awk '{ if (length($0) > 14) print substr($0,1,6) "…" substr($0,length($0)-3) " (" length($0) " chars)"; else print "(" length($0) " chars)" }')
        printf "%-35s %-25s %s\n" "$name" "$src" "$preview"
        TO_WRITE_NAME+=("$name")
        TO_WRITE_SRC+=("$src")
        TO_WRITE_VAL+=("$val")
    fi
done

echo ""
echo "Auto-resolved: ${#TO_WRITE_NAME[@]}    Will prompt: ${#NEED_PROMPT[@]}"
echo ""

if [ "$DRY_RUN" = "1" ]; then
    echo "(dry-run — no writes)"
    exit 0
fi

# Phase 2: prompt for missing
for name in "${NEED_PROMPT[@]+"${NEED_PROMPT[@]}"}"; do
    echo "──────────────────────────────────────────────"
    echo " $name — paste value (hidden, Enter to skip)"
    echo -n " > "
    read -rs val
    echo ""
    if [ -n "$val" ]; then
        TO_WRITE_NAME+=("$name")
        TO_WRITE_SRC+=("prompt")
        TO_WRITE_VAL+=("$val")
    else
        echo "  ⏭  skipped"
    fi
    unset val
done

# Phase 3: confirm
echo ""
echo "About to write ${#TO_WRITE_NAME[@]} secrets to $TARGET_ENV. Proceed? [y/N]"
read -r CONFIRM
if [ "$CONFIRM" != "y" ] && [ "$CONFIRM" != "Y" ]; then
    echo "Aborted."
    exit 0
fi

# Phase 4: write
written=0
failed=0
for i in "${!TO_WRITE_NAME[@]}"; do
    name="${TO_WRITE_NAME[$i]}"
    src="${TO_WRITE_SRC[$i]}"
    val="${TO_WRITE_VAL[$i]}"
    if printf '%s' "$val" | gh secret set "$name" --env "$TARGET_ENV" --body - -R "$REPO" >/dev/null 2>&1; then
        printf "  ✅ %-35s (from %s)\n" "$name" "$src"
        written=$((written + 1))
    else
        printf "  ❌ %-35s — gh secret set failed\n" "$name"
        failed=$((failed + 1))
    fi
    unset val
done

echo ""
echo "Done. written=$written  failed=$failed"
echo "Verify: gh secret list --env $TARGET_ENV -R $REPO"
