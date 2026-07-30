import { MigrationInterface, QueryRunner } from 'typeorm';

import {
    mongoMigrationClient,
    mongoMigrationsSkipped,
} from '../../mongo/mongo-migration-client';
import {
    dropTokenUsageIndexes,
    ensureTokenUsageIndexes,
} from '../../mongo/token-usage/ensure-indexes';
import { backfillTokenUsageTu } from '../../mongo/token-usage/backfill-tu';

/**
 * MongoDB migration (runs through the same TypeORM runner as the SQL ones, so it
 * rides the Postgres `migrations` ledger: once per instance, on boot, pod-locked).
 *
 * Prepares the Token Usage screen's covered path on `observability_telemetry`:
 *   1. builds the `tu_cover_*` covering indexes + drops superseded dead indexes;
 *   2. backfills the indexable `attributes.tu` sub-doc onto historical spans
 *      (the write path already stamps new ones) — idempotent + resumable.
 *
 * `transaction = false`: the backfill can run for many minutes on a large
 * collection; holding a Postgres transaction open that whole time would risk
 * idle-in-transaction timeouts and locks. The Mongo work isn't transactional
 * with Postgres anyway — idempotency (skip docs that already have `tu`) makes a
 * partial run safe to re-run on the next boot.
 *
 * Very large instances: run `pnpm mongo:migrate token-usage-tu` off-peak BEFORE
 * deploying so this boot step is a no-op. Tune via BATCH / SLEEP_MS / SINCE env.
 */
export class TokenUsageTuMongo2026070200000000 implements MigrationInterface {
    name = 'TokenUsageTuMongo2026070200000000';
    transaction = false;

    public async up(_queryRunner: QueryRunner): Promise<void> {
        if (mongoMigrationsSkipped()) {
            console.log(
                '[TokenUsageTuMongo] skipped (SKIP_MONGO_MIGRATIONS=true)',
            );
            return;
        }
        const log = (m: string) => console.log(m);
        const { db, close } = await mongoMigrationClient();
        try {
            await ensureTokenUsageIndexes(db, log);
            await backfillTokenUsageTu(db, {
                batch: process.env.BATCH ? parseInt(process.env.BATCH, 10) : 3000,
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
        // Only the indexes are reversible; the backfilled `attributes.tu` is a
        // harmless mirror left in place (dropping it would just force a re-run).
        const { db, close } = await mongoMigrationClient();
        try {
            await dropTokenUsageIndexes(db, (m) => console.log(m));
        } finally {
            await close();
        }
    }
}
