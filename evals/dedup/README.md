# Dedup eval

> - **Answers:** Does dedup merge findings that are different bugs, so one of them is lost?
> - **Runs:** every engine PR, mocked (`--mock=identity`) and through the engine on the scripted model (`--model=eval-fake`), both in `evals/wiring-smoke.js`.
> - **Run it:** `pnpm eval:dedup:mock` · `pnpm eval:dedup`
> - **Gate:** goldens lost must be 0 (`evals/dedup/run.js`).
> - **Cost:** mock: none. Live: the dedup model plus the judge.

Measures the review pipeline's **deduplication** step (`agent-review.stage.ts#deduplicateSuggestions`) — the LLM pass (`gpt-5.4-mini`) that groups "same bug" suggestions and keeps one representative per group. The `evals/investigation` recall eval explicitly does **not** cover this downstream step; this fills that gap.

## What it answers

The dangerous failure of dedup is **over-merge**: collapsing two findings that describe *different* bugs into one group → the dropped one is lost → **recall harm the finder never sees**. The other failure is **under-merge**: leaving true duplicates un-merged → comment spam. This eval quantifies both, plus the good merges.

## Ground truth — golden-anchored (no new labeling, not circular)

Each finding is judge-matched (Sonnet, via `../investigation/recall-judge`) to the PR's golden bugs → every finding gets a `goldenId` (or `-1` = noise). Findings sharing a `goldenId` are true duplicates; findings on different goldens are distinct. Then we run the **real** dedup and check whether its merges respect that grouping. It's non-circular because the labeler (Sonnet) is a different model than the dedup (`gpt-5.4-mini`).

Headline metric: **goldens lost** = goldens covered by some finding *before* dedup but by no kept finding *after*. Should be **0**.

## Files

- `build-dataset.js` — extract `{prId, findings, goldenComments}` per PR from a finder-recall result JSON (default `/tmp/recall-new-g3.json`) → `datasets/`. Reuses real finder output, no finder re-run.
- `dedup-runner.js` — invokes the **real** dedup decision: the live prompt+schema from `libs/code-review/infrastructure/agents/engine/dedup-prompt.ts` through `LLM.run`, the same entry point the stage calls, so the executor's structured-output recovery is measured too. The model routes through `evals/shared/tier0-models.js`. Derives `kept`/`dropped` from the model's `groups`/`unique`.
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
- **CI**: `--mock=identity --gate` falls back to `evals/secondary/datasets/` smoke set (committed) when the dedup datasets directory (`build-dataset.js` output, not committed) is empty. Full live matrix: `node evals/dedup/run-matrix.js`.
- BYOK migration readiness: see `evals/secondary/BYOK-READINESS.md`.

## Caveats

- The replay/seed is a single finder pass; production dedups a richer aggregated pool. Enrich the dataset by unioning findings across model runs if you want heavier dedup load.
- First-match wins when a finding could map to multiple goldens (findings normally address one bug).

## Duplicate gold (`gold/`)

A second ground truth that covers every finder suggestion, golden or not: per model, which suggestions of the same PR are duplicates of each other. One file per model in `gold/` (`deepseek-v4.1-flash`, `kimi-k3`, `muse-spark-1.2`, `gpt-6.1-sol`, `sonnet-5.5`, `opus-5.5`, `glm-5.3`), built from the finder output that feeds the dedup (G + M3, heavysv pools).

- Criterion: `gold/judge-prompt.md`. Three kinds (`same_location`, `cross_location`, `systemic_pattern`), all duplicates. A suggestion that is part of another, or that shares a reported defect with it, is a duplicate too; `needsUnifiedComment` marks groups whose merged comment must carry every location or defect. Two pilot groups were split by the reviewer because one suggestion only mentioned the other defect as context or inside its fix (`gold/human-overrides.json`); the prompt does not state that limit yet.
- Labeling: two blind judges (Opus 5.5 via Claude Code, GPT-6 Astra via Codex, both on subscription, no tools) in `gold/judge.js`; agreement stays, disagreements go by component to an Opus arbiter in `gold/reconcile.js`. Human corrections live in `gold/human-overrides.json` and survive a re-reconcile.
- Human review: `gold/review-data.js` builds the review page data, `gold/review/second-check.js` re-checks every unique suggestion, `gold/apply-decisions.js` writes the reviewer's decisions (`gold/review/decisions-pilot.json`) into the gold.
- Status: pilot labeled and fully human-reviewed (5 PRs, one per repo, for `muse-spark-1.2` and `gpt-6.1-sol`). The other PRs and models are still unlabeled.

```bash
node evals/dedup/gold/build-gold.js
node evals/dedup/gold/judge.js --judge=opus --models=<model> --prs=<caseId,...>
node evals/dedup/gold/judge.js --judge=astra --models=<model> --prs=<caseId,...>
node evals/dedup/gold/reconcile.js --models=<model> --arbitrate --write
```
