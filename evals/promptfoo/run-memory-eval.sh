#!/bin/bash

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ENV_FILE="$PROJECT_ROOT/.env"

extract_env() {
    grep "^$1=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d'=' -f2- | tr -d '"' | tr -d "'"
}

export OPENAI_API_KEY="$(extract_env API_OPEN_AI_API_KEY)"
export ANTHROPIC_API_KEY="$(extract_env API_ANTHROPIC_API_KEY)"
export GOOGLE_API_KEY="$(extract_env API_GOOGLE_AI_API_KEY)"
export OPENROUTER_API_KEY="$(extract_env API_OPENROUTER_KEY)"

CONVERT_ARGS=()
PROMPTFOO_ARGS=()

for arg in "$@"; do
    if [[ "$arg" == --dataset=* ]] || [[ "$arg" == --limit=* ]]; then
        CONVERT_ARGS+=("$arg")
    else
        PROMPTFOO_ARGS+=("$arg")
    fi
done

cd "$SCRIPT_DIR"
cd "$PROJECT_ROOT/packages/kodus-flow"
node --loader ts-node/esm "$PROJECT_ROOT/evals/promptfoo/generate-memory-prompt.js"

cd "$SCRIPT_DIR"
node convert-memory-dataset.js "${CONVERT_ARGS[@]}"

npx promptfoo eval -c promptfoo.memory.yaml -j 10 "${PROMPTFOO_ARGS[@]}"
