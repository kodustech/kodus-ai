import type { RecipeValidationSnapshot } from '@libs/runtime/contracts/recipe-validation';

import type { Pool } from 'pg';

import type { EnvSessionBlocker, EnvSessionOwner, EnvSessionState, EnvStepView } from '@libs/runtime/contracts/env-session';

// The dev's interactive sessions (consumer mcp) and their exec steps, in the
// Runtime Postgres: any worker replica answers a call for a session another
// one opened, and a step's result outlives the call that started it.

export interface EnvSessionRow extends Omit<EnvSessionOwner, 'repositoryIds'> {
    repositoryId: string;
    sessionId: string;
    environmentId: string;
    sha: string;
    /** Immutable authority from the setup recipe, never from guest files. */
    validationSnapshot?: RecipeValidationSnapshot;
    state: EnvSessionState;
    claimId?: string;
    cellId?: string;
    leaseExpiresAt?: string;
    services?: { name: string; health: 'ok' | 'failed' }[];
    blockers?: EnvSessionBlocker[];
    reason?: string;
    createdAt: string;
    lastUsedAt: string;
}

export interface EnvStepRow {
    stepId: string;
    sessionId: string;
    organizationId: string;
    command: string;
    timeoutMs: number;
    state: EnvStepView['state'];
    startedAt: string;
    finishedAt?: string;
    result?: Pick<EnvStepView, 'exitCode' | 'stdout' | 'stderr' | 'truncated' | 'durationMs' | 'redactions' | 'error'>;
}

/** Every read names the org: another org's session or step reads as absent. */
export interface EnvSessionStore {
    insert(row: EnvSessionRow): Promise<boolean>;
    get(organizationId: string, sessionId: string): Promise<EnvSessionRow | null>;
    update(organizationId: string, sessionId: string, patch: Partial<Omit<EnvSessionRow, 'sessionId' | 'organizationId'>>): Promise<void>;
    /** The live sessions (acquiring or ready) of an org, for the quota and for the key's reuse. */
    listLive(organizationId: string): Promise<EnvSessionRow[]>;
    /** Live sessions with no call since `idleBefore`, or past their lease, any org (the sweep). */
    listStale(idleBefore: string, now: string, limit: number): Promise<EnvSessionRow[]>;
    insertStep(row: EnvStepRow): Promise<void>;
    getStep(organizationId: string, stepId: string): Promise<EnvStepRow | null>;
    finishStep(organizationId: string, stepId: string, patch: Pick<EnvStepRow, 'state' | 'finishedAt' | 'result'>): Promise<void>;
}

export class InMemoryEnvSessionStore implements EnvSessionStore {
    readonly sessions = new Map<string, EnvSessionRow>();
    readonly steps = new Map<string, EnvStepRow>();

    async insert(row: EnvSessionRow) {
        if (this.sessions.has(row.sessionId)) return false;
        this.sessions.set(row.sessionId, structuredClone(row));
        return true;
    }
    async get(organizationId: string, sessionId: string) {
        const r = this.sessions.get(sessionId);
        return r && r.organizationId === organizationId ? structuredClone(r) : null;
    }
    async update(organizationId: string, sessionId: string, patch: Partial<EnvSessionRow>) {
        const r = this.sessions.get(sessionId);
        if (r && r.organizationId === organizationId) this.sessions.set(sessionId, { ...r, ...patch, validationSnapshot:r.validationSnapshot });
    }
    async listLive(organizationId: string) {
        return [...this.sessions.values()]
            .filter((s) => s.organizationId === organizationId && (s.state === 'acquiring' || s.state === 'ready'))
            .map((s) => structuredClone(s));
    }
    async listStale(idleBefore: string, now: string, limit: number) {
        return [...this.sessions.values()]
            .filter((s) => (s.state === 'acquiring' || s.state === 'ready') && (s.lastUsedAt < idleBefore || (!!s.leaseExpiresAt && s.leaseExpiresAt < now)))
            .slice(0, limit)
            .map((s) => structuredClone(s));
    }
    async insertStep(row: EnvStepRow) {
        this.steps.set(row.stepId, { ...row });
    }
    async getStep(organizationId: string, stepId: string) {
        const r = this.steps.get(stepId);
        return r && r.organizationId === organizationId ? { ...r } : null;
    }
    async finishStep(organizationId: string, stepId: string, patch: Pick<EnvStepRow, 'state' | 'finishedAt' | 'result'>) {
        const r = this.steps.get(stepId);
        if (r && r.organizationId === organizationId) this.steps.set(stepId, { ...r, ...patch });
    }
}

const SCHEMA = `
CREATE SCHEMA IF NOT EXISTS runtime;
CREATE TABLE IF NOT EXISTS runtime.runtime_env_sessions (
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
CREATE INDEX IF NOT EXISTS runtime_env_steps_started ON runtime.runtime_env_steps (started_at);
`;

const COLUMNS: Record<string, string> = {
    teamId: 'team_id',
    repositoryId: 'repository_id',
    keyId: 'key_id',
    environmentId: 'environment_id',
    sha: 'sha',
    state: 'state',
    claimId: 'claim_id',
    cellId: 'cell_id',
    leaseExpiresAt: 'lease_expires_at',
    services: 'services',
    blockers: 'blockers',
    reason: 'reason',
    createdAt: 'created_at',
    lastUsedAt: 'last_used_at',
};
const JSON_COLUMNS = new Set(['services', 'blockers']);

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v ? String(v) : undefined);

function sessionFrom(r: Record<string, any>): EnvSessionRow {
    return {
        sessionId: r.session_id,
        organizationId: r.organization_id,
        teamId: r.team_id,
        repositoryId: r.repository_id,
        keyId: r.key_id,
        environmentId: r.environment_id,
        sha: r.sha,
        state: r.state,
        ...(r.validation_snapshot ? {validationSnapshot: r.validation_snapshot} : {}),
        ...(r.claim_id ? { claimId: r.claim_id } : {}),
        ...(r.cell_id ? { cellId: r.cell_id } : {}),
        ...(r.lease_expires_at ? { leaseExpiresAt: iso(r.lease_expires_at) } : {}),
        ...(r.services ? { services: r.services } : {}),
        ...(r.blockers ? { blockers: r.blockers } : {}),
        ...(r.reason ? { reason: r.reason } : {}),
        createdAt: iso(r.created_at)!,
        lastUsedAt: iso(r.last_used_at)!,
    };
}

function stepFrom(r: Record<string, any>): EnvStepRow {
    return {
        stepId: r.step_id,
        sessionId: r.session_id,
        organizationId: r.organization_id,
        command: r.command,
        timeoutMs: Number(r.timeout_ms),
        state: r.state,
        startedAt: iso(r.started_at)!,
        ...(r.finished_at ? { finishedAt: iso(r.finished_at) } : {}),
        ...(r.result ? { result: r.result } : {}),
    };
}

export class PgEnvSessionStore implements EnvSessionStore {
    constructor(private readonly pool: Pool) {}

    /** Its own tables, created on boot like the rest of the Runtime schema. */
    static async ensureSchema(pool: Pool) {
        await pool.query(SCHEMA);
    }

    async insert(s: EnvSessionRow) {
        const result = await this.pool.query(
            `INSERT INTO runtime.runtime_env_sessions (session_id, organization_id, team_id, repository_id, key_id, environment_id, sha, state, created_at, last_used_at, validation_snapshot)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT (session_id) DO NOTHING RETURNING session_id`,
            [s.sessionId, s.organizationId, s.teamId, s.repositoryId, s.keyId, s.environmentId, s.sha, s.state, s.createdAt, s.lastUsedAt, s.validationSnapshot ? JSON.stringify(s.validationSnapshot) : null],
        );
        return result.rows.length === 1;
    }

    async get(organizationId: string, sessionId: string) {
        const { rows } = await this.pool.query(`SELECT * FROM runtime.runtime_env_sessions WHERE session_id = $1 AND organization_id = $2`, [
            sessionId,
            organizationId,
        ]);
        return rows[0] ? sessionFrom(rows[0]) : null;
    }

    async update(organizationId: string, sessionId: string, patch: Partial<EnvSessionRow>) {
        const sets: string[] = [];
        const values: unknown[] = [sessionId, organizationId];
        for (const [k, v] of Object.entries(patch)) {
            const col = COLUMNS[k];
            if (!col || v === undefined) continue;
            values.push(JSON_COLUMNS.has(col) ? JSON.stringify(v) : v);
            sets.push(`${col} = $${values.length}`);
        }
        if (!sets.length) return;
        await this.pool.query(`UPDATE runtime.runtime_env_sessions SET ${sets.join(', ')} WHERE session_id = $1 AND organization_id = $2`, values);
    }

    async listLive(organizationId: string) {
        const { rows } = await this.pool.query(
            `SELECT * FROM runtime.runtime_env_sessions WHERE organization_id = $1 AND state IN ('acquiring', 'ready') ORDER BY created_at DESC LIMIT 100`,
            [organizationId],
        );
        return rows.map(sessionFrom);
    }

    async listStale(idleBefore: string, now: string, limit: number) {
        const { rows } = await this.pool.query(
            `SELECT * FROM runtime.runtime_env_sessions WHERE state IN ('acquiring', 'ready') AND (last_used_at < $1 OR lease_expires_at < $2) ORDER BY last_used_at LIMIT $3`,
            [idleBefore, now, limit],
        );
        return rows.map(sessionFrom);
    }

    async insertStep(s: EnvStepRow) {
        await this.pool.query(
            `INSERT INTO runtime.runtime_env_steps (step_id, session_id, organization_id, command, timeout_ms, state, started_at) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [s.stepId, s.sessionId, s.organizationId, s.command, s.timeoutMs, s.state, s.startedAt],
        );
    }

    async getStep(organizationId: string, stepId: string) {
        const { rows } = await this.pool.query(`SELECT * FROM runtime.runtime_env_steps WHERE step_id = $1 AND organization_id = $2`, [stepId, organizationId]);
        return rows[0] ? stepFrom(rows[0]) : null;
    }

    async finishStep(organizationId: string, stepId: string, patch: Pick<EnvStepRow, 'state' | 'finishedAt' | 'result'>) {
        await this.pool.query(
            `UPDATE runtime.runtime_env_steps SET state = $3, finished_at = $4, result = $5 WHERE step_id = $1 AND organization_id = $2 AND state = 'running'`,
            [stepId, organizationId, patch.state, patch.finishedAt ?? null, patch.result ? JSON.stringify(patch.result) : null],
        );
    }
}
