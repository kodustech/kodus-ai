import { withTransaction } from '@libs/runtime/run/adapters/advisory-lock';
import { ORG_EGRESS_SCOPE } from '@libs/runtime/contracts/egress';
import { SANDBOX_ENVIRONMENT_ID } from '@libs/runtime/protocol/sandbox';
import type { LockScopedPg } from './lock-scoped-pg';
import type { Pool } from 'pg';

import type { CellTokenRecord, CellTokenStore } from '@libs/runtime/contracts/cell-token';
import { REVOCATION_TERMINATED_CLAIM_STATES } from '@libs/runtime/contracts/enums';

// What the API decides, applied by the Runtime (the API never writes the
// Runtime database): approvals, stop, cell tokens and revocations.

export interface CommandStore {
    recordForkApproval(a: { key: string; runId: string; headSha: string; approver: string; approvedAt: string }): Promise<void>;
    hasForkApproval(runId: string, headSha: string): Promise<boolean>;
    /**
     * An approval, or the same host approved again (a new mode, its paths, or after a revocation). A delivery older
     * than the row's last approval or revocation changes nothing: the outbox may replay it after a revoke.
     */
    recordEgressApproval(a: EgressApprovalRecord): Promise<void>;
    /** Revokes a live approval approved before `revokedAt`; true when it did (G3). */
    revokeEgressApproval(r: { environmentId: string; host: string; organizationId: string; revokedBy: string; revokedAt: string }): Promise<boolean>;
    /** One append-only row per approval, revocation and settings change (G4), written once per command key. */
    recordEgressAudit(a: EgressAuditRecord): Promise<void>;
    /** The org's outbound access settings (D2, D3); a change older than the stored one changes nothing. */
    recordEgressSettings(s: { organizationId: string; recommendedEnabled: boolean; whoMayAdd: string; updatedBy: string; updatedAt: string }): Promise<void>;
    /** The org's own daily machine minutes (null = the deployment's); a change older than the stored one changes nothing. */
    recordMachineMinuteLimit(s: { organizationId: string; minutesPerDay: number | null; updatedBy: string; updatedAt: string }): Promise<void>;
    machineMinuteLimit(organizationId: string): Promise<number | null>;
    /** Every host approved for an environment and the org list, none revoked: the egress allowlist its live claims get. */
    approvedHosts(organizationId: string, environmentId: string): Promise<string[]>;
    recordStop(s: { scope: 'org' | 'global'; organizationId?: string; requestedBy: string; requestedAt: string }): Promise<void>;
    isStopped(organizationId: string): Promise<boolean>;
    /** Sets cleared_at on the active stops of the scope requested at or before `clearedAt`; idempotent. */
    clearStop(c: { scope: 'org' | 'global'; organizationId?: string; clearedAt: string }): Promise<number>;
    recordCellToken(t: CellTokenRecord): Promise<void>;
    /** True when an unused token of that org was revoked now. */
    revokeCellToken(r: { tokenHash: string; organizationId: string; revokedAt: string; revokedBy: string }): Promise<boolean>;
    revokeCell(r: { cellId: string; reason?: string; revokedBy: string }): Promise<void>;
}

export interface EgressApprovalRecord {
    environmentId: string;
    host: string;
    organizationId: string;
    approvedBy: string;
    approvedAt: string;
    mode?: 'inspected' | 'passthrough';
    pathPrefixes?: string[];
    source?: 'blocker' | 'settings';
}

export interface EgressAuditRecord {
    key: string;
    organizationId: string;
    environmentId?: string;
    host?: string;
    action: 'approve' | 'revoke' | 'settings';
    mode?: string;
    pathPrefixes?: string[];
    actor: string;
    source: string;
    sourceRef?: string;
    recommendedVersion?: number;
    reason?: string;
    detail?: Record<string, unknown>;
    at: string;
}

export const egressScopes = (environmentId: string) => (environmentId === SANDBOX_ENVIRONMENT_ID ? [environmentId] : [environmentId, ORG_EGRESS_SCOPE]);

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
    async recordEgressApproval(a: EgressApprovalRecord) {
        await this.pool.query(
            `INSERT INTO runtime.runtime_egress_approvals (environment_id, host, organization_id, approved_by, approved_at, mode, path_prefixes, source)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (organization_id, environment_id, host) DO UPDATE
                SET approved_by = EXCLUDED.approved_by, approved_at = EXCLUDED.approved_at, mode = EXCLUDED.mode,
                    path_prefixes = EXCLUDED.path_prefixes, source = EXCLUDED.source, revoked_at = NULL, revoked_by = NULL
              WHERE runtime_egress_approvals.approved_at <= EXCLUDED.approved_at
                AND (runtime_egress_approvals.revoked_at IS NULL OR runtime_egress_approvals.revoked_at <= EXCLUDED.approved_at)`,
            [a.environmentId, a.host.toLowerCase(), a.organizationId, a.approvedBy, a.approvedAt, a.mode ?? 'passthrough', a.pathPrefixes ?? [], a.source ?? 'blocker'],
        );
    }
    async revokeEgressApproval(r: { environmentId: string; host: string; organizationId: string; revokedBy: string; revokedAt: string }) {
        const res = await this.pool.query(
            `UPDATE runtime.runtime_egress_approvals SET revoked_at = $4, revoked_by = $5
              WHERE organization_id = $1 AND environment_id = $2 AND host = $3 AND revoked_at IS NULL AND approved_at <= $4`,
            [r.organizationId, r.environmentId, r.host.toLowerCase(), r.revokedAt, r.revokedBy],
        );
        return (res.rowCount ?? 0) > 0;
    }
    async recordEgressAudit(a: EgressAuditRecord) {
        // The command key once: a redelivery adds no second row.
        await this.pool.query(
            `INSERT INTO runtime.runtime_egress_audit (organization_id, environment_id, host, action, mode, path_prefixes, actor, source, source_ref, recommended_version, reason, detail, at)
             SELECT $1::text, $2::text, $3::text, $4::text, $5::text, $6::text[], $7::text, $8::text, $9::text, $10::integer, $11::text, $12::jsonb, $13::timestamptz
              WHERE NOT EXISTS (SELECT 1 FROM runtime.runtime_egress_audit WHERE organization_id = $1::text AND detail->>'key' = $14::text)`,
            [a.organizationId, a.environmentId ?? null, a.host ?? null, a.action, a.mode ?? null, a.pathPrefixes ?? null, a.actor, a.source, a.sourceRef ?? null, a.recommendedVersion ?? null, a.reason ?? null, JSON.stringify({ ...(a.detail ?? {}), key: a.key }), a.at, a.key],
        );
    }
    async recordEgressSettings(s: { organizationId: string; recommendedEnabled: boolean; whoMayAdd: string; updatedBy: string; updatedAt: string }) {
        await this.pool.query(
            `INSERT INTO runtime.runtime_egress_settings (organization_id, recommended_enabled, who_may_add, updated_by, updated_at) VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (organization_id) DO UPDATE SET recommended_enabled = EXCLUDED.recommended_enabled, who_may_add = EXCLUDED.who_may_add,
                    updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at
              WHERE runtime_egress_settings.updated_at <= EXCLUDED.updated_at`,
            [s.organizationId, s.recommendedEnabled, s.whoMayAdd, s.updatedBy, s.updatedAt],
        );
    }
    async recordMachineMinuteLimit(s: { organizationId: string; minutesPerDay: number | null; updatedBy: string; updatedAt: string }) {
        await this.pool.query(
            `INSERT INTO runtime.runtime_org_machine_budget (organization_id, minutes_per_day, updated_by, updated_at) VALUES ($1, $2, $3, $4)
             ON CONFLICT (organization_id) DO UPDATE SET minutes_per_day = EXCLUDED.minutes_per_day, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at
              WHERE runtime_org_machine_budget.updated_at <= EXCLUDED.updated_at`,
            [s.organizationId, s.minutesPerDay, s.updatedBy, s.updatedAt],
        );
    }
    async machineMinuteLimit(organizationId: string) {
        const r = await this.pool.query(`SELECT minutes_per_day FROM runtime.runtime_org_machine_budget WHERE organization_id = $1`, [organizationId]);
        return r.rows[0]?.minutes_per_day ?? null;
    }
    async approvedHosts(organizationId: string, environmentId: string) {
        const r = await this.pool.query(
            `SELECT DISTINCT host FROM runtime.runtime_egress_approvals
              WHERE organization_id = $1 AND environment_id = ANY($2::text[]) AND revoked_at IS NULL ORDER BY host LIMIT 256`,
            [organizationId, egressScopes(environmentId)],
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
    async revokeCellToken(r: { tokenHash: string; organizationId: string; revokedAt: string; revokedBy: string }) {
        return this.revoke(r.tokenHash, r.organizationId, new Date(r.revokedAt), r.revokedBy);
    }
    async insert(t: CellTokenRecord) {
        await this.pool.query(
            `INSERT INTO runtime.runtime_cell_tokens (token_hash, organization_id, topology, expires_at, issued_by) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
            [t.tokenHash, t.organizationId, t.topology, t.expiresAt, t.issuedBy],
        );
    }
    async consume(tokenHash: string, now: Date): Promise<CellTokenRecord | null> {
        const r = await this.pool.query(
            `UPDATE runtime.runtime_cell_tokens SET used_at = $2 WHERE token_hash = $1 AND used_at IS NULL AND revoked_at IS NULL RETURNING *`,
            [tokenHash, now],
        );
        const x = r.rows[0];
        return x
            ? { tokenHash: x.token_hash, organizationId: x.organization_id, topology: x.topology, expiresAt: x.expires_at.toISOString(), issuedBy: x.issued_by, usedAt: now.toISOString() }
            : null;
    }
    async revoke(tokenHash: string, organizationId: string, at: Date, by: string): Promise<boolean> {
        // The same row lock as consume: a revoke and a redemption of one token cannot both win.
        const r = await this.pool.query(
            `UPDATE runtime.runtime_cell_tokens SET revoked_at = $3, revoked_by = $4
              WHERE token_hash = $1 AND organization_id = $2 AND used_at IS NULL AND revoked_at IS NULL`,
            [tokenHash, organizationId, at, by],
        );
        return r.rowCount === 1;
    }
    /**
     * The revocation, the cell's status and its live claims, in one
     * transaction: the claims of a revoked cell are terminated, so no worker
     * keeps sending them steps until the transport drops (the hub drops the
     * connection within its 5 s enforcement tick).
     */
    async revokeCell(r: { cellId: string; reason?: string; revokedBy: string }) {
        // A store on a pool revokes in its own transaction; one on a held connection runs in the caller's.
        const run = (fn: (q: Pick<Pool, 'query'>) => Promise<void>) =>
            this.pool.connect ? withTransaction(this.pool as Pick<Pool, 'connect'>, fn) : fn(this.pool);
        await run(async (q) => {
            await q.query(`INSERT INTO runtime.runtime_cell_revocations (cell_id, reason, revoked_by) VALUES ($1, $2, $3)`, [r.cellId, r.reason ?? null, r.revokedBy]);
            await q.query(`UPDATE runtime.runtime_cells SET status = 'revoked' WHERE cell_id = $1`, [r.cellId]);
            await q.query(
                `UPDATE runtime.runtime_claims SET state = 'terminated', released_at = now(), reason = 'cell_revoked', reason_detail = NULL, state_changed_at = now()
                  WHERE cell_id = $1 AND released_at IS NULL AND state = ANY($2::text[])`,
                [r.cellId, [...REVOCATION_TERMINATED_CLAIM_STATES]],
            );
        });
    }
}
