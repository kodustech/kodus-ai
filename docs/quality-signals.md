# Quality signals

Every quality gate writes one row per run to BigQuery `kody-408918.quality.signals`. The
dashboard and the daily digest read it. Nothing is computed there: the producer decides
the status, the table records it. Plan and task list: `docs/quality-signals-plan.md`.

## The row

| Column | Meaning |
|---|---|
| `ts` | when it was measured |
| `source` | producer, `kodus-ai/tests.yml` or `kodus-quality/pull` |
| `name` | `<area>.<gate>[.<dimension>]`: at least two dot-separated segments of `[a-z0-9_-]`. The action lowercases and folds every other character (e.g. `@` in a model id) to `_`; a name without a dot is rejected and no row is written |
| `status` | `green` `yellow` `red` `skipped` `infra` |
| `value`, `unit` | the number when there is one; `ratio` `count` `usd` `ms` `pct` |
| `run_url` | where a human goes to see why |
| `commit`, `branch` | what was measured |
| `meta` | JSON: breakdowns, failed names, links |

Views: `signals_latest` (last row per name), `signals_daily` (last row per name per day).

**Status.** `green`/`red` is the gate's own verdict. `yellow` is advisory: the gate passed
but something is worth a look (matrix advisories, mutation score under target without
`break`). `skipped` is deliberate (path filter, no key on a fork). `infra` is "could not
measure": quota, missing secret, network. `infra` is never a quality result; the dashboard
shows it grey.

**Names in use** (producer in parentheses).

| Name | Producer | Value |
|---|---|---|
| `unit.jest` | `tests.yml` | failed tests; `meta.total`, `meta.suites_failed` |
| `gate.typecheck`, `gate.di_graph`, `gate.permissions_matrix`, `gate.env_drift` | one workflow each | status only |
| `gate.mutation` | `mutation-gate.yml` | mutation score (pct); yellow under the `low` threshold, skipped when nothing to mutate |
| `contract.api`, `contract.byok_live` | `contract-tests.yml` | status only |
| `e2e.selfhosted.matrix` | `e2e-self-hosted-matrix.yml` (aggregate) | gating failures; status is the scoreboard's |
| `e2e.cloud` | `e2e-cloud.yml` | gating failures; inconclusive or no digest = infra |
| `e2e.cloud_aws`, `e2e.health` | `e2e-cloud-aws.yml`, `e2e-health-report.yml` | status / history rows |
| `evals.wiring` | `code-review-evals-pr.yml` | status only |
| `evals.nightly.recall`, `evals.nightly.precision` | `code-review-evals-nightly.yml` (notify) | ratio; status from the nightly verdict |
| `evals.tier0.<model>` | `code-review-evals-tier0.yml` (one row per matrix model) | review seconds (ms); red when review or PR summary is broken |
| `evals.benchmark` | `code-review-model-benchmark.yml` | lowest F1 across models; `meta.models` has each model's precision/recall/f1 |
| `prod.errors.<group>`, `.total`, `.noise`, `.new_signatures`, `.spikes` | kodus-insights `nightly-errors.yml` (CloudWatch) | counts |
| `prod.betterstack.monitors_down` | kodus-quality `pull.yml` | count |
| `feedback.thumbs_down.count`, `.rate` | kodus-quality `pull.yml` | 24h |
| `feedback.thumbs_down.weekly.*` | kodus-insights weekly job | week |
| `review.langfuse.<agent>.latency_p95`, `.cost_per_review` | kodus-quality `pull.yml` | per review agent |

Reusable workflows (`e2e-self-hosted-matrix`, `e2e-cloud`, `code-review-model-benchmark`) report from inside, so every caller grants `id-token: write` to the calling job.

## Adding a signal from a workflow

1. Give the workflow `permissions: id-token: write`.
2. At the end of the job, after the step that knows the result:

```yaml
- name: Report quality signal
  if: always()
  uses: ./.github/actions/report-signal
  with:
      name: unit.jest
      status: ${{ job.status }}          # or green|yellow|red|skipped|infra when you know better
      value: ${{ steps.jest.outputs.failed }}
      unit: count
      meta: '{"total": ${{ steps.jest.outputs.total || 0 }}}'   # empty output would break the JSON
      gcp_wif_provider: ${{ vars.GCP_WIF_PROVIDER }}   # a composite action cannot read vars
      gcp_sa_email: ${{ vars.GCP_SA_EMAIL }}
      gcp_project: ${{ vars.GCP_PROJECT }}
```

3. Run the workflow once and put the row in the PR description.

A new name needs no schema change. Add it to the list above.

## Ops

- `scripts/quality/bootstrap-gcp.sh`: dataset, service accounts, Workload Identity, repo variables. Idempotent.
- `scripts/quality/apply.sh`: table and views. Idempotent.
- `.github/workflows/quality-signal-smoke.yml`: writes and reads back one row. Runs on PRs that touch the action; run it by hand when auth changes.
- The writer service account can only touch the `quality` dataset. There is no JSON key anywhere.
