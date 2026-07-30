#!/usr/bin/env bash
# Build the current branch ONCE and put it on every alive matrix* droplet.
#
# The first instance gets a real build via deploy.sh, which caches a
# docker-compose.override.yml at ~/.kodus-dev/last-deploy.override.yml pinning
# the dev image tag. The remaining instances get that SAME override SCP'd onto
# them plus a pull + restart — no rebuild — so all droplets converge on one
# image. Use this to push a code change to an already-provisioned per-provider
# matrix fleet without re-provisioning (fresh provisions auto-apply the cached
# override; alive ones don't, which is what this script handles).
#
# Usage:
#   pnpm run selfhosted:deploy-all
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
. "$SCRIPT_DIR/_common.sh"

INSTANCES=()
while IFS= read -r line; do
    [ -n "$line" ] && INSTANCES+=("$line")
done < <(list_instances | grep -E '^matrix(-|$)' || true)

if [ "${#INSTANCES[@]}" -eq 0 ]; then
    err "No matrix* droplets alive. Provision first:"
    err "  pnpm run e2e:matrix matrix/full.yml --target self-hosted --auto-provision-per-provider -y"
    exit 1
fi

FIRST="${INSTANCES[0]}"
log "Building once → deploying to $FIRST (${#INSTANCES[@]} droplet(s) total) ..."
"$SCRIPT_DIR/deploy.sh" --name "$FIRST"

OVERRIDE_CACHE="$HOME/.kodus-dev/last-deploy.override.yml"
[ -f "$OVERRIDE_CACHE" ] || { err "deploy.sh did not produce $OVERRIDE_CACHE — cannot distribute"; exit 1; }

SSH_OPTS=(-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=15)
GH_USER=$(gh api user --jq .login 2>/dev/null | tr '[:upper:]' '[:lower:]' || true)

# Distribute the freshly-built image (pinned in the cached override) to the
# remaining droplets without rebuilding.
for inst in "${INSTANCES[@]:1}"; do
    ip=$(state_get "$inst" .server_ip)
    if [ -z "$ip" ]; then
        warn "no server_ip for $inst — skipping"
        continue
    fi
    key=$(ssh_key_path_for "$inst")
    log "Distributing build to $inst ($ip) — no rebuild ..."
    scp -i "$key" "${SSH_OPTS[@]}" \
        "$OVERRIDE_CACHE" "root@$ip:/opt/kodus-installer/docker-compose.override.yml"
    GH_TOKEN_FOR_DROPLET=$(gh auth token 2>/dev/null || true)
    ssh -i "$key" "${SSH_OPTS[@]}" "root@$ip" bash <<REMOTE
set -e
cd /opt/kodus-installer
echo "$GH_TOKEN_FOR_DROPLET" | docker login ghcr.io -u "$GH_USER" --password-stdin >/dev/null
docker compose pull
docker compose up -d --remove-orphans
docker logout ghcr.io >/dev/null
REMOTE
    unset GH_TOKEN_FOR_DROPLET
    ok "$inst updated"
done

ok "deploy-all done — ${#INSTANCES[@]} droplet(s) on the current build."
