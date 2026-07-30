# Severity eval

Measures the review pipeline's **severity reclassification** step
(`classify-severity.ts` / `severity-prompt.ts`) — the secondary pass that
overwrites agent-assigned severity before `severityLevelFilter` and PR posting.

## Why

Under-severity is **silent recall loss**: a real bug reclassified from `high` →
`low` is filtered out of the PR when the org threshold is `high`. This is the
headline risk of routing severity through client BYOK instead of platform
`gpt-5.4-mini`.

## Metrics

| Metric | Meaning |
|---|---|
| `exact_acc` | fraction matching judge severity |
| `ordinal_mae` | mean \|rank_pred − rank_judge\| |
| **`filter_false_drop@high`** | would pass filter under judge, fails under model — **must be 0** |
| `filter_false_drop@medium` | same at medium threshold |
| `parse_fail` | model returned unparseable JSON (defaults all medium in prod) |

Judge for the smoke set is a **heuristic** (content cues + agent severity) so
`--mock=heuristic` and CI need no LLM keys. Live multi-model runs should swap in
an LLM judge (≠ candidate) before trusting BYOK readiness numbers.

## Run

```bash
# CI / no keys
node evals/severity/run.js --mock=heuristic --gate
node evals/severity/run.js --mock=all-medium --gate   # expect false_drop if goldens are high
node evals/severity/run.js --mock=agent

# Live (needs model key from secondary-models.js)
node evals/severity/run.js --model=gpt-5.4-mini --gate
```

Datasets: `evals/secondary/datasets/` (shared with format/dedup smoke).

## Exit codes

- `0` pass
- `1` quality gate (`filter_false_drop@high` or parse fails)
- `2` infra (missing datasets, model/key error)
