import { MigrationInterface, QueryRunner } from 'typeorm';

import {
    mongoMigrationClient,
    mongoMigrationsSkipped,
} from '../../mongo/mongo-migration-client';
import { normalizeKodyRulesPullRequestScope } from '../../mongo/kody-rules/normalize-pull-request-scope';

/**
 * MongoDB migration (via the TypeORM runner → Postgres `migrations` ledger:
 * once per instance, on boot, pod-locked). Rewrites Kody Rules stored with
 * `scope: 'pull request'` (what the CLI used to send) to `'pull-request'`, the
 * value the review pipeline matches; until then they were judged as file
 * rules.
 *
 * Idempotent. `transaction = false` to avoid holding a Postgres transaction
 * open across the Mongo update. Same shared module as the manual runner
 * (`pnpm mongo:migrate kody-rules-pr-scope [--dry-run]`).
 */
export class KodyRulesPullRequestScopeMongo2026110200000000 implements MigrationInterface {
    name = 'KodyRulesPullRequestScopeMongo2026110200000000';
    transaction = false;

    public async up(_queryRunner: QueryRunner): Promise<void> {
        if (mongoMigrationsSkipped()) {
            console.log(
                '[KodyRulesPullRequestScopeMongo] skipped (SKIP_MONGO_MIGRATIONS=true)',
            );
            return;
        }
        const { db, close } = await mongoMigrationClient();
        try {
            await normalizeKodyRulesPullRequestScope(db, {
                log: (m) => console.log(m),
            });
        } finally {
            await close();
        }
    }

    public async down(_queryRunner: QueryRunner): Promise<void> {
        // Irreversible on purpose: restoring the misspelling would turn these
        // rules back into file rules. No-op so reverting later migrations works.
    }
}
