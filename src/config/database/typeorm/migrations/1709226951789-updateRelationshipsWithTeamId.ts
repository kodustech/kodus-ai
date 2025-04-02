import { MigrationInterface, QueryRunner } from 'typeorm';

export class UpdateRelationshipsWithTeamId1709226951789
    implements MigrationInterface
{
    name = 'UpdateRelationshipsWithTeamId1709226951789';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "profiles"
            ADD "position" character varying
        `);
        await queryRunner.query(`
            ALTER TABLE "integration_configs"
            ADD "team_id" uuid
        `);
        await queryRunner.query(`
            ALTER TABLE "team_members"
            ADD "status" boolean NOT NULL DEFAULT true
        `);
        await queryRunner.query(`
            ALTER TABLE "team_members"
            ADD "team_id" uuid
        `);
        await queryRunner.query(`
            ALTER TABLE "team_members"
            ADD CONSTRAINT "UQ_fdad7d5768277e60c40e01cdcea" UNIQUE ("team_id")
        `);
        await queryRunner.query(`
            ALTER TABLE "profiles"
            ALTER COLUMN "phone" DROP NOT NULL
        `);
        await queryRunner.query(`
            ALTER TABLE "profiles"
            ALTER COLUMN "img" DROP NOT NULL
        `);
        await queryRunner.query(`
            ALTER TYPE "public"."profiles_role_enum"
            RENAME TO "profiles_role_enum_old"
        `);
        await queryRunner.query(`
            CREATE TYPE "public"."profiles_role_enum" AS ENUM('user', 'root')
        `);
        await queryRunner.query(`
            ALTER TABLE "profiles"
            ALTER COLUMN "role" TYPE "public"."profiles_role_enum" USING "role"::"text"::"public"."profiles_role_enum"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."profiles_role_enum_old"
        `);
        await queryRunner.query(`
            ALTER TABLE "integration_configs"
            ADD CONSTRAINT "FK_1e32572c007608d399d3764acc6" FOREIGN KEY ("team_id") REFERENCES "teams"("uuid") ON DELETE NO ACTION ON UPDATE NO ACTION
        `);
        await queryRunner.query(`
            ALTER TABLE "team_members"
            ADD CONSTRAINT "FK_fdad7d5768277e60c40e01cdcea" FOREIGN KEY ("team_id") REFERENCES "teams"("uuid") ON DELETE NO ACTION ON UPDATE NO ACTION
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "team_members" DROP CONSTRAINT "FK_fdad7d5768277e60c40e01cdcea"
        `);
        await queryRunner.query(`
            ALTER TABLE "integration_configs" DROP CONSTRAINT "FK_1e32572c007608d399d3764acc6"
        `);
        await queryRunner.query(`
            CREATE TYPE "public"."profiles_role_enum_old" AS ENUM('TEAM_MEMBER', 'MEMBER', 'ADMIN')
        `);
        await queryRunner.query(`
            ALTER TABLE "profiles"
            ALTER COLUMN "role" TYPE "public"."profiles_role_enum_old" USING "role"::"text"::"public"."profiles_role_enum_old"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."profiles_role_enum"
        `);
        await queryRunner.query(`
            ALTER TYPE "public"."profiles_role_enum_old"
            RENAME TO "profiles_role_enum"
        `);
        await queryRunner.query(`
            ALTER TABLE "profiles"
            ALTER COLUMN "img"
            SET NOT NULL
        `);
        await queryRunner.query(`
            ALTER TABLE "profiles"
            ALTER COLUMN "phone"
            SET NOT NULL
        `);
        await queryRunner.query(`
            ALTER TABLE "team_members" DROP CONSTRAINT "UQ_fdad7d5768277e60c40e01cdcea"
        `);
        await queryRunner.query(`
            ALTER TABLE "team_members" DROP COLUMN "team_id"
        `);
        await queryRunner.query(`
            ALTER TABLE "team_members" DROP COLUMN "status"
        `);
        await queryRunner.query(`
            ALTER TABLE "integration_configs" DROP COLUMN "team_id"
        `);
        await queryRunner.query(`
            ALTER TABLE "profiles" DROP COLUMN "position"
        `);
    }
}
