import { createLogger } from '@kodus/flow';
import { Inject, Injectable } from '@nestjs/common';
import { DeepPartial } from 'typeorm';

import {
    IPullRequestMessagesService,
    PULL_REQUEST_MESSAGES_SERVICE_TOKEN,
} from '@libs/code-review/domain/pullRequestMessages/contracts/pullRequestMessages.service.contract';
import { PullRequestMessagesEntity } from '@libs/code-review/domain/pullRequestMessages/entities/pullRequestMessages.entity';
import { deepDifference, deepMerge } from '@libs/common/utils/deep';
import { getDefaultKodusConfigFile } from '@libs/common/utils/validateCodeReviewConfigFile';
import {
    FormattedConfig,
    FormattedConfigLevel,
    IFormattedConfigProperty,
} from '@libs/core/infrastructure/config/types/general/codeReviewConfig.type';
import { ConfigLevel } from '@libs/core/infrastructure/config/types/general/pullRequestMessages.type';

type CustomMessagesConfig = ReturnType<
    typeof getDefaultKodusConfigFile
>['customMessages'];

export type FormattedCustomMessagesConfig =
    FormattedConfig<CustomMessagesConfig>;

@Injectable()
export class FindByRepositoryOrDirectoryIdPullRequestMessagesUseCase {
    private readonly logger = createLogger(
        FindByRepositoryOrDirectoryIdPullRequestMessagesUseCase.name,
    );

    constructor(
        @Inject(PULL_REQUEST_MESSAGES_SERVICE_TOKEN)
        private readonly pullRequestMessagesService: IPullRequestMessagesService,
    ) {}

    async execute(
        organizationId: string,
        repositoryId: string,
        directoryId?: string,
    ) {
        try {
            if (!organizationId) {
                throw new Error('Organization ID is required');
            }

            if (directoryId && !repositoryId) {
                throw new Error(
                    'Repository ID is required when Directory ID is provided',
                );
            }

            const { customMessages: defaultConfig } =
                getDefaultKodusConfigFile();

            const globalEntity = await this.pullRequestMessagesService.findOne({
                organizationId,
                configLevel: ConfigLevel.GLOBAL,
            });
            const globalConfig = this.getConfigs(globalEntity);

            const repoEntity = repositoryId
                ? await this.pullRequestMessagesService.findOne({
                      organizationId,
                      repositoryId,
                      configLevel: ConfigLevel.REPOSITORY,
                  })
                : undefined;
            const repoConfig = this.getConfigs(repoEntity);

            const directoryEntity = directoryId
                ? await this.pullRequestMessagesService.findOne({
                      organizationId,
                      repositoryId,
                      directoryId,
                      configLevel: ConfigLevel.DIRECTORY,
                  })
                : undefined;
            const directoryConfig = this.getConfigs(directoryEntity);

            const resolvedGlobalConfig = deepMerge(defaultConfig, globalConfig);
            const resolvedRepoConfig = deepMerge(
                resolvedGlobalConfig,
                repoConfig,
            );

            const globalDelta = deepDifference(defaultConfig, globalConfig);
            const repoDelta = deepDifference(resolvedGlobalConfig, repoConfig);
            const directoryDelta = deepDifference(
                resolvedRepoConfig,
                directoryConfig,
            );

            const formattedDefaultConfig =
                this.formatDefaultConfig(defaultConfig);

            const formattedGlobalConfig = this.formatLevel(
                formattedDefaultConfig,
                globalDelta,
                FormattedConfigLevel.GLOBAL,
            );

            const formattedRepoConfig = this.formatLevel(
                formattedGlobalConfig,
                repoDelta,
                FormattedConfigLevel.REPOSITORY,
            );

            const formattedDirectoryConfig = this.formatLevel(
                formattedRepoConfig,
                directoryDelta,
                FormattedConfigLevel.DIRECTORY,
            );

            const finalEntity = directoryEntity ?? repoEntity ?? globalEntity;

            const baseEntityObject = finalEntity?.toJson() ?? {
                uuid: undefined,
                organizationId,
                repositoryId,
                directoryId,
            };

            return {
                ...baseEntityObject,
                ...formattedDirectoryConfig,
            };
        } catch (error) {
            this.logger.error({
                message:
                    'Error finding pull request messages by repository or directory',
                context:
                    FindByRepositoryOrDirectoryIdPullRequestMessagesUseCase.name,
                error: error,
                metadata: { organizationId, repositoryId, directoryId },
            });
        }
    }

    private getConfigs(entity: PullRequestMessagesEntity | undefined) {
        const json = entity?.toJson();
        return {
            globalSettings: {
                hideComments: json?.globalSettings?.hideComments,
                suggestionCopyPrompt:
                    json?.globalSettings?.suggestionCopyPrompt,
            },
            endReviewMessage: {
                content: json?.endReviewMessage?.content,
                status: json?.endReviewMessage?.status,
            },
            startReviewMessage: {
                content: json?.startReviewMessage?.content,
                status: json?.startReviewMessage?.status,
            },
        } as CustomMessagesConfig;
    }

    private formatDefaultConfig(config: object): FormattedCustomMessagesConfig {
        const formatted = {};
        for (const key in config) {
            if (Object.prototype.hasOwnProperty.call(config, key)) {
                const value = config[key];
                if (
                    typeof value === 'object' &&
                    value !== null &&
                    !Array.isArray(value)
                ) {
                    formatted[key] = this.formatDefaultConfig(value);
                } else {
                    formatted[key] = {
                        value,
                        level: FormattedConfigLevel.DEFAULT,
                    };
                }
            }
        }
        return formatted as FormattedCustomMessagesConfig;
    }

    private formatLevel(
        formattedParent: FormattedCustomMessagesConfig,
        childDelta: DeepPartial<CustomMessagesConfig> | undefined,
        childLevel: FormattedConfigLevel,
    ): FormattedCustomMessagesConfig {
        if (!childDelta) {
            return formattedParent;
        }

        const formattedChild = { ...formattedParent };

        for (const key in childDelta) {
            if (Object.prototype.hasOwnProperty.call(childDelta, key)) {
                const childValue = childDelta[key];
                const parentNode = formattedParent[key];

                if (childValue === null || typeof childValue === 'undefined') {
                    continue;
                }

                const isParentNodeLeaf =
                    this.isFormattedConfigProperty(parentNode);
                const isParentNodeBranch =
                    !!parentNode &&
                    typeof parentNode === 'object' &&
                    !isParentNodeLeaf;

                if (
                    typeof childValue === 'object' &&
                    !Array.isArray(childValue)
                ) {
                    if (isParentNodeBranch) {
                        formattedChild[key] = this.formatLevel(
                            parentNode,
                            childValue,
                            childLevel,
                        );
                    } else {
                        formattedChild[key] = this.formatObjectAtLevel(
                            childValue,
                            childLevel,
                        );
                    }
                    continue;
                }

                formattedChild[key] = {
                    value: childValue,
                    level: childLevel,
                    overriddenValue: isParentNodeLeaf
                        ? (parentNode as IFormattedConfigProperty<any>).value
                        : undefined,
                    overriddenLevel: isParentNodeLeaf
                        ? (parentNode as IFormattedConfigProperty<any>).level
                        : undefined,
                };
            }
        }
        return formattedChild;
    }

    private formatObjectAtLevel(
        config: object,
        level: FormattedConfigLevel,
    ): FormattedCustomMessagesConfig {
        const formatted = {};
        for (const key in config) {
            if (Object.prototype.hasOwnProperty.call(config, key)) {
                const value = config[key];
                if (
                    typeof value === 'object' &&
                    value !== null &&
                    !Array.isArray(value)
                ) {
                    formatted[key] = this.formatObjectAtLevel(value, level);
                } else {
                    formatted[key] = {
                        value,
                        level,
                    };
                }
            }
        }
        return formatted as FormattedCustomMessagesConfig;
    }

    private isFormattedConfigProperty(
        value: any,
    ): value is IFormattedConfigProperty<any> {
        return (
            value &&
            typeof value === 'object' &&
            'value' in value &&
            'level' in value
        );
    }
}
