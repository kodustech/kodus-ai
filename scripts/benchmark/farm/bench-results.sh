#!/usr/bin/env bash
# bench-results.sh
#
# One table across all slots' latest runs -- compare branches side by side.
#
# Usage:
#   scripts/benchmark/farm/bench-results.sh

set -euo pipefail
FARM_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
. "${FARM_SCRIPT_DIR}/_farm-common.sh"

RESULTS_ROOT="${FARM_SCRIPT_DIR}/results"
[ -d "$RESULTS_ROOT" ] || { warn "No runs yet."; exit 0; }

printf '%-8s %-28s %-10s %-7s %-7s %-7s %s\n' SLOT BRANCH STATUS F1 P R RUN
for link in "${RESULTS_ROOT}"/*-latest; do
    [ -L "$link" ] || continue
    slot="$(basename "$link")"; slot="${slot%-latest}"
    run_id="$(readlink "$link" 2>/dev/null || true)"; [ -n "$run_id" ] || continue
    d="${RESULTS_ROOT}/${run_id}"
    branch="$(cat "${d}/branch" 2>/dev/null || echo '?')"
    status="$(cat "${d}/status" 2>/dev/null || echo '?')"
    f1=-; p=-; r=-
    if [ -f "${d}/scorecard.json" ]; then
        read -r f1 p r < <(jq -r '.scores[0] | "\(.f1) \(.precision) \(.recall)"' "${d}/scorecard.json" 2>/dev/null || echo "- - -")
    fi
    printf '%-8s %-28s %-10s %-7s %-7s %-7s %s\n' "$slot" "$branch" "$status" "$f1" "$p" "$r" "$run_id"
done
