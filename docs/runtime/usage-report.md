# Runtime usage report

What one org's Kody Runtime used in one UTC month, to price it: Runs, setups and sandbox sessions, machine time,
LLM tokens and their cost. Owner only. Terms are in [glossary.md](glossary.md).

- API: `GET /runtime/settings/usage?month=YYYY-MM&repositoryId=&environmentId=` and `GET /runtime/settings/usage/export`
  (same query, CSV, one line per Run). `checkRole(OWNER)`, in the RBAC manifest. 503 without `RUNTIME_DATABASE_READ_URL`.
- Screen: Kody Runtime → Settings → Usage (`/runtime/settings/usage`).
- Code: `libs/runtime/api/domain/usage-report.ts` (every formula), `application/use-cases/usage-report.use-case.ts`,
  `infrastructure/pg-runtime-usage-report.reader.ts`, `infrastructure/telemetry-llm-spend.reader.ts`.

## Sources

| Figure | Source | Read with |
|---|---|---|
| Runs, trigger, verdict, wall time, boot phases | `runtime.runtime_runs` (requested in the month) | read-only role, `runtime_runs_org_requested_idx` |
| Machine time of Runs | `runtime.runtime_claims` of those Runs, wherever the claim fell | `runtime_claims_run_idx` |
| Setups, sandbox sessions, MCP, custom agents | `runtime.runtime_claims` created in the month, by `consumer` | `runtime_claims_org_created_idx` (migration 23) |
| Repository of a setup claim | `runtime.runtime_environment_setups.repository_id` of its environment | join |
| Start of a claim (cold, pool, bake) | `runtime.runtime_claims.start_source`, from the cell's `claim.ready` `start` (feature `readyStart`) | migration 24 |
| vCPUs of a claim | `runtime.runtime_claims.cpus`: the claim's size, else the cell's hello `capabilities.defaultSize` | migrations 23, 24 |
| Sandbox operations | `runtime.runtime_sandbox_audit` of the month | `runtime_sandbox_audit_org_at_idx`, read-only grant |
| LLM tokens and US$ | the usage spans `LLM.run` writes to `observability_telemetry` (`attributes.tu.route = 'runtime'`) | `TokenUsageRepository.getRuntimeUsage`, the Token Usage read |
| LLM prices | `PricingResolver` (LiteLLM + models.dev) and the org's manual overrides, as Token Usage | per call's tier |
| Host price of a shared cell | `RUNTIME_CELL_PRICES` | config |
| Unit price of machine time | `RUNTIME_MACHINE_USD_PER_GB_MINUTE`, `RUNTIME_MACHINE_USD_PER_VCPU_MINUTE` (default 0 = not set) | config |

The gateway's budget counters (`runtime_llm_budget`) are for limits only; nothing in the cost or the report reads them.

## Formulas

- **Run wall time**: `finishedAt − requestedAt` (queue and capacity wait included). p50/p95 are nearest-rank over the
  month's finished Runs. A setup or sandbox session's wall time is its claim's `admitted_at` to its end.
- **Setups**: setup claims (`consumer = 'setup'`). A repair or a learn boot of the same setup counts again: the Runtime
  keeps one `runtime_environment_setups` row per environment, not one per setup (see "Not measured yet").
- **Start of a Run**: the coldest start its claims said (`cold`, then `bake`, then `pool`; `runStartOf`). A claim says
  `pool` when it adopted a ready pool machine, `bake` when a base booted a bake its cell made, else `cold`. Null when no
  claim said (a cell older than `readyStart`, a claim that never got ready, rows from before migration 24).
- **Sandbox operations**: rows of `runtime_sandbox_audit` stamped in the month: the total, the refused and the failed,
  and the sum of their durations. Null under a repository or environment filter, and when the read-only role cannot read
  the table (the report still answers). `partial` when the month starts more than 30 days ago (the audit's retention).
- **Sandbox sessions**: sandbox claims. Not tied to a repository, so `null` under a repository or environment filter.
- **GB·min** of a claim: MB × minutes at its build size until ready, at its ready size after (`claimMbMinutes`), ÷ 1024.
- **vCPU·min** of a claim: its machine size's vCPUs (`runtime_claims.cpus`) × minutes from admission to its end. A
  claim at the cell's default size counts the default's vCPUs when the cell's hello says them; a fractional default
  (`-gvisor-cpus 1.5`) counts by its whole part, as the cell's maximum does.
- **Build minutes**: admission until ready, or until the end of a claim that never got ready.
- A claim's end: `released_at`; while open, now (never past `hard_expires_at`); failed or blocked, `state_changed_at`.
- **Machine host estimate**: per claim on a Kodus-managed cell, `MB·min / allocatable MB × host US$/h ÷ 60`.
- **Machine cost at the unit price**: `GB·min × usdPerGbMinute + vCPU·min × usdPerVcpuMinute`, only when one is above 0.
- **LLM US$ of a span bucket**: each tier bracket at its own rate (`ModelCostCalculator.bucketCost`); a prompt above a
  model's threshold (Claude, Gemini over 200K) is priced entirely at that tier, as the provider bills it. Cache reads
  and writes come off the full-price input. BYOK spans (`isByok`) are the org's spend, managed ones Kodus's.
- **Agent** of a span (`runtimeLlmAgentOf`): recipe author, test planner, Run agent (`runtime.plan` and its model
  turns), finding intent, setup learning.
- **Per Run**: the Run cost the Run page shows (`RuntimeRunCostService`, same spans, same claims).
- **Cost to Kodus for the month**: host estimate of every claim on a Kodus cell + the managed LLM US$. A lower bound
  while `cost.complete` is false.

The CSV leaves a cell empty where nothing was measured. A value that starts with `=`, `+`, `-`, `@`, tab or CR is
written with a leading `'`.

## Limits

- At most 2 000 Runs listed per report (the counts cover all) and 20 000 claim rows per kind (`claimsTruncated`).
- Spans are attributed by `attributes.runId`. A Run's per-Run LLM reads its spans from an hour before it was requested
  to an hour after it ended; the month's totals read the spans stamped in the month.

## Not measured yet

- **Start and default-size vCPUs before the cell says them.** A cell older than `readyStart` and `defaultSize`, and rows
  from before migrations 23 and 24, leave `start` null and the vCPUs of a default-size claim unmeasured.
- **Machine time on aws-ec2 cells** records no memory, so no GB·min (the Run page prices it per VM instead).
- **Customer cells.** Held time is counted. It is priced only once the org sets its price per host-hour in Runtime
  settings: a shared cell by the share of the host each claim held, at that price. An aws-ec2 customer cell stays
  unpriced (the product does not know the size of its VMs).
- **Spans written before the runtime route was stamped on the harness agents** (recipe author and test planner on the
  managed default): no `route`, no `runId`; they are in Token Usage but not here.
- **Setups as their own unit.** No row per setup, and the data does not allow one: a setup claim's id is a hash of its
  idempotency key (`setup:<key>`, `setup:<key>:repair-N`, `setup:<key>:<learn label>`), so the claims of one setup
  cannot be grouped back, and parsing the key out of the idempotency key is ambiguous (a key may hold `:`). What it
  needs: the setup's acquires carry its learn scope (`setupLearnScopeId(key)`, the id its recipe-author spans already
  carry as `runId`), the hub writes it on the claim row (a `setup_scope` column), and the report groups setup claims by
  it, one row per setup with its boots, machine time and LLM. Rows written before stay one per claim.
- **Storage, egress bytes, evidence uploads, observers, the hub and the API**: no source.
