import { CreateOrUpdateParametersUseCase } from '@libs/organization/application/use-cases/parameters/create-or-update-use-case';
import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';

import { createLogger } from '@kodus/flow';
import {
    IParametersService,
    PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/parameters/contracts/parameters.service.contract';
import {
    IIntegrationConfigService,
    INTEGRATION_CONFIG_SERVICE_TOKEN,
} from '@libs/integrations/domain/integrationConfigs/contracts/integration-config.service.contracts';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AuditLogEvents } from '@libs/ee/codeReviewSettingsLog/events/audit-log.events';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { ParametersEntity } from '@libs/organization/domain/parameters/entities/parameters.entity';
import { IntegrationConfigKey, ParametersKey } from '@libs/core/domain/enums';
import { CodeReviewParameter } from '@libs/core/infrastructure/config/types/general/codeReviewConfig.type';
import {
    ActionType,
    ConfigLevel,
} from '@libs/core/infrastructure/config/types/general/codeReviewSettingsLog.type';

interface ICodeRepository {
    avatar_url?: string;
    default_branch: string;
    http_url: string;
    id: string;
    language: string;
    name: string;
    organizationName: string;
    selected: string;
    visibility: 'private' | 'public';
}

@Injectable()
export class UpdateCodeReviewParameterRepositoriesUseCase {
    private readonly logger = createLogger(
        UpdateCodeReviewParameterRepositoriesUseCase.name,
    );

    constructor(
        @Inject(PARAMETERS_SERVICE_TOKEN)
        private readonly parametersService: IParametersService,

        private readonly createOrUpdateParametersUseCase: CreateOrUpdateParametersUseCase,

        @Inject(INTEGRATION_CONFIG_SERVICE_TOKEN)
        private readonly integrationConfigService: IIntegrationConfigService,

        private readonly eventEmitter: EventEmitter2,

        @Inject(REQUEST)
        private readonly request: Request & {
            user: {
                organization: { uuid: string };
                uuid: string;
                email: string;
            };
        },
    ) {}

    async execute(body: {
        organizationAndTeamData: OrganizationAndTeamData;
        actor?: {
            source?: 'cli' | 'web' | 'sync';
            organizationId?: string;
            userId?: string;
            userEmail?: string;
        };
    }): Promise<ParametersEntity<ParametersKey.CODE_REVIEW_CONFIG> | boolean> {
        try {
            const { organizationAndTeamData } = body;

            const codeReviewConfigs = await this.parametersService.findByKey(
                ParametersKey.CODE_REVIEW_CONFIG,
                organizationAndTeamData,
            );

            if (!codeReviewConfigs) {
                return false;
            }

            const codeRepositories =
                await this.integrationConfigService.findIntegrationConfigFormatted<
                    ICodeRepository[]
                >(IntegrationConfigKey.REPOSITORIES, organizationAndTeamData);

            const filteredRepositories = codeRepositories.map((repository) => {
                return {
                    id: repository.id,
                    name: repository.name,
                    isSelected: true,
                    configs: {},
                    directories: [],
                };
            });

            const codeReviewRepositories =
                codeReviewConfigs.configValue.repositories;

            const commonRepositories = codeReviewRepositories.filter(
                (repository) =>
                    filteredRepositories.some(
                        (filteredRepo) => filteredRepo.id === repository.id,
                    ),
            );

            const codeReviewRepositoryIds = codeReviewRepositories.map(
                (repo) => repo.id,
            );

            const newRepositories = filteredRepositories.filter(
                (repository) =>
                    !codeReviewRepositoryIds.includes(repository.id),
            );

            const updatedRepositories = Array.from(
                new Map(
                    [...commonRepositories, ...newRepositories].map((repo) => [
                        repo.id,
                        repo,
                    ]),
                ).values(),
            );
            const updatedCodeReviewConfigValue = {
                ...codeReviewConfigs.configValue,
                repositories: updatedRepositories,
            } as CodeReviewParameter;

            const result = await this.createOrUpdateParametersUseCase.execute(
                ParametersKey.CODE_REVIEW_CONFIG,
                updatedCodeReviewConfigValue,
                organizationAndTeamData,
            );

            // Identificar repositories adicionados e removidos para o log
            const addedRepositories = newRepositories;
            const removedRepositories = codeReviewRepositories.filter(
                (repository) =>
                    !commonRepositories.some(
                        (commonRepo) => commonRepo.id === repository.id,
                    ),
            );

            try {
                const actor = this.resolveActor(body.actor);
                const hasChanges =
                    addedRepositories.length > 0 ||
                    removedRepositories.length > 0;

                if (actor && hasChanges) {
                    const actionType =
                        addedRepositories.length > 0 &&
                        removedRepositories.length > 0
                            ? ActionType.EDIT
                            : addedRepositories.length > 0
                              ? ActionType.ADD
                              : ActionType.DELETE;

                    this.eventEmitter.emit(AuditLogEvents.REPOSITORIES, {
                        organizationAndTeamData: {
                            ...body.organizationAndTeamData,
                            organizationId: actor.organizationId,
                        },
                        userInfo: {
                            userId: actor.userId,
                            userEmail: actor.userEmail,
                        },
                        actionType,
                        addedRepositories,
                        removedRepositories,
                        configLevel: ConfigLevel.GLOBAL,
                    });
                }
            } catch (error) {
                this.logger.error({
                    message:
                        'Error emitting audit log event for repository update',
                    error:
                        error instanceof Error
                            ? error
                            : new Error(String(error)),
                    context: UpdateCodeReviewParameterRepositoriesUseCase.name,
                });
            }

            return result;
        } catch (error) {
            if (error instanceof ForbiddenException) {
                throw error;
            }

            this.logger.error({
                message:
                    'Error creating or updating code review parameter repositories',
                context: UpdateCodeReviewParameterRepositoriesUseCase.name,
                error:
                    error instanceof Error ? error : new Error(String(error)),
                metadata: {
                    parametersKey: ParametersKey.CODE_REVIEW_CONFIG,
                    organizationAndTeamData: body.organizationAndTeamData,
                },
            });
            throw new Error('Error creating or updating parameters', {
                cause: error,
            });
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

    private resolveActor(actor?: {
        source?: 'cli' | 'web' | 'sync';
        organizationId?: string;
        userId?: string;
        userEmail?: string;
    }) {
        if (actor?.source === 'cli') {
            const organizationId =
                actor.organizationId ?? this.request?.user?.organization?.uuid;

            if (!organizationId) {
                return null;
            }

            return {
                organizationId,
                userId: actor.userId ?? 'cli-key',
                userEmail: actor.userEmail ?? 'CLI key',
            };
        }

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
