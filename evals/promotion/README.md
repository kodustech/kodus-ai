# Promotion Evals

Promptfoo harness for evaluating the post-investigation decision boundary.

This suite is intentionally narrower than `evals/investigation`:
- `investigation` asks whether the model explored the right places
- `promotion` asks whether the model should keep or drop a candidate once evidence is frozen

Current scope:
- `verification` mode only
- input = frozen benchmark candidate + frozen diff/file evidence
- output = `keep/drop` JSON with rationale + confidence

What this is for:
- measure whether a prompt or verifier threshold makes the model too eager to keep speculative findings
- compare models on precision-sensitive keep/drop decisions without rerunning full planner behavior
- isolate verifier/promotion regressions from planner regressions

Smoke run:

```bash
pnpm run eval:promotion
```

List datasets:

```bash
pnpm run eval:promotion --list-datasets
```

List model presets:

```bash
pnpm run eval:promotion --list-presets
```

Run one dataset:

```bash
pnpm run eval:promotion:no-cache \
  --dataset async-import-of-the-appstore-packages-cal-com.json \
  --preset gemini-3.1-pro
```

Run all datasets:

```bash
pnpm run eval:promotion:all:no-cache \
  --preset gpt-5.4 \
  --preset gemini-3.1-pro
```

Generate a verification dataset from a benchmark run plus an existing investigation seed:

```bash
pnpm run eval:promotion:extract \
  --run gemini-planner-r01-r01 \
  --title "Async import of the appStore packages"
```

Dataset notes:
- extractor joins benchmark candidates with `match-matrix.json`
- each emitted candidate becomes one verification case
- `expectedKeep=true` when that candidate matches at least one golden issue
- frozen evidence is derived from the existing investigation dataset for the same PR title

Artifacts from the latest run:
- `results/last-output.json`
- `results/last-assertion.json`
- `results/last-error.json`

Important:
- this suite does not currently rerun planner tools
- it measures keep/drop judgment from frozen evidence
- a future `promotion-from-evidence` mode can sit beside this one once we want full finding generation from frozen evidence
