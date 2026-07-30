# Format eval

Measures the review pipeline's **suggestion content formatter**
(`format-suggestion-content.ts` / `format-prompt.ts`) — the secondary pass that
turns WHAT/WHY/HOW scaffolding into natural prose.

## Why

Cosmetic vs dedup/severity, but under BYOK a weak model can:
- strip technical identifiers (function names, etc.)
- leave scaffold labels
- fail to parse → prod keeps original (silent no-op)

## Metrics (automated — CI-friendly)

| Metric | Meaning |
|---|---|
| `auto_pass_rate` | non-empty + no WHAT/WHY/HOW + idents kept ≥0.5 + length ≤3× |
| `ident_recall_mean` | fraction of original code-ish tokens still present |
| `no_scaffold_rate` | fraction without WHAT/WHY/HOW labels |
| `parse_fail` | unparseable JSON (prod keeps original) |

## Run

```bash
# CI
node evals/format/run.js --mock=perfect --gate
node evals/format/run.js --mock=identity          # baseline: scaffold still present

# Live
node evals/format/run.js --model=gpt-5.4-mini --gate
```

Datasets: `evals/secondary/datasets/`.

## Exit codes

- `0` pass
- `1` quality gate
- `2` infra
