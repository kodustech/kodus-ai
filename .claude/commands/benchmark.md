---
name: benchmark
description: Run the code review benchmark pipeline — create PRs, extract results from MongoDB, judge with Sonnet against 136 golden comments (50 PRs across Sentry, Grafana, Cal.com, Discourse, Keycloak), and compute precision/recall/F1 scores.
---

# Code Review Benchmark

## Overview

Evaluates Kodus code review quality against golden comments from withmartian/code-review-benchmark.

**Dataset:** 50 PRs, 136 golden comments, 5 repos (Sentry, Grafana, Cal.com, Discourse, Keycloak)

## Quick Start

Two scripts handle everything:

```bash
# Step 1: Create PRs and trigger reviews
./scripts/benchmark/benchmark-create.sh 20

# Step 2: After reviews finish, extract + judge
./scripts/benchmark/benchmark-evaluate.sh 20
```

## Arguments

Parse arguments after `/benchmark`:

- No args → show latest results or guide through the flow
- `create [N]` → run `benchmark-create.sh N` (default: 20)
- `evaluate [N]` → run `benchmark-evaluate.sh N` (default: 20)
- `results` → show latest results from `scripts/benchmark/results/`
- `status` → check worker, queues, and processing state
- `setup` → fork repos + create PRs (first-time setup)

## Scripts

### `benchmark-create.sh [TOTAL_PRS]`

1. Cleans pipeline (inbox, outbox, RabbitMQ queues)
2. Clears webpack cache and restarts worker
3. Creates PRs distributed evenly across repos (ceil(N/5) per repo)

After running, tell the user to wait for reviews to finish and check progress:
```bash
docker logs 1cf0a7d802e5_kodus_worker --since 30s 2>&1 | grep -c AGENT
```
When it returns 0 for two checks in a row, reviews are done.

### `benchmark-evaluate.sh [TOTAL_PRS]`

1. Extracts suggestions from **MongoDB** (not GitHub API) matched by branch name
2. Splits into two filter levels: `issue+critical` and `issue+critical+warning`
3. Judges each level with **Sonnet** using the exact withmartian judge prompt
4. Prints detailed results: per-repo, per-PR, with found/missed/noise breakdown

**ANTHROPIC_API_KEY** is loaded from `.env` automatically (`API_ANTHROPIC_API_KEY` or `ANTHROPIC_API_KEY`).

Extract only (skip judge):
```bash
./scripts/benchmark/benchmark-evaluate.sh 20 --extract-only
```

## How Extraction Works

Candidates are extracted from **MongoDB** (`pullRequests` collection), NOT from GitHub API:
- Matches benchmark PRs by `headBranchRef` (branch name), not by PR number
- Each suggestion has `level` (issue/critical/warning), `severity`, `label`, `deliveryStatus`
- Two filter levels produced:
  - **issue-critical**: only `level=issue` or `level=critical`
  - **with-warning**: adds `level=warning` too

This is more reliable than GitHub API because:
- Gets ALL suggestions, not just posted ones
- Has the original `level` classification
- No badge cleanup needed (raw `suggestionContent`)

## How Judging Works

Uses `judge-sonnet.js` — standalone Sonnet judge with the exact withmartian prompt:

```
Golden Comment: {golden_comment}
Candidate Issue: {candidate}
→ {"reasoning": "...", "match": true/false, "confidence": 0.0-1.0}
```

N×M pairwise comparison: each golden comment vs each candidate. 1:1 matching — each golden matches at most one candidate (best confidence wins).

## Results Format

Results are saved to `scripts/benchmark/results/results-{issue-critical,with-warning}.json` with:
- Overall: F1, Precision, Recall, TP, FP, FN
- Per-repo: breakdown by repo with recall
- Per-PR: each PR with:
  - `found` — golden comments matched (TP) with severity
  - `missed` — golden comments not matched (FN) with severity
  - `noise` — candidate comments that didn't match any golden (FP)

## Agent Mode

When the user wants to judge manually (without Sonnet), extract candidates first:

```bash
./scripts/benchmark/benchmark-evaluate.sh 20 --extract-only
```

Then read the files and judge yourself:
- `scripts/benchmark/results/golden.json` — ground truth
- `scripts/benchmark/results/candidates-issue-critical.json` — candidates to judge
- `scripts/benchmark/results/candidates-with-warning.json` — candidates including warnings

For each PR, compare candidates against golden comments using the same judge logic:
1. Same core issue? Accept semantic matches — different wording is fine
2. Not a match if: same code region but different/incorrect reason
3. 1:1 mapping: each golden matches at most one candidate

## First-Time Setup

If the benchmark repos don't exist yet:

```bash
cd scripts/pr-creator
./fork-benchmark-repos.sh ai-code-review-benchmark
```

This forks from `ai-code-review-evaluation`, pushes all branches, and generates `prs.json`.

## Interpreting Scores

- **Precision** — Of all issues Kodus flagged, what % were real bugs?
- **Recall** — Of all known bugs, what % did Kodus find?
- **F1** — Harmonic mean. Balanced score.

Context: Top tools on this benchmark score F1 0.15-0.30. Recall of 0.20+ is competitive.

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Worker not processing | Check `docker logs` for errors, clean inbox: `DELETE FROM kodus_workflow.inbox_messages WHERE status = 'PROCESSING'` |
| RabbitMQ disk alarm | `docker exec rabbitmq rabbitmqctl set_disk_free_limit "1GB"` |
| Sandboxes filling disk | `docker exec worker rm -rf /tmp/kodus-sandbox-*` |
| 401 from Sonnet judge | Check `API_ANTHROPIC_API_KEY` in `.env` — the script loads it automatically |
| PRs not created | Some branches may already have open PRs — script skips those |
| Wrong PR mapping | Extraction matches by branch name (`headBranchRef`), not PR number |
