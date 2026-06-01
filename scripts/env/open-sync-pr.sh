#!/usr/bin/env bash
# Opens a PR with the regenerated env files. Called from env-sync-release.yml.
#
# Usage: open-sync-pr.sh <repo-name> <file-path> [<file-path>...]
# Env:   TAG  — release tag (e.g. selfhosted-2.1.9)
#        SHA  — kodus-ai commit sha
#        GH_TOKEN — PAT with PR-create on the target repo
#
# Exits 0 (no-op) when there is no drift on any file, so the workflow stays green.

set -euo pipefail

repo="$1"
shift
files=("$@")
branch="env-sync/${TAG}"

git config user.name  "kodus-env-sync[bot]"
git config user.email "kodus-env-sync@users.noreply.github.com"

if git diff --quiet -- "${files[@]}"; then
    echo "No drift in $repo. Skipping PR."
    exit 0
fi

# -B (force) so reruns of the same tag (workflow_dispatch, retries) reset
# the branch instead of erroring "branch already exists".
git checkout -B "$branch"
git add -- "${files[@]}"
git commit -m "chore(env): sync from kodus-ai@${TAG}

Auto-generated from kodus-ai/.env.schema at ${SHA}.
Source: https://github.com/kodustech/kodus-ai/tree/${SHA}/.env.schema"
# --force so the same branch can be updated on reruns without manual cleanup.
git push -u --force origin "$branch"

# If a PR is already open for this branch, update its body instead of failing.
existing_pr=$(gh pr list --head "$branch" --state open --json number --jq '.[0].number' 2>/dev/null || echo "")
if [ -n "$existing_pr" ]; then
    echo "PR #${existing_pr} already exists for ${branch}; refreshing body."
    gh pr edit "$existing_pr" \
        --body "Auto-generated from \`kodus-ai/.env.schema\` at tag \`${TAG}\` ([\`${SHA:0:7}\`](https://github.com/kodustech/kodus-ai/tree/${SHA}/.env.schema)).

Review the diff — added/removed vars and changed defaults reflect schema edits in kodus-ai.

Approve to keep \`${repo}\` in sync with this release cut."
else
    gh pr create \
        --title "chore(env): sync from kodus-ai@${TAG}" \
        --label automated,env-sync \
        --body "Auto-generated from \`kodus-ai/.env.schema\` at tag \`${TAG}\` ([\`${SHA:0:7}\`](https://github.com/kodustech/kodus-ai/tree/${SHA}/.env.schema)).

Review the diff — added/removed vars and changed defaults reflect schema edits in kodus-ai.

Approve to keep \`${repo}\` in sync with this release cut."
fi
