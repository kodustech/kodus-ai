#!/usr/bin/env bash
set -eo pipefail

# Fork benchmark repos into a target GitHub org, preserving ALL branches.
#
# Usage:
#   ./fork-benchmark-repos.sh [OPTIONS] <target-org>
#
# Options:
#   --http       Use standard git commands over HTTPS (Default)
#   --ssh        Use standard git commands over SSH
#   --api, --gh  Use GitHub API (gh CLI) to sync branches (no git clone required)
#
# Example:
#   ./fork-benchmark-repos.sh my-company
#   ./fork-benchmark-repos.sh --ssh my-company
#   ./fork-benchmark-repos.sh --api my-company

SOURCE_ORG="ai-code-review-evaluation"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Parse arguments
SYNC_METHOD="http"
TARGET_ORG=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --ssh)
            SYNC_METHOD="ssh"
            shift
            ;;
        --http)
            SYNC_METHOD="http"
            shift
            ;;
        --api|--gh)
            SYNC_METHOD="api"
            shift
            ;;
        -h|--help)
            grep "^#" "$0" | grep -v "^#!/usr/bin/env bash"
            exit 0
            ;;
        *)
            if [[ -z "$TARGET_ORG" ]]; then
                TARGET_ORG="$1"
            else
                echo "Unknown argument: $1"
                echo "Usage: $0 [--http | --ssh | --api] <target-org>"
                exit 1
            fi
            shift
            ;;
    esac
done

if [[ -z "$TARGET_ORG" ]]; then
    echo "Usage: $0 [--http | --ssh | --api] <target-org>"
    exit 1
fi

# source-repo:target-name pairs
REPOS="sentry-greptile:sentry
cal.com-greptile:cal.com
grafana-greptile:grafana-codex
keycloak-greptile:keycloak
discourse-greptile:discourse-cursor"

echo "Forking benchmark repos into ${TARGET_ORG}"
echo "   Sync Method: ${SYNC_METHOD^^}"

# Only set up a temporary directory if we are actually using git
if [[ "$SYNC_METHOD" != "api" ]]; then
    WORKDIR=$(mktemp -d)
    trap '[[ -n "$WORKDIR" ]] && rm -rf "$WORKDIR"' EXIT
    echo "   Working directory: ${WORKDIR}"
fi
echo ""

echo "$REPOS" | while IFS=: read -r SRC_REPO TARGET_NAME; do
    SRC_FULL="${SOURCE_ORG}/${SRC_REPO}"
    TARGET_FULL="${TARGET_ORG}/${TARGET_NAME}"

    echo "-------------------------------------------"
    echo "${SRC_FULL} -> ${TARGET_FULL}"
    echo ""

    # 1. Check if fork already exists; if not, create it
    if gh repo view "$TARGET_FULL" &>/dev/null; then
        echo "   ${TARGET_FULL} already exists, syncing branches..."
    else
        echo "   Creating fork..."

        TARGET_TYPE=$(gh api "users/${TARGET_ORG}" --jq '.type' 2>/dev/null || echo "User")

        # Capture and display any errors during the fork process
        if [[ "$TARGET_TYPE" == "Organization" ]]; then
            if ! fork_err=$(gh repo fork "$SRC_FULL" --org "$TARGET_ORG" --fork-name "$TARGET_NAME" --clone=false 2>&1); then
                echo "   ⚠️ Warning during fork:"
                echo "$fork_err" | sed 's/^/      /'
            fi
        else
            if ! fork_err=$(gh repo fork "$SRC_FULL" --fork-name "$TARGET_NAME" --clone=false 2>&1); then
                echo "   ⚠️ Warning during fork:"
                echo "$fork_err" | sed 's/^/      /'
            fi
        fi

        echo "   Fork created"
        echo "   Waiting for fork to be ready..."
        for i in $(seq 1 30); do
            if gh repo view "$TARGET_FULL" &>/dev/null; then break; fi
            sleep 2
        done

        # Give GitHub an extra few seconds to finish initializing the refs internally if using API
        if [[ "$SYNC_METHOD" == "api" ]]; then sleep 3; fi
    fi

    # 2. Sync branches and tags based on the selected method
    if [[ "$SYNC_METHOD" == "api" ]]; then
        # ==========================================
        # GITHUB API SYNC METHOD
        # ==========================================

        echo "   Syncing tags via API..."
        gh api --paginate "repos/$SRC_FULL/tags" --jq '.[] | "\(.name) \(.commit.sha)"' | while read -r name sha; do
            if ! gh api --method PATCH "repos/$TARGET_FULL/git/refs/tags/$name" -f sha="$sha" -F force=true --silent 2>/dev/null; then
                if ! create_err=$(gh api --method POST "repos/$TARGET_FULL/git/refs" -f ref="refs/tags/$name" -f sha="$sha" --silent 2>&1); then
                    echo "      ⚠️ Failed to sync tag $name"
                    echo "$create_err" | sed 's/^/         /'
                fi
            fi
        done

        echo "   Syncing branches via API..."
        gh api --paginate "repos/$SRC_FULL/branches" --jq '.[] | "\(.name) \(.commit.sha)"' | while read -r branch sha; do
            echo "      Pushing $branch..."
            if ! gh api --method PATCH "repos/$TARGET_FULL/git/refs/heads/$branch" -f sha="$sha" -F force=true --silent 2>/dev/null; then
                if ! create_err=$(gh api --method POST "repos/$TARGET_FULL/git/refs" -f ref="refs/heads/$branch" -f sha="$sha" --silent 2>&1); then
                    echo "      ⚠️ Failed to sync branch $branch"
                    echo "$create_err" | sed 's/^/         /'
                fi
            fi
        done

    else
        # ==========================================
        # GIT (HTTP or SSH) SYNC METHOD
        # ==========================================

        # Determine Git URLs based on protocol choice
        if [[ "$SYNC_METHOD" == "ssh" ]]; then
            SRC_URL="git@github.com:${SRC_FULL}.git"
            TARGET_URL="git@github.com:${TARGET_FULL}.git"
        else
            SRC_URL="https://github.com/${SRC_FULL}.git"
            TARGET_URL="https://github.com/${TARGET_FULL}.git"
        fi

        echo "   Cloning source repo..."
        CLONE_DIR="${WORKDIR}/${TARGET_NAME}"

        if ! clone_err=$(git clone --bare "$SRC_URL" "$CLONE_DIR" 2>&1 >/dev/null); then
            echo "   ❌ Failed to clone $SRC_URL"
            echo "$clone_err" | sed 's/^/      /'
            echo "   Skipping to next repository..."
            echo ""
            continue
        fi

        BRANCH_COUNT=$(git -C "$CLONE_DIR" branch -a | wc -l | tr -d ' ')
        echo "   Found ${BRANCH_COUNT} branches"

        echo "   Pushing branches to fork (one by one to avoid GitHub workflow timeouts)..."
        git -C "$CLONE_DIR" remote add fork "$TARGET_URL"

        if ! tags_err=$(git -C "$CLONE_DIR" push fork --tags --force 2>&1 >/dev/null); then
            echo "   ⚠️ Failed to push tags:"
            echo "$tags_err" | sed 's/^/      /'
        fi

        for branch in $(git -C "$CLONE_DIR" branch -a | grep -v HEAD | sed 's|^\* ||' | sed 's|^ *||'); do
            clean_branch=$(echo "$branch" | sed 's|^refs/heads/||')
            echo "      Pushing $clean_branch..."

            if ! push_err=$(git -C "$CLONE_DIR" push fork "$clean_branch:$clean_branch" --force 2>&1 >/dev/null); then
                echo "      ⚠️ Failed to push $clean_branch"
                echo "$push_err" | sed 's/^/         /'
            fi
        done
    fi

    echo "   Done: https://github.com/${TARGET_FULL}"
    echo ""
done

echo "-------------------------------------------"
echo "All repos forked and synced!"
echo ""

# Generate/Update prs.json with the target org
PRS_FILE="${SCRIPT_DIR}/prs.json"

if [[ -f "$PRS_FILE" ]]; then
    echo "Updating existing prs.json to use org '${TARGET_ORG}'..."
    TMP_JSON=$(mktemp)
    sed -E "s|\"repo\": \"[^/]+/|\"repo\": \"${TARGET_ORG}/|g" "$PRS_FILE" > "$TMP_JSON"
    mv "$TMP_JSON" "$PRS_FILE"

    PR_COUNT=$(grep -c '"head"' "$PRS_FILE")
    echo "Updated prs.json (${PR_COUNT} PRs pointing to ${TARGET_ORG})"
else
    echo "WARNING: prs.json not found. Please create it manually."
fi

echo ""
echo "Ready! Run './create-test-prs.mjs' to create the benchmark PRs."
