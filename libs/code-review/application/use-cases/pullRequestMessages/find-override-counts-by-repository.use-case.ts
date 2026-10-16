import { createLogger } from '@libs/core/log/logger';
import { Inject, Injectable } from '@nestjs/common';

import {
    IPullRequestMessagesService,
    PULL_REQUEST_MESSAGES_SERVICE_TOKEN,
} from '@libs/code-review/domain/pullRequestMessages/contracts/pullRequestMessages.service.contract';
import { PullRequestMessagesEntity } from '@libs/code-review/domain/pullRequestMessages/entities/pullRequestMessages.entity';
import { deepDifference, deepMerge } from '@libs/common/utils/deep';
import { getDefaultKodusConfigFile } from '@libs/common/utils/validateCodeReviewConfigFile';
import {
    FormattedConfigLevel,
    IFormattedConfigProperty,
} from '@libs/core/infrastructure/config/types/general/codeReviewConfig.type';
import { ConfigLevel } from '@libs/core/infrastructure/config/types/general/pullRequestMessages.type';
import { DeepPartial } from 'typeorm';
import { UserRequest } from '@libs/core/infrastructure/config/types/http/user-request.type';
import {
    Action,
    ResourceType,
} from '@libs/identity/domain/permissions/enums/permissions.enum';
import {
    AUTHORIZATION_SERVICE_TOKEN,
    IAuthorizationService,
} from '@libs/identity/domain/permissions/contracts/authorization.service.contract';
import { FormattedCustomMessagesConfig } from './find-by-repo-or-directory.use-case';

type CustomMessagesConfig = ReturnType<
    typeof getDefaultKodusConfigFile
>['customMessages'];

type RepositoryMessages = {
    repository?: PullRequestMessagesEntity;
    directories: PullRequestMessagesEntity[];
};

@Injectable()
export class FindOverrideCountsByRepositoryPullRequestMessagesUseCase {
    private readonly logger = createLogger(
        FindOverrideCountsByRepositoryPullRequestMessagesUseCase.name,
    );

    constructor(
        @Inject(PULL_REQUEST_MESSAGES_SERVICE_TOKEN)
        private readonly pullRequestMessagesService: IPullRequestMessagesService,
        @Inject(AUTHORIZATION_SERVICE_TOKEN)
        private readonly authorizationService: IAuthorizationService,
    ) {}

    async execute(organizationId: string, repositoryId: string) {
        try {
            if (!organizationId) {
                throw new Error('Organization ID is required');
            }

            if (!repositoryId || repositoryId === 'global') {
                throw new Error('Repository ID is required');
            }

            const globalEntity = await this.pullRequestMessagesService.findOne({
                organizationId,
                configLevel: ConfigLevel.GLOBAL,
            });

            const repositoryEntity =
                await this.pullRequestMessagesService.findOne({
                    organizationId,
                    repositoryId,
                    configLevel: ConfigLevel.REPOSITORY,
                });

            const directoryEntities =
                await this.pullRequestMessagesService.find({
                    organizationId,
                    repositoryId,
                    configLevel: ConfigLevel.DIRECTORY,
                });

            return this.countForRepository(
                repositoryId,
                globalEntity,
                repositoryEntity,
                directoryEntities,
            );
        } catch (error) {
            this.logger.error({
                message:
                    'Error finding pull request messages override counts by repository',
                context:
                    FindOverrideCountsByRepositoryPullRequestMessagesUseCase.name,
                error,
                metadata: { organizationId, repositoryId },
            });

            throw error;
        }
    }

    async executeAll(user: UserRequest['user']) {
        const organizationId = user?.organization?.uuid;
        if (!organizationId) {
            throw new Error('Organization ID is required');
        }

        const allowedScope = await this.authorizationService.getRepositoryScope(
            {
                user,
                action: Action.Read,
                resource: ResourceType.CodeReviewSettings,
            },
        );
        const allowed = Array.isArray(allowedScope)
            ? new Set(allowedScope)
            : null;
        if (allowed?.size === 0) return [];

        // Read the organization's messages once, including the shared parent.
        // Repositories without message documents have no message overrides.
        const entities =
            (await this.pullRequestMessagesService.find({ organizationId })) ??
            [];
        const globalEntity = entities.find(
            (entity) => entity.configLevel === ConfigLevel.GLOBAL,
        );
        const repositories = new Map<string, RepositoryMessages>();
        for (const entity of entities) {
            const repositoryId = entity.repositoryId;
            if (
                entity.configLevel === ConfigLevel.GLOBAL ||
                !repositoryId ||
                repositoryId === 'global' ||
                (allowed && !allowed.has(repositoryId))
            )
                continue;
            const entry: RepositoryMessages = repositories.get(
                repositoryId,
            ) ?? { directories: [] };
            if (entity.configLevel === ConfigLevel.REPOSITORY) {
                entry.repository = entity;
            } else if (entity.configLevel === ConfigLevel.DIRECTORY) {
                entry.directories.push(entity);
            }
            repositories.set(repositoryId, entry);
        }
        return [...repositories].map(([repositoryId, entry]) =>
            this.countForRepository(
                repositoryId,
                globalEntity,
                entry.repository,
                entry.directories,
            ),
        );
    }

    private countForRepository(
        repositoryId: string,
        globalEntity: PullRequestMessagesEntity | null | undefined,
        repositoryEntity: PullRequestMessagesEntity | null | undefined,
        directoryEntities: PullRequestMessagesEntity[],
    ) {
        const { customMessages: defaultConfig } = getDefaultKodusConfigFile();
        const globalConfig = this.getConfigs(globalEntity);
        const repositoryConfig = this.getConfigs(repositoryEntity);
        const resolvedGlobalConfig = deepMerge(defaultConfig, globalConfig);
        const resolvedRepositoryConfig = deepMerge(
            resolvedGlobalConfig,
            repositoryConfig,
        );

        const globalDelta = deepDifference(defaultConfig, globalConfig);
        const repositoryDelta = deepDifference(
            resolvedGlobalConfig,
            repositoryConfig,
        );

        const formattedDefaultConfig = this.formatDefaultConfig(defaultConfig);
        const formattedGlobalConfig = this.formatLevel(
            formattedDefaultConfig,
            globalDelta,
            FormattedConfigLevel.GLOBAL,
        );
        const formattedRepositoryConfig = this.formatLevel(
            formattedGlobalConfig,
            repositoryDelta,
            FormattedConfigLevel.REPOSITORY,
        );

        const repositoryOverrideCount = this.countOverridesRecursive(
            formattedRepositoryConfig,
            FormattedConfigLevel.REPOSITORY,
        );

        const directoryOverrideCounts = (directoryEntities ?? []).map(
            (entity) => {
                const directoryConfig = this.getConfigs(entity);
                const directoryDelta = deepDifference(
                    resolvedRepositoryConfig,
                    directoryConfig,
                );

                const formattedDirectoryConfig = this.formatLevel(
                    formattedRepositoryConfig,
                    directoryDelta,
                    FormattedConfigLevel.DIRECTORY,
                );

                return {
                    directoryId: entity.directoryId,
                    overrideCount: this.countOverridesRecursive(
                        formattedDirectoryConfig,
                        FormattedConfigLevel.DIRECTORY,
                    ),
                };
            },
        );

        return {
            repositoryId,
            repositoryOverrideCount,
            directoryOverrideCounts,
        };
    }

    private getConfigs(entity: PullRequestMessagesEntity | null | undefined) {
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
            errorReviewMessage: {
                content: json?.errorReviewMessage?.content,
                status: json?.errorReviewMessage?.status,
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
            if (!Object.prototype.hasOwnProperty.call(config, key)) continue;

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
            if (!Object.prototype.hasOwnProperty.call(childDelta, key))
                continue;

            const childValue = childDelta[key];
            const parentNode = formattedParent[key];

            if (childValue === null || typeof childValue === 'undefined') {
                continue;
            }

            const isParentNodeLeaf = this.isFormattedConfigProperty(parentNode);
            const isParentNodeBranch =
                !!parentNode &&
                typeof parentNode === 'object' &&
                !isParentNodeLeaf;

            if (typeof childValue === 'object' && !Array.isArray(childValue)) {
                if (isParentNodeBranch) {
                    formattedChild[key] = this.formatLevel(
                        parentNode,
                        childValue as DeepPartial<CustomMessagesConfig>,
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

        return formattedChild;
    }

    private formatObjectAtLevel(
        config: object,
        level: FormattedConfigLevel,
    ): FormattedCustomMessagesConfig {
        const formatted = {};

        for (const key in config) {
            if (!Object.prototype.hasOwnProperty.call(config, key)) continue;

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

        return formatted as FormattedCustomMessagesConfig;
    }

    private isFormattedConfigProperty(
        value: any,
    ): value is IFormattedConfigProperty<any> {
        return (
            value &&
            typeof value === 'object' &&
            'value' in value &&
            'level' in value &&
            ('overriddenValue' in value || 'overriddenLevel' in value)
        );
    }

    private countOverridesRecursive(
        obj: any,
        targetLevel: FormattedConfigLevel,
    ): number {
        if (!obj || typeof obj !== 'object') {
            return 0;
        }

        if (this.isFormattedConfigProperty(obj)) {
            const hasOverride =
                obj.overriddenValue !== undefined ||
                obj.overriddenLevel !== undefined;

            if (!hasOverride) {
                return 0;
            }

            return obj.level === targetLevel ? 1 : 0;
        }

        let count = 0;
        for (const key in obj) {
            if (Object.prototype.hasOwnProperty.call(obj, key)) {
                count += this.countOverridesRecursive(obj[key], targetLevel);
            }
        }

        return count;
    }
}
