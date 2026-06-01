import { MigrationInterface, QueryRunner } from 'typeorm';

export class AstGraphTables1775690886942 implements MigrationInterface {
    name = 'AstGraphTables1775690886942';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            DO $$ BEGIN
                CREATE TYPE "public"."repositories_ast_graph_status_enum" AS ENUM('pending', 'building', 'ready', 'failed');
            EXCEPTION WHEN duplicate_object THEN NULL;
            END $$
        `);
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "repositories" (
                "uuid" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone,
                "updatedAt" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone,
                "integration_config_id" uuid NOT NULL,
                "external_id" text NOT NULL,
                "name" text NOT NULL,
                "full_name" text NOT NULL,
                "platform" text NOT NULL,
                "default_branch" text NOT NULL DEFAULT 'main',
                "ast_graph_status" "public"."repositories_ast_graph_status_enum" DEFAULT 'pending',
                "ast_graph_sha" text,
                "ast_graph_built_at" TIMESTAMP,
                "ast_graph_node_count" integer NOT NULL DEFAULT '0',
                "ast_graph_edge_count" integer NOT NULL DEFAULT '0',
                CONSTRAINT "UQ_repositories_platform_external" UNIQUE ("platform", "external_id"),
                CONSTRAINT "PK_81c93bbab1c39a9c1e39ae48cb7" PRIMARY KEY ("uuid")
            )
        `);
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "ast_nodes" (
                "id" BIGSERIAL NOT NULL,
                "repo_id" uuid NOT NULL,
                "kind" text NOT NULL,
                "name" text NOT NULL,
                "qualified_name" text NOT NULL,
                "file_path" text NOT NULL,
                "line_start" integer,
                "line_end" integer,
                "language" text,
                "parent_name" text,
                "params" text,
                "return_type" text,
                "modifiers" text,
                "is_test" boolean NOT NULL DEFAULT false,
                "file_hash" text,
                CONSTRAINT "UQ_ast_nodes_repo_qualified" UNIQUE ("repo_id", "qualified_name"),
                CONSTRAINT "PK_71f55d2ee018f34007f567c203f" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "idx_ast_nodes_repo_qual" ON "ast_nodes" ("repo_id", "qualified_name")
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "idx_ast_nodes_repo_kind" ON "ast_nodes" ("repo_id", "kind")
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "idx_ast_nodes_repo_file" ON "ast_nodes" ("repo_id", "file_path")
        `);
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "ast_edges" (
                "id" BIGSERIAL NOT NULL,
                "repo_id" uuid NOT NULL,
                "kind" text NOT NULL,
                "source_qualified" text NOT NULL,
                "target_qualified" text NOT NULL,
                "file_path" text NOT NULL,
                "line" integer NOT NULL DEFAULT '0',
                "confidence" real,
                CONSTRAINT "UQ_ast_edges_repo_kind_src_tgt" UNIQUE (
                    "repo_id",
                    "kind",
                    "source_qualified",
                    "target_qualified"
                ),
                CONSTRAINT "PK_68d6f449376a7860a98d357c2db" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "idx_ast_edges_repo_file" ON "ast_edges" ("repo_id", "file_path")
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "idx_ast_edges_repo_kind" ON "ast_edges" ("repo_id", "kind")
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "idx_ast_edges_repo_target" ON "ast_edges" ("repo_id", "target_qualified")
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "idx_ast_edges_repo_source" ON "ast_edges" ("repo_id", "source_qualified")
        `);
        await queryRunner.query(`
            ALTER TYPE "kodus_workflow"."workflow_jobs_workflowtype_enum"
            RENAME TO "workflow_jobs_workflowtype_enum_old"
        `);
        await queryRunner.query(`
            CREATE TYPE "kodus_workflow"."workflow_jobs_workflowtype_enum" AS ENUM(
                'CODE_REVIEW',
                'CRON_CHECK_PR_APPROVAL',
                'CRON_KODY_LEARNING',
                'CRON_CODE_REVIEW_FEEDBACK',
                'WEBHOOK_PROCESSING',
                'CHECK_SUGGESTION_IMPLEMENTATION',
                'AST_GRAPH_BUILD',
                'AST_GRAPH_INCREMENTAL'
            )
        `);
        await queryRunner.query(`
            ALTER TABLE "kodus_workflow"."workflow_jobs"
            ALTER COLUMN "workflowType" TYPE "kodus_workflow"."workflow_jobs_workflowtype_enum" USING "workflowType"::"text"::"kodus_workflow"."workflow_jobs_workflowtype_enum"
        `);
        await queryRunner.query(`
            DROP TYPE "kodus_workflow"."workflow_jobs_workflowtype_enum_old"
        `);
        await queryRunner.query(`
            DO $$ BEGIN
                ALTER TABLE "ast_nodes"
                ADD CONSTRAINT "FK_3646ba9180736a6764f10a98f02" FOREIGN KEY ("repo_id") REFERENCES "repositories"("uuid") ON DELETE CASCADE ON UPDATE NO ACTION;
            EXCEPTION WHEN duplicate_object THEN NULL;
            END $$
        `);
        await queryRunner.query(`
            DO $$ BEGIN
                ALTER TABLE "ast_edges"
                ADD CONSTRAINT "FK_7faf9409db66f438da015eb7976" FOREIGN KEY ("repo_id") REFERENCES "repositories"("uuid") ON DELETE CASCADE ON UPDATE NO ACTION;
            EXCEPTION WHEN duplicate_object THEN NULL;
            END $$
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "ast_edges" DROP CONSTRAINT "FK_7faf9409db66f438da015eb7976"
        `);
        await queryRunner.query(`
            ALTER TABLE "ast_nodes" DROP CONSTRAINT "FK_3646ba9180736a6764f10a98f02"
        `);
        await queryRunner.query(`
            CREATE TYPE "kodus_workflow"."workflow_jobs_workflowtype_enum_old" AS ENUM(
                'CODE_REVIEW',
                'CRON_CHECK_PR_APPROVAL',
                'CRON_KODY_LEARNING',
                'CRON_CODE_REVIEW_FEEDBACK',
                'WEBHOOK_PROCESSING',
                'CHECK_SUGGESTION_IMPLEMENTATION'
            )
        `);
        await queryRunner.query(`
            ALTER TABLE "kodus_workflow"."workflow_jobs"
            ALTER COLUMN "workflowType" TYPE "kodus_workflow"."workflow_jobs_workflowtype_enum_old" USING "workflowType"::"text"::"kodus_workflow"."workflow_jobs_workflowtype_enum_old"
        `);
        await queryRunner.query(`
            DROP TYPE "kodus_workflow"."workflow_jobs_workflowtype_enum"
        `);
        await queryRunner.query(`
            ALTER TYPE "kodus_workflow"."workflow_jobs_workflowtype_enum_old"
            RENAME TO "workflow_jobs_workflowtype_enum"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."idx_ast_edges_repo_source"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."idx_ast_edges_repo_target"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."idx_ast_edges_repo_kind"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."idx_ast_edges_repo_file"
        `);
        await queryRunner.query(`
            DROP TABLE "ast_edges"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."idx_ast_nodes_repo_file"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."idx_ast_nodes_repo_kind"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."idx_ast_nodes_repo_qual"
        `);
        await queryRunner.query(`
            DROP TABLE "ast_nodes"
        `);
        await queryRunner.query(`
            DROP TABLE "repositories"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."repositories_ast_graph_status_enum"
        `);
    }
}
