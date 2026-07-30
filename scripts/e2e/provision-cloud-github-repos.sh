#!/usr/bin/env bash
# Provision the per-tenant cloud GitHub fixture repos used by the E2E
# matrix. Each cloud GitHub PAT tenant runs on its OWN repo (1 org : 1
# repo) so a single PR webhook never fans out across multiple Kodus orgs
# — the root cause of the flaky "review pipeline never started" failures
# on cloud × github cells. See tests/e2e/cli/cloud/setup-tenants.ts.
#
# Idempotent: a repo that already exists is left as-is unless
# --force-content is passed, in which case its default branch is
# re-mirrored from the base repo.
#
# Required env:
#   GH_TEST_TOKEN        PAT with `repo` + repo-creation rights in the
#                        target org (kodus-e2e). Same token the matrix uses.
# Optional env:
#   BASE_REPO            owner/name to mirror content from
#                        (default: ${GH_TEST_REPO_CLOUD:-kodus-e2e/tiny-url-cloud})
#   REPO_OWNER           org/user to create repos under (default: kodus-e2e)
#   REPO_VISIBILITY      private | public (default: private)
#
# Usage:
#   GH_TEST_TOKEN=... ./scripts/e2e/provision-cloud-github-repos.sh
#   GH_TEST_TOKEN=... ./scripts/e2e/provision-cloud-github-repos.sh --force-content
set -euo pipefail

FORCE_CONTENT=0
[ "${1:-}" = "--force-content" ] && FORCE_CONTENT=1

: "${GH_TEST_TOKEN:?set GH_TEST_TOKEN (PAT with repo + create rights in the target org)}"
BASE_REPO="${BASE_REPO:-${GH_TEST_REPO_CLOUD:-kodus-e2e/tiny-url-cloud}}"
REPO_OWNER="${REPO_OWNER:-kodus-e2e}"
REPO_VISIBILITY="${REPO_VISIBILITY:-private}"
API="https://api.github.com"
AUTH=(-H "Authorization: Bearer ${GH_TEST_TOKEN}" -H "Accept: application/vnd.github+json")

# MUST mirror the repoFullName values in tests/e2e/cli/cloud/setup-tenants.ts
TARGET_REPOS=(
    "${REPO_OWNER}/tiny-url-cloud-paid"
    "${REPO_OWNER}/tiny-url-cloud-free"
    "${REPO_OWNER}/tiny-url-cloud-trial"
    "${REPO_OWNER}/tiny-url-cloud-community"
    "${REPO_OWNER}/tiny-url-cloud-stripe-free"
    "${REPO_OWNER}/tiny-url-cloud-stripe-trial"
)

say() { printf '\033[0;34m[provision]\033[0m %s\n' "$*"; }
ok()  { printf '\033[0;32m[ok]\033[0m        %s\n' "$*"; }
err() { printf '\033[0;31m[err]\033[0m       %s\n' "$*" >&2; }

repo_exists() {
    local full="$1"
    local code
    code=$(curl -sS -o /dev/null -w '%{http_code}' "${AUTH[@]}" "${API}/repos/${full}")
    [ "$code" = "200" ]
}

create_repo() {
    local full="$1" owner="${1%%/*}" name="${1##*/}"
    local priv="true"; [ "$REPO_VISIBILITY" = "public" ] && priv="false"
    # Try org endpoint first; fall back to user endpoint if owner is the token's user.
    local code
    code=$(curl -sS -o /tmp/.gh_create.json -w '%{http_code}' "${AUTH[@]}" \
        -X POST "${API}/orgs/${owner}/repos" \
        -d "{\"name\":\"${name}\",\"private\":${priv},\"auto_init\":false,\"has_issues\":false,\"has_projects\":false,\"has_wiki\":false}")
    if [ "$code" = "201" ]; then return 0; fi
    code=$(curl -sS -o /tmp/.gh_create.json -w '%{http_code}' "${AUTH[@]}" \
        -X POST "${API}/user/repos" \
        -d "{\"name\":\"${name}\",\"private\":${priv},\"auto_init\":false}")
    if [ "$code" = "201" ]; then return 0; fi
    err "create ${full} failed (HTTP ${code}): $(head -c 300 /tmp/.gh_create.json)"
    return 1
}

mirror_default_branch() {
    # Push the BASE_REPO default branch into the target so the fixture
    # content (the tiny-url app the scenarios diff against) is identical.
    local target="$1"
    local tmp
    tmp="$(mktemp -d)"
    git clone --quiet --bare "https://x-access-token:${GH_TEST_TOKEN}@github.com/${BASE_REPO}.git" "${tmp}/base.git"
    git -C "${tmp}/base.git" push --quiet --mirror "https://x-access-token:${GH_TEST_TOKEN}@github.com/${target}.git" \
        2>/dev/null || git -C "${tmp}/base.git" push --quiet \
        "https://x-access-token:${GH_TEST_TOKEN}@github.com/${target}.git" 'HEAD'
    rm -rf "${tmp}"
}

say "base repo (content source): ${BASE_REPO}"
say "owner: ${REPO_OWNER} | visibility: ${REPO_VISIBILITY} | force-content: ${FORCE_CONTENT}"
repo_exists "$BASE_REPO" || { err "base repo ${BASE_REPO} not reachable with this token"; exit 1; }

created=0; mirrored=0; skipped=0
for full in "${TARGET_REPOS[@]}"; do
    if repo_exists "$full"; then
        if [ "$FORCE_CONTENT" = "1" ]; then
            say "${full} exists — re-mirroring content (--force-content)"
            mirror_default_branch "$full"; mirrored=$((mirrored+1))
        else
            ok "${full} already exists — skipping"; skipped=$((skipped+1))
        fi
        continue
    fi
    say "creating ${full}"
    create_repo "$full"
    say "mirroring content into ${full}"
    mirror_default_branch "$full"
    ok "${full} ready"
    created=$((created+1))
done

echo
ok "done — created=${created} mirrored=${mirrored} skipped=${skipped}"
echo "Next: re-seed tenants so each connects its dedicated repo (type:replace"
echo "moves it off the shared repo):  pnpm run cloud:setup-tenants"
