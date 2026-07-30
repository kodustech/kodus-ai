import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Cockpit revamp (phase 2) — two columns the "Kodus Review" tab needs:
 *
 *  - `suggestions_mv.brokenKodyRulesIds` — the rule UUIDs a suggestion
 *    enforces, promoted out of the `raw` JSONB so rule-level analytics
 *    (triggers, implementation rate per rule) can aggregate with a GIN
 *    index instead of scanning JSON. Backfilled from `raw` in place.
 *
 *  - `pull_requests_opt.pr_number` — the provider-facing PR number, so the
 *    suggestions explorer can deep-link "view on PR". Not backfillable from
 *    warehouse data (the opt row doesn't keep the raw PR doc); it populates
 *    going forward via ingestion and retroactively via a backfill re-run.
 */
export class AddRuleIdsAndPrNumber2026060612000000
    implements MigrationInterface
{
    name = 'AddRuleIdsAndPrNumber2026060612000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "analytics"."suggestions_mv"
                ADD COLUMN IF NOT EXISTS "brokenKodyRulesIds" text[]
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "idx_sugg_mv_broken_rules"
                ON "analytics"."suggestions_mv" USING GIN ("brokenKodyRulesIds")
        `);

        // Backfill from the raw JSONB already sitting in the table.
        await queryRunner.query(`
            UPDATE "analytics"."suggestions_mv"
               SET "brokenKodyRulesIds" = ARRAY(
                       SELECT jsonb_array_elements_text("raw"->'brokenKodyRulesIds')
                   )
             WHERE "brokenKodyRulesIds" IS NULL
               AND jsonb_typeof("raw"->'brokenKodyRulesIds') = 'array'
        `);

        await queryRunner.query(`
            ALTER TABLE "analytics"."pull_requests_opt"
                ADD COLUMN IF NOT EXISTS "pr_number" integer
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            DROP INDEX IF EXISTS "analytics"."idx_sugg_mv_broken_rules"
        `);
        await queryRunner.query(`
            ALTER TABLE "analytics"."suggestions_mv"
                DROP COLUMN IF EXISTS "brokenKodyRulesIds"
        `);
        await queryRunner.query(`
            ALTER TABLE "analytics"."pull_requests_opt"
                DROP COLUMN IF EXISTS "pr_number"
        `);
    }
}
