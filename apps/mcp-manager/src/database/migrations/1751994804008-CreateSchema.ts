import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateSchema1751994804008 implements MigrationInterface {
    name = 'CreateSchema1751994804008';

    public async up(queryRunner: QueryRunner): Promise<void> {
        // Create schema if it doesn't exist
        await queryRunner.query(`CREATE SCHEMA IF NOT EXISTS "mcp-manager"`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Note: We don't drop the schema in down() to avoid affecting other potential tables
    }
}
