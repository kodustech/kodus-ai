import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Retires `ideRulesSyncEnabled`. It meant "convert IDE rule files into Kody
 * Rules", which no longer happens; reading coding-agent instructions during
 * review is a separate setting (`repoInstructionsEnabled`), off by default, so
 * no stored value carries over. Removed at every level and from every stored
 * version, so restoring an old version cannot bring it back.
 */
type ScopeConfigs = Record<string, unknown>;

type CodeReviewConfigValue = {
    configs?: ScopeConfigs;
    repositories?: Array<{
        configs?: ScopeConfigs;
        directories?: Array<{ configs?: ScopeConfigs }>;
    }>;
};

const RETIRED_KEY = 'ideRulesSyncEnabled';

export class RemoveIdeRulesSyncEnabled2026101500000000 implements MigrationInterface {
    name = 'RemoveIdeRulesSyncEnabled2026101500000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const rows: Array<{
            uuid: string;
            configValue: CodeReviewConfigValue | null;
        }> = await queryRunner.query(`
            SELECT uuid, "configValue"
              FROM "parameters"
             WHERE "configKey" = 'code_review_config'
        `);

        for (const row of rows) {
            if (!removeRetiredKey(row.configValue)) {
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
        // Not reversible: the old setting's behaviour no longer exists.
    }
}

/** Mutates `configValue` in place. Returns true if anything changed. */
function removeRetiredKey(configValue?: CodeReviewConfigValue | null): boolean {
    if (!configValue) {
        return false;
    }

    const scopes = [
        configValue.configs,
        ...(configValue.repositories ?? []).flatMap((repository) => [
            repository?.configs,
            ...(repository?.directories ?? []).map(
                (directory) => directory?.configs,
            ),
        ]),
    ];

    let changed = false;
    for (const configs of scopes) {
        if (configs && RETIRED_KEY in configs) {
            delete configs[RETIRED_KEY];
            changed = true;
        }
    }
    return changed;
}
