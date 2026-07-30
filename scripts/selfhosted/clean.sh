#!/usr/bin/env bash
# Clean local Docker disk usage that accumulates from selfhosted:deploy.
#
# What it cleans (in order, most to least impactful):
#   1. BuildKit cache (the usual culprit — can grow to 20+ GB)
#   2. Dangling images (failed builds, replaced tags)
#   3. Stopped containers (not running, just taking space)
#   4. (Optional with --volumes) Volumes not attached to a container
#
# Does NOT touch:
#   - Running containers
#   - Images currently in use by a running container
#   - Anything outside Docker
#
# Usage:
#   pnpm run selfhosted:clean              # interactive (shows usage + asks confirm)
#   pnpm run selfhosted:clean -y           # skip confirmation
#   pnpm run selfhosted:clean --volumes    # also prune dangling volumes
#   pnpm run selfhosted:clean --nuke       # 'docker system prune -af' — aggressive

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
. "$SCRIPT_DIR/_common.sh"

ASSUME_YES=0
PRUNE_VOLUMES=0
NUKE=0
while [ $# -gt 0 ]; do
    case "$1" in
        -y|--yes) ASSUME_YES=1; shift ;;
        --volumes) PRUNE_VOLUMES=1; shift ;;
        --nuke) NUKE=1; shift ;;
        -h|--help)
            grep -E '^#( |$)' "$0" | sed 's/^# \?//'
            exit 0
            ;;
        *) err "Unknown arg: $1"; exit 2 ;;
    esac
done

require_cmd docker

log "Current Docker disk usage:"
echo ""
docker system df 2>&1 | sed 's/^/  /'
echo ""

if [ "$NUKE" = "1" ]; then
    warn "Nuke mode: 'docker system prune -af --volumes' will remove:"
    warn "  - ALL stopped containers"
    warn "  - ALL networks not used by at least one container"
    warn "  - ALL images without at least one container associated"
    warn "  - ALL build cache"
    warn "  - ALL dangling volumes"
    if [ "$ASSUME_YES" != "1" ]; then
        read -p "$(echo -e "${YELLOW}Continue? (y/N): ${NC}")" -r REPLY
        [[ "$REPLY" =~ ^[Yy]$ ]] || { dim "Aborted."; exit 0; }
    fi
    docker system prune -af --volumes
    echo ""
    ok "Done. Re-running docker system df:"
    docker system df 2>&1 | sed 's/^/  /'
    exit 0
fi

cat <<PLAN
Plan:
  1. docker buildx prune --all --force      # clear BuildKit cache
  2. docker image prune -a --force          # remove unused images
  3. docker container prune --force         # remove stopped containers
$([ "$PRUNE_VOLUMES" = "1" ] && echo "  4. docker volume prune --force            # remove dangling volumes")

PLAN

if [ "$ASSUME_YES" != "1" ]; then
    read -p "$(echo -e "${YELLOW}Continue? (y/N): ${NC}")" -r REPLY
    [[ "$REPLY" =~ ^[Yy]$ ]] || { dim "Aborted."; exit 0; }
fi

log "Pruning BuildKit cache..."
docker buildx prune --all --force 2>&1 | tail -3

log "Pruning unused images..."
docker image prune -a --force 2>&1 | tail -3

log "Pruning stopped containers..."
docker container prune --force 2>&1 | tail -3

if [ "$PRUNE_VOLUMES" = "1" ]; then
    log "Pruning dangling volumes..."
    docker volume prune --force 2>&1 | tail -3
fi

echo ""
ok "Done. Current Docker disk usage:"
docker system df 2>&1 | sed 's/^/  /'
