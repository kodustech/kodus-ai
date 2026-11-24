# apps/runtime/src/shared/persistence

The Runtime Postgres as both control-plane apps use it: the schema and its migrations, cluster-wide locks, and the stores whose rows more than one process writes or reads (commands from the API, previews, snapshot placements, the cell directory). Adapters only: the rules they apply come from `libs/runtime`, and the claim store itself is the hub's (`hub/hub-store.ts`).

## Owns
- Schema: `runtime-schema.ts` `RUNTIME_SCHEMA_SQL` (the baseline), `RUNTIME_MIGRATIONS`, `ensureRuntimeSchema` (pending migrations under the migration advisory lock, asked for every `MIGRATION_LOCK_POLL_MS` and never waited on in `pg_advisory_lock`; a `sql` migration in its own transaction, a `concurrentIndexes` one built with `CREATE INDEX CONCURRENTLY`, an INVALID leftover rebuilt), `applyRetention` (every table in batched deletes, at most `RETENTION_MAX_BATCHES` a pass: 30 days for the stream, audits, blockers, env steps and ended env sessions, a fleet host's rows once it is terminated, ended pool demand, fleet tokens and machine-minute rows; `runtime_stability` keeps 90, `STABILITY_RETENTION_DAYS`; `runtime_kept_check_results` keeps 180, `KEPT_CHECK_RESULTS_RETENTION_DAYS`; ended claims and ended fleet cells keep `CLAIM_RETENTION_DAYS`, 400; an ended Run keeps `RUNTIME_RUN_RETENTION_DAYS`, 365 (its `runtime_runs` row, PR generation record, fork approval and preview record; never a Run a live claim, a kept check result or the stability history names); admission intents in pages of 100 until a short one), `ensureDatabase` (local and self-hosted bootstrap).
- Locks: `locks.ts` `DistributedLocks`, `PgDistributedLocks` (session advisory locks on a dedicated connection; `withLock`, `tryWithLock`, `currentClient`). `lock-scoped-pg.ts` `LockScopedPg`: a store that joins the lock's live connection instead of taking a second pool slot, and refuses nested transactions.
- Commands the API decided: `pg-command-store.ts` `PgCommandStore` (`CommandStore`: fork and egress approvals, egress audit and settings, stops, cell tokens, `revokeCell`), `egressScopes`.
- Cell choice: `cell-directory.ts` `PgCellDirectory` (`reserveCell`, `replicaForClaim`, `replicaForCell`), `reserveCellFor` / `reserveCellCapped` (the capped, org-locked reservation in `runtime_cell_reservations`), `reserveCellRow` (the hub's uncapped one), and the SQL they share (`RESERVE_CELL_SQL`, `CELL_CAPACITY_SQL`, `BEST_CELL_SQL`).
- Suite demand: `suite-demand.ts` `PgSuiteDemand` (`request`: one `runtime_pool_demand` row per shard of a suite run, keyed `suite:<org>/<suiteRun>/<shard>`; `status`: per shard `starting | ready | failed`; `end`: the run's demand expires at once). `CellWant` carries `suiteRunId` and `shard` for a claim of consumer `suite`.
- Suite baseline requests: `suite-baseline-requests.ts` `PgSuiteBaselineRequests` (`runtime_suite_baseline_requests`, migration 52): the baseline suite runs a template turning ready asks for. `request` is one statement: the queued requests of the environment for another commit are replaced, and a commit already recorded (queued or started) changes nothing; each request carries the `suiteRunId` its run will have. `pending` lists the queued ones oldest first; `markStarted` (own organization only) moves one out of the queue. The fleet writes it; the product reads it with the read-only role and issues the command.
- The organization purge: `organization-purge.ts` `PgOrganizationPurgeStore` (`liveClaims`, `cordonPools`, `deleteOrganization`: every row of one organization in batches, the tables in `ORGANIZATION_PURGE_TABLES`; a host that is not terminated stays with its pool). `organization-purge.integration.spec.ts` fails when a `runtime` table with an organization column is missing from the list.
- Previews: `preview-store.ts` `PgPreviewStore` (records and state, tunnel tickets, edge sessions, grants seen, tunnel holders), `normalizedSerial`, `sessionHashOf`.
- Snapshot placements: `snapshot-placements.ts` `PgSnapshotPlacements` (which cell holds a sandbox's template or session snapshot, and the PR a session belongs to).

## Does not own
- `runtime_claims` and its transitions: `apps/runtime/src/hub/hub-store.ts` ([claims](../../../AGENTS.md#claims)); the worker's read of it: `worker/persistence/pg-run-claims.ts`.
- Admission requests, PR fences and the physical reservation: `../admission/`.
- The Run projection, setups and lessons stores: `libs/runtime/run/adapters/`.

## Rules and limits
- Writers by table are in [README.md "Stores and who writes them"](../../../README.md#stores-and-who-writes-them). Here: the worker's reservation decrements `runtime_cell_sessions.free_slots` (the next heartbeat overwrites it), and `revokeCell` terminates the cell's claims in the revocation's transaction, the one write to `runtime_claims` outside the hub.
- The schema changes only by a new `RUNTIME_MIGRATIONS` entry; never edit an applied one ([protocol and schema](../../../AGENTS.md#protocol-and-schema)).
- A connection whose unlock or rollback failed is destroyed, never pooled.
- A shared cell takes an org's claim only under `sharedClaimCap` (`DEFAULT_ORG_SHARED_CLAIM_CAP`); a size or isolation no eligible cell grants is refused before the cap. A reservation counts for `RESERVATION_TTL_SECONDS` until the hub records the claim.
- An egress delivery older than the row's last approval or revocation changes nothing (the outbox may replay it).
- A preview read by id names the org; the edge reads by host and checks the org on the grant and session.

## Where new code goes
- A new table or column: a migration at the end of `RUNTIME_MIGRATIONS`, the grant in `scripts/runtime/runtime-reader-grants.sql` if the API reads it, and retention in `applyRetention` if it grows per Run. A new index on a table that grows with Runs or claims: a `concurrentIndexes` migration of its own.
- A new store method: the Pg class and its `InMemory…` twin in `testing.ts` with the same semantics, plus an integration case.

## Tests
- Unit: `API_NODE_ENV=test npx jest apps/runtime/src/shared/persistence`.
- Postgres: `RUNTIME_IT_DATABASE_URL=postgres://… API_NODE_ENV=test npx jest apps/runtime/src/shared/persistence --runInBand` (each suite leases its own database, `../../testing/isolated-database.ts`).

<!-- module-map:start (generated by scripts/runtime/module-docs.mjs; do not edit) -->

## Module map

Files (13, tests apart): `cell-directory.ts`, `host-pools.ts`, `lock-scoped-pg.ts`, `locks.ts`, `organization-purge.ts`, `pg-command-store.ts`, `preview-store.ts`, `runtime-schema.ts`, `snapshot-placements.ts`, `suite-baseline-requests.ts`, `suite-demand.ts`, `testing.ts`, `workflow-retention.ts`

Imports these Runtime modules:

- [`libs/runtime/api/domain`](../../../../../libs/runtime/api/domain/AGENTS.md)
- [`libs/runtime/contracts`](../../../../../libs/runtime/contracts/AGENTS.md)
- [`libs/runtime/gate`](../../../../../libs/runtime/gate/AGENTS.md)
- [`libs/runtime/placement`](../../../../../libs/runtime/placement/AGENTS.md)
- [`libs/runtime/protocol`](../../../../../libs/runtime/protocol/AGENTS.md)
- [`libs/runtime/run`](../../../../../libs/runtime/run/AGENTS.md)
- [`libs/runtime/run/adapters`](../../../../../libs/runtime/run/adapters/AGENTS.md)

Imported by:

- [`apps/runtime/src/edge`](../../edge/AGENTS.md)
- [`apps/runtime/src/fleet`](../../fleet/AGENTS.md)
- [`apps/runtime/src/fleet/template`](../../fleet/template/AGENTS.md)
- [`apps/runtime/src/hub`](../../hub/AGENTS.md)
- [`apps/runtime/src/shared`](../AGENTS.md)
- [`apps/runtime/src/shared/admission`](../admission/AGENTS.md)
- [`apps/runtime/src/worker`](../../worker/AGENTS.md)
- [`apps/runtime/src/worker/commands`](../../worker/commands/AGENTS.md)
- [`apps/runtime/src/worker/consumer`](../../worker/consumer/AGENTS.md)
- [`apps/runtime/src/worker/dbos`](../../worker/dbos/AGENTS.md)
- [`apps/runtime/src/worker/env`](../../worker/env/AGENTS.md)
- [`apps/runtime/src/worker/preview`](../../worker/preview/AGENTS.md)
- [`apps/runtime/src/worker/sandbox`](../../worker/sandbox/AGENTS.md)
- [`apps/runtime/src/worker/suite`](../../worker/suite/AGENTS.md)

<!-- module-map:end -->
