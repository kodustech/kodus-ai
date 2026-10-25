import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddWebhookCreationFailuresConfigKey2026092400000000
    implements MigrationInterface
{
    name = 'AddWebhookCreationFailuresConfigKey2026092400000000';
    transaction = false;

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TYPE "public"."integration_configs_configkey_enum"
            ADD VALUE IF NOT EXISTS 'webhook_creation_failures'
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // PostgreSQL does not support removing values from an enum.
        // A full rename-recreate approach would risk data loss if rows
        // reference this value, so we leave it in place.
    }
}
