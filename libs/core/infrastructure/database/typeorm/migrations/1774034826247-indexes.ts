import { MigrationInterface, QueryRunner } from 'typeorm';

export class Indexes1774034826247 implements MigrationInterface {
    name = 'Indexes1774034826247';

    transaction = false;

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_integrations_platform_org_team" ON "integrations" ("platform", "organization_id", "team_id")
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            DROP INDEX CONCURRENTLY IF EXISTS "public"."IDX_integrations_platform_org_team"
        `);
    }
}
