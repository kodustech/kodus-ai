import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migrates the memory-only `llmGeneratedMemoriesRequireApproval` boolean to the
 * unified `kodyKnowledgeApproval: { enabled }` object inside the
 * `code_review_config` parameter's jsonb `configValue`.
 *
 * The flag can live at three nesting levels of the config cascade — global
 * (`configValue.configs`), per-repository (`repositories[].configs`), and
 * per-directory (`repositories[].directories[].configs`) — so the transform is
 * applied at each. Done in JS over the loaded rows rather than in SQL because
 * the rename is nested and conditional. Idempotent: a `configs` block already
 * carrying `kodyKnowledgeApproval` is left untouched.
 */
export class KodyKnowledgeApprovalConfig2026062100000000
    implements MigrationInterface
{
    name = 'KodyKnowledgeApprovalConfig2026062100000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await this.remap(queryRunner, (configs) => {
            if (
                configs &&
                typeof configs === 'object' &&
                Object.prototype.hasOwnProperty.call(
                    configs,
                    'llmGeneratedMemoriesRequireApproval',
                )
            ) {
                configs.kodyKnowledgeApproval = {
                    enabled: configs.llmGeneratedMemoriesRequireApproval === true,
                };
                delete configs.llmGeneratedMemoriesRequireApproval;
                return true;
            }
            return false;
        });
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await this.remap(queryRunner, (configs) => {
            if (
                configs &&
                typeof configs === 'object' &&
                configs.kodyKnowledgeApproval &&
                typeof configs.kodyKnowledgeApproval === 'object'
            ) {
                configs.llmGeneratedMemoriesRequireApproval =
                    configs.kodyKnowledgeApproval.enabled === true;
                delete configs.kodyKnowledgeApproval;
                return true;
            }
            return false;
        });
    }

    /**
     * Loads every `code_review_config` parameter row, applies `transform` to
     * each `configs` block (global, per-repo, per-directory), and writes back
     * only the rows that changed.
     */
    private async remap(
        queryRunner: QueryRunner,
        transform: (configs: any) => boolean,
    ): Promise<void> {
        const rows: Array<{ uuid: string; configValue: any }> =
            await queryRunner.query(
                `SELECT uuid, "configValue" FROM parameters WHERE "configKey" = 'code_review_config'`,
            );

        for (const row of rows) {
            const configValue = row.configValue;
            if (!configValue || typeof configValue !== 'object') continue;

            let changed = false;
            const apply = (configs: any) => {
                if (transform(configs)) changed = true;
            };

            apply(configValue.configs);
            for (const repo of configValue.repositories ?? []) {
                apply(repo?.configs);
                for (const dir of repo?.directories ?? []) {
                    apply(dir?.configs);
                }
            }

            if (!changed) continue;

            await queryRunner.query(
                `UPDATE parameters SET "configValue" = $1 WHERE uuid = $2`,
                [JSON.stringify(configValue), row.uuid],
            );
        }
    }
}
