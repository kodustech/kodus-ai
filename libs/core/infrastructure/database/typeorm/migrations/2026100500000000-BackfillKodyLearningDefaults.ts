import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Keeps every team's effective Kody Rules learning settings unchanged when
 * they start resolving default → global → repository.
 *
 * - `kodyRulesGeneratorEnabled` now defaults to off. A team with no global
 *   value was getting "on" from the old default, so it gets "on" stored at
 *   global and its repositories keep inheriting it. Stored values stay.
 * - `ideRulesSyncEnabled` used to be read from the repository alone, so a
 *   global "on" was ignored. Repositories without their own value under such
 *   a global would start syncing, so they get "off" pinned.
 *
 * Directory-level values are left alone: both behaviors are repo-scoped.
 */
type ScopeConfigs = Record<string, unknown>;

type CodeReviewConfigValue = {
    configs?: ScopeConfigs;
    repositories?: Array<{ configs?: ScopeConfigs }>;
};

export class BackfillKodyLearningDefaults2026100500000000 implements MigrationInterface {
    name = 'BackfillKodyLearningDefaults2026100500000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const rows: Array<{
            uuid: string;
            configValue: CodeReviewConfigValue;
        }> = await queryRunner.query(`
            SELECT uuid, "configValue"
              FROM "parameters"
             WHERE "configKey" = 'code_review_config'
               AND active = true
        `);

        for (const row of rows) {
            if (!backfillConfigValue(row.configValue)) {
                continue;
            }

            await queryRunner.query(
                `
                    UPDATE "parameters"
                       SET "configValue" = $1,
                           "updatedAt" = NOW()
                     WHERE uuid = $2
                `,
                [JSON.stringify(row.configValue), row.uuid],
            );
        }
    }

    public async down(): Promise<void> {
        // Not reversible: a backfilled value is indistinguishable from one the
        // team saved itself, so removing it could undo the team's own choice.
    }
}

/** Mutates `configValue` in place. Returns true if anything changed. */
function backfillConfigValue(configValue?: CodeReviewConfigValue): boolean {
    if (!configValue) {
        return false;
    }

    let changed = false;
    const global = (configValue.configs ??= {});

    if (global.kodyRulesGeneratorEnabled === undefined) {
        global.kodyRulesGeneratorEnabled = true;
        changed = true;
    }

    if (global.ideRulesSyncEnabled === true) {
        for (const repository of configValue.repositories ?? []) {
            if (!repository) {
                continue;
            }

            const repoConfigs = (repository.configs ??= {});

            if (repoConfigs.ideRulesSyncEnabled === undefined) {
                repoConfigs.ideRulesSyncEnabled = false;
                changed = true;
            }
        }
    }

    return changed;
}
