import { createLogger } from '@kodus/flow';
import { Inject, Injectable } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';

import { EventEmitter2 } from '@nestjs/event-emitter';
import { IntegrationConfigKey } from '@libs/core/domain/enums/Integration-config-key.enum';
import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import {
    IPermissionsService,
    PERMISSIONS_SERVICE_TOKEN,
} from '@libs/identity/domain/permissions/contracts/permissions.service.contract';
import {
    IUsersService,
    USER_SERVICE_TOKEN,
} from '@libs/identity/domain/user/contracts/user.service.contract';
import {
    IIntegrationConfigService,
    INTEGRATION_CONFIG_SERVICE_TOKEN,
} from '@libs/integrations/domain/integrationConfigs/contracts/integration-config.service.contracts';
import { Repositories } from '@libs/platform/domain/platformIntegrations/types/codeManagement/repositories.type';
import { UserRequest } from '@libs/core/infrastructure/config/types/http/user-request.type';
import { AuditLogEvents } from '@libs/ee/codeReviewSettingsLog/events/audit-log.events';
import { UserRepoAccessLogParams } from '@libs/ee/codeReviewSettingsLog/infrastructure/adapters/services/userManagementLog.handler';
import { ActionType } from '@libs/core/infrastructure/config/types/general/codeReviewSettingsLog.type';

@Injectable()
export class AssignReposUseCase implements IUseCase {
    private readonly logger = createLogger(AssignReposUseCase.name);
    constructor(
        @Inject(USER_SERVICE_TOKEN)
        private readonly userService: IUsersService,
        @Inject(PERMISSIONS_SERVICE_TOKEN)
        private readonly permissionsService: IPermissionsService,
        @Inject(INTEGRATION_CONFIG_SERVICE_TOKEN)
        private readonly integrationConfigService: IIntegrationConfigService,
        @Inject(REQUEST)
        private readonly request: UserRequest,
        private readonly eventEmitter: EventEmitter2,
    ) {}

    async execute(params: {
        userId: string;
        repoIds: string[];
        teamId: string;
    }) {
        try {
            const { userId, repoIds, teamId } = params;

            const user = await this.userService.findOne({ uuid: userId });
            if (!user) {
                throw new Error('User not found');
            }

            const integrationConfigs =
                await this.integrationConfigService.findOne({
                    configKey: IntegrationConfigKey.REPOSITORIES,
                    integration: {
                        organization: {
                            uuid: user.organization?.uuid,
                        },
                        team: {
                            uuid: teamId,
                        },
                        status: true,
                    },
                });
            if (!integrationConfigs) {
                throw new Error(
                    'Integration configurations not found for the organization',
                );
            }

            const configuredRepos =
                (integrationConfigs.configValue as Repositories[]) || [];
            const configuredRepoIdSet = new Set(
                configuredRepos.map((repo) => repo.id),
            );

            const validRepoIds =
                repoIds.length === 0
                    ? []
                    : repoIds.filter((id) => configuredRepoIdSet.has(id));
            if (repoIds.length > 0 && validRepoIds.length === 0) {
                throw new Error(
                    'None of the provided repository IDs are valid',
                );
            }

            const permissions = await this.permissionsService.findOne({
                user: { uuid: userId },
            });

            const previousRepoIds: string[] =
                permissions?.permissions?.assignedRepositoryIds ?? [];

            if (!permissions) {
                this.logger.warn({
                    message: `No permissions found for user. Creating new permissions record.`,
                    metadata: { userId, assignedRepositoryIds: validRepoIds },
                    context: AssignReposUseCase.name,
                });

                await this.permissionsService.create({
                    user: { uuid: userId },
                    permissions: { assignedRepositoryIds: validRepoIds },
                });
            } else {
                await this.permissionsService.update(permissions.uuid, {
                    permissions: { assignedRepositoryIds: validRepoIds },
                });
            }

            this.logger.log({
                message: `Assigned repositories to user with UUID: ${userId}`,
                context: AssignReposUseCase.name,
                metadata: { assignedRepositoryIds: validRepoIds },
            });

            // Build repo name map from configured repos
            const repoNameMap = new Map<string, string>();
            for (const repo of configuredRepos) {
                repoNameMap.set(repo.id, repo.name);
            }

            const previousRepoIdsSet = new Set(previousRepoIds);
            const validRepoIdsSet = new Set(validRepoIds);

            const addedIds = validRepoIds.filter(
                (id) => !previousRepoIdsSet.has(id),
            );
            const removedIds = previousRepoIds.filter(
                (id) => !validRepoIdsSet.has(id),
            );

            if (addedIds.length > 0 || removedIds.length > 0) {
                const logParams: UserRepoAccessLogParams = {
                    organizationAndTeamData: {
                        organizationId: user.organization?.uuid,
                        teamId,
                    },
                    userInfo: {
                        userId: this.request.user?.uuid,
                        userEmail: this.request.user?.email,
                    },
                    actionType: ActionType.EDIT,
                    targetUserEmail: user.email,
                    addedRepositories: addedIds.map((id) => ({
                        id,
                        name: repoNameMap.get(id) || id,
                    })),
                    removedRepositories: removedIds.map((id) => ({
                        id,
                        name: repoNameMap.get(id) || id,
                    })),
                };

                this.eventEmitter.emit(
                    AuditLogEvents.USER_REPO_ACCESS,
                    logParams,
                );
            }

            return validRepoIds;
        } catch (error) {
            this.logger.error({
                message: 'Error assigning repositories to user',
                error,
                context: AssignReposUseCase.name,
                metadata: { params },
            });

            throw error;
        }
    }
}
