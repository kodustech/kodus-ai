#!/usr/bin/env bash
# Sets up a Cloudflare named tunnel + DNS for a provisioned self-hosted
# Kodus droplet. Replaces the random quick-tunnel webhook URL with stable
# DNS-backed routes for both web (port 3000) and webhook (port 3332).
# One named tunnel handles both via ingress rules — same systemd service
# slot as before (kodus-tunnel.service), so the rollback story is just
# putting the old ExecStart line back.
#
# No cloudflared CLI needed locally: we drive everything through the
# Cloudflare REST API + restart cloudflared (already on the droplet from
# provision.sh) with `--token <tunnel-token>` (read from env file). No
# `cert.pem` to generate, no browser login.
#
# What you need (one-time, in your Cloudflare account):
#   1. API token with: Account > Cloudflare Tunnel > Edit
#                      Zone   > DNS              > Edit  (Specific zone)
#   2. Account ID  (dashboard home → sidebar right)
#   3. Zone ID     (your zone, e.g. kodus.io → sidebar right)
#
# Usage:
#   pnpm run selfhosted:dns-setup \
#       --token      <CF_API_TOKEN> \
#       --account-id <CF_ACCOUNT_ID> \
#       --zone-id    <CF_ZONE_ID>
#
# Optional:
#   --web-sub <name>    web subdomain (default: kodus-<8hex>)
#   --wh-sub  <name>    webhook subdomain (default: wh-<same-8hex>)
#   --name    <inst>    selfhosted instance name (default: default)
#   --dry-run           print plan, skip all API + remote calls

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
. "$SCRIPT_DIR/_common.sh"

require_cmd curl
require_cmd jq
require_cmd openssl

NAME_RAW="default"
CF_TOKEN=""
CF_ACCOUNT_ID=""
CF_ZONE_ID=""
WEB_SUB=""
WH_SUB=""
DRY_RUN="false"

while [ $# -gt 0 ]; do
    case "$1" in
        --token)        CF_TOKEN="$2"; shift 2 ;;
        --token=*)      CF_TOKEN="${1#--token=}"; shift ;;
        --account-id)   CF_ACCOUNT_ID="$2"; shift 2 ;;
        --account-id=*) CF_ACCOUNT_ID="${1#--account-id=}"; shift ;;
        --zone-id)      CF_ZONE_ID="$2"; shift 2 ;;
        --zone-id=*)    CF_ZONE_ID="${1#--zone-id=}"; shift ;;
        --web-sub)      WEB_SUB="$2"; shift 2 ;;
        --web-sub=*)    WEB_SUB="${1#--web-sub=}"; shift ;;
        --wh-sub)       WH_SUB="$2"; shift 2 ;;
        --wh-sub=*)     WH_SUB="${1#--wh-sub=}"; shift ;;
        --name)         NAME_RAW="$2"; shift 2 ;;
        --name=*)       NAME_RAW="${1#--name=}"; shift ;;
        --dry-run)      DRY_RUN="true"; shift ;;
        -h|--help)
            # Print only the header comment block (everything between the
            # shebang and the first blank line). Avoids leaking internal
            # `# section` comments scattered through the script body.
            awk 'NR>1 && /^$/ {exit} NR>1 {sub(/^# ?/,""); print}' "$0"
            exit 0
            ;;
        *) err "Unknown arg: $1 (try --help)"; exit 1 ;;
    esac
done

[ -n "$CF_TOKEN" ]      || { err "--token is required (Cloudflare API token)"; exit 1; }
[ -n "$CF_ACCOUNT_ID" ] || { err "--account-id is required"; exit 1; }
[ -n "$CF_ZONE_ID" ]    || { err "--zone-id is required"; exit 1; }

NAME=$(normalize_name "$NAME_RAW")
state_exists "$NAME" || { err "No selfhosted instance named '$NAME'. Run 'pnpm run selfhosted:provision' first."; exit 1; }
SERVER_IP=$(state_get "$NAME" .server_ip)

# Generate a single random suffix and share it between web + webhook subs
# unless the caller pinned either one. Sharing the suffix keeps the two
# subdomains visually related (kodus-a3f2b9c1 + wh-a3f2b9c1) so when you
# see one in a log you immediately know the other.
if [ -z "$WEB_SUB" ] || [ -z "$WH_SUB" ]; then
    RAND=$(openssl rand -hex 4)
    [ -z "$WEB_SUB" ] && WEB_SUB="kodus-${RAND}"
    [ -z "$WH_SUB" ]  && WH_SUB="wh-${RAND}"
fi

# ---------- Cloudflare REST helper ----------
# Single funnel for every CF call so error formatting + auth header stay
# consistent. Returns the raw JSON on success, dumps the error envelope
# to stderr on failure (CF returns { success: bool, errors: [...] }).
cf_api() {
    local method="$1" path="$2" data="${3:-}"
    local resp
    if [ -n "$data" ]; then
        resp=$(curl -sS -X "$method" "https://api.cloudflare.com/client/v4$path" \
            -H "Authorization: Bearer $CF_TOKEN" \
            -H "Content-Type: application/json" \
            --data "$data")
    else
        resp=$(curl -sS -X "$method" "https://api.cloudflare.com/client/v4$path" \
            -H "Authorization: Bearer $CF_TOKEN")
    fi
    local success
    success=$(echo "$resp" | jq -r '.success // false')
    if [ "$success" != "true" ]; then
        err "Cloudflare API call failed: $method $path"
        echo "$resp" | jq . >&2 || echo "$resp" >&2
        return 1
    fi
    echo "$resp"
}

log "Resolving zone metadata..."
ZONE_NAME=$(cf_api GET "/zones/$CF_ZONE_ID" | jq -r '.result.name')
[ -n "$ZONE_NAME" ] && [ "$ZONE_NAME" != "null" ] \
    || { err "Could not resolve zone name from --zone-id"; exit 1; }
ok "Zone: $ZONE_NAME"

WEB_FQDN="${WEB_SUB}.${ZONE_NAME}"
WH_FQDN="${WH_SUB}.${ZONE_NAME}"
TUNNEL_NAME="kodus-${NAME}-${WEB_SUB##*-}"

log "Plan:"
dim "  Instance:        $NAME ($SERVER_IP)"
dim "  Tunnel name:     $TUNNEL_NAME"
dim "  Web FQDN:        https://$WEB_FQDN   → http://localhost:3000"
dim "  Webhook FQDN:    https://$WH_FQDN    → http://localhost:3332"

if [ "$DRY_RUN" = "true" ]; then
    warn "Dry run — exiting before any side effects"
    exit 0
fi

# ---------- 1. Create tunnel ----------
log "Creating named tunnel..."
TUNNEL_RESP=$(cf_api POST "/accounts/$CF_ACCOUNT_ID/cfd_tunnel" \
    "$(jq -nc --arg name "$TUNNEL_NAME" '{name: $name, config_src: "cloudflare"}')")
TUNNEL_ID=$(echo "$TUNNEL_RESP" | jq -r '.result.id')
TUNNEL_TOKEN=$(echo "$TUNNEL_RESP" | jq -r '.result.token')
[ -n "$TUNNEL_ID" ] && [ "$TUNNEL_ID" != "null" ] || { err "No tunnel id in API response"; exit 1; }
ok "Tunnel created: $TUNNEL_ID"

# ---------- 2. Ingress rules ----------
# `cloudflared` matches incoming requests by Host header to one of these
# rules in order; the last `http_status:404` is the required catch-all.
# Services point at `localhost:<port>` because cloudflared runs on the
# droplet host network, not inside the docker-compose network.
log "Configuring tunnel ingress (web :3000, webhook :3332)..."
INGRESS=$(jq -nc \
    --arg web "$WEB_FQDN" \
    --arg wh  "$WH_FQDN" \
    '{config: {ingress: [
        {hostname: $web, service: "http://localhost:3000"},
        {hostname: $wh,  service: "http://localhost:3332"},
        {service: "http_status:404"}
    ]}}')
cf_api PUT "/accounts/$CF_ACCOUNT_ID/cfd_tunnel/$TUNNEL_ID/configurations" "$INGRESS" >/dev/null
ok "Ingress rules configured"

# ---------- 3. DNS CNAMEs ----------
# Idempotent: if a record at the target name already exists we PUT
# (replace) instead of POST, so re-running the script never errors out
# with "record already exists".
log "Creating DNS records..."
CNAME_TARGET="${TUNNEL_ID}.cfargotunnel.com"
for SUB in "$WEB_SUB" "$WH_SUB"; do
    EXISTING=$(cf_api GET "/zones/$CF_ZONE_ID/dns_records?type=CNAME&name=${SUB}.${ZONE_NAME}" \
        | jq -r '.result[0].id // empty')
    PAYLOAD=$(jq -nc --arg name "$SUB" --arg content "$CNAME_TARGET" \
        '{type:"CNAME", name:$name, content:$content, proxied:true, ttl:1}')
    if [ -n "$EXISTING" ]; then
        warn "  CNAME ${SUB}.${ZONE_NAME} exists — replacing"
        cf_api PUT "/zones/$CF_ZONE_ID/dns_records/$EXISTING" "$PAYLOAD" >/dev/null
    else
        cf_api POST "/zones/$CF_ZONE_ID/dns_records" "$PAYLOAD" >/dev/null
    fi
    ok "  ${SUB}.${ZONE_NAME} → ${CNAME_TARGET} (proxied)"
done

# ---------- 4. Reconfigure cloudflared on the droplet ----------
# Token-based tunnels read TUNNEL_TOKEN from env; using EnvironmentFile
# keeps the secret off the command line (which would show in `ps aux`).
# Same systemd unit name as provision.sh's quick-tunnel, so swapping
# back is a one-liner ExecStart edit.
log "Updating cloudflared service on droplet ($SERVER_IP)..."
ssh_to "$NAME" bash -s <<REMOTE
set -euo pipefail
install -m 700 -d /etc/cloudflared
umask 077
cat > /etc/cloudflared/tunnel.env <<EOF
TUNNEL_TOKEN=${TUNNEL_TOKEN}
EOF
chmod 600 /etc/cloudflared/tunnel.env

cat > /etc/systemd/system/kodus-tunnel.service <<'UNIT'
[Unit]
Description=cloudflared named tunnel for Kodus (web + webhooks)
After=network-online.target
[Service]
EnvironmentFile=/etc/cloudflared/tunnel.env
ExecStart=/usr/local/bin/cloudflared tunnel --no-autoupdate --logfile /var/log/cloudflared.log run
Restart=on-failure
[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl restart kodus-tunnel.service
sleep 2
systemctl --no-pager status kodus-tunnel.service | head -10
REMOTE
ok "cloudflared restarted with named tunnel"

# ---------- 5. .env on droplet ----------
# These four URLs all need to match the public FQDN so:
#   - NextAuth cookies scope correctly (NEXTAUTH_URL)
#   - SSO redirect lands on the right host (API_FRONTEND_URL)
#   - Invite emails contain working links (API_USER_INVITE_BASE_URL)
#   - Webhook auto-registration tells providers where to POST
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
env_set NEXTAUTH_URL                                "https://${WEB_FQDN}"
env_set API_FRONTEND_URL                            "https://${WEB_FQDN}"
env_set API_USER_INVITE_BASE_URL                    "https://${WEB_FQDN}"
env_set API_GITHUB_CODE_MANAGEMENT_WEBHOOK          "https://${WH_FQDN}/github/webhook"
env_set API_GITLAB_CODE_MANAGEMENT_WEBHOOK          "https://${WH_FQDN}/gitlab/webhook"
env_set GLOBAL_BITBUCKET_CODE_MANAGEMENT_WEBHOOK    "https://${WH_FQDN}/bitbucket/webhook"
env_set GLOBAL_AZURE_REPOS_CODE_MANAGEMENT_WEBHOOK  "https://${WH_FQDN}/azure-repos/webhook"
REMOTE
ok ".env updated on droplet"

# ---------- 6. Restart app containers ----------
# Only the services that read any of the changed env vars need to bounce.
# DB / mongo / rabbit are untouched.
log "Restarting kodus app containers..."
ssh_to "$NAME" "cd /opt/kodus-installer && docker compose up -d --force-recreate kodus-web api webhooks worker"
ok "Containers restarted"

# ---------- 7. Persist tunnel info for later (destroy, status) ----------
TUNNEL_STATE="$STATE_DIR/cf-tunnel-${NAME}.json"
jq -n \
    --arg id     "$TUNNEL_ID" \
    --arg name   "$TUNNEL_NAME" \
    --arg web    "$WEB_FQDN" \
    --arg wh     "$WH_FQDN" \
    --arg account "$CF_ACCOUNT_ID" \
    --arg zone   "$CF_ZONE_ID" \
    '{
        tunnel_id: $id,
        tunnel_name: $name,
        web_fqdn: $web,
        webhook_fqdn: $wh,
        account_id: $account,
        zone_id: $zone,
        created_at: now | todate
    }' > "$TUNNEL_STATE"
ok "Saved tunnel state → $TUNNEL_STATE"

echo ""
echo "════════════════════════════════════════════════════════════"
ok "🌐 Web:     https://${WEB_FQDN}"
ok "📨 Webhook: https://${WH_FQDN}"
echo "════════════════════════════════════════════════════════════"
echo ""
warn "DNS + tunnel can take ~30s to be reachable. If first request 404s, wait a minute."
warn "Existing browser sessions tied to http://${SERVER_IP}:3000 are gone — relog."
warn "Webhooks already registered with the old quick-tunnel URL must be re-registered"
warn "  → in the Kodus dashboard, reconnect each repository / integration."
