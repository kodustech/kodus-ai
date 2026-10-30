#!/usr/bin/env bash
# Shared helpers for scripts/selfhosted/*.sh
#
# Source from each script with:  . "$(dirname "$0")/_common.sh"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STATE_DIR="$REPO_ROOT/.kodus-dev"
SSH_KEY_DIR="$STATE_DIR/ssh-keys"
GLOBAL_CONFIG="$HOME/.kodus-dev/config"

mkdir -p "$STATE_DIR" "$SSH_KEY_DIR"
chmod 700 "$SSH_KEY_DIR"

# Load env config in priority order. Already-exported env vars win — that lets
# you override a single value inline (e.g. IMAGE_TAG=foo pnpm run selfhosted:provision)
# without editing the config file.
#
#   1. Already-exported env (highest — caller's shell wins)
#   2. scripts/selfhosted/.env  (per-repo overrides, gitignored)
#   3. ~/.kodus-dev/config       (global, written by setup.sh)
#
# Implementation: snapshot each tracked var BEFORE loading any file. Load
# files (lower → higher priority). Then restore snapshotted values for any
# var the caller had set, so caller overrides win. Plain shell vars only
# — no associative arrays — so this stays compatible with macOS bash 3.2.
__snap_DIGITALOCEAN_TOKEN="${DIGITALOCEAN_TOKEN+__SET__}${DIGITALOCEAN_TOKEN:-}"
__snap_HCLOUD_TOKEN="${HCLOUD_TOKEN+__SET__}${HCLOUD_TOKEN:-}"
__snap_SH_LICENSE_KEY="${SH_LICENSE_KEY+__SET__}${SH_LICENSE_KEY:-}"
__snap_GH_DEV_TOKEN="${GH_DEV_TOKEN+__SET__}${GH_DEV_TOKEN:-}"
__snap_API_OPEN_AI_API_KEY="${API_OPEN_AI_API_KEY+__SET__}${API_OPEN_AI_API_KEY:-}"
__snap_API_OPENAI_FORCE_BASE_URL="${API_OPENAI_FORCE_BASE_URL+__SET__}${API_OPENAI_FORCE_BASE_URL:-}"
__snap_API_LLM_PROVIDER_MODEL="${API_LLM_PROVIDER_MODEL+__SET__}${API_LLM_PROVIDER_MODEL:-}"
__snap_KODUS_INSTALLER_PATH="${KODUS_INSTALLER_PATH+__SET__}${KODUS_INSTALLER_PATH:-}"
__snap_TEST_VM_PROVIDER="${TEST_VM_PROVIDER+__SET__}${TEST_VM_PROVIDER:-}"
__snap_IMAGE_TAG="${IMAGE_TAG+__SET__}${IMAGE_TAG:-}"
__snap_DO_REGION="${DO_REGION+__SET__}${DO_REGION:-}"
__snap_DO_SIZE="${DO_SIZE+__SET__}${DO_SIZE:-}"
__snap_DO_IMAGE="${DO_IMAGE+__SET__}${DO_IMAGE:-}"
__snap_HCLOUD_LOCATION="${HCLOUD_LOCATION+__SET__}${HCLOUD_LOCATION:-}"
__snap_HCLOUD_SERVER_TYPE="${HCLOUD_SERVER_TYPE+__SET__}${HCLOUD_SERVER_TYPE:-}"
__snap_HCLOUD_IMAGE="${HCLOUD_IMAGE+__SET__}${HCLOUD_IMAGE:-}"

__load_value_from_file() {
    local file="$1"
    [ -f "$file" ] || return 0
    # shellcheck disable=SC1090
    set -a; . "$file"; set +a
}
__load_value_from_file "$GLOBAL_CONFIG"
__load_value_from_file "$REPO_ROOT/scripts/selfhosted/.env"

# Restore caller's pre-existing values on top (caller wins).
__restore_if_set() {
    local var="$1" snap="$2"
    case "$snap" in
        __SET__*) export "$var=${snap#__SET__}" ;;
    esac
}
__restore_if_set DIGITALOCEAN_TOKEN        "$__snap_DIGITALOCEAN_TOKEN"
__restore_if_set HCLOUD_TOKEN              "$__snap_HCLOUD_TOKEN"
__restore_if_set SH_LICENSE_KEY            "$__snap_SH_LICENSE_KEY"
__restore_if_set GH_DEV_TOKEN              "$__snap_GH_DEV_TOKEN"
__restore_if_set API_OPEN_AI_API_KEY       "$__snap_API_OPEN_AI_API_KEY"
__restore_if_set API_OPENAI_FORCE_BASE_URL "$__snap_API_OPENAI_FORCE_BASE_URL"
__restore_if_set API_LLM_PROVIDER_MODEL    "$__snap_API_LLM_PROVIDER_MODEL"
__restore_if_set KODUS_INSTALLER_PATH      "$__snap_KODUS_INSTALLER_PATH"
__restore_if_set TEST_VM_PROVIDER          "$__snap_TEST_VM_PROVIDER"
__restore_if_set IMAGE_TAG                 "$__snap_IMAGE_TAG"
__restore_if_set DO_REGION                 "$__snap_DO_REGION"
__restore_if_set DO_SIZE                   "$__snap_DO_SIZE"
__restore_if_set DO_IMAGE                  "$__snap_DO_IMAGE"
__restore_if_set HCLOUD_LOCATION           "$__snap_HCLOUD_LOCATION"
__restore_if_set HCLOUD_SERVER_TYPE        "$__snap_HCLOUD_SERVER_TYPE"
__restore_if_set HCLOUD_IMAGE              "$__snap_HCLOUD_IMAGE"

unset __snap_DIGITALOCEAN_TOKEN __snap_HCLOUD_TOKEN __snap_SH_LICENSE_KEY \
      __snap_GH_DEV_TOKEN __snap_API_OPEN_AI_API_KEY __snap_API_OPENAI_FORCE_BASE_URL \
      __snap_API_LLM_PROVIDER_MODEL \
      __snap_KODUS_INSTALLER_PATH __snap_TEST_VM_PROVIDER \
      __snap_IMAGE_TAG __snap_DO_REGION __snap_DO_SIZE __snap_DO_IMAGE \
      __snap_HCLOUD_LOCATION __snap_HCLOUD_SERVER_TYPE __snap_HCLOUD_IMAGE
unset -f __load_value_from_file __restore_if_set

# Resolve 1Password CLI references — any var whose value starts with `op://`
# is replaced with the value of that 1Password item field, fetched via the
# `op` CLI. Internal team can store secrets as `op://Vault/Item/field` in
# ~/.kodus-dev/config; external contributors paste plain values. Both work
# transparently from the rest of the scripts' perspective.
#
# Fails the calling script (set -e or exit 1) with a clear message if:
#   - the value is op:// but `op` is not installed
#   - `op` is installed but not authenticated
#   - the reference path is invalid
__resolve_op_ref() {
    local var="$1"
    local value="${!var:-}"
    case "$value" in
        op://*) ;;
        *) return 0 ;;
    esac
    if ! command -v op >/dev/null 2>&1; then
        echo "ERROR: $var is a 1Password reference ($value), but the 'op' CLI is not installed." >&2
        echo "       Install: brew install --cask 1password-cli  (or see https://developer.1password.com/docs/cli)" >&2
        echo "       Or replace the ref with a plain value in ~/.kodus-dev/config" >&2
        return 1
    fi
    local resolved
    if ! resolved=$(op read --no-newline "$value" 2>&1); then
        echo "ERROR: failed to resolve $var ($value):" >&2
        echo "       $resolved" >&2
        echo "       Make sure 'op signin' is current (or 1Password app integration is enabled)" >&2
        echo "       and the reference path is correct." >&2
        return 1
    fi
    export "$var=$resolved"
}
__resolve_op_ref DIGITALOCEAN_TOKEN        || exit 1
__resolve_op_ref HCLOUD_TOKEN              || exit 1
__resolve_op_ref SH_LICENSE_KEY            || exit 1
__resolve_op_ref GH_DEV_TOKEN              || exit 1
__resolve_op_ref CLOUDFLARE_API_TOKEN      || exit 1
__resolve_op_ref API_OPEN_AI_API_KEY       || exit 1
__resolve_op_ref API_OPENAI_FORCE_BASE_URL || exit 1
__resolve_op_ref API_LLM_PROVIDER_MODEL    || exit 1
unset -f __resolve_op_ref

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; BLUE='\033[0;34m'; GRAY='\033[0;90m'; NC='\033[0m'
log()  { echo -e "${BLUE}[selfhosted]${NC} $*"; }
ok()   { echo -e "${GREEN}[ok]${NC}          $*"; }
warn() { echo -e "${YELLOW}[warn]${NC}        $*"; }
err()  { echo -e "${RED}[err]${NC}         $*" >&2; }
dim()  { echo -e "${GRAY}$*${NC}"; }

require_cmd() {
    command -v "$1" >/dev/null 2>&1 || { err "Missing dependency: $1"; exit 1; }
}

require_env() {
    [ -n "${!1:-}" ] || { err "Required env $1 is not set"; exit 1; }
}

# Normalize a user-provided name into a safe slug for filenames + cloud
# resource names. Replaces non-alnum with dashes, lowercases, trims.
normalize_name() {
    local raw="${1:-default}"
    echo "$raw" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9-]/-/g' | sed 's/--*/-/g' | sed 's/^-//;s/-$//'
}

state_file_for() {
    local name=$1
    echo "$STATE_DIR/selfhosted-vm-${name}.json"
}

ssh_key_path_for() {
    local name=$1
    echo "$SSH_KEY_DIR/${name}"
}

state_exists() {
    [ -f "$(state_file_for "$1")" ]
}

# Reads a JSON path from the state file and prints the value.
# Usage: state_get default .server_ip
state_get() {
    local name=$1 path=$2
    jq -r "$path // empty" "$(state_file_for "$name")"
}

# Lists all instance names that have a state file.
list_instances() {
    find "$STATE_DIR" -maxdepth 1 -name 'selfhosted-vm-*.json' -type f 2>/dev/null \
        | sed -E "s|.*/selfhosted-vm-(.+)\.json|\1|" \
        | sort
}

# Convenience: SSH into a given instance, with the proper key + options.
# Usage: ssh_to default "uptime"
ssh_to() {
    local name=$1
    shift
    local ip key
    ip=$(state_get "$name" .server_ip)
    key=$(state_get "$name" .ssh_key_path)
    [ -n "$ip" ] && [ -n "$key" ] && [ -f "$key" ] \
        || { err "No live SSH config for '$name' (state missing or destroyed)"; return 1; }
    ssh -i "$key" \
        -o StrictHostKeyChecking=no \
        -o UserKnownHostsFile=/dev/null \
        -o LogLevel=ERROR \
        -o ConnectTimeout=10 \
        -o ServerAliveInterval=30 \
        -o ServerAliveCountMax=3 \
        "root@$ip" "$@"
}
