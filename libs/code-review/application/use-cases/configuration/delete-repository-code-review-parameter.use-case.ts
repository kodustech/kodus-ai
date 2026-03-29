import { CreateOrUpdateParametersUseCase } from '@libs/organization/application/use-cases/parameters/create-or-update-use-case';
import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { produce } from 'immer';

import { createLogger } from '@kodus/flow';
import { DeleteByRepositoryOrDirectoryPullRequestMessagesUseCase } from '@libs/code-review/application/use-cases/pullRequestMessages/delete-by-repository-or-directory.use-case';
import { ParametersKey } from '@libs/core/domain/enums';
import { CodeReviewParameter } from '@libs/core/infrastructure/config/types/general/codeReviewConfig.type';
import { ActionType } from '@libs/core/infrastructure/config/types/general/codeReviewSettingsLog.type';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { UserRequest } from '@libs/core/infrastructure/config/types/http/user-request.type';
import { RepositoryWithDirectoriesException } from '@libs/core/infrastructure/filters';
import { AuditLogEvents } from '@libs/ee/codeReviewSettingsLog/events/audit-log.events';
import {
    IKodyRulesService,
    KODY_RULES_SERVICE_TOKEN,
} from '@libs/kodyRules/domain/contracts/kodyRules.service.contract';
import { KodyRulesStatus } from '@libs/kodyRules/domain/interfaces/kodyRules.interface';
import {
    IParametersService,
    PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/parameters/contracts/parameters.service.contract';
import { ParametersEntity } from '@libs/organization/domain/parameters/entities/parameters.entity';
import { DeleteRepositoryCodeReviewParameterDto } from '@libs/organization/dtos/delete-repository-code-review-parameter.dto';
import { EventEmitter2 } from '@nestjs/event-emitter';

@Injectable()
export class DeleteRepositoryCodeReviewParameterUseCase {
    private readonly logger = createLogger(
        DeleteRepositoryCodeReviewParameterUseCase.name,
    );
    constructor(
        @Inject(PARAMETERS_SERVICE_TOKEN)
        private readonly parametersService: IParametersService,

        private readonly createOrUpdateParametersUseCase: CreateOrUpdateParametersUseCase,

        private readonly eventEmitter: EventEmitter2,

        private readonly deletePullRequestMessagesUseCase: DeleteByRepositoryOrDirectoryPullRequestMessagesUseCase,

        @Inject(KODY_RULES_SERVICE_TOKEN)
        private readonly kodyRulesService: IKodyRulesService,

        @Inject(REQUEST)
        private readonly request: UserRequest,
    ) {}

    async execute(
        body: DeleteRepositoryCodeReviewParameterDto & {
            organizationAndTeamData?: OrganizationAndTeamData;
            actor?: {
                source?: 'cli' | 'web' | 'sync';
                organizationId?: string;
                userId?: string;
                userEmail?: string;
            };
        },
    ): Promise<ParametersEntity<ParametersKey.CODE_REVIEW_CONFIG> | boolean> {
        const { teamId, repositoryId, directoryId } = body;

        try {
            const organizationId =
                body.organizationAndTeamData?.organizationId ??
                body.actor?.organizationId ??
                this.request?.user?.organization?.uuid;

            if (!organizationId) {
                throw new Error('Organization ID not found');
            }

            const organizationAndTeamData: OrganizationAndTeamData = {
                organizationId,
                teamId: body.organizationAndTeamData?.teamId ?? teamId,
            };

            await this.ensureManualChangesAllowed(
                organizationAndTeamData,
                body.actor?.source,
            );

            const codeReviewConfigParam =
                await this.parametersService.findByKey(
                    ParametersKey.CODE_REVIEW_CONFIG,
                    organizationAndTeamData,
                );

            if (!codeReviewConfigParam || !codeReviewConfigParam.configValue) {
                throw new Error('Code review config not found');
            }

            const codeReviewConfig = codeReviewConfigParam.configValue;
            let result:
                | ParametersEntity<ParametersKey.CODE_REVIEW_CONFIG>
                | boolean;

            if (repositoryId && directoryId) {
                result = await this.deleteDirectoryConfig(
                    organizationAndTeamData,
                    codeReviewConfig,
                    repositoryId,
                    directoryId,
                    body.actor,
                );
            } else if (repositoryId) {
                result = await this.deleteRepositoryConfig(
                    organizationAndTeamData,
                    codeReviewConfig,
                    repositoryId,
                    body.actor,
                );
            } else {
                throw new Error('RepositoryId is required');
            }

            return result;
        } catch (error) {
            this.logger.error({
                message: 'Could not delete code review configuration',
                context: DeleteRepositoryCodeReviewParameterUseCase.name,
                error: error,
                metadata: { body },
            });
            throw error;
        }
    }

    private async ensureManualChangesAllowed(
        organizationAndTeamData: OrganizationAndTeamData,
        source?: 'cli' | 'web' | 'sync',
    ): Promise<void> {
        if (source === 'sync') {
            return;
        }

        const centralizedConfig = await this.parametersService.findByKey(
            ParametersKey.CENTRALIZED_CONFIG,
            organizationAndTeamData,
        );

        if (centralizedConfig?.configValue?.enabled === true) {
            throw new ForbiddenException(
                'Code review settings are locked while centralized configuration is enabled.',
            );
        }
    }

    private async deleteRepositoryConfig(
        organizationAndTeamData: OrganizationAndTeamData,
        currentConfig: CodeReviewParameter,
        repositoryId: string,
        actor?: {
            source?: 'cli' | 'web' | 'sync';
            organizationId?: string;
            userId?: string;
            userEmail?: string;
        },
    ) {
        const repositoryIndex = currentConfig.repositories.findIndex(
            (repo) => repo.id === repositoryId,
        );

        if (repositoryIndex === -1) {
            throw new Error('Repository not found in configuration');
        }

        const repositoryToRemove = currentConfig.repositories[repositoryIndex];

        if (repositoryToRemove.directories?.length > 0) {
            throw new RepositoryWithDirectoriesException();
        }

        const updatedConfig = produce(currentConfig, (draft) => {
            const repo = draft.repositories[repositoryIndex];
            repo.configs = {};
            repo.isSelected = false;
        });

        const updated = await this.createOrUpdateParametersUseCase.execute(
            ParametersKey.CODE_REVIEW_CONFIG,
            updatedConfig,
            organizationAndTeamData,
        );

        this.logger.log({
            message: 'Repository configuration reset successfully',
            context: DeleteRepositoryCodeReviewParameterUseCase.name,
            metadata: { repositoryId, organizationAndTeamData },
        });

        await this.handleRepositorySideEffects(
            organizationAndTeamData,
            repositoryToRemove,
            actor,
        );

        return updated;
    }

    private async deleteDirectoryConfig(
        organizationAndTeamData: OrganizationAndTeamData,
        currentConfig: CodeReviewParameter,
        repositoryId: string,
        directoryId: string,
        actor?: {
            source?: 'cli' | 'web' | 'sync';
            organizationId?: string;
            userId?: string;
            userEmail?: string;
        },
    ) {
        const repositoryIndex = currentConfig.repositories.findIndex(
            (repo) => repo.id === repositoryId,
        );
        if (repositoryIndex === -1) {
            throw new Error('Repository not found in configuration');
        }

        const repository = currentConfig.repositories[repositoryIndex];
        const directoryIndex = repository.directories?.findIndex(
            (dir) => dir.id === directoryId,
        );

        if (directoryIndex === undefined || directoryIndex === -1) {
            throw new Error('Directory not found in configuration');
        }

        const directoryToRemove = repository.directories[directoryIndex];

        const updatedConfig = produce(currentConfig, (draft) => {
            const repo = draft.repositories[repositoryIndex];
            repo.directories.splice(directoryIndex, 1);

            if (
                repo.directories.length === 0 &&
                (!repo.configs || Object.keys(repo.configs).length === 0)
            ) {
                repo.isSelected = false;
            }
        });

        const updated = await this.createOrUpdateParametersUseCase.execute(
            ParametersKey.CODE_REVIEW_CONFIG,
            updatedConfig,
            organizationAndTeamData,
        );

        this.logger.log({
            message:
                'Directory removed from repository configuration successfully',
            context: DeleteRepositoryCodeReviewParameterUseCase.name,
            metadata: { repositoryId, directoryId, organizationAndTeamData },
        });

        await this.handleDirectorySideEffects(
            organizationAndTeamData,
            repository,
            directoryToRemove,
            actor,
        );

        return updated;
    }

    private async handleRepositorySideEffects(
        orgData: OrganizationAndTeamData,
        repository: { id: string; name: string },
        actor?: {
            source?: 'cli' | 'web' | 'sync';
            organizationId?: string;
            userId?: string;
            userEmail?: string;
        },
    ) {
        await this.deletePullRequestMessagesUseCase.execute({
            organizationId: orgData.organizationId,
            repositoryId: repository.id,
        });

        await this.kodyRulesService.updateRulesStatusByFilter(
            orgData.organizationId,
            repository.id,
            undefined,
            KodyRulesStatus.DELETED,
        );

        const resolvedActor = this.resolveActor(actor);
        if (!resolvedActor) {
            return;
        }

        this.eventEmitter.emit(AuditLogEvents.REPOSITORY_CONFIG_REMOVAL, {
            organizationAndTeamData: orgData,
            userInfo: {
                userId: resolvedActor.userId,
                userEmail: resolvedActor.userEmail,
            },
            repository,
            actionType: ActionType.DELETE,
        });
    }

    private async handleDirectorySideEffects(
        orgData: OrganizationAndTeamData,
        repository: { id: string; name: string },
        directory: { id: string; path: string },
        actor?: {
            source?: 'cli' | 'web' | 'sync';
            organizationId?: string;
            userId?: string;
            userEmail?: string;
        },
    ) {
        await this.deletePullRequestMessagesUseCase.execute({
            organizationId: orgData.organizationId,
            repositoryId: repository.id,
            directoryId: directory.id,
        });

        await this.kodyRulesService.updateRulesStatusByFilter(
            orgData.organizationId,
            repository.id,
            directory.id,
            KodyRulesStatus.DELETED,
        );

        const resolvedActor = this.resolveActor(actor);
        if (!resolvedActor) {
            return;
        }

        this.eventEmitter.emit(AuditLogEvents.DIRECTORY_CONFIG_REMOVAL, {
            organizationAndTeamData: orgData,
            userInfo: {
                userId: resolvedActor.userId,
                userEmail: resolvedActor.userEmail,
            },
            repository,
            directory,
            actionType: ActionType.DELETE,
        });
    }

    private resolveActor(actor?: {
        source?: 'cli' | 'web' | 'sync';
        organizationId?: string;
        userId?: string;
        userEmail?: string;
    }) {
        const resolvedActor = actor ?? {
            organizationId: this.request?.user?.organization?.uuid,
            userId: this.request?.user?.uuid,
            userEmail: this.request?.user?.email,
        };

        if (
            !resolvedActor.organizationId ||
            !resolvedActor.userId ||
            !resolvedActor.userEmail
        ) {
            return null;
        }

        return resolvedActor;
    }
}
