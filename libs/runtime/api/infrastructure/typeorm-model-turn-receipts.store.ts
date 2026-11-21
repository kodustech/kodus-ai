import type { ModelTurnResponse } from '@libs/runtime/contracts/model-turn';
import { MODEL_TURN_LIMITS } from '@libs/runtime/contracts/model-turn';

import type { RuntimeModelTurnReceipts } from '../domain/model-turn';
import type { Sql } from './typeorm-sql';

export const MODEL_TURN_RECEIPTS_TABLE = 'runtime_model_turn_receipts';

/**
 * Product-owned receipts of the model turns (product Postgres): they survive
 * a lost request and a restart, and a pending turn is never run again. The
 * primary key on the turn makes the first claim the only fresh one.
 */
export class TypeOrmModelTurnReceipts implements RuntimeModelTurnReceipts {
    constructor(private readonly sql: Sql) {}

    async claim(key: string, fingerprint: string, expiresAt: Date) {
        const inserted = await this.sql.query(
            `INSERT INTO ${MODEL_TURN_RECEIPTS_TABLE} (key, fingerprint, expires_at) VALUES ($1, $2, $3) ON CONFLICT (key) DO NOTHING RETURNING key`,
            [key, fingerprint, expiresAt],
        );
        if (inserted.rows.length) return { fresh: true as const };
        const existing = (await this.sql.query(`SELECT fingerprint, response FROM ${MODEL_TURN_RECEIPTS_TABLE} WHERE key = $1`, [key])).rows[0];
        if (!existing) throw Error('model turn receipt unavailable');
        return {
            fresh: false as const,
            fingerprint: existing.fingerprint as string,
            ...(existing.response ? { response: existing.response as ModelTurnResponse } : {}),
        };
    }

    async complete(key: string, fingerprint: string, response: ModelTurnResponse) {
        const json = JSON.stringify(response);
        if (Buffer.byteLength(json, 'utf8') > MODEL_TURN_LIMITS.responseBytes) throw Error('model turn response too large');
        const updated = await this.sql.query(
            `UPDATE ${MODEL_TURN_RECEIPTS_TABLE} SET response = $3::jsonb WHERE key = $1 AND fingerprint = $2 AND response IS NULL RETURNING key`,
            [key, fingerprint, json],
        );
        if (updated.rows.length !== 1) throw Error('model turn receipt conflict');
    }
}
