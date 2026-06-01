#!/bin/bash
#
# End-to-end benchmark runner
#
# Usage:
#   ./run-benchmark.sh [TOTAL_PRS]
#
# Examples:
#   ./run-benchmark.sh 20    # 4 per repo
#   ./run-benchmark.sh 50    # all 50 PRs
#   ./run-benchmark.sh       # default: 20
#
# Prerequisites:
#   - Docker containers running (worker, api, webhooks, rabbitmq, mongodb, postgres)
#   - ngrok tunnel active
#   - gh authenticated
#   - ANTHROPIC_API_KEY set (for Sonnet judge)
#
set -euo pipefail

TOTAL_PRS=${1:-20}
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
OWNER="ai-code-review-benchmark"
MONGO_URI="mongodb://kodusdev:123456@localhost:27017/kodus_db?authSource=admin"

echo "============================================================"
echo "Kodus Code Review Benchmark"
echo "============================================================"
echo "PRs: $TOTAL_PRS | Owner: $OWNER"
echo ""

# ── Step 1: Clean state ──────────────────────────────────────────
echo "▸ Step 1: Cleaning pipeline state..."
docker exec db_postgres psql -U kodusdev -d kodus_db -c \
  "DELETE FROM kodus_workflow.inbox_messages WHERE status = 'PROCESSING';" -q 2>/dev/null || true
docker exec db_postgres psql -U kodusdev -d kodus_db -c \
  "DELETE FROM kodus_workflow.outbox_messages WHERE status IN ('READY','PROCESSING','FAILED');" -q 2>/dev/null || true
docker exec rabbitmq rabbitmqctl purge_queue -p kodus-ai workflow.jobs.code_review.queue 2>/dev/null || true
docker exec rabbitmq rabbitmqctl purge_queue -p kodus-ai workflow.jobs.webhook.queue 2>/dev/null || true
echo "  ✓ Pipeline cleaned"

# ── Step 2: Ensure worker is running ─────────────────────────────
echo "▸ Step 2: Checking worker..."
docker exec kodus_worker rm -rf /usr/src/app/node_modules/.cache/webpack 2>/dev/null || true
WORKER_STATUS=$(docker inspect --format='{{.State.Status}}' kodus_worker 2>/dev/null || echo "missing")
if [ "$WORKER_STATUS" != "running" ]; then
  docker restart kodus_worker > /dev/null 2>&1 || true
  sleep 30
fi
echo "  ✓ Worker ready (status: $WORKER_STATUS)"

# ── Step 3: Create PRs ───────────────────────────────────────────
echo "▸ Step 3: Creating $TOTAL_PRS PRs..."
cd "$REPO_DIR/scripts/pr-creator"
RESULT=$(GITHUB_TOKEN=$(gh auth token) TOTAL_PRS=$TOTAL_PRS node create-test-prs.mjs 2>&1)
CREATED=$(echo "$RESULT" | grep "Total:" | grep -o "[0-9]*")
echo "  ✓ Created $CREATED PRs"

# Save PR URLs for later
echo "$RESULT" | grep "✅" | grep -o "https://[^ ]*" > /tmp/benchmark-pr-urls.txt

# ── Step 4: Wait for processing ──────────────────────────────────
echo "▸ Step 4: Waiting for processing..."
MAX_WAIT=900  # 15 minutes max
ELAPSED=0
INTERVAL=30
IDLE_CYCLES=0
START_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ)

while [ $ELAPSED -lt $MAX_WAIT ]; do
  sleep $INTERVAL
  ELAPSED=$((ELAPSED + INTERVAL))

  DONE=$(docker logs kodus_worker --since "$START_TIME" 2>&1 | grep -c "RequestChangesOrApproveStage.*Finished" || true)
  ACTIVE=$(docker logs kodus_worker --since ${INTERVAL}s 2>&1 | grep -c "AGENT-TOOL\|AgentReviewStage" || true)

  echo "  ${ELAPSED}s: $DONE/$CREATED done, $ACTIVE active"

  if [ "$ACTIVE" -eq 0 ] && [ "$DONE" -gt 0 ]; then
    IDLE_CYCLES=$((IDLE_CYCLES + 1))
    # Require 2 consecutive idle cycles to confirm done
    if [ "$IDLE_CYCLES" -ge 2 ]; then
      echo "  ✓ Processing complete ($DONE PRs)"
      break
    fi
  else
    IDLE_CYCLES=0
  fi
done

if [ $ELAPSED -ge $MAX_WAIT ]; then
  echo "  ⚠ Timeout after ${MAX_WAIT}s — proceeding with partial results"
fi

# ── Step 5: Extract from MongoDB ─────────────────────────────────
echo "▸ Step 5: Extracting suggestions from MongoDB..."
cd "$REPO_DIR"

node -e "
const { execSync } = require('child_process');
const fs = require('fs');
const benchmark = JSON.parse(fs.readFileSync('scripts/benchmark/prs-benchmark.json', 'utf8'));
const owner = '$OWNER';
const totalPrs = $TOTAL_PRS;
const repos = ['sentry', 'grafana-codex', 'discourse-cursor', 'cal.com', 'keycloak'];
const perRepo = Math.ceil(totalPrs / repos.length);

const byRepo = {};
for (const pr of benchmark.prs) {
  const repo = pr.repo.split('/').pop();
  if (!byRepo[repo]) byRepo[repo] = [];
  byRepo[repo].push(pr);
}

// Extract suggestions from MongoDB matched by head branch
const mongoCmd = (query) => {
  const escaped = query.replace(/'/g, \"'\\\\\\\"'\\\\\\\"'\");
  return execSync(
    'docker exec mongodb mongosh -u kodusdev -p 123456 --authenticationDatabase admin kodus_db --quiet --eval \\'' + escaped + '\\'',
    { encoding: 'utf8', timeout: 30000 }
  ).trim();
};

const results = { all: [], issueOnly: [], issueCritical: [] };
const golden = [];

for (const repo of repos) {
  const benchPrs = (byRepo[repo] || []).slice(0, perRepo);

  for (const bpr of benchPrs) {
    golden.push(bpr);

    // Find LATEST PR in MongoDB by head branch (sort by number desc to avoid stale runs)
    const query = 'JSON.stringify(db.pullRequests.find({headBranchRef: \"' + bpr.head + '\"}, {number: 1, files: 1}).sort({number: -1}).limit(1).toArray()[0])';
    let prData;
    try {
      const raw = mongoCmd(query);
      prData = JSON.parse(raw);
    } catch { prData = null; }

    const suggestions = { all: [], issue: [], issueCritical: [] };

    if (prData?.files) {
      for (const file of prData.files) {
        if (!file.suggestions) continue;
        for (const s of file.suggestions) {
          if (!s.suggestionContent || s.suggestionContent.length < 20) continue;
          const entry = {
            comment: (s.suggestionContent || '').substring(0, 500),
            location: (s.relevantFile || file.filename) + ':' + (s.relevantLinesStart || 'general'),
            level: s.level || 'unknown',
            severity: s.severity || 'unknown',
            label: s.label || 'unknown',
            deliveryStatus: s.deliveryStatus || 'unknown',
          };
          suggestions.all.push(entry);
          if (s.level === 'issue') suggestions.issue.push(entry);
          if (s.level === 'issue' || s.level === 'critical') suggestions.issueCritical.push(entry);
        }
      }
    }

    const prInfo = { pr_title: bpr.title, head: bpr.head, repo: repo, tool: 'kodus' };
    results.all.push({ ...prInfo, issues: suggestions.all });
    results.issueOnly.push({ ...prInfo, issues: suggestions.issue });
    results.issueCritical.push({ ...prInfo, issues: suggestions.issueCritical });

    const prNum = prData?.number || '?';
    console.log(repo + ' PR#' + prNum + ' (' + bpr.head.substring(0,25) + ') — ' + suggestions.all.length + ' all, ' + suggestions.issueCritical.length + ' issue+critical, ' + suggestions.issue.length + ' issue-only');
  }
}

fs.writeFileSync('/tmp/benchmark-golden.json', JSON.stringify(golden, null, 2));
fs.writeFileSync('/tmp/benchmark-candidates-all.json', JSON.stringify(results.all, null, 2));
fs.writeFileSync('/tmp/benchmark-candidates-issue-critical.json', JSON.stringify(results.issueCritical, null, 2));
fs.writeFileSync('/tmp/benchmark-candidates-issue-only.json', JSON.stringify(results.issueOnly, null, 2));

const totalGolden = golden.reduce((s,p) => s + p.golden_comments.length, 0);
console.log('');
console.log('Total: ' + golden.length + ' PRs');
console.log('Golden: ' + totalGolden);
console.log('Candidates (all levels): ' + results.all.reduce((s,c) => s + c.issues.length, 0));
console.log('Candidates (issue+critical): ' + results.issueCritical.reduce((s,c) => s + c.issues.length, 0));
console.log('Candidates (issue only): ' + results.issueOnly.reduce((s,c) => s + c.issues.length, 0));
"

echo "  ✓ Extracted"

# ── Step 6: Judge with Sonnet ────────────────────────────────────
echo "▸ Step 6: Judging with Sonnet..."

if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "  ⚠ ANTHROPIC_API_KEY not set — skipping Sonnet judge"
  echo "  Run manually: npx tsx scripts/benchmark/judge.ts --candidates /tmp/benchmark-candidates-all.json"

  # Fallback: agent mode summary
  echo ""
  echo "============================================================"
  echo "Extraction complete — run /benchmark to judge with agent mode"
  echo "============================================================"
  echo "Files saved:"
  echo "  /tmp/benchmark-golden.json"
  echo "  /tmp/benchmark-candidates-all.json"
  echo "  /tmp/benchmark-candidates-issue-critical.json"
  echo "  /tmp/benchmark-candidates-issue-only.json"
  exit 0
fi

# Judge each filter level
for LEVEL in "all" "issue-critical" "issue-only"; do
  echo "  Judging: $LEVEL..."
  CANDIDATES="/tmp/benchmark-candidates-${LEVEL}.json"
  OUTPUT="/tmp/benchmark-results-${LEVEL}.json"

  node -e "
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');

const JUDGE_PROMPT = \`You are evaluating AI code review tools.
Determine if the candidate issue matches the golden (expected) comment.

Golden Comment (the issue we're looking for):
{golden_comment}

Candidate Issue (from the tool's review):
{candidate}

Instructions:
- Determine if the candidate identifies the SAME underlying issue as the golden comment
- Accept semantic matches - different wording is fine if it's the same problem
- Focus on whether they point to the same bug, concern, or code issue

Respond with ONLY a JSON object:
{\"reasoning\": \"brief explanation\", \"match\": true/false, \"confidence\": 0.0-1.0}\`;

async function main() {
  const client = new Anthropic.default();
  const golden = JSON.parse(fs.readFileSync('/tmp/benchmark-golden.json', 'utf8'));
  const candidates = JSON.parse(fs.readFileSync('$CANDIDATES', 'utf8'));

  const judgments = {};
  let totalTP = 0, totalFP = 0, totalFN = 0;

  for (let i = 0; i < golden.length; i++) {
    const pr = golden[i];
    const cand = candidates[i];
    const matches = [];
    const goldenMatched = new Set();
    const candMatched = new Set();

    // N×M pairwise comparison
    for (let gi = 0; gi < pr.golden_comments.length; gi++) {
      if (goldenMatched.has(gi)) continue;
      let bestCi = -1, bestConf = 0;

      for (let ci = 0; ci < cand.issues.length; ci++) {
        if (candMatched.has(ci)) continue;

        const prompt = JUDGE_PROMPT
          .replace('{golden_comment}', pr.golden_comments[gi].comment)
          .replace('{candidate}', cand.issues[ci].comment);

        try {
          const resp = await client.messages.create({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 200,
            temperature: 0,
            messages: [{ role: 'user', content: prompt }],
          });
          const text = resp.content[0].text.trim();
          const json = JSON.parse(text.replace(/\`\`\`json?/g, '').replace(/\`\`\`/g, '').trim());
          if (json.match && json.confidence > bestConf) {
            bestCi = ci;
            bestConf = json.confidence;
          }
        } catch {}
      }

      if (bestCi >= 0) {
        matches.push([bestCi, gi]);
        goldenMatched.add(gi);
        candMatched.add(bestCi);
      }
    }

    judgments[i] = { matches };
    const tp = matches.length;
    const fp = cand.issues.length - tp;
    const fn = pr.golden_comments.length - tp;
    totalTP += tp; totalFP += fp; totalFN += fn;

    const repo = pr.repo.split('/').pop();
    process.stderr.write('  ' + repo + ' ' + pr.title.substring(0,35) + ': ' + tp + ' TP, ' + fp + ' FP, ' + fn + ' FN\n');
  }

  const p = totalTP / (totalTP + totalFP) || 0;
  const r = totalTP / (totalTP + totalFN) || 0;
  const f1 = p + r === 0 ? 0 : 2 * p * r / (p + r);

  // Build per-PR and per-repo results
  const prResults = [];
  const repoStats = {};

  for (let i = 0; i < golden.length; i++) {
    const pr = golden[i];
    const cand = candidates[i];
    const matches = judgments[i]?.matches || [];
    const repo = pr.repo.split('/').pop();
    const tp = matches.length;
    const fp = cand.issues.length - tp;
    const fn = pr.golden_comments.length - tp;

    // Golden found vs missed
    const matchedG = new Set(matches.map(m => m[1]));
    const found = pr.golden_comments.filter((g, gi) => matchedG.has(gi)).map(g => ({ comment: g.comment.substring(0, 100), severity: g.severity }));
    const missed = pr.golden_comments.filter((g, gi) => !matchedG.has(gi)).map(g => ({ comment: g.comment.substring(0, 100), severity: g.severity }));

    // Noise (FP candidates)
    const matchedC = new Set(matches.map(m => m[0]));
    const noise = cand.issues.filter((c, ci) => !matchedC.has(ci)).map(c => c.comment.substring(0, 100));

    prResults.push({ repo, title: pr.title.substring(0, 50), tp, fp, fn, golden: pr.golden_comments.length, candidates: cand.issues.length, found, missed, noise });

    if (!repoStats[repo]) repoStats[repo] = { tp: 0, fp: 0, fn: 0, golden: 0, candidates: 0, prs: 0 };
    repoStats[repo].tp += tp;
    repoStats[repo].fp += fp;
    repoStats[repo].fn += fn;
    repoStats[repo].golden += pr.golden_comments.length;
    repoStats[repo].candidates += cand.issues.length;
    repoStats[repo].prs++;
  }

  const result = { level: '$LEVEL', tp: totalTP, fp: totalFP, fn: totalFN, precision: p, recall: r, f1, judgments, prResults, repoStats };
  fs.writeFileSync('$OUTPUT', JSON.stringify(result, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });
" 2>/tmp/benchmark-judge-${LEVEL}.log
done

# ── Step 7: Results ──────────────────────────────────────────────
echo ""
echo "============================================================"
echo "BENCHMARK RESULTS"
echo "============================================================"

# For each level, print summary + per-repo + per-PR
for LEVEL in "all" "issue-critical" "issue-only"; do
  OUTPUT="/tmp/benchmark-results-${LEVEL}.json"
  [ -f "$OUTPUT" ] || continue

  node -e "
const d = JSON.parse(require('fs').readFileSync('$OUTPUT', 'utf8'));
const f1 = d.f1.toFixed(3), p = d.precision.toFixed(3), r = d.recall.toFixed(3);

console.log('');
console.log('── ' + d.level.toUpperCase() + ' ──────────────────────────────────────');
console.log('F1=' + f1 + '  Precision=' + p + '  Recall=' + r + '  TP=' + d.tp + '  FP=' + d.fp + '  FN=' + d.fn);
console.log('');

// Per-repo table
console.log('By Repository:');
console.log('  ' + 'Repo'.padEnd(18) + ' PRs  Golden  Cand  TP  FP  FN  Recall');
console.log('  ' + '-'.repeat(65));
for (const [repo, s] of Object.entries(d.repoStats)) {
  const rr = s.golden > 0 ? (s.tp / (s.tp + s.fn)).toFixed(3) : 'N/A';
  console.log('  ' + repo.padEnd(18) + ' ' + String(s.prs).padStart(3) + '  ' + String(s.golden).padStart(6) + '  ' + String(s.candidates).padStart(4) + '  ' + String(s.tp).padStart(2) + '  ' + String(s.fp).padStart(2) + '  ' + String(s.fn).padStart(2) + '  ' + rr);
}
console.log('');

// Per-PR detail
console.log('By PR:');
for (const pr of d.prResults) {
  const icon = pr.tp > 0 ? '✓' : '·';
  console.log('  ' + icon + ' ' + pr.repo.padEnd(18) + pr.title.padEnd(52) + ' TP=' + pr.tp + ' FP=' + pr.fp + ' FN=' + pr.fn + ' (' + pr.tp + '/' + pr.golden + ' golden)');
  if (pr.found.length > 0) {
    for (const f of pr.found) console.log('      ✓ [' + f.severity + '] ' + f.comment);
  }
  if (pr.missed.length > 0) {
    for (const m of pr.missed) console.log('      ✗ [' + m.severity + '] ' + m.comment);
  }
  if (pr.noise.length > 0) {
    for (const n of pr.noise) console.log('      ~ ' + n);
  }
}
"
done

echo ""
echo "============================================================"
echo "Files: /tmp/benchmark-results-{all,issue-critical,issue-only}.json"
echo "Logs: /tmp/benchmark-judge-{all,issue-critical,issue-only}.log"
