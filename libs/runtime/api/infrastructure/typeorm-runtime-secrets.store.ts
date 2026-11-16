import type { RuntimeSecretAuditRecord, RuntimeSecretRecord, RuntimeSecretStore } from '../domain/secrets';
import type { Sql, TransactionalSql } from './typeorm-sql';

/** Secret metadata (never a value), in the product Postgres; one row per org and name. */
export const RUNTIME_SECRETS_TABLE = 'runtime_secrets';
/** Every change of a secret, kept with the org: who, when, the hosts, whether the value was replaced. */
export const RUNTIME_SECRET_AUDIT_TABLE = 'runtime_secret_audit';

const COLUMNS = `organization_id, secret_id, name, hosts, created_by, created_at, updated_by, updated_at, value_set_at`;

const iso = (v: unknown) => (v instanceof Date ? v : new Date(String(v))).toISOString();

function readRecord(row: any): RuntimeSecretRecord {
    return {
        organizationId: row.organization_id,
        secretId: row.secret_id,
        name: row.name,
        hosts: [...(row.hosts ?? [])],
        createdBy: row.created_by,
        createdAt: iso(row.created_at),
        updatedBy: row.updated_by,
        updatedAt: iso(row.updated_at),
        valueSetAt: iso(row.value_set_at),
    };
}

const recordValues = (r: RuntimeSecretRecord) => [r.organizationId, r.secretId, r.name, JSON.stringify(r.hosts), JSON.stringify(r.createdBy), r.createdAt, JSON.stringify(r.updatedBy), r.updatedAt, r.valueSetAt];

async function insertAudit(tx: Sql, a: RuntimeSecretAuditRecord) {
    await tx.query(
        `INSERT INTO ${RUNTIME_SECRET_AUDIT_TABLE} (audit_id, organization_id, secret_id, name, action, hosts, value_replaced, actor, at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::jsonb, $9::timestamptz)`,
        [a.auditId, a.organizationId, a.secretId, a.name, a.action, JSON.stringify(a.hosts), a.valueReplaced, JSON.stringify(a.actor), a.at],
    );
}

/** Every query names the org. A vault call runs inside the row's transaction, after the row is locked or inserted. */
export class TypeOrmRuntimeSecretStore implements RuntimeSecretStore {
    constructor(private readonly sql: TransactionalSql) {}

    async list(organizationId: string) {
        const { rows } = await this.sql.query(`SELECT ${COLUMNS} FROM ${RUNTIME_SECRETS_TABLE} WHERE organization_id = $1 ORDER BY name LIMIT 500`, [organizationId]);
        return rows.map(readRecord);
    }

    async count(organizationId: string) {
        const { rows } = await this.sql.query(`SELECT count(*)::int AS n FROM ${RUNTIME_SECRETS_TABLE} WHERE organization_id = $1`, [organizationId]);
        return Number(rows[0]?.n ?? 0);
    }

    async create(record: RuntimeSecretRecord, audit: RuntimeSecretAuditRecord, effect: () => Promise<void>) {
        return this.sql.transaction(async (tx) => {
            const { rows } = await tx.query(
                `INSERT INTO ${RUNTIME_SECRETS_TABLE} (${COLUMNS})
                 VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::timestamptz, $7::jsonb, $8::timestamptz, $9::timestamptz)
                 ON CONFLICT (organization_id, secret_id) DO NOTHING RETURNING ${COLUMNS}`,
                recordValues(record),
            );
            if (!rows[0]) return null;
            await insertAudit(tx, audit);
            await effect();
            return readRecord(rows[0]);
        });
    }

    async update(
        organizationId: string,
        secretId: string,
        change: (current: RuntimeSecretRecord) => { next: RuntimeSecretRecord; audit: RuntimeSecretAuditRecord },
        effect: (current: RuntimeSecretRecord, next: RuntimeSecretRecord) => Promise<void>,
    ) {
        return this.sql.transaction(async (tx) => {
            const { rows } = await tx.query(`SELECT ${COLUMNS} FROM ${RUNTIME_SECRETS_TABLE} WHERE organization_id = $1 AND secret_id = $2 FOR UPDATE`, [organizationId, secretId]);
            if (!rows[0]) return null;
            const current = readRecord(rows[0]);
            const { next, audit } = change(current);
            const updated = await tx.query(
                `UPDATE ${RUNTIME_SECRETS_TABLE} SET hosts = $3::jsonb, updated_by = $4::jsonb, updated_at = $5::timestamptz, value_set_at = $6::timestamptz
                 WHERE organization_id = $1 AND secret_id = $2 RETURNING ${COLUMNS}`,
                [organizationId, secretId, JSON.stringify(next.hosts), JSON.stringify(next.updatedBy), next.updatedAt, next.valueSetAt],
            );
            await insertAudit(tx, audit);
            await effect(current, next);
            return readRecord(updated.rows[0]);
        });
    }

    async delete(organizationId: string, secretId: string, audit: (current: RuntimeSecretRecord) => RuntimeSecretAuditRecord, effect: () => Promise<void>) {
        return this.sql.transaction(async (tx) => {
            const { rows } = await tx.query(`DELETE FROM ${RUNTIME_SECRETS_TABLE} WHERE organization_id = $1 AND secret_id = $2 RETURNING ${COLUMNS}`, [organizationId, secretId]);
            if (!rows[0]) return false;
            await insertAudit(tx, audit(readRecord(rows[0])));
            await effect();
            return true;
        });
    }

    async listAudit(organizationId: string, limit: number) {
        const { rows } = await this.sql.query(
            `SELECT audit_id, organization_id, secret_id, name, action, hosts, value_replaced, actor, at FROM ${RUNTIME_SECRET_AUDIT_TABLE}
             WHERE organization_id = $1 ORDER BY at DESC, audit_id LIMIT $2`,
            [organizationId, limit],
        );
        return rows.map(
            (r: any): RuntimeSecretAuditRecord => ({
                auditId: r.audit_id,
                organizationId: r.organization_id,
                secretId: r.secret_id,
                name: r.name,
                action: r.action,
                hosts: [...(r.hosts ?? [])],
                valueReplaced: !!r.value_replaced,
                actor: r.actor,
                at: iso(r.at),
            }),
        );
    }
}
