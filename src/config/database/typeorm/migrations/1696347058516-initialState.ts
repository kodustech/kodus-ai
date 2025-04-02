import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialState1696347058516 implements MigrationInterface {
    name = 'InitialState1696347058516';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TYPE "public"."organization_platforms_platformname_enum" AS ENUM('GITHUB', 'JIRA', 'SLACK', 'NOTION')
        `);
        await queryRunner.query(`
            CREATE TABLE "organization_platforms" (
                "uuid" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone,
                "updatedAt" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone,
                "platformName" "public"."organization_platforms_platformname_enum" NOT NULL,
                "authToken" character varying NOT NULL,
                "botToken" character varying,
                "baseUrl" character varying,
                "cloudId" character varying,
                "platformId" character varying,
                "platformKey" character varying,
                "refreshToken" character varying,
                "lastSynced" TIMESTAMP NOT NULL DEFAULT now(),
                "status" boolean NOT NULL DEFAULT true,
                "organization_id" uuid,
                CONSTRAINT "PK_42bf38e4407d12826215f4738aa" PRIMARY KEY ("uuid")
            )
        `);
        await queryRunner.query(`
            CREATE TABLE "platforms" (
                "uuid" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone,
                "updatedAt" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone,
                "type" character varying NOT NULL,
                "value" character varying NOT NULL,
                "status" boolean NOT NULL DEFAULT true,
                "teamProfile_Id" uuid,
                CONSTRAINT "PK_2d4ddc024b28f4069798478bb6f" PRIMARY KEY ("uuid")
            )
        `);
        await queryRunner.query(`
            CREATE TABLE "team_profiles" (
                "uuid" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone,
                "updatedAt" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone,
                "team_id" uuid,
                "profile_id" uuid,
                CONSTRAINT "PK_386b4aeb29a379f6ba3007c3e3f" PRIMARY KEY ("uuid")
            )
        `);
        await queryRunner.query(`
            CREATE TYPE "public"."profiles_role_enum" AS ENUM('TEAM_MEMBER', 'MEMBER', 'ADMIN')
        `);
        await queryRunner.query(`
            CREATE TABLE "profiles" (
                "uuid" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone,
                "updatedAt" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone,
                "name" character varying NOT NULL,
                "phone" character varying NOT NULL,
                "img" character varying NOT NULL,
                "status" boolean NOT NULL DEFAULT true,
                "role" "public"."profiles_role_enum" NOT NULL,
                "user_id" uuid,
                CONSTRAINT "REL_9e432b7df0d182f8d292902d1a" UNIQUE ("user_id"),
                CONSTRAINT "PK_2c0c7196c89bdcc9b04f29f3fe6" PRIMARY KEY ("uuid")
            )
        `);
        await queryRunner.query(`
            CREATE TABLE "auth" (
                "uuid" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone,
                "updatedAt" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone,
                "refreshToken" text NOT NULL,
                "expiryDate" TIMESTAMP NOT NULL DEFAULT now(),
                "used" boolean NOT NULL DEFAULT false,
                "userUuid" uuid,
                CONSTRAINT "UQ_5fb5d6abb950a839551fe3c5de9" UNIQUE ("refreshToken"),
                CONSTRAINT "PK_96102ee3fa43a27bc51bb91f3ca" PRIMARY KEY ("uuid")
            )
        `);
        await queryRunner.query(`
            CREATE TYPE "public"."users_scopes_enum" AS ENUM('user', 'root')
        `);
        await queryRunner.query(`
            CREATE TABLE "users" (
                "uuid" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone,
                "updatedAt" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone,
                "email" character varying NOT NULL,
                "password" character varying NOT NULL,
                "scopes" "public"."users_scopes_enum" NOT NULL DEFAULT 'user',
                "status" boolean NOT NULL DEFAULT true,
                "organization_id" uuid,
                CONSTRAINT "UQ_97672ac88f789774dd47f7c8be3" UNIQUE ("email"),
                CONSTRAINT "PK_951b8f1dfc94ac1d0301a14b7e1" PRIMARY KEY ("uuid")
            )
        `);
        await queryRunner.query(`
            CREATE TABLE "slack" (
                "uuid" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone,
                "updatedAt" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone,
                "channelId" character varying,
                "channelKey" character varying,
                "organization_id" uuid,
                CONSTRAINT "REL_e4dc632c54851838ee60974050" UNIQUE ("organization_id"),
                CONSTRAINT "PK_dfe4ab85a24ce766fb78847844f" PRIMARY KEY ("uuid")
            )
        `);
        await queryRunner.query(`
            CREATE TABLE "organizations" (
                "uuid" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone,
                "updatedAt" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone,
                "name" character varying NOT NULL,
                "tenantName" character varying,
                "status" boolean NOT NULL DEFAULT true,
                CONSTRAINT "PK_94726c8fd554481cd1db1be83e8" PRIMARY KEY ("uuid")
            )
        `);
        await queryRunner.query(`
            CREATE TABLE "diagnostic_scores" (
                "uuid" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone,
                "updatedAt" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone,
                "score" double precision NOT NULL,
                "dataAnalyzed" jsonb,
                "version" integer NOT NULL,
                "error" character varying,
                "team_good_practice_id" uuid,
                "analysis_history_id" uuid,
                CONSTRAINT "PK_02185c9f82a9ebac8232b0b57a7" PRIMARY KEY ("uuid")
            )
        `);
        await queryRunner.query(`
            CREATE TYPE "public"."diagnostic_analysis_history_status_enum" AS ENUM(
                'not_processed',
                'processing',
                'processed',
                'partial_error'
            )
        `);
        await queryRunner.query(`
            CREATE TABLE "diagnostic_analysis_history" (
                "uuid" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone,
                "updatedAt" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone,
                "dateOfAnalysis" TIMESTAMP NOT NULL,
                "overallScore" double precision NOT NULL DEFAULT '0',
                "version" integer NOT NULL,
                "status" "public"."diagnostic_analysis_history_status_enum" NOT NULL DEFAULT 'not_processed',
                "team_id" uuid,
                CONSTRAINT "PK_74e69e2b96a303373f2d26731cc" PRIMARY KEY ("uuid")
            )
        `);
        await queryRunner.query(`
            CREATE TABLE "automation" (
                "uuid" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone,
                "updatedAt" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone,
                "name" character varying NOT NULL,
                "description" character varying NOT NULL,
                "tags" text NOT NULL,
                "antiPatterns" text NOT NULL,
                "status" boolean NOT NULL DEFAULT true,
                "version" character varying NOT NULL,
                CONSTRAINT "PK_abe1351d1749099604a7c3fd97b" PRIMARY KEY ("uuid")
            )
        `);
        await queryRunner.query(`
            CREATE TYPE "public"."automation_execution_status_enum" AS ENUM('success', 'error')
        `);
        await queryRunner.query(`
            CREATE TABLE "automation_execution" (
                "uuid" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone,
                "updatedAt" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone,
                "status" "public"."automation_execution_status_enum" NOT NULL DEFAULT 'success',
                "errorMessage" character varying,
                "dataExecution" jsonb,
                "team_automation_id" uuid,
                CONSTRAINT "PK_03d3e9bf351e94ad36aa18bb4c1" PRIMARY KEY ("uuid")
            )
        `);
        await queryRunner.query(`
            CREATE TABLE "team_automations" (
                "uuid" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone,
                "updatedAt" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone,
                "version" character varying NOT NULL,
                "isActive" boolean NOT NULL DEFAULT true,
                "teamUuid" uuid,
                "automationUuid" uuid,
                CONSTRAINT "PK_f52fdba6b8166b4469b8b11afdd" PRIMARY KEY ("uuid")
            )
        `);
        await queryRunner.query(`
            CREATE TYPE "public"."metrics_platformname_enum" AS ENUM(
                'leadTime',
                'cycleTime',
                'leadTimeForChange',
                'throughput',
                'bugRatio'
            )
        `);
        await queryRunner.query(`
            CREATE TABLE "metrics" (
                "uuid" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone,
                "updatedAt" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone,
                "platformName" "public"."metrics_platformname_enum" NOT NULL,
                "value" jsonb NOT NULL,
                "status" boolean NOT NULL DEFAULT true,
                "team_id" uuid,
                CONSTRAINT "PK_95ac22b304f21a1680a4bd204cf" PRIMARY KEY ("uuid")
            )
        `);
        await queryRunner.query(`
            CREATE TABLE "teams" (
                "uuid" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone,
                "updatedAt" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone,
                "name" character varying NOT NULL,
                "status" boolean NOT NULL DEFAULT true,
                "organization_id" uuid,
                CONSTRAINT "PK_59dcc55c0af733a59470895cce6" PRIMARY KEY ("uuid")
            )
        `);
        await queryRunner.query(`
            CREATE TYPE "public"."team_good_practices_status_enum" AS ENUM('pending', 'processed', 'error')
        `);
        await queryRunner.query(`
            CREATE TABLE "team_good_practices" (
                "uuid" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone,
                "updatedAt" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone,
                "status" "public"."team_good_practices_status_enum" NOT NULL DEFAULT 'pending',
                "errorMessage" text,
                "team_id" uuid,
                "good_practice_id" uuid,
                "analysis_history_id" uuid,
                CONSTRAINT "PK_c2c053fd1e566c456cb46cebe5f" PRIMARY KEY ("uuid")
            )
        `);
        await queryRunner.query(`
            CREATE TYPE "public"."good_practices_goodpracticetype_enum" AS ENUM(
                'IssuesWithAssignedOwner',
                'ClearDescription',
                'CommitsLinkedToIssue',
                'ConsistencyIssueSizes',
                'DefinedWipLimit',
                'EnsureAcceptanceCriteria'
            )
        `);
        await queryRunner.query(`
            CREATE TABLE "good_practices" (
                "uuid" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone,
                "updatedAt" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone,
                "name" character varying NOT NULL,
                "description" text,
                "periodOfAnalysis" character varying,
                "version" integer NOT NULL,
                "order_execution" integer NOT NULL,
                "depends_result_id" character varying,
                "data_requirements" jsonb DEFAULT '{}',
                "calculation_method" jsonb DEFAULT '{}',
                "goodPracticeType" "public"."good_practices_goodpracticetype_enum" NOT NULL,
                CONSTRAINT "UQ_4feb4c52c3110033061b8e1f1c0" UNIQUE ("goodPracticeType"),
                CONSTRAINT "PK_f5a697462441a171a3a5df35233" PRIMARY KEY ("uuid")
            )
        `);
        await queryRunner.query(`
            CREATE TABLE "github" (
                "uuid" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone,
                "updatedAt" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone,
                "repositories" jsonb NOT NULL,
                "organization_id" uuid,
                CONSTRAINT "PK_17b2e0c4b8926afa1522d46f406" PRIMARY KEY ("uuid")
            )
        `);
        await queryRunner.query(`
            CREATE TABLE "jira" (
                "uuid" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone,
                "updatedAt" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone,
                "columns" jsonb NOT NULL,
                "organization_id" uuid,
                CONSTRAINT "PK_36ac97ea762c5bb11d81fee7567" PRIMARY KEY ("uuid")
            )
        `);
        await queryRunner.query(`
            CREATE TABLE "team_members" (
                "uuid" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone,
                "updatedAt" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone,
                "members" jsonb NOT NULL,
                "organization_id" uuid,
                CONSTRAINT "PK_46e9305a61d8ef1c08668ca6063" PRIMARY KEY ("uuid")
            )
        `);
        await queryRunner.query(`
            ALTER TABLE "organization_platforms"
            ADD CONSTRAINT "FK_4d720631b713711dad14912a316" FOREIGN KEY ("organization_id") REFERENCES "organizations"("uuid") ON DELETE NO ACTION ON UPDATE NO ACTION
        `);
        await queryRunner.query(`
            ALTER TABLE "platforms"
            ADD CONSTRAINT "FK_9a976af737b1cd80cbcc3fac4d0" FOREIGN KEY ("teamProfile_Id") REFERENCES "team_profiles"("uuid") ON DELETE NO ACTION ON UPDATE NO ACTION
        `);
        await queryRunner.query(`
            ALTER TABLE "team_profiles"
            ADD CONSTRAINT "FK_f4aebb86ff89723d6868d211001" FOREIGN KEY ("team_id") REFERENCES "teams"("uuid") ON DELETE NO ACTION ON UPDATE NO ACTION
        `);
        await queryRunner.query(`
            ALTER TABLE "team_profiles"
            ADD CONSTRAINT "FK_3ed26109ab9e65ac965cc27eca7" FOREIGN KEY ("profile_id") REFERENCES "profiles"("uuid") ON DELETE NO ACTION ON UPDATE NO ACTION
        `);
        await queryRunner.query(`
            ALTER TABLE "profiles"
            ADD CONSTRAINT "FK_9e432b7df0d182f8d292902d1a2" FOREIGN KEY ("user_id") REFERENCES "users"("uuid") ON DELETE NO ACTION ON UPDATE NO ACTION
        `);
        await queryRunner.query(`
            ALTER TABLE "auth"
            ADD CONSTRAINT "FK_3ff4ca6607345724557de0f5ce9" FOREIGN KEY ("userUuid") REFERENCES "users"("uuid") ON DELETE NO ACTION ON UPDATE NO ACTION
        `);
        await queryRunner.query(`
            ALTER TABLE "users"
            ADD CONSTRAINT "FK_21a659804ed7bf61eb91688dea7" FOREIGN KEY ("organization_id") REFERENCES "organizations"("uuid") ON DELETE NO ACTION ON UPDATE NO ACTION
        `);
        await queryRunner.query(`
            ALTER TABLE "slack"
            ADD CONSTRAINT "FK_e4dc632c54851838ee609740502" FOREIGN KEY ("organization_id") REFERENCES "organizations"("uuid") ON DELETE NO ACTION ON UPDATE NO ACTION
        `);
        await queryRunner.query(`
            ALTER TABLE "diagnostic_scores"
            ADD CONSTRAINT "FK_2b605e93517bd637293925ea9c1" FOREIGN KEY ("team_good_practice_id") REFERENCES "team_good_practices"("uuid") ON DELETE NO ACTION ON UPDATE NO ACTION
        `);
        await queryRunner.query(`
            ALTER TABLE "diagnostic_scores"
            ADD CONSTRAINT "FK_47a4d5af17fdc3d397283fd8ed6" FOREIGN KEY ("analysis_history_id") REFERENCES "diagnostic_analysis_history"("uuid") ON DELETE NO ACTION ON UPDATE NO ACTION
        `);
        await queryRunner.query(`
            ALTER TABLE "diagnostic_analysis_history"
            ADD CONSTRAINT "FK_c0d5a8b50b9615b8d63390a68c2" FOREIGN KEY ("team_id") REFERENCES "teams"("uuid") ON DELETE NO ACTION ON UPDATE NO ACTION
        `);
        await queryRunner.query(`
            ALTER TABLE "automation_execution"
            ADD CONSTRAINT "FK_8c4bf05f6ab2e6207a5aa3aedae" FOREIGN KEY ("team_automation_id") REFERENCES "team_automations"("uuid") ON DELETE NO ACTION ON UPDATE NO ACTION
        `);
        await queryRunner.query(`
            ALTER TABLE "team_automations"
            ADD CONSTRAINT "FK_419193cca4bd24e16264af8fc78" FOREIGN KEY ("teamUuid") REFERENCES "teams"("uuid") ON DELETE NO ACTION ON UPDATE NO ACTION
        `);
        await queryRunner.query(`
            ALTER TABLE "team_automations"
            ADD CONSTRAINT "FK_4adb958a3bdb43b2690edb83bd6" FOREIGN KEY ("automationUuid") REFERENCES "automation"("uuid") ON DELETE NO ACTION ON UPDATE NO ACTION
        `);
        await queryRunner.query(`
            ALTER TABLE "metrics"
            ADD CONSTRAINT "FK_e7e7830b4e3693d93ce16b0de73" FOREIGN KEY ("team_id") REFERENCES "teams"("uuid") ON DELETE NO ACTION ON UPDATE NO ACTION
        `);
        await queryRunner.query(`
            ALTER TABLE "teams"
            ADD CONSTRAINT "FK_fdc736f761896ccc179c823a785" FOREIGN KEY ("organization_id") REFERENCES "organizations"("uuid") ON DELETE NO ACTION ON UPDATE NO ACTION
        `);
        await queryRunner.query(`
            ALTER TABLE "team_good_practices"
            ADD CONSTRAINT "FK_f94002f95fa851a954984514391" FOREIGN KEY ("team_id") REFERENCES "teams"("uuid") ON DELETE NO ACTION ON UPDATE NO ACTION
        `);
        await queryRunner.query(`
            ALTER TABLE "team_good_practices"
            ADD CONSTRAINT "FK_0f37e5175ff02abe1d178ca6816" FOREIGN KEY ("good_practice_id") REFERENCES "good_practices"("uuid") ON DELETE NO ACTION ON UPDATE NO ACTION
        `);
        await queryRunner.query(`
            ALTER TABLE "team_good_practices"
            ADD CONSTRAINT "FK_474b43e53a31261f6b8d4b4b65b" FOREIGN KEY ("analysis_history_id") REFERENCES "diagnostic_analysis_history"("uuid") ON DELETE NO ACTION ON UPDATE NO ACTION
        `);
        await queryRunner.query(`
            ALTER TABLE "github"
            ADD CONSTRAINT "FK_73b448cae1d5e0671449058a1fb" FOREIGN KEY ("organization_id") REFERENCES "organizations"("uuid") ON DELETE NO ACTION ON UPDATE NO ACTION
        `);
        await queryRunner.query(`
            ALTER TABLE "jira"
            ADD CONSTRAINT "FK_ac4ba35f4cac26ec49d5877abd2" FOREIGN KEY ("organization_id") REFERENCES "organizations"("uuid") ON DELETE NO ACTION ON UPDATE NO ACTION
        `);
        await queryRunner.query(`
            ALTER TABLE "team_members"
            ADD CONSTRAINT "FK_6316cb096adabe354fa3af73388" FOREIGN KEY ("organization_id") REFERENCES "organizations"("uuid") ON DELETE NO ACTION ON UPDATE NO ACTION
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "team_members" DROP CONSTRAINT "FK_6316cb096adabe354fa3af73388"
        `);
        await queryRunner.query(`
            ALTER TABLE "jira" DROP CONSTRAINT "FK_ac4ba35f4cac26ec49d5877abd2"
        `);
        await queryRunner.query(`
            ALTER TABLE "github" DROP CONSTRAINT "FK_73b448cae1d5e0671449058a1fb"
        `);
        await queryRunner.query(`
            ALTER TABLE "team_good_practices" DROP CONSTRAINT "FK_474b43e53a31261f6b8d4b4b65b"
        `);
        await queryRunner.query(`
            ALTER TABLE "team_good_practices" DROP CONSTRAINT "FK_0f37e5175ff02abe1d178ca6816"
        `);
        await queryRunner.query(`
            ALTER TABLE "team_good_practices" DROP CONSTRAINT "FK_f94002f95fa851a954984514391"
        `);
        await queryRunner.query(`
            ALTER TABLE "teams" DROP CONSTRAINT "FK_fdc736f761896ccc179c823a785"
        `);
        await queryRunner.query(`
            ALTER TABLE "metrics" DROP CONSTRAINT "FK_e7e7830b4e3693d93ce16b0de73"
        `);
        await queryRunner.query(`
            ALTER TABLE "team_automations" DROP CONSTRAINT "FK_4adb958a3bdb43b2690edb83bd6"
        `);
        await queryRunner.query(`
            ALTER TABLE "team_automations" DROP CONSTRAINT "FK_419193cca4bd24e16264af8fc78"
        `);
        await queryRunner.query(`
            ALTER TABLE "automation_execution" DROP CONSTRAINT "FK_8c4bf05f6ab2e6207a5aa3aedae"
        `);
        await queryRunner.query(`
            ALTER TABLE "diagnostic_analysis_history" DROP CONSTRAINT "FK_c0d5a8b50b9615b8d63390a68c2"
        `);
        await queryRunner.query(`
            ALTER TABLE "diagnostic_scores" DROP CONSTRAINT "FK_47a4d5af17fdc3d397283fd8ed6"
        `);
        await queryRunner.query(`
            ALTER TABLE "diagnostic_scores" DROP CONSTRAINT "FK_2b605e93517bd637293925ea9c1"
        `);
        await queryRunner.query(`
            ALTER TABLE "slack" DROP CONSTRAINT "FK_e4dc632c54851838ee609740502"
        `);
        await queryRunner.query(`
            ALTER TABLE "users" DROP CONSTRAINT "FK_21a659804ed7bf61eb91688dea7"
        `);
        await queryRunner.query(`
            ALTER TABLE "auth" DROP CONSTRAINT "FK_3ff4ca6607345724557de0f5ce9"
        `);
        await queryRunner.query(`
            ALTER TABLE "profiles" DROP CONSTRAINT "FK_9e432b7df0d182f8d292902d1a2"
        `);
        await queryRunner.query(`
            ALTER TABLE "team_profiles" DROP CONSTRAINT "FK_3ed26109ab9e65ac965cc27eca7"
        `);
        await queryRunner.query(`
            ALTER TABLE "team_profiles" DROP CONSTRAINT "FK_f4aebb86ff89723d6868d211001"
        `);
        await queryRunner.query(`
            ALTER TABLE "platforms" DROP CONSTRAINT "FK_9a976af737b1cd80cbcc3fac4d0"
        `);
        await queryRunner.query(`
            ALTER TABLE "organization_platforms" DROP CONSTRAINT "FK_4d720631b713711dad14912a316"
        `);
        await queryRunner.query(`
            DROP TABLE "team_members"
        `);
        await queryRunner.query(`
            DROP TABLE "jira"
        `);
        await queryRunner.query(`
            DROP TABLE "github"
        `);
        await queryRunner.query(`
            DROP TABLE "good_practices"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."good_practices_goodpracticetype_enum"
        `);
        await queryRunner.query(`
            DROP TABLE "team_good_practices"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."team_good_practices_status_enum"
        `);
        await queryRunner.query(`
            DROP TABLE "teams"
        `);
        await queryRunner.query(`
            DROP TABLE "metrics"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."metrics_platformname_enum"
        `);
        await queryRunner.query(`
            DROP TABLE "team_automations"
        `);
        await queryRunner.query(`
            DROP TABLE "automation_execution"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."automation_execution_status_enum"
        `);
        await queryRunner.query(`
            DROP TABLE "automation"
        `);
        await queryRunner.query(`
            DROP TABLE "diagnostic_analysis_history"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."diagnostic_analysis_history_status_enum"
        `);
        await queryRunner.query(`
            DROP TABLE "diagnostic_scores"
        `);
        await queryRunner.query(`
            DROP TABLE "organizations"
        `);
        await queryRunner.query(`
            DROP TABLE "slack"
        `);
        await queryRunner.query(`
            DROP TABLE "users"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."users_scopes_enum"
        `);
        await queryRunner.query(`
            DROP TABLE "auth"
        `);
        await queryRunner.query(`
            DROP TABLE "profiles"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."profiles_role_enum"
        `);
        await queryRunner.query(`
            DROP TABLE "team_profiles"
        `);
        await queryRunner.query(`
            DROP TABLE "platforms"
        `);
        await queryRunner.query(`
            DROP TABLE "organization_platforms"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."organization_platforms_platformname_enum"
        `);
    }
}
