# Secondary-pass eval harness

> - **Answers:** Shared datasets for the dedup and severity evals.
> - **Runs:** through those evals.
> - **Run it:** `node evals/secondary/build-findings-dataset.js <recall-result.json>`
> - **Gate:** none.
> - **Cost:** none.

Shared datasets for the review's **secondary** passes, which run on the org's
routed model (its BYOK model, else the managed default) and we want to certify
for **client BYOK**. The models route through `evals/shared/tier0-models.js`.

| Pass | Directory | Status |
|---|---|---|
| Dedup | `evals/dedup` | exists + matrix |
| Severity | `evals/severity` | new |
| Format | `evals/format` | own cases (`evals/format/batches.json`), production formatter |

See [BYOK-READINESS.md](./BYOK-READINESS.md) for the migration decision matrix.

## Shared pieces

- `datasets/` — smoke PRs committed for CI (mock gates)
- `build-findings-dataset.js` — build full set from finder-recall JSON

```bash
# rebuild full datasets from a recall run
node evals/secondary/build-findings-dataset.js /tmp/recall.json --out=evals/secondary/datasets
```
