import { createHash } from 'crypto';

import type { RecipeAuthorClaim, RecipeAuthorOutcome, RecipeAuthorReceipts, RecipeAuthorReservation, SetupCallCounter } from '../domain/setup-calls';
import type { Sql } from './typeorm-sql';

export const RECIPE_AUTHOR_RECEIPTS_TABLE = 'runtime_recipe_author_receipts';
export const SETUP_CALL_COUNTS_TABLE = 'runtime_setup_call_counts';

/**
 * Kody's recipe-author attempts in the product Postgres, one row per
 * (setupKey, attempt): who runs it and until when, the budget it reserved,
 * and its answer once written. Of the calls asking at once, the primary key
 * lets one insert; a lapsed lease is taken by one conditional update.
 */
export class TypeOrmRecipeAuthorReceipts implements RecipeAuthorReceipts {
    constructor(private readonly sql: Sql) {}

    async claim(input: Parameters<RecipeAuthorReceipts['claim']>[0]): Promise<RecipeAuthorClaim> {
        // A receipt given back between the insert and the read is inserted again: a few tries, never a loop.
        for (let i = 0; i < 3; i++) {
            const inserted = await this.sql.query(
                `INSERT INTO ${RECIPE_AUTHOR_RECEIPTS_TABLE} (key, fingerprint, owner, lease_until, expires_at) VALUES ($1, $2, $3, $4, $5)
                 ON CONFLICT (key) DO NOTHING RETURNING key`,
                [input.key, input.fingerprint, input.owner, input.leaseUntil, input.expiresAt],
            );
            if (inserted.rows.length) return { state: 'fresh' };
            // Concurrent takers wait on the row and re-check the lease on the row the winner wrote: one takes it.
            const taken = await this.sql.query(
                `UPDATE ${RECIPE_AUTHOR_RECEIPTS_TABLE} SET owner = $3, lease_until = $4, expires_at = $5
                 WHERE key = $1 AND fingerprint = $2 AND outcome IS NULL AND lease_until <= $6 RETURNING reservation`,
                [input.key, input.fingerprint, input.owner, input.leaseUntil, input.expiresAt, input.now],
            );
            if (taken.rows.length) {
                const reservation = taken.rows[0].reservation as RecipeAuthorReservation | null;
                return { state: 'taken_over', ...(reservation ? { reservation } : {}) };
            }
            const doc = (await this.sql.query(`SELECT fingerprint, outcome FROM ${RECIPE_AUTHOR_RECEIPTS_TABLE} WHERE key = $1`, [input.key])).rows[0];
            if (!doc) continue;
            if (doc.fingerprint !== input.fingerprint) return { state: 'conflict' };
            if (doc.outcome) return { state: 'done', outcome: doc.outcome as RecipeAuthorOutcome };
            return { state: 'running' };
        }
        throw new Error('recipe author receipt unavailable');
    }

    async reserved(key: string, owner: string, reservation: RecipeAuthorReservation) {
        await this.sql.query(`UPDATE ${RECIPE_AUTHOR_RECEIPTS_TABLE} SET reservation = $3::jsonb WHERE key = $1 AND owner = $2 AND outcome IS NULL`, [
            key,
            owner,
            JSON.stringify(reservation),
        ]);
    }

    async settled(key: string, owner: string) {
        await this.sql.query(`UPDATE ${RECIPE_AUTHOR_RECEIPTS_TABLE} SET reservation = NULL WHERE key = $1 AND owner = $2`, [key, owner]);
    }

    async complete(key: string, owner: string, outcome: RecipeAuthorOutcome) {
        await this.sql.query(`UPDATE ${RECIPE_AUTHOR_RECEIPTS_TABLE} SET outcome = $3::jsonb WHERE key = $1 AND owner = $2 AND outcome IS NULL`, [
            key,
            owner,
            JSON.stringify(outcome),
        ]);
    }

    async release(key: string, owner: string) {
        await this.sql.query(`DELETE FROM ${RECIPE_AUTHOR_RECEIPTS_TABLE} WHERE key = $1 AND owner = $2 AND outcome IS NULL`, [key, owner]);
    }
}

/**
 * A count per key in the product Postgres that never passes its max: one
 * conditional upsert, so concurrent calls across API instances are counted
 * once each and the one past the max is refused without counting.
 */
export class TypeOrmSetupCallCounter implements SetupCallCounter {
    constructor(private readonly sql: Sql) {}

    /**
     * The row is keyed by the key's SHA-256: callers join their parts with NUL (`setup-repo-tokens\0<setupKey>\0<kind>`),
     * which a Postgres text value cannot hold (22021), and a hash bounds the length too.
     */
    async take(key: string, max: number, expiresAt: Date): Promise<boolean> {
        if (max < 1) return false;
        const counted = await this.sql.query(
            `INSERT INTO ${SETUP_CALL_COUNTS_TABLE} AS c (key, count, expires_at) VALUES ($1, 1, $3)
             ON CONFLICT (key) DO UPDATE SET count = c.count + 1 WHERE c.count < $2 RETURNING count`,
            [createHash('sha256').update(key).digest('hex'), max, expiresAt],
        );
        return counted.rows.length === 1;
    }
}
