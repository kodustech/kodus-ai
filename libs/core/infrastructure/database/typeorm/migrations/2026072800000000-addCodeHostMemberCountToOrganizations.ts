import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Persists the latest organization-member snapshot obtained from the connected
 * code host. For GitHub integrations this is the GitHub organization developer
 * count previously sent only to PostHog at the end of onboarding.
 */
export class AddCodeHostMemberCountToOrganizations2026072800000000
    implements MigrationInterface
{
    name = 'AddCodeHostMemberCountToOrganizations2026072800000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "organizations"
            ADD COLUMN IF NOT EXISTS "code_host_member_count" integer
        `);
        await queryRunner.query(`
            ALTER TABLE "organizations"
            ADD COLUMN IF NOT EXISTS "code_host_member_count_updated_at" TIMESTAMPTZ
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "organizations"
            DROP COLUMN IF EXISTS "code_host_member_count_updated_at"
        `);
        await queryRunner.query(`
            ALTER TABLE "organizations"
            DROP COLUMN IF EXISTS "code_host_member_count"
        `);
    }
}
