import { deepMerge } from '@libs/common/utils/deep';
import { getDefaultKodusConfigFile } from '@libs/common/utils/validateCodeReviewConfigFile';
import { CodeReviewParameter } from '@libs/core/infrastructure/config/types/general/codeReviewConfig.type';

export type KodyLearningSettings = {
    ideRulesSyncEnabled: boolean;
    kodyRulesGeneratorEnabled: boolean;
    kodyLearningExcludedReviewers: string[];
};

type CodeReviewConfigLike =
    Pick<CodeReviewParameter, 'configs' | 'repositories'> | null | undefined;

/**
 * Resolves the learning settings repositories actually run with: default →
 * global → repository. Directory-level values are ignored on purpose, because
 * rule generation and IDE rule-file sync both work per repository.
 *
 * The defaults and the global level are merged once, so callers resolving
 * many repositories should build one resolver and reuse it.
 */
export function createKodyLearningSettingsResolver(
    codeReviewConfig: CodeReviewConfigLike,
): (repositoryId: string) => KodyLearningSettings {
    const resolvedGlobal = deepMerge<Record<string, unknown>>(
        getDefaultKodusConfigFile() as Record<string, unknown>,
        (codeReviewConfig?.configs ?? {}) as Record<string, unknown>,
    );

    const repositoryConfigs = new Map<string, Record<string, unknown>>(
        (codeReviewConfig?.repositories ?? []).map((repo) => [
            String(repo.id),
            (repo.configs ?? {}) as Record<string, unknown>,
        ]),
    );

    return (repositoryId: string) => {
        const resolved = deepMerge<Record<string, unknown>>(
            resolvedGlobal,
            repositoryConfigs.get(String(repositoryId)) ?? {},
        );

        return {
            ideRulesSyncEnabled: resolved.ideRulesSyncEnabled === true,
            kodyRulesGeneratorEnabled:
                resolved.kodyRulesGeneratorEnabled === true,
            kodyLearningExcludedReviewers: Array.isArray(
                resolved.kodyLearningExcludedReviewers,
            )
                ? (resolved.kodyLearningExcludedReviewers as unknown[]).map(
                      String,
                  )
                : [],
        };
    };
}

/** Learning settings of a single repository. See the resolver above. */
export function resolveKodyLearningSettings(
    codeReviewConfig: CodeReviewConfigLike,
    repositoryId: string,
): KodyLearningSettings {
    return createKodyLearningSettingsResolver(codeReviewConfig)(repositoryId);
}
