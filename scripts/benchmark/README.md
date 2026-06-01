# Code Review Benchmark

Evaluates Kodus code review quality against golden comments from the [withmartian/code-review-benchmark](https://github.com/withmartian/code-review-benchmark).

## Dataset

- **50 PRs** across 5 repositories (10 each): Sentry, Grafana, Cal.com, Discourse, Keycloak
- **128 golden comments** with severity labels (Critical/High/Medium/Low)
- Golden comments in `golden-comments/` — raw data from the benchmark
- `prs-benchmark.json` — 50 PRs in pr-creator format, enriched with golden comments

## Pipeline

```
1. Fork repos          → fork-benchmark-repos.sh (in kodus-ai)
2. Create PRs          → create-test-prs.mjs with prs-benchmark.json
3. Kodus reviews       → automatic via GitHub integration
4. Extract issues      → npx tsx scripts/benchmark/extract.ts
5. Judge results       → npx tsx scripts/benchmark/judge.ts
6. View in agent       → Growth Agent getBenchmarkResults tool
```

## Scripts

### benchmark-suite.sh — Repeat the same run sequentially

Runs `benchmark-create.sh` + waits until all mapped PRs finish + `benchmark-evaluate.sh`, one run at a time.
Before each repeat, it validates that the benchmark-critical containers are up (`api`, `worker`, `webhooks`, `mongodb`, `db_postgres`, `rabbitmq`).

```bash
./scripts/benchmark/benchmark-suite.sh gemini-control 10 5
```

Outputs:
- `results/suites/<base>-<timestamp>/suite-summary.json`
- `results/suites/<base>-<timestamp>/suite-summary.md`
- optional per-run trace exports

### benchmark-preflight.sh — Validate services before the next batch

Checks that the benchmark-critical containers exist and are `running`/`healthy`.

```bash
./scripts/benchmark/benchmark-preflight.sh
```

### wait-for-run.js — Know when the run is done

The run is considered finished when every mapped `prNumber` in `runs/<name>.json` reaches:
- `code_review_execution.stage_name = 'Kody Review Finished'`
- `code_review_execution.status = 'success'`

```bash
node scripts/benchmark/wait-for-run.js gemini-control-r01
```

### analyze-runs.js — Aggregate replicates

Computes mean, standard deviation, min/max/range, and per-PR instability across multiple runs.

```bash
node scripts/benchmark/analyze-runs.js gemini-control-r01 gemini-control-r02 gemini-control-r03
```

### export-trace-metrics.js — Export process metrics

Exports per-PR/per-agent execution metrics from `automation_execution` + `code_review_execution.metadata.agentTrace`.

```bash
node scripts/benchmark/export-trace-metrics.js gemini-control-r01
```

### extract.ts — Extract review comments

Pulls review comments from GitHub PRs and normalizes them into atomic issues using an LLM.

```bash
npx tsx scripts/benchmark/extract.ts --owner ai-code-review-benchmark --tool kodus
```

Options:
- `--owner <org>` — GitHub org with the forked repos (required)
- `--tool <name>` — Label for the review tool (default: "kodus")
- `--output <path>` — Output path (default: candidates.json)
- `--github-token <tok>` — GitHub token (or set GITHUB_TOKEN)

### judge.ts — Evaluate against golden comments

Compares extracted issues against golden comments using an LLM judge.

```bash
npx tsx scripts/benchmark/judge.ts --candidates candidates.json --tool kodus
```

Options:
- `--candidates <path>` — Path to candidates.json (required)
- `--tool <name>` — Tool label (default: "kodus")
- `--output <path>` — Output path (default: results/evaluations.json)

## Output

Results are written to `results/evaluations.json` with:
- Per-PR precision/recall/F1
- Per-repo aggregation
- Per-severity recall breakdown
- Match details with reasoning

## PR Format Compatibility

`prs-benchmark.json` is compatible with the pr-creator in `kodus-ai/scripts/pr-creator/`. The pr-creator reads `repo`, `head`, `base`, and `title` fields — the extra `source_url` and `golden_comments` fields are ignored.

**Note:** PRs with branch names starting with `benchmark-` need their branches created in the forked repos before the pr-creator can use them. The 20 original PRs (from prs-example.json) have existing branches.
