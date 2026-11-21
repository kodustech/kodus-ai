import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Publish target of each Kody Runtime Run (org, team, repo, PR, SHA,
 * platform), written by the product when it enqueues the RuntimeRunRequested
 * and before the outbox row. The product worker's publisher takes the target
 * only from here, never from anything the Runtime wrote (ADR-052). Product
 * Postgres, written only by the product (§8).
 */
export class CreateRuntimeRunTargets2026103000000000 implements MigrationInterface {
    name = 'CreateRuntimeRunTargets2026103000000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "runtime_run_targets" (
                "uuid" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
                "updatedAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
                "run_id" character varying(128) NOT NULL,
                "attempt" integer NOT NULL,
                "organization_id" character varying(128) NOT NULL,
                "team_id" character varying(128) NOT NULL,
                "repository_id" character varying(128) NOT NULL,
                "repository_name" character varying(256) NOT NULL,
                "repository_full_name" character varying(512),
                "platform" character varying(32) NOT NULL,
                "pr_number" integer NOT NULL,
                "head_sha" character varying(40) NOT NULL,
                CONSTRAINT "PK_runtime_run_targets" PRIMARY KEY ("uuid")
            )
        `);
        await queryRunner.query(
            `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_runtime_run_targets_run" ON "runtime_run_targets" ("run_id")`,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE IF EXISTS "runtime_run_targets"`);
    }
}
