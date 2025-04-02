import { MigrationInterface, QueryRunner } from 'typeorm';

export class GithubOrganization1698784948930 implements MigrationInterface {
    name = 'GithubOrganization1698784948930';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "github"
            ADD "installId" text
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "github" DROP COLUMN "installId"
        `);
    }
}
