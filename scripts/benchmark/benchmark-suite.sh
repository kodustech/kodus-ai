#!/bin/bash
#
# Run the same benchmark configuration sequentially multiple times.
#
# Usage:
#   ./benchmark-suite.sh <base-name> [TOTAL_PRS] [REPEATS]
#   ./benchmark-suite.sh gemini-control 10 5
#
set -euo pipefail

if [ -z "${1:-}" ]; then
  echo "Usage: ./benchmark-suite.sh <base-name> [TOTAL_PRS] [REPEATS]"
  echo ""
  echo "Examples:"
  echo "  ./benchmark-suite.sh gemini-control 10 5"
  echo "  ./benchmark-suite.sh kimi-baseline 20 3"
  exit 1
fi

BASE_NAME="$1"
TOTAL_PRS="${2:-10}"
REPEATS="${3:-3}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
STAMP="$(date +%Y%m%d-%H%M%S)"
SUITE_DIR="$SCRIPT_DIR/results/suites/${BASE_NAME}-${STAMP}"
INTERVAL_SEC="${BENCHMARK_WAIT_INTERVAL_SEC:-20}"
TIMEOUT_MIN="${BENCHMARK_WAIT_TIMEOUT_MIN:-90}"
EXTRACT_ONLY="${BENCHMARK_EXTRACT_ONLY:-false}"
EXPORT_TRACES="${BENCHMARK_EXPORT_TRACES:-true}"

mkdir -p "$SUITE_DIR"

echo "============================================================"
echo "Benchmark Suite"
echo "============================================================"
echo "Base name: $BASE_NAME"
echo "PRs:       $TOTAL_PRS"
echo "Repeats:   $REPEATS"
echo "Wait:      interval=${INTERVAL_SEC}s timeout=${TIMEOUT_MIN}m"
echo "Suite dir: $SUITE_DIR"
echo ""

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

  if [ "$EXTRACT_ONLY" = "true" ]; then
    "$SCRIPT_DIR/benchmark-evaluate.sh" "$RUN_NAME" --extract-only
  else
    "$SCRIPT_DIR/benchmark-evaluate.sh" "$RUN_NAME"
  fi

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
