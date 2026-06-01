#!/usr/bin/env bash
set -euo pipefail

# Reset benchmark forks in a target GitHub org.
#
# Usage:
#   ./reset-benchmark-forks.sh <target-org>
#
# Example:
#   ./reset-benchmark-forks.sh ai-code-review-benchmark

if [[ -z "${1:-}" ]]; then
    echo "Usage: $0 <target-org>"
    exit 1
fi

TARGET_ORG="$1"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

REPOS=(
    "sentry"
    "grafana-codex"
    "discourse-cursor"
    "cal.com"
    "keycloak"
)

echo "============================================================"
echo "Reset Benchmark Forks"
echo "============================================================"
echo "Target org: $TARGET_ORG"
echo ""

echo "▸ Closing open PRs..."
node "$SCRIPT_DIR/close-all-prs.mjs" "$TARGET_ORG"
echo ""

echo "▸ Deleting existing fork repos..."
for repo in "${REPOS[@]}"; do
    full_repo="${TARGET_ORG}/${repo}"
    if gh repo view "$full_repo" >/dev/null 2>&1; then
        echo "  Deleting $full_repo..."
        gh repo delete "$full_repo" --yes
    else
        echo "  Skipping $full_repo (not found)"
    fi
done
echo ""

echo "▸ Waiting for GitHub deletion to settle..."
sleep 10
echo ""

echo "▸ Recreating forks..."
"$SCRIPT_DIR/fork-benchmark-repos.sh" "$TARGET_ORG"
echo ""

echo "Done."
