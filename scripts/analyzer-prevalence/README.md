# Analyzer prevalence

How often does each deterministic analyzer apply to a real pull request?

This measures **prevalence**, not capability. It runs each tool's real
`selectFiles` over a uniform sample of merged public PRs and counts how often
the tool would fire at all. No analyzer executes, no model is called, no ground
truth is needed — only filenames and patches, so a run is cheap.

It exists because capability is worthless without it. `evals/security-analyzers/`
showed the rule pack detects real vulnerabilities and the reviewer already
catches **every one** of them; the remaining case for the conditional analyzers
rests entirely on how often the file types they cover actually show up.

## Running it

```bash
node scripts/analyzer-prevalence/sample-prs.mjs sample.json --hours 8 --sample 1200 --seed 7
npx tsx scripts/analyzer-prevalence/measure.ts sample.json --out result.json
node scripts/analyzer-prevalence/check-adoption.mjs result.json
```

The sampling frame is [GH Archive](https://data.gharchive.org) — the public
GitHub event stream, one gzipped file per hour — read directly, so no BigQuery
account is needed. Sampling it avoids the bias in the search API, which caps
every query at a thousand *ranked* results: popular repositories would be
over-represented by construction, and popularity plausibly correlates with the
CI hygiene being measured.

The archived payload is reduced — `pull_request` carries only ids and refs — so
a merged PR is identified by `action === 'merged'`, and author, repository and
files are fetched from the API for sampled PRs only (2 calls each).

## Result

1,200 PRs sampled, 1,064 resolved, **835 usable** after dropping forks, archived
repositories and empty diffs. Seed 7, eight archive hours across Sep 2025 – Aug 2026.

| tool | human-authored (n=614) | bot-authored (n=221) |
|---|---|---|
| secrets | 99.2% | 100% |
| ast-grep | 99.2% *(claimed)* | 100% *(claimed)* |
| rule-pack | 59.3% | 7.7% |
| ruff | 13.5% *(claimed)* | 1.4% |
| dependencies | 9.8% | **32.1%** |
| actionlint | 7.0% | 14.0% |
| zizmor | 7.0% | 14.0% |
| iac | 4.1% | 5.9% |
| openapi | 0.2% | 0.0% |
| protobuf | **0.0%** | 0.0% |
| *any conditional* | 17.9% | 51.1% |

### Corrected for adoption

`ruff` and `ast-grep` run the repository's OWN rules and do nothing without
them, so `selectFiles` is an upper bound for both rather than an answer:

- **ruff**: 15 of 85 repositories with Python in the diff configure it (17.6%)
  → roughly **1.8% of PRs**.
- **ast-grep**: **0 of 250** sampled repositories have `sgconfig.yml`
  → effectively **0% of PRs**.

### Popularity is not driving it

Reported as a sensitivity band rather than a filter, because filtering on stars
would bias toward exactly the hygiene being measured. It turns out not to
matter — the conditional rate is flat from 17.9% (all) to 22.2% (>1000 stars).

## Reading it honestly

- **Bots are lockfile bumps**, which is why `dependencies` triples and
  `any conditional` reaches 51% for them. Blending the two strata produces a
  number that means nothing; they are never quoted together here.
- **`secrets` and `ast-grep` "claim" nearly every PR** because they accept any
  source file. Claiming is not finding: the secret scan produced **zero**
  findings across 47 real PRs in the review benchmark.
- Public GitHub is **not our customer base**. Private company repositories
  plausibly carry more CI and packaging churn than a population diluted by small
  projects, so these figures most likely **understate** prevalence.
- 14 of 835 PRs had file lists truncated at 100 files, a small undercount.
- Archive hours vary in completeness — two of the eight sampled returned no
  events — so the effective frame is roughly six dates rather than eight.
