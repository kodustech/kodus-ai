import { inTransaction, lockKey, lockStatement } from '@libs/runtime/run/adapters/advisory-lock';
import type { Pool, PoolClient } from 'pg';

import { KEPT_CHECK_RESULTS_RETENTION_DAYS } from '@libs/runtime/contracts/kept-check';
import { STABILITY_RETENTION_DAYS } from '@libs/runtime/gate/stability';
import { TERMINAL_STATES } from '@libs/runtime/run/run-state';

// Tables of the Runtime database next to the DBOS system tables (docs §8).
// The hub writes runtime_cell_sessions and runtime_steps_index. One exception:
// the worker's PgCellDirectory (cell-directory.ts) decrements a session's
// free_slots when it reserves a cell; the next heartbeat overwrites it.

export const RUNTIME_SCHEMA_SQL = `
CREATE SCHEMA IF NOT EXISTS runtime;

CREATE TABLE IF NOT EXISTS runtime.runtime_cell_sessions (
    cell_id           text PRIMARY KEY,
    replica_id        text NOT NULL,
    replica_url       text NOT NULL,
    owner             text NOT NULL CHECK (owner IN ('kodus', 'customer')),
    org_id            text,
    driver            text NOT NULL,
    connected_at      timestamptz NOT NULL DEFAULT now(),
    last_heartbeat_at timestamptz NOT NULL DEFAULT now(),
    free_slots        integer NOT NULL DEFAULT 0,
    disconnected_at   timestamptz
);

CREATE TABLE IF NOT EXISTS runtime.runtime_claims (
    claim_id         text PRIMARY KEY,
    cell_id          text NOT NULL,
    org_id           text NOT NULL,
    run_id           text,
    side             text NOT NULL,
    state            text NOT NULL,
    lease_expires_at timestamptz NOT NULL,
    hard_expires_at  timestamptz NOT NULL,
    created_at       timestamptz NOT NULL DEFAULT now(),
    released_at      timestamptz
);
CREATE INDEX IF NOT EXISTS runtime_claims_run_idx ON runtime.runtime_claims (run_id);
CREATE INDEX IF NOT EXISTS runtime_claims_cell_idx ON runtime.runtime_claims (cell_id);
-- Which environment a claim serves: an approved egress host is pushed to its live claims.
ALTER TABLE runtime.runtime_claims ADD COLUMN IF NOT EXISTS environment_id text;
CREATE INDEX IF NOT EXISTS runtime_claims_env_idx ON runtime.runtime_claims (org_id, environment_id) WHERE state = 'bound';

CREATE TABLE IF NOT EXISTS runtime.runtime_steps_index (
    step_id    uuid PRIMARY KEY,
    cell_id    text NOT NULL,
    claim_id   text NOT NULL,
    org_id     text NOT NULL,
    run_id     text,
    command_hash text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS runtime_steps_index_created_idx ON runtime.runtime_steps_index (created_at);

CREATE TABLE IF NOT EXISTS runtime.runtime_egress_events (
    id         bigserial PRIMARY KEY,
    claim_id   text NOT NULL,
    cell_id    text NOT NULL,
    org_id     text NOT NULL,
    host       text NOT NULL,
    port       integer NOT NULL,
    phase      text NOT NULL,
    at         timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS runtime_egress_events_claim_idx ON runtime.runtime_egress_events (claim_id);

-- Cells, registration tokens and revocations (ADR-054). Read by the API, written here.
CREATE TABLE IF NOT EXISTS runtime.runtime_cells (
    cell_id                text PRIMARY KEY,
    organization_id        text,
    owner                  text NOT NULL CHECK (owner IN ('kodus', 'customer')),
    topology               text NOT NULL,
    status                 text NOT NULL DEFAULT 'disconnected',
    certificate_serial     text,
    certificate_expires_at timestamptz,
    last_heartbeat_at      timestamptz,
    created_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS runtime_cells_org_idx ON runtime.runtime_cells (organization_id);
-- 2026-10-31: the 24 h cell secret is gone (mTLS only, ADR-054).
ALTER TABLE runtime.runtime_cells DROP COLUMN IF EXISTS secret_hash;
-- The serial RUNTIME_MANAGED_CELLS last pinned: a managed cell that renewed
-- keeps its newer pin across a hub restart until the config names another serial.
ALTER TABLE runtime.runtime_cells ADD COLUMN IF NOT EXISTS managed_serial text;

CREATE TABLE IF NOT EXISTS runtime.runtime_cell_tokens (
    token_hash      text PRIMARY KEY,
    organization_id text NOT NULL,
    topology        text NOT NULL,
    expires_at      timestamptz NOT NULL,
    issued_by       text NOT NULL,
    used_at         timestamptz
);

CREATE TABLE IF NOT EXISTS runtime.runtime_cell_revocations (
    cell_id    text NOT NULL,
    reason     text,
    revoked_by text NOT NULL,
    revoked_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (cell_id, revoked_at)
);

CREATE TABLE IF NOT EXISTS runtime.runtime_fork_approvals (
    key         text PRIMARY KEY,
    run_id      text NOT NULL,
    head_sha    text NOT NULL,
    approver    text NOT NULL,
    approved_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS runtime_fork_approvals_run_idx ON runtime.runtime_fork_approvals (run_id);

CREATE TABLE IF NOT EXISTS runtime.runtime_egress_approvals (
    environment_id  text NOT NULL,
    host            text NOT NULL,
    organization_id text NOT NULL,
    approved_by     text NOT NULL,
    approved_at     timestamptz NOT NULL,
    PRIMARY KEY (environment_id, host)
);

-- The stop button (§7 POST /runtime/stop): while a row is active, no new Run starts in its scope.
CREATE TABLE IF NOT EXISTS runtime.runtime_stops (
    id              bigserial PRIMARY KEY,
    scope           text NOT NULL CHECK (scope IN ('org', 'global')),
    organization_id text,
    requested_by    text NOT NULL,
    requested_at    timestamptz NOT NULL,
    cleared_at      timestamptz
);
`;

/** An index on a large table, built without a lock on the table's writes. */
export interface ConcurrentIndex {
    /** The index name, in the runtime schema. */
    name: string;
    /** `CREATE [UNIQUE] INDEX CONCURRENTLY IF NOT EXISTS <name> ON runtime.<table> ...`. */
    sql: string;
}

/**
 * One versioned migration: either `sql`, applied in one transaction with its schema_migrations row, or
 * `concurrentIndexes`, each built with CREATE INDEX CONCURRENTLY outside a transaction (it cannot run in one)
 * so a large table keeps taking writes while it builds. A build cut half way leaves an INVALID index of that
 * name: the next run drops it (concurrently) and builds it again; the version row is written after the last one.
 */
export type RuntimeMigration = { version: number; name: string } & ({ sql: string; concurrentIndexes?: never } | { concurrentIndexes: readonly ConcurrentIndex[]; sql?: never });

/**
 * Versioned migrations of the Runtime database. Each runs once, recorded in
 * runtime.schema_migrations; a process applies the pending ones under an
 * advisory lock, so replicas booting together apply each once. Version 1 is
 * the baseline above (idempotent DDL, so a database created before versioning
 * adopts it). Never edit an applied migration: add one. A new index on a
 * table that grows with Runs or claims goes in a `concurrentIndexes` migration.
 */
export const RUNTIME_MIGRATIONS: ReadonlyArray<RuntimeMigration> = [
    { version: 1, name: 'baseline', sql: RUNTIME_SCHEMA_SQL },
    {
        version: 2,
        name: 'reaper index, step and egress indexes, org-scoped approvals, run events',
        sql: `
-- The reaper and the claims of a Run read live claims by expiry.
CREATE INDEX IF NOT EXISTS runtime_claims_live_expiry_idx ON runtime.runtime_claims (hard_expires_at) WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS runtime_steps_index_claim_idx ON runtime.runtime_steps_index (claim_id);
CREATE INDEX IF NOT EXISTS runtime_egress_events_at_idx ON runtime.runtime_egress_events (at);
-- An approval belongs to one org's environment.
ALTER TABLE runtime.runtime_egress_approvals DROP CONSTRAINT IF EXISTS runtime_egress_approvals_pkey;
ALTER TABLE runtime.runtime_egress_approvals ADD PRIMARY KEY (organization_id, environment_id, host);
-- The Run stream in Postgres (RUNTIME_STREAM_STORE=postgres): one writer per event key, read by offset.
CREATE TABLE IF NOT EXISTS runtime.runtime_run_events (
    seq        bigserial PRIMARY KEY,
    org_id     text NOT NULL,
    run_id     text NOT NULL,
    event_key  text,
    event      jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS runtime_run_events_run_idx ON runtime.runtime_run_events (org_id, run_id, seq);
CREATE UNIQUE INDEX IF NOT EXISTS runtime_run_events_key_idx ON runtime.runtime_run_events (run_id, event_key) WHERE event_key IS NOT NULL;
`,
    },
    {
        version: 3,
        name: 'claim blockers the cell reports (security_violation)',
        sql: `
-- Written by the hub when a cell reports a security violation on a claim; read by the worker for its Run.
CREATE TABLE IF NOT EXISTS runtime.runtime_claim_blockers (
    claim_id  text NOT NULL,
    org_id    text NOT NULL,
    run_id    text,
    cell_id   text NOT NULL,
    side      text NOT NULL,
    kind      text NOT NULL,
    signature text NOT NULL,
    message   text NOT NULL,
    at        timestamptz NOT NULL,
    PRIMARY KEY (claim_id, kind, signature)
);
CREATE INDEX IF NOT EXISTS runtime_claim_blockers_run_idx ON runtime.runtime_claim_blockers (org_id, run_id);
`,
    },
    {
        version: 4,
        name: 'why a claim is in its state, and since when',
        sql: `
-- reason is ClaimReason (hub/hub-store.ts), a closed set; reason_detail is the cell's own code for it.
ALTER TABLE runtime.runtime_claims ADD COLUMN IF NOT EXISTS reason text;
ALTER TABLE runtime.runtime_claims ADD COLUMN IF NOT EXISTS reason_detail text;
ALTER TABLE runtime.runtime_claims ADD COLUMN IF NOT EXISTS state_changed_at timestamptz;
`,
    },
    {
        version: 5,
        name: 'live claims of an org per cell (fair scheduling on shared cells)',
        sql: `
-- Every cell reservation counts the org's live claims, per cell and on shared cells (shared/cell-directory.ts).
CREATE INDEX IF NOT EXISTS runtime_claims_org_live_idx ON runtime.runtime_claims (org_id, cell_id) WHERE released_at IS NULL;
`,
    },
    {
        version: 6,
        name: 'what a cell may be asked: its hello features and largest claim size',
        sql: `
-- features: the optional claim.acquire fields the cell decodes (protocol CELL_FEATURES); empty for an older cell.
-- max_claim_*: the largest size it grants one claim, both null when it grants none (or does not decode size),
-- so the cell directory routes a sized claim only to a cell whose maximum fits it.
ALTER TABLE runtime.runtime_cell_sessions ADD COLUMN IF NOT EXISTS features text[] NOT NULL DEFAULT '{}';
ALTER TABLE runtime.runtime_cell_sessions ADD COLUMN IF NOT EXISTS max_claim_memory_mb integer;
ALTER TABLE runtime.runtime_cell_sessions ADD COLUMN IF NOT EXISTS max_claim_cpus integer;
`,
    },
    {
        version: 7,
        name: 'the consumer a claim was acquired for',
        sql: `
-- consumer is Consumer (libs/runtime/environment): claim.renew takes the lease TTL from it, never from the caller.
-- Null on rows from before this migration; those renew with the caller's consumer until their ceiling ends them.
ALTER TABLE runtime.runtime_claims ADD COLUMN IF NOT EXISTS consumer text;
`,
    },
    {
        version: 8,
        name: 'cell reservations the hub has not recorded a claim for yet',
        sql: `
-- A capped reservation (shared/cell-directory.ts reserveCellCapped) counts against its org's shared-cell cap
-- from the moment it takes a slot, until the hub's claim row with the same claim_id replaces it or it expires.
CREATE TABLE IF NOT EXISTS runtime.runtime_cell_reservations (
    claim_id   text PRIMARY KEY,
    org_id     text NOT NULL,
    cell_id    text NOT NULL,
    expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS runtime_cell_reservations_org_idx ON runtime.runtime_cell_reservations (org_id, expires_at);
`,
    },
    {
        version: 9,
        name: 'the output tail of a claim that failed to boot',
        sql: `
-- A failed boot's blocker (claim.failed) is recorded with its last output lines, redacted by the cell and the hub:
-- at most 40, each at most 300 characters (libs/runtime/run/boot-failure.ts). Empty for a security_violation.
ALTER TABLE runtime.runtime_claim_blockers ADD COLUMN IF NOT EXISTS log_tail text[] NOT NULL DEFAULT '{}';
`,
    },
    {
        version: 10,
        name: 'the Run stream in Postgres by default: retention by age',
        sql: `
-- The stream is append-only, so created_at follows seq: a BRIN index (a few pages for millions of rows)
-- finds the rows past retention without a scan. Reads stay on runtime_run_events_run_idx (org_id, run_id, seq);
-- a keyed event stays unique per Run (runtime_run_events_key_idx).
CREATE INDEX IF NOT EXISTS runtime_run_events_created_brin ON runtime.runtime_run_events USING brin (created_at);
`,
    },
    {
        version: 11,
        name: 'what each claim round held, for the cost of its Run',
        sql: `
-- Written once per transition by the hub (hub/hub-store.ts ClaimMetering), read by the API (kodus_runtime_reader) to
-- price a Run by what its claims held (libs/runtime/api/domain/run-cost.ts): the cell's driver; on a cell whose claims
-- share its memory (ADR-070) the MB counted while the claim boots and once ready, and what the cell may commit in all
-- (null on a cell that reports no memory); when the round was admitted and when the cell reported it ready.
-- released_at already marks its end. Null on rows from before this migration: their Run is not priced.
ALTER TABLE runtime.runtime_claims ADD COLUMN IF NOT EXISTS driver text;
ALTER TABLE runtime.runtime_claims ADD COLUMN IF NOT EXISTS memory_mb_boot integer;
ALTER TABLE runtime.runtime_claims ADD COLUMN IF NOT EXISTS memory_mb_ready integer;
ALTER TABLE runtime.runtime_claims ADD COLUMN IF NOT EXISTS memory_allocatable_mb integer;
ALTER TABLE runtime.runtime_claims ADD COLUMN IF NOT EXISTS admitted_at timestamptz;
ALTER TABLE runtime.runtime_claims ADD COLUMN IF NOT EXISTS ready_at timestamptz;
`,
    },
    {
        version: 12,
        name: 'bounded durable Run and setup admission intents',
        sql: `
CREATE TABLE runtime.runtime_admission_requests (
    org_id text NOT NULL,
    kind text NOT NULL CHECK (kind IN ('run','setup')),
    request_key text NOT NULL,
    generation integer NOT NULL CHECK (generation >= 0),
    ticket_owner_token uuid NOT NULL,
    payload jsonb,
    payload_bytes integer NOT NULL CHECK (payload_bytes >= 0),
    payload_hash text,
    execution_id text,
    state text NOT NULL CHECK (state IN ('awaiting_approval','waiting','owned','reserved','dispatched','running','completed','cancelled','expired','rejected')),
    deadline_at timestamptz,
    approval_deadline_at timestamptz,
    next_at timestamptz,
    max_attempts integer NOT NULL CHECK (max_attempts > 0),
    lease_token uuid,
    owner_epoch bigint NOT NULL CHECK (owner_epoch >= 0),
    owner_until timestamptz,
    permit_held boolean NOT NULL DEFAULT false,
    ticket jsonb,
    last_reason text,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    PRIMARY KEY (org_id,kind,request_key),
    CHECK ((payload IS NULL AND payload_bytes=0) OR payload IS NOT NULL)
);
CREATE UNIQUE INDEX runtime_admission_execution_idx ON runtime.runtime_admission_requests (execution_id) WHERE execution_id IS NOT NULL;
CREATE UNIQUE INDEX runtime_admission_key_owner_idx ON runtime.runtime_admission_requests (kind,request_key) WHERE payload IS NOT NULL;
CREATE INDEX runtime_admission_budget_idx ON runtime.runtime_admission_requests (org_id,kind,permit_held) INCLUDE (payload_bytes,state)
 WHERE permit_held OR state IN ('awaiting_approval','waiting','owned');
CREATE INDEX runtime_admission_due_idx ON runtime.runtime_admission_requests (next_at,created_at,org_id,kind,request_key) WHERE next_at IS NOT NULL;
`,
    },
    {
        version: 13,
        name: 'physical ticket session epoch and reservation ownership',
        sql: `
ALTER TABLE runtime.runtime_cell_sessions ADD COLUMN IF NOT EXISTS session_epoch uuid;
ALTER TABLE runtime.runtime_cell_reservations ADD COLUMN IF NOT EXISTS owner_token text;
`,
    },
    {
        version: 14,
        name: 'cell isolation declaration for strict physical admission policy',
        sql: `ALTER TABLE runtime.runtime_cell_sessions ADD COLUMN IF NOT EXISTS isolation text;`,
    },
    {
        version: 15,
        name: 'fair durable admission repair and bounded pending ticket cleanup',
        sql: `
ALTER TABLE runtime.runtime_admission_requests ADD COLUMN last_scanned_at timestamptz;
CREATE INDEX runtime_admission_fair_due_idx ON runtime.runtime_admission_requests (last_scanned_at NULLS FIRST,next_at,created_at,org_id,kind,request_key) WHERE next_at IS NOT NULL;
DROP INDEX runtime.runtime_admission_budget_idx;
CREATE INDEX runtime_admission_budget_idx ON runtime.runtime_admission_requests (org_id,kind,permit_held) INCLUDE (payload_bytes,state)
    WHERE permit_held OR state IN ('awaiting_approval','waiting','owned') OR ticket IS NOT NULL;
`,
    },

    {
        version: 16,
        name: 'bounded terminal admission retention',
        sql: `CREATE INDEX runtime_admission_retention_idx ON runtime.runtime_admission_requests (updated_at,org_id,kind,request_key)
            WHERE NOT permit_held AND ticket IS NULL AND state IN ('completed','cancelled','expired','rejected');`,
    },

    {
        version: 17,
        name: 'immutable interactive validation recipe authority',
        sql: `ALTER TABLE IF EXISTS runtime.runtime_env_sessions ADD COLUMN IF NOT EXISTS validation_snapshot jsonb;`,
    },

    {
        version: 18,
        name: 'pr_admission_generations',
        // Retain these ordering tombstones until the broker/outbox replay horizon is enforced.
        // Deleting a current fence or a live Run registration would revive stale deliveries.
        sql: `CREATE TABLE IF NOT EXISTS runtime.runtime_pr_fences (
            organization_id text NOT NULL, repository_id text NOT NULL, pr_number integer NOT NULL,
            generation bigint NOT NULL CHECK (generation >= 0), head_sha text,
            PRIMARY KEY (organization_id, repository_id, pr_number));
        CREATE TABLE IF NOT EXISTS runtime.runtime_pr_run_generations (
            organization_id text NOT NULL, run_id text NOT NULL, repository_id text NOT NULL,
            pr_number integer NOT NULL, generation bigint NOT NULL CHECK (generation > 0), head_sha text NOT NULL,
            created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (organization_id, run_id));
        CREATE INDEX IF NOT EXISTS runtime_pr_runs_scope_idx ON runtime.runtime_pr_run_generations (organization_id, repository_id, pr_number, generation);
        CREATE TABLE IF NOT EXISTS runtime.runtime_pr_cancel_generations (
            organization_id text NOT NULL, command_id text NOT NULL, repository_id text NOT NULL,
            pr_number integer NOT NULL, ceiling bigint NOT NULL CHECK (ceiling >= 0), keep_head text,
            created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (organization_id, command_id));
        CREATE INDEX IF NOT EXISTS runtime_pr_cancels_scope_idx ON runtime.runtime_pr_cancel_generations (organization_id, repository_id, pr_number, ceiling);`,
    },
    {
        version: 19,
        name: 'claim fork pull request',
        // The PR side of a fork: the environment's approved egress hosts never reach the claim.
        sql: `ALTER TABLE IF EXISTS runtime.runtime_claims ADD COLUMN IF NOT EXISTS fork_pull_request boolean NOT NULL DEFAULT false;`,
    },
    {
        version: 20,
        name: 'org machine-minute budget',
        // One row per claim, on the UTC day of its first round (hub/claims/pg-machine-minutes.store.ts):
        // the rounds that ended (settled_seconds) and the round in flight, reserved at its whole ceiling
        // until the claim row says it ended. runtime_machine_usage is what each claim counts; the
        // API reads it (kodus_runtime_reader) for the org's minutes left today.
        sql: `CREATE TABLE IF NOT EXISTS runtime.runtime_machine_reservations (
            claim_id text PRIMARY KEY,
            org_id text NOT NULL,
            day date NOT NULL,
            settled_seconds bigint NOT NULL DEFAULT 0 CHECK (settled_seconds >= 0),
            round_started_at timestamptz NOT NULL,
            round_reserved_seconds bigint NOT NULL CHECK (round_reserved_seconds >= 0),
            created_at timestamptz NOT NULL DEFAULT now());
        CREATE INDEX IF NOT EXISTS runtime_machine_reservations_org_day_idx ON runtime.runtime_machine_reservations (org_id, day);
        CREATE OR REPLACE VIEW runtime.runtime_machine_usage AS
        SELECT r.claim_id, r.org_id, r.day,
               r.settled_seconds + CASE WHEN e.ended_at >= r.round_started_at
                    THEN LEAST(r.round_reserved_seconds, CEIL(EXTRACT(EPOCH FROM (e.ended_at - r.round_started_at)))::bigint)
                    ELSE r.round_reserved_seconds END AS seconds,
               r.settled_seconds + LEAST(r.round_reserved_seconds,
                    GREATEST(0, CEIL(EXTRACT(EPOCH FROM (CASE WHEN e.ended_at >= r.round_started_at THEN e.ended_at ELSE now() END - r.round_started_at))))::bigint) AS held_seconds,
               (r.round_reserved_seconds > 0 AND (e.ended_at IS NULL OR e.ended_at < r.round_started_at)) AS open
          FROM runtime.runtime_machine_reservations r
          LEFT JOIN runtime.runtime_claims c ON c.claim_id = r.claim_id
          CROSS JOIN LATERAL (SELECT COALESCE(c.released_at, CASE WHEN c.state IN ('blocked', 'failed') THEN c.state_changed_at END) AS ended_at) e;`,
    },
    {
        version: 21,
        name: 'Run projection, environment setups and lessons (moved from Mongo)',
        // The runtime-worker writes these three; the API reads them with kodus_runtime_reader
        // (scripts/runtime/runtime-reader-grants.sql). Typed columns are what the reads filter and sort
        // on; the jsonb column holds the rest of the document, read whole (libs/runtime/run/adapters/pg-document.ts).
        // No retention: Mongo kept them for good too. scripts/runtime/backfill-runtime-mongo.ts copies the old documents.
        sql: `
CREATE TABLE IF NOT EXISTS runtime.runtime_runs (
    run_id          text PRIMARY KEY,
    organization_id text,
    team_id         text,
    repository_id   text,
    repository_name text,
    pr_number       integer,
    head_sha        text,
    base_sha        text,
    base_branch     text,
    environment_id  text,
    image_id        text,
    attempt         integer,
    correlation_id  text,
    state           text,
    verdict_state   text,
    phase           text,
    trigger         text,
    requested_at    timestamptz,
    started_at      timestamptz,
    finished_at     timestamptz,
    updated_at      timestamptz NOT NULL,
    report          jsonb NOT NULL DEFAULT '{}'::jsonb
);
-- One live Run per org, repository, PR, head and environment (a repository in two environments runs the same head
-- in each). NULLS NOT DISTINCT: a Run recorded without an environment still dedupes against another one without.
CREATE UNIQUE INDEX IF NOT EXISTS runtime_runs_one_live_per_environment_sha
    ON runtime.runtime_runs (organization_id, repository_id, pr_number, head_sha, environment_id) NULLS NOT DISTINCT
    WHERE state IN ('queued', 'awaiting_approval', 'booting', 'testing');
-- The live Runs of one org, or of every org (the global stop, the sweeper).
CREATE INDEX IF NOT EXISTS runtime_runs_live_idx ON runtime.runtime_runs (organization_id)
    WHERE state IN ('queued', 'awaiting_approval', 'booting', 'testing');
-- The runs page, a repository's Runs, a PR's Runs (the pull requests screens), an environment's Runs.
CREATE INDEX IF NOT EXISTS runtime_runs_org_requested_idx ON runtime.runtime_runs (organization_id, requested_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS runtime_runs_repo_requested_idx ON runtime.runtime_runs (organization_id, repository_id, requested_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS runtime_runs_pr_requested_idx ON runtime.runtime_runs (organization_id, repository_id, pr_number, requested_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS runtime_runs_env_requested_idx ON runtime.runtime_runs (environment_id, requested_at DESC NULLS LAST);

CREATE TABLE IF NOT EXISTS runtime.runtime_environment_setups (
    environment_id  text PRIMARY KEY,
    organization_id text NOT NULL,
    repository_id   text NOT NULL,
    setup_key       text NOT NULL,
    state           text NOT NULL,
    image_id        text,
    requested_at    timestamptz NOT NULL,
    updated_at      timestamptz NOT NULL,
    finished_at     timestamptz,
    record          jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS runtime_environment_setups_org_idx ON runtime.runtime_environment_setups (organization_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS runtime.runtime_lessons (
    lesson_id       text PRIMARY KEY,
    organization_id text NOT NULL,
    repository_id   text NOT NULL,
    environment_id  text,
    scope           text NOT NULL,
    signature       text NOT NULL,
    state           text NOT NULL,
    helped          integer NOT NULL,
    first_at        timestamptz,
    last_at         timestamptz NOT NULL,
    lesson          jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS runtime_lessons_org_signature_idx ON runtime.runtime_lessons (organization_id, signature);
CREATE INDEX IF NOT EXISTS runtime_lessons_org_active_idx ON runtime.runtime_lessons (organization_id, last_at DESC) WHERE state = 'active';
`,
    },
    {
        version: 22,
        name: 'code sandbox audit',
        // Every sandbox operation (docs/runtime/sandbox.md), per org, written by the hub: the op, the
        // exec's command redacted or the file op's path, and how it ended. Never output or file content.
        // Kept 30 days (applyRetention).
        sql: `CREATE TABLE IF NOT EXISTS runtime.runtime_sandbox_audit (
            id          bigserial PRIMARY KEY,
            org_id      text NOT NULL,
            claim_id    text NOT NULL,
            cell_id     text NOT NULL,
            step_id     uuid NOT NULL,
            op          text NOT NULL,
            command     text,
            path        text,
            outcome     text NOT NULL CHECK (outcome IN ('ok', 'refused', 'failed')),
            detail      text,
            exit_code   integer,
            bytes       bigint,
            duration_ms integer NOT NULL,
            at          timestamptz NOT NULL);
        CREATE INDEX IF NOT EXISTS runtime_sandbox_audit_org_at_idx ON runtime.runtime_sandbox_audit (org_id, at DESC);
        CREATE INDEX IF NOT EXISTS runtime_sandbox_audit_claim_idx ON runtime.runtime_sandbox_audit (claim_id);`,
    },
    {
        version: 23,
        name: 'claim vCPUs and the claims of an org by month, for the usage report',
        // cpus: the vCPUs of the claim's machine size, written with its metering by the hub (null at the cell's
        // default size, and on rows from before). The API's usage report (docs/runtime/usage-report.md) reads an
        // org's claims of one month with kodus_runtime_reader, on runtime_claims_org_created_idx.
        sql: `ALTER TABLE runtime.runtime_claims ADD COLUMN IF NOT EXISTS cpus integer;
        CREATE INDEX IF NOT EXISTS runtime_claims_org_created_idx ON runtime.runtime_claims (org_id, created_at);`,
    },
    {
        version: 24,
        name: 'claim start source and the cell default size, for the usage report',
        // start_source: how the claim's workload came to be, as the cell's claim.ready said (readyStart):
        // cold, pool or bake; null before the cell said, or for a cell that does not say.
        // default_claim_*: the size a claim that asks none runs at (hello capabilities.defaultSize), so
        // the hub records the vCPUs of such a claim in runtime_claims.cpus.
        sql: `ALTER TABLE runtime.runtime_claims ADD COLUMN IF NOT EXISTS start_source text CHECK (start_source IN ('cold', 'pool', 'bake'));
        ALTER TABLE runtime.runtime_cell_sessions ADD COLUMN IF NOT EXISTS default_claim_memory_mb integer;
        ALTER TABLE runtime.runtime_cell_sessions ADD COLUMN IF NOT EXISTS default_claim_cpus integer;`,
    },
    {
        version: 25,
        name: 'the cell sandbox size, for sandbox admission',
        // sandbox_claim_*: the size a code sandbox that asks none runs at (hello capabilities.sandboxSize),
        // so the hub admits it at that size and not at the cell's default Run size; null for a cell that
        // does not say (the hub's RUNTIME_SANDBOX_MEMORY_MB then).
        sql: `ALTER TABLE runtime.runtime_cell_sessions ADD COLUMN IF NOT EXISTS sandbox_claim_memory_mb integer;
        ALTER TABLE runtime.runtime_cell_sessions ADD COLUMN IF NOT EXISTS sandbox_claim_cpus integer;`,
    },
    {
        version: 26,
        name: 'cell registration tokens: issued time and revocation',
        // An org owner lists the org's recent tokens (never the token: only its hash is stored) and revokes an
        // unused one (docs/runtime/self-hosted.md). Redemption skips a revoked row in the UPDATE that burns it.
        // The API reads them with kodus_runtime_reader on runtime_cell_tokens_org_idx.
        sql: `ALTER TABLE runtime.runtime_cell_tokens ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
        ALTER TABLE runtime.runtime_cell_tokens ADD COLUMN IF NOT EXISTS revoked_at timestamptz;
        ALTER TABLE runtime.runtime_cell_tokens ADD COLUMN IF NOT EXISTS revoked_by text;
        CREATE INDEX IF NOT EXISTS runtime_cell_tokens_org_idx ON runtime.runtime_cell_tokens (organization_id, created_at);`,
    },
    {
        version: 27,
        name: 'preview URLs: previews, sessions, used grants, tunnel tickets and holders, audit',
        // docs/runtime/preview-urls.md. runtime_previews: one row per side of a Run a person opened; the worker
        // writes its state, the edge only last_activity_at and wake_requested_at. sealed_repo_token: the download
        // token the API minted for its last open, sealed to the preview (a wake after it expires asks to open again).
        // runtime_preview_sessions: the edge's cookie sessions, by the cookie's hash. runtime_preview_grants_used:
        // each grant's jti until it expires (single use). runtime_preview_tunnel_tickets: the hub's one-time tickets
        // for a cell's tunnel, by hash. runtime_preview_tunnels: which edge replica holds a cell's tunnel.
        // runtime_preview_audit: every session, refusal, start, wake, sleep, stop and expiry (§6.7); no IP, no path.
        sql: `CREATE TABLE IF NOT EXISTS runtime.runtime_previews (
            preview_id text PRIMARY KEY,
            org_id text NOT NULL,
            environment_id text NOT NULL,
            repository_id text NOT NULL,
            repository_full_name text NOT NULL,
            run_id text NOT NULL,
            side text NOT NULL CHECK (side IN ('base', 'pr')),
            sha text NOT NULL,
            host text NOT NULL UNIQUE,
            state text NOT NULL CHECK (state IN ('starting', 'ready', 'sleeping', 'blocked', 'stopped', 'expired')),
            reason text,
            opened_by text NOT NULL,
            without_secrets boolean NOT NULL DEFAULT true,
            starts integer NOT NULL DEFAULT 0,
            claim_id text,
            cell_id text,
            target_service text,
            target_port integer,
            lease_expires_at timestamptz,
            claim_hard_expires_at timestamptz,
            sealed_repo_token text,
            token_sealed_at timestamptz,
            wake_requested_at timestamptz,
            last_activity_at timestamptz,
            ready_at timestamptz,
            routed_at timestamptz,
            created_at timestamptz NOT NULL,
            updated_at timestamptz NOT NULL,
            expires_at timestamptz NOT NULL
        );
        CREATE INDEX IF NOT EXISTS runtime_previews_org_run_idx ON runtime.runtime_previews (org_id, run_id);
        CREATE INDEX IF NOT EXISTS runtime_previews_open_idx ON runtime.runtime_previews (updated_at) WHERE state IN ('starting', 'ready', 'sleeping', 'blocked');
        CREATE TABLE IF NOT EXISTS runtime.runtime_preview_sessions (
            session_hash text PRIMARY KEY,
            preview_id text NOT NULL,
            org_id text NOT NULL,
            user_id text NOT NULL,
            created_at timestamptz NOT NULL,
            expires_at timestamptz NOT NULL,
            closed_at timestamptz,
            requests bigint NOT NULL DEFAULT 0,
            bytes_in bigint NOT NULL DEFAULT 0,
            bytes_out bigint NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS runtime_preview_sessions_preview_idx ON runtime.runtime_preview_sessions (preview_id) WHERE closed_at IS NULL;
        CREATE TABLE IF NOT EXISTS runtime.runtime_preview_grants_used (jti text PRIMARY KEY, expires_at timestamptz NOT NULL);
        CREATE TABLE IF NOT EXISTS runtime.runtime_preview_tunnel_tickets (ticket_hash text PRIMARY KEY, cell_id text NOT NULL, expires_at timestamptz NOT NULL);
        CREATE TABLE IF NOT EXISTS runtime.runtime_preview_tunnels (
            cell_id text PRIMARY KEY,
            edge_replica text NOT NULL,
            connected_at timestamptz NOT NULL,
            seen_at timestamptz NOT NULL
        );
        CREATE TABLE IF NOT EXISTS runtime.runtime_preview_audit (
            id bigserial PRIMARY KEY,
            at timestamptz NOT NULL DEFAULT now(),
            org_id text NOT NULL,
            preview_id text NOT NULL,
            run_id text,
            side text,
            actor text,
            action text NOT NULL CHECK (action IN ('session_opened', 'session_refused', 'session_closed', 'started', 'woken', 'slept', 'stopped', 'expired')),
            reason text,
            requests bigint,
            bytes_in bigint,
            bytes_out bigint
        );
        CREATE INDEX IF NOT EXISTS runtime_preview_audit_org_at_idx ON runtime.runtime_preview_audit (org_id, at);
        CREATE INDEX IF NOT EXISTS runtime_preview_audit_preview_idx ON runtime.runtime_preview_audit (preview_id);`,
    },
    {
        version: 28,
        name: 'preview URLs phase 2: per-preview policy, pull request, environment previews, edge holder URL',
        // docs/runtime/preview-urls.md §15. The policy an open asked for (idle stop, one start's ceiling, the
        // org's monthly cap, a fork's PR side) lives on the preview so a wake applies it without the API.
        // pr_number: a newer Run of the PR or its closing ends the preview (runtime_previews_org_pr_idx).
        // run_id null: an environment's own preview. edge_url: where another edge replica forwards a request
        // for a cell whose tunnel this replica holds.
        sql: `ALTER TABLE runtime.runtime_previews ALTER COLUMN run_id DROP NOT NULL;
        ALTER TABLE runtime.runtime_previews ADD COLUMN IF NOT EXISTS pr_number integer;
        ALTER TABLE runtime.runtime_previews ADD COLUMN IF NOT EXISTS idle_minutes integer;
        ALTER TABLE runtime.runtime_previews ADD COLUMN IF NOT EXISTS ceiling_minutes integer;
        ALTER TABLE runtime.runtime_previews ADD COLUMN IF NOT EXISTS monthly_machine_minutes integer;
        ALTER TABLE runtime.runtime_previews ADD COLUMN IF NOT EXISTS fork_pull_request boolean NOT NULL DEFAULT false;
        CREATE INDEX IF NOT EXISTS runtime_previews_org_pr_idx ON runtime.runtime_previews (org_id, repository_id, pr_number) WHERE state IN ('starting', 'ready', 'sleeping', 'blocked');
        CREATE INDEX IF NOT EXISTS runtime_previews_org_env_idx ON runtime.runtime_previews (org_id, environment_id) WHERE run_id IS NULL AND state IN ('starting', 'ready', 'sleeping', 'blocked');
        ALTER TABLE runtime.runtime_preview_tunnels ADD COLUMN IF NOT EXISTS edge_url text;`,
    },
    {
        version: 29,
        name: 'cell registration tokens issued before 26: issued time from their expiry',
        // 26 added created_at with DEFAULT now(), so every token issued before it got the upgrade's time and showed
        // as just made in the owner's list of the last 24 hours (dev VM, 2026-11-13: eight tokens of up to two weeks
        // as "7 minutes ago"). A token is issued CELL_TOKEN_TTL_MS (15 min) before it expires; a created_at later
        // than that can only be the backfill's.
        sql: `UPDATE runtime.runtime_cell_tokens SET created_at = expires_at - interval '15 minutes'
            WHERE created_at > expires_at - interval '15 minutes';`,
    },
    {
        // 30, not 26: 26-29 were taken first; versions apply by number, so a gap is fine.
        version: 30,
        name: 'memory snapshot placement: the cell that holds a template or a session',
        // A memory snapshot never leaves the cell that took it (docs/runtime/isolation-p3-snapshots.md). The
        // worker records the cell of each sandbox template (template:<key>) and session (session:<id>) and
        // reserves that cell first for a sandbox that starts from it; any other cell boots the sandbox cold.
        sql: `CREATE TABLE IF NOT EXISTS runtime.runtime_snapshot_cells (
            org_id text NOT NULL,
            snapshot_ref text NOT NULL,
            cell_id text NOT NULL,
            created_at timestamptz NOT NULL DEFAULT now(),
            PRIMARY KEY (org_id, snapshot_ref)
        );`,
    },
    {
        // 31 after p3's 30 (next holds 26-29).
        version: 31,
        name: 'memory snapshot placement: the pull request a session holds the code of',
        // A session of a review's sandbox names its PR (SandboxSnapshotRequest.pullRequest): it is removed when
        // the PR closes or merges (the worker's pr_closed cancel), and the API's sweep finds the ones whose
        // close was lost (runtime_snapshot_cells_pr_idx, with kodus_runtime_reader).
        sql: `ALTER TABLE runtime.runtime_snapshot_cells ADD COLUMN IF NOT EXISTS repository_id text;
        ALTER TABLE runtime.runtime_snapshot_cells ADD COLUMN IF NOT EXISTS pr_number integer;
        CREATE INDEX IF NOT EXISTS runtime_snapshot_cells_pr_idx ON runtime.runtime_snapshot_cells (org_id, repository_id, pr_number) WHERE pr_number IS NOT NULL;`,
    },
    {
        // 32 after next-p3's 30-31 (next holds 26-29).
        version: 32,
        name: 'egress tiers: approval mode and revocation, the egress audit, the org egress settings',
        // docs/runtime/egress-allowlist.md §9. An approval is inspected (GET/HEAD under path_prefixes) or passthrough
        // (every approval before this one); a revoked row stays for the record and no claim gets it. environment_id '*'
        // is the org list (ORG_EGRESS_SCOPE). last_sent_at is when a claim last got the host (D5: approvals never
        // expire, the screen shows their last use). The runtime-worker writes all three tables from the outbox
        // commands; the API reads them with kodus_runtime_reader.
        sql: `ALTER TABLE runtime.runtime_egress_approvals ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'passthrough';
        ALTER TABLE runtime.runtime_egress_approvals ADD COLUMN IF NOT EXISTS path_prefixes text[] NOT NULL DEFAULT '{}';
        ALTER TABLE runtime.runtime_egress_approvals ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'blocker';
        ALTER TABLE runtime.runtime_egress_approvals ADD COLUMN IF NOT EXISTS revoked_at timestamptz;
        ALTER TABLE runtime.runtime_egress_approvals ADD COLUMN IF NOT EXISTS revoked_by text;
        ALTER TABLE runtime.runtime_egress_approvals ADD COLUMN IF NOT EXISTS last_sent_at timestamptz;
        CREATE TABLE IF NOT EXISTS runtime.runtime_egress_audit (
            id                  bigserial PRIMARY KEY,
            organization_id     text NOT NULL,
            environment_id      text,
            host                text,
            action              text NOT NULL,
            mode                text,
            path_prefixes       text[],
            actor               text NOT NULL,
            source              text NOT NULL,
            source_ref          text,
            recommended_version integer,
            reason              text,
            detail              jsonb,
            at                  timestamptz NOT NULL
        );
        CREATE INDEX IF NOT EXISTS runtime_egress_audit_org_idx ON runtime.runtime_egress_audit (organization_id, environment_id, at DESC);
        CREATE TABLE IF NOT EXISTS runtime.runtime_egress_settings (
            organization_id     text PRIMARY KEY,
            recommended_enabled boolean NOT NULL DEFAULT true,
            who_may_add         text NOT NULL DEFAULT 'owners',
            updated_by          text NOT NULL,
            updated_at          timestamptz NOT NULL
        );`,
    },
    {
        // 30 and 31 are next-p3's, 32 the egress branch's: this one takes 33, applied in version order either way.
        version: 33,
        name: 'build states a cell evicted: needs setup again',
        // docs/runtime/build-cache.md. The cell's disk floor removed every environment's build state on the dev cell
        // (2026-11-13) and nothing said so: the environments stayed "active" while their PRs built cold, calcom's past
        // its boot's ceiling. The hub keeps each cell's last heartbeat list (evictedBuildStates); the API shows the
        // environment as needing a setup again, and a Run whose build ran cold because of it says so.
        sql: `CREATE TABLE IF NOT EXISTS runtime.runtime_build_state_evictions (
            cell_id text NOT NULL,
            org_id text NOT NULL,
            environment_id text NOT NULL,
            evicted_at timestamptz NOT NULL,
            PRIMARY KEY (cell_id, org_id, environment_id)
        );
        CREATE INDEX IF NOT EXISTS runtime_build_state_evictions_env_idx ON runtime.runtime_build_state_evictions (org_id, environment_id);`,
    },
    {
        version: 34,
        name: 'what an evicted build state cost to make',
        // Heartbeat evictedBuildStates[].rebuildSeconds (cell feature buildStateRebuildCost): the hub refuses at admission
        // a Run's PR side whose cold build would pass its ready wait (claim.service.ts, architecture review P3).
        sql: `ALTER TABLE runtime.runtime_build_state_evictions ADD COLUMN IF NOT EXISTS rebuild_seconds integer;`,
    },
    {
        version: 35,
        name: "the org's own daily machine minutes",
        // Spec v18 PR 2 "teto de minutos de execução por org": an org admin lowers the deployment's
        // RUNTIME_MACHINE_MINUTES_PER_ORG_DAY for the org (PATCH /runtime/settings machineMinutesPerDay). The API sends
        // runtime.org.machine_minutes_changed; the runtime-worker writes this row; the hub reads it under the org day's
        // lock in every reserve (pg-machine-minutes.store.ts). NULL = the deployment's limit.
        sql: `CREATE TABLE IF NOT EXISTS runtime.runtime_org_machine_budget (
            organization_id text PRIMARY KEY,
            minutes_per_day integer CHECK (minutes_per_day IS NULL OR minutes_per_day > 0),
            updated_by      text NOT NULL,
            updated_at      timestamptz NOT NULL
        );`,
    },
    {
        // 35 is the org machine-minute budget; this one takes 36, applied in version order.
        version: 36,
        name: 'the versioned stability history of each probe shape',
        // §8 and ADR-050: what varied on each probe's base, by org, environment and probe shape
        // (gate/stability.ts probeKeyOf), with the normalizer version its field names belong to.
        // One row per Run and probe index; only the base's varying fields, never the PR's (S-36).
        // 90 days (applyRetention, STABILITY_RETENTION_DAYS), read by (org, environment, key, newest).
        sql: `CREATE TABLE IF NOT EXISTS runtime.runtime_stability (
            org_id text NOT NULL,
            environment_id text NOT NULL,
            run_id text NOT NULL,
            probe_index integer NOT NULL,
            probe_key text NOT NULL,
            normalizer_version text NOT NULL,
            unstable_fields text[] NOT NULL DEFAULT '{}',
            verdict text NOT NULL,
            base_rounds integer NOT NULL,
            pr_rounds integer NOT NULL,
            recorded_at timestamptz NOT NULL DEFAULT now(),
            PRIMARY KEY (org_id, run_id, probe_index)
        );
        CREATE INDEX IF NOT EXISTS runtime_stability_key_idx ON runtime.runtime_stability (org_id, environment_id, probe_key, recorded_at DESC);
        CREATE INDEX IF NOT EXISTS runtime_stability_recorded_brin ON runtime.runtime_stability USING brin (recorded_at);`,
    },
    {
        version: 37,
        name: 'each Run\'s outcome of the repository\'s kept checks',
        // docs/runtime/kept-checks.md §4 and §10: one row per Run and kept check, ids, an outcome
        // and a reason code only. Read by (org, kept check, newest) for the list's last outcome and
        // by (org, environment, repository) for the metric. 180 days (KEPT_CHECK_RESULTS_RETENTION_DAYS).
        sql: `CREATE TABLE IF NOT EXISTS runtime.runtime_kept_check_results (
            org_id text NOT NULL,
            environment_id text NOT NULL,
            repository_id text NOT NULL,
            run_id text NOT NULL,
            pr_number integer NOT NULL,
            kept_check_id text NOT NULL,
            source_pr_number integer NOT NULL,
            outcome text NOT NULL CHECK (outcome IN ('passed', 'failed', 'intended', 'stale', 'inconclusive', 'skipped')),
            stale_reason text CHECK (stale_reason IS NULL OR stale_reason IN ('target_gone', 'route_gone', 'baseline_changed')),
            recorded_at timestamptz NOT NULL DEFAULT now(),
            PRIMARY KEY (org_id, run_id, kept_check_id)
        );
        CREATE INDEX IF NOT EXISTS runtime_kept_check_results_check_idx ON runtime.runtime_kept_check_results (org_id, kept_check_id, recorded_at DESC);
        CREATE INDEX IF NOT EXISTS runtime_kept_check_results_repo_idx ON runtime.runtime_kept_check_results (org_id, environment_id, repository_id, recorded_at DESC);
        CREATE INDEX IF NOT EXISTS runtime_kept_check_results_recorded_brin ON runtime.runtime_kept_check_results USING brin (recorded_at);`,
    },
    {
        version: 38,
        name: 'baked images shared across the cells of an org',
        // docs/runtime/shared-baked-environments.md §8. runtime_bake_asks: each image.bake the hub sent, by cell,
        // org and bake key, so an image.shared is recorded only for a bake the hub asked of that cell (a day, applyRetention).
        // runtime_shared_images: one row per org, environment and build fingerprint, the newest bake (by its ask)
        // winning; the hub keeps the last SHARED_IMAGE_BAKES_KEPT bakes per environment (hub-store.ts).
        sql: `CREATE TABLE IF NOT EXISTS runtime.runtime_bake_asks (
            cell_id text NOT NULL,
            org_id text NOT NULL,
            environment_id text NOT NULL,
            env_key text NOT NULL,
            recipe_sha text NOT NULL,
            asked_at timestamptz NOT NULL,
            PRIMARY KEY (cell_id, org_id, environment_id, env_key, recipe_sha)
        );
        CREATE TABLE IF NOT EXISTS runtime.runtime_shared_images (
            org_id text NOT NULL,
            environment_id text NOT NULL,
            env_key text NOT NULL,
            recipe_sha text NOT NULL,
            fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
            digest text NOT NULL CHECK (digest ~ '^sha256:[0-9a-f]{64}$'),
            cell_id text NOT NULL,
            asked_at timestamptz NOT NULL,
            pushed_at timestamptz NOT NULL,
            last_pulled_at timestamptz,
            PRIMARY KEY (org_id, environment_id, fingerprint)
        );
        CREATE INDEX IF NOT EXISTS runtime_shared_images_env_idx ON runtime.runtime_shared_images (org_id, environment_id, asked_at DESC);`,
    },
    {
        version: 39,
        name: 'host pools, hosts, host events and pool demand; every cell in a pool',
        // docs/runtime/host-providers.md §5.2. runtime-fleet writes pools (spec and status), hosts and their events;
        // the hub writes static pools at registration and the pool of a cell; the worker's directory writes demand
        // (a Run that asked a perRun pool for room) and the fleet answers it (host, failure). A cell's pool, host,
        // bound key and cordon live on runtime_cells (hub) and are copied to its session at hello, so the directory
        // filters without a join. Every existing cell is backfilled into a static pool.
        sql: `CREATE TABLE IF NOT EXISTS runtime.runtime_host_pools (
            pool_id text PRIMARY KEY,
            scope text NOT NULL CHECK (scope = 'kodus' OR scope LIKE 'org:%'),
            organization_id text,
            provider text NOT NULL,
            lifecycle text NOT NULL CHECK (lifecycle IN ('perRun', 'pooled')),
            spec jsonb NOT NULL DEFAULT '{}'::jsonb,
            spec_hash text,
            weight integer NOT NULL DEFAULT 0,
            cordoned_at timestamptz,
            status jsonb NOT NULL DEFAULT '{}'::jsonb,
            created_at timestamptz NOT NULL DEFAULT now(),
            updated_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS runtime.runtime_hosts (
            host_id text PRIMARY KEY,
            pool_id text NOT NULL REFERENCES runtime.runtime_host_pools (pool_id),
            provider text NOT NULL,
            provider_id text,
            state text NOT NULL CHECK (state IN ('requested', 'provisioning', 'bootstrapping', 'ready', 'draining', 'terminating', 'terminated', 'failed')),
            bound_key text,
            organization_id text,
            usd_per_hour numeric,
            last_error text,
            created_at timestamptz NOT NULL DEFAULT now(),
            ready_at timestamptz,
            terminated_at timestamptz,
            updated_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS runtime_hosts_pool_live_idx ON runtime.runtime_hosts (pool_id, state) WHERE state <> 'terminated';
        CREATE UNIQUE INDEX IF NOT EXISTS runtime_hosts_provider_idx ON runtime.runtime_hosts (provider, provider_id) WHERE provider_id IS NOT NULL;
        CREATE TABLE IF NOT EXISTS runtime.runtime_host_events (
            id bigserial PRIMARY KEY,
            host_id text NOT NULL,
            pool_id text NOT NULL,
            from_state text,
            to_state text NOT NULL,
            reason text NOT NULL,
            detail text,
            at timestamptz NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS runtime_host_events_host_idx ON runtime.runtime_host_events (host_id, id);
        CREATE INDEX IF NOT EXISTS runtime_host_events_at_brin ON runtime.runtime_host_events USING brin (at);
        CREATE TABLE IF NOT EXISTS runtime.runtime_pool_demand (
            pool_id text NOT NULL,
            bound_key text NOT NULL,
            organization_id text NOT NULL,
            environment_id text,
            run_id text,
            size_mb integer,
            since timestamptz NOT NULL DEFAULT now(),
            expires_at timestamptz NOT NULL,
            host_id text,
            failed_at timestamptz,
            failure text,
            PRIMARY KEY (pool_id, bound_key)
        );
        CREATE INDEX IF NOT EXISTS runtime_pool_demand_open_idx ON runtime.runtime_pool_demand (pool_id, expires_at) WHERE failed_at IS NULL;
        ALTER TABLE runtime.runtime_cells ADD COLUMN IF NOT EXISTS pool_id text;
        ALTER TABLE runtime.runtime_cells ADD COLUMN IF NOT EXISTS host_id text;
        ALTER TABLE runtime.runtime_cells ADD COLUMN IF NOT EXISTS bound_key text;
        ALTER TABLE runtime.runtime_cells ADD COLUMN IF NOT EXISTS cordoned_at timestamptz;
        CREATE INDEX IF NOT EXISTS runtime_cells_host_idx ON runtime.runtime_cells (host_id) WHERE host_id IS NOT NULL;
        ALTER TABLE runtime.runtime_cell_sessions ADD COLUMN IF NOT EXISTS pool_id text;
        ALTER TABLE runtime.runtime_cell_sessions ADD COLUMN IF NOT EXISTS bound_key text;
        ALTER TABLE runtime.runtime_cell_sessions ADD COLUMN IF NOT EXISTS cordoned_at timestamptz;
        CREATE INDEX IF NOT EXISTS runtime_cell_sessions_bound_idx ON runtime.runtime_cell_sessions (bound_key) WHERE bound_key IS NOT NULL AND disconnected_at IS NULL;
        INSERT INTO runtime.runtime_host_pools (pool_id, scope, provider, lifecycle) VALUES ('kodus-static', 'kodus', 'static', 'pooled') ON CONFLICT DO NOTHING;
        INSERT INTO runtime.runtime_host_pools (pool_id, scope, organization_id, provider, lifecycle)
            SELECT DISTINCT 'org:' || o || '/default', 'org:' || o, o, 'static', 'pooled'
              FROM (SELECT organization_id AS o FROM runtime.runtime_cells WHERE owner = 'customer' AND organization_id IS NOT NULL
                    UNION SELECT org_id FROM runtime.runtime_cell_sessions WHERE owner = 'customer' AND org_id IS NOT NULL) orgs
            ON CONFLICT DO NOTHING;
        UPDATE runtime.runtime_cells SET pool_id = CASE WHEN owner = 'customer' AND organization_id IS NOT NULL THEN 'org:' || organization_id || '/default' ELSE 'kodus-static' END
         WHERE pool_id IS NULL;
        UPDATE runtime.runtime_cell_sessions s SET pool_id = COALESCE(c.pool_id, CASE WHEN s.owner = 'customer' AND s.org_id IS NOT NULL THEN 'org:' || s.org_id || '/default' ELSE 'kodus-static' END)
          FROM (SELECT cell_id FROM runtime.runtime_cell_sessions) x LEFT JOIN runtime.runtime_cells c ON c.cell_id = x.cell_id
         WHERE s.cell_id = x.cell_id AND s.pool_id IS NULL;`,
    },
    {
        version: 40,
        name: 'fleet registration tokens, one per host',
        // docs/runtime/host-providers.md §8.1: kcf_ tokens the hub mints for runtime-fleet's CN only; the hash, the
        // pool, host and Run they bind, single use (burned with the cell's insert). One row per host: a re-mint
        // replaces an unused token and never a used one.
        sql: `CREATE TABLE IF NOT EXISTS runtime.runtime_fleet_tokens (
            token_hash text PRIMARY KEY,
            pool_id text NOT NULL,
            host_id text NOT NULL UNIQUE,
            bound_key text,
            expires_at timestamptz NOT NULL,
            issued_by text NOT NULL,
            issued_at timestamptz NOT NULL DEFAULT now(),
            used_at timestamptz
        );`,
    },
    {
        version: 41,
        name: "each environment's template on a pool (a provider's saved snapshot)",
        // docs/runtime/host-providers.md §8.2: runtime-fleet writes it; a perRun host starts from the ready row of its
        // Run's environment on its pool. The snapshot name carries hashes, not the org's id. One ready row per
        // environment and pool (a newer one replaces the older, whose snapshot is deleted at the provider).
        sql: `CREATE TABLE IF NOT EXISTS runtime.runtime_env_templates (
            org_id text NOT NULL,
            environment_id text NOT NULL,
            pool_id text NOT NULL,
            fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{16,64}$'),
            snapshot_name text NOT NULL CHECK (snapshot_name ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
            state text NOT NULL CHECK (state IN ('building', 'ready', 'failed', 'replaced')),
            failure text,
            created_at timestamptz NOT NULL DEFAULT now(),
            updated_at timestamptz NOT NULL DEFAULT now(),
            ready_at timestamptz,
            replaced_at timestamptz,
            PRIMARY KEY (org_id, environment_id, pool_id, fingerprint)
        );
        CREATE INDEX IF NOT EXISTS runtime_env_templates_ready_idx ON runtime.runtime_env_templates (org_id, environment_id, pool_id, ready_at DESC) WHERE state = 'ready';`,
    },
    {
        version: 42,
        name: "a developer's env sessions and their steps (worker/env-session)",
        // Created at boot by the env-session store before, outside this list and its lock: two workers on a fresh
        // database could race on CREATE TABLE. Idempotent, so a database that already has them adopts them as they are.
        sql: `CREATE TABLE IF NOT EXISTS runtime.runtime_env_sessions (
            session_id uuid PRIMARY KEY,
            organization_id text NOT NULL,
            team_id text NOT NULL,
            repository_id text NOT NULL,
            key_id text NOT NULL,
            environment_id text NOT NULL,
            sha text NOT NULL,
            state text NOT NULL,
            claim_id text,
            cell_id text,
            lease_expires_at timestamptz,
            services jsonb,
            blockers jsonb,
            reason text,
            created_at timestamptz NOT NULL,
            last_used_at timestamptz NOT NULL
        );
        ALTER TABLE runtime.runtime_env_sessions ADD COLUMN IF NOT EXISTS validation_snapshot jsonb;
        ALTER TABLE runtime.runtime_env_sessions ADD COLUMN IF NOT EXISTS repositories jsonb;
        CREATE INDEX IF NOT EXISTS runtime_env_sessions_live ON runtime.runtime_env_sessions (organization_id) WHERE state IN ('acquiring', 'ready');
        CREATE INDEX IF NOT EXISTS runtime_env_sessions_idle ON runtime.runtime_env_sessions (last_used_at) WHERE state IN ('acquiring', 'ready');
        CREATE TABLE IF NOT EXISTS runtime.runtime_env_steps (
            step_id uuid PRIMARY KEY,
            session_id uuid NOT NULL,
            organization_id text NOT NULL,
            command text NOT NULL,
            timeout_ms integer NOT NULL,
            state text NOT NULL,
            started_at timestamptz NOT NULL,
            finished_at timestamptz,
            result jsonb
        );
        CREATE INDEX IF NOT EXISTS runtime_env_steps_started ON runtime.runtime_env_steps (started_at);`,
    },
    {
        version: 43,
        name: 'retention and read indexes on the tables that grow with claims',
        // Built concurrently: these tables take the hub's writes on every claim and sandbox operation.
        // BRIN for the append-only time columns applyRetention deletes by (rows arrive in time order, so a range
        // of pages covers a range of times, and a pass with nothing old to delete reads a few index pages);
        // runtime_claims_org_preview_idx for the month's preview minutes (Preview settings, the worker's cap);
        // runtime_cells_cert_expiry_idx for the hub's 5 s pin reload, which reads only cells whose certificate is valid.
        concurrentIndexes: [
            { name: 'runtime_sandbox_audit_at_brin', sql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS runtime_sandbox_audit_at_brin ON runtime.runtime_sandbox_audit USING brin (at)' },
            { name: 'runtime_preview_audit_at_brin', sql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS runtime_preview_audit_at_brin ON runtime.runtime_preview_audit USING brin (at)' },
            { name: 'runtime_claim_blockers_at_brin', sql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS runtime_claim_blockers_at_brin ON runtime.runtime_claim_blockers USING brin (at)' },
            { name: 'runtime_claims_created_brin', sql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS runtime_claims_created_brin ON runtime.runtime_claims USING brin (created_at)' },
            { name: 'runtime_machine_reservations_day_brin', sql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS runtime_machine_reservations_day_brin ON runtime.runtime_machine_reservations USING brin (day)' },
            {
                name: 'runtime_claims_org_preview_idx',
                sql: "CREATE INDEX CONCURRENTLY IF NOT EXISTS runtime_claims_org_preview_idx ON runtime.runtime_claims (org_id, created_at) WHERE consumer = 'preview'",
            },
            { name: 'runtime_cells_cert_expiry_idx', sql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS runtime_cells_cert_expiry_idx ON runtime.runtime_cells (certificate_expires_at)' },
        ],
    },
    {
        version: 44,
        name: 'the cell memory the heartbeat reports, for the API',
        // memory_allocatable_mb / memory_committed_mb: heartbeat memory (ADR-070), written by the hub when it
        // changes and at most every few minutes otherwise, so the API (read-only) can suggest the sandbox cap.
        sql: `ALTER TABLE runtime.runtime_cell_sessions ADD COLUMN IF NOT EXISTS memory_allocatable_mb integer;
        ALTER TABLE runtime.runtime_cell_sessions ADD COLUMN IF NOT EXISTS memory_committed_mb integer;`,
    },
    {
        version: 45,
        name: 'the sandbox pool the heartbeat reports, for the API',
        // sandbox_pool_target / sandbox_pool_ready: the warm pool of blank sandboxes (heartbeat sandboxPool), written
        // by the hub on the same throttle as the heartbeat memory. Null: a cell older than it or without a pool.
        sql: `ALTER TABLE runtime.runtime_cell_sessions ADD COLUMN IF NOT EXISTS sandbox_pool_target integer;
        ALTER TABLE runtime.runtime_cell_sessions ADD COLUMN IF NOT EXISTS sandbox_pool_ready integer;`,
    },
    {
        version: 46,
        name: 'the ended Runs the Run retention deletes by',
        // applyRetention deletes a Run `RUNTIME_RUN_RETENTION_DAYS` after it ended. The partial index holds only ended
        // Runs, by the time they ended (updated_at for one that never recorded finished_at), so a pass with nothing old
        // to delete reads one index page. Built concurrently: runtime_runs takes the worker's writes on every step.
        concurrentIndexes: [
            {
                name: 'runtime_runs_ended_idx',
                sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS runtime_runs_ended_idx ON runtime.runtime_runs ((COALESCE(finished_at, updated_at)))
                    WHERE state IN ('no_regressions', 'regression', 'partly_tested', 'could_not_boot', 'nothing_to_test', 'skipped', 'superseded', 'cancelled', 'timed_out', 'errored', 'halted')`,
            },
        ],
    },
    {
        version: 47,
        name: 'the setup an environment template build asked for',
        // setup_key / setup_requested_at: the command key the fleet chose for the setup that bakes a template and when it
        // asked. The product (read-only on this database) lists building rows with a key and no setup record yet and
        // issues the setup_requested command, because only it holds the repository and LLM credentials.
        sql: `ALTER TABLE runtime.runtime_env_templates ADD COLUMN IF NOT EXISTS setup_key text;
        ALTER TABLE runtime.runtime_env_templates ADD COLUMN IF NOT EXISTS setup_requested_at timestamptz;`,
    },
    {
        version: 48,
        name: 'why an evicted build state was not kept',
        // Heartbeat evictedBuildStates[].freeBytes and floorBytes (cell feature buildStateDiskFacts): the free space the
        // volume had when the disk floor removed the state and the floor, so the environment says why the cache was not kept.
        sql: `ALTER TABLE runtime.runtime_build_state_evictions ADD COLUMN IF NOT EXISTS free_bytes bigint;
        ALTER TABLE runtime.runtime_build_state_evictions ADD COLUMN IF NOT EXISTS floor_bytes bigint;`,
    },
    {
        version: 49,
        name: 'the setup host a template build boots',
        // setup_host_id: written with the building row before the setup host is created, so the fleet's orphan pass
        // (reconcile.ts) spares a host that runtime_hosts does not know while its template builds.
        sql: `ALTER TABLE runtime.runtime_env_templates ADD COLUMN IF NOT EXISTS setup_host_id text;`,
    },
    {
        version: 50,
        name: 'the setup records of environment template builds',
        // One row per template setup key (template:<org>/<env>:<hostId>): a template build's setup never writes the
        // environment's own record (runtime_environment_setups), so a failed template build cannot block the environment.
        sql: `CREATE TABLE IF NOT EXISTS runtime.runtime_template_setups (
            setup_key       text PRIMARY KEY,
            organization_id text NOT NULL,
            environment_id  text NOT NULL,
            state           text NOT NULL,
            record          jsonb NOT NULL DEFAULT '{}'::jsonb,
            updated_at      timestamptz NOT NULL
        );
        CREATE INDEX IF NOT EXISTS runtime_template_setups_env_idx ON runtime.runtime_template_setups (organization_id, environment_id);`,
    },
    {
        version: 51,
        name: 'the e2e suite runs, shards, results, baselines and spec durations',
        // docs/runtime/e2e-suites.md section 7. A suite run is the worker's (the product asks through a command); every
        // table carries the organization so the purge reaches it and a read is always scoped. Results are one row per
        // spec and phase (shard, rerun_pr, rerun_main): a shard reporting a spec twice writes it once. The baseline is
        // unique per (environment, main commit, suite digest). Spec stats hold the duration the next plan balances by.
        sql: `CREATE TABLE IF NOT EXISTS runtime.runtime_suite_runs (
            suite_run_id    text PRIMARY KEY,
            organization_id text NOT NULL,
            environment_id  text NOT NULL,
            repository_id   text NOT NULL,
            mode            text NOT NULL,
            state           text NOT NULL DEFAULT 'requested',
            pr_number       integer,
            pr_sha          text,
            merge_base      text,
            main_sha        text NOT NULL,
            suite_digest    text,
            selection       jsonb NOT NULL DEFAULT '{}'::jsonb,
            requested_at    timestamptz NOT NULL,
            finished_at     timestamptz,
            updated_at      timestamptz NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS runtime_suite_runs_pr_idx ON runtime.runtime_suite_runs (organization_id, environment_id, pr_number, requested_at DESC) WHERE pr_number IS NOT NULL;
        CREATE TABLE IF NOT EXISTS runtime.runtime_suite_shards (
            suite_run_id    text NOT NULL,
            shard           integer NOT NULL,
            organization_id text NOT NULL,
            state           text NOT NULL DEFAULT 'planned',
            specs           jsonb NOT NULL DEFAULT '[]'::jsonb,
            host_id         text,
            started_at      timestamptz,
            finished_at     timestamptz,
            updated_at      timestamptz NOT NULL DEFAULT now(),
            PRIMARY KEY (suite_run_id, shard)
        );
        CREATE TABLE IF NOT EXISTS runtime.runtime_suite_results (
            suite_run_id    text NOT NULL,
            phase           text NOT NULL,
            spec            text NOT NULL,
            organization_id text NOT NULL,
            shard           integer NOT NULL,
            status          text NOT NULL,
            duration_ms     integer NOT NULL DEFAULT 0,
            error_signature text,
            tests           jsonb NOT NULL DEFAULT '[]'::jsonb,
            recorded_at     timestamptz NOT NULL DEFAULT now(),
            PRIMARY KEY (suite_run_id, phase, spec)
        );
        CREATE TABLE IF NOT EXISTS runtime.runtime_suite_baselines (
            organization_id text NOT NULL,
            environment_id  text NOT NULL,
            main_sha        text NOT NULL,
            suite_digest    text NOT NULL,
            status          text NOT NULL,
            specs           jsonb NOT NULL DEFAULT '{}'::jsonb,
            finished_at     timestamptz NOT NULL,
            PRIMARY KEY (environment_id, main_sha, suite_digest)
        );
        CREATE INDEX IF NOT EXISTS runtime_suite_baselines_env_idx ON runtime.runtime_suite_baselines (organization_id, environment_id, finished_at DESC);
        CREATE TABLE IF NOT EXISTS runtime.runtime_suite_spec_stats (
            organization_id text NOT NULL,
            environment_id  text NOT NULL,
            spec            text NOT NULL,
            p50_ms          integer NOT NULL,
            last_ms         integer NOT NULL,
            samples         integer NOT NULL DEFAULT 1,
            last_seen_sha   text,
            updated_at      timestamptz NOT NULL DEFAULT now(),
            PRIMARY KEY (environment_id, spec)
        );`,
    },
    {
        version: 52,
        name: 'the baseline suite runs a template turning ready asks for',
        // docs/runtime/e2e-suites.md section 2.1. The fleet records the request (it holds no repository credentials); the
        // product reads the queued ones and issues RuntimeSuiteRequested with `suite_run_id`, so a redelivery finds one run.
        // One row per (environment, main commit); at most one queued per environment is kept by the writer.
        sql: `CREATE TABLE IF NOT EXISTS runtime.runtime_suite_baseline_requests (
            environment_id  text NOT NULL,
            main_sha        text NOT NULL,
            organization_id text NOT NULL,
            repository_id   text NOT NULL,
            fingerprint     text NOT NULL,
            suite_run_id    text NOT NULL,
            state           text NOT NULL DEFAULT 'queued',
            requested_at    timestamptz NOT NULL DEFAULT now(),
            started_at      timestamptz,
            updated_at      timestamptz NOT NULL DEFAULT now(),
            PRIMARY KEY (environment_id, main_sha)
        );
        CREATE INDEX IF NOT EXISTS runtime_suite_baseline_requests_queued_idx ON runtime.runtime_suite_baseline_requests (requested_at) WHERE state = 'queued';`,
    },
    {
        version: 53,
        name: 'the classification a suite run ends with',
        // docs/runtime/e2e-suites.md section 9: whose fault each red test was. The publisher reads it from the run after
        // the engine has gone (the check, the annotations, the Run's findings). Null for a baseline and for a run that ended before it.
        sql: `ALTER TABLE runtime.runtime_suite_runs ADD COLUMN IF NOT EXISTS classification jsonb;`,
    },
    {
        version: 54,
        name: 'the baseline a suite run was judged against and how far main had moved',
        // docs/runtime/e2e-suites.md 8.2: the check names the baseline commit and the drift in main commits ("update the branch
        // to confirm"). Set with the conclusion; null where the run used no baseline or ended before it. `selection` (v51) holds how the specs were chosen.
        sql: `ALTER TABLE runtime.runtime_suite_runs ADD COLUMN IF NOT EXISTS baseline_sha text;
        ALTER TABLE runtime.runtime_suite_runs ADD COLUMN IF NOT EXISTS base_drift integer;`,
    },
    {
        version: 55,
        name: 'the coverage maps of suite baselines',
        // docs/runtime/e2e-suites.md section 6.1: per spec the repository files it exercised on main, which selection reads to run only
        // the specs a PR reaches. Unique per (environment, main commit, suite digest) like a baseline, so a changed suite never reuses an
        // old map; the store keeps the newest complete map and the one before. The worker owns it: the product does not read it.
        sql: `CREATE TABLE IF NOT EXISTS runtime.runtime_suite_coverage_maps (
            organization_id text NOT NULL,
            environment_id  text NOT NULL,
            main_sha        text NOT NULL,
            suite_digest    text NOT NULL,
            status          text NOT NULL,
            specs           jsonb NOT NULL DEFAULT '{}'::jsonb,
            finished_at     timestamptz NOT NULL,
            PRIMARY KEY (environment_id, main_sha, suite_digest)
        );
        CREATE INDEX IF NOT EXISTS runtime_suite_coverage_maps_env_idx ON runtime.runtime_suite_coverage_maps (organization_id, environment_id, finished_at DESC);`,
    },
    {
        version: 56,
        name: 'the artifacts kept for the failed specs of a suite run',
        // docs/runtime/e2e-suites.md section 7: per failed spec the files kept as evidence (name, evidence key, content type, bytes), so the
        // suite page can open them by key. The objects live in the evidence store under the run's `suite-artifact` keys and follow its TTL.
        sql: `ALTER TABLE runtime.runtime_suite_results ADD COLUMN IF NOT EXISTS artifacts jsonb;`,
    },
    {
        version: 57,
        name: 'the shadow check of selection: shadows, their misses and the environment selection state',
        // docs/runtime/e2e-suites.md section 6.1 (Proof b) and D14. A shadow is a selected PR run that also ran in full in the background:
        // the worker records the request (it holds no repository credentials; the product issues the run), then what the full run found that
        // the selection skipped (`selection_misses`, one spec each, with the PR's changed files). The state row is what that does to the
        // environment: selected runs counted (every 5th, then 10th, gets a shadow), pull requests left on the whole suite after a miss, and off.
        sql: `CREATE TABLE IF NOT EXISTS runtime.runtime_suite_shadows (
            shadow_run_id    text PRIMARY KEY,
            organization_id  text NOT NULL,
            environment_id   text NOT NULL,
            repository_id    text NOT NULL,
            source_run_id    text NOT NULL UNIQUE,
            pr_number        integer NOT NULL,
            pr_sha           text NOT NULL,
            merge_base       text NOT NULL,
            main_sha         text NOT NULL,
            selected         jsonb NOT NULL DEFAULT '[]'::jsonb,
            changed_files    jsonb NOT NULL DEFAULT '[]'::jsonb,
            removed_files    jsonb NOT NULL DEFAULT '[]'::jsonb,
            state            text NOT NULL DEFAULT 'queued',
            selection_misses jsonb NOT NULL DEFAULT '[]'::jsonb,
            conclusive       boolean,
            requested_at     timestamptz NOT NULL DEFAULT now(),
            started_at       timestamptz,
            finished_at      timestamptz,
            updated_at       timestamptz NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS runtime_suite_shadows_env_idx ON runtime.runtime_suite_shadows (organization_id, environment_id, finished_at DESC) WHERE state = 'done';
        CREATE INDEX IF NOT EXISTS runtime_suite_shadows_queued_idx ON runtime.runtime_suite_shadows (requested_at) WHERE state = 'queued';
        CREATE TABLE IF NOT EXISTS runtime.runtime_suite_selection_state (
            organization_id text NOT NULL,
            environment_id  text PRIMARY KEY,
            selected_runs   integer NOT NULL DEFAULT 0,
            full_prs_left   integer NOT NULL DEFAULT 0,
            off             boolean NOT NULL DEFAULT false,
            off_at          timestamptz,
            reenabled_at    timestamptz,
            updated_at      timestamptz NOT NULL DEFAULT now()
        );`,
    },
    {
        version: 58,
        name: 'who turned an environment\'s spec selection off',
        // docs/runtime/e2e-suites.md D14: the shadow check (a brake) or a person. The settings screen shows a brake as "paused" with its
        // way to resume, and a person's choice as the switch it is. Null while selection is on.
        sql: `ALTER TABLE runtime.runtime_suite_selection_state ADD COLUMN IF NOT EXISTS off_by text;
        UPDATE runtime.runtime_suite_selection_state SET off_by = 'brake' WHERE off AND off_by IS NULL;`,
    },
    {
        version: 59,
        name: 'the machine time a suite run held hosts for',
        // docs/runtime/e2e-suites.md section 12 and usage-report.md: the time the run's hosts were held (a claim's acquire until its commands ended),
        // as the engine measured it: the first pass on the shard hosts, and the re-runs on the PR, main and fresh hosts. Summed over hosts, so
        // three shards of four minutes are twelve. Null on a run stored before this, and on one that ended before it measured: never zero.
        sql: `ALTER TABLE runtime.runtime_suite_runs ADD COLUMN IF NOT EXISTS first_pass_ms bigint;
        ALTER TABLE runtime.runtime_suite_runs ADD COLUMN IF NOT EXISTS rerun_ms bigint;`,
    },
    {
        version: 60,
        name: 'the hosts of a run found by their bound key',
        // The e2e suite tab reads a suite run's hosts by the prefix of their bound key (`suite:<org>/<run>/`), and the table keeps every
        // terminated host for the retention window: without this each page view scans it whole. text_pattern_ops serves the prefix LIKE.
        sql: `CREATE INDEX IF NOT EXISTS runtime_hosts_org_bound_key_idx ON runtime.runtime_hosts (organization_id, bound_key text_pattern_ops) WHERE bound_key IS NOT NULL;`,
    },
    {
        version: 61,
        name: 'an environment template records the cell base it was built from',
        // A template is a disk saved from a setup host that booted the pool's cell base, so it carries that base's cell. A pool
        // moved to a new base (a cell release, a security fix) must not keep starting Run hosts on the old cell until the
        // repository's setup changes: a template of another base is no ready template (template-store.ts), and the build that
        // replaces it records the old snapshot to delete once the new one is promoted. Rows from before this have no base ('').
        sql: `ALTER TABLE runtime.runtime_env_templates ADD COLUMN IF NOT EXISTS cell_base text NOT NULL DEFAULT '';
        ALTER TABLE runtime.runtime_env_templates ADD COLUMN IF NOT EXISTS retired_snapshot text;`,
    },
    {
        version: 62,
        name: 'why a baseline request ended without a run',
        // docs/runtime/e2e-suites.md section 2.1: a request ends `started` (its run exists), `skipped` (the recipe at its commit declares
        // no suite with a baseline) or `superseded` (a newer main commit replaced it while it was queued); `reason` is the code the
        // environment page turns into words. Null while queued or started. The product reads it with the read-only role.
        sql: `ALTER TABLE runtime.runtime_suite_baseline_requests ADD COLUMN IF NOT EXISTS reason text;`,
    },
];

/** The migration lock: the only constant advisory key (advisory-lock.ts). */
const MIGRATION_LOCK = lockKey('migration');
/** How often a process waiting for another's migrations asks for the lock again. */
export const MIGRATION_LOCK_POLL_MS = 250;

const CONCURRENT_INDEX_SQL = /^\s*CREATE\s+(UNIQUE\s+)?INDEX\s+CONCURRENTLY\s+IF\s+NOT\s+EXISTS\s+([a-z0-9_]+)\s+ON\s+runtime\./i;

/**
 * Waits for the migration lock by asking for it again every MIGRATION_LOCK_POLL_MS, never with a blocking
 * pg_advisory_lock: a session blocked in that call holds a snapshot for as long as it waits, CREATE INDEX
 * CONCURRENTLY waits for every older snapshot, and the lock holder building one then deadlocked with the
 * replica waiting for it (Postgres aborted the waiter's boot with "deadlock detected").
 */
async function takeMigrationLock(client: Pick<PoolClient, 'query'>, sleep: (ms: number) => Promise<void>) {
    const lock = lockStatement('pg_try_advisory_lock', MIGRATION_LOCK);
    while ((await client.query(lock.text, lock.values)).rows[0]?.acquired !== true) await sleep(MIGRATION_LOCK_POLL_MS);
}

async function buildConcurrently(client: Pick<PoolClient, 'query'>, ix: ConcurrentIndex) {
    const m = CONCURRENT_INDEX_SQL.exec(ix.sql);
    if (!m || m[2] !== ix.name) throw new Error(`concurrent index ${ix.name}: its sql must be CREATE INDEX CONCURRENTLY IF NOT EXISTS ${ix.name} ON runtime.<table>`);
    const r = await client.query(
        `SELECT i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'runtime' AND c.relname = $1`,
        [ix.name],
    );
    // Left INVALID by a build that was cut: IF NOT EXISTS would keep it, and the planner never uses it.
    if (r.rows[0] && r.rows[0].indisvalid === false) await client.query(`DROP INDEX CONCURRENTLY IF EXISTS runtime.${ix.name}`);
    await client.query(ix.sql);
}

export async function ensureRuntimeSchema(pool: Pool, migrations: ReadonlyArray<RuntimeMigration> = RUNTIME_MIGRATIONS, sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))): Promise<number[]> {
    const client = await pool.connect();
    const applied: number[] = [];
    try {
        await takeMigrationLock(client, sleep);
        await client.query(`CREATE SCHEMA IF NOT EXISTS runtime;
            CREATE TABLE IF NOT EXISTS runtime.schema_migrations (version integer PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
        const done = new Set((await client.query('SELECT version FROM runtime.schema_migrations')).rows.map((r) => Number(r.version)));
        for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
            if (done.has(m.version)) continue;
            try {
                if (m.concurrentIndexes) {
                    for (const ix of m.concurrentIndexes) await buildConcurrently(client, ix);
                    await client.query('INSERT INTO runtime.schema_migrations (version, name) VALUES ($1, $2) ON CONFLICT (version) DO NOTHING', [m.version, m.name]);
                } else {
                    await inTransaction(client, async () => {
                        await client.query(m.sql);
                        await client.query('INSERT INTO runtime.schema_migrations (version, name) VALUES ($1, $2)', [m.version, m.name]);
                    });
                }
                applied.push(m.version);
            } catch (e) {
                throw new Error(`runtime migration ${m.version} (${m.name}) failed: ${(e as Error).message}`, { cause: e });
            }
        }
        return applied;
    } finally {
        const unlock = lockStatement('pg_advisory_unlock', MIGRATION_LOCK);
        // A session lock that could not be released ends with its session: the connection is destroyed, not pooled.
        const unlocked = await client.query(unlock.text, unlock.values).then(() => true, () => false);
        client.release(unlocked ? undefined : true);
    }
}

/** Run stream rows one retention statement deletes at most: short transactions, never a long lock on the hub's appends. */
export const RUN_EVENTS_RETENTION_BATCH = 5_000;
/**
 * Batches one table's retention runs at most per pass (hourly): a backlog (a first pass on a large table, or
 * after the worker was down) drains over several passes instead of holding the maintenance lock for minutes.
 */
export const RETENTION_MAX_BATCHES = 200;
/**
 * Days a released claim is kept: the usage report reads any month's claims, and invoices look back a year.
 * The fleet cells those claims ran on are kept as long (the report reads a claim's cell owner).
 */
export const CLAIM_RETENTION_DAYS = 400;
/** Days an ended Run (its projection row and what hangs off it) is kept when RUNTIME_RUN_RETENTION_DAYS says nothing. */
export const DEFAULT_RUN_RETENTION_DAYS = 365;

/**
 * Deletes the rows of `table` that `where` selects, `batch` at a time (each its own short statement), until a
 * batch comes back short or RETENTION_MAX_BATCHES ran. `where` binds `$1`; the batch size is the last parameter.
 */
async function deleteInBatches(pool: Pick<Pool, 'query'>, table: string, where: string, value: unknown, batch: number): Promise<number> {
    let removed = 0;
    for (let i = 0; i < RETENTION_MAX_BATCHES; i++) {
        const n = (await pool.query(`DELETE FROM runtime.${table} WHERE ctid = ANY(ARRAY(SELECT ctid FROM runtime.${table} WHERE ${where} LIMIT $2))`, [value, batch])).rowCount ?? 0;
        removed += n;
        if (n < batch) break;
    }
    return removed;
}

/** Rows kept 30 days (§11): stream/evidence indexes and fully cleaned terminal admission intents. */
export async function applyRetention(pool: Pick<Pool, 'query'>, days = 30, batch = RUN_EVENTS_RETENTION_BATCH, runDays = DEFAULT_RUN_RETENTION_DAYS): Promise<number> {
    let removed = 0;
    const older = (column: string) => `${column} < now() - make_interval(days => $1)`;
    for (const [table, where, value] of [
        ['runtime_steps_index', older('created_at'), days],
        ['runtime_egress_events', older('at'), days],
        ['runtime_claim_blockers', older('at'), days],
        ['runtime_sandbox_audit', older('at'), days],
        ['runtime_preview_audit', older('at'), days],
        // Short-lived by design: gone once expired, whatever the retention.
        ['runtime_preview_grants_used', older('expires_at'), 0],
        ['runtime_preview_tunnel_tickets', older('expires_at'), 0],
        ['runtime_preview_sessions', older('expires_at'), days],
        // A developer's env commands and their output, and the sessions that ended (a live one stays, whatever its age).
        ['runtime_env_steps', older('started_at'), days],
        ['runtime_env_sessions', `state NOT IN ('acquiring', 'ready') AND ${older('last_used_at')}`, days],
        // A fleet host's rows once it ended: a failed host whose teardown is still owed is never removed.
        ['runtime_host_events', older('at'), days],
        ['runtime_hosts', `state = 'terminated' AND ${older('terminated_at')}`, days],
        ['runtime_pool_demand', older('expires_at'), days],
        // A fleet registration token is single use and expires within minutes: past its expiry it opens nothing.
        ['runtime_fleet_tokens', older('expires_at'), days],
        // A claim's machine-minute row counts only on its UTC day (pg-machine-minutes.store.ts reads today's).
        ['runtime_machine_reservations', `day < (now() AT TIME ZONE 'UTC')::date - $1::int`, days],
        // A bake's ask answers its image.shared within hours (bake and push): a day is plenty.
        ['runtime_bake_asks', older('asked_at'), 1],
        // The stability history keeps its own 90 days (§8), whatever the stream's retention.
        ['runtime_stability', older('recorded_at'), STABILITY_RETENTION_DAYS],
        // Kept-check outcomes feed the metric (docs/runtime/kept-checks.md §10): their own 180 days.
        ['runtime_kept_check_results', older('recorded_at'), KEPT_CHECK_RESULTS_RETENTION_DAYS],
        // A claim that ended (released or terminated; an open one never has released_at), past the report's year.
        // created_at bounds it on runtime_claims_created_brin: a claim never ends before it is made.
        ['runtime_claims', `released_at IS NOT NULL AND ${older('released_at')} AND ${older('created_at')}`, CLAIM_RETENTION_DAYS],
        // A suite run's shards and results follow the evidence TTL; the run row stays for the re-push rule while it is that young.
        ['runtime_suite_results', older('recorded_at'), days],
        ['runtime_suite_shards', older('updated_at'), days],
        ['runtime_suite_runs', `finished_at IS NOT NULL AND ${older('updated_at')}`, days],
        // A baseline request that ended (started, skipped or superseded) is history once its run's rows are gone.
        ['runtime_suite_baseline_requests', `state <> 'queued' AND ${older('updated_at')}`, days],
    ] as const) {
        removed += await deleteInBatches(pool, table, where, value, batch);
    }
    removed += await deleteEndedFleetCells(pool, CLAIM_RETENTION_DAYS);
    removed += await deleteEndedRuns(pool, runDays, batch);
    // The stream is the big table: oldest seq first, in batches, until a batch comes back short.
    for (;;) {
        const n =
            (
                await pool.query(
                    `DELETE FROM runtime.runtime_run_events WHERE seq IN (
                        SELECT seq FROM runtime.runtime_run_events WHERE created_at < now() - make_interval(days => $1) ORDER BY seq LIMIT $2)`,
                    [days, batch],
                )
            ).rowCount ?? 0;
        removed += n;
        if (n < batch) break;
    }
    // Admission payloads may contain large sealed requests: pages of at most 100, only after both logical execution
    // and physical ticket cleanup have completed, until a page comes back short (one page an hour fell behind past
    // 2 400 Runs and setups a day).
    const page = Math.min(batch, 100);
    for (let i = 0; i < RETENTION_MAX_BATCHES; i++) {
        const n =
            (
                await pool.query(
                    `WITH expired AS (
        SELECT org_id,kind,request_key FROM runtime.runtime_admission_requests
        WHERE NOT permit_held AND ticket IS NULL AND state IN ('completed','cancelled','expired','rejected')
          AND updated_at < now()-make_interval(days => $1)
        ORDER BY updated_at,org_id,kind,request_key LIMIT $2 FOR UPDATE SKIP LOCKED
    ) DELETE FROM runtime.runtime_admission_requests AS admission USING expired
      WHERE admission.org_id=expired.org_id AND admission.kind=expired.kind AND admission.request_key=expired.request_key`,
                    [days, page],
                )
            ).rowCount ?? 0;
        removed += n;
        if (n < page) break;
    }
    return removed;
}

/** The terminal states as a SQL list: the same set as `TERMINAL_STATES` (libs/runtime/run/run-state.ts), which the index of migration 46 spells out. */
const TERMINAL_RUN_STATES = [...TERMINAL_STATES];

/**
 * Runs that ended `days` ago, with the per-Run rows no other rule sweeps (the PR generation record, the fork approval
 * and the preview record), `batch` Runs at a time until a batch comes back short or RETENTION_MAX_BATCHES ran. Never a
 * Run that is not terminal, one a live claim still names, or one a kept check or the stability history still cites:
 * those rows keep their own (shorter) retention and the Run goes with the last of them. The stream, the steps index,
 * the claim blockers, the kept checks and the stability rows of a Run are older rows other rules already swept.
 */
async function deleteEndedRuns(pool: Pick<Pool, 'query'>, days: number, batch: number): Promise<number> {
    let removed = 0;
    for (let i = 0; i < RETENTION_MAX_BATCHES; i++) {
        const r = await pool.query(
            `WITH doomed AS (
                SELECT run_id, organization_id FROM runtime.runtime_runs r
                 WHERE r.state = ANY($1::text[])
                   AND COALESCE(r.finished_at, r.updated_at) < now() - make_interval(days => $2)
                   AND NOT EXISTS (SELECT 1 FROM runtime.runtime_claims c WHERE c.run_id = r.run_id AND c.released_at IS NULL)
                   AND NOT EXISTS (SELECT 1 FROM runtime.runtime_kept_check_results k WHERE k.run_id = r.run_id AND k.org_id = r.organization_id)
                   AND NOT EXISTS (SELECT 1 FROM runtime.runtime_stability s WHERE s.run_id = r.run_id AND s.org_id = r.organization_id)
                 ORDER BY COALESCE(r.finished_at, r.updated_at) LIMIT $3
                 FOR UPDATE OF r SKIP LOCKED),
             g AS (DELETE FROM runtime.runtime_pr_run_generations x USING doomed d WHERE x.run_id = d.run_id AND x.organization_id = d.organization_id),
             f AS (DELETE FROM runtime.runtime_fork_approvals x USING doomed d WHERE x.run_id = d.run_id),
             p AS (DELETE FROM runtime.runtime_previews x USING doomed d WHERE x.run_id = d.run_id AND x.org_id = d.organization_id
                     AND x.state NOT IN ('starting', 'ready', 'sleeping', 'blocked')),
             gone AS (DELETE FROM runtime.runtime_runs x USING doomed d WHERE x.run_id = d.run_id RETURNING 1)
             SELECT count(*)::int AS n FROM gone`,
            [TERMINAL_RUN_STATES, days, batch],
        );
        const n = Number(r.rows[0]?.n ?? 0);
        removed += n;
        if (n < batch) break;
    }
    return removed;
}

/**
 * A fleet cell (one a runtime-fleet host registered, host_id set) whose certificate expired `days` ago: it can
 * never connect again (the handshake refuses an expired certificate and a perRun host is gone), and without
 * this a perRun pool adds a row per Run for ever. Its session and revocations go with it. A customer's cell
 * and a managed one are never removed: the org's cell list shows them.
 */
async function deleteEndedFleetCells(pool: Pick<Pool, 'query'>, days: number): Promise<number> {
    const r = await pool.query(
        `WITH gone AS (
            DELETE FROM runtime.runtime_cells WHERE cell_id IN (
                SELECT cell_id FROM runtime.runtime_cells
                 WHERE host_id IS NOT NULL AND certificate_expires_at < now() - make_interval(days => $1) LIMIT 1000)
            RETURNING cell_id),
         s AS (DELETE FROM runtime.runtime_cell_sessions WHERE cell_id IN (SELECT cell_id FROM gone)),
         v AS (DELETE FROM runtime.runtime_cell_revocations WHERE cell_id IN (SELECT cell_id FROM gone))
         SELECT count(*)::int AS n FROM gone`,
        [days],
    );
    return Number(r.rows[0]?.n ?? 0);
}

/** Creates the Runtime database when missing (local and self-hosted bootstrap). */
export async function ensureDatabase(url: string): Promise<void> {
    const { Client } = await import('pg');
    const u = new URL(url);
    const db = u.pathname.slice(1);
    // A Runtime role that may connect only to its own database (ADR-046): if
    // it connects, the database exists and `postgres` is never touched.
    const own = new Client({ connectionString: url });
    try {
        await own.connect();
        return;
    } catch (e) {
        if ((e as { code?: string })?.code !== '3D000') throw e;
    } finally {
        // The probe client is done either way; ending one that never connected may fail and changes nothing.
        await own.end().catch(() => undefined);
    }
    u.pathname = '/postgres';
    const c = new Client({ connectionString: u.toString() });
    await c.connect();
    try {
        const r = await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [db]);
        if (r.rowCount === 0) await c.query(`CREATE DATABASE "${db.replace(/"/g, '')}"`);
    } finally {
        await c.end();
    }
}
