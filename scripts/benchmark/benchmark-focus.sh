#!/bin/bash
#
# Run benchmark on a focused subset of PRs (e.g. worst performers).
#
# Usage:
#   ./benchmark-focus.sh <base-name> <pr-list-file> [REPEATS]
#   ./benchmark-focus.sh fix-keycloak worst-prs.json 2
#
# The pr-list-file is a JSON with the same format as prs-benchmark.json
# but containing only the PRs you want to test.
#
# Quick start — extract worst PRs from a previous run:
#   node -e "
#     const r = require('./results/my-run/results-severity.json');
#     const worst = r.prResults.filter(p => p.tp === 0).map(p => p.title);
#     const all = require('./prs-benchmark.json');
#     const focused = { prs: all.prs.filter(p => worst.includes(p.title)) };
#     require('fs').writeFileSync('worst-prs.json', JSON.stringify(focused, null, 2));
#     console.log(focused.prs.length + ' PRs extracted');
#   "
#
set -euo pipefail

if [ -z "${1:-}" ] || [ -z "${2:-}" ]; then
  echo "Usage: ./benchmark-focus.sh <base-name> <pr-list-file> [REPEATS]"
  echo ""
  echo "Examples:"
  echo "  ./benchmark-focus.sh fix-keycloak worst-prs.json 2"
  echo "  ./benchmark-focus.sh test-docs scripts/benchmark/focus-sets/0tp-prs.json 1"
  exit 1
fi

BASE_NAME="$1"
PR_LIST_FILE="$2"
REPEATS="${3:-1}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
STAMP="$(date +%Y%m%d-%H%M%S)"
SUITE_DIR="$SCRIPT_DIR/results/suites/${BASE_NAME}-${STAMP}"
INTERVAL_SEC="${BENCHMARK_WAIT_INTERVAL_SEC:-20}"
TIMEOUT_MIN="${BENCHMARK_WAIT_TIMEOUT_MIN:-90}"
EXPORT_TRACES="${BENCHMARK_EXPORT_TRACES:-true}"

# Resolve PR list file
if [[ "$PR_LIST_FILE" = /* ]]; then
  FOCUS_FILE="$PR_LIST_FILE"
else
  FOCUS_FILE="$SCRIPT_DIR/$PR_LIST_FILE"
fi

if [ ! -f "$FOCUS_FILE" ]; then
  echo "PR list file not found: $FOCUS_FILE"
  exit 1
fi

TOTAL_PRS=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$FOCUS_FILE','utf8')).prs.length)")

mkdir -p "$SUITE_DIR"

echo "============================================================"
echo "Focused Benchmark Suite"
echo "============================================================"
echo "Base name:  $BASE_NAME"
echo "PR list:    $PR_LIST_FILE ($TOTAL_PRS PRs)"
echo "Repeats:    $REPEATS"
echo "Wait:       interval=${INTERVAL_SEC}s timeout=${TIMEOUT_MIN}m"
echo "Suite dir:  $SUITE_DIR"
echo ""

# Temporarily swap prs-benchmark.json AND pr-creator/prs.json with focused list
ORIGINAL_BENCHMARK="$SCRIPT_DIR/prs-benchmark.json"
BACKUP_BENCHMARK="$SCRIPT_DIR/prs-benchmark.json.bak"
PR_CREATOR_FILE="$SCRIPT_DIR/../pr-creator/prs.json"
BACKUP_PR_CREATOR="$SCRIPT_DIR/../pr-creator/prs.json.bak"

cp "$ORIGINAL_BENCHMARK" "$BACKUP_BENCHMARK"
cp "$FOCUS_FILE" "$ORIGINAL_BENCHMARK"

if [ -f "$PR_CREATOR_FILE" ]; then
  cp "$PR_CREATOR_FILE" "$BACKUP_PR_CREATOR"
  cp "$FOCUS_FILE" "$PR_CREATOR_FILE"
fi

# Restore on exit
trap '
  cp "$BACKUP_BENCHMARK" "$ORIGINAL_BENCHMARK" && rm -f "$BACKUP_BENCHMARK"
  if [ -f "$BACKUP_PR_CREATOR" ]; then
    cp "$BACKUP_PR_CREATOR" "$PR_CREATOR_FILE" && rm -f "$BACKUP_PR_CREATOR"
  fi
  echo "Restored original prs-benchmark.json and prs.json"
' EXIT

RUN_NAMES=()

for i in $(seq 1 "$REPEATS"); do
  RUN_NAME="${BASE_NAME}-r$(printf '%02d' "$i")"
  RUN_NAMES+=("$RUN_NAME")

  echo "------------------------------------------------------------"
  echo "Run $i/$REPEATS — $RUN_NAME"
  echo "------------------------------------------------------------"

  "$SCRIPT_DIR/benchmark-preflight.sh"
  "$SCRIPT_DIR/benchmark-create.sh" "$RUN_NAME" "$TOTAL_PRS"
  node "$SCRIPT_DIR/wait-for-run.js" "$RUN_NAME" \
    --interval-sec "$INTERVAL_SEC" \
    --timeout-min "$TIMEOUT_MIN"

  "$SCRIPT_DIR/benchmark-evaluate.sh" "$RUN_NAME"

  if [ "$EXPORT_TRACES" = "true" ]; then
    node "$SCRIPT_DIR/export-trace-metrics.js" "$RUN_NAME" --output-dir "$SUITE_DIR" || true
  fi
done

echo ""
echo "▸ Aggregating run results..."
node "$SCRIPT_DIR/analyze-runs.js" "${RUN_NAMES[@]}" --output-dir "$SUITE_DIR"

cat > "$SUITE_DIR/suite.json" <<EOF
{
  "baseName": "$BASE_NAME",
  "generatedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "totalPrs": $TOTAL_PRS,
  "repeats": $REPEATS,
  "focusFile": "$PR_LIST_FILE",
  "intervalSec": $INTERVAL_SEC,
  "timeoutMin": $TIMEOUT_MIN,
  "runs": [
$(printf '    "%s"%s\n' "${RUN_NAMES[@]}" | sed '$ ! s/$/,/')
  ]
}
EOF

echo ""
echo "Suite completed."
echo "Results:"
echo "  $SUITE_DIR"
