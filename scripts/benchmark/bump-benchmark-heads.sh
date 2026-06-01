#!/bin/bash
#
# Bumps the HEAD of benchmark branches with an empty commit (same tree).
# This changes head_sha so GitHub allows creating a new PR (100-PR-per-head_sha cap).
#
# Usage:
#   ./bump-benchmark-heads.sh              # bump every branch in prs.json
#   TOTAL_PRS=5 ./bump-benchmark-heads.sh  # bump only the branches that will be
#                                          # selected for this run (same logic as
#                                          # create-test-prs.mjs: evenly per repo)
#
# Requires `gh` authenticated with push access on ai-code-review-benchmark/*.
#
# Important: bumping branches that have open orphan PRs (e.g. leftovers from
# previous runs whose head branch was not cleaned up) fires a `synchronize`
# webhook and triggers a spurious review. Passing TOTAL_PRS here mirrors the
# create-test-prs selection so we only touch the branches we actually need.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
PRS_JSON="$REPO_DIR/scripts/pr-creator/prs.json"

if [ ! -f "$PRS_JSON" ]; then
  echo "prs.json not found at $PRS_JSON"
  exit 1
fi

AUTHOR_NAME="${BENCHMARK_BUMP_AUTHOR_NAME:-Kodus Benchmark Bot}"
AUTHOR_EMAIL="${BENCHMARK_BUMP_AUTHOR_EMAIL:-benchmark-bot@kodus.io}"

if [ -n "${TOTAL_PRS:-}" ]; then
  echo "▸ Bumping HEAD of benchmark branches (TOTAL_PRS=$TOTAL_PRS, same selection as create-test-prs)..."
else
  echo "▸ Bumping HEAD of all benchmark branches (no TOTAL_PRS limit)..."
fi

# Emit "repo|branch" pairs for the selected subset, mirroring create-test-prs.mjs:
# group by repo, take ceil(limit/repos) per repo, then slice first `limit`.
PAIRS=$(TOTAL_PRS="${TOTAL_PRS:-}" node -e "
const fs = require('fs');
const d = JSON.parse(fs.readFileSync('$PRS_JSON','utf8'));
const prs = Array.isArray(d) ? d : d.prs;

// Deduplicate (repo, head) pairs while preserving order.
const uniq = [];
const seen = new Set();
for (const p of prs) {
  const k = p.repo + '|' + p.head;
  if (seen.has(k)) continue;
  seen.add(k);
  uniq.push(p);
}

const limit = parseInt(process.env.TOTAL_PRS || '0', 10);
let selected = uniq;
if (limit > 0 && limit < uniq.length) {
  const byRepo = {};
  for (const p of uniq) {
    (byRepo[p.repo] = byRepo[p.repo] || []).push(p);
  }
  const repos = Object.keys(byRepo);
  const perRepo = Math.ceil(limit / repos.length);
  const picked = [];
  for (const r of repos) picked.push(...byRepo[r].slice(0, perRepo));
  selected = picked.slice(0, limit);
}

for (const p of selected) process.stdout.write(p.repo + '|' + p.head + '\n');
")

TOTAL=$(printf '%s\n' "$PAIRS" | grep -c '|' || true)
OK=0
FAIL=0
SKIPPED=0
IDX=0

while IFS='|' read -r REPO BRANCH; do
  [ -z "$REPO" ] && continue
  IDX=$((IDX + 1))

  # Defensive: if the branch still has an open PR, skip the bump. Pushing
  # an empty commit would fire a `synchronize` webhook and trigger a
  # spurious review (we already saw this double the queue depth on runs
  # where benchmark-create.sh's close step did not fully propagate).
  OWNER="${REPO%%/*}"
  OPEN_COUNT=$(gh api "repos/$REPO/pulls?state=open&head=$OWNER:$BRANCH&per_page=1" --jq 'length' 2>/dev/null || echo "0")
  if [ "${OPEN_COUNT:-0}" -gt 0 ]; then
    echo "  [$IDX/$TOTAL] ⊘ $REPO#$BRANCH — skipped (PR still open, bump would fire synchronize)"
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  # 1. Get current ref SHA. When the branch doesn't exist gh prints a 404
  # JSON body on stdout AND exits non-zero; --jq on an error body returns
  # empty and falls through to the `|| echo ""` guard. Validate the shape
  # of REF_SHA so a missing branch produces an accurate "ref not found"
  # instead of tripping the tree lookup with a garbage SHA.
  REF_SHA=$(gh api "repos/$REPO/git/ref/heads/$BRANCH" --jq '.object.sha' 2>/dev/null || echo "")
  if [ -z "$REF_SHA" ] || ! [[ "$REF_SHA" =~ ^[0-9a-f]{40}$ ]]; then
    echo "  [$IDX/$TOTAL] ✗ $REPO#$BRANCH — ref not found"
    FAIL=$((FAIL + 1))
    continue
  fi

  # 2. Get the commit's tree SHA
  TREE_SHA=$(gh api "repos/$REPO/git/commits/$REF_SHA" --jq '.tree.sha' 2>/dev/null || echo "")
  if [ -z "$TREE_SHA" ] || ! [[ "$TREE_SHA" =~ ^[0-9a-f]{40}$ ]]; then
    echo "  [$IDX/$TOTAL] ✗ $REPO#$BRANCH — tree not found (commit $REF_SHA)"
    FAIL=$((FAIL + 1))
    continue
  fi

  # 3. Create a new commit pointing at the same tree (empty commit)
  MSG="bench: bump head $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  NEW_SHA=$(gh api "repos/$REPO/git/commits" \
    -f "message=$MSG" \
    -f "tree=$TREE_SHA" \
    -f "parents[]=$REF_SHA" \
    -f "author[name]=$AUTHOR_NAME" \
    -f "author[email]=$AUTHOR_EMAIL" \
    --jq '.sha' 2>/dev/null || echo "")
  if [ -z "$NEW_SHA" ]; then
    echo "  [$IDX/$TOTAL] ✗ $REPO#$BRANCH — failed to create commit"
    FAIL=$((FAIL + 1))
    continue
  fi

  # 4. Update ref to new commit
  if gh api "repos/$REPO/git/refs/heads/$BRANCH" -X PATCH -f "sha=$NEW_SHA" --silent 2>/dev/null; then
    echo "  [$IDX/$TOTAL] ✓ $REPO#$BRANCH ${REF_SHA:0:7} → ${NEW_SHA:0:7}"
    OK=$((OK + 1))
  else
    echo "  [$IDX/$TOTAL] ✗ $REPO#$BRANCH — failed to update ref"
    FAIL=$((FAIL + 1))
  fi
done <<< "$PAIRS"

echo "  ✓ Bumped $OK/$TOTAL branches ($FAIL failed, $SKIPPED skipped due to open PRs)"

# Only hard-fail if nothing bumped AND nothing was skipped — skips are fine
# (branch already has a PR queued for review, no need to bump it).
if [ "$OK" -eq 0 ] && [ "$SKIPPED" -eq 0 ]; then
  exit 1
fi
