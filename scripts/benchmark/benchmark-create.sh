#!/bin/bash
#
# Step 1: Create benchmark PRs
#
# Usage:
#   ./benchmark-create.sh <name> [TOTAL_PRS] [--platform=github|azure]
#
# Examples:
#   ./benchmark-create.sh sonnet-v1 20                       # GitHub (default)
#   ./benchmark-create.sh kimi-baseline 50
#   ./benchmark-create.sh azure-run 5 --platform=azure       # Azure DevOps
#
# Platforms:
#   github (default) — uses gh auth token + scripts/pr-creator/prs.json
#   azure            — uses AZURE_DEVOPS_TOKEN + scripts/pr-creator/prs-azure.json
#                      (generate it first with migrate-prs-to-azure.mjs)
#
set -euo pipefail

# Parse optional --platform flag from any position
PLATFORM="github"
POS_ARGS=()
for arg in "$@"; do
  case "$arg" in
    --platform=*) PLATFORM="${arg#*=}" ;;
    *)            POS_ARGS+=("$arg") ;;
  esac
done
# Reset positional args (safe under set -u when POS_ARGS is empty)
set -- ${POS_ARGS[@]+"${POS_ARGS[@]}"}

if [ "$PLATFORM" != "github" ] && [ "$PLATFORM" != "azure" ]; then
  echo "ERROR: --platform must be 'github' or 'azure' (got: '$PLATFORM')"
  exit 1
fi

if [ -z "${1:-}" ]; then
  echo "Usage: ./benchmark-create.sh <name> [TOTAL_PRS] [--platform=github|azure]"
  echo ""
  echo "Examples:"
  echo "  ./benchmark-create.sh sonnet-v1 20                       # GitHub (default)"
  echo "  ./benchmark-create.sh kimi-baseline"
  echo "  ./benchmark-create.sh azure-run 5 --platform=azure       # Azure DevOps"
  echo ""
  # List existing runs
  RUNS_DIR="$(cd "$(dirname "$0")" && pwd)/runs"
  if [ -d "$RUNS_DIR" ] && [ "$(ls -A "$RUNS_DIR" 2>/dev/null)" ]; then
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
WORKER=$(docker ps --format '{{.Names}}' | grep worker | head -1)
WORKER="${WORKER:-kodus_worker}"
BASE_ENV_FILE="${BASE_ENV_FILE:-.env}"

if [[ "$BASE_ENV_FILE" = /* ]]; then
  SOURCE_ENV_FILE="$BASE_ENV_FILE"
else
  SOURCE_ENV_FILE="$REPO_DIR/$BASE_ENV_FILE"
fi

if [ ! -f "$SOURCE_ENV_FILE" ]; then
  echo "Environment file '$SOURCE_ENV_FILE' not found"
  exit 1
fi

RUNTIME_ENV_FILE="/tmp/kodus-benchmark-${RUN_NAME}.env"

echo "============================================================"
echo "Benchmark — Create PRs"
echo "============================================================"
echo "Run: $RUN_NAME | PRs: $TOTAL_PRS"
echo "Owner: $BENCHMARK_OWNER"
echo ""

# Clean pipeline + MongoDB benchmark PRs
echo "▸ Cleaning pipeline..."
docker exec db_postgres psql -U kodusdev -d kodus_db -c \
  "DELETE FROM kodus_workflow.inbox_messages WHERE status = 'PROCESSING';" -q 2>/dev/null || true
docker exec db_postgres psql -U kodusdev -d kodus_db -c \
  "DELETE FROM kodus_workflow.outbox_messages WHERE status IN ('READY','PROCESSING','FAILED');" -q 2>/dev/null || true
docker exec rabbitmq rabbitmqctl purge_queue -p kodus-ai workflow.jobs.code_review.queue 2>/dev/null || true
docker exec rabbitmq rabbitmqctl purge_queue -p kodus-ai workflow.jobs.webhook.queue 2>/dev/null || true

# Delete ALL PRs from MongoDB to avoid stale data matching
DELETED=$(docker exec mongodb mongosh -u kodusdev -p 123456 --authenticationDatabase admin kodus_db --quiet --eval \
  "var r = db.pullRequests.deleteMany({}); print(r.deletedCount)" 2>/dev/null || echo 0)
echo "  ✓ Pipeline cleaned (removed $DELETED PRs from MongoDB)"

# Recreate worker with benchmark-specific env overrides.
# SKIP_WORKER_RECREATE=1 leaves the already-running worker/db untouched — needed
# when the live containers belong to a different compose project (e.g. a
# coexisting worktree stack) so `up --force-recreate` would collide on the fixed
# container_name. BYOK is read from the DB per review, so no recreate is needed
# just to switch models.
if [ "${SKIP_WORKER_RECREATE:-0}" = "1" ]; then
  echo "▸ Skipping worker recreate (SKIP_WORKER_RECREATE=1) — reusing running worker"
else
  echo "▸ Recreating worker..."
  cp "$SOURCE_ENV_FILE" "$RUNTIME_ENV_FILE"
  ENV_FILE="$RUNTIME_ENV_FILE" docker compose -f "$REPO_DIR/docker-compose.dev.yml" --profile local-db up -d --force-recreate worker db_postgres db_mongodb > /dev/null
  # Clear webpack cache AFTER recreate so it persists in the volume
  docker exec $WORKER rm -rf /usr/src/app/node_modules/.cache/webpack 2>/dev/null || true
fi

READY=0
for _ in $(seq 1 18); do
  INSPECT=$(docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}' "$WORKER" 2>/dev/null || true)
  STATE=$(echo "$INSPECT" | awk '{print $1}')
  HEALTH=$(echo "$INSPECT" | awk '{print $2}')

  if [ "$STATE" = "running" ] && { [ "$HEALTH" = "healthy" ] || [ "$HEALTH" = "no-healthcheck" ]; }; then
    READY=1
    break
  fi

  sleep 5
done

if [ "$READY" -eq 1 ]; then
  echo "  ✓ Worker recreated and is healthy"
else
  echo "  ✗ Worker failed to become healthy after recreate"
  docker logs --since 2m $WORKER 2>&1 | tail -n 120
  exit 1
fi

# Close ALL open PRs in benchmark repos first, then verify they actually
# closed before bumping. If a PR stays open when bump-benchmark-heads pushes
# an empty commit to its head branch, GitHub fires a `synchronize` webhook
# and the worker picks up a spurious review — doubling (or worse) the
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
    # Ignore rate-limit responses (contain "rate limit" in error body)
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
# Pass TOTAL_PRS so we only bump the branches that will actually be used —
# bumping every branch in prs.json fires synchronize webhooks on orphan PRs
# from previous runs and triggers spurious reviews.
#
# Azure DevOps doesn't enforce the same cap, and bump-benchmark-heads.sh
# is GitHub-API only, so we always skip on the azure path.
if [ "$PLATFORM" = "azure" ]; then
  echo "▸ Skipping HEAD bump (azure platform — N/A)"
elif [ "${SKIP_BUMP_HEADS:-0}" != "1" ]; then
  TOTAL_PRS="$TOTAL_PRS" "$(cd "$(dirname "$0")" && pwd)/bump-benchmark-heads.sh"
else
  echo "▸ Skipping HEAD bump (SKIP_BUMP_HEADS=1)"
fi

# Create PRs
echo "▸ Creating $TOTAL_PRS PRs on $PLATFORM..."
cd "$REPO_DIR/scripts/pr-creator"
if [ "$PLATFORM" = "azure" ]; then
  if [ -z "${AZURE_DEVOPS_TOKEN:-}" ]; then
    echo "ERROR: AZURE_DEVOPS_TOKEN must be set for --platform=azure"
    exit 1
  fi
  if [ ! -f "$REPO_DIR/scripts/pr-creator/prs-azure.json" ]; then
    echo "ERROR: scripts/pr-creator/prs-azure.json not found."
    echo "Generate it first:"
    echo "  node scripts/benchmark/migrate-prs-to-azure.mjs \\"
    echo "    --azure-org=<org> --azure-project=<project>"
    exit 1
  fi
  RESULT=$(AZURE_DEVOPS_TOKEN="$AZURE_DEVOPS_TOKEN" \
           PR_CONFIG=prs-azure.json \
           TOTAL_PRS=$TOTAL_PRS \
           node create-test-prs.mjs 2>&1)
else
  RESULT=$(GITHUB_TOKEN=$(gh auth token) TOTAL_PRS=$TOTAL_PRS node create-test-prs.mjs 2>&1)
fi
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

// prs.json has the real repo names (Wellington01/sentry-greptile etc.)
const prsConfig = JSON.parse(fs.readFileSync('scripts/pr-creator/prs.json', 'utf8'));
const sourcePrs = Array.isArray(prsConfig) ? prsConfig : prsConfig.prs;

// prs-benchmark.json has golden comments (matched by head branch)
const benchmark = JSON.parse(fs.readFileSync('scripts/benchmark/prs-benchmark.json', 'utf8'));
const goldenByHead = {};
for (const pr of benchmark.prs) { goldenByHead[pr.head] = pr; }

// Group by repo and distribute evenly
const byRepo = {};
for (const pr of sourcePrs) {
  const repo = pr.repo; // e.g. 'Wellington01/sentry-greptile'
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
// For each selected PR, find the actual GitHub PR number by head branch
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
echo "Wait for reviews to finish, then run:"
echo "  ./scripts/benchmark/benchmark-evaluate.sh $RUN_NAME"
echo ""
echo "Or wait programmatically with:"
echo "  node scripts/benchmark/wait-for-run.js $RUN_NAME"
