#!/usr/bin/env bash
# Bootstrap the "Kodus-Dev" 1Password vault from .env.template + local .env.
#
# Reads every op://Kodus-Dev/<NAME>/password reference in .env.template,
# looks up the corresponding value in your .env, and creates a 1Password
# item per ref. Idempotent: re-running skips items that already exist
# (use --update to overwrite their `password` field instead).
#
# Usage:
#   ./scripts/env/bootstrap-vault.sh                # create missing items
#   ./scripts/env/bootstrap-vault.sh --update       # also overwrite existing
#   ./scripts/env/bootstrap-vault.sh --dry-run      # show what would happen
#   ./scripts/env/bootstrap-vault.sh --source .env  # custom source file
#
# Items where the source value is empty are created with an EMPTY value
# (not "REPLACE_ME" or other placeholder string). Reason: any non-empty
# placeholder defeats `if (!process.env.X)` checks in code paths that
# treat the var as @optional — the code would happily try to use
# "REPLACE_ME" as an API key. Empty string is the honest "not set" signal:
# - @optional vars: code falls back to its alternate path. Boot OK.
# - @required vars: Joi validator fails at boot. Loud, early signal that
#   you need to populate the secret. Exactly what we want.
# Populate later via the 1P app or `op item edit ... password="<value>"`.
#
# Requirements: op CLI signed in, write access to the vault.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TEMPLATE="${REPO_ROOT}/.env.template"
SOURCE="${REPO_ROOT}/.env"
VAULT="Kodus-Dev"
DRY_RUN=0
UPDATE=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --dry-run)  DRY_RUN=1; shift ;;
        --update)   UPDATE=1; shift ;;
        --source)   SOURCE="$2"; shift 2 ;;
        --vault)    VAULT="$2"; shift 2 ;;
        -h|--help)  sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *)          echo "Unknown arg: $1" >&2; exit 2 ;;
    esac
done

# ── Preflight ────────────────────────────────────────────────────────────────

if ! command -v op >/dev/null 2>&1; then
    echo "error: 1Password CLI (op) not installed. brew install 1password-cli" >&2
    exit 1
fi
# `op whoami` returns non-zero under desktop biometric integration (no
# persistent session — each call prompts). So we check auth implicitly
# via a lightweight vault read: if it works, we're authenticated AND
# the vault exists. If it fails, we can't tell which is which, so we
# print both possibilities.
if ! op vault get "$VAULT" >/dev/null 2>&1; then
    echo "error: cannot read vault \"$VAULT\"." >&2
    echo "  Either op CLI isn't signed in (open 1Password desktop or run 'op signin')," >&2
    echo "  or the vault doesn't exist (create with: op vault create \"$VAULT\")." >&2
    exit 1
fi
if [[ ! -f "$TEMPLATE" ]]; then
    echo "error: $TEMPLATE not found. Run 'pnpm run env:apply'." >&2
    exit 1
fi
if [[ ! -f "$SOURCE" ]]; then
    echo "error: source file $SOURCE not found." >&2
    exit 1
fi

# ── Extract the list of items the template expects ───────────────────────────

# Each line: <ITEM_NAME>=<FIELD>   (we always use 'credential' today, but
# parsing the field future-proofs against a template that uses op://.../url
# or op://.../password etc.)
# Skip commented lines — the header has a literal `op://Kodus Dev/<ENV_VAR_NAME>/...`
# example we don't want to bootstrap.
ITEMS=$(grep -v '^#' "$TEMPLATE" \
        | grep -oE "op://${VAULT}/[A-Z][A-Z0-9_]+/[A-Za-z0-9_]+" \
        | sort -u \
        | sed "s|op://${VAULT}/||; s|/|=|")

if [[ -z "$ITEMS" ]]; then
    echo "No op:// refs found in $TEMPLATE for vault \"$VAULT\". Nothing to do."
    exit 0
fi

ITEM_COUNT=$(echo "$ITEMS" | wc -l | tr -d ' ')
echo "Found $ITEM_COUNT items referenced by $TEMPLATE."
echo "Vault: $VAULT"
echo "Source: $SOURCE"
[[ $DRY_RUN -eq 1 ]] && echo "Mode: DRY-RUN (no changes will be made)"
[[ $UPDATE -eq 1 ]]  && echo "Mode: UPDATE existing items"
echo

# ── Source value lookup ──────────────────────────────────────────────────────

# Read a key's value from the source .env. Returns empty string if absent or
# commented out. Handles quoted and unquoted values.
get_source_value() {
    local key="$1"
    local raw
    raw=$(grep -E "^${key}=" "$SOURCE" | head -1 | sed "s|^${key}=||" || true)
    # Strip surrounding double quotes
    if [[ "$raw" =~ ^\".*\"$ ]]; then
        raw="${raw:1:${#raw}-2}"
    fi
    # Strip surrounding single quotes
    if [[ "$raw" =~ ^\'.*\'$ ]]; then
        raw="${raw:1:${#raw}-2}"
    fi
    printf '%s' "$raw"
}

# ── Walk items ───────────────────────────────────────────────────────────────

CREATED=0
UPDATED=0
SKIPPED=0
PLACEHOLDER=0
FAILED=0

while IFS='=' read -r ITEM_NAME FIELD; do
    [[ -z "$ITEM_NAME" ]] && continue

    VALUE=$(get_source_value "$ITEM_NAME")
    USE_PLACEHOLDER=0
    if [[ -z "$VALUE" ]]; then
        # Honest "not set" — see header comment for why we don't use a
        # non-empty placeholder. The item gets created with field empty.
        USE_PLACEHOLDER=1
    fi

    # Does the item already exist?
    if op item get "$ITEM_NAME" --vault "$VAULT" >/dev/null 2>&1; then
        if [[ $UPDATE -eq 1 ]]; then
            printf "  [update]      %-45s " "$ITEM_NAME"
            if [[ $DRY_RUN -eq 1 ]]; then
                echo "(dry-run)"
            else
                if op item edit "$ITEM_NAME" --vault "$VAULT" \
                       "${FIELD}=${VALUE}" >/dev/null 2>&1; then
                    echo "ok"
                    UPDATED=$((UPDATED + 1))
                else
                    echo "FAILED"
                    FAILED=$((FAILED + 1))
                fi
            fi
        else
            printf "  [skip exists] %-45s\n" "$ITEM_NAME"
            SKIPPED=$((SKIPPED + 1))
        fi
        continue
    fi

    # Item doesn't exist — create it.
    local_tag="$([[ $USE_PLACEHOLDER -eq 1 ]] && echo "placeholder" || echo "create")"
    printf "  [%-11s] %-45s " "$local_tag" "$ITEM_NAME"

    if [[ $DRY_RUN -eq 1 ]]; then
        echo "(dry-run)"
        [[ $USE_PLACEHOLDER -eq 1 ]] && PLACEHOLDER=$((PLACEHOLDER + 1)) || CREATED=$((CREATED + 1))
        continue
    fi

    # Use "Password" category — it has just a `password` field with no
    # `expires`/`valid from` metadata, so items don't show up as
    # "expired" in the 1P UI (which the "API Credential" category does
    # when the expiry timestamp defaults to 0 = 1970).
    if op item create \
        --category "Password" \
        --vault "$VAULT" \
        --title "$ITEM_NAME" \
        "${FIELD}=${VALUE}" >/dev/null 2>&1; then
        echo "ok"
        if [[ $USE_PLACEHOLDER -eq 1 ]]; then
            PLACEHOLDER=$((PLACEHOLDER + 1))
        else
            CREATED=$((CREATED + 1))
        fi
    else
        echo "FAILED"
        FAILED=$((FAILED + 1))
    fi
done <<< "$ITEMS"

# ── Summary ──────────────────────────────────────────────────────────────────

echo
echo "Summary:"
echo "  Created:                $CREATED"
echo "  Created (placeholder):  $PLACEHOLDER"
echo "  Updated:                $UPDATED"
echo "  Skipped (already exist):$SKIPPED"
echo "  Failed:                 $FAILED"
echo
if [[ $PLACEHOLDER -gt 0 ]]; then
    echo "ℹ  $PLACEHOLDER item(s) created with EMPTY value (no source value found)."
    echo "   The .env produced by 'pnpm run env:pull' will have these vars set to \"\""
    echo "   — @optional vars fall through, @required vars trip the Joi validator"
    echo "   on boot. Populate via 1P app or: op item edit <NAME> --vault \"$VAULT\" password=\"<value>\""
fi
if [[ $FAILED -gt 0 ]]; then
    echo "✗  $FAILED failure(s). Re-run with --dry-run to inspect, or"
    echo "   check 'op item get <NAME> --vault \"$VAULT\"' manually."
    exit 1
fi

echo "Done. Verify with: pnpm run env:pull:check"
