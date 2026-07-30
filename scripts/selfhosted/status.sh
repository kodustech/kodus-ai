#!/usr/bin/env bash
# Lists active self-hosted dev instances and reports health.
#
# Usage:
#   pnpm run selfhosted:status                  # lists all
#   pnpm run selfhosted:status --name wellington # detail for one

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
. "$SCRIPT_DIR/_common.sh"

NAME_RAW=""
while [ $# -gt 0 ]; do
    case "$1" in
        --name) NAME_RAW="$2"; shift 2 ;;
        --name=*) NAME_RAW="${1#--name=}"; shift ;;
        -h|--help)
            grep -E '^#( |$)' "$0" | sed 's/^# \?//'
            exit 0
            ;;
        *) err "Unknown arg: $1"; exit 2 ;;
    esac
done

probe_http() {
    local url=$1
    local code
    code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "$url" 2>/dev/null || echo 000)
    if [[ "$code" =~ ^[234][0-9][0-9]$ ]]; then echo "up ($code)"; else echo "down ($code)"; fi
}

show_instance() {
    local name=$1
    local dashboard api tunnel server_ip created_at age_secs age_str
    dashboard=$(state_get "$name" .dashboard_url)
    api=$(state_get "$name" .api_url)
    tunnel=$(state_get "$name" .tunnel_url)
    server_ip=$(state_get "$name" .server_ip)
    created_at=$(state_get "$name" .created_at)

    # Coarse age calc — bash-portable.
    if [ -n "$created_at" ]; then
        if date -j -f "%Y-%m-%dT%H:%M:%SZ" "$created_at" "+%s" >/dev/null 2>&1; then
            age_secs=$(( $(date +%s) - $(date -j -u -f "%Y-%m-%dT%H:%M:%SZ" "$created_at" "+%s") ))
        else
            age_secs=$(( $(date +%s) - $(date -u -d "$created_at" "+%s" 2>/dev/null || echo 0) ))
        fi
        if [ "$age_secs" -gt 0 ]; then
            local h=$(( age_secs / 3600 ))
            local m=$(( (age_secs % 3600) / 60 ))
            age_str="${h}h${m}m"
        else
            age_str="?"
        fi
    fi

    echo ""
    echo -e "${BLUE}[$name]${NC}"
    echo "  Server IP:    $server_ip"
    echo "  Dashboard:    $dashboard  → $(probe_http "$dashboard")"
    echo "  API:          $api  → $(probe_http "$api")"
    echo "  Tunnel:       $tunnel"
    echo "  Created:      $created_at  (${age_str:-?} ago)"
    echo "  Tenant:       $(state_get "$name" .tenant.email)"
    echo "  GH wired:     $(state_get "$name" .gh_integration_configured)"
}

if [ -n "$NAME_RAW" ]; then
    NAME=$(normalize_name "$NAME_RAW")
    state_exists "$NAME" || { err "No instance named '$NAME'"; exit 1; }
    show_instance "$NAME"
else
    INSTANCES=$(list_instances)
    if [ -z "$INSTANCES" ]; then
        dim "No active instances. Run 'pnpm run selfhosted:provision' to provision one."
        exit 0
    fi
    log "Active instances:"
    while read -r name; do
        [ -z "$name" ] && continue
        show_instance "$name"
    done <<< "$INSTANCES"
fi
