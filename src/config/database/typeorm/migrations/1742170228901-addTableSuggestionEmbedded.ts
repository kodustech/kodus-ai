import { MigrationInterface, QueryRunner } from "typeorm";

export class AddTableSuggestionEmbedded1742170228901 implements MigrationInterface {
    name = 'AddTableSuggestionEmbedded1742170228901'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE "suggestion_embedded" (
                "uuid" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "suggestionEmbed" vector NOT NULL,
                "createdAt" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone,
                "updatedAt" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone,
                "pullRequestNumber" integer NOT NULL,
                "repositoryId" character varying NOT NULL,
                "repositoryFullName" character varying NOT NULL,
                "suggestionId" character varying NOT NULL,
                "label" character varying NOT NULL,
                "severity" character varying NOT NULL,
                "feedbackType" character varying NOT NULL,
                "improvedCode" text NOT NULL,
                "suggestionContent" text NOT NULL,
                "language" character varying,
                "organization_id" uuid,
                CONSTRAINT "PK_1c9a8f7477bd93360a5ab61e164" PRIMARY KEY ("uuid")
            )
        `);
        await queryRunner.query(`
            ALTER TABLE "suggestion_embedded"
            ADD CONSTRAINT "FK_a07c798694e84acae375bba3571" FOREIGN KEY ("organization_id") REFERENCES "organizations"("uuid") ON DELETE NO ACTION ON UPDATE NO ACTION
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "suggestion_embedded" DROP CONSTRAINT "FK_a07c798694e84acae375bba3571"
        `);
        await queryRunner.query(`
            DROP TABLE "suggestion_embedded"
        `);
    }

}
