#!/usr/bin/env bash
# bench-up.sh <slot>
#
# Create (or reuse) a bare droplet for a benchmark farm slot: Docker + git +
# rsync + cloudflared, no Kodus stack yet. The stack is built onto it later by
# bench-sync.sh from a branch's source (Option A -- build on droplet, no GHCR).
#
# This is a thin wrapper over scripts/selfhosted/provision.sh in BENCH_BASE_ONLY
# mode, so droplet creation / SSH keys / state / secrets all come from the
# existing self-hosted tooling.
#
# Env:
#   BENCH_DO_SIZE   droplet size (default s-4vcpu-8gb -- build needs RAM/CPU)
#   DIGITALOCEAN_TOKEN  via ~/.kodus-dev/config (loaded by _common.sh)
#
# Usage:
#   scripts/benchmark/farm/bench-up.sh a
#   BENCH_DO_SIZE=s-8vcpu-16gb scripts/benchmark/farm/bench-up.sh perf-v2

set -euo pipefail
FARM_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
. "${FARM_SCRIPT_DIR}/_farm-common.sh"

SLOT="${1:-}"
[ -n "$SLOT" ] || { err "Usage: bench-up.sh <slot>"; exit 2; }

NAME="$(farm_name_for "$SLOT")"

if state_exists "$NAME"; then
    IP="$(state_get "$NAME" .server_ip)"
    ok "Slot '$SLOT' already up -- $NAME at ${IP:-<unknown>}"
    dim "  Sync a branch onto it: scripts/benchmark/farm/bench-sync.sh $SLOT <branch>"
    exit 0
fi

log "Creating bare droplet for slot '$SLOT' ($NAME)..."
BENCH_BASE_ONLY=1 \
DO_SIZE="${BENCH_DO_SIZE:-s-4vcpu-8gb}" \
    bash "${REPO_ROOT}/scripts/selfhosted/provision.sh" --name "$NAME"

IP="$(state_get "$NAME" .server_ip)"
ok "Slot '$SLOT' ready at ${IP}"
dim "  Next: scripts/benchmark/farm/bench-sync.sh $SLOT <branch>"
