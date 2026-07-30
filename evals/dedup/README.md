# Dedup eval

Measures the review pipeline's **deduplication** step (`agent-review.stage.ts#deduplicateSuggestions`) — the LLM pass (`gpt-5.4-mini`) that groups "same bug" suggestions and keeps one representative per group. The `evals/investigation` recall eval explicitly does **not** cover this downstream step; this fills that gap.

## What it answers

The dangerous failure of dedup is **over-merge**: collapsing two findings that describe *different* bugs into one group → the dropped one is lost → **recall harm the finder never sees**. The other failure is **under-merge**: leaving true duplicates un-merged → comment spam. This eval quantifies both, plus the good merges.

## Ground truth — golden-anchored (no new labeling, not circular)

Each finding is judge-matched (Sonnet, via `../investigation/recall-judge`) to the PR's golden bugs → every finding gets a `goldenId` (or `-1` = noise). Findings sharing a `goldenId` are true duplicates; findings on different goldens are distinct. Then we run the **real** dedup and check whether its merges respect that grouping. It's non-circular because the labeler (Sonnet) is a different model than the dedup (`gpt-5.4-mini`).

Headline metric: **goldens lost** = goldens covered by some finding *before* dedup but by no kept finding *after*. Should be **0**.

## Files

- `build-dataset.js` — extract `{prId, findings, goldenComments}` per PR from a finder-recall result JSON (default `/tmp/recall-new-g3.json`) → `datasets/`. Reuses real finder output, no finder re-run.
- `dedup-runner.js` — invokes the **real** dedup decision. Loads the live prompt+schema+model from `libs/code-review/infrastructure/agents/engine/dedup-prompt.ts` (extracted from the stage so production and this eval share one prompt — no drift). Derives `kept`/`dropped` from the model's `groups`/`unique`.
- `dedup-eval.js` — `matchFindingsToGoldens` (the Sonnet labeling) + `computeMetrics` (over/under-merge, goldens lost).
- `run.js` — driver: label (cached) → dedup → score → aggregate.

## Run

```bash
# real dedup (needs OpenAI key + Anthropic judge key, from ~/.kodus-dev/config)
node evals/dedup/build-dataset.js /tmp/recall-new-g3.json   # once, to build datasets
node evals/dedup/run.js --model=gpt-5.4-mini --guard=content --contentthresh=0.3 --limit=39

# no-dedup-model sanity baselines (judge-only):
node evals/dedup/run.js --mock=identity   # keep-all → goldens lost must be 0
node evals/dedup/run.js --mock=overmerge  # merge-all → shows the harm ceiling
node evals/dedup/run.js --pr=<caseId>     # single PR
```

Golden labels are cached in `.cache-goldenlabels/` (judging is dedup-independent), so iterating on the dedup costs only gemini calls.

## Status

- Metric logic unit-verified (over-merge, under-merge, good-merge scenarios).
- Golden-match + driver validated live on real PRs with the identity mock.
- Seed dataset: 50 PRs / 159 findings (39 with ≥2 findings = dedup-relevant), from the gemini-3-flash NEW-engine recall run.
- **CI**: `--mock=identity --gate` falls back to `evals/secondary/datasets/` smoke set (committed) when `evals/dedup/datasets/` is empty. Full live matrix: `node evals/dedup/run-matrix.js`.
- BYOK migration readiness: see `evals/secondary/BYOK-READINESS.md`.

## Caveats

- The replay/seed is a single finder pass; production dedups a richer aggregated pool. Enrich the dataset by unioning findings across model runs if you want heavier dedup load.
- First-match wins when a finding could map to multiple goldens (findings normally address one bug).
