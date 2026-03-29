import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateSessionEvents1772560489322 implements MigrationInterface {
    name = 'CreateSessionEvents1772560489322';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE "session_events" (
                "uuid" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone,
                "updatedAt" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone,
                "organization_id" uuid NOT NULL,
                "team_id" uuid NOT NULL,
                "session_id" character varying(120) NOT NULL,
                "type" character varying(30) NOT NULL,
                "branch" character varying(250) NOT NULL,
                "event_timestamp" TIMESTAMP NOT NULL,
                "payload" jsonb NOT NULL,
                CONSTRAINT "PK_935b988572a98155597ecd4c658" PRIMARY KEY ("uuid")
            )
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_session_events_timestamp" ON "session_events" ("event_timestamp")
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_session_events_session_type" ON "session_events" ("session_id", "type")
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_session_events_org_branch" ON "session_events" ("organization_id", "branch")
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_session_events_org_session" ON "session_events" ("organization_id", "session_id")
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            DROP INDEX "public"."IDX_session_events_org_session"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_session_events_org_branch"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_session_events_session_type"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_session_events_timestamp"
        `);
        await queryRunner.query(`
            DROP TABLE "session_events"
        `);
    }
}
