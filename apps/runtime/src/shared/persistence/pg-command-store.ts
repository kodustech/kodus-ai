import type { LockScopedPg } from './lock-scoped-pg';
import type { Pool, PoolClient } from 'pg';

import type { CellTokenRecord, CellTokenStore } from '@libs/runtime/api/domain/cell-token';

// What the API decides, applied by the Runtime (the API never writes the
// Runtime database, ADR-025): approvals, stop, cell tokens and revocations.

export interface CommandStore {
    recordForkApproval(a: { key: string; runId: string; headSha: string; approver: string; approvedAt: string }): Promise<void>;
    hasForkApproval(runId: string, headSha: string): Promise<boolean>;
    recordEgressApproval(a: { environmentId: string; host: string; organizationId: string; approvedBy: string; approvedAt: string }): Promise<void>;
    /** Every host approved for an environment: the egress allowlist its live claims get. */
    approvedHosts(organizationId: string, environmentId: string): Promise<string[]>;
    recordStop(s: { scope: 'org' | 'global'; organizationId?: string; requestedBy: string; requestedAt: string }): Promise<void>;
    isStopped(organizationId: string): Promise<boolean>;
    /** Sets cleared_at on the active stops of the scope requested at or before `clearedAt`; idempotent. */
    clearStop(c: { scope: 'org' | 'global'; organizationId?: string; clearedAt: string }): Promise<number>;
    recordCellToken(t: CellTokenRecord): Promise<void>;
    revokeCell(r: { cellId: string; reason?: string; revokedBy: string }): Promise<void>;
}

export class InMemoryCommandStore implements CommandStore {
    approvals: any[] = [];
    egress: any[] = [];
    stops: any[] = [];
    tokens: CellTokenRecord[] = [];
    revoked: any[] = [];
    async recordForkApproval(a: any) {
        if (!this.approvals.some((x) => x.key === a.key)) this.approvals.push(a);
    }
    async hasForkApproval(runId: string, headSha: string) {
        return this.approvals.some((a) => a.runId === runId && a.headSha === headSha);
    }
    async recordEgressApproval(a: any) {
        this.egress.push(a);
    }
    async approvedHosts(orgId: string, envId: string) {
        return [...new Set(this.egress.filter((e) => e.organizationId === orgId && e.environmentId === envId).map((e) => String(e.host).toLowerCase()))].sort();
    }
    async recordStop(s: any) {
        this.stops.push(s);
    }
    async isStopped(orgId: string) {
        return this.stops.some((s) => !s.clearedAt && (s.scope === 'global' || s.organizationId === orgId));
    }
    async clearStop(c: { scope: 'org' | 'global'; organizationId?: string; clearedAt: string }) {
        let n = 0;
        for (const s of this.stops) {
            const inScope = s.scope === c.scope && (c.scope === 'global' || s.organizationId === c.organizationId);
            if (inScope && !s.clearedAt && Date.parse(s.requestedAt) <= Date.parse(c.clearedAt)) {
                s.clearedAt = c.clearedAt;
                n++;
            }
        }
        return n;
    }
    async recordCellToken(t: CellTokenRecord) {
        this.tokens.push(t);
    }
    async revokeCell(r: any) {
        this.revoked.push(r);
    }
}

type Queryable = Pick<Pool, 'query'> & Partial<Pick<Pool, 'connect'>>;

export class PgCommandStore implements CommandStore, CellTokenStore {
    /** A pool, or one client inside a transaction (the hub's token redemption). */
    constructor(private readonly pool: Queryable, private readonly scoped?: Pick<LockScopedPg, 'query'>) {}

    async recordForkApproval(a: { key: string; runId: string; headSha: string; approver: string; approvedAt: string }) {
        await this.pool.query(
            `INSERT INTO runtime.runtime_fork_approvals (key, run_id, head_sha, approver, approved_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (key) DO NOTHING`,
            [a.key, a.runId, a.headSha, a.approver, a.approvedAt],
        );
    }
    async hasForkApproval(runId: string, headSha: string) {
        const r = await this.pool.query(`SELECT 1 FROM runtime.runtime_fork_approvals WHERE run_id = $1 AND head_sha = $2`, [runId, headSha]);
        return (r.rowCount ?? 0) > 0;
    }
    async recordEgressApproval(a: { environmentId: string; host: string; organizationId: string; approvedBy: string; approvedAt: string }) {
        await this.pool.query(
            `INSERT INTO runtime.runtime_egress_approvals (environment_id, host, organization_id, approved_by, approved_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
            [a.environmentId, a.host.toLowerCase(), a.organizationId, a.approvedBy, a.approvedAt],
        );
    }
    async approvedHosts(organizationId: string, environmentId: string) {
        const r = await this.pool.query(
            `SELECT DISTINCT host FROM runtime.runtime_egress_approvals WHERE organization_id = $1 AND environment_id = $2 ORDER BY host`,
            [organizationId, environmentId],
        );
        return r.rows.map((x) => x.host as string);
    }
    async recordStop(s: { scope: 'org' | 'global'; organizationId?: string; requestedBy: string; requestedAt: string }) {
        // The outbox can deliver a stop after a later clear of the same scope:
        // the clear's tombstone (requested_by '<clear>') closes it on arrival.
        await this.pool.query(
            `INSERT INTO runtime.runtime_stops (scope, organization_id, requested_by, requested_at, cleared_at)
             VALUES ($1, $2, $3, $4,
                     (SELECT min(t.cleared_at) FROM runtime.runtime_stops t
                       WHERE t.requested_by = '<clear>' AND t.scope = $1 AND ($1 = 'global' OR t.organization_id = $2) AND t.cleared_at >= $4))`,
            [s.scope, s.organizationId ?? null, s.requestedBy, s.requestedAt],
        );
    }
    async isStopped(orgId: string) {
        const r = await (this.scoped ?? this.pool).query(
            `SELECT 1 FROM runtime.runtime_stops WHERE cleared_at IS NULL AND (scope = 'global' OR organization_id = $1) LIMIT 1`,
            [orgId],
        );
        return (r.rowCount ?? 0) > 0;
    }
    async clearStop(c: { scope: 'org' | 'global'; organizationId?: string; clearedAt: string }) {
        // The clear and its tombstone in one statement (a redelivered clear adds no second tombstone).
        const r = await this.pool.query(
            `WITH cleared AS (
               UPDATE runtime.runtime_stops SET cleared_at = $3
                WHERE cleared_at IS NULL AND scope = $1 AND ($1 = 'global' OR organization_id = $2) AND requested_at <= $3
                RETURNING id),
             tomb AS (
               INSERT INTO runtime.runtime_stops (scope, organization_id, requested_by, requested_at, cleared_at)
               SELECT $1, $2, '<clear>', $3, $3
                WHERE NOT EXISTS (SELECT 1 FROM runtime.runtime_stops t WHERE t.requested_by = '<clear>' AND t.scope = $1
                                    AND t.organization_id IS NOT DISTINCT FROM $2 AND t.cleared_at = $3)
               RETURNING id)
             SELECT (SELECT count(*) FROM cleared)::int AS n`,
            [c.scope, c.organizationId ?? null, c.clearedAt],
        );
        return Number(r.rows[0]?.n ?? 0);
    }
    async recordCellToken(t: CellTokenRecord) {
        await this.insert(t);
    }
    async insert(t: CellTokenRecord) {
        await this.pool.query(
            `INSERT INTO runtime.runtime_cell_tokens (token_hash, organization_id, topology, expires_at, issued_by) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
            [t.tokenHash, t.organizationId, t.topology, t.expiresAt, t.issuedBy],
        );
    }
    async consume(tokenHash: string, now: Date): Promise<CellTokenRecord | null> {
        const r = await this.pool.query(
            `UPDATE runtime.runtime_cell_tokens SET used_at = $2 WHERE token_hash = $1 AND used_at IS NULL RETURNING *`,
            [tokenHash, now],
        );
        const x = r.rows[0];
        return x
            ? { tokenHash: x.token_hash, organizationId: x.organization_id, topology: x.topology, expiresAt: x.expires_at.toISOString(), issuedBy: x.issued_by, usedAt: now.toISOString() }
            : null;
    }
    /**
     * The revocation, the cell's status and its live claims, in one
     * transaction: the claims of a revoked cell are terminated, so no worker
     * keeps sending them steps until the transport drops (the hub drops the
     * connection within its 5 s enforcement tick).
     */
    async revokeCell(r: { cellId: string; reason?: string; revokedBy: string }) {
        const client: PoolClient | undefined = this.pool.connect ? await this.pool.connect() : undefined;
        const q = client ?? this.pool;
        try {
            if (client) await client.query('BEGIN');
            await q.query(`INSERT INTO runtime.runtime_cell_revocations (cell_id, reason, revoked_by) VALUES ($1, $2, $3)`, [r.cellId, r.reason ?? null, r.revokedBy]);
            await q.query(`UPDATE runtime.runtime_cells SET status = 'revoked' WHERE cell_id = $1`, [r.cellId]);
            await q.query(
                `UPDATE runtime.runtime_claims SET state = 'terminated', released_at = now(), reason = 'cell_revoked', reason_detail = NULL, state_changed_at = now()
                  WHERE cell_id = $1 AND state IN ('pending', 'bound', 'held', 'blocked', 'failed')`,
                [r.cellId],
            );
            if (client) await client.query('COMMIT');
        } catch (e) {
            if (client) await client.query('ROLLBACK').catch(() => undefined);
            throw e;
        } finally {
            client?.release();
        }
    }
}
