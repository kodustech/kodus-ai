# Quality signals

Every quality gate writes one row per run to BigQuery `kody-408918.quality.signals`. The
dashboard and the daily digest read it. Nothing is computed there: the producer decides
the status, the table records it. Plan and task list: `docs/quality-signals-plan.md`.

## The row

| Column | Meaning |
|---|---|
| `ts` | when it was measured |
| `source` | producer, `kodus-ai/tests.yml` or `kodus-quality/pull` |
| `name` | `<area>.<gate>[.<dimension>]`, lowercase, dots only |
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

**Names in use.** `unit.jest`, `gate.typecheck`, `gate.di_graph`, `gate.permissions_matrix`,
`gate.env_drift`, `gate.mutation`, `contract.api`, `contract.byok_live`,
`e2e.selfhosted.matrix`, `e2e.cloud`, `e2e.cloud_aws`, `e2e.health`, `evals.wiring`,
`evals.nightly.recall`, `evals.nightly.precision`, `evals.nightly.cost`, `evals.tier0.<model>`,
`evals.benchmark.<model>.f1`, `prod.sentry.<app>.new_issues`, `prod.sentry.<app>.unresolved`,
`prod.posthog.<app>.errors`, `feedback.thumbs_down.count`, `feedback.thumbs_down.rate`,
`review.langfuse.latency_p95`, `review.langfuse.cost_per_review`.

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
      meta: '{"total": ${{ steps.jest.outputs.total }}}'
```

3. Run the workflow once and put the row in the PR description.

A new name needs no schema change. Add it to the list above.

## Ops

- `scripts/quality/bootstrap-gcp.sh`: dataset, service accounts, Workload Identity, repo variables. Idempotent.
- `scripts/quality/apply.sh`: table and views. Idempotent.
- `.github/workflows/quality-signal-smoke.yml`: writes and reads back one row. Run it when auth changes.
- The writer service account can only touch the `quality` dataset. There is no JSON key anywhere.
