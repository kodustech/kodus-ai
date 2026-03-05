import { MigrationInterface, QueryRunner } from 'typeorm';

export class MarketingSurvey1771438580377 implements MigrationInterface {
    name = 'MarketingSurvey1771438580377';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "profiles"
            ADD "referralSource" character varying
        `);
        await queryRunner.query(`
            ALTER TABLE "profiles"
            ADD "primaryGoal" character varying
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "profiles" DROP COLUMN "primaryGoal"
        `);
        await queryRunner.query(`
            ALTER TABLE "profiles" DROP COLUMN "referralSource"
        `);
    }
}
