import { MigrationInterface, QueryRunner } from "typeorm";

export class SsoTestConnection1776706820467 implements MigrationInterface {
    name = 'SsoTestConnection1776706820467'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "sso_config"
            ADD "connection_test" jsonb
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "sso_config" DROP COLUMN "connection_test"
        `);
    }

}
