import { MigrationInterface, QueryRunner } from "typeorm";

export class RefactoringTeamMemberModelAndUserModel1720283552821 implements MigrationInterface {
    name = 'RefactoringTeamMemberModelAndUserModel1720283552821'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE "team_member" (
                "uuid" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone,
                "updatedAt" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone,
                "name" character varying NOT NULL,
                "status" boolean NOT NULL DEFAULT true,
                "avatar" character varying,
                "communication" jsonb,
                "codeManagement" jsonb,
                "projectManagement" jsonb,
                "communicationId" character varying NOT NULL,
                "teamRole" character varying NOT NULL DEFAULT 'team_member',
                "user_id" uuid,
                "organization_id" uuid,
                "team_id" uuid,
                CONSTRAINT "REL_0724b86622f89c433dee4cd8b1" UNIQUE ("user_id"),
                CONSTRAINT "PK_b29977c70b4331eb44b5bfa07eb" PRIMARY KEY ("uuid")
            )
        `);
        await queryRunner.query(`
            ALTER TYPE "public"."users_role_enum"
            RENAME TO "users_role_enum_old"
        `);
        await queryRunner.query(`
            CREATE TYPE "public"."users_role_enum" AS ENUM('owner', 'user')
        `);
        await queryRunner.query(`
            ALTER TABLE "users"
            ALTER COLUMN "role" DROP DEFAULT
        `);
        await queryRunner.query(`
            ALTER TABLE "users"
            ALTER COLUMN "role" TYPE "public"."users_role_enum" USING "role"::"text"::"public"."users_role_enum"
        `);
        await queryRunner.query(`
            ALTER TABLE "users"
            ALTER COLUMN "role"
            SET DEFAULT 'owner'
        `);
        await queryRunner.query(`
            DROP TYPE "public"."users_role_enum_old"
        `);
        await queryRunner.query(`
            ALTER TABLE "users" DROP COLUMN "status"
        `);
        await queryRunner.query(`
            CREATE TYPE "public"."users_status_enum" AS ENUM('active', 'inactive', 'pending', 'removed')
        `);
        await queryRunner.query(`
            ALTER TABLE "users"
            ADD "status" "public"."users_status_enum" NOT NULL DEFAULT 'pending'
        `);
        await queryRunner.query(`
            ALTER TABLE "team_member"
            ADD CONSTRAINT "FK_0724b86622f89c433dee4cd8b17" FOREIGN KEY ("user_id") REFERENCES "users"("uuid") ON DELETE NO ACTION ON UPDATE NO ACTION
        `);
        await queryRunner.query(`
            ALTER TABLE "team_member"
            ADD CONSTRAINT "FK_c88647c9bb67047f0b8123bf767" FOREIGN KEY ("organization_id") REFERENCES "organizations"("uuid") ON DELETE NO ACTION ON UPDATE NO ACTION
        `);
        await queryRunner.query(`
            ALTER TABLE "team_member"
            ADD CONSTRAINT "FK_a1b5b4f5fa1b7f890d0a278748b" FOREIGN KEY ("team_id") REFERENCES "teams"("uuid") ON DELETE NO ACTION ON UPDATE NO ACTION
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "team_member" DROP CONSTRAINT "FK_a1b5b4f5fa1b7f890d0a278748b"
        `);
        await queryRunner.query(`
            ALTER TABLE "team_member" DROP CONSTRAINT "FK_c88647c9bb67047f0b8123bf767"
        `);
        await queryRunner.query(`
            ALTER TABLE "team_member" DROP CONSTRAINT "FK_0724b86622f89c433dee4cd8b17"
        `);
        await queryRunner.query(`
            ALTER TABLE "users" DROP COLUMN "status"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."users_status_enum"
        `);
        await queryRunner.query(`
            ALTER TABLE "users"
            ADD "status" boolean NOT NULL DEFAULT true
        `);
        await queryRunner.query(`
            CREATE TYPE "public"."users_role_enum_old" AS ENUM('owner', 'team_leader')
        `);
        await queryRunner.query(`
            ALTER TABLE "users"
            ALTER COLUMN "role" DROP DEFAULT
        `);
        await queryRunner.query(`
            ALTER TABLE "users"
            ALTER COLUMN "role" TYPE "public"."users_role_enum_old" USING "role"::"text"::"public"."users_role_enum_old"
        `);
        await queryRunner.query(`
            ALTER TABLE "users"
            ALTER COLUMN "role"
            SET DEFAULT 'owner'
        `);
        await queryRunner.query(`
            DROP TYPE "public"."users_role_enum"
        `);
        await queryRunner.query(`
            ALTER TYPE "public"."users_role_enum_old"
            RENAME TO "users_role_enum"
        `);
        await queryRunner.query(`
            DROP TABLE "team_member"
        `);
    }

}
