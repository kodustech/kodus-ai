import { MigrationInterface, QueryRunner } from 'typeorm';

import {
    mongoMigrationClient,
    mongoMigrationsSkipped,
} from '../../mongo/mongo-migration-client';
import { ensureTokenUsageIndexes } from '../../mongo/token-usage/ensure-indexes';
import { backfillTokenUsageTu } from '../../mongo/token-usage/backfill-tu';

/**
 * MongoDB migration (TypeORM runner — Postgres ledger, once per instance, on
 * boot). Adds the "where are tokens spent" dimension to Token Usage:
 *
 *   1. builds the `tu_cover_*_v2` covering indexes (v1 keys + `tu.area` +
 *      top-level `correlationId`, so the by-area and by-review aggregations
 *      stay index-covered) and drops the superseded v1 covers;
 *   2. re-runs the tu backfill, which now also stamps `attributes.tu.area`
 *      onto historical spans (docs missing `tu` OR missing `tu.area`) —
 *      idempotent, resumable, throttled (see backfill-tu.ts).
 *
 * `transaction = false`: same rationale as TokenUsageTuMongo2026070200000000 —
 * the backfill can run for minutes and the Mongo work isn't transactional with
 * Postgres anyway. Very large instances: run the backfill off-peak first so
 * this boot step is a no-op (tune via BATCH / SLEEP_MS / SINCE env).
 */
export class TokenUsageTuAreaMongo2026070300000000
    implements MigrationInterface
{
    name = 'TokenUsageTuAreaMongo2026070300000000';
    transaction = false;

    public async up(_queryRunner: QueryRunner): Promise<void> {
        if (mongoMigrationsSkipped()) {
            console.log(
                '[TokenUsageTuAreaMongo] skipped (SKIP_MONGO_MIGRATIONS=true)',
            );
            return;
        }
        const log = (m: string) => console.log(m);
        const { db, close } = await mongoMigrationClient();
        try {
            await ensureTokenUsageIndexes(db, log);
            await backfillTokenUsageTu(db, {
                batch: process.env.BATCH
                    ? parseInt(process.env.BATCH, 10)
                    : 3000,
                sleepMs: process.env.SLEEP_MS
                    ? parseInt(process.env.SLEEP_MS, 10)
                    : 150,
                since: process.env.SINCE ? new Date(process.env.SINCE) : null,
                log,
            });
        } finally {
            await close();
        }
    }

    public async down(_queryRunner: QueryRunner): Promise<void> {
        // The v2 indexes supersede the v1 ones (already dropped on the way
        // up); recreating v1 on rollback would just burn hours of index build
        // on a 100GB collection. The `tu.area` field is a harmless mirror —
        // leave both in place.
    }
}
