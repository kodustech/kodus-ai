import { MigrationInterface, QueryRunner } from "typeorm";

export class NotificationEngine1778536701342 implements MigrationInterface {
    name = 'NotificationEngine1778536701342'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TYPE "public"."notification_deliveries_criticality_enum" AS ENUM(
                'system',
                'critical',
                'transactional',
                'informational'
            )
        `);
        await queryRunner.query(`
            CREATE TYPE "public"."notification_deliveries_channel_enum" AS ENUM('email', 'in_app', 'slack', 'discord', 'webhook')
        `);
        await queryRunner.query(`
            CREATE TYPE "public"."notification_deliveries_deliverystatus_enum" AS ENUM('pending', 'delivered', 'failed')
        `);
        await queryRunner.query(`
            CREATE TABLE "notification_deliveries" (
                "uuid" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone,
                "updatedAt" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone,
                "event" text NOT NULL,
                "criticality" "public"."notification_deliveries_criticality_enum" NOT NULL,
                "channel" "public"."notification_deliveries_channel_enum" NOT NULL,
                "title" text NOT NULL,
                "body" text NOT NULL,
                "ctaUrl" text,
                "category" text NOT NULL,
                "recipientEmail" text,
                "recipientRole" text,
                "deliveryStatus" "public"."notification_deliveries_deliverystatus_enum" NOT NULL DEFAULT 'pending',
                "metadata" jsonb NOT NULL DEFAULT '{}',
                "correlationId" text NOT NULL,
                "lastError" text,
                "deliveredAt" TIMESTAMP,
                "attempts" integer NOT NULL DEFAULT '0',
                "nextAttemptAt" TIMESTAMP,
                "lockedAt" TIMESTAMP,
                "lockedBy" character varying(255),
                "organization_id" uuid NOT NULL,
                "recipient_user_id" uuid,
                CONSTRAINT "PK_bba06c20dfde205865d43744f67" PRIMARY KEY ("uuid")
            )
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_nd_retry_ready" ON "notification_deliveries" ("nextAttemptAt")
            WHERE "deliveryStatus" = 'pending'
                AND "attempts" > 0
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_nd_created" ON "notification_deliveries" ("createdAt")
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_nd_correlation" ON "notification_deliveries" ("correlationId")
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_nd_channel_status" ON "notification_deliveries" ("channel", "deliveryStatus")
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_nd_org_event" ON "notification_deliveries" ("organization_id", "event")
        `);
        await queryRunner.query(`
            CREATE TABLE "user_notifications" (
                "uuid" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone,
                "updatedAt" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone,
                "readAt" TIMESTAMP,
                "user_id" uuid NOT NULL,
                "delivery_id" uuid,
                CONSTRAINT "UQ_un_delivery" UNIQUE ("delivery_id"),
                CONSTRAINT "PK_18d6bfca410a4746bfc6525cc93" PRIMARY KEY ("uuid")
            )
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_un_user_created" ON "user_notifications" ("user_id", "createdAt")
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_un_user_read" ON "user_notifications" ("user_id", "readAt")
        `);
        await queryRunner.query(`
            CREATE TABLE "notification_routing_rules" (
                "uuid" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone,
                "updatedAt" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone,
                "event" text NOT NULL,
                "category" text,
                "role" text NOT NULL,
                "channels" jsonb NOT NULL DEFAULT '{}',
                "organization_id" uuid NOT NULL,
                CONSTRAINT "UQ_nrr_org_event_role" UNIQUE ("organization_id", "event", "role"),
                CONSTRAINT "PK_3fd38ae8e072ce571109d8fcf6f" PRIMARY KEY ("uuid")
            )
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_nrr_org" ON "notification_routing_rules" ("organization_id")
        `);
        await queryRunner.query(`
            ALTER TABLE "notification_deliveries"
            ADD CONSTRAINT "FK_fc17814bb38d81b288294bd8f90" FOREIGN KEY ("organization_id") REFERENCES "organizations"("uuid") ON DELETE NO ACTION ON UPDATE NO ACTION
        `);
        await queryRunner.query(`
            ALTER TABLE "notification_deliveries"
            ADD CONSTRAINT "FK_754b483843ff095c71800e6997a" FOREIGN KEY ("recipient_user_id") REFERENCES "users"("uuid") ON DELETE NO ACTION ON UPDATE NO ACTION
        `);
        await queryRunner.query(`
            ALTER TABLE "user_notifications"
            ADD CONSTRAINT "FK_ae9b1d1f1fe780ef8e3e7d0c0f6" FOREIGN KEY ("user_id") REFERENCES "users"("uuid") ON DELETE NO ACTION ON UPDATE NO ACTION
        `);
        await queryRunner.query(`
            ALTER TABLE "user_notifications"
            ADD CONSTRAINT "FK_3041f807c863b327a6ec9c72a73" FOREIGN KEY ("delivery_id") REFERENCES "notification_deliveries"("uuid") ON DELETE CASCADE ON UPDATE NO ACTION
        `);
        await queryRunner.query(`
            ALTER TABLE "notification_routing_rules"
            ADD CONSTRAINT "FK_57aea5e4a4f2c2fe9ab52d3ae86" FOREIGN KEY ("organization_id") REFERENCES "organizations"("uuid") ON DELETE NO ACTION ON UPDATE NO ACTION
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "notification_routing_rules" DROP CONSTRAINT "FK_57aea5e4a4f2c2fe9ab52d3ae86"
        `);
        await queryRunner.query(`
            ALTER TABLE "user_notifications" DROP CONSTRAINT "FK_3041f807c863b327a6ec9c72a73"
        `);
        await queryRunner.query(`
            ALTER TABLE "user_notifications" DROP CONSTRAINT "FK_ae9b1d1f1fe780ef8e3e7d0c0f6"
        `);
        await queryRunner.query(`
            ALTER TABLE "notification_deliveries" DROP CONSTRAINT "FK_754b483843ff095c71800e6997a"
        `);
        await queryRunner.query(`
            ALTER TABLE "notification_deliveries" DROP CONSTRAINT "FK_fc17814bb38d81b288294bd8f90"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_nrr_org"
        `);
        await queryRunner.query(`
            DROP TABLE "notification_routing_rules"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_un_user_read"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_un_user_created"
        `);
        await queryRunner.query(`
            DROP TABLE "user_notifications"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_nd_org_event"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_nd_channel_status"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_nd_correlation"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_nd_created"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_nd_retry_ready"
        `);
        await queryRunner.query(`
            DROP TABLE "notification_deliveries"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."notification_deliveries_deliverystatus_enum"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."notification_deliveries_channel_enum"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."notification_deliveries_criticality_enum"
        `);
    }

}
