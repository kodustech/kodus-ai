#!/usr/bin/env bash
#
# import-repos-to-azure.sh
#
# Mirrors the 5 benchmark fork repos from GitHub to Azure DevOps,
# preserving every branch, tag, and SHA (byte-for-byte via --mirror).
#
# Idempotent: if the Azure repo already exists, the script skips the
# create step and just pushes/refreshes the mirror.
#
# Requires:
#   - az CLI + azure-devops extension
#   - git
#   - AZURE_DEVOPS_TOKEN env var (PAT with Code read/write + PR read/write)
#
# Usage:
#   AZURE_ORG=myorg AZURE_PROJECT=ai-code-review-benchmark \
#   AZURE_DEVOPS_TOKEN=<pat> \
#     ./scripts/benchmark/import-repos-to-azure.sh
#
#   Optional:
#     GITHUB_OWNER=Wellington01            (default)
#     WORKDIR=./tmp/benchmark-import       (default; cloned mirrors live here)
#     SKIP_VALIDATE=1                      (skip SHA spot-check after push)
#
# Does NOT touch the GitHub source repos. Read-only on GitHub side.

set -euo pipefail

# ---------- args / env ----------

AZURE_ORG="${AZURE_ORG:-}"
AZURE_PROJECT="${AZURE_PROJECT:-}"
GITHUB_OWNER="${GITHUB_OWNER:-Wellington01}"
WORKDIR="${WORKDIR:-./tmp/benchmark-import}"
SKIP_VALIDATE="${SKIP_VALIDATE:-0}"

if [ -z "$AZURE_ORG" ] || [ -z "$AZURE_PROJECT" ]; then
    echo "ERROR: AZURE_ORG and AZURE_PROJECT are required."
    echo ""
    echo "Example:"
    echo "  AZURE_ORG=myorg AZURE_PROJECT=ai-code-review-benchmark \\"
    echo "    AZURE_DEVOPS_TOKEN=<pat> $0"
    exit 1
fi

if [ -z "${AZURE_DEVOPS_TOKEN:-}" ]; then
    echo "ERROR: AZURE_DEVOPS_TOKEN env var is required (PAT with Code+PR write)."
    exit 1
fi

# Tell az CLI to use the PAT non-interactively
export AZURE_DEVOPS_EXT_PAT="$AZURE_DEVOPS_TOKEN"
# Pre-compute the Authorization header git will send on push
AZ_AUTH_HEADER="Authorization: Basic $(printf ':%s' "$AZURE_DEVOPS_TOKEN" | base64 | tr -d '\n')"

REPOS=(
    "sentry-greptile"
    "grafana-greptile"
    "discourse-greptile"
    "cal.com-greptile"
    "keycloak-greptile"
)

AZURE_BASE="https://dev.azure.com/${AZURE_ORG}/${AZURE_PROJECT}/_git"

mkdir -p "$WORKDIR"
echo "🪜  Workdir: $WORKDIR"
echo "🪜  Azure target: $AZURE_BASE"
echo ""

# ---------- prerequisites ----------

command -v az >/dev/null || {
    echo "ERROR: az CLI not installed. brew install azure-cli"; exit 1;
}
az extension show --name azure-devops >/dev/null 2>&1 || {
    echo "Installing azure-devops extension..."
    az extension add --name azure-devops
}
command -v git >/dev/null || { echo "ERROR: git missing"; exit 1; }

# Configure default org/project for az (silences --organization on every call)
az devops configure --defaults \
    organization="https://dev.azure.com/${AZURE_ORG}" \
    project="${AZURE_PROJECT}" >/dev/null

echo "✅ az CLI ready (org=$AZURE_ORG, project=$AZURE_PROJECT)"
echo ""

# ---------- per-repo ----------

for REPO in "${REPOS[@]}"; do
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "📦  $REPO"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

    GH_URL="https://github.com/${GITHUB_OWNER}/${REPO}.git"
    AZ_URL="${AZURE_BASE}/${REPO}"
    LOCAL_MIRROR="${WORKDIR}/${REPO}.git"

    # 1. Mirror clone (or refresh if already cloned)
    if [ -d "$LOCAL_MIRROR" ]; then
        echo "  ↻  Refreshing existing mirror..."
        git -C "$LOCAL_MIRROR" remote update --prune >/dev/null 2>&1
    else
        echo "  ⬇️  Cloning --mirror from GitHub..."
        git clone --mirror "$GH_URL" "$LOCAL_MIRROR" >/dev/null 2>&1
    fi

    # 2. Ensure Azure repo exists (idempotent)
    if az repos show --repository "$REPO" >/dev/null 2>&1; then
        echo "  ℹ️   Azure repo exists — will refresh"
    else
        echo "  ✨  Creating Azure repo..."
        az repos create --name "$REPO" >/dev/null
    fi

    # 3. Push branches and tags to Azure (PAT via http.extraheader)
    # Avoid --mirror because it tries to push refs/pull/* and refs/notes/*
    # which Azure DevOps blocks ("can only be performed by the system").
    # Explicit refspec covers what we need (all branches + all tags), with
    # --force so retries work if something already exists.
    echo "  ⬆️   Pushing branches+tags to Azure..."
    git -C "$LOCAL_MIRROR" remote remove azure >/dev/null 2>&1 || true
    git -C "$LOCAL_MIRROR" remote add azure "$AZ_URL"
    git -C "$LOCAL_MIRROR" \
        -c "http.extraheader=$AZ_AUTH_HEADER" \
        push --force azure \
            'refs/heads/*:refs/heads/*' \
            'refs/tags/*:refs/tags/*' 2>&1 | tail -5

    # 4. Validate SHA preservation (spot-check first branch from prs.json)
    if [ "$SKIP_VALIDATE" != "1" ]; then
        # Pick one branch this repo uses in prs.json
        SAMPLE_BRANCH=$(node -e "
            const p = require('./scripts/pr-creator/prs.json');
            const match = p.prs.find(pr => pr.repo.endsWith('/${REPO}'));
            console.log(match ? match.head : '');
        " 2>/dev/null || echo "")

        if [ -n "$SAMPLE_BRANCH" ]; then
            GH_SHA=$(git -C "$LOCAL_MIRROR" rev-parse "refs/heads/${SAMPLE_BRANCH}" 2>/dev/null || echo "missing")
            AZ_SHA=$(az repos ref list --repository "$REPO" --filter "heads/${SAMPLE_BRANCH}" \
                --query "[0].objectId" -o tsv 2>/dev/null || echo "missing")

            if [ "$GH_SHA" = "$AZ_SHA" ] && [ "$GH_SHA" != "missing" ]; then
                echo "  ✅ SHA match on '${SAMPLE_BRANCH}': ${GH_SHA:0:12}"
            else
                echo "  ⚠️  SHA mismatch on '${SAMPLE_BRANCH}':"
                echo "       GitHub: ${GH_SHA}"
                echo "       Azure:  ${AZ_SHA}"
            fi
        fi
    fi

    echo ""
done

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ Done. ${#REPOS[@]} repos mirrored to ${AZURE_BASE}/<repo>"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "Next:"
echo "  1. Connect the Azure DevOps integration in the benchmark Kodus account"
echo "  2. Generate prs-azure.json:"
echo "       node scripts/benchmark/migrate-prs-to-azure.mjs \\"
echo "         --azure-org=${AZURE_ORG} --azure-project=${AZURE_PROJECT}"
echo "  3. Run benchmark-create.sh --platform=azure 5"
