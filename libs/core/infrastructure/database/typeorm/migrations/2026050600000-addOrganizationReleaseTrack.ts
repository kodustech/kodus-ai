import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the `release_track` column to `organizations`. The track gates which
 * features (by lifecycle stage) the org can see in cloud:
 *   - `stable` -> only general-availability features
 *   - `beta`   -> beta + general-availability (default for new orgs)
 *   - `alpha`  -> alpha + beta + ga (design partners and Kodus internal)
 *
 * Default is `beta` so existing orgs keep seeing the same features they had
 * access to before this migration. Customers explicitly pinned to `stable`
 * (e.g. enterprise stability customers) must be flipped via a follow-up
 * statement: `UPDATE organizations SET release_track='stable' WHERE id='...'`.
 *
 * Hand-written because `CREATE TYPE` + `ALTER TABLE ADD COLUMN` with a typed
 * default cannot run inside a single TypeORM-managed transaction reliably
 * across all Postgres versions we support.
 */
export class AddOrganizationReleaseTrack2026050600000
    implements MigrationInterface
{
    name = 'AddOrganizationReleaseTrack2026050600000';
    public transaction = false;

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            DO $$ BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM pg_type WHERE typname = 'organizations_release_track_enum'
                ) THEN
                    CREATE TYPE "public"."organizations_release_track_enum"
                    AS ENUM ('stable', 'beta', 'alpha');
                END IF;
            END $$;
        `);

        await queryRunner.query(`
            ALTER TABLE "organizations"
            ADD COLUMN IF NOT EXISTS "release_track"
            "public"."organizations_release_track_enum"
            NOT NULL DEFAULT 'beta'
        `);

        // CONCURRENTLY avoids the SHARE lock that a regular CREATE INDEX
        // takes on `organizations`. The table is small in dev but on
        // production it carries every customer org row and we don't want
        // the deploy to block writes. Requires `transaction = false`
        // (set above) — Postgres rejects CONCURRENTLY inside a tx.
        await queryRunner.query(`
            CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_organizations_release_track"
            ON "organizations" ("release_track")
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            DROP INDEX IF EXISTS "IDX_organizations_release_track"
        `);
        await queryRunner.query(`
            ALTER TABLE "organizations" DROP COLUMN IF EXISTS "release_track"
        `);
        await queryRunner.query(`
            DROP TYPE IF EXISTS "public"."organizations_release_track_enum"
        `);
    }
}
