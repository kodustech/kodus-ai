import { MigrationInterface, QueryRunner } from "typeorm";

export class SsoDomainVerify1776711371106 implements MigrationInterface {
    name = 'SsoDomainVerify1776711371106'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "sso_config"
            ADD "domain_verification" jsonb
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "sso_config" DROP COLUMN "domain_verification"
        `);
    }

}
