#!/bin/bash
#
# QA variant of benchmark-evaluate.sh.
#
# Extracts candidates by fetching Kodus review comments directly from GitHub
# (gh api), with NO local infra touching (no Mongo, no Postgres, no docker).
# Then runs the same judge-sonnet.js over golden vs candidates.
#
# Only comments authored by the QA bot AND created after the run manifest's
# `created` timestamp are counted — this prevents leakage from other envs
# (e.g. DEV) that may post on the same PRs.
#
# Usage:
#   ./benchmark-evaluate-qa.sh <name> --bot <github-login>
#   ./benchmark-evaluate-qa.sh <name> --bot malinosqui --extract-only
#
# Examples:
#   ./benchmark-evaluate-qa.sh qa-smoke --bot malinosqui
#   ./benchmark-evaluate-qa.sh qa-smoke --bot "kodus-qa[bot]"
#
# The --bot flag is required (author login whose comments count as the QA
# review). KODUS_BOT_LOGIN env var is accepted as fallback when --bot is
# omitted.
#
# Optional env:
#   ANTHROPIC_API_KEY   — for judge (or pass --extract-only)
#   BENCHMARK_OWNER     — GitHub org (default: ai-code-review-benchmark)
#   COMMENT_GRACE_SEC   — seconds to subtract from manifest.created when
#                         filtering comments, to absorb clock skew (default: 60)
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
RUNS_DIR="$SCRIPT_DIR/runs"
BENCHMARK_OWNER="${BENCHMARK_OWNER:-ai-code-review-benchmark}"
COMMENT_GRACE_SEC="${COMMENT_GRACE_SEC:-60}"

cd "$REPO_DIR"

# Load ANTHROPIC_API_KEY from .env if not already set (mirrors evaluate.sh)
if [ -f ".env" ]; then
  _KEY=$(grep -E "^API_ANTHROPIC_API_KEY=|^ANTHROPIC_API_KEY=" .env | head -1 | cut -d= -f2-)
  if [ -n "$_KEY" ]; then
    export ANTHROPIC_API_KEY="$_KEY"
  fi
fi

# No args → list runs
if [ -z "${1:-}" ]; then
  echo "Usage: ./benchmark-evaluate-qa.sh <name> --bot <github-login> [--extract-only]"
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
    echo "  ./benchmark-create-qa.sh <name> [TOTAL_PRS]"
  fi
  exit 0
fi

RUN_NAME="$1"
shift
EXTRACT_ONLY=false
BOT_LOGIN="${KODUS_BOT_LOGIN:-}"

while [ $# -gt 0 ]; do
  case "$1" in
    --bot)
      BOT_LOGIN="${2:-}"
      if [ -z "$BOT_LOGIN" ]; then
        echo "Error: --bot requires a GitHub login (e.g. --bot malinosqui)"
        exit 1
      fi
      shift 2
      ;;
    --bot=*)
      BOT_LOGIN="${1#--bot=}"
      shift
      ;;
    --extract-only)
      EXTRACT_ONLY=true
      shift
      ;;
    *)
      echo "Unknown argument: $1"
      echo "Usage: ./benchmark-evaluate-qa.sh <name> --bot <github-login> [--extract-only]"
      exit 1
      ;;
  esac
done

if [ -z "$BOT_LOGIN" ]; then
  echo "Error: --bot <github-login> is required"
  echo "  (or set KODUS_BOT_LOGIN env var)"
  echo "Example: ./benchmark-evaluate-qa.sh $RUN_NAME --bot malinosqui"
  exit 1
fi

export KODUS_BOT_LOGIN="$BOT_LOGIN"

MANIFEST="$RUNS_DIR/$RUN_NAME.json"
if [ ! -f "$MANIFEST" ]; then
  echo "Run '$RUN_NAME' not found at $MANIFEST"
  exit 1
fi

RESULTS_DIR="$SCRIPT_DIR/results/$RUN_NAME"
mkdir -p "$RESULTS_DIR"

echo "============================================================"
echo "Benchmark (QA) — Evaluate: $RUN_NAME"
echo "============================================================"
echo "Bot filter:   $BOT_LOGIN"
echo "Owner:        $BENCHMARK_OWNER"
echo "Grace window: ${COMMENT_GRACE_SEC}s before manifest.created"
echo ""

# ── Extract from GitHub via gh api ───────────────────────────────
echo "▸ Extracting suggestions from GitHub (gh api)..."

RUN_NAME="$RUN_NAME" \
MANIFEST="$MANIFEST" \
RESULTS_DIR="$RESULTS_DIR" \
BENCHMARK_OWNER="$BENCHMARK_OWNER" \
KODUS_BOT_LOGIN="$KODUS_BOT_LOGIN" \
COMMENT_GRACE_SEC="$COMMENT_GRACE_SEC" \
node -e "
const { execFileSync } = require('child_process');
const fs = require('fs');

const RUN_NAME = process.env.RUN_NAME;
const MANIFEST = process.env.MANIFEST;
const RESULTS_DIR = process.env.RESULTS_DIR;
const OWNER = process.env.BENCHMARK_OWNER;
const BOT = process.env.KODUS_BOT_LOGIN;
const GRACE = parseInt(process.env.COMMENT_GRACE_SEC, 10) || 60;

const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
const benchmark = JSON.parse(fs.readFileSync('scripts/benchmark/prs-benchmark.json', 'utf8'));

const goldenByHead = {};
for (const pr of benchmark.prs) goldenByHead[pr.head] = pr;

const manifestCreatedMs = Date.parse(manifest.created);
const cutoffMs = Number.isFinite(manifestCreatedMs)
  ? manifestCreatedMs - GRACE * 1000
  : 0;

function gh(args) {
  try {
    return execFileSync('gh', args, { encoding: 'utf8', timeout: 30000, maxBuffer: 20 * 1024 * 1024 });
  } catch (e) {
    return '';
  }
}

function fetchInlineComments(repo, prNum) {
  const raw = gh(['api', '--paginate',
    'repos/' + OWNER + '/' + repo + '/pulls/' + prNum + '/comments?per_page=100']);
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}

function fetchReviews(repo, prNum) {
  const raw = gh(['api', '--paginate',
    'repos/' + OWNER + '/' + repo + '/pulls/' + prNum + '/reviews?per_page=100']);
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}

function parseSeverity(body) {
  if (!body) return 'unknown';
  const lower = body.toLowerCase();
  const marker = lower.match(/<!--\s*kodus[-_]severity\s*:\s*(critical|high|medium|low)\s*-->/);
  if (marker) return marker[1];
  if (/(severity[:\s]+critical|\bcritical\b.*severity|\[critical\]|🔴\s*critical|\*\*critical\*\*)/.test(lower)) return 'critical';
  if (/(severity[:\s]+high|\[high\]|🟠\s*high|\*\*high\*\*)/.test(lower)) return 'high';
  if (/(severity[:\s]+medium|\[medium\]|🟡\s*medium|\*\*medium\*\*)/.test(lower)) return 'medium';
  if (/(severity[:\s]+low|\[low\]|🟢\s*low|\*\*low\*\*)/.test(lower)) return 'low';
  return 'unknown';
}

function byBotAndFresh(items) {
  return items.filter(it => {
    if (!it || !it.user || it.user.login !== BOT) return false;
    const createdAt = Date.parse(it.created_at || it.submitted_at || '');
    if (!Number.isFinite(createdAt)) return false;
    return createdAt >= cutoffMs;
  });
}

const results = { severity: [] };
const golden = [];
const skippedPrs = [];
const prMetadata = [];

for (const entry of manifest.prs) {
  const bpr = goldenByHead[entry.head];
  if (!bpr) { console.log(entry.repo.padEnd(18) + ' ⚠ No golden for branch ' + entry.head); continue; }

  if (!entry.prNumber) {
    skippedPrs.push({ repo: entry.repo, title: bpr.title.substring(0, 50), head: entry.head, prNum: '?' });
    prMetadata.push({
      repo: entry.repo, head: entry.head, title: bpr.title,
      prNumber: null, processed: false, githubFound: false,
      candidateCounts: { severity: 0 },
    });
    console.log(entry.repo.padEnd(18) + ' PR#?    ⚠ No PR number in manifest (skipped)');
    continue;
  }

  const inline = fetchInlineComments(entry.repo, entry.prNumber);
  const reviews = fetchReviews(entry.repo, entry.prNumber);
  const botInline = byBotAndFresh(inline);
  const botReviews = byBotAndFresh(reviews);

  // 'Processed' = bot left ANY review/comment on this PR since the run started.
  const wasProcessed = botInline.length > 0 || botReviews.length > 0;

  if (!wasProcessed) {
    skippedPrs.push({ repo: entry.repo, title: bpr.title.substring(0, 50), head: entry.head, prNum: entry.prNumber });
    prMetadata.push({
      repo: entry.repo, head: entry.head, title: bpr.title,
      prNumber: entry.prNumber, processed: false, githubFound: false,
      candidateCounts: { severity: 0 },
    });
    console.log(entry.repo.padEnd(18) + ' PR#' + String(entry.prNumber).padEnd(5) + ' ⚠ NOT PROCESSED (skipped)');
    continue;
  }

  golden.push(bpr);

  const issues = [];

  for (const c of botInline) {
    const body = c.body || '';
    if (body.length < 20) continue;
    issues.push({
      comment: body.substring(0, 500),
      location: (c.path || 'unknown') + ':' + (c.line ?? c.original_line ?? c.start_line ?? 'general'),
      severity: parseSeverity(body),
      label: 'unknown',
      deliveryStatus: 'posted',
      priorityStatus: 'prioritized',
    });
  }

  // Also include non-empty review summary bodies (sometimes Kodus posts a
  // per-issue review summary without an inline anchor). Keep this conservative
  // — only if the review body itself carries a Kodus-style severity marker.
  for (const r of botReviews) {
    const body = r.body || '';
    if (body.length < 20) continue;
    const sev = parseSeverity(body);
    if (sev === 'unknown') continue; // avoid capturing generic summaries
    issues.push({
      comment: body.substring(0, 500),
      location: 'review:' + (r.state || 'COMMENTED'),
      severity: sev,
      label: 'unknown',
      deliveryStatus: 'posted',
      priorityStatus: 'prioritized',
    });
  }

  const prInfo = { pr_title: bpr.title, head: entry.head, repo: entry.repo, tool: 'kodus-qa' };
  results.severity.push({ ...prInfo, issues });
  prMetadata.push({
    repo: entry.repo, head: entry.head, title: bpr.title,
    prNumber: entry.prNumber, processed: true, githubFound: true,
    candidateCounts: { severity: issues.length },
  });

  console.log(entry.repo.padEnd(18) + ' PR#' + String(entry.prNumber).padEnd(5) + ' severity=' + String(issues.length).padStart(2));
}

fs.writeFileSync(RESULTS_DIR + '/golden.json', JSON.stringify(golden, null, 2));
fs.writeFileSync(RESULTS_DIR + '/candidates-severity.json', JSON.stringify(results.severity, null, 2));
fs.writeFileSync(RESULTS_DIR + '/pr-metadata.json', JSON.stringify({
  runName: RUN_NAME,
  generatedAt: new Date().toISOString(),
  environment: 'qa',
  botLogin: BOT,
  cutoffMs,
  benchmarkConfig: manifest.benchmarkConfig || null,
  prs: prMetadata,
}, null, 2));

const totalGolden = golden.reduce((s, p) => s + p.golden_comments.length, 0);
const totalExpected = golden.length + skippedPrs.length;
console.log('');
console.log('Processed: ' + golden.length + '/' + totalExpected + ' PRs (' + skippedPrs.length + ' not processed)');
console.log('Golden: ' + totalGolden + ' comments');
console.log('Candidates: severity=' + results.severity.reduce((s, c) => s + c.issues.length, 0));
if (skippedPrs.length > 0) {
  console.log('');
  console.log('⚠ Skipped PRs (bot did not post comments — not counted in score):');
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

# ── Print Results (same layout as DEV) ───────────────────────────
echo ""
echo "============================================================"
echo "BENCHMARK RESULTS (QA) — $RUN_NAME"
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
