import { MigrationInterface, QueryRunner } from 'typeorm';

import {
    mongoMigrationClient,
    mongoMigrationsSkipped,
} from '../../mongo/mongo-migration-client';
import {
    freezeAgentFileRules,
    restoreAgentFileRules,
} from '../../mongo/kody-rules/freeze-agent-file-rules';

/**
 * MongoDB migration (via the TypeORM runner → Postgres `migrations` ledger:
 * once per instance, on boot, pod-locked). Coding-agent files stopped being
 * converted into Kody Rules (#1823): rules the onboarding import created from
 * them are deleted (restorable: `down` puts them back), and the `@kody-sync`
 * pin is cleared.
 * See `freeze-agent-file-rules.ts` for the exact selection.
 *
 * Idempotent. `transaction = false` to avoid holding a Postgres transaction
 * open across the Mongo cursor.
 */
export class FreezeAgentFileRulesMongo2026101300000000 implements MigrationInterface {
    name = 'FreezeAgentFileRulesMongo2026101300000000';
    transaction = false;

    public async up(_queryRunner: QueryRunner): Promise<void> {
        if (mongoMigrationsSkipped()) {
            console.log(
                '[FreezeAgentFileRulesMongo] skipped (SKIP_MONGO_MIGRATIONS=true)',
            );
            return;
        }
        const { db, close } = await mongoMigrationClient();
        try {
            await freezeAgentFileRules(db, { log: (m) => console.log(m) });
        } finally {
            await close();
        }
    }

    public async down(_queryRunner: QueryRunner): Promise<void> {
        if (mongoMigrationsSkipped()) return;
        const { db, close } = await mongoMigrationClient();
        try {
            await restoreAgentFileRules(db, { log: (m) => console.log(m) });
        } finally {
            await close();
        }
    }
}
