#!/bin/bash

# Run the cross-file context planner eval with promptfoo.
#
# Usage:
#   ./evals/cross-file/planner-run-eval.sh
#   ./evals/cross-file/planner-run-eval.sh --limit=5
#   ./evals/cross-file/planner-run-eval.sh --no-cache

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Load API keys from .env
ENV_FILE="$PROJECT_ROOT/.env"

extract_env() {
    grep "^$1=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d'=' -f2- | tr -d '"' | tr -d "'"
}

export GOOGLE_API_KEY="$(extract_env API_GOOGLE_AI_API_KEY)"

# Separate our args from promptfoo args
CONVERT_ARGS=()
PROMPTFOO_ARGS=()
for arg in "$@"; do
    if [[ "$arg" == --limit=* ]]; then
        CONVERT_ARGS+=("$arg")
    else
        PROMPTFOO_ARGS+=("$arg")
    fi
done

cd "$SCRIPT_DIR"
mkdir -p results

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  Cross-File Context Planner Eval"
echo "═══════════════════════════════════════════════════════"
echo ""

# Step 1: Convert dataset
node planner-convert-dataset.js "${CONVERT_ARGS[@]}"

# Step 2: Run promptfoo eval
npx promptfoo eval -c promptfoo-planner.yaml -o results/planner-output.json "${PROMPTFOO_ARGS[@]}"

echo ""
echo "Done. Results saved to results/planner-output.json"
