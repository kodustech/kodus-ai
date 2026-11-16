import { EGRESS_WHO_MAY_ADD } from '@libs/runtime/contracts/egress';
import type { SqlQuery } from '@libs/runtime/run/adapters/pg-sql';

import type { EgressApprovalRow, EgressAuditRow, EgressBlockedRow, EgressSettingsRow, RuntimeEgressReader } from '../domain/ports';

/** A table or column the Runtime's migrations have not made yet (42P01, 42703). */
const isUndefinedSchema = (e: unknown) => ['42P01', '42703'].includes((e as { code?: string })?.code ?? '');

/**
 * Reads runtime_egress_events (joined to runtime_claims for the Run) and
 * runtime_egress_approvals from the Runtime Postgres, through the shared
 * read-only RuntimeReadDb (ADR-025). Without RUNTIME_DATABASE_READ_URL a read
 * fails with 503, as every Runtime read does.
 */
export class PgRuntimeEgressReader implements RuntimeEgressReader {
    constructor(private readonly db: SqlQuery) {}

    private async query<T>(sql: string, params: unknown[]): Promise<T[]> {
        return (await this.db.query(sql, params)).rows as T[];
    }

    async blockedForRuns(organizationId: string, runIds: string[], since: Date): Promise<EgressBlockedRow[]> {
        if (!runIds.length) return [];
        const rows = await this.query<{ host: string; port: number; phase: string; count: string; last_at: Date }>(
            `SELECT e.host, e.port, e.phase, count(*) AS count, max(e.at) AS last_at
               FROM runtime.runtime_egress_events e
               JOIN runtime.runtime_claims c ON c.claim_id = e.claim_id
              WHERE e.org_id = $1 AND c.org_id = $1 AND c.run_id = ANY($2) AND e.at >= $3
              GROUP BY e.host, e.port, e.phase
              ORDER BY count(*) DESC
              LIMIT 200`,
            [organizationId, runIds, since],
        );
        return rows.map((r) => ({
            host: r.host,
            port: r.port,
            ...(r.phase === 'build' || r.phase === 'test' ? { phase: r.phase } : {}),
            count: Number(r.count),
            lastAt: new Date(r.last_at).toISOString(),
        }));
    }

    async approvals(organizationId: string, environmentId: string): Promise<EgressApprovalRow[]> {
        type Row = {
            host: string; approved_by: string; approved_at: Date; mode: string; path_prefixes: string[] | null; source: string;
            revoked_at: Date | null; revoked_by: string | null; last_sent_at: Date | null;
        };
        const rows = await this.query<Row>(
            `SELECT host, approved_by, approved_at, mode, path_prefixes, source, revoked_at, revoked_by, last_sent_at
               FROM runtime.runtime_egress_approvals
              WHERE organization_id = $1 AND environment_id = $2 ORDER BY (revoked_at IS NULL) DESC, approved_at DESC LIMIT 500`,
            [organizationId, environmentId],
        ).catch(async (e) => {
            // The API may run before the Runtime applied migration 32 (a rolling deploy): read the rows as they were.
            if (!isUndefinedSchema(e)) throw e;
            return this.query<Row>(
                `SELECT host, approved_by, approved_at, 'passthrough' AS mode, NULL AS path_prefixes, 'blocker' AS source, NULL AS revoked_at,
                        NULL AS revoked_by, NULL AS last_sent_at
                   FROM runtime.runtime_egress_approvals WHERE organization_id = $1 AND environment_id = $2 ORDER BY approved_at DESC LIMIT 500`,
                [organizationId, environmentId],
            );
        });
        return rows.map((r): EgressApprovalRow => ({
            host: r.host,
            approvedBy: r.approved_by,
            approvedAt: new Date(r.approved_at).toISOString(),
            mode: r.mode === 'inspected' ? 'inspected' : 'passthrough',
            ...(r.mode === 'inspected' && r.path_prefixes?.length ? { pathPrefixes: r.path_prefixes } : {}),
            source: r.source === 'settings' ? 'settings' : 'blocker',
            ...(r.revoked_at ? { revokedAt: new Date(r.revoked_at).toISOString(), ...(r.revoked_by ? { revokedBy: r.revoked_by } : {}) } : {}),
            ...(r.last_sent_at ? { lastSentAt: new Date(r.last_sent_at).toISOString() } : {}),
        }));
    }

    async settings(organizationId: string): Promise<EgressSettingsRow> {
        const rows = await this.query<{ recommended_enabled: boolean; who_may_add: string; updated_by: string; updated_at: Date }>(
            `SELECT recommended_enabled, who_may_add, updated_by, updated_at FROM runtime.runtime_egress_settings WHERE organization_id = $1`,
            [organizationId],
        ).catch((e) => {
            if (isUndefinedSchema(e)) return [];
            throw e;
        });
        const r = rows[0];
        if (!r) return { recommendedEnabled: true, whoMayAdd: 'owners' };
        const who = (EGRESS_WHO_MAY_ADD as readonly string[]).includes(r.who_may_add) ? (r.who_may_add as EgressSettingsRow['whoMayAdd']) : 'owners';
        return { recommendedEnabled: r.recommended_enabled !== false, whoMayAdd: who, updatedBy: r.updated_by, updatedAt: new Date(r.updated_at).toISOString() };
    }

    async audit(organizationId: string, environmentId?: string): Promise<EgressAuditRow[]> {
        type Row = {
            action: string; environment_id: string | null; host: string | null; mode: string | null; path_prefixes: string[] | null; actor: string;
            source: string; source_ref: string | null; recommended_version: number | null; reason: string | null; at: Date;
        };
        const rows = await this.query<Row>(
            `SELECT action, environment_id, host, mode, path_prefixes, actor, source, source_ref, recommended_version, reason, at
               FROM runtime.runtime_egress_audit
              WHERE organization_id = $1 AND ($2::text IS NULL OR environment_id = $2::text) ORDER BY at DESC LIMIT 200`,
            [organizationId, environmentId ?? null],
        ).catch((e): Row[] => {
            if (isUndefinedSchema(e)) return [];
            throw e;
        });
        return rows.map((r): EgressAuditRow => ({
            action: r.action === 'revoke' ? 'revoke' : r.action === 'settings' ? 'settings' : 'approve',
            ...(r.environment_id ? { environmentId: r.environment_id } : {}),
            ...(r.host ? { host: r.host } : {}),
            ...(r.mode ? { mode: r.mode } : {}),
            ...(r.path_prefixes?.length ? { pathPrefixes: r.path_prefixes } : {}),
            actor: r.actor,
            source: r.source,
            ...(r.source_ref ? { sourceRef: r.source_ref } : {}),
            ...(r.recommended_version ? { recommendedVersion: r.recommended_version } : {}),
            ...(r.reason ? { reason: r.reason } : {}),
            at: new Date(r.at).toISOString(),
        }));
    }
}
