# Cross-Process Events Bridge

Runtime docs for `cross-process-events.bridge.ts`, the local instrumentation added on **2026-07-31**, and the load-repro tool used to measure the damage mechanism on a laptop.

Read this first if:
- The API is timing out on `pg-pool` connections
- The `[BRIDGE-METRIC]` lines in `docker logs -f kodus_api` show `waiting > 0`, `delivErr` climbing, or `inflight` growing
- You're about to change the bridge, the pool sizing, or replace the transport

---

## The bridge in one screen

```
┌─────────────────────┐                                    ┌─────────────────────┐
│      WORKER         │                                    │        API          │
│                     │                                    │                     │
│  automationExecution│                                    │  KodyRulesSync      │
│    .service         │                                    │    Listener         │
│         │           │                                    │  centralizedConfig  │
│ emit('pr-execution  │                                    │    Sync Listener    │
│   .updated', ...)   │                                    │  SSE endpoint       │
│         │           │                                    │         ▲           │
│         ▼           │                                    │         │           │
│  CrossProcess       │                                    │  eventEmitter.emit  │
│  EventsBridge       │                                    │         ▲           │
│                     │                                    │         │           │
│ forward()           │                                    │  deliverById(id)    │
│  ├─INSERT envelope──┼─────► kodus_cross_process_events ──┼─► SELECT (POOL!)    │
│  └─pg_notify(id) ───┼──chan─► LISTEN (own connection) ───┼─► notification event│
│         │           │       [GLOBAL COMMIT LOCK ⚠]       │        ▲            │
│                     │                                    │        │            │
│  pool  ─────────────┼─── shared pg-pool ─────────────────┼──── pool (POOL!) ⚠  │
└─────────────────────┘                                    └─────────────────────┘
```

Two contention points are marked ⚠:

- **Global commit lock** on `pg_notify`. Postgres serializes commits that call NOTIFY through a single lock held across `fsync()`. Ceiling ~2.9k writes/s regardless of hardware. (DBOS write-up: https://dbos.dev/blog/postgres-listen-notify-scalability.)
- **pg-pool** on the receive side. `deliverById()` runs a `SELECT` **per notification** on the API's main `dataSource`. Pool max in prod is **25** (hardcoded in `apps/api/src/api.module.ts:106` via `SharedPostgresModule.forRoot({ poolSize: 25 })` — the env `DB_POOL_MAX_API` is overridden by this constructor arg). A burst of N concurrent notifications takes N pool slots. Above 25, everything else (`DistributedLockService`, cron handlers, HTTP endpoints) queues on `pool.waiting`.

The bridge itself holds **one dedicated `pg.Client`** for LISTEN (not from the pool). The pool exhaustion is entirely on the deliver path.

---

## Incident 2026-07-26 → 2026-07-31 — what actually happened

The investigation went through several wrong hypotheses before landing on the mechanism. The refuted ones are documented below so nobody repeats them.

### Timeline (verified against CloudWatch metrics + ECS events)

```
22-jul 13:23 UTC   task-def :79 (image 2.1.32) — bridge live in prod
26-jul 13-23 UTC   INCIDENT #1  — pool_timeouts ~900-1000/h for 10 hours
26-jul 23 → 27-jul 01   fades naturally (Saturday night → Sunday)
27-28 jul          quiet — Sunday + Monday morning with fresh task from
                   manual restart at 28-jul 14:07 UTC
29-jul 20:50 UTC   deploy 2.1.33 (recycles both API tasks)
30-jul 02-13 UTC   INCIDENT #2 — same pattern, task had ~5h uptime at
                   the start of the incident, ruling out "long uptime"
31-jul 02-11 UTC   INCIDENT #3 — same pattern, worker desired=8
                   (ruling out earlier "worker scale" hypothesis)
31-jul 11:54 UTC   force-new-deployment of the API — immediately clears
                   pool_timeouts to 0 through the natural lull window
```

### What ACTUALLY causes the pool exhaustion (evidence, not hypothesis)

Three independent signals, all confirmed from production logs on 2026-07-31:

**1. RDS parameter group has `idle_session_timeout = 3600000` (1 hour).**
```
$ aws rds describe-db-parameters --db-parameter-group-name kodus-prod-pg-tuned \
    --query "Parameters[?ParameterName=='idle_session_timeout']"
[{ "ParameterName": "idle_session_timeout", "ParameterValue": "3600000", "Source": "user" }]
```

**2. The bridge's dedicated `pg.Client` LISTEN connection is naturally idle** between notifications (it never runs application queries). Postgres kills it every ~1h with:
```
error: terminating connection due to idle-session timeout
    at DatabaseError
    at Parser.handlePacket (/usr/src/app/node_modules/pg-protocol/src/parser.ts:212:19)
```

**3. Every reconnect executes `ensureInfra()` which runs a DELETE on the pool.**

Look at `cross-process-events.bridge.ts:265-274`:
```typescript
private async ensureInfra(): Promise<void> {
    await this.dataSource.query(`CREATE TABLE IF NOT EXISTS ...`);
    await this.dataSource.query(
        `DELETE FROM ${PG_TABLE} WHERE created_at < now() - interval '${ROW_TTL_MINUTES} minutes'`,
    );
}
```

Called at `connect():354` **on every reconnection**. `this.dataSource.query` uses the **main pool**, not the LISTEN client. On a table that has accumulated an hour of unswept rows, the DELETE is slow and holds a pool slot for its duration.

### The cascade

```
1. LISTEN idle for ~1h → RDS kills the connection.
2. Bridge catches error → scheduleReconnect() → connect() → ensureInfra()
3. DELETE on the main pool starts → holds a pool slot.
4. WHILE steps 2-3 are happening, the LISTEN is not active, so pg_notify
   from the workers arrive at Postgres and are BROADCAST to nobody. The
   envelope rows exist in the table but no consumer is listening.
5. LISTEN reconnects. But there's no replay of the missed notifications —
   this is the durability gap in LISTEN/NOTIFY.
6. Meanwhile, new notifications start arriving. deliverById() fires for
   each, each takes a pool slot for its SELECT. If bursts overlap with a
   reconnect where DELETE is still running, pool saturates fast.
7. Once pool saturates, deliverById() promises pile up in `inflight`.
   New pool grants get consumed by the pile → the pile never drains.
8. Restart is the only way out — it kills the pile.
```

Correlation from the log data (2026-07-31, hourly):
```
hour_utc     LISTEN_reconnects   envelope_fetch_failed   pool_timeouts
05:00              7                  602                    923
07:00              8                  930                    920
09:00              1                  931                    916
11:00              5                  930                    933
```
`envelope_fetch_failed` and `pool_timeouts` track each other 1:1. Reconnect spikes precede the pool spikes.

### Why restarting the API works but scaling back to 2 tasks does not

After the pool saturates and `inflight` grows past pool max, the surviving task has thousands of pending `deliverById` promises queued on the pool. Nothing in the code drops them. When a new pool slot frees, the next pending promise grabs it — the pile is FIFO, effectively infinite. The task never drains.

A brand-new task (post-restart) starts clean. But a rolling deploy that keeps ONE OF THE OLD TASKS running only fixes 50% of the load — the other 50% still hits the degraded task and still times out. Only `force-new-deployment` (replacing both tasks) clears it.

Concrete proof from 2026-07-31: after AZ rebalance restored 2 API tasks at 10:00 UTC, `pool_timeouts` stayed at 350-360/5min through 11:39 UTC. The `force-new-deployment` at 11:54 UTC dropped them to 0 within one bucket.

---

## Refuted hypotheses (do not chase these again)

Each of these was ranked plausible at some point during the investigation on 2026-07-31 and refuted by direct evidence. Documenting them so future-us doesn't re-derive.

| Hypothesis | Why it seemed plausible | What refuted it |
|---|---|---|
| Worker `desired_count 8→5` was the trigger | Incident 30-jul started 9min after the scale-down | Incident 31-jul happened with worker at 8 |
| Retry amplification from 2.1.33 (rethrow of `fetch failed`) | Two commits in 2.1.33 change transient-fetch handling; timeline correlated | `fetch_failed=0` in the API logs during the whole incident window |
| ASG `night-down` reducing cluster capacity | It fires exactly at 03 UTC, right when the incident starts | The action has existed for weeks; restart of the API (which doesn't touch EC2) fully resolves the symptom |
| Global-rules kody sync amplifying `pull-request.closed` cost | The 2.1.33 listener adds a query per event | Only 1 org has global-rules configured — not enough to move the needle |
| Long uptime accumulating in-memory state | Restart resolves | Task at 30-jul 02 UTC had only ~5h uptime after deploy 2.1.33 |
| Connection leak | Restart resolves; pool metrics look bad | RDS `DatabaseConnections` stays flat during the incident (never trends up) |

The one that survived: **RDS `idle_session_timeout` killing the LISTEN + DELETE on reconnect blocking the pool**. Backed by log evidence, exact error message, and 1:1 metric correlation.

---

## Running the reproduction locally

To exercise the bridge under load, insert envelopes + issue a `pg_notify`
directly against the local Postgres (mirrors exactly what `forward()` does):

```bash
# 1. Sobe tudo (postgres, mongo, rabbit, api, worker, webhook)
pnpm docker:start

# 2. Numa outra aba, tail dos [BRIDGE-METRIC] da API (uma linha a cada 5s)
pnpm docker:logs:api | grep BRIDGE-METRIC

# 3. Dispara alguns envelopes direto no PG (bypass forward, exercita LISTEN)
docker exec db_postgres psql -U kodusdev -d kodus_db -c "
INSERT INTO kodus_cross_process_events (envelope)
SELECT jsonb_build_object(
    'instanceId', 'load-test',
    'name', 'pr-execution.updated',
    'payload', jsonb_build_object('n', gs)
)
FROM generate_series(1, 1000) gs
RETURNING id;
SELECT pg_notify('kodus_cross_process_events',
    string_agg(id::text, ','))
FROM (SELECT id FROM kodus_cross_process_events
      ORDER BY id DESC LIMIT 1000) t;
"
```

### O que ler no `[BRIDGE-METRIC]`

Uma linha exemplo:
```
[BRIDGE-METRIC] t=2026-07-31T14:12:05Z component=api pid=7 \
  fwd=0 fwdErr=0 \
  insertMs=p50:0/p95:0/max:0 notifyMs=p50:0/p95:0/max:0 \
  notifyRecv=487 delivered=487 delivErr=0 missing=0 \
  selectMs=p50:2/p95:18/max:41 \
  lagMs=p50:12/p95:98/max:210 \
  inflight=3 \
  pool=total:12/idle:9/waiting:0
```

Sinais de saturação, em ordem:

| Sinal | Significa |
|---|---|
| `inflight` cresce sem parar | `deliverById` recebendo notify mais rápido que o pool consegue processar |
| `pool.waiting > 0` | requests HTTP e outros services **na fila do pool**, esperando conexão livre |
| `lagMs.p95` sobe (100→500→1000+) | eventos velhos ainda sendo entregues; API está atrás do stream |
| `delivErr` cresce | pool esgotou — `deliverById` timeoutou tentando pegar conexão |
| `missing > 0` | envelope expirou (>60min TTL) antes de ser entregue → **evento perdido silenciosamente** |

Em bursts saudáveis, `pool.waiting = 0` e `lagMs.p95` fica <100ms.

### Why local doesn't saturate as easily

In prod, the pool baseline is ~50-70% occupied by all the other services in the API process (crons, `DistributedLockService`, `SandboxLeaseReaperService`, `NotificationRetryService`, HTTP handlers). The bridge only has to fill the remaining slack.

Locally, only the bridge exercises the pool. To reproduce the saturation faithfully you can either:

**a)** Force the API pool small via env (won't work: `DB_POOL_MAX_API` is overridden by the hardcoded 25). Instead edit `apps/api/src/api.module.ts:106` to `poolSize: 3`, restart the API container (`docker compose up -d --force-recreate --no-deps kodus-api`), then run the flood — observed clearly: `inflight=21 pool=total:3/idle:0/waiting:18` at 300 notif/s.

**b)** Run multiple flood clients in parallel (10 × 500/s = 5000/s combined). Even with pool=25, the max effective rate the API can drain matches ~5000/s comfortably — you'll see `inflight` peak at 24 and `lagMs.p95` climb to 3s, but no `delivErr`. This measures the throughput ceiling, not the incident.

The **mechanism** (idle-timeout → reconnect → DELETE → pool held) needs the RDS `idle_session_timeout` to be set locally too — Postgres in `docker-compose.dev.yml` doesn't set it, so LISTEN connections stay up forever locally and the reconnect path never triggers. To exercise it, run:

```bash
docker exec db_postgres psql -U kodusdev -d kodus_db \
  -c "ALTER SYSTEM SET idle_session_timeout = '90s'; SELECT pg_reload_conf();"
docker restart kodus_api
# wait 2 minutes then check
docker logs kodus_api --since 2m | grep -E "Listening on|LISTEN connection errored"
```

You should see the LISTEN drop and reconnect every ~90s.

---

## Fix roadmap — reordered by evidence

The 2026-07-31 investigation reordered priorities: the batch/coalesce (from the DBOS article) is still a good throughput win but **does not attack the mechanism** we actually see in prod. The reconnect-on-idle-timeout is what needs to die first.

### Priority 1 — attack the mechanism directly (~30 min of code, no external dependencies)

**1.1. `keepAlive` on the LISTEN client** — prevents RDS from killing the connection.
```typescript
// cross-process-events.bridge.ts:315 — inside new Client({...})
keepAlive: true,
keepAliveInitialDelayMillis: 10_000,
```
TCP keepalive marks the connection as active every 10s; RDS's `idle_session_timeout` never triggers. Eliminates ~90% of reconnects.

**1.2. Move TTL sweep out of `ensureInfra`.**

Today `ensureInfra()` runs on every `connect()` call, including reconnects. It runs `CREATE TABLE IF NOT EXISTS` (fine, cheap) **and** `DELETE FROM ... WHERE created_at < now() - interval '60 minutes'`. On a table with an hour of accumulated rows, this DELETE holds a pool slot for its duration — right during the reconnect that already dropped some notifications.

Split responsibilities:
- `ensureInfra()` keeps only the `CREATE TABLE IF NOT EXISTS`, guarded by an `infraReady` flag so it runs at most once per process lifetime.
- Add a `@Cron('0 */15 * * * *')` `sweepExpiredRows()` method that runs the DELETE on a predictable schedule, only when `this.isPrimary`.

Reconnect becomes instant. Sweep becomes observable.

**1.3. `application_name` on both the LISTEN client and the pool.**

Today `pg_stat_activity` shows all Kodus connections as unknown/blank, so you can't tell what's the bridge, what's the pool, what's a stuck cron. Adding `application_name: 'kodus-bridge-listener'` (on the client) and `application_name: 'kodus-api-pool'` (via `extra.application_name` in TypeORM factory) makes the DB side of every future incident diagnosable in one query.

### Priority 2 — defense in depth (does not fix the mechanism, but caps blast radius)

**2.1. Dedicated `DataSource` for the bridge with `max=5`.**

Even after 1.1 + 1.2, a code change or config drift could re-introduce a slow query in the deliver path. Isolating the bridge on its own connection pool means the API's HTTP pool never gets held by a bridge bug — the bridge can degrade in isolation.

**2.2. Semaphore in `deliverById()`.**

Today an unbounded number of `deliverById()` promises can pile up. Add an in-flight semaphore that either:
- **Awaits** (backpressure) when at N concurrent — pool never saturates by the bridge alone.
- **Drops with a `warn`** when over N — accept the loss, prefer availability. Requires idempotency in the handlers, but they should already have it.

This makes the "pile that never drains" fixed above impossible.

### Priority 3 — throughput and durability (from the DBOS reference)

**3.1. Batch on `forward()` + `deliverById()`.**

Buffer 50-100ms of envelopes into one multi-row INSERT + one `pg_notify` carrying `"id1,id2,id3,..."`. On the receive side, one `SELECT ... WHERE id = ANY($1)` per burst. Reduces the number of global commit locks by ~20× (DBOS reported number). Latency cost: +50ms.

**3.2. Outbox polling as fallback.**

Add a `@Cron('*/5 * * * * *')` `pollFallback()` that does `SELECT id, envelope FROM ... WHERE id > lastSeenId LIMIT 100`. Covers events lost by reconnect / NOTIFY dropped / LISTEN gap during ensureInfra. Turns the bridge into *at-least-once* durable (requires idempotency in handlers).

### Priority 4 — nice to have, no urgency

- **`connectionTimeoutMillis: 10_000`** on the LISTEN client (currently defaults to 30s).
- **`statement_timeout`** on the pool (safety net for any query — bug or user query — that hangs).
- **RDS parameter change: `idle_session_timeout = 0`** (disable) — treats the root cause on the DB side. But this is a broader operational choice; the 1.1 fix works without touching RDS.

**On `SharedPostgresModule.forRoot({ poolSize: 25 })` in `apps/api/src/api.module.ts:106`:**
kept as-is on purpose — the hardcoded 25 makes the pool size explicit at the wire-up
site, independent of whether an env var reaches the container. If you ever revisit
this and consider switching to env-driven, check `pg_stat_activity` first to confirm
`DB_POOL_MAX_API` is actually set in prod (was `30` at the time of the 2026-07-31
investigation).

---

## What we've confirmed the fixes should NOT do

- **Do not switch to RabbitMQ yet.** The mechanism above is solvable without changing transport. Migration to Rabbit is architecturally correct if load 10x's, but it's not urgent for the current scale, and the risk of introducing new bugs during migration outweighs the benefit today.
- **Do not raise pool size.** 25 is fine; the mechanism drains 25 in ~10s under a normal burst. The problem is the reconnect-DELETE holding slots, not the pool being small.
- **Do not schedule daily API restarts.** It works as a curative — but it hides the mechanism from future engineers and treats the symptom.

---

## Files referenced

- `libs/core/workflow/infrastructure/cross-process-events.bridge.ts` — bridge + 2026-07-31 instrumentation
- `libs/core/workflow/modules/workflow.module.ts:54-56` — provider wiring
- `libs/automation/infrastructure/adapters/services/automationExecution.service.ts` — emits `pr-execution.updated`
- `libs/platform/infrastructure/webhooks/{github,bitbucket,azure,forgejo}PullRequest.handler.ts` — emit `pull-request.closed`
- `libs/kodyRules/infrastructure/adapters/listeners/kody-rules-sync.listener.ts` — consumer (API)
- `libs/centralized-config/infrastructure/adapters/listeners/centralized-config-sync.listener.ts` — consumer (API)
- `libs/core/infrastructure/database/typeorm/migrations/2026071300000000-CrossProcessEventsTable.ts` — table migration
- `libs/core/infrastructure/database/typeorm/typeORM.factory.ts:82-95` — pool config (includes `application_name`)
- `apps/api/src/api.module.ts:106` — hardcoded `poolSize: 25` (intentionally kept explicit — see Priority 4)
- `test/unit/core/cross-process-events.bridge.spec.ts` — unit tests
