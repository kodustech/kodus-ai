#!/bin/bash
#
# QA variant of benchmark-create.sh.
#
# Same org, same repos, same PR creation flow — but ZERO local infra touching:
# no preflight, no docker, no postgres/mongo/rabbit cleanup, no worker recreate.
# Intended for a QA environment where the API/worker live remotely and the only
# thing this machine does is talk to GitHub.
#
# Usage:
#   ./benchmark-create-qa.sh <name> [TOTAL_PRS]
#
# Examples:
#   ./benchmark-create-qa.sh qa-smoke 10
#   ./benchmark-create-qa.sh qa-release-check 20
#
set -euo pipefail

if [ -z "${1:-}" ]; then
  echo "Usage: ./benchmark-create-qa.sh <name> [TOTAL_PRS]"
  echo ""
  echo "Examples:"
  echo "  ./benchmark-create-qa.sh qa-smoke 10"
  echo "  ./benchmark-create-qa.sh qa-release-check 20"
  RUNS_DIR="$(cd "$(dirname "$0")" && pwd)/runs"
  if [ -d "$RUNS_DIR" ] && [ "$(ls -A "$RUNS_DIR" 2>/dev/null)" ]; then
    echo ""
    echo "Existing runs:"
    for f in "$RUNS_DIR"/*.json; do
      NAME=$(basename "$f" .json)
      PRS=$(node -e "const d=JSON.parse(require('fs').readFileSync('$f','utf8')); console.log(d.prs.length + ' PRs, created ' + d.created)" 2>/dev/null || echo "?")
      echo "  $NAME — $PRS"
    done
  fi
  exit 1
fi

RUN_NAME="$1"
TOTAL_PRS=${2:-20}
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
RUNS_DIR="$SCRIPT_DIR/runs"
BENCHMARK_OWNER="${BENCHMARK_OWNER:-ai-code-review-benchmark}"
mkdir -p "$RUNS_DIR"

echo "============================================================"
echo "Benchmark (QA) — Create PRs"
echo "============================================================"
echo "Run:   $RUN_NAME | PRs: $TOTAL_PRS"
echo "Owner: $BENCHMARK_OWNER"
echo "Mode:  GitHub-only (no local infra changes)"
echo ""

# Close ALL open PRs in benchmark repos first, then verify they actually
# closed before bumping. If a PR stays open when bump-benchmark-heads pushes
# an empty commit to its head branch, GitHub fires a `synchronize` webhook
# and the remote worker picks up a spurious review — doubling (or worse) the
# number of jobs enqueued for the run.
BENCHMARK_REPOS="${BENCHMARK_REPOS:-sentry grafana-codex discourse-cursor cal.com keycloak}"

echo "▸ Closing all open PRs..."
for repo in $BENCHMARK_REPOS; do
  OPEN_PRS=$(gh api "repos/$BENCHMARK_OWNER/$repo/pulls?state=open&per_page=100" --jq '.[].number' 2>/dev/null || true)
  for pr in $OPEN_PRS; do
    gh api "repos/$BENCHMARK_OWNER/$repo/pulls/$pr" -X PATCH -f state=closed --silent 2>/dev/null || true
  done
  COUNT=$(printf '%s' "$OPEN_PRS" | grep -c '[0-9]' 2>/dev/null || true)
  COUNT=${COUNT:-0}
  [ "$COUNT" -gt 0 ] && echo "  $repo: closed $COUNT PRs"
done

echo "▸ Verifying all PRs are closed (GitHub needs a moment to propagate)..."
CLOSE_TIMEOUT="${BENCHMARK_CLOSE_TIMEOUT_SEC:-60}"
CLOSE_POLL_INTERVAL="${BENCHMARK_CLOSE_POLL_INTERVAL:-5}"
CLOSE_ELAPSED=0
while :; do
  PENDING=""
  for repo in $BENCHMARK_REPOS; do
    STILL_OPEN=$(gh api "repos/$BENCHMARK_OWNER/$repo/pulls?state=open&per_page=100" --jq '.[].number' 2>/dev/null || true)
    if echo "$STILL_OPEN" | grep -q "rate limit"; then
      echo "  ⚠️ Hit GitHub rate limit while checking $repo — assuming PRs are closed"
      continue
    fi
    [ -n "$STILL_OPEN" ] && PENDING="$PENDING $repo($(echo "$STILL_OPEN" | tr '\n' ',' | sed 's/,$//'))"
  done
  if [ -z "$PENDING" ]; then
    echo "  ✓ All PRs confirmed closed"
    break
  fi
  if [ "$CLOSE_ELAPSED" -ge "$CLOSE_TIMEOUT" ]; then
    echo "  ⚠️ Still open after ${CLOSE_TIMEOUT}s:$PENDING"
    echo "  Retrying close on stragglers and continuing anyway..."
    for repo in $BENCHMARK_REPOS; do
      STILL_OPEN=$(gh api "repos/$BENCHMARK_OWNER/$repo/pulls?state=open&per_page=100" --jq '.[].number' 2>/dev/null || true)
      if echo "$STILL_OPEN" | grep -q "rate limit"; then
        continue
      fi
      for pr in $STILL_OPEN; do
        gh api "repos/$BENCHMARK_OWNER/$repo/pulls/$pr" -X PATCH -f state=closed --silent 2>/dev/null || true
      done
    done
    break
  fi
  sleep "$CLOSE_POLL_INTERVAL"
  CLOSE_ELAPSED=$((CLOSE_ELAPSED + CLOSE_POLL_INTERVAL))
done

# Bump HEAD of benchmark branches so GitHub allows new PRs
# (GitHub caps at 100 PRs per identical head_sha).
if [ "${SKIP_BUMP_HEADS:-0}" != "1" ]; then
  TOTAL_PRS="$TOTAL_PRS" "$SCRIPT_DIR/bump-benchmark-heads.sh"
else
  echo "▸ Skipping HEAD bump (SKIP_BUMP_HEADS=1)"
fi

# Create PRs
echo "▸ Creating $TOTAL_PRS PRs..."
cd "$REPO_DIR/scripts/pr-creator"
RESULT=$(GITHUB_TOKEN=$(gh auth token) TOTAL_PRS=$TOTAL_PRS node create-test-prs.mjs 2>&1)
CREATED=$(printf '%s\n' "$RESULT" | sed -n 's/.*Total: \([0-9][0-9]*\).*/\1/p' | tail -n 1)
echo "$RESULT" | grep "✅" || true
echo "$RESULT" | grep "❌" || true
echo ""
if [ -n "$CREATED" ]; then
  echo "  ✓ PR creator reported $CREATED successful create actions"
else
  echo "  ⚠️ Could not determine PR creator summary from output"
fi

if [ -n "$CREATED" ] && [ "$CREATED" -ne "$TOTAL_PRS" ]; then
  echo "  ⚠️ PR creator summary differs from requested total ($CREATED vs $TOTAL_PRS)."
  echo "  Continuing to manifest validation because duplicated benchmark heads can collapse into fewer active PRs."
fi

# Save run manifest — maps repo/branch to PR number
cd "$REPO_DIR"
echo "▸ Building run manifest..."
node -e "
const fs = require('fs');
const { execSync } = require('child_process');

const prsConfig = JSON.parse(fs.readFileSync('scripts/pr-creator/prs.json', 'utf8'));
const sourcePrs = Array.isArray(prsConfig) ? prsConfig : prsConfig.prs;

const benchmark = JSON.parse(fs.readFileSync('scripts/benchmark/prs-benchmark.json', 'utf8'));
const goldenByHead = {};
for (const pr of benchmark.prs) { goldenByHead[pr.head] = pr; }

const byRepo = {};
for (const pr of sourcePrs) {
  const repo = pr.repo;
  if (!byRepo[repo]) byRepo[repo] = [];
  byRepo[repo].push(pr);
}
const repos = Object.keys(byRepo);
const perRepo = Math.ceil($TOTAL_PRS / repos.length);
const selected = [];
for (const repo of repos) {
  selected.push(...byRepo[repo].slice(0, perRepo));
}
selected.splice($TOTAL_PRS);

const prs = [];
for (const spr of selected) {
  const [owner, repoName] = spr.repo.split('/');
  let ghPrs = [];
  try {
    ghPrs = JSON.parse(execSync(
      'gh api \"repos/' + owner + '/' + repoName + '/pulls?state=all&per_page=50&sort=created&direction=desc\" --jq \"[.[] | {number, head: .head.ref}]\"',
      { encoding: 'utf8', timeout: 30000 }
    ));
  } catch {}
  const match = ghPrs.find(p => p.head === spr.head);
  const golden = goldenByHead[spr.head];
  prs.push({
    repo: repoName,
    head: spr.head,
    title: spr.title || golden?.title || spr.head,
    prNumber: match ? match.number : null,
  });
  const status = match ? 'PR#' + match.number : 'NOT FOUND';
  console.log('  ' + repoName.padEnd(22) + spr.head.substring(0,35).padEnd(37) + status);
}

const manifest = {
  name: '$RUN_NAME',
  created: new Date().toISOString(),
  totalPrs: $TOTAL_PRS,
  environment: 'qa',
  benchmarkConfig: {},
  prs,
};

fs.writeFileSync('$RUNS_DIR/$RUN_NAME.json', JSON.stringify(manifest, null, 2));
const mapped = prs.filter(p => p.prNumber).length;
console.log('');
console.log('Manifest: scripts/benchmark/runs/$RUN_NAME.json (' + mapped + '/' + prs.length + ' mapped)');
if (mapped !== prs.length) {
  const missing = prs.filter(p => !p.prNumber).map(p => p.repo + '/' + p.head);
  console.error('');
  console.error('⚠ Not all PRs mapped: ' + missing.join(', '));
  console.error('Some PRs may not have been created. Continuing...');
}
"

echo ""
echo "Done. PRs are open on GitHub — the QA API/worker will pick them up."
