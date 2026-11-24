import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddRepositorySelectionConfigKeys2026110600000000
    implements MigrationInterface
{
    name = 'AddRepositorySelectionConfigKeys2026110600000000';
    transaction = false;

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TYPE "public"."integration_configs_configkey_enum"
            ADD VALUE IF NOT EXISTS 'repository_selection'
        `);
        await queryRunner.query(`
            ALTER TYPE "public"."integration_configs_configkey_enum"
            ADD VALUE IF NOT EXISTS 'repository_sync_state'
        `);
    }

    public async down(): Promise<void> {
        // PostgreSQL cannot drop enum values; rows may reference them.
    }
}
