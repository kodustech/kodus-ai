#!/usr/bin/env bash
# bench-down.sh <slot>
#
# Destroy a farm slot's droplet. Thin wrapper over scripts/selfhosted/destroy.sh
# (same provider abstraction + the `kodus-selfhosted-*` safety prefix), targeting
# the slot's instance name bench-<slot>.
#
# Usage:
#   scripts/benchmark/farm/bench-down.sh a

set -euo pipefail
FARM_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
. "${FARM_SCRIPT_DIR}/_farm-common.sh"

SLOT="${1:-}"
[ -n "$SLOT" ] || { err "Usage: bench-down.sh <slot>"; exit 2; }

NAME="$(farm_name_for "$SLOT")"
state_exists "$NAME" || { warn "Slot '$SLOT' has no droplet -- nothing to destroy."; exit 0; }

log "Destroying slot '$SLOT' ($NAME)..."
# -y: non-interactive (the farm is script-driven; destroy.sh otherwise prompts
# for confirmation and hangs). The `kodus-selfhosted-*` prefix safety check in
# destroy.sh still guards against nuking the wrong droplet.
bash "${REPO_ROOT}/scripts/selfhosted/destroy.sh" --name "$NAME" -y
ok "Slot '$SLOT' destroyed."
