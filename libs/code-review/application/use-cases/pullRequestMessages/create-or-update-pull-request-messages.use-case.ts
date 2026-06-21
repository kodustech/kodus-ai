import { Inject, Injectable } from '@nestjs/common';

import { EventEmitter2 } from '@nestjs/event-emitter';
import {
    CentralizedConfigPrService,
    CentralizedPrMetadata,
} from '@libs/centralized-config/infrastructure/adapters/services/centralized-config-pr.service';
import { AuditLogEvents } from '@libs/ee/codeReviewSettingsLog/events/audit-log.events';
import { PullRequestMessagesLogParams } from '@libs/ee/codeReviewSettingsLog/infrastructure/adapters/services/pullRequestMessageLog.handler';
import { CodeReviewParameter } from '@libs/core/infrastructure/config/types/general/codeReviewConfig.type';
import {
    IPullRequestMessagesService,
    PULL_REQUEST_MESSAGES_SERVICE_TOKEN,
} from '@libs/code-review/domain/pullRequestMessages/contracts/pullRequestMessages.service.contract';
import { IPullRequestMessages } from '@libs/code-review/domain/pullRequestMessages/interfaces/pullRequestMessages.interface';

import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import { ActionType } from '@libs/core/infrastructure/config/types/general/codeReviewSettingsLog.type';
import { ConfigLevel } from '@libs/core/infrastructure/config/types/general/pullRequestMessages.type';
import { getDefaultKodusConfigFile } from '@libs/common/utils/validateCodeReviewConfigFile';
import {
    Action,
    ResourceType,
} from '@libs/identity/domain/permissions/enums/permissions.enum';
import { IUser } from '@libs/identity/domain/user/interfaces/user.interface';
import { AuthorizationService } from '@libs/identity/infrastructure/adapters/services/permissions/authorization.service';
import {
    CONTEXT_RESOLUTION_SERVICE_TOKEN,
    IContextResolutionService,
} from '@libs/core/context-resolution/domain/contracts/context-resolution.service.contract';
import { ParametersKey } from '@libs/core/domain/enums';
import {
    IParametersService,
    PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/parameters/contracts/parameters.service.contract';
import { createLogger } from '@kodus/flow';
import { buildKodusConfigCentralizedMutationRequest } from '@libs/centralized-config/utils/kodus-config-centralized-pr.builder';

@Injectable()
export class CreateOrUpdatePullRequestMessagesUseCase implements IUseCase {
    private readonly logger = createLogger(
        CreateOrUpdatePullRequestMessagesUseCase.name,
    );

    constructor(
        @Inject(PULL_REQUEST_MESSAGES_SERVICE_TOKEN)
        private readonly pullRequestMessagesService: IPullRequestMessagesService,

        private readonly eventEmitter: EventEmitter2,

        @Inject(CONTEXT_RESOLUTION_SERVICE_TOKEN)
        private readonly contextResolutionService: IContextResolutionService,

        @Inject(PARAMETERS_SERVICE_TOKEN)
        private readonly parametersService: IParametersService,

        private readonly authorizationService: AuthorizationService,
        private readonly centralizedConfigPrService: CentralizedConfigPrService,
    ) {}

    async execute(
        userInfo: Partial<IUser>,
        pullRequestMessages: IPullRequestMessages,
        options?: {
            skipAuthorization?: boolean;
            teamId?: string;
            skipCentralizedPr?: boolean;
        },
    ): Promise<void | CentralizedPrMetadata> {
        if (!userInfo?.organization?.uuid) {
            throw new Error('Organization ID is required in user info');
        }

        const organizationId = userInfo.organization.uuid;

        if (!options?.skipAuthorization) {
            this.authorizationService.ensure({
                user: userInfo,
                action: Action.Create,
                resource: ResourceType.CodeReviewSettings,
                repoIds: [pullRequestMessages.repositoryId || 'global'],
            });
        }

        pullRequestMessages.organizationId = userInfo?.organization?.uuid;

        if (pullRequestMessages?.configLevel === ConfigLevel.GLOBAL) {
            pullRequestMessages.repositoryId = 'global';
        }

        const teamId = await this.resolveTeamIdForMutation({
            organizationId,
            repositoryId: pullRequestMessages.repositoryId,
            preferredTeamId: options?.teamId,
        });

        const shouldAttemptCentralizedMutation =
            !options?.skipCentralizedPr && Boolean(teamId);

        const existingPullRequestMessage = await this.findExistingConfiguration(
            pullRequestMessages.organizationId,
            pullRequestMessages.configLevel,
            pullRequestMessages.repositoryId,
            pullRequestMessages.directoryId,
        );

        const isUpdate = !!existingPullRequestMessage;

        // For non-global configurations, check if content matches global/parent config.
        if (pullRequestMessages.configLevel !== ConfigLevel.GLOBAL) {
            const shouldInherit =
                await this.shouldInheritFromParent(pullRequestMessages);

            const centralizedPr = shouldAttemptCentralizedMutation
                ? await this.createCentralizedMutationIfEnabled({
                      organizationId,
                      teamId,
                      pullRequestMessages,
                      shouldInherit,
                  })
                : null;

            if (centralizedPr) {
                return centralizedPr;
            }

            if (shouldInherit && existingPullRequestMessage) {
                await this.pullRequestMessagesService.deleteByFilter({
                    organizationId: pullRequestMessages.organizationId,
                    repositoryId: pullRequestMessages.repositoryId,
                    directoryId: pullRequestMessages.directoryId,
                    configLevel: pullRequestMessages.configLevel,
                });

                this.logger.log({
                    message:
                        'Deleted repository/directory configuration to inherit from parent',
                    context: CreateOrUpdatePullRequestMessagesUseCase.name,
                    metadata: {
                        organizationId: pullRequestMessages.organizationId,
                        configLevel: pullRequestMessages.configLevel,
                        repositoryId: pullRequestMessages.repositoryId,
                        directoryId: pullRequestMessages.directoryId,
                    },
                });
                return;
            }

            if (shouldInherit && !existingPullRequestMessage) {
                this.logger.log({
                    message:
                        'Configuration matches parent, no action needed - inheriting',
                    context: CreateOrUpdatePullRequestMessagesUseCase.name,
                    metadata: {
                        organizationId: pullRequestMessages.organizationId,
                        configLevel: pullRequestMessages.configLevel,
                        repositoryId: pullRequestMessages.repositoryId,
                        directoryId: pullRequestMessages.directoryId,
                    },
                });
                return;
            }
        } else {
            const centralizedPr = shouldAttemptCentralizedMutation
                ? await this.createCentralizedMutationIfEnabled({
                      organizationId,
                      teamId,
                      pullRequestMessages,
                      shouldInherit: false,
                  })
                : null;

            if (centralizedPr) {
                return centralizedPr;
            }
        }

        if (isUpdate) {
            // Repository update is id-based and requires the existing entity uuid.
            pullRequestMessages.uuid = existingPullRequestMessage.uuid;
            await this.pullRequestMessagesService.update(pullRequestMessages);
        } else {
            await this.pullRequestMessagesService.create(pullRequestMessages);
        }

        const logParams: PullRequestMessagesLogParams = {
            organizationAndTeamData: {
                organizationId: pullRequestMessages.organizationId,
            },
            userInfo: {
                userId: userInfo?.uuid,
                userEmail: userInfo?.email,
            },
            actionType: ActionType.EDIT,
            configLevel: pullRequestMessages.configLevel,
            repositoryId: pullRequestMessages.repositoryId,
            directoryId: pullRequestMessages.directoryId,
            startReviewMessage: pullRequestMessages.startReviewMessage,
            endReviewMessage: pullRequestMessages.endReviewMessage,
            existingStartMessage:
                existingPullRequestMessage?.startReviewMessage,
            existingEndMessage: existingPullRequestMessage?.endReviewMessage,
            globalSettings: pullRequestMessages.globalSettings,
            existingGlobalSettings: existingPullRequestMessage?.globalSettings,
            directoryPath:
                (await this.contextResolutionService.getDirectoryPathByOrganizationAndRepository(
                    pullRequestMessages.organizationId,
                    pullRequestMessages.repositoryId,
                    pullRequestMessages.directoryId,
                )) || '',
            isUpdate,
        };
        this.eventEmitter.emit(AuditLogEvents.PR_MESSAGES, logParams);
    }

    private async createCentralizedMutationIfEnabled(params: {
        organizationId: string;
        teamId: string;
        pullRequestMessages: IPullRequestMessages;
        shouldInherit: boolean;
    }): Promise<CentralizedPrMetadata | null> {
        const { organizationId, teamId, pullRequestMessages, shouldInherit } =
            params;

        const parameter = await this.parametersService.findByKey(
            ParametersKey.CODE_REVIEW_CONFIG,
            {
                organizationId,
                teamId,
            },
        );

        const scopeConfig = this.extractScopeConfig(
            parameter?.configValue,
            pullRequestMessages.repositoryId,
            pullRequestMessages.directoryId,
            pullRequestMessages.configLevel,
        );

        const parentCustomMessages = await this.getResolvedParentConfig(
            organizationId,
            pullRequestMessages.configLevel,
            pullRequestMessages.repositoryId,
            pullRequestMessages.directoryId,
        );

        const resolvedNextCustomMessages = this.mergeConfigs(
            parentCustomMessages,
            {
                startReviewMessage: pullRequestMessages.startReviewMessage,
                endReviewMessage: pullRequestMessages.endReviewMessage,
                globalSettings: pullRequestMessages.globalSettings,
            },
        );

        const customMessagesDelta = shouldInherit
            ? null
            : this.buildCustomMessagesDelta(
                  parentCustomMessages,
                  resolvedNextCustomMessages,
              );

        const configFileContent: Record<string, any> = {
            ...(scopeConfig || {}),
        };

        if (shouldInherit) {
            delete configFileContent.customMessages;
        } else if (
            customMessagesDelta &&
            (customMessagesDelta.startReviewMessage ||
                customMessagesDelta.endReviewMessage ||
                customMessagesDelta.globalSettings)
        ) {
            configFileContent.customMessages = customMessagesDelta;
        }

        const directoryPath =
            pullRequestMessages.configLevel === ConfigLevel.DIRECTORY
                ? await this.contextResolutionService.getDirectoryPathByOrganizationAndRepository(
                      organizationId,
                      pullRequestMessages.repositoryId,
                      pullRequestMessages.directoryId,
                  )
                : undefined;

        let directoryFolders:
            | Array<{ id?: string; name?: string; path: string }>
            | undefined;
        if (
            pullRequestMessages.configLevel === ConfigLevel.DIRECTORY &&
            pullRequestMessages.directoryId
        ) {
            const codeReviewParam = await this.parametersService.findByKey(
                ParametersKey.CODE_REVIEW_CONFIG,
                { organizationId, teamId },
            );
            const repo = (
                codeReviewParam?.configValue?.repositories ?? []
            ).find((r) => r.id === pullRequestMessages.repositoryId);
            const dir = (repo?.directories ?? []).find(
                (d) => d.id === pullRequestMessages.directoryId,
            );
            if (dir?.folders && dir.folders.length > 0) {
                directoryFolders = dir.folders;
            }
        }

        const pr =
            await this.centralizedConfigPrService.createMutationPullRequestIfEnabled(
                buildKodusConfigCentralizedMutationRequest({
                    centralizedConfigPrService: this.centralizedConfigPrService,
                    organizationAndTeamData: {
                        organizationId,
                        teamId,
                    },
                    repositoryId:
                        pullRequestMessages.configLevel === ConfigLevel.GLOBAL
                            ? undefined
                            : pullRequestMessages.repositoryId,
                    directoryPath: directoryFolders
                        ? undefined
                        : directoryPath || undefined,
                    folders: directoryFolders,
                    configFileContent:
                        Object.keys(configFileContent).length > 0
                            ? configFileContent
                            : null,
                    title: `Update custom messages for ${pullRequestMessages.repositoryId || 'global'}${directoryPath ? ` (${directoryPath})` : ''}`,
                    description:
                        'This pull request proposes a custom messages change in centralized config mode.',
                    commitMessage: `update custom messages for ${pullRequestMessages.repositoryId || 'global'}`,
                    sourceBranchPrefix:
                        'kodus-centralized-config-custom-messages',
                    centralizedModeMessage:
                        'Centralized config is enabled. Custom messages change proposed through a pull request.',
                }),
            );

        if (pr.mode !== 'centralized-pr') {
            return null;
        }

        return pr;
    }

    private buildCustomMessagesDelta(
        parentConfig: IPullRequestMessages,
        nextConfig: IPullRequestMessages,
    ): {
        startReviewMessage?: IPullRequestMessages['startReviewMessage'];
        endReviewMessage?: IPullRequestMessages['endReviewMessage'];
        globalSettings?: Partial<
            NonNullable<IPullRequestMessages['globalSettings']>
        >;
    } | null {
        const delta: {
            startReviewMessage?: IPullRequestMessages['startReviewMessage'];
            endReviewMessage?: IPullRequestMessages['endReviewMessage'];
            globalSettings?: Partial<
                NonNullable<IPullRequestMessages['globalSettings']>
            >;
        } = {};

        if (
            !this.areMessagesEqual(
                nextConfig.startReviewMessage,
                parentConfig.startReviewMessage,
            )
        ) {
            delta.startReviewMessage = nextConfig.startReviewMessage;
        }

        if (
            !this.areMessagesEqual(
                nextConfig.endReviewMessage,
                parentConfig.endReviewMessage,
            )
        ) {
            delta.endReviewMessage = nextConfig.endReviewMessage;
        }

        const globalSettingsDelta: Partial<
            NonNullable<IPullRequestMessages['globalSettings']>
        > = {};

        if (
            nextConfig.globalSettings?.hideComments !==
            parentConfig.globalSettings?.hideComments
        ) {
            globalSettingsDelta.hideComments =
                nextConfig.globalSettings?.hideComments;
        }

        if (
            nextConfig.globalSettings?.suggestionCopyPrompt !==
            parentConfig.globalSettings?.suggestionCopyPrompt
        ) {
            globalSettingsDelta.suggestionCopyPrompt =
                nextConfig.globalSettings?.suggestionCopyPrompt;
        }

        if (Object.keys(globalSettingsDelta).length > 0) {
            delta.globalSettings = globalSettingsDelta;
        }

        return Object.keys(delta).length > 0 ? delta : null;
    }

    private async resolveTeamIdForMutation(params: {
        organizationId: string;
        repositoryId?: string;
        preferredTeamId?: string;
    }): Promise<string | undefined> {
        if (params.preferredTeamId) {
            return params.preferredTeamId;
        }

        if (!params.repositoryId || params.repositoryId === 'global') {
            return undefined;
        }

        try {
            return await this.contextResolutionService.getTeamIdByOrganizationAndRepository(
                params.organizationId,
                params.repositoryId,
            );
        } catch (error) {
            this.logger.warn({
                message:
                    'Unable to resolve teamId for custom messages centralized mutation',
                context: CreateOrUpdatePullRequestMessagesUseCase.name,
                error: this.normalizeError(error),
                metadata: {
                    organizationId: params.organizationId,
                    repositoryId: params.repositoryId,
                },
            });

            return undefined;
        }
    }

    private extractScopeConfig(
        codeReviewConfig: CodeReviewParameter | undefined,
        repositoryId: string | undefined,
        directoryId: string | undefined,
        configLevel: ConfigLevel,
    ): Record<string, any> {
        if (!codeReviewConfig) {
            return {};
        }

        if (configLevel === ConfigLevel.GLOBAL) {
            return codeReviewConfig.configs || {};
        }

        const repository = codeReviewConfig.repositories?.find(
            (repo) => repo.id === repositoryId,
        );

        if (!repository) {
            return {};
        }

        if (configLevel === ConfigLevel.REPOSITORY) {
            return repository.configs || {};
        }

        const directory = repository.directories?.find(
            (dir) => dir.id === directoryId,
        );

        return directory?.configs || {};
    }

    private async findExistingConfiguration(
        organizationId: string,
        configLevel: ConfigLevel,
        repositoryId?: string,
        directoryId?: string,
    ): Promise<IPullRequestMessages | null> {
        const searchCriteria: any = {
            organizationId,
            configLevel,
        };

        if (
            repositoryId &&
            (configLevel === ConfigLevel.REPOSITORY ||
                configLevel === ConfigLevel.DIRECTORY)
        ) {
            searchCriteria.repositoryId = repositoryId;
        }

        if (configLevel === ConfigLevel.DIRECTORY && directoryId) {
            searchCriteria.directoryId = directoryId;
        }

        return await this.pullRequestMessagesService.findOne(searchCriteria);
    }

    private async shouldInheritFromParent(
        pullRequestMessages: IPullRequestMessages,
    ): Promise<boolean> {
        try {
            const parentConfig = await this.getResolvedParentConfig(
                pullRequestMessages.organizationId,
                pullRequestMessages.configLevel,
                pullRequestMessages.repositoryId,
                pullRequestMessages.directoryId,
            );

            return this.areConfigurationsEqual(
                pullRequestMessages,
                parentConfig,
            );
        } catch (error) {
            this.logger.error({
                message: 'Error checking if should inherit from parent',
                context: CreateOrUpdatePullRequestMessagesUseCase.name,
                error: this.normalizeError(error),
                metadata: {
                    organizationId: pullRequestMessages.organizationId,
                    configLevel: pullRequestMessages.configLevel,
                    repositoryId: pullRequestMessages.repositoryId,
                    directoryId: pullRequestMessages.directoryId,
                },
            });
            return false;
        }
    }

    private normalizeError(error: unknown): Error {
        return error instanceof Error ? error : new Error(String(error));
    }

    private async getResolvedParentConfig(
        organizationId: string,
        configLevel: ConfigLevel,
        repositoryId?: string,
        _directoryId?: string,
    ): Promise<IPullRequestMessages> {
        const { customMessages: defaultConfig } = getDefaultKodusConfigFile();

        // Get global configuration
        const globalEntity = await this.pullRequestMessagesService.findOne({
            organizationId,
            configLevel: ConfigLevel.GLOBAL,
        });
        const globalConfig = this.extractConfig(globalEntity);

        if (configLevel === ConfigLevel.REPOSITORY) {
            // For repository level, parent is global (or default if no global)
            return this.mergeConfigs(defaultConfig, globalConfig);
        }

        if (configLevel === ConfigLevel.DIRECTORY) {
            // For directory level, get repository config and merge hierarchy
            const repoEntity = await this.pullRequestMessagesService.findOne({
                organizationId,
                repositoryId,
                configLevel: ConfigLevel.REPOSITORY,
            });
            const repoConfig = this.extractConfig(repoEntity);

            // Merge: default -> global -> repo
            const merged = this.mergeConfigs(defaultConfig, globalConfig);
            return this.mergeConfigs(merged, repoConfig);
        }

        return this.normalizeConfig(defaultConfig);
    }

    private mergeConfigs(
        baseConfig: any,
        overrideConfig: Partial<IPullRequestMessages>,
    ): IPullRequestMessages {
        return {
            startReviewMessage:
                overrideConfig.startReviewMessage ||
                baseConfig.startReviewMessage,
            endReviewMessage:
                overrideConfig.endReviewMessage || baseConfig.endReviewMessage,
            globalSettings: {
                hideComments:
                    overrideConfig.globalSettings?.hideComments ??
                    baseConfig.globalSettings?.hideComments ??
                    false,
                suggestionCopyPrompt:
                    overrideConfig.globalSettings?.suggestionCopyPrompt ??
                    baseConfig.globalSettings?.suggestionCopyPrompt ??
                    true,
            },
        } as IPullRequestMessages;
    }

    private normalizeConfig(config: any): IPullRequestMessages {
        return {
            startReviewMessage: config.startReviewMessage,
            endReviewMessage: config.endReviewMessage,
            globalSettings: config.globalSettings || {
                hideComments: false,
                suggestionCopyPrompt: true,
            },
        } as IPullRequestMessages;
    }

    private extractConfig(entity: any): Partial<IPullRequestMessages> {
        if (!entity) {
            return {};
        }

        const json = entity.toJson ? entity.toJson() : entity;
        return {
            startReviewMessage: json?.startReviewMessage,
            endReviewMessage: json?.endReviewMessage,
            globalSettings: json?.globalSettings,
        };
    }

    private areConfigurationsEqual(
        config1: IPullRequestMessages,
        config2: IPullRequestMessages,
    ): boolean {
        // Compare startReviewMessage
        if (
            !this.areMessagesEqual(
                config1.startReviewMessage,
                config2.startReviewMessage,
            )
        ) {
            return false;
        }

        // Compare endReviewMessage
        if (
            !this.areMessagesEqual(
                config1.endReviewMessage,
                config2.endReviewMessage,
            )
        ) {
            return false;
        }

        // Compare globalSettings
        if (
            !this.areGlobalSettingsEqual(
                config1.globalSettings,
                config2.globalSettings,
            )
        ) {
            return false;
        }

        return true;
    }

    private areMessagesEqual(message1: any, message2: any): boolean {
        // Handle null/undefined cases
        if (!message1 && !message2) return true;
        if (!message1 || !message2) return false;

        return (
            message1.content === message2.content &&
            message1.status === message2.status
        );
    }

    private areGlobalSettingsEqual(settings1: any, settings2: any): boolean {
        // Handle null/undefined cases
        if (!settings1 && !settings2) return true;
        if (!settings1 || !settings2) return false;

        return (
            settings1.hideComments === settings2.hideComments &&
            settings1.suggestionCopyPrompt === settings2.suggestionCopyPrompt
        );
    }
}
