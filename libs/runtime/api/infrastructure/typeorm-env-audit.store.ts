import { DocumentTable, jsonb } from '@libs/runtime/run/adapters/pg-document';

import type { EnvAuditKind, EnvAuditRecord, RuntimeEnvAuditStore } from '../domain/env-tools';
import type { Sql } from './typeorm-sql';

/** Every env_exec and env_fix of a team key (S-27), in the product Postgres, kept 90 days (RuntimeProductRetention). */
export const RUNTIME_ENV_AUDIT_TABLE = 'runtime_env_audit';
export const ENV_AUDIT_RETENTION_DAYS = 90;

const AUDIT_COLUMNS = new DocumentTable<EnvAuditRecord>(
    [
        ['auditId', 'audit_id', 'text'],
        ['organizationId', 'organization_id', 'text'],
        ['teamId', 'team_id', 'text'],
        ['keyId', 'key_id', 'text'],
        ['repositoryId', 'repository_id', 'text'],
        ['kind', 'kind', 'text'],
        ['outcome', 'outcome', 'text'],
        ['at', 'at', 'timestamptz'],
    ],
    'record',
);

/** Every read names the org. */
export class TypeOrmRuntimeEnvAuditStore implements RuntimeEnvAuditStore {
    constructor(private readonly sql: Sql) {}

    async record(r: EnvAuditRecord) {
        const split = AUDIT_COLUMNS.split({ ...r });
        const columns = [...split.columns, 'record'];
        await this.sql.query(
            `INSERT INTO ${RUNTIME_ENV_AUDIT_TABLE} (${columns.join(', ')}) VALUES (${columns.map((c, i) => (c === 'record' ? `$${i + 1}::jsonb` : `$${i + 1}`)).join(', ')})`,
            [...split.values, jsonb(split.rest)],
        );
    }

    async setOutcome(organizationId: string, auditId: string, outcome: EnvAuditRecord['outcome'], reason?: string) {
        await this.sql.query(
            `UPDATE ${RUNTIME_ENV_AUDIT_TABLE} SET outcome = $3, record = CASE WHEN $4::text IS NULL THEN record ELSE record || jsonb_build_object('reason', $4::text) END
             WHERE audit_id = $1 AND organization_id = $2`,
            [auditId, organizationId, outcome, reason || null],
        );
    }

    async countAccepted(q: { organizationId: string; keyId?: string; since: string }) {
        const row = (
            await this.sql.query(
                `SELECT count(*)::int AS n FROM ${RUNTIME_ENV_AUDIT_TABLE}
                 WHERE organization_id = $1 AND kind = 'env_exec' AND outcome = 'accepted' AND at >= $2::timestamptz${q.keyId ? ' AND key_id = $3' : ''}`,
                q.keyId ? [q.organizationId, q.since, q.keyId] : [q.organizationId, q.since],
            )
        ).rows[0];
        return Number(row?.n ?? 0);
    }

    async list(q: { organizationId: string; kind: EnvAuditKind; limit: number; before?: string }) {
        const values: unknown[] = [q.organizationId, q.kind];
        if (q.before) values.push(q.before);
        values.push(q.limit);
        const rows = (
            await this.sql.query(
                `SELECT ${AUDIT_COLUMNS.selectList} FROM ${RUNTIME_ENV_AUDIT_TABLE}
                 WHERE organization_id = $1 AND kind = $2${q.before ? ' AND at < $3::timestamptz' : ''}
                 ORDER BY at DESC LIMIT $${values.length}`,
                values,
            )
        ).rows;
        return rows.map((r) => AUDIT_COLUMNS.read(r));
    }
}
