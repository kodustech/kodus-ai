import { MigrationInterface, QueryRunner } from 'typeorm';

export class SsoConfig1764869633621 implements MigrationInterface {
    name = 'SsoConfig1764869633621';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TYPE "public"."sso_config_protocol_enum" AS ENUM('saml', 'oidc')
        `);
        await queryRunner.query(`
            CREATE TABLE "sso_config" (
                "uuid" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone,
                "updatedAt" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone,
                "protocol" "public"."sso_config_protocol_enum" NOT NULL DEFAULT 'saml',
                "active" boolean NOT NULL DEFAULT true,
                "domains" text array NOT NULL DEFAULT '{}',
                "provider_config" jsonb NOT NULL,
                "organization_id" uuid,
                CONSTRAINT "PK_31e21229aa03349c35c71ebb47d" PRIMARY KEY ("uuid")
            )
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_SSOConfig_OrganizationId" ON "sso_config" ("organization_id")
        `);
        await queryRunner.query(`
            ALTER TYPE "public"."auth_authprovider_enum"
            RENAME TO "auth_authprovider_enum_old"
        `);
        await queryRunner.query(`
            CREATE TYPE "public"."auth_authprovider_enum" AS ENUM(
                'credentials',
                'google',
                'github',
                'gitlab',
                'sso'
            )
        `);
        await queryRunner.query(`
            ALTER TABLE "auth"
            ALTER COLUMN "authProvider" DROP DEFAULT
        `);
        await queryRunner.query(`
            ALTER TABLE "auth"
            ALTER COLUMN "authProvider" TYPE "public"."auth_authprovider_enum" USING "authProvider"::"text"::"public"."auth_authprovider_enum"
        `);
        await queryRunner.query(`
            ALTER TABLE "auth"
            ALTER COLUMN "authProvider"
            SET DEFAULT 'credentials'
        `);
        await queryRunner.query(`
            DROP TYPE "public"."auth_authprovider_enum_old"
        `);
        await queryRunner.query(`
            ALTER TABLE "sso_config"
            ADD CONSTRAINT "FK_c2437cc58782e10739015c861a8" FOREIGN KEY ("organization_id") REFERENCES "organizations"("uuid") ON DELETE NO ACTION ON UPDATE NO ACTION
        `);

        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_SSOConfig_Domains_GIN"
            ON "sso_config" USING GIN ("domains")
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "sso_config" DROP CONSTRAINT "FK_c2437cc58782e10739015c861a8"
        `);
        await queryRunner.query(`
            CREATE TYPE "public"."auth_authprovider_enum_old" AS ENUM('credentials', 'google', 'github', 'gitlab')
        `);
        await queryRunner.query(`
            ALTER TABLE "auth"
            ALTER COLUMN "authProvider" DROP DEFAULT
        `);
        await queryRunner.query(`
            ALTER TABLE "auth"
            ALTER COLUMN "authProvider" TYPE "public"."auth_authprovider_enum_old" USING "authProvider"::"text"::"public"."auth_authprovider_enum_old"
        `);
        await queryRunner.query(`
            ALTER TABLE "auth"
            ALTER COLUMN "authProvider"
            SET DEFAULT 'credentials'
        `);
        await queryRunner.query(`
            DROP TYPE "public"."auth_authprovider_enum"
        `);
        await queryRunner.query(`
            ALTER TYPE "public"."auth_authprovider_enum_old"
            RENAME TO "auth_authprovider_enum"
        `);
        await queryRunner.query(`
            DROP INDEX CONCURRENTLY "public"."IDX_SSOConfig_OrganizationId"
        `);
        await queryRunner.query(`
            DROP TABLE "sso_config"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."sso_config_protocol_enum"
        `);
    }
}
