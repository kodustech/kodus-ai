#!/usr/bin/env bash
# Named Cloudflare Tunnel helpers for the self-hosted test environments.
#
# WHY: the quick tunnel (`cloudflared tunnel --url`) is anonymous and
# ephemeral by design — it dies unannounced (observed: ~2h into a debug
# session, silently 502-ing every GitHub webhook delivery) and a restart
# mints a DIFFERENT URL, so the webhooks registered on the provider repos
# go stale. A named tunnel has a STABLE hostname (https, real cert at
# Cloudflare's edge), reconnects automatically and survives restarts.
#
# Requirements (resolved from ~/.kodus-dev/config / 1Password like the
# other secrets):
#   CLOUDFLARE_API_TOKEN     scopes: Account>Cloudflare Tunnel:Edit,
#                             Zone>DNS:Edit (zone kodus.io)
#   CLOUDFLARE_ACCOUNT_ID    optional — auto-resolved from the token
#   CLOUDFLARE_ZONE_ID       optional — auto-resolved (zone kodus.io)
#
# Without CLOUDFLARE_API_TOKEN every function is a no-op and callers fall
# back to the quick tunnel (previous behavior).

CF_API="https://api.cloudflare.com/client/v4"
CF_TUNNEL_DOMAIN="${CF_TUNNEL_DOMAIN:-e2e.kodus.io}"

cf_named_tunnel_available() {
    [ -n "${CLOUDFLARE_API_TOKEN:-}" ]
}

__cf_curl() {
    curl -sS -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
        -H "Content-Type: application/json" "$@"
}

__cf_require_ids() {
    if [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
        CLOUDFLARE_ACCOUNT_ID=$(__cf_curl "$CF_API/accounts?per_page=1" |
            jq -r '.result[0].id // empty')
    fi
    if [ -z "${CLOUDFLARE_ZONE_ID:-}" ]; then
        local apex="${CF_TUNNEL_DOMAIN#*.}" # e2e.kodus.io -> kodus.io
        CLOUDFLARE_ZONE_ID=$(__cf_curl "$CF_API/zones?name=${apex}" |
            jq -r '.result[0].id // empty')
    fi
    [ -n "$CLOUDFLARE_ACCOUNT_ID" ] && [ -n "$CLOUDFLARE_ZONE_ID" ]
}

# cf_tunnel_provision <env-name>
# Creates (or reuses) the tunnel + DNS record. On success prints two lines:
#   CF_TUNNEL_URL=https://<env-name>.e2e.kodus.io
#   CF_TUNNEL_TOKEN=<run token for cloudflared>
cf_tunnel_provision() {
    local name="kodus-e2e-$1"
    local hostname="$1.${CF_TUNNEL_DOMAIN}"

    __cf_require_ids || {
        echo "cf-tunnel: could not resolve account/zone ids" >&2
        return 1
    }

    # Reuse an existing tunnel with this name (idempotent re-provision);
    # otherwise create one with remote-managed config.
    local tunnel_id
    tunnel_id=$(__cf_curl \
        "$CF_API/accounts/$CLOUDFLARE_ACCOUNT_ID/cfd_tunnel?name=${name}&is_deleted=false" |
        jq -r '.result[0].id // empty')
    if [ -z "$tunnel_id" ]; then
        tunnel_id=$(__cf_curl -X POST \
            "$CF_API/accounts/$CLOUDFLARE_ACCOUNT_ID/cfd_tunnel" \
            -d "{\"name\":\"${name}\",\"config_src\":\"cloudflare\"}" |
            jq -r '.result.id // empty')
    fi
    [ -n "$tunnel_id" ] || {
        echo "cf-tunnel: tunnel create failed" >&2
        return 1
    }

    # Ingress: hostname -> the webhooks proxy port on the VM.
    __cf_curl -X PUT \
        "$CF_API/accounts/$CLOUDFLARE_ACCOUNT_ID/cfd_tunnel/$tunnel_id/configurations" \
        -d "{\"config\":{\"ingress\":[{\"hostname\":\"${hostname}\",\"service\":\"http://localhost:3332\"},{\"service\":\"http_status:404\"}]}}" \
        >/dev/null

    # DNS: CNAME <name>.e2e -> <tunnel>.cfargotunnel.com (proxied). Upsert.
    local record_id
    record_id=$(__cf_curl \
        "$CF_API/zones/$CLOUDFLARE_ZONE_ID/dns_records?name=${hostname}&type=CNAME" |
        jq -r '.result[0].id // empty')
    local dns_body="{\"type\":\"CNAME\",\"name\":\"${hostname}\",\"content\":\"${tunnel_id}.cfargotunnel.com\",\"proxied\":true,\"comment\":\"kodus e2e tunnel (auto)\"}"
    if [ -n "$record_id" ]; then
        __cf_curl -X PUT \
            "$CF_API/zones/$CLOUDFLARE_ZONE_ID/dns_records/$record_id" \
            -d "$dns_body" >/dev/null
    else
        __cf_curl -X POST "$CF_API/zones/$CLOUDFLARE_ZONE_ID/dns_records" \
            -d "$dns_body" >/dev/null
    fi

    local run_token
    run_token=$(__cf_curl \
        "$CF_API/accounts/$CLOUDFLARE_ACCOUNT_ID/cfd_tunnel/$tunnel_id/token" |
        jq -r '.result // empty')
    [ -n "$run_token" ] || {
        echo "cf-tunnel: token fetch failed" >&2
        return 1
    }

    echo "CF_TUNNEL_URL=https://${hostname}"
    echo "CF_TUNNEL_TOKEN=${run_token}"
}

# cf_tunnel_destroy <env-name> — best-effort cleanup (DNS + tunnel).
cf_tunnel_destroy() {
    cf_named_tunnel_available || return 0
    local name="kodus-e2e-$1"
    local hostname="$1.${CF_TUNNEL_DOMAIN}"
    __cf_require_ids || return 0

    local record_id
    record_id=$(__cf_curl \
        "$CF_API/zones/$CLOUDFLARE_ZONE_ID/dns_records?name=${hostname}&type=CNAME" |
        jq -r '.result[0].id // empty')
    [ -n "$record_id" ] && __cf_curl -X DELETE \
        "$CF_API/zones/$CLOUDFLARE_ZONE_ID/dns_records/$record_id" >/dev/null

    local tunnel_id
    tunnel_id=$(__cf_curl \
        "$CF_API/accounts/$CLOUDFLARE_ACCOUNT_ID/cfd_tunnel?name=${name}&is_deleted=false" |
        jq -r '.result[0].id // empty')
    if [ -n "$tunnel_id" ]; then
        # cascade=true drops open connections so the delete can't 409.
        __cf_curl -X DELETE \
            "$CF_API/accounts/$CLOUDFLARE_ACCOUNT_ID/cfd_tunnel/$tunnel_id?cascade=true" \
            >/dev/null
    fi
}
