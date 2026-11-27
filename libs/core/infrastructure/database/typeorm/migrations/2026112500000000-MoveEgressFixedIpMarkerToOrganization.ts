import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Moves the fixed-IP marker from the team (`integration_configs`, written by
 * the clone fallback since 2.2.18) to the organization
 * (`organization_parameters`), where the policy now reads it. Without this,
 * a team already marked would go back to the shared network on deploy and
 * fail its first clone again.
 *
 * One row per organization: a team that needs the fixed IP makes the whole
 * organization need it, and the latest such marker wins, keeping its
 * `detectedAt` so its expiry is unchanged. An organization that already has
 * the setting keeps it. Runs after the enum migration, in its own
 * transaction, since Postgres refuses a new enum value in the transaction
 * that added it.
 */
export class MoveEgressFixedIpMarkerToOrganization2026112500000000 implements MigrationInterface {
    name = 'MoveEgressFixedIpMarkerToOrganization2026112500000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            INSERT INTO "organization_parameters" ("configKey", "configValue", "organization_id")
            SELECT DISTINCT ON (t."organization_id")
                   'egress_fixed_ip', ic."configValue", t."organization_id"
            FROM "integration_configs" ic
            JOIN "teams" t ON t."uuid" = ic."team_id"
            WHERE ic."configKey"::text = 'egress_fixed_ip'
              AND t."organization_id" IS NOT NULL
              AND jsonb_typeof(ic."configValue") = 'object'
              AND (ic."configValue"->>'required') = 'true'
              AND NOT EXISTS (
                  SELECT 1 FROM "organization_parameters" op
                  WHERE op."organization_id" = t."organization_id"
                    AND op."configKey"::text = 'egress_fixed_ip'
              )
            ORDER BY t."organization_id", ic."updatedAt" DESC
        `);
    }

    public async down(): Promise<void> {
        // The team rows are left in place, so nothing is lost going back; a
        // copied row cannot be told from one an owner saved afterwards, and
        // the enum migration's down removes every one of them anyway.
    }
}
