#!/usr/bin/env bash
# Interactive bootstrap for selfhosted dev helpers.
#
# Prompts for the values provision.sh needs, saves them to ~/.kodus-dev/config
# (chmod 600 — only your user can read). Re-running shows current values
# (masked) and lets you update field by field.
#
# If direnv is installed, offers to create an .envrc in the repo that
# auto-loads the config when you cd into the project.
#
# Usage:
#   pnpm run selfhosted:setup          # interactive
#   pnpm run selfhosted:setup --show   # show current config (masked)
#   pnpm run selfhosted:setup --path   # print config file path and exit

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

CONFIG_DIR="$HOME/.kodus-dev"
CONFIG_FILE="$CONFIG_DIR/config"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; BLUE='\033[0;34m'; GRAY='\033[0;90m'; NC='\033[0m'
log()  { echo -e "${BLUE}[setup]${NC} $*"; }
ok()   { echo -e "${GREEN}[ok]${NC}     $*"; }
warn() { echo -e "${YELLOW}[warn]${NC}   $*"; }
dim()  { echo -e "${GRAY}$*${NC}"; }

mode="interactive"
while [ $# -gt 0 ]; do
    case "$1" in
        --show) mode="show"; shift ;;
        --path) echo "$CONFIG_FILE"; exit 0 ;;
        -h|--help)
            grep -E '^#( |$)' "$0" | sed 's/^# \?//'
            exit 0
            ;;
        *) echo "Unknown arg: $1" >&2; exit 2 ;;
    esac
done

# Load defaults for each field. Priority:
#   1) value from the config file (if it exists)
#   2) value from the caller's env (so first-time setup pre-fills anything
#      the user already has exported — they just press Enter to save it)
#   3) empty
if [ -f "$CONFIG_FILE" ]; then
    # shellcheck disable=SC1090
    set -a; . "$CONFIG_FILE"; set +a
fi
existing_do_token="${DIGITALOCEAN_TOKEN:-}"
existing_license="${SH_LICENSE_KEY:-}"
existing_gh_token="${GH_DEV_TOKEN:-}"
existing_openai_key="${API_OPEN_AI_API_KEY:-}"
existing_openai_base_url="${API_OPENAI_FORCE_BASE_URL:-}"
existing_llm_model="${API_LLM_PROVIDER_MODEL:-}"
existing_installer_path="${KODUS_INSTALLER_PATH:-}"

# Team-wide LLM defaults (Kimi K2.6 via Moonshot OpenAI-compatible endpoint).
# Used on first setup when the user hasn't picked anything. External
# contributors can override at the prompt or pick OpenAI by leaving the
# base URL empty and using a gpt-* model.
DEFAULT_LLM_MODEL="kimi-k2.6"
DEFAULT_OPENAI_BASE_URL="https://api.moonshot.ai/v1"

mask() {
    local val="$1"
    if [ -z "$val" ]; then
        echo "${GRAY}(not set)${NC}"
        return
    fi
    # 1Password references aren't secret on their own — they're just paths.
    # Show them verbatim so the user can spot mistakes.
    case "$val" in
        op://*) echo "${GRAY}1Password ref:${NC} $val"; return ;;
    esac
    local len=${#val}
    if [ "$len" -le 8 ]; then
        echo "${val:0:2}…${val: -2}"
    else
        echo "${val:0:6}…${val: -4}  (${len} chars)"
    fi
}

# Detect 1Password CLI so we can hint at it in prompts. External contributors
# without `op` installed see plain-value prompts only.
OP_AVAILABLE=0
OP_HINT=""
if command -v op >/dev/null 2>&1; then
    OP_AVAILABLE=1
    OP_HINT=" — or paste a 1Password ref like op://Engineering/kodus-dev/<field>"
fi

if [ "$mode" = "show" ]; then
    log "Config: $CONFIG_FILE"
    [ -f "$CONFIG_FILE" ] || { warn "(does not exist — run 'pnpm run selfhosted:setup' to create)"; exit 0; }
    echo ""
    echo -e "  ${BLUE}DIGITALOCEAN_TOKEN${NC}          $(mask "$existing_do_token")"
    echo -e "  ${BLUE}SH_LICENSE_KEY${NC}              $(mask "$existing_license")"
    echo -e "  ${BLUE}GH_DEV_TOKEN${NC}                $(mask "$existing_gh_token")"
    echo -e "  ${BLUE}API_OPEN_AI_API_KEY${NC}         $(mask "$existing_openai_key")"
    echo -e "  ${BLUE}API_OPENAI_FORCE_BASE_URL${NC}   ${existing_openai_base_url:-${GRAY}(not set)${NC}}"
    echo -e "  ${BLUE}API_LLM_PROVIDER_MODEL${NC}      ${existing_llm_model:-${GRAY}(not set)${NC}}"
    echo -e "  ${BLUE}KODUS_INSTALLER_PATH${NC}        ${existing_installer_path:-${GRAY}(not set)${NC}}"
    echo ""
    exit 0
fi

# ---------- interactive prompts ----------

prompt_secret() {
    local label="$1" current="$2" hint="$3"
    local current_display
    if [ -n "$current" ]; then
        current_display="  (current: $(mask "$current"))"
    fi
    echo "" >&2
    echo -e "${BLUE}${label}${NC}${current_display}" >&2
    [ -n "$hint" ] && dim "  $hint" >&2
    echo -n "  → " >&2
    # -s hides input, but we still want a newline after they hit enter
    local input
    read -rs input
    echo "" >&2
    echo "$input"
}

prompt_plain() {
    local label="$1" current="$2" hint="$3"
    echo "" >&2
    echo -e "${BLUE}${label}${NC}" >&2
    [ -n "$hint" ] && dim "  $hint" >&2
    if [ -n "$current" ]; then
        echo -n "  [$current] → " >&2
    else
        echo -n "  → " >&2
    fi
    local input
    read -r input
    if [ -z "$input" ] && [ -n "$current" ]; then
        echo "$current"
    else
        echo "$input"
    fi
}

cat <<INTRO

$(echo -e "${GREEN}╭─ Kodus self-hosted dev setup ─╮${NC}")

  Saved to $CONFIG_FILE (chmod 600).
  Re-running: press Enter to keep the current value; type to replace it.
$( [ "$OP_AVAILABLE" = "1" ] && echo "  1Password CLI detected — see scripts/selfhosted/op-references.md for shared team paths." )

INTRO

new_do_token=$(prompt_secret "DigitalOcean API token" "$existing_do_token" \
    "https://cloud.digitalocean.com/account/api — scopes: droplet:create/read/delete + ssh_key:create/read/delete${OP_HINT}")
if [ -z "$new_do_token" ] && [ -n "$existing_do_token" ]; then
    new_do_token="$existing_do_token"
fi
if [ -z "$new_do_token" ]; then
    warn "DIGITALOCEAN_TOKEN is required (default provider). Aborting."
    exit 1
fi

new_license=$(prompt_secret "Self-hosted license key" "$existing_license" \
    "Optional. Empty = stack boots in the installer's default mode (paid features locked).${OP_HINT}")
if [ -z "$new_license" ] && [ -n "$existing_license" ]; then
    new_license="$existing_license"
fi

new_gh_token=$(prompt_secret "GitHub dev token (PAT)" "$existing_gh_token" \
    "Optional. If set, provision.sh auto-configures the GitHub integration after signup.${OP_HINT}")
if [ -z "$new_gh_token" ] && [ -n "$existing_gh_token" ]; then
    new_gh_token="$existing_gh_token"
fi

new_openai_key=$(prompt_secret "OpenAI-compatible API key" "$existing_openai_key" \
    "Required for Kodus to review PRs. Team default uses Kimi/Moonshot — get a key at https://platform.moonshot.ai. For native OpenAI, use https://platform.openai.com/api-keys.${OP_HINT}")
if [ -z "$new_openai_key" ] && [ -n "$existing_openai_key" ]; then
    new_openai_key="$existing_openai_key"
fi

# Default base URL + model to Kimi on first setup; keep whatever the user
# had on re-runs.
default_base_url="${existing_openai_base_url:-$DEFAULT_OPENAI_BASE_URL}"
new_openai_base_url=$(prompt_plain "OpenAI-compatible base URL" "$default_base_url" \
    "Team default: $DEFAULT_OPENAI_BASE_URL (Moonshot for Kimi). For native OpenAI, set to https://api.openai.com/v1 (or leave empty — the app treats empty as OpenAI default).")
if [ -z "$new_openai_base_url" ] && [ -n "$existing_openai_base_url" ]; then
    new_openai_base_url="$existing_openai_base_url"
fi

default_llm_model="${existing_llm_model:-$DEFAULT_LLM_MODEL}"
new_llm_model=$(prompt_plain "LLM model" "$default_llm_model" \
    "Team default: $DEFAULT_LLM_MODEL (Moonshot Kimi K2.6). For OpenAI, use 'gpt-4o' or 'auto' to let Kodus router pick.")
if [ -z "$new_llm_model" ] && [ -n "$existing_llm_model" ]; then
    new_llm_model="$existing_llm_model"
fi

# If any tracked secret looks like an op:// ref, validate it now so the user
# catches typos at setup time rather than at the next provision/deploy.
if [ "$OP_AVAILABLE" = "1" ]; then
    validate_op_ref() {
        local label=$1 value=$2
        case "$value" in
            op://*) ;;
            *) return 0 ;;
        esac
        if op read --no-newline "$value" >/dev/null 2>&1; then
            ok "$label: 1Password ref resolves OK"
        else
            warn "$label: 1Password ref does NOT resolve ($value)"
            warn "  Check the path or run 'op signin' if your session expired."
            warn "  Saving anyway — fix it later by re-running 'pnpm run selfhosted:setup'."
        fi
    }
    validate_op_ref "DIGITALOCEAN_TOKEN" "$new_do_token"
    validate_op_ref "SH_LICENSE_KEY" "$new_license"
    validate_op_ref "GH_DEV_TOKEN" "$new_gh_token"
    validate_op_ref "API_OPEN_AI_API_KEY" "$new_openai_key"
fi

default_installer_path="${existing_installer_path:-$REPO_ROOT/../kodus-installer}"
new_installer_path=$(prompt_plain "Path to kodus-installer checkout" "$default_installer_path" \
    "Where the local installer checkout lives (the script rsyncs it onto the droplet).")
if [ ! -d "$new_installer_path" ]; then
    warn "Directory $new_installer_path does not exist yet. That's fine — provision.sh will complain if you try to provision before cloning."
fi

# ---------- write config atomically ----------
mkdir -p "$CONFIG_DIR"
chmod 700 "$CONFIG_DIR"

tmp_file="${CONFIG_FILE}.tmp.$$"
cat > "$tmp_file" <<EOF
# Kodus self-hosted dev config — generated by scripts/selfhosted/setup.sh
# Source via 'set -a; . ~/.kodus-dev/config; set +a' or via direnv .envrc.
# Re-run 'pnpm run selfhosted:setup' to update.

DIGITALOCEAN_TOKEN=$new_do_token
SH_LICENSE_KEY=$new_license
GH_DEV_TOKEN=$new_gh_token
API_OPEN_AI_API_KEY=$new_openai_key
API_OPENAI_FORCE_BASE_URL=$new_openai_base_url
API_LLM_PROVIDER_MODEL=$new_llm_model
KODUS_INSTALLER_PATH=$new_installer_path
EOF
chmod 600 "$tmp_file"
mv "$tmp_file" "$CONFIG_FILE"

ok "Saved to $CONFIG_FILE"

# ---------- direnv offer ----------
ENVRC="$REPO_ROOT/.envrc"
if command -v direnv >/dev/null 2>&1; then
    if [ -f "$ENVRC" ]; then
        if grep -q "kodus-dev/config" "$ENVRC" 2>/dev/null; then
            ok "$ENVRC already loads the config (direnv ready)"
        else
            warn "$ENVRC exists but does not load ~/.kodus-dev/config — add it manually if you want auto-load."
        fi
    else
        echo ""
        echo -e "${BLUE}direnv detected.${NC} Create $ENVRC to auto-load this config when you cd into the repo? (y/N): "
        read -r reply
        if [[ "$reply" =~ ^[Yy]$ ]]; then
            cat > "$ENVRC" <<EOF
# Auto-loads Kodus dev config when you cd into this repo.
# Managed by scripts/selfhosted/setup.sh — run it to regenerate.
if [ -f "\$HOME/.kodus-dev/config" ]; then
    dotenv "\$HOME/.kodus-dev/config"
fi
EOF
            ok "$ENVRC created"
            if direnv allow "$REPO_ROOT" 2>/dev/null; then
                ok "direnv allow granted — env will load automatically."
            else
                warn "Run 'direnv allow' manually in the repo to activate."
            fi
        else
            dim "Skipping direnv. You can run 'set -a; . ~/.kodus-dev/config; set +a' manually, or create .envrc later."
        fi
    fi
else
    dim ""
    dim "direnv not detected. Install with 'brew install direnv' for auto-load (optional)."
    dim "Without direnv: scripts/selfhosted/*.sh reads ~/.kodus-dev/config automatically."
fi

cat <<DONE

$(echo -e "${GREEN}Done.${NC}") Next step:

  pnpm run selfhosted:provision

DONE
