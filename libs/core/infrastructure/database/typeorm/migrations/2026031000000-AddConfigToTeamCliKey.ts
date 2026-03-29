import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddConfigToTeamCliKey2026031000000 implements MigrationInterface {
    name = 'AddConfigToTeamCliKey2026031000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "team_cli_key"
            ADD COLUMN "config" jsonb NOT NULL DEFAULT '{}'::jsonb
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "team_cli_key"
            DROP COLUMN "config"
        `);
    }
}
