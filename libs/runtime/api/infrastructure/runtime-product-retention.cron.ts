import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { RUNTIME_CRON_SCHEDULES } from './runtime-cron-schedules';
import { DataSource } from 'typeorm';

import { createLogger } from '@libs/core/log/logger';
import { type DistributedLock, DistributedLockService } from '@libs/core/workflow/infrastructure/distributed-lock.service';

import { ENV_AUDIT_RETENTION_DAYS, RUNTIME_ENV_AUDIT_TABLE } from './typeorm-env-audit.store';
import { RUNTIME_LLM_BUDGET_TABLE, RUNTIME_LLM_RESERVATIONS_TABLE } from './typeorm-llm-budget.store';
import { MODEL_TURN_RECEIPTS_TABLE } from './typeorm-model-turn-receipts.store';
import { RECIPE_AUTHOR_RECEIPTS_TABLE, SETUP_CALL_COUNTS_TABLE } from './typeorm-setup-calls.store';
import { RECONCILED_HEADS_RETENTION_DAYS, RUNTIME_RECONCILED_HEADS_TABLE } from './typeorm-reconciled-heads.store';
import { type Sql, TypeOrmSql } from './typeorm-sql';

/** Rows one statement deletes at most: short transactions, never a long lock on the writers. */
export const RETENTION_BATCH = 5_000;

/**
 * What the Mongo TTL indexes did, as explicit deletes on an index of the time
 * column: a row past its expires_at (the setup token, the model turn, the
 * per-day counter, a reservation that never settled), an env audit row
 * older than 90 days, and a reconciled head older than 30 days. A row past its time but not swept yet reads as before
 * (Mongo's TTL monitor also lagged); nothing decides on that lag.
 */
export const RUNTIME_PRODUCT_RETENTION: ReadonlyArray<{ table: string; expired: string }> = [
    { table: MODEL_TURN_RECEIPTS_TABLE, expired: 'expires_at <= now()' },
    { table: RECIPE_AUTHOR_RECEIPTS_TABLE, expired: 'expires_at <= now()' },
    { table: SETUP_CALL_COUNTS_TABLE, expired: 'expires_at <= now()' },
    { table: RUNTIME_LLM_BUDGET_TABLE, expired: 'expires_at IS NOT NULL AND expires_at <= now()' },
    { table: RUNTIME_LLM_RESERVATIONS_TABLE, expired: 'expires_at <= now()' },
    { table: RUNTIME_ENV_AUDIT_TABLE, expired: `at < now() - interval '${ENV_AUDIT_RETENTION_DAYS} days'` },
    { table: RUNTIME_RECONCILED_HEADS_TABLE, expired: `updated_at < now() - interval '${RECONCILED_HEADS_RETENTION_DAYS} days'` },
];

/** Deletes every expired row of the Runtime's product stores, in batches; returns how many went, per table. */
export async function sweepRuntimeProductRetention(sql: Sql, batch = RETENTION_BATCH): Promise<Record<string, number>> {
    const removed: Record<string, number> = {};
    for (const { table, expired } of RUNTIME_PRODUCT_RETENTION) {
        removed[table] = 0;
        for (;;) {
            const n = (await sql.query(`DELETE FROM ${table} WHERE ctid IN (SELECT ctid FROM ${table} WHERE ${expired} LIMIT $1)`, [batch])).rowCount;
            removed[table] += n;
            if (n < batch) break;
        }
    }
    return removed;
}

// Every 10 minutes, on one replica (API or product worker) at a time.

@Injectable()
export class RuntimeProductRetentionCron {
    private readonly logger = createLogger(RuntimeProductRetentionCron.name);
    private readonly sql: Sql;

    constructor(
        source: DataSource,
        private readonly locks: DistributedLockService,
    ) {
        this.sql = new TypeOrmSql(source);
    }

    @Cron(RUNTIME_CRON_SCHEDULES.productRetention, { name: 'Runtime product retention' })
    async handleCron(): Promise<void> {
        let lock: DistributedLock | null;
        try {
            lock = await this.locks.acquire('CRON:RUNTIME:PRODUCT_RETENTION', { ttl: 9 * 60 * 1000 });
        } catch (error) {
            this.logger.error({
                message: 'Runtime product retention: lock failed',
                context: RuntimeProductRetentionCron.name,
                error: error instanceof Error ? error : undefined,
            });
            return;
        }
        if (!lock) return;
        try {
            const removed = await sweepRuntimeProductRetention(this.sql);
            if (Object.values(removed).some((n) => n > 0)) {
                this.logger.log({ message: 'Runtime product retention: swept', context: RuntimeProductRetentionCron.name, metadata: removed });
            }
        } catch (error) {
            this.logger.error({
                message: 'Runtime product retention: sweep failed',
                context: RuntimeProductRetentionCron.name,
                error: error instanceof Error ? error : undefined,
            });
        } finally {
            // DistributedLock.release logs its own failure, and the TTL frees the lock anyway.
            await lock.release().catch(() => undefined);
        }
    }
}
