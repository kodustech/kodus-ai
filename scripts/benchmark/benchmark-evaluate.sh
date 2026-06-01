#!/bin/bash
#
# Step 2: Extract from MongoDB + Judge with Sonnet
#
# Usage:
#   ./benchmark-evaluate.sh <name>                    # extract + judge
#   ./benchmark-evaluate.sh <name> --extract-only     # just extract, skip judge
#   ./benchmark-evaluate.sh                           # list available runs
#
# Requires: ANTHROPIC_API_KEY for judge (or use --extract-only)
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
RUNS_DIR="$SCRIPT_DIR/runs"
OWNER="Wellington01"

cd "$REPO_DIR"

# Always load from .env — the shell may have a different ANTHROPIC_API_KEY (e.g. Claude Code's key)
if [ -f ".env" ]; then
  _KEY=$(grep -E "^API_ANTHROPIC_API_KEY=|^ANTHROPIC_API_KEY=" .env | head -1 | cut -d= -f2-)
  if [ -n "$_KEY" ]; then
    export ANTHROPIC_API_KEY="$_KEY"
  fi
fi

# No args → list runs
if [ -z "${1:-}" ]; then
  echo "Usage: ./benchmark-evaluate.sh <name> [--extract-only]"
  echo ""
  if [ -d "$RUNS_DIR" ] && [ "$(ls -A "$RUNS_DIR" 2>/dev/null)" ]; then
    echo "Available runs:"
    for f in "$RUNS_DIR"/*.json; do
      NAME=$(basename "$f" .json)
      INFO=$(node -e "const d=JSON.parse(require('fs').readFileSync('$f','utf8')); const mapped=d.prs.filter(p=>p.prNumber).length; console.log(mapped + '/' + d.prs.length + ' PRs, created ' + d.created.substring(0,16))" 2>/dev/null || echo "?")
      echo "  $NAME — $INFO"
    done
  else
    echo "No runs found. Create one first:"
    echo "  ./benchmark-create.sh <name> [TOTAL_PRS]"
  fi
  exit 0
fi

RUN_NAME="$1"
EXTRACT_ONLY=false
if [[ "${2:-}" == "--extract-only" ]]; then
  EXTRACT_ONLY=true
fi

MANIFEST="$RUNS_DIR/$RUN_NAME.json"
if [ ! -f "$MANIFEST" ]; then
  echo "Run '$RUN_NAME' not found at $MANIFEST"
  echo ""
  echo "Available runs:"
  for f in "$RUNS_DIR"/*.json; do
    [ -f "$f" ] || continue
    echo "  $(basename "$f" .json)"
  done
  exit 1
fi

RESULTS_DIR="$SCRIPT_DIR/results/$RUN_NAME"
mkdir -p "$RESULTS_DIR"

echo "============================================================"
echo "Benchmark — Evaluate: $RUN_NAME"
echo "============================================================"
echo ""

# ── Extract from MongoDB using manifest PR numbers ───────────────
echo "▸ Extracting suggestions from MongoDB..."

node -e "
const { execSync, execFileSync } = require('child_process');
const fs = require('fs');
const manifest = JSON.parse(fs.readFileSync('$MANIFEST', 'utf8'));
const benchmark = JSON.parse(fs.readFileSync('scripts/benchmark/prs-benchmark.json', 'utf8'));

const mongoCmd = (query) => {
  return execSync(
    \"docker exec mongodb mongosh -u kodusdev -p 123456 --authenticationDatabase admin kodus_db --quiet --eval '\" + query.replace(/'/g, \"'\\\\''\") + \"'\",
    { encoding: 'utf8', timeout: 30000 }
  ).trim();
};

// Build golden lookup by head branch
const goldenByHead = {};
for (const pr of benchmark.prs) {
  goldenByHead[pr.head] = pr;
}

const results = { severity: [] };
const golden = [];
const skippedPrs = [];
const prMetadata = [];

for (const entry of manifest.prs) {
  const bpr = goldenByHead[entry.head];
  if (!bpr) { console.log(entry.repo.padEnd(18) + ' ⚠ No golden for branch ' + entry.head); continue; }

  let prData = null;

  if (entry.prNumber) {
    // Use exact PR number + repo name from manifest
    try {
      const query = 'JSON.stringify(db.pullRequests.findOne({number: ' + entry.prNumber + ', \"repository.name\": \"' + entry.repo + '\"}, {number: 1, files: 1, repository: 1, createdAt: 1, updatedAt: 1}))';
      const raw = mongoCmd(query);
      prData = JSON.parse(raw);
    } catch {}
  }

  if (!prData) {
    // Fallback: find by branch + repo (most recent with suggestions)
    try {
      const query = 'var pr = db.pullRequests.find({headBranchRef: \"' + entry.head + '\", \"repository.name\": \"' + entry.repo + '\", \"files.suggestions.0\": {\"\$exists\": true}}).sort({updatedAt: -1}).limit(1).toArray()[0]; pr = pr || db.pullRequests.find({headBranchRef: \"' + entry.head + '\", \"repository.name\": \"' + entry.repo + '\"}).sort({updatedAt: -1}).limit(1).toArray()[0]; JSON.stringify(pr)';
      const raw = mongoCmd(query);
      prData = JSON.parse(raw);
    } catch {}
  }

  // Count suggestions
  let totalSugg = 0;
  if (prData && prData.files) {
    for (const file of prData.files) {
      if (file.suggestions) totalSugg += file.suggestions.length;
    }
  }

  const prNum = prData ? prData.number : (entry.prNumber || '?');

  // Check if review actually completed by querying automation_execution in Postgres
  let wasProcessed = false;
  if (entry.prNumber) {
    try {
      const result = execFileSync(process.execPath, ['$SCRIPT_DIR/check-processed.js', String(entry.prNumber), entry.repo], { encoding: 'utf8', timeout: 15000 }).trim();
      wasProcessed = result === 'true';
    } catch {}
  }

  if (!prData && !wasProcessed) {
    skippedPrs.push({ repo: entry.repo, title: bpr.title.substring(0, 50), head: entry.head, prNum });
    prMetadata.push({
      repo: entry.repo,
      head: entry.head,
      title: bpr.title,
      prNumber: entry.prNumber || null,
      repositoryId: null,
      processed: false,
      mongoFound: false,
      changedFiles: [],
      candidateCounts: { severity: 0 },
    });
    console.log(entry.repo.padEnd(18) + ' PR#' + String(prNum).padEnd(5) + ' ⚠ NOT PROCESSED (skipped)');
    continue;
  }
  if (!prData) {
    // Processed but no MongoDB record — unlikely but handle gracefully
    golden.push(bpr);
    const prInfo = { pr_title: bpr.title, head: entry.head, repo: entry.repo, tool: 'kodus' };
    results.severity.push({ ...prInfo, issues: [] });
    prMetadata.push({
      repo: entry.repo,
      head: entry.head,
      title: bpr.title,
      prNumber: entry.prNumber || null,
      repositoryId: null,
      processed: true,
      mongoFound: false,
      changedFiles: [],
      candidateCounts: { severity: 0 },
    });
    console.log(entry.repo.padEnd(18) + ' PR#' + String(prNum).padEnd(5) + ' issue+critical= 0  +warning= 0  (processed, no findings)');
    continue;
  }

  golden.push(bpr);

  const suggestions = { severity: [] };

  for (const file of prData.files) {
    if (!file.suggestions) continue;
    for (const s of file.suggestions) {
      if (!s.suggestionContent || s.suggestionContent.length < 20) continue;
      // Skip suggestions discarded by the verifier (safeguard) — these are confirmed FPs
      if (s.priorityStatus === 'discarded-by-safeguard') continue;
      const entry2 = {
        comment: (s.suggestionContent || '').substring(0, 500),
        location: (s.relevantFile || file.filename) + ':' + (s.relevantLinesStart || 'general'),
        severity: s.severity || 'unknown',
        label: s.label || 'unknown',
        deliveryStatus: s.deliveryStatus || 'unknown',
        priorityStatus: s.priorityStatus || 'prioritized',
      };
      suggestions.severity.push(entry2);
    }
  }

  const prInfo = { pr_title: bpr.title, head: entry.head, repo: entry.repo, tool: 'kodus' };
  results.severity.push({ ...prInfo, issues: suggestions.severity });
  prMetadata.push({
    repo: entry.repo,
    head: entry.head,
    title: bpr.title,
    prNumber: prData.number || entry.prNumber || null,
    repositoryId: prData.repository?.id ? String(prData.repository.id) : null,
    processed: true,
    mongoFound: true,
    mongoCreatedAt: prData.createdAt || null,
    mongoUpdatedAt: prData.updatedAt || null,
    changedFiles: Array.isArray(prData.files) ? prData.files.map(f => f.filename).filter(Boolean) : [],
    candidateCounts: {
      severity: suggestions.severity.length,
    },
  });

  console.log(entry.repo.padEnd(18) + ' PR#' + String(prNum).padEnd(5) + ' severity=' + String(suggestions.severity.length).padStart(2));
}

fs.writeFileSync('$RESULTS_DIR/golden.json', JSON.stringify(golden, null, 2));
fs.writeFileSync('$RESULTS_DIR/candidates-severity.json', JSON.stringify(results.severity, null, 2));
fs.writeFileSync('$RESULTS_DIR/pr-metadata.json', JSON.stringify({
  runName: '$RUN_NAME',
  generatedAt: new Date().toISOString(),
  benchmarkConfig: manifest.benchmarkConfig || null,
  prs: prMetadata,
}, null, 2));

const totalGolden = golden.reduce((s,p) => s + p.golden_comments.length, 0);
const totalExpected = golden.length + skippedPrs.length;
console.log('');
console.log('Processed: ' + golden.length + '/' + totalExpected + ' PRs (' + skippedPrs.length + ' not processed)');
console.log('Golden: ' + totalGolden + ' comments');
console.log('Candidates: severity=' + results.severity.reduce((s,c) => s + c.issues.length, 0));
if (skippedPrs.length > 0) {
  console.log('');
  console.log('⚠ Skipped PRs (not processed by worker — not counted in score):');
  for (const sp of skippedPrs) console.log('  - ' + sp.repo + ' PR#' + sp.prNum + ' ' + sp.title);
}
"

echo "  ✓ Extracted to $RESULTS_DIR/"

if [ "$EXTRACT_ONLY" = true ]; then
  echo ""
  echo "Extract only — skipping judge."
  exit 0
fi

# ── Judge with Sonnet ────────────────────────────────────────────
if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo ""
  echo "  ⚠ ANTHROPIC_API_KEY not set — skipping judge"
  echo "  Set it in .env and re-run"
  exit 0
fi

echo ""
echo "▸ Judging with Sonnet (single severity pass)..."
echo "  Key: ${ANTHROPIC_API_KEY:0:15}... (len=${#ANTHROPIC_API_KEY})"

ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY}" node "$SCRIPT_DIR/judge-sonnet.js" \
  "$RESULTS_DIR/golden.json" \
  "$RESULTS_DIR/candidates-severity.json" \
  "$RESULTS_DIR" 2>&1

# ── Print Results ────────────────────────────────────────────────
echo ""
echo "============================================================"
echo "BENCHMARK RESULTS — $RUN_NAME"
echo "============================================================"

for LEVEL in "all" "critical" "high" "medium"; do
  OUTPUT="$RESULTS_DIR/results-${LEVEL}.json"
  [ -f "$OUTPUT" ] || continue

  node -e "
const d = JSON.parse(require('fs').readFileSync('$OUTPUT', 'utf8'));

console.log('');
console.log('── ' + d.level.toUpperCase() + ' ──────────────────────────────────────');
console.log('F1=' + d.f1.toFixed(3) + '  Precision=' + d.precision.toFixed(3) + '  Recall=' + d.recall.toFixed(3) + '  TP=' + d.tp + '  FP=' + d.fp + '  FN=' + d.fn);
console.log('');

console.log('  ' + 'Repo'.padEnd(18) + ' PRs  Golden  Cand   TP  FP  FN  Recall');
console.log('  ' + '-'.repeat(65));
for (const [repo, s] of Object.entries(d.repoStats)) {
  const rr = (s.tp + s.fn) > 0 ? (s.tp / (s.tp + s.fn)).toFixed(3) : 'N/A';
  console.log('  ' + repo.padEnd(18) + ' ' + String(s.prs).padStart(3) + '  ' + String(s.golden).padStart(6) + '  ' + String(s.candidates).padStart(4) + '   ' + String(s.tp).padStart(2) + '  ' + String(s.fp).padStart(2) + '  ' + String(s.fn).padStart(2) + '  ' + rr);
}
console.log('');

for (const pr of d.prResults) {
  const icon = pr.tp > 0 ? '✓' : '·';
  console.log('  ' + icon + ' ' + pr.repo.padEnd(18) + pr.title.padEnd(52) + ' TP=' + pr.tp + ' FP=' + pr.fp + ' FN=' + pr.fn + ' (' + pr.tp + '/' + pr.golden + ')');
  for (const f of pr.found) console.log('      ✓ [' + f.severity + '] ' + f.comment);
  for (const m of pr.missed) console.log('      ✗ [' + m.severity + '] ' + m.comment);
  if (pr.noise.length > 0) console.log('      ~ ' + pr.noise.length + ' noise comments');
}
"
done

echo ""
echo "============================================================"
echo "Results saved to: $RESULTS_DIR/"
