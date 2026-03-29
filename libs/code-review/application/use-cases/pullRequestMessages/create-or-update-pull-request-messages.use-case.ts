import { Inject, Injectable } from '@nestjs/common';

import { EventEmitter2 } from '@nestjs/event-emitter';
import { AuditLogEvents } from '@libs/ee/codeReviewSettingsLog/events/audit-log.events';
import { PullRequestMessagesLogParams } from '@libs/ee/codeReviewSettingsLog/infrastructure/adapters/services/pullRequestMessageLog.handler';
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
import { createLogger } from '@kodus/flow';

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

        private readonly authorizationService: AuthorizationService,
    ) {}

    async execute(
        userInfo: Partial<IUser>,
        pullRequestMessages: IPullRequestMessages,
    ): Promise<void> {
        if (!userInfo?.organization?.uuid) {
            throw new Error('Organization ID is required in user info');
        }

        this.authorizationService.ensure({
            user: userInfo,
            action: Action.Create,
            resource: ResourceType.CodeReviewSettings,
            repoIds: [pullRequestMessages.repositoryId || 'global'],
        });

        pullRequestMessages.organizationId = userInfo?.organization?.uuid;

        if (pullRequestMessages?.configLevel === ConfigLevel.GLOBAL) {
            pullRequestMessages.repositoryId = 'global';
        }

        const existingPullRequestMessage = await this.findExistingConfiguration(
            pullRequestMessages.organizationId,
            pullRequestMessages.configLevel,
            pullRequestMessages.repositoryId,
            pullRequestMessages.directoryId,
        );

        const isUpdate = !!existingPullRequestMessage;

        // For non-global configurations, check if content matches global/parent config
        // If it does, delete the specific config to inherit instead of creating/updating
        if (pullRequestMessages.configLevel !== ConfigLevel.GLOBAL) {
            const shouldInherit =
                await this.shouldInheritFromParent(pullRequestMessages);

            if (shouldInherit && existingPullRequestMessage) {
                // Delete existing configuration to inherit from parent
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
                // No need to create config if it matches parent - just inherit
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
        }

        if (isUpdate) {
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
                error,
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

    private async getResolvedParentConfig(
        organizationId: string,
        configLevel: ConfigLevel,
        repositoryId?: string,
        directoryId?: string,
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
