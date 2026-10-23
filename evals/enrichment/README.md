# enrichment

> - **Answers:** Does the enrichment write a fix that the judge passes, no code where none fits, and a title that names the problem?
> - **Runs:** on demand, by hand, while the step is designed (#1821).
> - **Run it:** `RECALL_MODEL=<id> node evals/enrichment/run.js --variant=oneshot` then `node evals/enrichment/judge.js`
> - **Gate:** none yet: the per-model floors in `targets.json` are the reference for the step's eval.
> - **Cost:** one call per finding (150), plus one judge call per answer.

Production's `enrich-content.ts` over the 150 findings of `dataset/items.json`: 100 with a fix
that fits the cited lines and 50 with no correct fix there, each with an Astra reference
(`dataset/references`). `judge.js` grades the answers and `report.py` builds the results page.
