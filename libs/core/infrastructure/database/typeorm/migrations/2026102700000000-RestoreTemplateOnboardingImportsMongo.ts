import { MigrationInterface, QueryRunner } from 'typeorm';

import {
    mongoMigrationClient,
    mongoMigrationsSkipped,
} from '../../mongo/mongo-migration-client';
import {
    removeTemplateOnboardingImports,
    restoreTemplateOnboardingImports,
} from '../../mongo/kody-rules/freeze-agent-file-rules';

/**
 * MongoDB migration. `FreezeAgentFileRulesMongo` first removed every onboarding
 * import outside `.kody/rules/`, including ones from the other Repository Rules
 * locations (`.rules/`, `docs/coding-standards/`, `rules/**.md`), which are
 * Kody Rules, not coding-agent files. This puts those back in their previous
 * status; `down` removes them again.
 *
 * Idempotent. `transaction = false` to avoid holding a Postgres transaction
 * open across the Mongo cursor.
 */
export class RestoreTemplateOnboardingImportsMongo2026102700000000 implements MigrationInterface {
    name = 'RestoreTemplateOnboardingImportsMongo2026102700000000';
    transaction = false;

    public async up(_queryRunner: QueryRunner): Promise<void> {
        if (mongoMigrationsSkipped()) {
            console.log(
                '[RestoreTemplateOnboardingImportsMongo] skipped (SKIP_MONGO_MIGRATIONS=true)',
            );
            return;
        }
        const { db, close } = await mongoMigrationClient();
        try {
            await restoreTemplateOnboardingImports(db, {
                log: (m) => console.log(m),
            });
        } finally {
            await close();
        }
    }

    public async down(_queryRunner: QueryRunner): Promise<void> {
        if (mongoMigrationsSkipped()) return;
        const { db, close } = await mongoMigrationClient();
        try {
            await removeTemplateOnboardingImports(db, {
                log: (m) => console.log(m),
            });
        } finally {
            await close();
        }
    }
}
