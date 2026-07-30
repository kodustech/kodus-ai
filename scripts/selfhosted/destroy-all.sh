#!/usr/bin/env bash
# Destroy every matrix droplet — the single `matrix` instance and all the
# per-provider `matrix-<provider>` instances created by
# `--auto-provision-per-provider`. Use after a per-provider matrix run so
# you don't leave 4 droplets billing on DigitalOcean.
#
# Usage:
#   pnpm run selfhosted:destroy-all          # prompts once, then destroys all
#   pnpm run selfhosted:destroy-all -y       # no prompt
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
. "$SCRIPT_DIR/_common.sh"

ASSUME_YES=0
for a in "$@"; do
    case "$a" in
        -y|--yes) ASSUME_YES=1 ;;
    esac
done

INSTANCES=()
while IFS= read -r line; do
    [ -n "$line" ] && INSTANCES+=("$line")
done < <(list_instances | grep -E '^matrix(-|$)' || true)

if [ "${#INSTANCES[@]}" -eq 0 ]; then
    log "No matrix* droplets to destroy."
    exit 0
fi

log "Will destroy ${#INSTANCES[@]} droplet(s): ${INSTANCES[*]}"
if [ "$ASSUME_YES" != "1" ]; then
    read -r -p "Continue? (y/N): " REPLY
    [[ "$REPLY" =~ ^[Yy]$ ]] || { warn "Aborted."; exit 0; }
fi

rc=0
for inst in "${INSTANCES[@]}"; do
    log "Destroying $inst ..."
    "$SCRIPT_DIR/destroy.sh" --name "$inst" -y || { warn "destroy failed for $inst"; rc=1; }
done
exit $rc
