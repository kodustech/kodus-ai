#!/usr/bin/env bash
# Tails docker compose logs on the remote self-hosted stack.
#
# Usage:
#   pnpm run selfhosted:logs                          # all services
#   pnpm run selfhosted:logs --name wellington
#   pnpm run selfhosted:logs -- api worker            # specific services
#   pnpm run selfhosted:logs --tail 200 -- api        # custom tail count

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
. "$SCRIPT_DIR/_common.sh"

NAME_RAW="default"
TAIL="50"
SERVICES_ARR=()
# Parse flags from anywhere on the line. Anything that isn't a flag becomes
# a positional service name. This lets `pnpm run selfhosted:logs api worker
# --tail 100` work — the package manager may eat the leading `--` so flags can appear after
# positionals.
while [ $# -gt 0 ]; do
    case "$1" in
        --name) NAME_RAW="$2"; shift 2 ;;
        --name=*) NAME_RAW="${1#--name=}"; shift ;;
        --tail) TAIL="$2"; shift 2 ;;
        --tail=*) TAIL="${1#--tail=}"; shift ;;
        --) shift ;;
        -h|--help)
            grep -E '^#( |$)' "$0" | sed 's/^# \?//'
            exit 0
            ;;
        *)
            SERVICES_ARR+=("$1")
            shift
            ;;
    esac
done
SERVICES="${SERVICES_ARR[*]:-}"

NAME=$(normalize_name "$NAME_RAW")
state_exists "$NAME" || { err "No instance named '$NAME'."; exit 1; }

CMD="cd /opt/kodus-installer && docker compose logs --tail $TAIL --no-color -f $SERVICES"
log "Tailing logs from '$NAME' (Ctrl-C to stop). Services: ${SERVICES:-all}"
# Note: ssh_to is a function in _common.sh, not an external command — `exec`
# would fail with "not found". Just call it.
ssh_to "$NAME" "$CMD"
