#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Load API key from project .env if not already set
REPO_ROOT="$(cd ../.. && pwd)"
if [ -z "${GEMINI_API_KEY:-}" ] && [ -f "$REPO_ROOT/.env" ]; then
    GEMINI_API_KEY=$(grep '^API_GOOGLE_AI_API_KEY=' "$REPO_ROOT/.env" | cut -d'=' -f2-)
    export GEMINI_API_KEY
    echo "=== Loaded GEMINI_API_KEY from .env ==="
fi

# Step 1: Auto-enrich rationales (planner originals → content-aware via Gemini Flash)
echo "=== Step 1: Enriching FP rationales ==="
node enrich-fp-rationales.js

# Step 2: Convert dataset to promptfoo format
echo ""
echo "=== Step 2: Converting dataset ==="
node convert-dataset.js --dataset-type=false_positives

# Step 3: Run FP eval
echo ""
echo "=== Step 3: Running FP eval ==="
npx promptfoo eval -c promptfoo-fp-quick.yaml --no-cache "$@"

echo ""
echo "=== Done ==="
