import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `repositories.integration_config_id` references `integration_configs.uuid`,
 * but onboarding and the AST-graph backfill stored the team uuid there, so
 * joins through it (e.g. the doctor's AST check) found nothing. Points every
 * such row at that team's `repositories` config, the most recently updated
 * one when there are several, as `findOneIntegrationConfigWithIntegrations`
 * picks at runtime. Rows whose team has no such config are left as they are.
 */
export class RelinkRepositoriesToIntegrationConfig2026103100000000 implements MigrationInterface {
    name = 'RelinkRepositoriesToIntegrationConfig2026103100000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            UPDATE "repositories" r
               SET "integration_config_id" = ic.uuid
              FROM (
                    SELECT DISTINCT ON ("team_id") "uuid", "team_id"
                      FROM "integration_configs"
                     WHERE "configKey" = 'repositories'
                       AND "team_id" IS NOT NULL
                     ORDER BY "team_id", "updatedAt" DESC
                   ) ic
             WHERE r."integration_config_id" = ic."team_id"
        `);
    }

    public async down(): Promise<void> {
        // Not reversible: the team uuid was never a valid value here.
    }
}
