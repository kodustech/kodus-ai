import { inTransaction, lockKey, lockStatement } from '@libs/runtime/run/adapters/advisory-lock';
import type { Pool } from 'pg';

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

/**
 * Versioned migrations of the Runtime database. Each runs once, in its own
 * transaction, recorded in runtime.schema_migrations; a process applies the
 * pending ones under an advisory lock, so replicas booting together apply
 * each once. Version 1 is the baseline above (idempotent DDL, so a database
 * created before versioning adopts it). Never edit an applied migration: add one.
 */
export const RUNTIME_MIGRATIONS: ReadonlyArray<{ version: number; name: string; sql: string }> = [
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
        // 30, not 26: kody-runtime/next holds 26-29; versions apply by number, so a gap is fine.
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
];

/** The migration lock: the only constant advisory key (advisory-lock.ts). */
const MIGRATION_LOCK = lockKey('migration');

export async function ensureRuntimeSchema(pool: Pool, migrations = RUNTIME_MIGRATIONS): Promise<number[]> {
    const client = await pool.connect();
    const applied: number[] = [];
    try {
        const lock = lockStatement('pg_advisory_lock', MIGRATION_LOCK);
        await client.query(lock.text, lock.values);
        await client.query(`CREATE SCHEMA IF NOT EXISTS runtime;
            CREATE TABLE IF NOT EXISTS runtime.schema_migrations (version integer PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
        const done = new Set((await client.query('SELECT version FROM runtime.schema_migrations')).rows.map((r) => Number(r.version)));
        for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
            if (done.has(m.version)) continue;
            try {
                await inTransaction(client, async () => {
                    await client.query(m.sql);
                    await client.query('INSERT INTO runtime.schema_migrations (version, name) VALUES ($1, $2)', [m.version, m.name]);
                });
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

/** Rows kept 30 days (§11): stream/evidence indexes and fully cleaned terminal admission intents. */
export async function applyRetention(pool: Pick<Pool, 'query'>, days = 30, batch = RUN_EVENTS_RETENTION_BATCH): Promise<number> {
    let removed = 0;
    for (const sql of [
        `DELETE FROM runtime.runtime_steps_index WHERE created_at < now() - make_interval(days => $1)`,
        `DELETE FROM runtime.runtime_egress_events WHERE at < now() - make_interval(days => $1)`,
        `DELETE FROM runtime.runtime_claim_blockers WHERE at < now() - make_interval(days => $1)`,
        `DELETE FROM runtime.runtime_sandbox_audit WHERE at < now() - make_interval(days => $1)`,
        `DELETE FROM runtime.runtime_preview_audit WHERE at < now() - make_interval(days => $1)`,
        // Short-lived by design: gone once expired, whatever the retention.
        `DELETE FROM runtime.runtime_preview_grants_used WHERE expires_at < now() - make_interval(days => 0 * $1)`,
        `DELETE FROM runtime.runtime_preview_tunnel_tickets WHERE expires_at < now() - make_interval(days => 0 * $1)`,
        `DELETE FROM runtime.runtime_preview_sessions WHERE expires_at < now() - make_interval(days => $1)`,
    ]) {
        removed += (await pool.query(sql, [days])).rowCount ?? 0;
    }
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
    // Admission payloads may contain large sealed requests. Delete one bounded page per tick,
    // only after both logical execution and physical ticket cleanup have completed.
    removed += (await pool.query(`WITH expired AS (
        SELECT org_id,kind,request_key FROM runtime.runtime_admission_requests
        WHERE NOT permit_held AND ticket IS NULL AND state IN ('completed','cancelled','expired','rejected')
          AND updated_at < now()-make_interval(days => $1)
        ORDER BY updated_at,org_id,kind,request_key LIMIT $2 FOR UPDATE SKIP LOCKED
    ) DELETE FROM runtime.runtime_admission_requests AS admission USING expired
      WHERE admission.org_id=expired.org_id AND admission.kind=expired.kind AND admission.request_key=expired.request_key`,
        [days, Math.min(batch, 100)])).rowCount ?? 0;
    return removed;
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
