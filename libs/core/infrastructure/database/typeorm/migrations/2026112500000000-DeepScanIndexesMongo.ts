import { MigrationInterface, QueryRunner } from 'typeorm';

import {
    mongoMigrationClient,
    mongoMigrationsSkipped,
} from '../../mongo/mongo-migration-client';
import { ensureReleaseIndexes } from '../../mongo/release-indexes/ensure-release-indexes';
import { RELEASE_INDEX } from '../../mongo/release-indexes/release-index-definitions';

/**
 * MongoDB migration: the deep scan's recorded conclusions (incremental scans)
 * and schedules. Same contract as ReleaseIndexesMongo2026112100000000: a build
 * existing data or an older index refuses is logged and skipped, never thrown.
 */
export class DeepScanIndexesMongo2026112500000000 implements MigrationInterface {
    name = 'DeepScanIndexesMongo2026112500000000';
    transaction = false;

    public async up(_queryRunner: QueryRunner): Promise<void> {
        if (mongoMigrationsSkipped()) {
            console.log(
                '[DeepScanIndexesMongo] skipped (SKIP_MONGO_MIGRATIONS=true)',
            );
            return;
        }
        const { db, close } = await mongoMigrationClient();
        try {
            await ensureReleaseIndexes(
                db,
                (m) => console.log(m),
                [
                    RELEASE_INDEX.scanCoveragePerArea,
                    RELEASE_INDEX.scanSchedulesDue,
                    RELEASE_INDEX.oneScanSchedulePerRepository,
                ],
            );
        } finally {
            await close();
        }
    }

    public async down(_queryRunner: QueryRunner): Promise<void> {
        // The schemas still declare these indexes.
    }
}
