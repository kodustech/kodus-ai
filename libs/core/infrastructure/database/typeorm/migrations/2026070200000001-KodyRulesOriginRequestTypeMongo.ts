import { MigrationInterface, QueryRunner } from 'typeorm';

import {
    mongoMigrationClient,
    mongoMigrationsSkipped,
} from '../../mongo/mongo-migration-client';
import { migrateKodyRulesOriginRequestType } from '../../mongo/kody-rules/migrate-origin-request-type';

/**
 * MongoDB migration (via the TypeORM runner → Postgres `migrations` ledger:
 * once per instance, on boot, pod-locked). Remaps, over the embedded `rules[]`
 * of every `kodyRules` doc:
 *   - the legacy `origin` enum → the widened set (manual/library/past_reviews/
 *     repo_file_sync/…);
 *   - `requestType` memory_create→create, memory_update→update.
 *
 * Idempotent: rules already on a widened value are left untouched. `transaction
 * = false` to avoid holding a Postgres transaction open across the Mongo cursor.
 * The remap logic is the same shared module the manual runner uses
 * (`pnpm mongo:migrate kody-rules-origin [--dry-run]`).
 */
export class KodyRulesOriginRequestTypeMongo2026070200000001
    implements MigrationInterface
{
    name = 'KodyRulesOriginRequestTypeMongo2026070200000001';
    transaction = false;

    public async up(_queryRunner: QueryRunner): Promise<void> {
        if (mongoMigrationsSkipped()) {
            console.log(
                '[KodyRulesOriginRequestTypeMongo] skipped (SKIP_MONGO_MIGRATIONS=true)',
            );
            return;
        }
        const { db, close } = await mongoMigrationClient();
        try {
            await migrateKodyRulesOriginRequestType(db, {
                log: (m) => console.log(m),
            });
        } finally {
            await close();
        }
    }

    public async down(_queryRunner: QueryRunner): Promise<void> {
        // Irreversible: the legacy origin/requestType values are not recoverable
        // from the widened ones. No-op so reverting later migrations still works.
    }
}
