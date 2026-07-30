#!/usr/bin/env bash
# Wrapper for `tsx tests/e2e/cli/cloud/setup-tenants.ts` that mirrors
# the env-loading priority used by `scripts/e2e/run.sh` so the cloud
# tenant seeder picks up the same provider tokens (`GH_TEST_TOKEN`
# etc.) the matrix smoke uses.
#
# Config sources (caller env wins):
#   1. inline env on the call
#   2. scripts/e2e/.env       (per-repo override; gitignored)
#   3. ~/.kodus-dev/config    (team default, set by `pnpm run selfhosted:setup`)
#
# `op://Vault/Item/field` references are resolved via the 1Password CLI
# the same way `run.sh` does — required since cloud signup needs the
# four provider PATs to register integrations.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
E2E_DIR="$REPO_ROOT/tests/e2e"
GLOBAL_CONFIG="$HOME/.kodus-dev/config"
LOCAL_ENV="$SCRIPT_DIR/.env"

RED='\033[0;31m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
err()  { echo -e "${RED}[err]${NC}  $*" >&2; }
warn() { echo -e "${YELLOW}[warn]${NC} $*"; }
log()  { echo -e "${BLUE}[cloud]${NC}  $*"; }

# Identical impl to scripts/e2e/run.sh:load_config_file — caller env wins.
load_config_file() {
    local file="$1"
    [ -f "$file" ] || return 0
    local line key val
    while IFS= read -r line || [ -n "$line" ]; do
        [[ "$line" =~ ^[[:space:]]*# ]] && continue
        [[ -z "${line// /}" ]] && continue
        if [[ "$line" =~ ^[[:space:]]*([A-Z_][A-Z0-9_]*)=(.*)$ ]]; then
            key="${BASH_REMATCH[1]}"
            val="${BASH_REMATCH[2]}"
            val="${val%\"}"; val="${val#\"}"
            val="${val%\'}"; val="${val#\'}"
            if [ -z "${!key+x}" ]; then
                export "$key=$val"
            fi
        fi
    done < "$file"
}

resolve_op_refs() {
    local var val resolved
    for var in "$@"; do
        val="${!var:-}"
        case "$val" in
            op://*) ;;
            *) continue ;;
        esac
        if ! command -v op >/dev/null 2>&1; then
            err "$var is a 1Password ref ($val) but 'op' CLI is not installed."
            exit 1
        fi
        resolved=$(op read "$val" 2>/dev/null || true)
        if [ -z "$resolved" ]; then
            err "$var=$val did not resolve via 1Password — run 'op signin' or fix the path."
            exit 1
        fi
        export "$var=$resolved"
    done
}

load_config_file "$LOCAL_ENV"
load_config_file "$GLOBAL_CONFIG"

# Resolve op:// refs for all provider tokens (signup needs all four to
# connect provider integrations across the 6 tenants) plus the BYOK LLM
# key — now that `paid` is seeded as BYOK too (not just community-byok),
# configureByok() runs for every paid cell across all four providers, so
# the key must be present (and op://-resolved) or those seeds fail-loud.
resolve_op_refs \
    GH_TEST_TOKEN \
    GL_TEST_TOKEN \
    BB_TEST_USER \
    BB_TEST_APP_PASSWORD \
    AZ_TEST_TOKEN \
    API_OPEN_AI_API_KEY \
    || true  # don't hard-fail when only a subset is configured

cd "$E2E_DIR"

if [ ! -d node_modules ]; then
    warn "Installing tests/e2e dependencies (first run)…"
    pnpm install --silent
fi

exec npx tsx cli/cloud/setup-tenants.ts "$@"
