import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Cockpit revamp — index to keep the "Kodus Review" aggregations fast on
 * large multi-tenant orgs.
 *
 * Every impl-rate / category / severity / rules / feedback query filters
 * `suggestions_mv` by `(organizationId, suggestionDeliveryStatus='sent')`
 * before joining PRs. Without a matching index Postgres seq-scans the whole
 * table (fine at thousands of rows, costly at hundreds of thousands). This
 * composite lets it restrict to one org's sent suggestions directly.
 */
export class ReviewAnalyticsIndexes2026060814000000
    implements MigrationInterface
{
    name = 'ReviewAnalyticsIndexes2026060814000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "idx_sugg_mv_org_delivery"
                ON "analytics"."suggestions_mv"
                ("organizationId", "suggestionDeliveryStatus")
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            DROP INDEX IF EXISTS "analytics"."idx_sugg_mv_org_delivery"
        `);
    }
}
