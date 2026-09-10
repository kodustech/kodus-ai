import { MigrationInterface, QueryRunner } from 'typeorm';

import {
    mongoMigrationClient,
    mongoMigrationsSkipped,
} from '../../mongo/mongo-migration-client';
import { ensureTokenUsageIndexes } from '../../mongo/token-usage/ensure-indexes';

/**
 * MongoDB migration (TypeORM runner — Postgres ledger, once per instance, on
 * boot). Fixes #1882: the Token Usage repository filter scoped spend by
 * `attributes.prNumber` alone — PR numbers are unique per repository, not per
 * org, so two repositories sharing a number leaked each other's spend.
 *
 * Builds the `tu_cover_*_v4` covering indexes (v3 keys + `attributes.repositoryId`,
 * now written on every usage span — see `buildUsageSpanAttributes`) and drops
 * the superseded v3 covers.
 *
 * No backfill: historical spans were never stamped with a repository id and
 * there is no source to derive one from after the fact (same accepted gap as
 * #1238). They simply won't match a repository-scoped read going forward —
 * the org-wide (unscoped) view is unaffected.
 *
 * `transaction = false`: index builds aren't transactional with Postgres
 * anyway (same rationale as the earlier tu migrations).
 */
export class TokenUsageRepositoryIdMongo2026091000000000
    implements MigrationInterface
{
    name = 'TokenUsageRepositoryIdMongo2026091000000000';
    transaction = false;

    public async up(_queryRunner: QueryRunner): Promise<void> {
        if (mongoMigrationsSkipped()) {
            console.log(
                '[TokenUsageRepositoryIdMongo] skipped (SKIP_MONGO_MIGRATIONS=true)',
            );
            return;
        }
        const log = (m: string) => console.log(m);
        const { db, close } = await mongoMigrationClient();
        try {
            await ensureTokenUsageIndexes(db, log);
        } finally {
            await close();
        }
    }

    public async down(_queryRunner: QueryRunner): Promise<void> {
        // The v4 indexes supersede the v3 ones (already dropped on the way
        // up); recreating v3 on rollback would just burn an index build.
    }
}
