#!/usr/bin/env bash
# Provision a persistent self-hosted Kodus stack on a fresh cloud VM, for
# manual testing / bug repro / demos. Stays alive until you run destroy.sh.
#
# Usage:
#   pnpm run selfhosted:provision                     # default instance
#   pnpm run selfhosted:provision --name wellington   # named instance (multi-tenant)
#
# Required env (or scripts/selfhosted/.env):
#   DIGITALOCEAN_TOKEN     DO API token        (default provider)
#   KODUS_INSTALLER_PATH   path to kodus-installer checkout
#                           default: ../kodus-installer
#
# Optional env:
#   TEST_VM_PROVIDER       digitalocean (default) | hetzner
#   HCLOUD_TOKEN           Hetzner token (if TEST_VM_PROVIDER=hetzner)
#   SH_LICENSE_KEY         License key to inject (paid features); if absent
#                           the stack runs without API_KODUS_LICENSE_KEY set,
#                           which is the installer's default trial behavior.
#   IMAGE_TAG              kodus-ai images to use; default: latest
#   GH_DEV_TOKEN           If set, configure GitHub integration after signup
#                           so the dashboard is "ready to use".
#   DO_REGION              default: nyc3
#   DO_SIZE                default: s-2vcpu-4gb
#   DO_IMAGE               default: ubuntu-24-04-x64

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# _common.sh loads ~/.kodus-dev/config + scripts/selfhosted/.env in the
# right priority order. Don't duplicate that here.
# shellcheck disable=SC1091
. "$SCRIPT_DIR/_common.sh"

# ---------- arg parsing ----------
NAME_RAW="default"
REUSE=0
while [ $# -gt 0 ]; do
    case "$1" in
        --name) NAME_RAW="$2"; shift 2 ;;
        --name=*) NAME_RAW="${1#--name=}"; shift ;;
        --reuse) REUSE=1; shift ;;
        -h|--help)
            grep -E '^#( |$)' "$0" | sed 's/^# \?//'
            exit 0
            ;;
        *) err "Unknown arg: $1"; exit 2 ;;
    esac
done
NAME=$(normalize_name "$NAME_RAW")
STATE_FILE=$(state_file_for "$NAME")
LOCAL_SSH_KEY=$(ssh_key_path_for "$NAME")

if state_exists "$NAME"; then
    EXISTING_IP=$(state_get "$NAME" .server_ip)
    if [ "$REUSE" = "1" ]; then
        ok "Instance '$NAME' already exists (IP $EXISTING_IP) — reusing."
        exit 0
    fi
    warn "Instance '$NAME' already exists (IP $EXISTING_IP)."
    warn "Run 'pnpm run selfhosted:status' to inspect, 'pnpm run selfhosted:destroy --name $NAME' to destroy, or pass --reuse to skip when present."
    exit 1
fi

# First-time UX: if the global config doesn't exist yet, run setup
# interactively before doing anything else. This way the dev only thinks
# about secrets ONCE — every subsequent command (destroy, deploy, ssh,
# logs, status) reads from ~/.kodus-dev/config without needing env vars.
#
# Any env vars already exported in the caller's shell are used as defaults
# in the prompts — they just press Enter to save them. No retyping.
if [ ! -f "$GLOBAL_CONFIG" ]; then
    log "First-time setup: no config at $GLOBAL_CONFIG yet."
    log "Running 'pnpm run selfhosted:setup' so you only type secrets once."
    echo ""
    "$SCRIPT_DIR/setup.sh"
    echo ""
    # Load the freshly-written config directly. We don't re-source
    # _common.sh here because its caller-env-wins logic would clobber any
    # values the user just changed during setup (the pre-setup env vars
    # would override the new config). A direct file source is what we want.
    if [ -f "$GLOBAL_CONFIG" ]; then
        # shellcheck disable=SC1090
        set -a; . "$GLOBAL_CONFIG"; set +a
    fi
fi

TEST_VM_PROVIDER="${TEST_VM_PROVIDER:-digitalocean}"
IMAGE_TAG="${IMAGE_TAG:-latest}"
KODUS_INSTALLER_PATH="${KODUS_INSTALLER_PATH:-$REPO_ROOT/../kodus-installer}"

# State for in-script use (and for cleanup on failure)
SERVER_ID=""
SSH_KEY_ID=""
SERVER_IP=""
SERVER_TUNNEL_URL=""
SSH_VERIFIED=0  # flips to 1 once we SSH'd into the box at least once
DEV_USER_EMAIL=""
DEV_USER_PASSWORD=""

# Writes a state file that's enough for destroy.sh / status.sh / ssh.sh to work
# even if provision.sh later fails. Called twice: a partial one right after SSH is
# verified (so failed runs are still recoverable), and a full one at the end.
save_state() {
    local stage="${1:-partial}"
    jq -n \
        --arg stage "$stage" \
        --arg name "$NAME" \
        --arg provider "$TEST_VM_PROVIDER" \
        --arg server_id "$SERVER_ID" \
        --arg server_ip "$SERVER_IP" \
        --arg ssh_key_id "$SSH_KEY_ID" \
        --arg ssh_key_path "$LOCAL_SSH_KEY" \
        --arg tunnel_url "${SERVER_TUNNEL_URL:-}" \
        --arg dashboard_url "http://$SERVER_IP:3000" \
        --arg api_url "http://$SERVER_IP:3001" \
        --arg image_tag "$IMAGE_TAG" \
        --arg user_email "${DEV_USER_EMAIL:-}" \
        --arg user_password "${DEV_USER_PASSWORD:-}" \
        --argjson gh_configured "${GH_CONFIGURED:-false}" \
        --arg created_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        '{
            stage: $stage,
            name: $name,
            provider: $provider,
            server_id: $server_id,
            server_ip: $server_ip,
            ssh_key_id: $ssh_key_id,
            ssh_key_path: $ssh_key_path,
            tunnel_url: $tunnel_url,
            dashboard_url: $dashboard_url,
            api_url: $api_url,
            image_tag: $image_tag,
            tenant: { email: $user_email, password: $user_password },
            gh_integration_configured: $gh_configured,
            created_at: $created_at
        }' > "$STATE_FILE"
    chmod 600 "$STATE_FILE"
}

DO_API="https://api.digitalocean.com/v2"
DO_REGION="${DO_REGION:-nyc3}"
DO_SIZE="${DO_SIZE:-s-2vcpu-4gb}"
DO_IMAGE="${DO_IMAGE:-ubuntu-24-04-x64}"

HCLOUD_API="https://api.hetzner.cloud/v1"
HCLOUD_LOCATION="${HCLOUD_LOCATION:-nbg1}"
HCLOUD_SERVER_TYPE="${HCLOUD_SERVER_TYPE:-cx22}"
HCLOUD_IMAGE="${HCLOUD_IMAGE:-ubuntu-24.04}"

# ---------- provider abstractions ----------
provision_ssh_key() {
    local label=$1 pubkey=$2
    case "$TEST_VM_PROVIDER" in
        digitalocean)
            local resp
            resp=$(curl -sS -X POST \
                -H "Authorization: Bearer ${DIGITALOCEAN_TOKEN}" \
                -H "Content-Type: application/json" \
                "$DO_API/account/keys" \
                -d "$(jq -nc --arg n "$label" --arg k "$pubkey" '{name:$n, public_key:$k}')")
            SSH_KEY_ID=$(echo "$resp" | jq -r '.ssh_key.id // empty')
            [ -n "$SSH_KEY_ID" ] || { err "DO key upload failed: $resp"; exit 1; }
            ;;
        hetzner)
            local resp
            resp=$(curl -sS -X POST \
                -H "Authorization: Bearer ${HCLOUD_TOKEN}" \
                -H "Content-Type: application/json" \
                "$HCLOUD_API/ssh_keys" \
                -d "$(jq -nc --arg n "$label" --arg k "$pubkey" '{name:$n, public_key:$k}')")
            SSH_KEY_ID=$(echo "$resp" | jq -r '.ssh_key.id // empty')
            [ -n "$SSH_KEY_ID" ] || { err "Hetzner key upload failed: $resp"; exit 1; }
            ;;
    esac
}

provision_server() {
    local label=$1 user_data=$2

    # Guard against non-ASCII bytes in cloud-init user_data. Today
    # (2026-05-23) a single em-dash in a comment caused cloud-init to
    # silently reject the entire user_data, dropping write_files and
    # runcmd; the droplet booted bare and provision.sh exited with the
    # uninformative "kodus-ready missing". Fail fast here with a
    # specific error instead of paying $0.02 for a useless droplet
    # plus 2 minutes of cloud-init wait.
    if LC_ALL=C grep -q '[^[:print:][:space:]]' <<<"$user_data"; then
        local bad_line
        bad_line=$(LC_ALL=C grep -n '[^[:print:][:space:]]' <<<"$user_data" | head -1)
        err "cloud-init user_data contains non-ASCII byte (line: $bad_line)"
        err "  cloud-init rejects the whole user_data when this happens (silently)."
        err "  Replace smart quotes / em-dashes / accented chars with ASCII."
        exit 1
    fi

    case "$TEST_VM_PROVIDER" in
        digitalocean)
            local resp
            resp=$(curl -sS -X POST \
                -H "Authorization: Bearer ${DIGITALOCEAN_TOKEN}" \
                -H "Content-Type: application/json" \
                "$DO_API/droplets" \
                -d "$(jq -nc \
                    --arg name "$label" --arg region "$DO_REGION" \
                    --arg size "$DO_SIZE" --arg image "$DO_IMAGE" \
                    --argjson key "$SSH_KEY_ID" --arg ud "$user_data" \
                    '{name:$name, region:$region, size:$size, image:$image,
                      ssh_keys:[$key], user_data:$ud, ipv6:false,
                      monitoring:false, backups:false}')")
            SERVER_ID=$(echo "$resp" | jq -r '.droplet.id // empty')
            [ -n "$SERVER_ID" ] || { err "DO droplet create failed: $resp"; exit 1; }
            log "Droplet $SERVER_ID created, waiting for active status + public IP..."
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
                    --arg name "$label" --arg type "$HCLOUD_SERVER_TYPE" \
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

# Failure handler.
#
# Rule: once SSH is up, NEVER auto-destroy the droplet. The user almost
# certainly wants to ssh in and inspect what went wrong. We save a state
# file at that point so destroy.sh / ssh.sh / logs.sh can find the box.
#
# We only do best-effort destroy when the failure happened BEFORE SSH was
# established (e.g. wrong region, bad token, droplet stuck pending) — in
# that case there's nothing useful left to debug and we don't want to leak
# resources on the user's bill.
rollback_on_failure() {
    local exit_code=$?
    if [ "$exit_code" -eq 0 ]; then return; fi

    if [ "$SSH_VERIFIED" = "1" ] && [ -n "$SERVER_ID" ] && [ -n "$SERVER_IP" ]; then
        # SSH worked at some point. Keep the droplet alive for debugging.
        save_state "failed" 2>/dev/null || true
        warn ""
        warn "Provision FAILED, but the droplet is alive so you can debug it."
        warn ""
        warn "  Server:  $SERVER_ID @ $SERVER_IP"
        warn "  SSH:     ssh -i $LOCAL_SSH_KEY root@$SERVER_IP"
        warn "  Logs:    pnpm run selfhosted:logs${NAME:+ --name $NAME}"
        warn "  Status:  pnpm run selfhosted:status${NAME:+ --name $NAME}"
        warn "  Destroy: pnpm run selfhosted:destroy${NAME:+ --name $NAME}"
        warn ""
        warn "  Remember: this droplet costs ~\$1/day. Destroy it when you're done."
        exit "$exit_code"
    fi

    if [ -f "$STATE_FILE" ]; then
        warn "Provision failed AFTER state file was written. Run 'pnpm run selfhosted:destroy --name $NAME' to clean up."
        exit "$exit_code"
    fi

    warn "Provision failed before SSH came up; cleaning up early resources..."
    if [ -n "$SERVER_ID" ]; then
        case "$TEST_VM_PROVIDER" in
            digitalocean)
                curl -sS -X DELETE \
                    -H "Authorization: Bearer ${DIGITALOCEAN_TOKEN}" \
                    "$DO_API/droplets/$SERVER_ID" >/dev/null 2>&1 \
                    && ok "Destroyed orphan DO droplet $SERVER_ID" \
                    || warn "Could not destroy droplet $SERVER_ID — check at cloud.digitalocean.com"
                ;;
            hetzner)
                curl -sS -X DELETE \
                    -H "Authorization: Bearer ${HCLOUD_TOKEN}" \
                    "$HCLOUD_API/servers/$SERVER_ID" >/dev/null 2>&1 \
                    && ok "Destroyed orphan Hetzner server $SERVER_ID" \
                    || warn "Could not destroy server $SERVER_ID"
                ;;
        esac
    fi
    if [ -n "$SSH_KEY_ID" ]; then
        case "$TEST_VM_PROVIDER" in
            digitalocean)
                curl -sS -X DELETE \
                    -H "Authorization: Bearer ${DIGITALOCEAN_TOKEN}" \
                    "$DO_API/account/keys/$SSH_KEY_ID" >/dev/null 2>&1 || true
                ;;
            hetzner)
                curl -sS -X DELETE \
                    -H "Authorization: Bearer ${HCLOUD_TOKEN}" \
                    "$HCLOUD_API/ssh_keys/$SSH_KEY_ID" >/dev/null 2>&1 || true
                ;;
        esac
    fi
    [ -f "$LOCAL_SSH_KEY" ] && rm -f "$LOCAL_SSH_KEY" "${LOCAL_SSH_KEY}.pub"
    exit "$exit_code"
}
trap rollback_on_failure EXIT

ssh_vm() {
    ssh -i "$LOCAL_SSH_KEY" \
        -o StrictHostKeyChecking=no \
        -o UserKnownHostsFile=/dev/null \
        -o LogLevel=ERROR \
        -o ConnectTimeout=10 \
        "root@$SERVER_IP" "$@"
}

# ---------- preflight ----------
log "Preflight (provider VM: $TEST_VM_PROVIDER, image: $IMAGE_TAG, name: $NAME)"
for c in curl jq ssh ssh-keygen rsync openssl; do require_cmd "$c"; done
case "$TEST_VM_PROVIDER" in
    digitalocean) require_env DIGITALOCEAN_TOKEN ;;
    hetzner)      require_env HCLOUD_TOKEN ;;
    *) err "Unknown TEST_VM_PROVIDER=$TEST_VM_PROVIDER"; exit 1 ;;
esac

# The benchmark farm (BENCH_BASE_ONLY=1) builds the stack from kodus-ai source
# on the droplet and never touches kodus-installer, so don't require it there.
if [ "${BENCH_BASE_ONLY:-0}" != "1" ] && [ ! -d "$KODUS_INSTALLER_PATH" ]; then
    err "KODUS_INSTALLER_PATH=$KODUS_INSTALLER_PATH does not exist."
    err "Either clone https://github.com/kodustech/kodus-installer next to this repo,"
    err "or set KODUS_INSTALLER_PATH to your local checkout."
    exit 1
fi

DEV_USER_EMAIL="dev-${NAME}-$(date +%s)@kodus.local"
DEV_USER_PASSWORD="$(openssl rand -base64 18 | tr -d '=+/' | head -c 24)Aa1!"
START_EPOCH=$(date +%s)

# ---------- ssh key ----------
log "Generating SSH key at $LOCAL_SSH_KEY..."
rm -f "$LOCAL_SSH_KEY" "${LOCAL_SSH_KEY}.pub"
ssh-keygen -t ed25519 -N "" -C "kodus-selfhosted-$NAME" -f "$LOCAL_SSH_KEY" >/dev/null
PUBKEY="$(cat "${LOCAL_SSH_KEY}.pub")"

log "Uploading SSH key to $TEST_VM_PROVIDER..."
provision_ssh_key "kodus-selfhosted-$NAME" "$PUBKEY"

# ---------- provision ----------
log "Creating server kodus-selfhosted-$NAME..."
USER_DATA=$(cat <<'CLOUDINIT'
#cloud-config
package_update: true
packages:
  - git
  - jq
  - openssl
  - curl
  - rsync
write_files:
  # Pull Docker Hub images via Google's public mirror instead of going
  # directly to registry-1.docker.io. Some DigitalOcean droplets land
  # on egress paths where IPv4 traffic to AWS us-east-1 (Docker Hub's
  # CDN) silently blackholes at hop 5 of the DO backbone -- observed
  # 2026-05-23 on 159.203.110.117 where every pull of pgvector/mongo
  # timed out, while ghcr.io (Azure) and mirror.gcr.io (Google) both
  # responded in ~150ms from the same host. The Docker daemon falls
  # back to docker.io if the mirror does not have the image, so this
  # is also self-healing if mirror.gcr.io ever drops an image. All
  # characters in this comment MUST stay ASCII -- cloud-init rejects
  # the whole user_data (silently!) if it sees non-ASCII bytes.
  - path: /etc/docker/daemon.json
    content: |
      {
        "registry-mirrors": ["https://mirror.gcr.io"]
      }
    permissions: '0644'
runcmd:
  - curl -fsSL https://get.docker.com | sh
  - systemctl enable --now docker
  - curl -fsSL -o /usr/local/bin/cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
  - chmod +x /usr/local/bin/cloudflared
  - touch /var/lib/cloud/instance/kodus-ready
CLOUDINIT
)

provision_server "kodus-selfhosted-$NAME" "$USER_DATA"
ok "Server $SERVER_ID at $SERVER_IP"

log "Waiting for SSH..."
for i in $(seq 1 60); do
    if ssh_vm "true" >/dev/null 2>&1; then ok "SSH up"; SSH_VERIFIED=1; break; fi
    sleep 5
    [ "$i" = 60 ] && { err "SSH never came up"; exit 1; }
done

# From this point on, any failure leaves the droplet alive (see rollback_on_failure).
save_state "ssh-up"

log "Waiting for cloud-init (~2 min)..."
ssh_vm "cloud-init status --wait" >/dev/null
ssh_vm "test -f /var/lib/cloud/instance/kodus-ready" || { err "cloud-init failed"; exit 1; }

# ---------- base-only mode (benchmark farm) ----------
# BENCH_BASE_ONLY=1 stops here: a bare droplet with Docker + git + rsync +
# cloudflared (installed by cloud-init above) and nothing else. The benchmark
# farm (scripts/benchmark/farm/) rsyncs the kodus-ai SOURCE for a given branch
# and builds the compiled artifact ON the droplet via docker-compose.bench.yml,
# instead of pulling kodus-installer's prebuilt GHCR images. Everything below
# (installer transfer + install.sh + GHCR) is skipped.
if [ "${BENCH_BASE_ONLY:-0}" = "1" ]; then
    save_state "base-ready"
    ok "Base droplet ready (BENCH_BASE_ONLY) — '${NAME}' at ${SERVER_IP}"
    dim "  Docker + cloudflared installed; no Kodus stack yet."
    dim "  Build a branch onto it: scripts/benchmark/farm/bench-sync.sh ${NAME#bench-} <branch>"
    exit 0
fi

# ---------- transfer installer ----------
log "Transferring kodus-installer from $KODUS_INSTALLER_PATH..."
ssh_vm "mkdir -p /opt/kodus-installer"
rsync -az --delete \
    -e "ssh -i $LOCAL_SSH_KEY -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR" \
    --exclude='.git/' --exclude='node_modules/' --exclude='.env' \
    --exclude='tests/e2e/.env' --exclude='.env.e2e-backup.*' \
    "$KODUS_INSTALLER_PATH/" "root@$SERVER_IP:/opt/kodus-installer/"
ssh_vm "chmod +x /opt/kodus-installer/scripts/*.sh"
ok "Installer transferred"

# ---------- apply cached dev image override (if any) ----------
# If the operator ran `pnpm run selfhosted:deploy --name <something>` at any
# point on this Mac, it cached a docker-compose.override.yml at
# ~/.kodus-dev/last-deploy.override.yml that pins every kodus-* service
# to a specific dev-tag in their personal GHCR namespace. Apply it to
# this droplet too, so a fresh sso-e2e (or any other future droplet
# that delegates here) uses the SAME images as the matrix droplet
# instead of falling back to the org's `:latest` tag -- which today
# may not exist OR may be stale relative to the local build.
# Idempotent no-op when the cache file is missing (e.g. a totally
# fresh dev machine that never ran deploy.sh).
OVERRIDE_CACHE="${HOME}/.kodus-dev/last-deploy.override.yml"
if [ -f "$OVERRIDE_CACHE" ]; then
    log "Applying cached dev-image override from $OVERRIDE_CACHE"
    scp -i "$LOCAL_SSH_KEY" \
        -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR \
        "$OVERRIDE_CACHE" "root@$SERVER_IP:/opt/kodus-installer/docker-compose.override.yml"
    # Droplet has to authenticate to GHCR before docker compose can
    # pull from the personal namespace (images are private by
    # default). Forward the dev machine's gh CLI token; revoke right
    # after install.sh finishes pulling so the token doesn't sit on
    # disk over the lifetime of the droplet.
    if command -v gh >/dev/null 2>&1; then
        GH_USER_FOR_LOGIN=$(gh api user --jq .login 2>/dev/null | tr '[:upper:]' '[:lower:]' || true)
        GH_TOKEN_FOR_DROPLET=$(gh auth token 2>/dev/null || true)
        if [ -n "$GH_USER_FOR_LOGIN" ] && [ -n "$GH_TOKEN_FOR_DROPLET" ]; then
            ssh_vm "echo '$GH_TOKEN_FOR_DROPLET' | docker login ghcr.io -u '$GH_USER_FOR_LOGIN' --password-stdin >/dev/null"
            ok "Droplet logged into ghcr.io as $GH_USER_FOR_LOGIN (for override pull)"
        else
            warn "Could not resolve GH user/token; install.sh may fail to pull private images"
        fi
        unset GH_TOKEN_FOR_DROPLET
    else
        warn "gh CLI not found; install.sh may fail to pull private GHCR images"
    fi
    ok "Override applied"
fi

# ---------- cloudflared tunnel ----------
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

for i in $(seq 1 30); do
    URL=$(ssh_vm "grep -oE 'https://[a-zA-Z0-9-]+\\.trycloudflare\\.com' /var/log/cloudflared.log 2>/dev/null | head -n1" || true)
    [ -n "$URL" ] && { SERVER_TUNNEL_URL="$URL"; break; }
    sleep 3
done
[ -n "$SERVER_TUNNEL_URL" ] || { err "tunnel URL never appeared"; exit 1; }
ok "Tunnel: $SERVER_TUNNEL_URL"

# ---------- .env on VM ----------
log "Writing .env..."
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
env_set WEB_HOSTNAME_API "kodus-api"
env_set WEB_PORT_API "3001"
env_set NEXTAUTH_URL "http://$SERVER_IP:3000"
# Per-provider webhook URLs. Note the mismatched prefixes match what
# the Kodus API code actually reads — github/gitlab use API_*,
# bitbucket/azure use GLOBAL_*. Setting the wrong prefix silently
# breaks webhook auto-registration (the env var resolves to undefined
# and Kodus tries to POST to `?token=...` with no host/path).
env_set API_GITHUB_CODE_MANAGEMENT_WEBHOOK "$SERVER_TUNNEL_URL/github/webhook"
env_set API_GITLAB_CODE_MANAGEMENT_WEBHOOK "$SERVER_TUNNEL_URL/gitlab/webhook"
env_set GLOBAL_BITBUCKET_CODE_MANAGEMENT_WEBHOOK "$SERVER_TUNNEL_URL/bitbucket/webhook"
env_set GLOBAL_AZURE_REPOS_CODE_MANAGEMENT_WEBHOOK "$SERVER_TUNNEL_URL/azure-repos/webhook"
env_set API_PG_DB_PASSWORD "\$(openssl rand -hex 16)"
env_set API_MG_DB_PASSWORD "\$(openssl rand -hex 16)"
env_set API_DATABASE_DISABLE_SSL "true"
env_set API_PG_DB_SSL "false"
env_set WORKER_ROLE "code-review"
# The notifications module hard-requires this even on self-hosted dev (it
# calls ConfigService.getOrThrow). Set a dummy value so the app boots; emails
# obviously won't actually send. Override RESEND_API_KEY before running
# provision.sh if you want real notifications.
env_set RESEND_API_KEY "${RESEND_API_KEY:-disabled-for-dev}"
# LLM provider keys — required for Kodus to actually review PRs.
# Without these, the dashboard shows a "No LLM provider configured" banner.
if [ -n "${API_OPEN_AI_API_KEY:-}" ]; then
    env_set API_OPEN_AI_API_KEY "$API_OPEN_AI_API_KEY"
fi
if [ -n "${API_OPENAI_FORCE_BASE_URL:-}" ]; then
    env_set API_OPENAI_FORCE_BASE_URL "$API_OPENAI_FORCE_BASE_URL"
fi
if [ -n "${API_LLM_PROVIDER_MODEL:-}" ]; then
    env_set API_LLM_PROVIDER_MODEL "$API_LLM_PROVIDER_MODEL"
fi
REMOTE

if [ -n "${SH_LICENSE_KEY:-}" ]; then
    log "Injecting SH_LICENSE_KEY..."
    # KODUS_LICENSE_KEY is the customer-facing var SelfHostedLicenseService
    # reads (NOT API_-prefixed). Injecting the wrong name leaves the install
    # effectively unlicensed → enterprise features 403.
    ssh_vm "cd /opt/kodus-installer && grep -qE '^KODUS_LICENSE_KEY=' .env \
            && sed -i 's|^KODUS_LICENSE_KEY=.*|KODUS_LICENSE_KEY=$SH_LICENSE_KEY|' .env \
            || echo 'KODUS_LICENSE_KEY=$SH_LICENSE_KEY' >> .env"
else
    dim "  No SH_LICENSE_KEY set — stack will boot in installer default mode (no paid features)."
fi

# ---------- boot ----------
log "Booting stack (./scripts/install.sh)..."
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
    ssh_vm "cd /opt/kodus-installer && docker compose logs api worker webhooks --tail 80 --no-color" || true
    exit 1
fi

# ---------- wait for the review pipeline (RabbitMQ workflow queue) ----------
# The HTTP checks above only prove web/api/webhooks ANSWER. The code-review
# pipeline runs through RabbitMQ (@kodus/flow): the webhooks service
# publishes a job to `workflow.jobs.code_review.queue` and the worker
# consumes it. On a cold boot the worker declares + binds that queue only
# after its (slow) NestJS init; until then the producer hits
# "404 NOT_FOUND - no queue ... QueueBind", the AMQP channel is closed, and
# the job is DROPPED — while the webhook still returns 200. Handing the
# droplet to the test in that window means a PR opened in the first ~minute
# gets a 200 ack but NO review, silently. (NB: the separate self-hosted
# "0 findings" chased on 2026-05-26 turned out to be license SEAT enforcement,
# NOT this queue race — but the cold-boot window is a real silent-drop risk
# regardless.) So gate readiness on the queue being declared AND consumed.
log "Waiting for review pipeline queue (RabbitMQ) to be ready..."
QUEUE_READY=0
for i in $(seq 1 60); do
    line=$(ssh_vm "docker exec rabbitmq-prod rabbitmqctl list_queues -t 10 -p kodus-ai name consumers --no-table-headers 2>/dev/null | grep -E '^workflow.jobs.code_review.queue[[:space:]]'" 2>/dev/null || true)
    consumers=$(printf '%s' "$line" | awk '{print $NF}')
    if [ -n "$consumers" ] && [ "$consumers" -ge 1 ] 2>/dev/null; then QUEUE_READY=1; break; fi
    sleep 3
done
if [ "$QUEUE_READY" = "1" ]; then
    # Settle buffer: let the webhooks producer channel reconnect after any
    # startup 404 before the first real PR event arrives.
    sleep 5
    ok "Review pipeline queue ready (consumer attached)"
else
    err "Review queue 'workflow.jobs.code_review.queue' never got a consumer within ~3min — worker likely failed to start. Reviews would be silently dropped, so refusing to mark the stack ready."
    ssh_vm "docker logs kodus-worker-prod --tail 80 --no-color" || true
    exit 1
fi

# ---------- signup ----------
log "Creating dev user $DEV_USER_EMAIL..."
SIGNUP_PAYLOAD=$(jq -nc \
    --arg name "Kodus Dev ($NAME)" \
    --arg email "$DEV_USER_EMAIL" \
    --arg pass "$DEV_USER_PASSWORD" \
    '{name:$name, email:$email, password:$pass}')
SIGNUP_CODE=$(curl -sS -X POST -H "Content-Type: application/json" --max-time 30 \
    -d "$SIGNUP_PAYLOAD" \
    -o /tmp/kodus-signup-$$.json -w "%{http_code}" \
    "http://$SERVER_IP:3001/auth/signUp" 2>&1 || echo "ERR")
if [[ ! "$SIGNUP_CODE" =~ ^2[0-9][0-9]$ ]]; then
    SIGNUP_CODE=$(curl -sS -X POST -H "Content-Type: application/json" --max-time 30 \
        -d "$SIGNUP_PAYLOAD" \
        -o /tmp/kodus-signup-$$.json -w "%{http_code}" \
        "http://$SERVER_IP:3001/auth/signup" 2>&1 || echo "ERR")
fi
[[ "$SIGNUP_CODE" =~ ^2[0-9][0-9]$ ]] || { err "Signup failed: HTTP $SIGNUP_CODE  body=$(cat /tmp/kodus-signup-$$.json 2>/dev/null | head -c 400)"; exit 1; }
rm -f /tmp/kodus-signup-$$.json
ok "Dev user created"

# ---------- smoke tenants (one per provider) ----------
# Smoke tests need one tenant per provider so:
#   * Each tenant only ever has a single integration → Kodus's
#     `getTypeIntegration` (filtered only by category) can't pick the wrong
#     platform.
#   * Webhook routing on Bitbucket — which has no disambiguator and picks
#     the OLDEST tenant with an active code-review automation registered
#     against the repo — has exactly one candidate, so events always land
#     on the smoke tenant.
#
# Created BEFORE any test-time signup so they remain the oldest candidates
# in `findIntegrationConfigWithTeams`. Each smoke logs in to the matching
# tenant rather than spinning up a fresh one.
log "Creating smoke tenants (1 per provider) for E2E isolation..."
SMOKE_TENANT_PASSWORD="${DEV_USER_PASSWORD}"
for provider in github gitlab bitbucket azure-devops; do
    smoke_email="e2e-${provider}@kodus.local"
    smoke_name="Kodus E2E ${provider}"
    payload=$(jq -nc \
        --arg name "$smoke_name" \
        --arg email "$smoke_email" \
        --arg pass "$SMOKE_TENANT_PASSWORD" \
        '{name:$name, email:$email, password:$pass}')
    code=$(curl -sS -X POST -H "Content-Type: application/json" --max-time 30 \
        -d "$payload" \
        -o /tmp/kodus-smoke-signup-$$.json -w "%{http_code}" \
        "http://$SERVER_IP:3001/auth/signUp" 2>&1 || echo "ERR")
    if [[ ! "$code" =~ ^2[0-9][0-9]$ ]]; then
        code=$(curl -sS -X POST -H "Content-Type: application/json" --max-time 30 \
            -d "$payload" \
            -o /tmp/kodus-smoke-signup-$$.json -w "%{http_code}" \
            "http://$SERVER_IP:3001/auth/signup" 2>&1 || echo "ERR")
    fi
    # 409 (conflict) is fine — tenant already exists from a previous provision.
    case "$code" in
        2*) ok "  ${provider}: created" ;;
        409) ok "  ${provider}: already exists" ;;
        *) warn "  ${provider}: signup HTTP $code (body=$(cat /tmp/kodus-smoke-signup-$$.json 2>/dev/null | head -c 200))" ;;
    esac
    rm -f /tmp/kodus-smoke-signup-$$.json
done

# ---------- optional: configure GitHub integration ----------
GH_CONFIGURED="false"
if [ -n "${GH_DEV_TOKEN:-}" ]; then
    log "Configuring GitHub integration with GH_DEV_TOKEN..."
    LOGIN_RESP=$(curl -sS -X POST -H "Content-Type: application/json" --max-time 20 \
        -d "$(jq -nc --arg e "$DEV_USER_EMAIL" --arg p "$DEV_USER_PASSWORD" \
            '{email:$e, password:$p}')" \
        "http://$SERVER_IP:3001/auth/login")
    ACCESS_TOKEN=$(echo "$LOGIN_RESP" | jq -r '.data.accessToken // empty')
    if [ -z "$ACCESS_TOKEN" ]; then
        warn "Could not log in to configure GitHub — skipping. Configure manually."
    else
        JWT_BODY=$(echo "$ACCESS_TOKEN" | awk -F. '{print $2}' | tr '_-' '/+')
        PAD=$(( 4 - ${#JWT_BODY} % 4 )); [ $PAD -lt 4 ] && JWT_BODY="${JWT_BODY}$(printf '=%.0s' $(seq 1 $PAD))"
        ORG_ID=$(printf '%s' "$JWT_BODY" | base64 -d 2>/dev/null | jq -r '.organizationId // empty')
        TEAM_RESP=$(curl -sS -H "Authorization: Bearer $ACCESS_TOKEN" --max-time 15 \
            "http://$SERVER_IP:3001/team/")
        TEAM_ID=$(echo "$TEAM_RESP" | jq -r '.data[0].uuid // empty')
        if [ -n "$ORG_ID" ] && [ -n "$TEAM_ID" ]; then
            AUTH_INT_RESP=$(curl -sS -X POST --max-time 30 \
                -H "Authorization: Bearer $ACCESS_TOKEN" -H "Content-Type: application/json" \
                -d "$(jq -nc --arg token "$GH_DEV_TOKEN" --arg orgId "$ORG_ID" --arg teamId "$TEAM_ID" \
                    '{integrationType:"GITHUB", authMode:"token", token:$token,
                      organizationAndTeamData:{organizationId:$orgId, teamId:$teamId}}')" \
                "http://$SERVER_IP:3001/code-management/auth-integration")
            if [ "$(echo "$AUTH_INT_RESP" | jq -r '.data.status // empty')" = "SUCCESS" ]; then
                ok "GitHub integration configured"
                GH_CONFIGURED="true"
            else
                warn "GitHub integration call returned: $AUTH_INT_RESP"
            fi
        fi
    fi
fi

# ---------- save state ----------
log "Saving state to $STATE_FILE..."
save_state "ready"

# ---------- success: disarm rollback trap ----------
trap - EXIT

ELAPSED=$(( $(date +%s) - START_EPOCH ))
MINS=$(( ELAPSED / 60 ))
SECS=$(( ELAPSED % 60 ))

cat <<EOF

$(echo -e "${GREEN}✅ Self-hosted stack online in ${MINS}m${SECS}s${NC}")

  $(echo -e "${BLUE}Dashboard:${NC}") http://$SERVER_IP:3000
  $(echo -e "${BLUE}API:${NC}")       http://$SERVER_IP:3001
  $(echo -e "${BLUE}Webhooks:${NC}")  $SERVER_TUNNEL_URL
  $(echo -e "${BLUE}Image:${NC}")     ghcr.io/kodustech/kodus-ai-*:${IMAGE_TAG}

  $(echo -e "${BLUE}Login:${NC}")     $DEV_USER_EMAIL
  $(echo -e "${BLUE}Password:${NC}")  $DEV_USER_PASSWORD
  $(echo -e "${BLUE}GH wired:${NC}")  $GH_CONFIGURED

  $(echo -e "${GRAY}SSH:${NC}")       ssh -i $LOCAL_SSH_KEY root@$SERVER_IP
  $(echo -e "${GRAY}Status:${NC}")    pnpm run selfhosted:status${NAME:+ --name $NAME}
  $(echo -e "${GRAY}Logs:${NC}")      pnpm run selfhosted:logs${NAME:+ --name $NAME}
  $(echo -e "${GRAY}Destroy:${NC}")   pnpm run selfhosted:destroy${NAME:+ --name $NAME}

$(echo -e "${YELLOW}⚠️  This is a PUBLISHED image, NOT your local code.${NC}")
$(echo -e "${YELLOW}    To test your current branch instead:${NC}")
$(echo -e "${YELLOW}    →  pnpm run selfhosted:deploy${NAME:+ --name $NAME}${NC}")

$(echo -e "${YELLOW}This VM is ALIVE. Cost: ~\$1/day on DO. Destroy when done.${NC}")

EOF
