import type { EnvironmentSetupProgress, EnvironmentSetupRecord, EnvironmentSetupState } from '../environment-setup';
import { DocumentTable, jsonb } from './pg-document';
import type { SqlQuery } from './pg-sql';

// The latest setup of each environment (runtime.runtime_environment_setups,
// docs §8): the runtime-worker's setup workflow writes it; the API reads it
// with the read-only role for Environment Health and the expose list of a
// "Run again" (ADR-025).

export const RUNTIME_ENVIRONMENT_SETUPS_TABLE = 'runtime.runtime_environment_setups';

/** What the reads filter on, as columns; everything else of the record (steps, recipe, learn, progress…) is `record`. */
export const SETUP_COLUMNS = new DocumentTable<EnvironmentSetupRecord>(
    [
        ['environmentId', 'environment_id', 'text'],
        ['organizationId', 'organization_id', 'text'],
        ['repositoryId', 'repository_id', 'text'],
        ['key', 'setup_key', 'text'],
        ['state', 'state', 'text'],
        ['imageId', 'image_id', 'text'],
        ['requestedAt', 'requested_at', 'timestamptz'],
        ['updatedAt', 'updated_at', 'timestamptz'],
        ['finishedAt', 'finished_at', 'timestamptz'],
    ],
    'record',
);

const SETUP_FIELDS = SETUP_COLUMNS.specs.map(([, c]) => c);

/** Reads of the setups; the API is handed only these. */
export class PgEnvironmentSetupReads {
    constructor(protected readonly db: SqlQuery) {}

    /** The setup of an environment; with an org, a setup of another org reads as absent. */
    async get(environmentId: string, organizationId?: string): Promise<EnvironmentSetupRecord | null> {
        const res = await this.db.query(
            `SELECT ${SETUP_COLUMNS.selectList} FROM ${RUNTIME_ENVIRONMENT_SETUPS_TABLE} WHERE environment_id = $1${organizationId ? ' AND organization_id = $2' : ''}`,
            organizationId ? [environmentId, organizationId] : [environmentId],
        );
        return res.rows[0] ? SETUP_COLUMNS.read(res.rows[0]) : null;
    }

    /** The state of each of these environments of one org, in one query. */
    async states(organizationId: string, environmentIds: string[], timeoutMs?: number): Promise<Map<string, EnvironmentSetupState>> {
        if (!organizationId || environmentIds.length === 0) return new Map();
        const res = await this.db.query(
            `SELECT environment_id, state FROM ${RUNTIME_ENVIRONMENT_SETUPS_TABLE} WHERE organization_id = $1 AND environment_id = ANY($2::text[])`,
            [organizationId, environmentIds],
            timeoutMs ? { timeoutMs } : undefined,
        );
        return new Map(res.rows.map((r) => [String(r.environment_id), r.state as EnvironmentSetupState]));
    }
}

/**
 * The runtime-worker's store: one row per environment, replaced by each save of its latest setup. A save of a setup
 * requested before the one the row holds is dropped: two setups of one environment that raced must not leave the
 * older one's record last, which the product reads as a setup still running (push-setup.ts isSetupInFlight).
 */
export class PgEnvironmentSetupStore extends PgEnvironmentSetupReads {
    async save(record: EnvironmentSetupRecord): Promise<void> {
        const split = SETUP_COLUMNS.split({ ...record } as Record<string, unknown>);
        // A whole record: the columns it leaves out are cleared, as Mongo's replaceOne did.
        const values = SETUP_FIELDS.map((c) => {
            const i = split.columns.indexOf(c);
            return i < 0 ? null : split.values[i];
        });
        const columns = [...SETUP_FIELDS, 'record'];
        await this.db.query(
            `INSERT INTO ${RUNTIME_ENVIRONMENT_SETUPS_TABLE} (${columns.join(', ')})
             VALUES (${columns.map((c, i) => (c === 'record' ? `$${i + 1}::jsonb` : `$${i + 1}`)).join(', ')})
             ON CONFLICT (environment_id) DO UPDATE SET ${columns.filter((c) => c !== 'environment_id').map((c) => `${c} = EXCLUDED.${c}`).join(', ')}
             WHERE ${RUNTIME_ENVIRONMENT_SETUPS_TABLE}.requested_at IS NULL OR EXCLUDED.requested_at IS NULL OR EXCLUDED.requested_at >= ${RUNTIME_ENVIRONMENT_SETUPS_TABLE}.requested_at`,
            [...values, jsonb(split.rest)],
        );
    }

    /** Only the setup still running: a late poll never writes over a finished one. */
    async saveProgress(environmentId: string, key: string, progress: EnvironmentSetupProgress): Promise<void> {
        await this.db.query(
            `UPDATE ${RUNTIME_ENVIRONMENT_SETUPS_TABLE} SET record = jsonb_set(record, '{progress}', $3::jsonb)
             WHERE environment_id = $1 AND setup_key = $2 AND state = 'setting_up'`,
            [environmentId, key, jsonb(progress)],
        );
    }
}
