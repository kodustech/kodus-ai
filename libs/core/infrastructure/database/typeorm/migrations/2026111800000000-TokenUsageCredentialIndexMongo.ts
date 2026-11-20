import { MigrationInterface, QueryRunner } from 'typeorm';

import {
    mongoMigrationClient,
    mongoMigrationsSkipped,
} from '../../mongo/mongo-migration-client';
import { ensureTokenUsageIndexes } from '../../mongo/token-usage/ensure-indexes';

/**
 * MongoDB migration (TypeORM runner — Postgres ledger, once per instance, on
 * boot). Builds `tu_cred_byok_v1`, the partial index that lets monthly spend
 * read its (model, credential) pairs from the index instead of fetching every
 * BYOK span of the month.
 *
 * Re-runs `ensureTokenUsageIndexes`, which is idempotent: the v3 covers
 * already exist, so only the new index is built. It is partial (BYOK spans
 * with a credential), so the build is small next to the covers.
 */
export class TokenUsageCredentialIndexMongo2026111800000000 implements MigrationInterface {
    name = 'TokenUsageCredentialIndexMongo2026111800000000';
    transaction = false;

    public async up(_queryRunner: QueryRunner): Promise<void> {
        if (mongoMigrationsSkipped()) {
            console.log(
                '[TokenUsageCredentialIndexMongo] skipped (SKIP_MONGO_MIGRATIONS=true)',
            );
            return;
        }
        const { db, close } = await mongoMigrationClient();
        try {
            await ensureTokenUsageIndexes(db, (m) => console.log(m));
        } finally {
            await close();
        }
    }

    public async down(_queryRunner: QueryRunner): Promise<void> {
        if (mongoMigrationsSkipped()) return;
        const { db, close } = await mongoMigrationClient();
        try {
            await db
                .collection('observability_telemetry')
                .dropIndex('tu_cred_byok_v1')
                .catch(() => undefined);
        } finally {
            await close();
        }
    }
}
