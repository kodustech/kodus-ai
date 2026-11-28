import type { EnvironmentSetupProgress, EnvironmentSetupRecord } from '../environment-setup';
import { jsonb } from './pg-document';
import type { SqlQuery } from './pg-sql';

// The setup records of environment TEMPLATE builds (runtime.runtime_template_setups, docs/runtime/host-providers.md
// §8.2): a setup whose command carries a template bound key writes here, one row per setup key, and never touches the
// environment's own record (runtime.runtime_environment_setups). The whole record is `record`.

export const RUNTIME_TEMPLATE_SETUPS_TABLE = 'runtime.runtime_template_setups';

export class PgTemplateSetupStore {
    constructor(private readonly db: SqlQuery) {}

    /** The record of one template setup, by its command key; with an org, a record of another org reads as absent. */
    async get(setupKey: string, organizationId?: string): Promise<EnvironmentSetupRecord | null> {
        const res = await this.db.query(
            `SELECT record FROM ${RUNTIME_TEMPLATE_SETUPS_TABLE} WHERE setup_key = $1${organizationId ? ' AND organization_id = $2' : ''}`,
            organizationId ? [setupKey, organizationId] : [setupKey],
        );
        return res.rows[0] ? (res.rows[0].record as EnvironmentSetupRecord) : null;
    }

    async save(record: EnvironmentSetupRecord): Promise<void> {
        await this.db.query(
            `INSERT INTO ${RUNTIME_TEMPLATE_SETUPS_TABLE} (setup_key, organization_id, environment_id, state, record, updated_at)
             VALUES ($1, $2, $3, $4, $5::jsonb, $6)
             ON CONFLICT (setup_key) DO UPDATE SET state = EXCLUDED.state, record = EXCLUDED.record, updated_at = EXCLUDED.updated_at`,
            [record.key, record.organizationId, record.environmentId, record.state, jsonb(record), record.updatedAt],
        );
    }

    /** Only the setup still running: a late poll never writes over a finished one. */
    async saveProgress(_environmentId: string, key: string, progress: EnvironmentSetupProgress): Promise<void> {
        await this.db.query(
            `UPDATE ${RUNTIME_TEMPLATE_SETUPS_TABLE} SET record = jsonb_set(record, '{progress}', $2::jsonb) WHERE setup_key = $1 AND state = 'setting_up'`,
            [key, jsonb(progress)],
        );
    }
}
