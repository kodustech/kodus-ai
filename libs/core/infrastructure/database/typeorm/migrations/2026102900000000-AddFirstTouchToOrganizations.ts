import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * First-touch marketing attribution (UTMs, gclid, referrer, landing page) of
 * the user who created the organization, written once at creation. Read by
 * the warehouse to split signups and paying accounts by acquisition source.
 */
export class AddFirstTouchToOrganizations2026102900000000
    implements MigrationInterface
{
    name = 'AddFirstTouchToOrganizations2026102900000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "organizations"
            ADD COLUMN IF NOT EXISTS "first_touch" jsonb
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "organizations"
            DROP COLUMN IF EXISTS "first_touch"
        `);
    }
}
