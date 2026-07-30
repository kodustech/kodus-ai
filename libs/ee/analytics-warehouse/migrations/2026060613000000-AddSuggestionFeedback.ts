import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Cockpit revamp (phase 3) — `suggestion_feedback`: thumbs up/down reactions
 * on suggestion comments, ingested from Mongo `codeReviewFeedback`.
 *
 * One row per suggestion (the Mongo collection keeps one doc per delivered
 * suggestion comment; reaction counts are absolute, not deltas — upserts
 * overwrite). Powers "negative votes by category", the 👎 trend, the
 * negative-vote-rate highlight, and the `noisy` state on rules health.
 */
export class AddSuggestionFeedback2026060613000000
    implements MigrationInterface
{
    name = 'AddSuggestionFeedback2026060613000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "analytics"."suggestion_feedback" (
                "suggestion_id" text PRIMARY KEY,
                "organizationId" text NOT NULL,
                "thumbs_up" integer NOT NULL DEFAULT 0,
                "thumbs_down" integer NOT NULL DEFAULT 0,
                "comment_id" bigint,
                "pull_request_id" text,
                "repo_full_name" text,
                "feedback_created_at" timestamptz,
                "source_updated_at" timestamptz,
                "ingested_at" timestamptz NOT NULL DEFAULT now()
            )
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "idx_sugg_fb_org_created"
                ON "analytics"."suggestion_feedback" ("organizationId", "feedback_created_at")
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `DROP TABLE IF EXISTS "analytics"."suggestion_feedback"`,
        );
    }
}
