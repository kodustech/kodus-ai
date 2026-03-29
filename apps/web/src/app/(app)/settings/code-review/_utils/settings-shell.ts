import type {
    FormattedCodeReviewConfig,
    FormattedGlobalCodeReviewConfig,
} from "../_types";

export type CodeReviewSettingsScope = {
    repositoryId: string;
    directoryId?: string;
};

export const buildCodeReviewSettingsScopeKey = (
    teamId: string,
    repositoryId: string,
    directoryId?: string,
) => `${teamId}::${repositoryId}::${directoryId ?? "root"}`;

export const shouldResetCodeReviewFormForScopeChange = (
    previousScopeKey: string | undefined,
    nextScopeKey: string,
) => previousScopeKey !== undefined && previousScopeKey !== nextScopeKey;

export const buildCodeReviewSettingsHydrationKey = (
    scopeKey: string,
    language: string,
) => `${scopeKey}::${language}`;

export const shouldHydrateCodeReviewForm = (
    previousHydrationKey: string | undefined,
    nextHydrationKey: string,
) => previousHydrationKey !== nextHydrationKey;

export const mergeFormattedCodeReviewConfigForScope = (
    currentConfig: FormattedGlobalCodeReviewConfig | undefined,
    scope: CodeReviewSettingsScope,
    nextConfig: FormattedCodeReviewConfig,
) => {
    if (!currentConfig) return currentConfig;

    if (scope.repositoryId === "global") {
        return {
            ...currentConfig,
            configs: {
                ...currentConfig.configs,
                ...nextConfig,
                showToggleCodeReviewVersion:
                    currentConfig.configs.showToggleCodeReviewVersion,
            },
        };
    }

    return {
        ...currentConfig,
        repositories: currentConfig.repositories.map((repository) => {
            if (repository.id !== scope.repositoryId) {
                return repository;
            }

            if (!scope.directoryId) {
                return {
                    ...repository,
                    configs: {
                        ...repository.configs,
                        ...nextConfig,
                    },
                };
            }

            return {
                ...repository,
                directories: repository.directories.map((directory) =>
                    directory.id === scope.directoryId
                        ? {
                              ...directory,
                              configs: {
                                  ...directory.configs,
                                  ...nextConfig,
                              },
                          }
                        : directory,
                ),
            };
        }),
    };
};
