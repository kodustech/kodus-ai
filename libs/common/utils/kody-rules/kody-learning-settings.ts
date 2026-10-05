import { deepMerge } from '@libs/common/utils/deep';
import { getDefaultKodusConfigFile } from '@libs/common/utils/validateCodeReviewConfigFile';
import { CodeReviewParameter } from '@libs/core/infrastructure/config/types/general/codeReviewConfig.type';

export type KodyLearningSettings = {
    ideRulesSyncEnabled: boolean;
    kodyRulesGeneratorEnabled: boolean;
    kodyLearningExcludedReviewers: string[];
};

/**
 * The learning settings a repository actually runs with: default → global →
 * repository. Directory-level values are ignored on purpose, because rule
 * generation and IDE rule-file sync both work per repository.
 */
export function resolveKodyLearningSettings(
    codeReviewConfig:
        | Pick<CodeReviewParameter, 'configs' | 'repositories'>
        | null
        | undefined,
    repositoryId: string,
): KodyLearningSettings {
    const repository = codeReviewConfig?.repositories?.find(
        (repo) => String(repo.id) === String(repositoryId),
    );

    const resolved = deepMerge<Record<string, unknown>>(
        getDefaultKodusConfigFile() as Record<string, unknown>,
        (codeReviewConfig?.configs ?? {}) as Record<string, unknown>,
        (repository?.configs ?? {}) as Record<string, unknown>,
    );

    return {
        ideRulesSyncEnabled: resolved.ideRulesSyncEnabled === true,
        kodyRulesGeneratorEnabled: resolved.kodyRulesGeneratorEnabled === true,
        kodyLearningExcludedReviewers: Array.isArray(
            resolved.kodyLearningExcludedReviewers,
        )
            ? (resolved.kodyLearningExcludedReviewers as unknown[]).map(String)
            : [],
    };
}
