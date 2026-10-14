import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Keeps repositories from starting IDE rule-file sync on their own when
 * `ideRulesSyncEnabled` starts resolving default → global → repository.
 *
 * It used to be read from the repository alone, so a global "on" was
 * ignored. A repository without its own value under such a global would
 * start syncing, so it gets "off" pinned. Stored values stay, and
 * directory-level values are left alone: the sync works per repository.
 */
type ScopeConfigs = Record<string, unknown>;

type CodeReviewConfigValue = {
    configs?: ScopeConfigs;
    repositories?: Array<{ configs?: ScopeConfigs }>;
};

export class PinIdeRulesSyncUnderGlobalOn2026100500000000 implements MigrationInterface {
    name = 'PinIdeRulesSyncUnderGlobalOn2026100500000000';

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
            if (!pinIdeRulesSync(row.configValue)) {
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
        // Not reversible: a pinned value is indistinguishable from one the
        // team saved itself, so removing it could undo the team's own choice.
    }
}

/** Mutates `configValue` in place. Returns true if anything changed. */
function pinIdeRulesSync(configValue?: CodeReviewConfigValue): boolean {
    if (configValue?.configs?.ideRulesSyncEnabled !== true) {
        return false;
    }

    let changed = false;

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

    return changed;
}
