import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { IDistributedLockRepository } from '../../domain/contracts/distributed-lock.repository.contract';

export const DISTRIBUTED_LOCKS_TABLE = '"kodus_workflow"."distributed_locks"';

/**
 * Extends `holder`'s lease by $3 ms, capped by the max hold set on acquire.
 * Params: [key, holder, leaseMs]. Returns one row `{ held }` while `holder`
 * still holds the key, none once it was taken over or released.
 *
 * Matching on holder is enough: a takeover overwrites holder and a release
 * deletes the row, so a row still naming us means nobody else has held it
 * since. Renewing past an expiry nobody claimed is therefore safe; past the
 * max hold it stays expired. Exported because the lease renewal thread
 * (lease-renewer.ts) runs this same statement on its own connection.
 */
export const RENEW_LEASE_SQL = `UPDATE ${DISTRIBUTED_LOCKS_TABLE}
    SET expires_at = LEAST(
            now() + $3::double precision * interval '1 millisecond',
            COALESCE(max_hold_until, 'infinity'::timestamptz))
  WHERE lock_key = $1 AND holder = $2
 RETURNING expires_at > now() AS held`;

/**
 * Single-statement SQL only: each call is its own implicit transaction, so a
 * pooler in transaction mode may run it on any server connection. Every
 * time comparison uses the database clock (`now()`), never the app's, so
 * holders on hosts with skewed clocks agree on who holds what.
 */
@Injectable()
export class DistributedLockRepository implements IDistributedLockRepository {
    constructor(
        @InjectDataSource()
        private readonly dataSource: DataSource,
    ) {}

    /**
     * Rows a statement returned. `DataSource.query` hands UPDATE/DELETE
     * results back as `[rows, rowCount]` but INSERT/SELECT as `rows`; the
     * structured result has the same `records` for every command.
     */
    private async records<T>(sql: string, params: unknown[]): Promise<T[]> {
        const runner = this.dataSource.createQueryRunner();
        try {
            const result = await runner.query(sql, params, true);
            return (result?.records ?? []) as T[];
        } finally {
            await runner.release();
        }
    }

    async tryAcquire(
        key: string,
        holder: string,
        leaseMs: number,
        maxHoldMs?: number,
    ): Promise<boolean> {
        // `max_hold_until` is fixed on acquire; `expires_at` never passes
        // it, so a lease taken with a max hold ends there even when its
        // holder crashed (nobody renews) or never released.
        const rows = await this.records<{ holder: string }>(
            `INSERT INTO ${DISTRIBUTED_LOCKS_TABLE}
                    (lock_key, holder, acquired_at, expires_at, max_hold_until)
             SELECT $1, $2, now(),
                    LEAST(now() + $3::double precision * interval '1 millisecond',
                          COALESCE(t.max_hold_until, 'infinity'::timestamptz)),
                    t.max_hold_until
               FROM (SELECT now() + $4::double precision * interval '1 millisecond' AS max_hold_until) t
             ON CONFLICT (lock_key) DO UPDATE
                SET holder = EXCLUDED.holder,
                    acquired_at = EXCLUDED.acquired_at,
                    expires_at = EXCLUDED.expires_at,
                    max_hold_until = EXCLUDED.max_hold_until
              WHERE distributed_locks.expires_at <= now()
             RETURNING holder`,
            [key, holder, leaseMs, maxHoldMs ?? null],
        );
        return rows.length > 0 && rows[0].holder === holder;
    }

    async renew(
        key: string,
        holder: string,
        leaseMs: number,
    ): Promise<boolean> {
        const rows = await this.records<{ held: boolean }>(RENEW_LEASE_SQL, [
            key,
            holder,
            leaseMs,
        ]);
        return rows.length > 0 && rows[0].held === true;
    }

    async release(key: string, holder: string): Promise<boolean> {
        const rows = await this.records<unknown>(
            `DELETE FROM ${DISTRIBUTED_LOCKS_TABLE}
              WHERE lock_key = $1 AND holder = $2
             RETURNING 1`,
            [key, holder],
        );
        return rows.length > 0;
    }

    async isHeld(key: string): Promise<boolean> {
        const rows = await this.records<{ held: boolean }>(
            `SELECT EXISTS (
                    SELECT 1 FROM ${DISTRIBUTED_LOCKS_TABLE}
                     WHERE lock_key = $1 AND expires_at > now()
                ) AS held`,
            [key],
        );
        return rows[0]?.held === true;
    }

    async deleteExpired(graceMs: number): Promise<number> {
        const rows = await this.records<unknown>(
            `DELETE FROM ${DISTRIBUTED_LOCKS_TABLE}
              WHERE expires_at < now() - $1::double precision * interval '1 millisecond'
             RETURNING 1`,
            [graceMs],
        );
        return rows.length;
    }
}
