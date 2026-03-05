#!/bin/bash
set -e
cd "$(dirname "$0")"

echo "=== Feature Extraction + Triage Pipeline Eval ==="

# Step 1: Convert discard dataset
echo ""
echo "--- Converting discard dataset ---"
node convert-dataset-features.js --dataset=discard

# Step 2: Run discard eval
echo ""
echo "--- Running discard eval ---"
npx promptfoo eval -c promptfoo-features-discard.yaml --no-table

# Step 3: Convert no_changes dataset
echo ""
echo "--- Converting no_changes dataset ---"
node convert-dataset-features.js --dataset=no_changes

# Step 4: Run no_changes eval
echo ""
echo "--- Running no_changes eval ---"
npx promptfoo eval -c promptfoo-features-nochanges.yaml --no-table

echo ""
echo "=== Done ==="
