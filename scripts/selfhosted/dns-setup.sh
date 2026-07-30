#!/usr/bin/env bash
# Quick Cloudflare tunnel for the web app — no Cloudflare account needed.
# Same pattern as the webhook tunnel that provision.sh sets up, but pointed
# at port 3000 instead of 3332. A second systemd unit runs alongside the
# existing kodus-tunnel.service (webhooks) so the two tunnels are managed
# independently.
#
# Trade-off: zero credentials, but URL is random under *.trycloudflare.com
# and changes whenever cloudflared restarts. For a stable URL on your own
# domain (e.g. kodus.io) use `pnpm run selfhosted:dns-setup-named` instead —
# that one needs a Cloudflare API token (one-time setup).
#
# What it does on the droplet:
#   1. Installs /etc/systemd/system/kodus-web-tunnel.service (→ :3000)
#   2. Starts it, polls /var/log/cloudflared-web.log for the trycloudflare URL
#   3. Updates .env: NEXTAUTH_URL, API_FRONTEND_URL, API_USER_INVITE_BASE_URL
#   4. Restarts kodus-{web,api,webhooks,worker} so they pick up new envs
#
# Usage:
#   pnpm run selfhosted:dns-setup
#   pnpm run selfhosted:dns-setup --name wellington

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
. "$SCRIPT_DIR/_common.sh"

require_cmd jq

NAME_RAW="default"
while [ $# -gt 0 ]; do
    case "$1" in
        --name)   NAME_RAW="$2"; shift 2 ;;
        --name=*) NAME_RAW="${1#--name=}"; shift ;;
        -h|--help)
            awk 'NR>1 && /^$/ {exit} NR>1 {sub(/^# ?/,""); print}' "$0"
            exit 0
            ;;
        *) err "Unknown arg: $1 (try --help)"; exit 1 ;;
    esac
done

NAME=$(normalize_name "$NAME_RAW")
state_exists "$NAME" || { err "No selfhosted instance named '$NAME'. Run 'pnpm run selfhosted:provision' first."; exit 1; }
SERVER_IP=$(state_get "$NAME" .server_ip)

# ---------- 1. Install + start kodus-web-tunnel.service ----------
# Separate systemd unit from kodus-tunnel.service (the webhooks one) so
# they restart independently — bouncing one doesn't take the other down.
# The log file is per-tunnel for the same reason (and so the URL regex
# below latches onto the right line).
log "Installing kodus-web-tunnel.service on '$NAME' ($SERVER_IP)..."
ssh_to "$NAME" bash -s <<'REMOTE'
set -euo pipefail
command -v cloudflared >/dev/null 2>&1 || {
    echo "[err] cloudflared binary missing on droplet — was provision.sh run?" >&2
    exit 1
}
cat > /etc/systemd/system/kodus-web-tunnel.service <<'UNIT'
[Unit]
Description=cloudflared quick tunnel for Kodus web (:3000)
After=network-online.target
[Service]
ExecStart=/usr/local/bin/cloudflared tunnel --url http://localhost:3000 --no-autoupdate --logfile /var/log/cloudflared-web.log
Restart=on-failure
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
# Truncate log so the URL probe below doesn't latch onto a stale value
# left over from a previous run.
: > /var/log/cloudflared-web.log
systemctl enable --now kodus-web-tunnel.service
REMOTE
ok "kodus-web-tunnel.service installed + started"

# ---------- 2. Wait for the random URL to show up in the log ----------
# Cloudflared prints the trycloudflare.com URL once at startup. Probe up
# to ~2 minutes (40 * 3s) because cold-start of a quick tunnel can be slow
# on the first call after droplet boot.
log "Waiting for tunnel URL..."
WEB_TUNNEL_URL=""
for i in $(seq 1 40); do
    WEB_TUNNEL_URL=$(ssh_to "$NAME" "grep -oE 'https://[a-zA-Z0-9-]+\\.trycloudflare\\.com' /var/log/cloudflared-web.log 2>/dev/null | head -n1" 2>/dev/null || true)
    [ -n "$WEB_TUNNEL_URL" ] && break
    sleep 3
done
[ -n "$WEB_TUNNEL_URL" ] || {
    err "Tunnel URL never appeared in /var/log/cloudflared-web.log after 2min."
    err "Check on the droplet: journalctl -u kodus-web-tunnel.service --no-pager | tail -30"
    exit 1
}
ok "Tunnel URL: $WEB_TUNNEL_URL"

# ---------- 3. Update .env on droplet ----------
# Three URLs need to match the public host so:
#   - NextAuth cookies scope to the right hostname (NEXTAUTH_URL)
#   - SSO callbacks land back on the right host (API_FRONTEND_URL)
#   - Invite emails contain links that actually work (USER_INVITE_BASE_URL)
log "Updating .env on droplet..."
ssh_to "$NAME" bash -s <<REMOTE
set -euo pipefail
cd /opt/kodus-installer
env_set() {
    local k="\$1" v="\$2"
    if grep -qE "^\${k}=" .env; then
        sed -i "s|^\${k}=.*|\${k}=\${v}|" .env
    else
        echo "\${k}=\${v}" >> .env
    fi
}
env_set NEXTAUTH_URL              "${WEB_TUNNEL_URL}"
env_set API_FRONTEND_URL          "${WEB_TUNNEL_URL}"
env_set API_USER_INVITE_BASE_URL  "${WEB_TUNNEL_URL}"
REMOTE
ok ".env updated (NEXTAUTH_URL, API_FRONTEND_URL, API_USER_INVITE_BASE_URL)"

# ---------- 4. Restart app containers ----------
# Only the services that read any changed env need to bounce. DB / mongo
# / rabbit / cache are untouched.
log "Restarting kodus app containers..."
# Service names as they appear in docker-compose.yml (run `docker compose
# config --services` on the droplet to verify). The web service is named
# `kodus-web` (not `web`), the rest are bare.
ssh_to "$NAME" "cd /opt/kodus-installer && docker compose up -d --force-recreate kodus-web api webhooks worker"
ok "Containers restarted"

# ---------- 5. Save state so destroy / status can find this later ----------
QUICK_STATE="$STATE_DIR/cf-quick-${NAME}.json"
jq -n \
    --arg url "$WEB_TUNNEL_URL" \
    --arg ip  "$SERVER_IP" \
    --arg at  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{mode: "quick", web_tunnel_url: $url, server_ip: $ip, created_at: $at}' \
    > "$QUICK_STATE"
ok "Saved state → $QUICK_STATE"

echo ""
echo "════════════════════════════════════════════════════════════"
ok "🌐 Web: ${WEB_TUNNEL_URL}"
echo "════════════════════════════════════════════════════════════"
echo ""
warn "URL is random and changes whenever the cloudflared service restarts."
warn "Sessions tied to http://${SERVER_IP}:3000 are gone — relog."
warn "If you want a stable URL under your own domain, use:"
warn "   pnpm run selfhosted:dns-setup-named --token ... --account-id ... --zone-id ..."
