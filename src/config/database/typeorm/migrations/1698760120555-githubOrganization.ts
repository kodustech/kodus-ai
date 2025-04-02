import { MigrationInterface, QueryRunner } from 'typeorm';

export class GithubOrganization1698760120555 implements MigrationInterface {
    name = 'GithubOrganization1698760120555';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TYPE "public"."github_installationstatus_enum" AS ENUM('PENDING', 'SUCCESS')
        `);
        await queryRunner.query(`
            ALTER TABLE "github"
            ADD "installationStatus" "public"."github_installationstatus_enum"
        `);
        await queryRunner.query(`
            ALTER TABLE "github"
            ADD "organizationName" text
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "github" DROP COLUMN "organizationName"
        `);
        await queryRunner.query(`
            ALTER TABLE "github" DROP COLUMN "installationStatus"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."github_installationstatus_enum"
        `);
    }
}
