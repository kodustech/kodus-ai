import { Pool } from 'pg';

import { createLogger } from '@libs/core/log/logger';

import type { EgressBlockedRow, RuntimeEgressReader } from '../domain/ports';

/**
 * Reads runtime_egress_events (joined to runtime_claims for the Run) and
 * runtime_egress_approvals from the Runtime Postgres, read-only (ADR-025).
 * Without RUNTIME_DATABASE_READ_URL the screens get empty lists, not a 503.
 */
export class PgRuntimeEgressReader implements RuntimeEgressReader {
    private pool?: Pool;
    private readonly logger = createLogger(PgRuntimeEgressReader.name);

    constructor(private readonly url: string | undefined) {
        if (!url) {
            this.logger.warn({
                message: 'RUNTIME_DATABASE_READ_URL is not set: egress events and approvals read as empty',
                context: PgRuntimeEgressReader.name,
            });
        }
    }

    private async query<T>(sql: string, params: unknown[]): Promise<T[]> {
        if (!this.url) return [];
        this.pool ??= new Pool({ connectionString: this.url, max: 2, idleTimeoutMillis: 30_000 });
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN READ ONLY');
            const res = await client.query(sql, params);
            await client.query('COMMIT');
            return res.rows as T[];
        } catch (e) {
            await client.query('ROLLBACK').catch(() => undefined);
            throw e;
        } finally {
            client.release();
        }
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

    async approvals(organizationId: string, environmentId: string) {
        const rows = await this.query<{ host: string; approved_by: string; approved_at: Date }>(
            `SELECT host, approved_by, approved_at FROM runtime.runtime_egress_approvals
              WHERE organization_id = $1 AND environment_id = $2 ORDER BY approved_at DESC LIMIT 500`,
            [organizationId, environmentId],
        );
        return rows.map((r) => ({ host: r.host, approvedBy: r.approved_by, approvedAt: new Date(r.approved_at).toISOString() }));
    }

    async onModuleDestroy() {
        await this.pool?.end();
    }
}
