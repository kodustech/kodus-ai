import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Bootstraps the cockpit warehouse schema and ALL its tables in one shot.
 *
 * Runs against the analytics DataSource, which may point at a dedicated
 * Postgres instance (cloud) or share the OLTP instance scoped to the
 * `analytics` schema (self-hosted). Either way, everything this migration
 * touches lives under that one schema.
 *
 * Tables created:
 *   - pull_requests_opt         wide, materialized PR view (ingestion target)
 *   - suggestions_mv            exploded suggestions per file
 *   - commits_view              exploded commits
 *   - pull_request_types        PR classification
 *   - watermarks                (table_name, tuple(updatedAt, _id), status)
 *   - ingestion_runs            one row per run (cron, backfill, replay)
 *   - ingestion_errors          quarantined docs the ingestion couldn't write
 *   - backfill_progress         checkpoint for the chunked backfill CLI
 */
export class InitAnalyticsSchema2026042000000 implements MigrationInterface {
    name = 'InitAnalyticsSchema2026042000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query('CREATE SCHEMA IF NOT EXISTS "analytics"');

        // ---------------------------------------------------------------
        // pull_requests_opt  +  indexes
        // ---------------------------------------------------------------
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "analytics"."pull_requests_opt" (
                "_id" text PRIMARY KEY,
                "organizationId" text NOT NULL,
                "repo_full_name" text,
                "repositoryId" text,
                "status" text,
                "authorId" text,
                "author_username" text,
                "totalChanges" integer,
                "createdAt" text,
                "openedAt" text,
                "closedAt" text,
                "parsed_created_at" timestamptz,
                "parsed_opened_at" timestamptz,
                "parsed_closed_at" timestamptz,
                "files" jsonb,
                "commits" jsonb,
                "ingested_at" timestamptz NOT NULL DEFAULT now(),
                "source_updated_at" timestamptz
            )
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "idx_pr_opt_org_closed"
                ON "analytics"."pull_requests_opt" ("organizationId", "parsed_closed_at")
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "idx_pr_opt_org_created"
                ON "analytics"."pull_requests_opt" ("organizationId", "parsed_created_at")
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "idx_pr_opt_org_repo"
                ON "analytics"."pull_requests_opt" ("organizationId", "repo_full_name")
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "idx_pr_opt_org"
                ON "analytics"."pull_requests_opt" ("organizationId")
        `);

        // ---------------------------------------------------------------
        // suggestions_mv  +  indexes
        // ---------------------------------------------------------------
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "analytics"."suggestions_mv" (
                "suggestion_id" text PRIMARY KEY,
                "organizationId" text NOT NULL,
                "pullRequestId" text NOT NULL,
                "repositoryId" text,
                "filePath" text,
                "label" text,
                "severity" text,
                "suggestionDeliveryStatus" text,
                "suggestionImplementationStatus" text,
                "suggestionCreatedAt" timestamptz,
                "raw" jsonb
            )
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "idx_sugg_mv_org_created"
                ON "analytics"."suggestions_mv" ("organizationId", "suggestionCreatedAt")
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "idx_sugg_mv_pr"
                ON "analytics"."suggestions_mv" ("pullRequestId")
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "idx_sugg_mv_org"
                ON "analytics"."suggestions_mv" ("organizationId")
        `);

        // ---------------------------------------------------------------
        // commits_view  +  indexes
        // ---------------------------------------------------------------
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "analytics"."commits_view" (
                "pull_request_id" text NOT NULL,
                "commit_hash" text NOT NULL,
                "organizationId" text NOT NULL,
                "commit_timestamp" timestamptz,
                "commit_timestamp_raw" text,
                "author_username" text,
                "raw" jsonb,
                CONSTRAINT "pk_commits_view" PRIMARY KEY ("pull_request_id", "commit_hash")
            )
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "idx_commits_view_org_ts"
                ON "analytics"."commits_view" ("organizationId", "commit_timestamp")
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "idx_commits_view_pr"
                ON "analytics"."commits_view" ("pull_request_id")
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "idx_commits_view_org"
                ON "analytics"."commits_view" ("organizationId")
        `);

        // ---------------------------------------------------------------
        // pull_request_types
        // ---------------------------------------------------------------
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "analytics"."pull_request_types" (
                "pullRequestId" text PRIMARY KEY,
                "organizationId" text NOT NULL,
                "type" text
            )
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "idx_pr_types_org"
                ON "analytics"."pull_request_types" ("organizationId")
        `);

        // ---------------------------------------------------------------
        // watermarks (tuple: updatedAt + _id)
        // ---------------------------------------------------------------
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "analytics"."watermarks" (
                "table_name" text PRIMARY KEY,
                "last_source_updated_at" timestamptz,
                "last_source_id" text,
                "last_run_at" timestamptz,
                "last_status" text,
                "last_error" text
            )
        `);

        // ---------------------------------------------------------------
        // ingestion_runs (one row per run)
        // ---------------------------------------------------------------
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "analytics"."ingestion_runs" (
                "id" bigserial PRIMARY KEY,
                "source" text NOT NULL,
                "mode" text NOT NULL,
                "started_at" timestamptz NOT NULL DEFAULT now(),
                "finished_at" timestamptz,
                "status" text NOT NULL,
                "scanned" integer NOT NULL DEFAULT 0,
                "prs_upserted" integer NOT NULL DEFAULT 0,
                "suggestions_inserted" integer NOT NULL DEFAULT 0,
                "commits_inserted" integer NOT NULL DEFAULT 0,
                "errors_quarantined" integer NOT NULL DEFAULT 0,
                "mongo_ms" integer,
                "write_ms" integer,
                "since" timestamptz,
                "until" timestamptz,
                "organizationId" text,
                "new_watermark" timestamptz,
                "error" text
            )
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "idx_ingestion_runs_started"
                ON "analytics"."ingestion_runs" ("source", "started_at" DESC)
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "idx_ingestion_runs_status"
                ON "analytics"."ingestion_runs" ("status", "finished_at" DESC)
        `);

        // ---------------------------------------------------------------
        // ingestion_errors (quarantine)
        // ---------------------------------------------------------------
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "analytics"."ingestion_errors" (
                "id" bigserial PRIMARY KEY,
                "source" text NOT NULL,
                "pull_request_id" text,
                "organizationId" text,
                "run_id" bigint,
                "created_at" timestamptz NOT NULL DEFAULT now(),
                "reason" text,
                "error" text,
                "raw" jsonb
            )
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "idx_ingestion_errors_source_created"
                ON "analytics"."ingestion_errors" ("source", "created_at" DESC)
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "idx_ingestion_errors_pr"
                ON "analytics"."ingestion_errors" ("pull_request_id")
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "idx_ingestion_errors_run"
                ON "analytics"."ingestion_errors" ("run_id")
        `);

        // ---------------------------------------------------------------
        // backfill_progress (CLI checkpoint)
        // ---------------------------------------------------------------
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "analytics"."backfill_progress" (
                "source" text PRIMARY KEY,
                "cursor_at" timestamptz NOT NULL,
                "status" text NOT NULL,
                "started_at" timestamptz NOT NULL DEFAULT now(),
                "updated_at" timestamptz NOT NULL DEFAULT now(),
                "finished_at" timestamptz,
                "scanned_total" bigint NOT NULL DEFAULT 0,
                "last_error" text,
                "params" jsonb
            )
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            'DROP TABLE IF EXISTS "analytics"."backfill_progress"',
        );
        await queryRunner.query(
            'DROP TABLE IF EXISTS "analytics"."ingestion_errors"',
        );
        await queryRunner.query(
            'DROP TABLE IF EXISTS "analytics"."ingestion_runs"',
        );
        await queryRunner.query(
            'DROP TABLE IF EXISTS "analytics"."watermarks"',
        );
        await queryRunner.query(
            'DROP TABLE IF EXISTS "analytics"."pull_request_types"',
        );
        await queryRunner.query(
            'DROP TABLE IF EXISTS "analytics"."commits_view"',
        );
        await queryRunner.query(
            'DROP TABLE IF EXISTS "analytics"."suggestions_mv"',
        );
        await queryRunner.query(
            'DROP TABLE IF EXISTS "analytics"."pull_requests_opt"',
        );
        // Intentionally leave the `analytics` schema in place — dropping a
        // schema with other objects would be destructive and this migration
        // should never own unrelated objects.
    }
}
