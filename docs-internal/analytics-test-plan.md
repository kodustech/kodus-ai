# Analytics Cockpit — Test Plan

This document covers the test strategy for the `analytics-selfhosted` branch: the in-process cockpit + ingestion pipeline that replaces `kodus-service-analytics` + Airbyte + BigQuery.

Unit tests (Tier 1) live alongside the code in `test/unit/...` and run on every PR via CI; they're **not** covered here. This plan focuses on what we cannot mock away:

- **Tier 2** — local integration against real Postgres and Mongo (Docker)
- **Tier 3** — staging against realistic data volumes and parity vs. BigQuery
- **Tier 4** — production canary rollout

Each tier validates properties the previous one cannot. Skipping a tier means accepting risk.

---

## Topology decisions (read first)

| Environment   | Postgres analytics       | Why |
|---------------|--------------------------|-----|
| Local dev     | shared with OLTP, schema `analytics` | Same shape as self-hosted; zero infra |
| Staging       | **shared with OLTP**, schema `analytics` | No dedicated RDS — saves cost, doubles as self-hosted validation, stresses contention |
| Self-hosted   | shared with OLTP, schema `analytics` | One Postgres on the customer's box |
| Production cloud | **dedicated RDS instance** | Blast-radius isolation; OLTP write path can't be disturbed by analytic queries / backfill |

The code path is identical — only `ANALYTICS_PG_DB_HOST` env decides. Staging therefore proves the self-hosted scenario for free, and the only thing prod uniquely tests (a separate physical instance) is verified by the `/cockpit/health` smoke check on first boot.

---

## Pre-flight checklist

Before running any tier:

- [ ] `analytics-selfhosted` branch checked out
- [ ] `docker-compose.dev.yml` and `docker-compose.override.yml` present
- [ ] `.env` exists (copy from `.env.example` if needed)
- [ ] All `as_*` containers up: `yarn docker:start`
- [ ] `as_kodus_api` started after `API_ANALYTICS_ALLOW_TRIGGER=true` was added to the override (you may need to restart the API container once)
- [ ] Mongo Atlas indexes (`{updatedAt:1, _id:1}` and `{createdAt:1}` on `pullRequests`) — for Tier 3+

---

## Tier 2 — Local integration

**Goal**: validate the ingestion pipeline against real Postgres and Mongo using synthetic data, on a developer machine.

**Tooling**:

- `yarn analytics:seed-test` — inserts synthetic PRs into Mongo (tagged `analytics-test-*` so reset only touches them).
- `POST /cockpit/admin/trigger-ingestion` — fires an ingestion run on demand (gated by `API_ANALYTICS_ALLOW_TRIGGER=true`).
- `yarn analytics:parity-check` — compares Mongo and Postgres row counts per organization.
- `yarn analytics:test-suite` — runs all Tier-2 cases below in sequence with PASS/FAIL output.

**Time**: ~5 minutes for the full suite.

### Test cases

| ID    | What it validates | Expected outcome |
|-------|-------------------|------------------|
| T2.1  | Happy path: 50 PRs in 1 org ingest cleanly | `pull_requests_opt` count = 50; run status = `ok`; tuple watermark `_id` populated |
| T2.2  | Tuple watermark survives same-timestamp ties | Both PRs at the same `updatedAt` end up in Postgres |
| T2.3  | Quarantine: a PR with `organizationId = NULL` is isolated | The 10 good PRs ingest; the bad one lands in `ingestion_errors`; run status `ok` or `partial` |
| T2.4  | Idempotency: a re-trigger does no extra work | Row count unchanged; second run scans 0 |
| T2.5  | Org-scoped trigger only ingests the requested tenant | Only the targeted org appears in Postgres |
| T2.6  | `/cockpit/health/runs` reflects the latest run | Endpoint returns the run that just executed |
| T2.7  | Parity check passes against synthetic data | `analytics:parity-check` exit code 0 |
| T2.8  | `/cockpit/health` is publicly reachable (no JWT) | HTTP 200 from a plain curl |
| T2.9  | The trigger endpoint is gated by `API_ANALYTICS_ALLOW_TRIGGER` | Without the env, returns 403 (manual verification) |

### How to run

```bash
# Full suite
yarn analytics:test-suite

# Single test
yarn analytics:test-suite T2_3
```

### Manual checks (Tier 2)

These supplement the automated suite — humans are still cheaper than test infrastructure for some things:

- **Visual smoke of the cockpit web UI** — open `http://localhost:3010`, log in, navigate to the cockpit. Confirm charts render with synthetic data (after seeding + triggering).
- **One real cockpit endpoint with JWT** — pick any of `/code-health/charts/*` or `/productivity/charts/*`, generate a JWT via login, curl it, eyeball the JSON shape.
- **Quarantine spelunking** — after T2.3, inspect `analytics.ingestion_errors.raw` to confirm the original Mongo doc was preserved verbatim (this is what makes manual replay possible later).

### Exit criteria for Tier 2

- All automated test cases PASS for 3 consecutive runs.
- Manual checks above show no regressions.
- No unexpected entries in `analytics.ingestion_errors`.

---

## Tier 3 — Staging integration

**Goal**: validate against realistic data volume, real infrastructure, and confirm parity with the existing BigQuery-backed cockpit.

**Topology choice for staging — NO dedicated RDS.** Staging reuses the existing OLTP Postgres with the `analytics` schema scoped on the same instance. This is the same shape self-hosted clients run, so Tier 3 doubles as self-hosted validation. The dedicated-RDS topology is reserved for production cloud, where blast-radius isolation justifies the cost.

Trade-offs of this choice:

- ✅ Zero extra infra cost for staging.
- ✅ Validates self-hosted code path simultaneously.
- ✅ Stresses lock / connection-pool contention between OLTP and analytics — a stricter test than two isolated instances.
- ⚠️ Doesn't validate "2 RDS instances connect correctly in cloud" — but that risk is the env var `ANALYTICS_PG_DB_HOST` resolving to a different host. Negligible code surface; covered by `/cockpit/health` smoke check on first prod deploy.

**Pre-requisites**:

1. ECS task `worker-analytics` deployed alongside the existing `worker` task (same image, env `WORKER_ROLE=analytics`).
2. Staging environment vars on both the API and `worker-analytics` tasks:
   ```
   ANALYTICS_PG_DB_HOST=         # empty → cascades to API_PG_DB_HOST
   ANALYTICS_PG_DB_SCHEMA=analytics
   API_ANALYTICS_ALLOW_TRIGGER=true   # only if you want HTTP triggers from the parity harness
   ```
3. `RUN_MIGRATIONS=true` on first deploy, or run `yarn analytics:migration:run:prod` manually once.
4. Mongo Atlas (staging) restored from a recent production snapshot.
5. Mongo Atlas indexes created in background:
   ```js
   db.pullRequests.createIndex({ updatedAt: 1, _id: 1 }, { background: true });
   db.pullRequests.createIndex({ createdAt: 1 }, { background: true });
   ```
6. `kodus-service-analytics`, Airbyte, and BigQuery still running in staging — they're the parity reference.

### Test cases

#### T3.1 — Migration runs cleanly on the existing Postgres

```bash
yarn analytics:migration:run:prod
```

Expected:
- Schema `analytics` exists alongside the existing `public` schema.
- One row in `analytics.migrations` (`InitAnalyticsSchema2026042000000`).
- All 8 tables present with expected indexes.
- `public.*` (OLTP) tables untouched.

#### T3.2 — Mongo Atlas index creation does not impact OLTP

While the index is building (could be hours on a real collection):

- Monitor webhook latency p95 and p99 on the existing review pipeline. **Must not regress.**
- Monitor Atlas IOPS and CPU on primary and secondary.
- `db.currentOp()` confirms the index is `building: true` and progresses.

#### T3.3 — Backfill of staging Mongo

```bash
# Estimate volume first
db.pullRequests.estimatedDocumentCount();

# Run in a maintenance window
yarn analytics:backfill --step-days 7 --pause-ms 5000
```

Live metrics to track (extra-vigilant in staging because the analytics
write path shares the OLTP Postgres):

- `analytics.backfill_progress.cursor_at` advances monotonically.
- WAL bytes/sec on the shared Postgres (CloudWatch / RDS Performance Insights).
- Postgres connection pool saturation — backfill must not exhaust the OLTP pool.
- Postgres autovacuum lag — the bursty UPSERTs from backfill can starve vacuum.
- **Webhook p95 latency on the OLTP pipeline** (must not regress; this is the
  smoking gun for "shared Postgres can't take it" — if it bumps in staging,
  prod will need to keep its dedicated RDS).
- Mongo Atlas secondary CPU + IOPS.

Final assertions:

- `pull_requests_opt` row count within 0.5% of `db.pullRequests.estimatedDocumentCount()`.
- `yarn analytics:parity-check --threshold 0.005` passes for all orgs.
- OLTP webhook latency p95 unchanged vs. baseline 24h before backfill.

#### T3.4 — Daily cron runs stable for 48 hours

After T3.3, leave the cron at default (`EVERY_30_MINUTES`).

Monitor `/cockpit/health/runs`:

- `lagHours` < 0.5 (one cycle).
- `failedLast24h` = 0.
- `quarantinedLast24h` baseline established (depends on data quality of staging Mongo); flag investigation if it spikes.

#### T3.5 — Parity vs. BigQuery (the critical one)

For each combination of:

- **5 representative orgs** (1 large, 1 medium, 3 small)
- **5 critical endpoints**: `bug-ratio`, `deploy-frequency`, `lead-time-for-change`, `suggestions-by-category`, `dashboard/company`
- **3 time windows**: last 7 days, last 30 days, last 90 days

Total: **75 comparisons**.

Procedure:

1. Call the new internal endpoint (returns from Postgres).
2. Call the legacy `kodus-service-analytics` endpoint (returns from BigQuery).
3. Diff the responses.

**Pass thresholds**:

- Count-based metrics (PRs, suggestions, commits): drift < 1%.
- Time-based metrics (lead time, deploy frequency): drift < 5% (BigQuery may use different timezone bucketing).

A separate script (`scripts/analytics/parity-vs-bq.ts`, to be added) automates calling both endpoints and printing diffs. **Human review is required** for any drift outside threshold to determine whether it's a real bug or an acceptable formatting/timezone difference.

#### T3.6 — Visual chart comparison

Open the cockpit web UI in staging with the PostHog flag `cockpit-internal-source=true` for one staging org. Compare each chart side-by-side with the legacy version (flag off, served by `kodus-service-analytics`).

Look for:

- Numbers match.
- Chart shape matches.
- Drill-down works.
- No console errors.
- Latency feels comparable.

This is **manual** because chart-rendering bugs (axes, tooltip formatting, color mapping) are visible to a human and invisible to a parity script.

#### T3.7 — Failover simulation

```bash
# Stop the analytics worker
docker stop worker-analytics-task

# Wait 1 hour (let lag accumulate)

# Bring it back up
docker start worker-analytics-task
```

Expected:

- Cron resumes on the next tick.
- `lagHours` returns to < 0.5 within ~30 minutes.
- No data loss (parity-check still passes).

#### T3.8 — Quarantine fires for real

Manually inject a doc into staging Mongo with a defect (e.g. `organizationId: null`).

Expected on the next cron tick:

- The bad doc lands in `analytics.ingestion_errors`.
- The run completes with status `ok` or `partial`.
- Watermark advances.
- Other docs in the same batch are unaffected.

### Manual obligations (Tier 3)

- **T3.5** is non-negotiable manual review. 75 number pairs need a human deciding "this drift is acceptable" or "this is a bug".
- **T3.6** chart-by-chart visual comparison.
- The decision to advance to Tier 4 is a human judgment call based on T3.5 results.

### Exit criteria for Tier 3

- T3.1 through T3.8 all pass.
- T3.5 has zero unresolved drifts above threshold.
- 48 hours of stable cron with `lagHours < 0.5`.

---

## Tier 4 — Production canary rollout

**Goal**: validate against real users with controlled blast radius before enabling for everyone.

**Pre-requisites**:

- Tier 3 fully green.
- Production RDS analytics provisioned and verified.
- Production migration applied.
- Production backfill completed and parity-check passes.
- 48 hours of stable cron in production.
- BetterStack alerts wired up: `lagHours > 1`, `failedLast24h > 0`, `quarantinedLast24h > 100` (tune the last threshold based on staging baseline).

### Phases

#### T4.1 — Dogfood (Kodus internal org, 1 week)

Enable the PostHog flag `cockpit-internal-source = true` for the Kodus organization only.

The Kodus team uses the cockpit normally for one week.

Collect feedback:

- "This number looks different from last week" — investigate.
- "This chart is broken" — investigate.
- "This is slow" — measure.

**Pass criterion**: zero reports of incorrect numbers; latency p95 < 2s.

#### T4.2 — Canary 5% (1 week)

Roll the flag out to 5% of organizations via PostHog rollout percentage.

Monitor weekly:

- `failedLast24h` = 0.
- `quarantinedLast24h` < 0.1% of daily ingestion volume.
- `lagHours` p95 < 0.5.
- Support tickets mentioning "cockpit" — compare before/after baseline.

#### T4.3 — Gradual rollout (3 weeks)

25% → 50% → 100%, one week per stage. Same metrics as T4.2.

#### T4.4 — Decommission (2 weeks after 100%)

After 14 days at 100% with no regressions:

1. Stop the `kodus-service-analytics` deployment.
2. Pause the Airbyte sync (Mongo → BigQuery).
3. Snapshot and archive the BigQuery dataset.
4. Remove the `cockpit-internal-source` feature flag (it's now always-on).
5. Remove the `LEGACY_BQ` code path in the `CockpitSourceResolver`.

### Manual obligations (Tier 4)

- All "advance to next %" decisions are human calls based on monitoring.
- Decommission is a planned maintenance with internal communication.

### Exit criteria for Tier 4

- 14 days at 100% with no regressions.
- No ongoing dependency on `kodus-service-analytics`, Airbyte, or BigQuery for cockpit features.
- Documentation updated: `README_DEPLOY.md` reflects the new topology.

---

## Should we include manual tests?

**Yes — at every tier**, for different reasons:

- **Tier 2 manual checks** catch UI rendering bugs and developer-experience issues that automated assertions don't see (e.g. "the chart loads but the tooltip is unreadable").
- **Tier 3 manual checks** are the difference between "the count matches" and "the metric is meaningful". A parity script can confirm `count(*) = count(*)` but cannot confirm "this number tells the user what they think it tells them".
- **Tier 4 manual checks** are user-facing: support feedback, in-product analytics events, anecdotes from the Kodus team using their own dashboards.

Manual tests are **not** a substitute for automated coverage — they're a complement. Automated tests catch regressions at speed; manual tests catch the bugs that only appear when a human looks at the screen.

Time budget:

- Tier 2 manual: 30 min per release.
- Tier 3 manual (T3.5 + T3.6): ~4 hours, once.
- Tier 4 manual: ~30 min per rollout phase, plus ad-hoc investigation of any ticket.

---

## Timeline reference

| Week | Activity |
|------|----------|
| 1    | Tier 1 (already in this branch) + Tier 2 setup |
| 1–2  | Tier 2 running locally, bug iteration |
| 2    | Infra adds `worker-analytics` task to staging GitOps (no RDS) |
| 2–3  | Tier 3 — migration + backfill staging on shared Postgres + 48h cron stable |
| 4    | Tier 3 — parity vs. BigQuery (T3.5 manual) |
| 5    | Production RDS analytics provisioned + production backfill |
| 6    | T4.1 — dogfood Kodus, 1 week |
| 7    | T4.2 — canary 5% |
| 8    | T4.3 — 25% |
| 9    | T4.3 — 50% |
| 10   | T4.3 — 100% |
| 12   | T4.4 — decommission legacy stack |

Total realistic path: **10–12 weeks** from "code merged" to "legacy decommissioned". Phases can compress if early metrics come in clean, but no tier should be skipped. The big change vs. an earlier version of this plan: **only production gets dedicated RDS**. Staging shares the existing Postgres, which both saves cost and validates the self-hosted topology.

---

## Owner matrix

| Activity | Owner |
|----------|-------|
| Write Tier 1 unit tests | Engineering (this branch) |
| Run `yarn analytics:test-suite` locally | Engineering, before opening PR |
| Add `worker-analytics` task to staging GitOps | Infrastructure team |
| Provision production RDS analytics (cloud only) | Infrastructure team |
| Run Tier 3 (T3.1–T3.8) | Engineering + Infrastructure |
| Manual review of T3.5 parity diffs | Engineering with product input |
| PostHog rollout decisions | Engineering + product owner |
| Decommission timing | Engineering + leadership sign-off |
