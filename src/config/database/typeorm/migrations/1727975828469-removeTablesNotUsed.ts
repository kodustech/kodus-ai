import { MigrationInterface, QueryRunner } from 'typeorm';

export class RemoveTablesNotUsed1727975828469 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `DROP TABLE IF EXISTS "platform_webhooks" CASCADE`,
        );
        await queryRunner.query(`DROP TABLE IF EXISTS "slack" CASCADE`);
        await queryRunner.query(`DROP TABLE IF EXISTS "jira" CASCADE`);
        await queryRunner.query(
            `DROP TABLE IF EXISTS "organization_platforms" CASCADE`,
        );
        await queryRunner.query(`DROP TABLE IF EXISTS "github" CASCADE`);
        await queryRunner.query(`DROP TABLE IF EXISTS "team_members" CASCADE`);
        await queryRunner.query(`DROP TABLE IF EXISTS "platforms" CASCADE`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Recria as tabelas deletadas para possibilitar a reversão da migração

        // Certifique-se de que a extensão uuid-ossp está disponível
        await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);

        // Tabela platform_webhooks
        await queryRunner.query(`
      CREATE TABLE "platform_webhooks" (
        "uuid" UUID NOT NULL DEFAULT uuid_generate_v4(),
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        "platform" VARCHAR NOT NULL,
        "data" JSONB NOT NULL,
        "team_id" UUID,
        PRIMARY KEY ("uuid")
      )
    `);

        // Tabela slack
        await queryRunner.query(`
      CREATE TABLE "slack" (
        "uuid" UUID NOT NULL DEFAULT uuid_generate_v4(),
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        "channelId" VARCHAR NOT NULL,
        "channelKey" VARCHAR NOT NULL,
        "organization_id" UUID,
        PRIMARY KEY ("uuid")
      )
    `);

        // Tabela jira
        await queryRunner.query(`
      CREATE TABLE "jira" (
        "uuid" UUID NOT NULL DEFAULT uuid_generate_v4(),
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        "channelId" VARCHAR NOT NULL,
        "channelKey" VARCHAR NOT NULL,
        "organization_id" UUID,
        PRIMARY KEY ("uuid")
      )
    `);

        // Tabela organization_platforms
        await queryRunner.query(`
      CREATE TABLE "organization_platforms" (
        "uuid" UUID NOT NULL DEFAULT uuid_generate_v4(),
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        "platformName" VARCHAR NOT NULL,
        "authToken" VARCHAR,
        "botToken" VARCHAR,
        "baseUrl" VARCHAR,
        "cloudId" VARCHAR,
        "platformId" VARCHAR,
        "platformKey" VARCHAR,
        "refreshToken" VARCHAR,
        "lastSynced" TIMESTAMP,
        "status" VARCHAR,
        "organization_id" UUID,
        PRIMARY KEY ("uuid")
      )
    `);

        // Tabela github
        await queryRunner.query(`
      CREATE TABLE "github" (
        "uuid" UUID NOT NULL DEFAULT uuid_generate_v4(),
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        "repositories" JSONB,
        "organization_id" UUID,
        "installationStatus" VARCHAR,
        "organizationName" VARCHAR,
        "installId" INTEGER,
        PRIMARY KEY ("uuid")
      )
    `);

        // Tabela team_members
        await queryRunner.query(`
      CREATE TABLE "team_members" (
        "uuid" UUID NOT NULL DEFAULT uuid_generate_v4(),
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        "repositories" JSONB,
        "organization_id" UUID,
        "installationStatus" VARCHAR,
        "organizationName" VARCHAR,
        "installId" INTEGER,
        PRIMARY KEY ("uuid")
      )
    `);

        // Tabela platforms
        await queryRunner.query(`
      CREATE TABLE "platforms" (
        "uuid" UUID NOT NULL DEFAULT uuid_generate_v4(),
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        "type" VARCHAR NOT NULL,
        "value" VARCHAR,
        "status" VARCHAR,
        "teamProfile_Id" UUID,
        PRIMARY KEY ("uuid")
      )
    `);
    }
}
