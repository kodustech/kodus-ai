#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# 1. Convert dataset (replaces enriched rationales with original planner-style ones)
echo "=== Converting enrichment dataset ==="
node enrichment-convert-dataset.js

# 2. Set API key from project .env if not already set
if [ -z "${GEMINI_API_KEY:-}" ]; then
    REPO_ROOT="$(cd ../.. && pwd)"
    if [ -f "$REPO_ROOT/.env" ]; then
        GEMINI_API_KEY=$(grep '^API_GOOGLE_AI_API_KEY=' "$REPO_ROOT/.env" | cut -d'=' -f2-)
        export GEMINI_API_KEY
        echo "=== Loaded GEMINI_API_KEY from .env ==="
    fi
fi

# 3. Run promptfoo eval
echo "=== Running enrichment eval ==="
npx promptfoo eval -c promptfoo-enrichment.yaml --no-cache "$@"

echo "=== Done ==="
