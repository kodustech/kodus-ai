import { MigrationInterface, QueryRunner } from 'typeorm';

import {
    mongoMigrationClient,
    mongoMigrationsSkipped,
} from '../../mongo/mongo-migration-client';
import { ensureTokenUsageIndexes } from '../../mongo/token-usage/ensure-indexes';
import { backfillTokenUsageTu } from '../../mongo/token-usage/backfill-tu';

/**
 * MongoDB migration (TypeORM runner — Postgres ledger, once per instance, on
 * boot). Adds the per-TASK dimension to Token Usage (the model the org picked
 * per routing task):
 *
 *   1. builds the `tu_cover_*_v3` covering indexes (v2 keys + `tu.route`, so the
 *      per-task × area aggregation stays index-covered) and drops the superseded
 *      v2 covers;
 *   2. re-runs the tu backfill, which now also stamps `attributes.tu.route`
 *      onto historical spans (docs missing `tu.route`) — a valid stamped route
 *      wins, else the area→task de-para, so pre-launch spend attributes to a
 *      task instead of blank. Re-stamping recomputes the WHOLE `tu`, so it also
 *      re-buckets the suggestion-refinement run-names that had drifted into
 *      `other`. Idempotent, resumable, throttled (see backfill-tu.ts).
 *
 * `transaction = false`: same rationale as the earlier tu migrations — the
 * backfill can run for minutes and the Mongo work isn't transactional with
 * Postgres anyway. Very large instances: run the backfill off-peak first so
 * this boot step is a no-op (tune via BATCH / SLEEP_MS / SINCE env).
 */
export class TokenUsageTuRouteMongo2026082000000000
    implements MigrationInterface
{
    name = 'TokenUsageTuRouteMongo2026082000000000';
    transaction = false;

    public async up(_queryRunner: QueryRunner): Promise<void> {
        if (mongoMigrationsSkipped()) {
            console.log(
                '[TokenUsageTuRouteMongo] skipped (SKIP_MONGO_MIGRATIONS=true)',
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
        // The v3 indexes supersede the v2 ones (already dropped on the way up);
        // recreating v2 on rollback would just burn an index build. The
        // `tu.route` field is a harmless mirror — leave both in place.
    }
}
