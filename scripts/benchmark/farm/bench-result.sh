#!/usr/bin/env bash
# bench-result.sh <slot> [run-id]
#
# Show the F1/precision/recall of a slot's latest run (or a specific run-id).
# While the run is in flight, prints the current phase instead. Reads the files
# bench-run.sh writes -- independent of the terminal that launched it.
#
# Usage:
#   scripts/benchmark/farm/bench-result.sh a

set -euo pipefail
FARM_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
. "${FARM_SCRIPT_DIR}/_farm-common.sh"

SLOT="${1:-}"
[ -n "$SLOT" ] || { err "Usage: bench-result.sh <slot> [run-id]"; exit 2; }
RESULTS_ROOT="${FARM_SCRIPT_DIR}/results"
RUN_ID="${2:-$(readlink "${RESULTS_ROOT}/${SLOT}-latest" 2>/dev/null || true)}"
[ -n "$RUN_ID" ] || { err "No runs for slot '$SLOT' (launch one: bench-run.sh $SLOT <branch>)"; exit 1; }

RUNDIR="${RESULTS_ROOT}/${RUN_ID}"
[ -d "$RUNDIR" ] || { err "Run '$RUN_ID' not found"; exit 1; }
STATUS="$(cat "${RUNDIR}/status" 2>/dev/null || echo unknown)"
BRANCH="$(cat "${RUNDIR}/branch" 2>/dev/null || echo '?')"

log "Run '${RUN_ID}' (branch '${BRANCH}') -- status: ${STATUS}"
if [ -f "${RUNDIR}/scorecard.json" ]; then
    jq -r '.scores[] | "  model \(.model):  F1=\(.f1)  P=\(.precision)  R=\(.recall)   (tp=\(.tp) fp=\(.fp) fn=\(.fn), \(.reviewed)/\(.prs) reviewed)"' \
        "${RUNDIR}/scorecard.json"
else
    case "$STATUS" in
        review) dim "  reviewing 50 PRs -- this is the ~40min LLM wait" ;;
        failed*) err "  see ${RUNDIR}/run.log" ;;
        *) dim "  not judged yet (phase: ${STATUS}); log: ${RUNDIR}/run.log" ;;
    esac
fi
