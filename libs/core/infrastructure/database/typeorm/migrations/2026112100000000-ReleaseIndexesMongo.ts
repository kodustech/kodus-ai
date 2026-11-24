import { MigrationInterface, QueryRunner } from 'typeorm';

import {
    mongoMigrationClient,
    mongoMigrationsSkipped,
} from '../../mongo/mongo-migration-client';
import { ensureReleaseIndexes } from '../../mongo/release-indexes/ensure-release-indexes';

/**
 * MongoDB migration (TypeORM runner — Postgres ledger, once per instance, on
 * boot). Builds the indexes this release declared on Mongoose schemas
 * (RELEASE_INDEXES): schema indexes are built only while MONGO_AUTO_INDEX is
 * on, and these must exist either way, the unique ones that enforce a rule
 * included. createIndex is a no-op for an index already there.
 *
 * Wherever `ttl_updatedAt` did not exist yet, building it lets MongoDB's TTL
 * monitor delete every agent session idle for more than 30 days, once.
 *
 * A build that existing data or an older index refuses is logged as an ERROR
 * and skipped, not thrown, so it cannot stop the boot. `down` leaves the
 * indexes: the schemas still declare them.
 */
export class ReleaseIndexesMongo2026112100000000 implements MigrationInterface {
    name = 'ReleaseIndexesMongo2026112100000000';
    transaction = false;

    public async up(_queryRunner: QueryRunner): Promise<void> {
        if (mongoMigrationsSkipped()) {
            console.log(
                '[ReleaseIndexesMongo] skipped (SKIP_MONGO_MIGRATIONS=true)',
            );
            return;
        }
        const { db, close } = await mongoMigrationClient();
        try {
            await ensureReleaseIndexes(db, (m) => console.log(m));
        } finally {
            await close();
        }
    }

    public async down(_queryRunner: QueryRunner): Promise<void> {
        // The schemas still declare these indexes; dropping them would only
        // have autoIndex build them again, or leave the rules they enforce off.
    }
}
