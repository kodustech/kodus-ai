import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Kody Runtime (docs/runtime/intent-oracle.md): the last description a pull request's author wrote, as the
 * Runtime read it on the PR's events. When the code review replaces the body with Kody's summary, the Run's
 * intent reads this instead of nothing. One row per (org, repository, PR). Product Postgres, written only by the API.
 */
export class AddRuntimePrAuthorDescriptions2026112700000000 implements MigrationInterface {
    name = 'AddRuntimePrAuthorDescriptions2026112700000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "runtime_pr_author_descriptions" (
                "uuid" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
                "updatedAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
                "organization_id" character varying(128) NOT NULL,
                "repository_id" character varying(128) NOT NULL,
                "pr_number" integer NOT NULL,
                "description" text NOT NULL,
                CONSTRAINT "PK_runtime_pr_author_descriptions" PRIMARY KEY ("uuid")
            )
        `);
        await queryRunner.query(
            `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_runtime_pr_author_descriptions_pr" ON "runtime_pr_author_descriptions" ("organization_id", "repository_id", "pr_number")`,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE IF EXISTS "runtime_pr_author_descriptions"`);
    }
}
