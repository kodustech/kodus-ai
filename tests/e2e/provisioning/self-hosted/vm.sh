#!/usr/bin/env bash
# Self-hosted E2E provisioning + matrix runner.
#
# Provisions an ephemeral cloud VM (DigitalOcean by default, Hetzner with
# TEST_VM_PROVIDER=hetzner), installs the Kodus stack from kodus-installer at
# the requested image tag, sets the license key, signs up a test user, exposes
# webhooks via a Cloudflare quick tunnel, then exec's the matrix runner.
#
# Required env (or tests/e2e/.env in this repo):
#   IMAGE_TAG              Tag to test (e.g. selfhosted-1.42.0-rc.1)
#   KODUS_INSTALLER_PATH   Path to a local checkout of kodus-installer
#   DIGITALOCEAN_TOKEN     DO API token (default provider)
#       OR
#   TEST_VM_PROVIDER=hetzner + HCLOUD_TOKEN
#
# Optional env:
#   MATRIX_FILE            Path to matrix YAML (default: matrix/fast.yml)
#   LICENSE_MODE           "license-paid" (default) | "license-free"
#   SH_LICENSE_KEY_PAID    License key string for license-paid
#   SH_LICENSE_KEY_FREE    License key string for license-free
#   TEST_KEEP_RUNNING      "1" to skip teardown for debug
#   TEST_TIMEOUT_REVIEW    seconds (default 600)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
E2E_ROOT="${REPO_ROOT}/tests/e2e"
cd "$REPO_ROOT"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; BLUE='\033[0;34m'; NC='\033[0m'
log()  { echo -e "${BLUE}[provision]${NC} $*"; }
ok()   { echo -e "${GREEN}[ok]${NC}       $*"; }
warn() { echo -e "${YELLOW}[warn]${NC}     $*"; }
err()  { echo -e "${RED}[err]${NC}      $*" >&2; }

if [ -f "$E2E_ROOT/.env" ]; then
    set -a; . "$E2E_ROOT/.env"; set +a
fi

TEST_VM_PROVIDER="${TEST_VM_PROVIDER:-digitalocean}"
MATRIX_FILE="${MATRIX_FILE:-matrix/fast.yml}"
LICENSE_MODE="${LICENSE_MODE:-license-paid}"
TEST_TIMEOUT_REVIEW="${TEST_TIMEOUT_REVIEW:-600}"
IMAGE_TAG="${IMAGE_TAG:-latest}"

# State for cleanup
SERVER_ID=""
SSH_KEY_ID=""
LOCAL_SSH_KEY=""
SERVER_IP=""
SERVER_TUNNEL_URL=""

DO_API="https://api.digitalocean.com/v2"
DO_REGION="${DO_REGION:-nyc3}"
DO_SIZE="${DO_SIZE:-s-2vcpu-4gb}"
DO_IMAGE="${DO_IMAGE:-ubuntu-24-04-x64}"

HCLOUD_API="https://api.hetzner.cloud/v1"
HCLOUD_LOCATION="${HCLOUD_LOCATION:-nbg1}"
HCLOUD_SERVER_TYPE="${HCLOUD_SERVER_TYPE:-cx22}"
HCLOUD_IMAGE="${HCLOUD_IMAGE:-ubuntu-24.04}"

provision_ssh_key() {
    local name=$1 pubkey=$2
    case "$TEST_VM_PROVIDER" in
        digitalocean)
            local resp
            resp=$(curl -sS -X POST \
                -H "Authorization: Bearer ${DIGITALOCEAN_TOKEN}" \
                -H "Content-Type: application/json" \
                "$DO_API/account/keys" \
                -d "$(jq -nc --arg n "$name" --arg k "$pubkey" '{name:$n, public_key:$k}')")
            SSH_KEY_ID=$(echo "$resp" | jq -r '.ssh_key.id // empty')
            [ -n "$SSH_KEY_ID" ] || { err "DO key upload failed: $resp"; exit 1; }
            ;;
        hetzner)
            local resp
            resp=$(curl -sS -X POST \
                -H "Authorization: Bearer ${HCLOUD_TOKEN}" \
                -H "Content-Type: application/json" \
                "$HCLOUD_API/ssh_keys" \
                -d "$(jq -nc --arg n "$name" --arg k "$pubkey" '{name:$n, public_key:$k}')")
            SSH_KEY_ID=$(echo "$resp" | jq -r '.ssh_key.id // empty')
            [ -n "$SSH_KEY_ID" ] || { err "Hetzner key upload failed: $resp"; exit 1; }
            ;;
    esac
}

provision_server() {
    local name=$1 user_data=$2
    case "$TEST_VM_PROVIDER" in
        digitalocean)
            local resp
            resp=$(curl -sS -X POST \
                -H "Authorization: Bearer ${DIGITALOCEAN_TOKEN}" \
                -H "Content-Type: application/json" \
                "$DO_API/droplets" \
                -d "$(jq -nc \
                    --arg name "$name" --arg region "$DO_REGION" \
                    --arg size "$DO_SIZE" --arg image "$DO_IMAGE" \
                    --argjson key "$SSH_KEY_ID" --arg ud "$user_data" \
                    '{name:$name, region:$region, size:$size, image:$image,
                      ssh_keys:[$key], user_data:$ud, ipv6:false,
                      monitoring:false, backups:false}')")
            SERVER_ID=$(echo "$resp" | jq -r '.droplet.id // empty')
            [ -n "$SERVER_ID" ] || { err "DO droplet create failed: $resp"; exit 1; }
            for i in $(seq 1 60); do
                local s
                s=$(curl -sS -H "Authorization: Bearer ${DIGITALOCEAN_TOKEN}" \
                    "$DO_API/droplets/$SERVER_ID")
                SERVER_IP=$(echo "$s" | jq -r '.droplet.networks.v4[]? | select(.type=="public") | .ip_address' | head -n1)
                local status
                status=$(echo "$s" | jq -r '.droplet.status // empty')
                if [ "$status" = "active" ] && [ -n "$SERVER_IP" ]; then return 0; fi
                sleep 5
            done
            err "Droplet $SERVER_ID never became active"; exit 1
            ;;
        hetzner)
            local resp
            resp=$(curl -sS -X POST \
                -H "Authorization: Bearer ${HCLOUD_TOKEN}" \
                -H "Content-Type: application/json" \
                "$HCLOUD_API/servers" \
                -d "$(jq -nc \
                    --arg name "$name" --arg type "$HCLOUD_SERVER_TYPE" \
                    --arg image "$HCLOUD_IMAGE" --arg location "$HCLOUD_LOCATION" \
                    --argjson key "$SSH_KEY_ID" --arg ud "$user_data" \
                    '{name:$name, server_type:$type, image:$image, location:$location,
                      ssh_keys:[$key], user_data:$ud, start_after_create:true,
                      public_net:{enable_ipv4:true, enable_ipv6:false}}')")
            SERVER_ID=$(echo "$resp" | jq -r '.server.id // empty')
            SERVER_IP=$(echo "$resp" | jq -r '.server.public_net.ipv4.ip // empty')
            [ -n "$SERVER_ID" ] && [ -n "$SERVER_IP" ] \
                || { err "Hetzner server create failed: $resp"; exit 1; }
            ;;
    esac
}

destroy_server() {
    [ -n "$SERVER_ID" ] || return 0
    case "$TEST_VM_PROVIDER" in
        digitalocean)
            curl -sS -X DELETE \
                -H "Authorization: Bearer ${DIGITALOCEAN_TOKEN}" \
                "$DO_API/droplets/$SERVER_ID" >/dev/null \
                && ok "Destroyed DO droplet $SERVER_ID" \
                || warn "Could not destroy droplet $SERVER_ID — check at cloud.digitalocean.com"
            ;;
        hetzner)
            curl -sS -X DELETE \
                -H "Authorization: Bearer ${HCLOUD_TOKEN}" \
                "$HCLOUD_API/servers/$SERVER_ID" >/dev/null \
                && ok "Destroyed Hetzner server $SERVER_ID" \
                || warn "Could not destroy server $SERVER_ID — check at hetzner.cloud"
            ;;
    esac
}

destroy_ssh_key() {
    [ -n "$SSH_KEY_ID" ] || return 0
    case "$TEST_VM_PROVIDER" in
        digitalocean)
            curl -sS -X DELETE \
                -H "Authorization: Bearer ${DIGITALOCEAN_TOKEN}" \
                "$DO_API/account/keys/$SSH_KEY_ID" >/dev/null || true
            ;;
        hetzner)
            curl -sS -X DELETE \
                -H "Authorization: Bearer ${HCLOUD_TOKEN}" \
                "$HCLOUD_API/ssh_keys/$SSH_KEY_ID" >/dev/null || true
            ;;
    esac
}

cleanup() {
    local exit_code=$?
    set +e
    if [ "${TEST_KEEP_RUNNING:-0}" = "1" ]; then
        warn "TEST_KEEP_RUNNING=1, skipping teardown."
        warn "  Server:   ${SERVER_ID:-?} (${SERVER_IP:-?})"
        warn "  SSH key:  $LOCAL_SSH_KEY"
        warn "  Tunnel:   ${SERVER_TUNNEL_URL:-?}"
        warn "  Connect:  ssh -i $LOCAL_SSH_KEY root@${SERVER_IP}"
        exit "$exit_code"
    fi
    log "Teardown..."
    destroy_server
    destroy_ssh_key
    if [ -n "$LOCAL_SSH_KEY" ] && [ -f "$LOCAL_SSH_KEY" ]; then
        rm -f "$LOCAL_SSH_KEY" "${LOCAL_SSH_KEY}.pub"
    fi
    exit "$exit_code"
}
trap cleanup EXIT INT TERM

require_cmd() { command -v "$1" >/dev/null 2>&1 || { err "Missing dependency: $1"; exit 1; }; }
require_env() { [ -n "${!1:-}" ] || { err "Required env $1 is not set"; exit 1; }; }

ssh_vm() {
    ssh -i "$LOCAL_SSH_KEY" \
        -o StrictHostKeyChecking=no \
        -o UserKnownHostsFile=/dev/null \
        -o LogLevel=ERROR \
        -o ConnectTimeout=10 \
        "root@$SERVER_IP" "$@"
}

# ---------- preflight ----------
log "Preflight (provider VM: $TEST_VM_PROVIDER, image: $IMAGE_TAG, matrix: $MATRIX_FILE)"
for c in curl jq ssh rsync openssl node; do require_cmd "$c"; done
require_env KODUS_INSTALLER_PATH
case "$TEST_VM_PROVIDER" in
    digitalocean) require_env DIGITALOCEAN_TOKEN ;;
    hetzner)      require_env HCLOUD_TOKEN ;;
esac

if [ ! -d "$KODUS_INSTALLER_PATH" ]; then
    err "KODUS_INSTALLER_PATH=$KODUS_INSTALLER_PATH does not exist"
    exit 1
fi

case "$LICENSE_MODE" in
    license-paid)
        LICENSE_KEY_TO_INJECT="${SH_LICENSE_KEY_PAID:-}"
        ;;
    license-free)
        LICENSE_KEY_TO_INJECT="${SH_LICENSE_KEY_FREE:-}"
        ;;
    *)
        err "Unknown LICENSE_MODE: $LICENSE_MODE (use license-paid|license-free)"
        exit 1
        ;;
esac

TEST_USER_EMAIL="${TEST_USER_EMAIL:-kodus-qa-$(date +%s)@kodusqa.io}"
TEST_USER_PASSWORD="${TEST_USER_PASSWORD:-$(openssl rand -base64 18 | tr -d '=+/' | head -c 24)Aa1!}"
RUN_ID="$(date +%Y%m%d-%H%M%S)-$RANDOM"

# ---------- ssh key ----------
log "Generating temporary SSH key..."
LOCAL_SSH_KEY="$(mktemp -t kodus-e2e-key-XXXXXX)"
rm -f "$LOCAL_SSH_KEY"
ssh-keygen -t ed25519 -N "" -C "kodus-e2e-$RUN_ID" -f "$LOCAL_SSH_KEY" >/dev/null
PUBKEY="$(cat "${LOCAL_SSH_KEY}.pub")"

log "Uploading SSH key to $TEST_VM_PROVIDER..."
provision_ssh_key "kodus-e2e-$RUN_ID" "$PUBKEY"

# ---------- provision ----------
log "Creating server..."
USER_DATA=$(cat <<'CLOUDINIT'
#cloud-config
package_update: true
packages:
  - git
  - jq
  - openssl
  - curl
  - rsync
runcmd:
  - curl -fsSL https://get.docker.com | sh
  - systemctl enable --now docker
  - curl -fsSL -o /usr/local/bin/cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
  - chmod +x /usr/local/bin/cloudflared
  - touch /var/lib/cloud/instance/kodus-ready
CLOUDINIT
)

provision_server "kodus-e2e-$RUN_ID" "$USER_DATA"
ok "Server $SERVER_ID at $SERVER_IP"

# ---------- wait for SSH + cloud-init ----------
log "Waiting for SSH..."
for i in $(seq 1 60); do
    if ssh_vm "true" >/dev/null 2>&1; then ok "SSH up"; break; fi
    sleep 5
    if [ "$i" = 60 ]; then err "SSH never came up"; exit 1; fi
done

log "Waiting for cloud-init to finish..."
ssh_vm "cloud-init status --wait" >/dev/null
ssh_vm "test -f /var/lib/cloud/instance/kodus-ready" || { err "cloud-init failed"; exit 1; }

# ---------- transfer kodus-installer ----------
log "Transferring kodus-installer from $KODUS_INSTALLER_PATH to VM..."
ssh_vm "mkdir -p /opt/kodus-installer"
rsync -az --delete \
    -e "ssh -i $LOCAL_SSH_KEY -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR" \
    --exclude='.git/' --exclude='node_modules/' --exclude='.env' \
    --exclude='tests/e2e/.env' --exclude='.env.e2e-backup.*' \
    "$KODUS_INSTALLER_PATH/" "root@$SERVER_IP:/opt/kodus-installer/"
ssh_vm "chmod +x /opt/kodus-installer/scripts/*.sh"
ok "Installer transferred"

# ---------- start cloudflared tunnel ----------
log "Starting cloudflared quick tunnel for :3332..."
ssh_vm "cat >/etc/systemd/system/kodus-tunnel.service <<'UNIT'
[Unit]
Description=cloudflared quick tunnel for Kodus webhooks
After=network-online.target
[Service]
ExecStart=/usr/local/bin/cloudflared tunnel --url http://localhost:3332 --no-autoupdate --logfile /var/log/cloudflared.log
Restart=on-failure
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now kodus-tunnel.service"

log "Waiting for tunnel URL..."
for i in $(seq 1 30); do
    URL=$(ssh_vm "grep -oE 'https://[a-zA-Z0-9-]+\\.trycloudflare\\.com' /var/log/cloudflared.log 2>/dev/null | head -n1" || true)
    if [ -n "$URL" ]; then SERVER_TUNNEL_URL="$URL"; break; fi
    sleep 3
done
[ -n "$SERVER_TUNNEL_URL" ] || { err "tunnel URL never appeared"; exit 1; }
ok "Tunnel: $SERVER_TUNNEL_URL"

# ---------- write .env on VM ----------
log "Writing .env on VM..."
ssh_vm "cd /opt/kodus-installer && cp .env.example .env && ./scripts/generate-secrets.sh" >/dev/null

ssh_vm bash -s <<REMOTE
set -e
cd /opt/kodus-installer
env_set() {
    local k=\$1 v=\$2
    if grep -qE "^\${k}=" .env; then
        sed -i "s|^\${k}=.*|\${k}=\${v}|" .env
    else
        echo "\${k}=\${v}" >> .env
    fi
}
env_set IMAGE_TAG "$IMAGE_TAG"
# Point the web's server-side API calls (next-auth authorize → /auth/login,
# used by rbac-frontend-routes / rbac-ui-render) at the compose SERVICE name
# `api`, which Docker DNS always resolves on the shared network regardless of
# container_name. The old literal `kodus-api` matched neither the service
# (`api`) nor the actual container (`kodus_api` once GLOBAL_API_CONTAINER_NAME
# is set), so authorize() got ENOTFOUND → returned null → the next-auth login
# 302'd with no session → both RBAC web scenarios failed on self-hosted only
# (cloud passes: it reaches the API over the public URL, not a docker host).
env_set WEB_HOSTNAME_API "api"
env_set WEB_PORT_API "3001"
env_set NEXTAUTH_URL "http://$SERVER_IP:3000"
# Webhook URL env var names are INCONSISTENT across providers in the app:
# github/gitlab read API_*_CODE_MANAGEMENT_WEBHOOK, but bitbucket and azure
# read GLOBAL_*_CODE_MANAGEMENT_WEBHOOK (see github.service getGithubWebhookUrl
# / gitlab.service vs bitbucket-cloud.service:3114 / azureRepos.service:3911,
# and .env.schema). Setting the API_ name for all four left bitbucket+azure
# with an empty webhook URL → 0 hooks registered → the review pipeline never
# fires → "0 findings" timeouts. Set each provider's ACTUAL name.
env_set API_GITHUB_CODE_MANAGEMENT_WEBHOOK "$SERVER_TUNNEL_URL/github/webhook"
env_set API_GITLAB_CODE_MANAGEMENT_WEBHOOK "$SERVER_TUNNEL_URL/gitlab/webhook"
env_set GLOBAL_BITBUCKET_CODE_MANAGEMENT_WEBHOOK "$SERVER_TUNNEL_URL/bitbucket/webhook"
env_set GLOBAL_AZURE_REPOS_CODE_MANAGEMENT_WEBHOOK "$SERVER_TUNNEL_URL/azure-repos/webhook"
# Bitbucket Cloud rate-limits per-endpoint at ~16-60 req/min. The prod
# default (400ms ≈ 150/min) and even 800ms (≈75/min) sit ABOVE that ceiling,
# so under the e2e load — 6 scenarios each re-onboarding (~72 calls to
# generate kody rules) + the runner's own calls, all on ONE shared test
# account — the worker's Bitbucket calls (getDefaultBranch, getLanguage-
# Repository, …) start returning 429 "Rate limit exceeded", which surfaces
# as NO_REPOSITORIES / 400 on the next scenario. Confirmed in worker logs
# 2026-05-30. 2500ms ≈ 24/min keeps every call inside the ceiling — slower
# but deterministic. ONLY the test droplet runs this hot; prod keeps the
# 400ms default (real installs don't re-onboard one account in a loop).
env_set BITBUCKET_RATE_GATE_MIN_INTERVAL_MS "2500"
env_set API_PG_DB_PASSWORD "\$(openssl rand -hex 16)"
env_set API_MG_DB_PASSWORD "\$(openssl rand -hex 16)"
env_set API_DATABASE_DISABLE_SSL "true"
env_set API_PG_DB_SSL "false"
env_set WORKER_ROLE "code-review"
# Analytics worker (Cockpit). When ANALYTICS_WORKER=1 is passed to vm.sh,
# enable the \`analytics\` compose profile so the installer's worker-analytics
# service (role=analytics) comes up alongside the code-review worker, and point
# the ingestion cron at a fast schedule so the cockpit-analytics scenario can
# observe an automatic ingestion run within its poll window. The \`:+\` guard is
# expanded LOCALLY (unquoted REMOTE heredoc), so COMPOSE_PROFILES is empty when
# the flag is off → community topology unchanged. We deliberately do NOT set
# ANALYTICS_PG_DB_HOST (leave it unset → loader cascades to API_PG_DB_*; an
# empty value would be a footgun pre-loader-fix). Classifier disabled: the test
# droplet has no LLM key for PR-type classification.
env_set COMPOSE_PROFILES "${ANALYTICS_WORKER:+analytics}"
env_set ANALYTICS_PG_DB_SCHEMA "analytics"
env_set ANALYTICS_INGESTION_CRON "${ANALYTICS_INGESTION_CRON:-*/2 * * * *}"
env_set ANALYTICS_CLASSIFIER_DISABLED "true"
# The notifications module hard-requires this (ConfigService.getOrThrow).
# Set a dummy so the app boots — emails won't actually send.
env_set RESEND_API_KEY "${RESEND_API_KEY:-disabled-for-dev}"
# LLM provider config — required for Kodus to actually review PRs in the
# matrix. Caller must provide these via env (no hardcoded fallback).
if [ -n "${API_OPEN_AI_API_KEY:-}" ]; then
    env_set API_OPEN_AI_API_KEY "${API_OPEN_AI_API_KEY:-}"
fi
if [ -n "${API_OPENAI_FORCE_BASE_URL:-}" ]; then
    env_set API_OPENAI_FORCE_BASE_URL "${API_OPENAI_FORCE_BASE_URL:-}"
fi
if [ -n "${API_LLM_PROVIDER_MODEL:-}" ]; then
    env_set API_LLM_PROVIDER_MODEL "${API_LLM_PROVIDER_MODEL:-}"
fi
REMOTE

if [ -n "$LICENSE_KEY_TO_INJECT" ]; then
    log "Injecting license key (mode=$LICENSE_MODE)..."
    ssh_vm "cd /opt/kodus-installer && grep -qE '^API_KODUS_LICENSE_KEY=' .env \
            && sed -i 's|^API_KODUS_LICENSE_KEY=.*|API_KODUS_LICENSE_KEY=$LICENSE_KEY_TO_INJECT|' .env \
            || echo 'API_KODUS_LICENSE_KEY=$LICENSE_KEY_TO_INJECT' >> .env"
fi

# ---------- boot ----------
log "Booting stack..."
ssh_vm "cd /opt/kodus-installer && ./scripts/install.sh"

log "Waiting for services to respond..."
HEALTH_FAILED=()
for label_port in "web:3000" "api:3001" "webhooks:3332"; do
    label="${label_port%:*}"; port="${label_port#*:}"
    SUCCESS=0
    for i in $(seq 1 100); do
        code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "http://$SERVER_IP:$port" || echo 000)
        if [[ "$code" =~ ^[234][0-9][0-9]$ ]]; then SUCCESS=1; break; fi
        sleep 3
    done
    [ "$SUCCESS" = "1" ] && ok "$label up" || { warn "$label not responding"; HEALTH_FAILED+=("$label_port"); }
done

if [ ${#HEALTH_FAILED[@]} -gt 0 ]; then
    err "Health check failed for: ${HEALTH_FAILED[*]}"
    ssh_vm "cd /opt/kodus-installer && docker compose logs api kodus-web worker webhooks --tail 80 --no-color" || true
    exit 1
fi

# ---------- signup ----------
log "Creating test user via /auth/signUp..."
SIGNUP_PAYLOAD=$(jq -nc \
    --arg name "Kodus E2E" \
    --arg email "$TEST_USER_EMAIL" \
    --arg pass "$TEST_USER_PASSWORD" \
    '{name:$name, email:$email, password:$pass}')
SIGNUP_CODE=$(curl -sS -X POST -H "Content-Type: application/json" --max-time 30 \
    -d "$SIGNUP_PAYLOAD" \
    -o /tmp/kodus-signup.json -w "%{http_code}" \
    "http://$SERVER_IP:3001/auth/signUp" 2>&1 || echo "ERR")
if [[ ! "$SIGNUP_CODE" =~ ^2[0-9][0-9]$ ]]; then
    SIGNUP_CODE=$(curl -sS -X POST -H "Content-Type: application/json" --max-time 30 \
        -d "$SIGNUP_PAYLOAD" \
        -o /tmp/kodus-signup.json -w "%{http_code}" \
        "http://$SERVER_IP:3001/auth/signup" 2>&1 || echo "ERR")
fi
[[ "$SIGNUP_CODE" =~ ^2[0-9][0-9]$ ]] || { err "Signup failed: HTTP $SIGNUP_CODE  body=$(cat /tmp/kodus-signup.json 2>/dev/null | head -c 400)"; exit 1; }
ok "Signed up $TEST_USER_EMAIL"

# ---------- exec matrix runner ----------
log "Running matrix $MATRIX_FILE against this target..."
cd "$E2E_ROOT"
if [ ! -d node_modules ]; then
    log "Installing e2e deps (first run only)..."
    npm install --silent || npm install
fi

export TARGET_BASE_URL="http://$SERVER_IP:3001"
export TARGET_WEB_URL="http://$SERVER_IP:3000"
export TARGET_TUNNEL_URL="$SERVER_TUNNEL_URL"
export SH_TENANT_EMAIL="$TEST_USER_EMAIL"
export SH_TENANT_PASSWORD="$TEST_USER_PASSWORD"
export TEST_USER_EMAIL TEST_USER_PASSWORD
export TEST_TIMEOUT_REVIEW

# --skip-missing-tokens: drop (not fail) scenarios whose prerequisites are
# absent. In CI the per-seat-license-toggle scenario needs a seats=1 license
# JWT at ~/.kodus-dev/license-seats1.jwt that only exists on a dev laptop —
# without the flag it crashes with ENOENT and reds the whole cell. The
# matrix YAML already documents this scenario as "skipped automatically when
# SH_LICENSE_KEY_PATH isn't available"; the flag is what makes that true.
ok "Run matrix runner: ./node_modules/.bin/tsx cli/run-matrix.ts $MATRIX_FILE --target self-hosted --skip-missing-tokens"
# NOT `exec`: exec would replace this shell and bypass the EXIT trap, so a
# scenario failure would (a) leave the droplet alive forever — no teardown —
# and (b) discard the on-VM logs. Run normally, capture the stack logs into
# the evidence tree (uploaded as the cell artifact), then exit so `cleanup`
# tears the droplet down.
set +e
./node_modules/.bin/tsx cli/run-matrix.ts "$MATRIX_FILE" --target self-hosted --skip-missing-tokens
RUN_EXIT=$?
set -e

# Dump the API + review-worker logs from the droplet into evidence/. The SSH
# key is ephemeral (discarded with the runner), so this is the only chance to
# see WHY a scenario failed on the server side — e.g. whether the kody-rules
# agent actually received the rule. Best-effort: never fail the run on this.
PROV="${TARGET_FILTER_PROVIDER:-unknown}"
mkdir -p "$E2E_ROOT/evidence"
ssh_vm "cd /opt/kodus-installer && docker compose logs api kodus-web worker webhooks --tail 2000 --no-color" \
    > "$E2E_ROOT/evidence/droplet-logs-${PROV}.txt" 2>&1 \
    && ok "Captured droplet logs → evidence/droplet-logs-${PROV}.txt" \
    || warn "Could not capture droplet logs"

exit "$RUN_EXIT"
