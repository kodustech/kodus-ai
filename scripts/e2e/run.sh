#!/usr/bin/env bash
# Run E2E quality gates locally — same scenarios that CI uses.
#
# Three modes:
#   dry-run   Validates wiring without provisioning or hitting providers.
#             Instant. No secrets needed. Run this first.
#   smoke     Runs ONE scenario × provider against the alive self-hosted droplet
#             from `pnpm run selfhosted:provision`. Fast (~3 min). Needs provider
#             token for the chosen provider.
#   matrix    Full matrix from tests/e2e/matrix/*.yml. Provisions fresh droplets
#             per self-hosted cell, hits all configured providers. Slow (~30-45
#             min) and costs droplet hours (~$1-2). Cells without the required
#             provider token are SKIPPED with a warning, not failed.
#
# Usage:
#   pnpm run e2e:dry-run
#   pnpm run e2e:smoke                                # github × code-review-basic
#   pnpm run e2e:smoke --provider gitlab              # different provider
#   pnpm run e2e:smoke --scenario kody-rules-create-and-apply
#   pnpm run e2e:smoke --name junior                  # against named instance
#   pnpm run e2e:matrix                               # default: matrix/fast.yml
#   pnpm run e2e:matrix matrix/full.yml               # full tier (adds upgrade/SSO/Stripe)
#   pnpm run e2e:matrix -y                            # skip confirmation prompt
#   pnpm run e2e:matrix matrix/full.yml --auto-provision -y
#                                                 # also ensure self-hosted +
#                                                 # sso-e2e droplets, seed
#                                                 # cloud tenants, and export
#                                                 # TARGET_* env vars from the
#                                                 # provisioned droplet's state
#                                                 # file. All idempotent.
#
# Config sources (same as scripts/selfhosted/):
#   1. Inline env (highest)
#   2. scripts/e2e/.env (gitignored)
#   3. ~/.kodus-dev/config (managed by `pnpm run selfhosted:setup`)
#
# Per-provider env vars needed for smoke/matrix (matrix skips cells without):
#   github       GH_TEST_TOKEN, GH_TEST_REPO        (optional: GH_TEST_PR_NUMBER)
#   gitlab       GL_TEST_TOKEN, GL_TEST_REPO        (optional: GL_TEST_MR_IID)
#   bitbucket    BB_TEST_USER, BB_TEST_APP_PASSWORD, BB_TEST_REPO   (optional: BB_TEST_PR_ID)
#   azure-devops AZ_TEST_TOKEN, AZ_TEST_ORG, AZ_TEST_PROJECT, AZ_TEST_REPO  (optional: AZ_TEST_PR_ID)
#
# `op://Vault/Item/field` references in the config are resolved via 1Password CLI.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
STATE_DIR="$REPO_ROOT/.kodus-dev"
GLOBAL_CONFIG="$HOME/.kodus-dev/config"
LOCAL_ENV="$SCRIPT_DIR/.env"
E2E_DIR="$REPO_ROOT/tests/e2e"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; BLUE='\033[0;34m'; GRAY='\033[0;90m'; NC='\033[0m'
log()  { echo -e "${BLUE}[e2e]${NC}  $*"; }
ok()   { echo -e "${GREEN}[ok]${NC}   $*"; }
warn() { echo -e "${YELLOW}[warn]${NC} $*"; }
err()  { echo -e "${RED}[err]${NC}  $*" >&2; }
dim()  { echo -e "${GRAY}$*${NC}"; }

usage() {
    grep -E '^#( |$)' "$0" | sed 's/^# \?//'
}

# Load KEY=VALUE pairs from a file without overriding env that's already set
# (caller wins, same precedence semantics as scripts/selfhosted/_common.sh).
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

# Resolve any var whose value starts with op:// via the 1Password CLI.
# Vars that aren't set or don't start with op:// are left alone.
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
            err "  Install: brew install --cask 1password-cli"
            err "  Or replace with plain value in ~/.kodus-dev/config"
            exit 1
        fi
        if ! resolved=$(op read --no-newline "$val" 2>&1); then
            err "Failed to resolve $var ($val):"
            err "  $resolved"
            err "  Make sure 'op signin' is current (or 1Password app integration is enabled)."
            exit 1
        fi
        export "$var=$resolved"
    done
}

MODE="${1:-}"; [ $# -gt 0 ] && shift
case "$MODE" in
    dry-run|smoke|matrix) ;;
    -h|--help|"") usage; exit 0 ;;
    *) err "Unknown mode '$MODE'"; echo ""; usage; exit 2 ;;
esac

# Load config in priority order: caller env > scripts/e2e/.env > ~/.kodus-dev/config.
# load_config_file is "set only if unset", so whichever file we load FIRST wins.
# Load LOCAL_ENV first so a per-repo override beats the global default.
#
# Resolution of `op://` refs happens lazily per-mode below — dry-run never needs
# any secret, so resolving upfront would fail if the user's 1Password session
# is expired and block work that doesn't need secrets at all.
load_config_file "$LOCAL_ENV"
load_config_file "$GLOBAL_CONFIG"

cd "$E2E_DIR"

if [ ! -d node_modules ]; then
    log "Installing tests/e2e dependencies (first run only)..."
    npm install --silent
fi

case "$MODE" in
    dry-run)
        log "Dry-run — validates wiring, hits no providers, provisions nothing."
        exec npm run dry-run
        ;;

    smoke)
        SCENARIO="code-review-basic"
        PROVIDER="github"
        INSTANCE_NAME="default"
        LICENSE="license-paid"
        while [ $# -gt 0 ]; do
            case "$1" in
                --scenario)  SCENARIO="$2"; shift 2 ;;
                --provider)  PROVIDER="$2"; shift 2 ;;
                --name)      INSTANCE_NAME="$2"; shift 2 ;;
                --license)   LICENSE="$2"; shift 2 ;;
                -h|--help)   usage; exit 0 ;;
                *) err "Unknown smoke arg: $1"; exit 2 ;;
            esac
        done

        # Resolve only the secrets this smoke needs.
        case "$PROVIDER" in
            github)       resolve_op_refs GH_TEST_TOKEN ;;
            gitlab)       resolve_op_refs GL_TEST_TOKEN ;;
            bitbucket)    resolve_op_refs BB_TEST_USER BB_TEST_APP_PASSWORD ;;
            azure-devops) resolve_op_refs AZ_TEST_TOKEN ;;
        esac

        STATE_FILE="$STATE_DIR/selfhosted-vm-${INSTANCE_NAME}.json"
        if [ ! -f "$STATE_FILE" ]; then
            err "No alive self-hosted instance named '$INSTANCE_NAME'."
            err "  Run: pnpm run selfhosted:provision${INSTANCE_NAME:+ --name $INSTANCE_NAME}"
            err "  (smoke runs against the droplet you already have — it does not provision one)"
            exit 1
        fi

        SERVER_IP=$(jq -r .server_ip "$STATE_FILE")
        TUNNEL_URL=$(jq -r .tunnel_url "$STATE_FILE")
        EMAIL=$(jq -r .tenant.email "$STATE_FILE")
        PASSWORD=$(jq -r .tenant.password "$STATE_FILE")

        [ -n "$SERVER_IP" ] && [ "$SERVER_IP" != "null" ] || { err "state file missing .server_ip"; exit 1; }
        [ -n "$TUNNEL_URL" ] && [ "$TUNNEL_URL" != "null" ] || { err "state file missing .tunnel_url"; exit 1; }
        [ -n "$EMAIL" ]      && [ "$EMAIL"      != "null" ] || { err "state file missing .tenant.email"; exit 1; }

        export TARGET_BASE_URL="http://$SERVER_IP:3001"
        export TARGET_WEB_URL="http://$SERVER_IP:3000"
        export TARGET_TUNNEL_URL="$TUNNEL_URL"
        export SH_TENANT_EMAIL="$EMAIL"
        export SH_TENANT_PASSWORD="$PASSWORD"

        case "$PROVIDER" in
            github)
                [ -n "${GH_TEST_TOKEN:-}" ] || { err "GH_TEST_TOKEN is required for smoke --provider github."; exit 1; }
                [ -n "${GH_TEST_REPO:-}" ]  || { err "GH_TEST_REPO is required for smoke --provider github (e.g. owner/repo)."; exit 1; }
                ;;
            gitlab)
                [ -n "${GL_TEST_TOKEN:-}" ] || { err "GL_TEST_TOKEN is required for smoke --provider gitlab."; exit 1; }
                [ -n "${GL_TEST_REPO:-}" ]  || { err "GL_TEST_REPO is required for smoke --provider gitlab."; exit 1; }
                ;;
            bitbucket)
                [ -n "${BB_TEST_USER:-}" ]         || { err "BB_TEST_USER is required for smoke --provider bitbucket."; exit 1; }
                [ -n "${BB_TEST_APP_PASSWORD:-}" ] || { err "BB_TEST_APP_PASSWORD is required for smoke --provider bitbucket."; exit 1; }
                [ -n "${BB_TEST_REPO:-}" ]         || { err "BB_TEST_REPO is required for smoke --provider bitbucket."; exit 1; }
                ;;
            azure-devops)
                [ -n "${AZ_TEST_TOKEN:-}" ]   || { err "AZ_TEST_TOKEN is required for smoke --provider azure-devops."; exit 1; }
                [ -n "${AZ_TEST_ORG:-}" ]     || { err "AZ_TEST_ORG is required for smoke --provider azure-devops."; exit 1; }
                [ -n "${AZ_TEST_PROJECT:-}" ] || { err "AZ_TEST_PROJECT is required for smoke --provider azure-devops."; exit 1; }
                [ -n "${AZ_TEST_REPO:-}" ]    || { err "AZ_TEST_REPO is required for smoke --provider azure-devops."; exit 1; }
                ;;
            *) err "Unknown provider '$PROVIDER'. Valid: github, gitlab, bitbucket, azure-devops"; exit 2 ;;
        esac

        log "Smoke: ${BLUE}$SCENARIO${NC} × ${BLUE}$PROVIDER${NC} × self-hosted (instance '$INSTANCE_NAME' @ $SERVER_IP)"
        exec npm run scenario -- \
            --scenario "$SCENARIO" \
            --target self-hosted \
            --provider "$PROVIDER" \
            --license "$LICENSE"
        ;;

    matrix)
        ASSUME_YES=0
        AUTO_PROVISION=0
        AUTO_PROVISION_PER_PROVIDER=0
        MATRIX_FILE="matrix/fast.yml"
        TARGET_FLAG=""
        TARGET_NAME=""
        while [ $# -gt 0 ]; do
            case "$1" in
                -y|--yes)  ASSUME_YES=1; shift ;;
                --auto-provision) AUTO_PROVISION=1; shift ;;
                # One isolated droplet PER self-hosted provider, so the
                # provider units the runner schedules in parallel each hit
                # their own backend. Implies --auto-provision.
                --auto-provision-per-provider) AUTO_PROVISION=1; AUTO_PROVISION_PER_PROVIDER=1; shift ;;
                --target)  TARGET_FLAG="--target $2"; TARGET_NAME="$2"; shift 2 ;;
                --target=*) TARGET_FLAG="--target ${1#--target=}"; TARGET_NAME="${1#--target=}"; shift ;;
                -h|--help) usage; exit 0 ;;
                -*)        err "Unknown matrix flag: $1"; exit 2 ;;
                *)         MATRIX_FILE="$1"; shift ;;
            esac
        done

        [ -f "$MATRIX_FILE" ] || { err "Matrix file not found: $MATRIX_FILE (relative to tests/e2e/)"; exit 1; }

        echo ""
        echo -e "${YELLOW}=== matrix local run ===${NC}"
        echo "Matrix file:    $MATRIX_FILE"
        echo ""
        echo "This will:"
        echo "  - Provision fresh self-hosted droplets (one per self-hosted cell)"
        echo "  - Hit real provider APIs using your configured test tokens"
        echo "  - Cells whose provider tokens aren't set are SKIPPED (not failed)"
        echo ""
        echo "Estimate: ~30-45 min, ~\$1-2 in droplet hours."
        echo ""

        if [ "$ASSUME_YES" != "1" ]; then
            read -r -p "$(echo -e "${YELLOW}Continue? (y/N): ${NC}")" REPLY
            [[ "$REPLY" =~ ^[Yy]$ ]] || { warn "Aborted."; exit 0; }
        fi

        # Resolve only the secrets the matrix will actually use. Cloud-only
        # runs don't need DO/Hetzner/SH_LICENSE_KEY (those drive self-hosted
        # droplet provisioning); resolving them via 1Password forces an
        # `op signin` that fails when the dev's session is expired even though
        # the cloud run wouldn't touch DO at all.
        if [ "$TARGET_FLAG" = "--target cloud" ]; then
            resolve_op_refs \
                GH_TEST_TOKEN GL_TEST_TOKEN \
                BB_TEST_USER BB_TEST_APP_PASSWORD \
                AZ_TEST_TOKEN \
                CLOUD_TENANT_PAID_PASSWORD CLOUD_TENANT_FREE_PASSWORD CLOUD_TENANT_TRIAL_PASSWORD
        else
            resolve_op_refs \
                DIGITALOCEAN_TOKEN HCLOUD_TOKEN \
                SH_LICENSE_KEY GH_DEV_TOKEN \
                GH_TEST_TOKEN GL_TEST_TOKEN \
                BB_TEST_USER BB_TEST_APP_PASSWORD \
                AZ_TEST_TOKEN \
                CLOUD_TENANT_PAID_PASSWORD CLOUD_TENANT_FREE_PASSWORD CLOUD_TENANT_TRIAL_PASSWORD
        fi

        # ----- optional auto-provision -----
        # Ensures the matrix has everything it needs before the runner
        # starts: self-hosted droplet (`matrix`), the SSO E2E droplet
        # (`sso-e2e`) for sso-* scenarios, the cloud tenants seeded on
        # qa.web.kodus.io, and the TARGET_* / SH_TENANT_PASSWORD env
        # vars the runner reads. Each step is idempotent (--reuse on
        # provision scripts, signup-409-OK on tenant seeding) so this
        # is safe to run from a cold or warm state.
        # Distinct self-hosted providers referenced by the matrix file.
        # Cells list `target:` then `provider:`, so track the most recent
        # target and emit the provider only while inside a self-hosted cell.
        SELFHOSTED_PROVIDERS=$(awk '
            /^[[:space:]]*-?[[:space:]]*target:[[:space:]]/ { t=$NF }
            /^[[:space:]]*provider:[[:space:]]/ { if (t=="self-hosted") print $NF }
        ' "$E2E_DIR/$MATRIX_FILE" | sort -u)

        if [ "$AUTO_PROVISION" = "1" ]; then
            if [ "$AUTO_PROVISION_PER_PROVIDER" = "1" ]; then
                [ -n "$SELFHOSTED_PROVIDERS" ] || { err "--auto-provision-per-provider: no self-hosted cells in $MATRIX_FILE"; exit 1; }
                log "auto-provision (per-provider): $(echo $SELFHOSTED_PROVIDERS | tr '\n' ' ')"
                # Serial provisioning is the safe default — each droplet
                # applies the cached dev-image override (from a prior
                # `selfhosted:deploy-all`) on creation, so all providers end
                # up on the same image. The wall-time win comes from the
                # parallel RUN, not parallel provisioning. (Parallelizing
                # provisioning itself is a future optimization.)
                for p in $SELFHOSTED_PROVIDERS; do
                    log "auto-provision: ensuring droplet matrix-$p (--reuse)"
                    "$REPO_ROOT/scripts/selfhosted/provision.sh" --name "matrix-$p" --reuse
                done
            else
                log "auto-provision: ensuring matrix droplet (--reuse)"
                "$REPO_ROOT/scripts/selfhosted/provision.sh" --name matrix --reuse
            fi

            # SSO E2E droplet only matters if the matrix file references
            # an sso-* scenario. Cheap check: grep the YAML.
            if grep -qE '^\s*-\s*sso-(cookie-domain|multi-user)\b' "$E2E_DIR/$MATRIX_FILE"; then
                # The sso-e2e droplet's bootstrap-kodus-sso.sh has to
                # POST /sso-config, which is gated by the enterprise-
                # tier license guard (libs/ee/license/guards/
                # enterprise-tier.guard.ts). A signed-up tenant on a
                # license-less droplet rejects it with HTTP 403
                # "organization is not on a supported plan", and the
                # provision script exits 1 — burning ~10 min on a
                # doomed droplet. Fail FAST here instead.
                #
                # Operator fix: set SH_LICENSE_KEY in ~/.kodus-dev/config
                # (op://Engineering/kodus-self-hosted-dev/license-paid).
                if [ -z "${SH_LICENSE_KEY:-}" ]; then
                    err "Matrix references sso-* scenarios but SH_LICENSE_KEY is empty."
                    err "  sso-e2e droplet provision will fail at POST /sso-config (HTTP 403 enterprise tier)."
                    err "  Fix: set SH_LICENSE_KEY in ~/.kodus-dev/config (pnpm run selfhosted:setup)."
                    err "  Workaround for this run: use a YAML without sso-cookie-domain / sso-multi-user."
                    exit 1
                fi
                log "auto-provision: ensuring sso-e2e droplet (--reuse)"
                "$REPO_ROOT/scripts/sso-e2e/droplet/provision.sh" --reuse --skip-test
            fi

            # Cloud tenants only matter if the matrix has cloud cells.
            if [ "$TARGET_NAME" != "self-hosted" ] && grep -qE '^\s*target:\s*cloud\b' "$E2E_DIR/$MATRIX_FILE"; then
                log "auto-provision: ensuring cloud tenants (idempotent signup)"
                "$REPO_ROOT/scripts/e2e/cloud-setup-tenants.sh"
            fi

            # Export SELFHOSTED_* + SH_TENANT_PASSWORD from the matrix
            # droplet's state file. The runner reads SELFHOSTED_* only
            # for the self-hosted target (and CLOUD_* for the cloud
            # target) — using the target-scoped names instead of the
            # generic TARGET_* avoids the env leaking into cloud cells
            # and pointing them at the droplet (observed 2026-05-20:
            # cloud login HTTP 401 because TARGET_BASE_URL hit the
            # droplet's API instead of qa.web.kodus.io).
            if [ "$TARGET_NAME" != "cloud" ]; then
                # (instance, env-suffix) pairs to export. Per-provider: one
                # droplet each, suffix scopes the var (SELFHOSTED_*_<SFX>).
                # Single: one shared droplet, generic SELFHOSTED_* vars.
                SH_EXPORT_PAIRS=""
                if [ "$AUTO_PROVISION_PER_PROVIDER" = "1" ]; then
                    for p in $SELFHOSTED_PROVIDERS; do
                        sfx=$(echo "$p" | tr '[:lower:]-' '[:upper:]_')
                        SH_EXPORT_PAIRS="$SH_EXPORT_PAIRS matrix-$p:$sfx"
                    done
                else
                    SH_EXPORT_PAIRS="matrix:"
                fi

                for pair in $SH_EXPORT_PAIRS; do
                    inst="${pair%%:*}"
                    sfx="${pair#*:}"
                    state="$STATE_DIR/selfhosted-vm-$inst.json"
                    if [ ! -f "$state" ]; then
                        warn "auto-provision: no state file for $inst — skipping export"
                        continue
                    fi
                    ip=$(jq -r .server_ip "$state")
                    pw=$(jq -r .tenant.password "$state")

                    # Refresh the cloudflared quick-tunnel URL. Quick tunnels
                    # get a NEW random URL whenever `cloudflared tunnel --url`
                    # restarts (the systemd Restart=on-failure kicked by
                    # Cloudflare's ~2-3h session limit), so the provision-time
                    # value goes stale. Re-grep the live log before the run.
                    key="$STATE_DIR/ssh-keys/$inst"
                    tun=""
                    if [ -f "$key" ]; then
                        tun=$(ssh -i "$key" \
                            -o StrictHostKeyChecking=no \
                            -o UserKnownHostsFile=/dev/null \
                            -o LogLevel=ERROR \
                            -o ConnectTimeout=10 \
                            "root@${ip}" \
                            "grep -oE 'https://[a-zA-Z0-9-]+\\.trycloudflare\\.com' /var/log/cloudflared.log 2>/dev/null | tail -n1" 2>/dev/null || true)
                    fi
                    if [ -n "$tun" ]; then
                        tmp=$(mktemp)
                        jq --arg url "$tun" '.tunnel_url = $url' "$state" > "$tmp" && mv "$tmp" "$state"
                    else
                        tun=$(jq -r .tunnel_url "$state")
                        warn "auto-provision: could not refresh tunnel for $inst; using state value ($tun)"
                    fi

                    if [ -n "$sfx" ]; then
                        export "SELFHOSTED_API_BASE_URL_$sfx=http://${ip}:3001"
                        [ -n "$tun" ] && [ "$tun" != "null" ] && export "SELFHOSTED_TUNNEL_URL_$sfx=$tun"
                    else
                        export SELFHOSTED_API_BASE_URL="http://${ip}:3001"
                        [ -n "$tun" ] && [ "$tun" != "null" ] && export SELFHOSTED_TUNNEL_URL="$tun"
                    fi
                    # One shared tenant password suffices: resolveTenantForCell
                    # signs up a fresh e2e tenant per (provider, run) using it
                    # on each droplet, so any droplet's password works.
                    [ -z "${SH_TENANT_PASSWORD:-}" ] && [ -n "$pw" ] && [ "$pw" != "null" ] && export SH_TENANT_PASSWORD="$pw"
                    log "auto-provision: $inst → SELFHOSTED_API_BASE_URL${sfx:+_$sfx}=http://${ip}:3001 (tunnel ${tun:0:40})"
                done
            fi
        fi

        log "Running matrix: $MATRIX_FILE ${TARGET_FLAG:+(target filter: ${TARGET_FLAG#--target })}"
        # shellcheck disable=SC2086
        exec npm run matrix -- "$MATRIX_FILE" --skip-missing-tokens $TARGET_FLAG
        ;;
esac
