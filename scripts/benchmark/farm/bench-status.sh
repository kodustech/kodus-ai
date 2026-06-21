#!/usr/bin/env bash
# bench-status.sh <slot>
#
# Quick remote health view of a farm slot: droplet IP, container states, and
# the tail of the worker log (where review progress shows). Cheap to poll while
# a 50-PR run is in flight.
#
# Usage:
#   scripts/benchmark/farm/bench-status.sh a

set -euo pipefail
FARM_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
. "${FARM_SCRIPT_DIR}/_farm-common.sh"

SLOT="${1:-}"
[ -n "$SLOT" ] || { err "Usage: bench-status.sh <slot>"; exit 2; }

IP="$(farm_ip_for "$SLOT")"
NAME="$(farm_name_for "$SLOT")"
log "Slot '$SLOT' ($NAME) at $IP"

echo
dim "── containers ──"
farm_ssh "$SLOT" "cd '$REMOTE_SRC' 2>/dev/null && docker compose -f docker-compose.bench.yml ps --format 'table {{.Service}}\t{{.State}}\t{{.Status}}' 2>/dev/null || echo '(no bench stack yet -- run bench-sync.sh)'"

echo
dim "── worker log (last 20 lines) ──"
farm_ssh "$SLOT" "docker logs kodus_worker_bench --tail 20 2>/dev/null || echo '(worker not running)'"
