# Dedup eval

> - **Answers:** Does dedup merge findings that are different bugs, so one of them is lost?
> - **Runs:** every engine PR, mocked (`--mock=identity`) and through the engine on the scripted model (`--model=eval-fake`), both in `evals/wiring-smoke.js`.
> - **Run it:** `pnpm eval:dedup:mock` · `pnpm eval:dedup`
> - **Gate:** goldens lost must be 0 (`evals/dedup/run.js`).
> - **Cost:** mock: none. Live: the dedup model plus the judge.

Measures the review pipeline's **deduplication** step: `AgentReviewStage.dedupSuggestionStreams` (`agent-review.stage.ts`), which merges Kody Rule findings by rule, groups the other "same bug" findings with the dedup model on the org's routed model (behind its merge guard), and absorbs a finding into a Kody Rule finding about the same issue. `evals/funnel/dedup` measures the same step on the input a production review gave it; this eval keeps its labelled datasets and its over/under-merge counts.

## What it answers

The dangerous failure of dedup is **over-merge**: collapsing two findings that describe *different* bugs into one group → the dropped one is lost → **recall harm the finder never sees**. The other failure is **under-merge**: leaving true duplicates un-merged → comment spam. This eval quantifies both, plus the good merges.

## Ground truth — golden-anchored (no new labeling, not circular)

Each finding is judge-matched (Sonnet, via `../investigation/recall-judge`) to the PR's golden bugs → every finding gets a `goldenId` (or `-1` = noise). Findings sharing a `goldenId` are true duplicates; findings on different goldens are distinct. Then we run the **real** dedup and check whether its merges respect that grouping. It's non-circular as long as the labeler is a different model than the dedup's.

Headline metric: **goldens lost** = goldens covered by some finding *before* dedup but by no kept finding *after*. Should be **0**.

## Files

- `build-dataset.js` — extract `{prId, findings, goldenComments}` per PR from a finder-recall result JSON (default `/tmp/recall-new-g3.json`) → `datasets/`. Reuses real finder output, no finder re-run.
- `dedup-runner.js` — runs production's step, `AgentReviewStage.dedupSuggestionStreams`, on a stage built as the review builds it, over the team's default config with the model routed as an org's (`evals/shared/review-stage.js` `teamContext`). `kept`/`dropped` are the findings that come out and the ones that do not.
- `dedup-eval.js` — `matchFindingsToGoldens` (the Sonnet labeling) + `computeMetrics` (over/under-merge, goldens lost).
- `run.js` — driver: label (cached) → dedup → score → aggregate.

## Run

```bash
# production's dedup on the managed default, or --model=<tier-0 id> as an org's
# BYOK model (the model's key, the Anthropic judge key, and the platform's
# OpenAI key in API_OPEN_AI_API_KEY for the embedder)
node evals/dedup/build-dataset.js /tmp/recall-new-g3.json   # once, to build datasets
node evals/dedup/run.js --limit=39

# no-dedup-model sanity baselines (judge-only):
node evals/dedup/run.js --mock=identity   # keep-all → goldens lost must be 0
node evals/dedup/run.js --mock=overmerge  # merge-all → shows the harm ceiling
node evals/dedup/run.js --pr=<caseId>     # single PR
```

Golden labels are cached in `.cache-goldenlabels/` (judging is dedup-independent), so iterating on the dedup costs only the dedup model's calls.

## Status

- Metric logic unit-verified (over-merge, under-merge, good-merge scenarios).
- Golden-match + driver validated live on real PRs with the identity mock.
- Seed dataset: 50 PRs / 159 findings (39 with ≥2 findings = dedup-relevant), from the gemini-3-flash NEW-engine recall run.
- **CI**: `--mock=identity --gate` falls back to `evals/secondary/datasets/` smoke set (committed) when the dedup datasets directory (`build-dataset.js` output, not committed) is empty. Full live matrix: `node evals/dedup/run-matrix.js`.
- BYOK migration readiness: see `evals/secondary/BYOK-READINESS.md`.

## Caveats

- The replay/seed is a single finder pass; production dedups a richer aggregated pool. Enrich the dataset by unioning findings across model runs if you want heavier dedup load.
- First-match wins when a finding could map to multiple goldens (findings normally address one bug).
