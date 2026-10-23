# severity

> - **Answers:** Which severity prompt rates a suggestion at the level its text defines, on each model?
> - **Runs:** on demand, by hand, while the prompt is designed (#1821); the step's eval is `evals/severity-levels`.
> - **Run it:** `RECALL_MODEL=<id> node evals/severity/run.js --prompt=<version> [--samples=N] [--levels=high]`
> - **Gate:** none: a research harness that compares prompt versions, not a floor.
> - **Cost:** one call per PR and sample, 75 calls per sample for the 205 suggestions.

The prompt versions of #1821 (`prompts.js`; `prod` is the criteria prompt teams with their own
flags still get) over the severity dataset (`dataset/items.json`), each suggestion rated from
its text against `definitions.md`. `report.py` builds the results page from `results/` and
`tests.json`. Test 17b is what production runs (`severity-prompt.ts`), measured by
`evals/severity-levels`.
