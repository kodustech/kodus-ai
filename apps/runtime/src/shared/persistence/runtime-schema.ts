import type { Pool } from 'pg';

// Tables of the Runtime database next to the DBOS system tables (docs §8).
// Only the hub role writes runtime_cell_sessions and runtime_steps_index.

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
];

const MIGRATION_LOCK = 727001;

export async function ensureRuntimeSchema(pool: Pool, migrations = RUNTIME_MIGRATIONS): Promise<number[]> {
    const client = await pool.connect();
    const applied: number[] = [];
    try {
        await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK]);
        await client.query(`CREATE SCHEMA IF NOT EXISTS runtime;
            CREATE TABLE IF NOT EXISTS runtime.schema_migrations (version integer PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
        const done = new Set((await client.query('SELECT version FROM runtime.schema_migrations')).rows.map((r) => Number(r.version)));
        for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
            if (done.has(m.version)) continue;
            await client.query('BEGIN');
            try {
                await client.query(m.sql);
                await client.query('INSERT INTO runtime.schema_migrations (version, name) VALUES ($1, $2)', [m.version, m.name]);
                await client.query('COMMIT');
                applied.push(m.version);
            } catch (e) {
                await client.query('ROLLBACK').catch(() => undefined);
                throw new Error(`runtime migration ${m.version} (${m.name}) failed: ${(e as Error).message}`, { cause: e });
            }
        }
        return applied;
    } finally {
        await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK]).catch(() => undefined);
        client.release();
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
