# Secondary-pass eval harness

> - **Answers:** Shared datasets and model registry for the dedup, severity and format evals.
> - **Runs:** through those evals.
> - **Run it:** `node evals/secondary/build-findings-dataset.js <recall-result.json>`
> - **Gate:** none.
> - **Cost:** none.

Shared datasets + model registry for the three review **secondary** passes that
today run on platform `gpt-5.4-mini` and we want to certify for **client BYOK**.

| Pass | Directory | Status |
|---|---|---|
| Dedup | `evals/dedup` | exists + matrix |
| Severity | `evals/severity` | new |
| Format | `evals/format` | new |

See [BYOK-READINESS.md](./BYOK-READINESS.md) for the migration decision matrix.

## Shared pieces

- `datasets/` — smoke PRs committed for CI (mock gates)
- `build-findings-dataset.js` — build full set from finder-recall JSON
- `evals/shared/secondary-models.js` — model registry for A/B

```bash
# rebuild full datasets from a recall run
node evals/secondary/build-findings-dataset.js /tmp/recall.json --out=evals/secondary/datasets
```
