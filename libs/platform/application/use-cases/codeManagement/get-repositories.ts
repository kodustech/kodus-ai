import { Inject } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';

import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import { UserRequest } from '@libs/core/infrastructure/config/types/http/user-request.type';
import {
    Action,
    ResourceType,
} from '@libs/identity/domain/permissions/enums/permissions.enum';
import { AuthorizationService } from '@libs/identity/infrastructure/adapters/services/permissions/authorization.service';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import { createLogger } from '@libs/core/log/logger';
import { IntegrationCategory } from '@libs/core/domain/enums/integration-category.enum';
import {
    IIntegrationService,
    INTEGRATION_SERVICE_TOKEN,
} from '@libs/integrations/domain/integrations/contracts/integration.service.contracts';

export class GetRepositoriesUseCase implements IUseCase {
    private readonly logger = createLogger(GetRepositoriesUseCase.name);

    constructor(
        private readonly codeManagementService: CodeManagementService,
        private readonly authorizationService: AuthorizationService,

        @Inject(REQUEST)
        private readonly request: UserRequest,

        @Inject(INTEGRATION_SERVICE_TOKEN)
        private readonly integrationService: IIntegrationService,
    ) {}

    public async execute(params: {
        teamId: string;
        organizationSelected: any;
        isSelected?: boolean;
        page?: number;
        perPage?: number;
        /** The Git connection to list; every connection's when absent. */
        connectionId?: string;
        /** The connections the caller may read; every one when absent. */
        readableConnectionIds?: string[];
    }) {
        try {
            const organizationId = this.request.user.organization.uuid;
            const readable = params?.readableConnectionIds
                ? new Set(params.readableConnectionIds)
                : null;
            const connectionIds = (
                params?.connectionId
                    ? [params.connectionId]
                    : (
                          (await this.integrationService.find({
                              organization: { uuid: organizationId },
                              team: { uuid: params?.teamId },
                              integrationCategory:
                                  IntegrationCategory.CODE_MANAGEMENT,
                              status: true,
                          })) ?? []
                      ).map((connection) => connection.uuid)
            ).filter((uuid) => !readable || readable.has(uuid));

            const lists = await Promise.allSettled(
                connectionIds.map(async (integrationId) =>
                    (
                        (await this.codeManagementService.getRepositories({
                            organizationAndTeamData: {
                                organizationId,
                                teamId: params?.teamId,
                                integrationId,
                            },
                            filters: {
                                organizationSelected:
                                    params?.organizationSelected,
                            },
                            options: { interactive: true },
                        })) ?? []
                    ).map((repository) => ({
                        ...repository,
                        connectionId: integrationId,
                    })),
                ),
            );

            lists.forEach((list, index) => {
                if (list.status === 'rejected') {
                    this.logger.warn({
                        message:
                            'Could not list a Git connection’s repositories',
                        context: GetRepositoriesUseCase.name,
                        error: list.reason,
                        metadata: {
                            organizationId,
                            teamId: params?.teamId,
                            integrationId: connectionIds[index],
                        },
                    });
                }
            });
            // A provider failure reaches the picker as an error, not as an
            // empty list; one connection failing beside others that answer
            // is logged and the others are listed.
            const failed = lists.find(
                (list): list is PromiseRejectedResult =>
                    list.status === 'rejected',
            );
            if (failed && lists.every((list) => list.status === 'rejected')) {
                throw failed.reason;
            }

            const repositories = lists.flatMap((list) =>
                list.status === 'fulfilled' ? list.value : [],
            );

            const assignedRepositoryIds =
                await this.authorizationService.getRepositoryScope({
                    user: this.request.user,
                    action: Action.Read,
                    resource: ResourceType.CodeReviewSettings,
                });

            let filteredRepositories = repositories;
            if (assignedRepositoryIds !== null) {
                filteredRepositories = filteredRepositories.filter((repo) =>
                    assignedRepositoryIds.includes(repo.id),
                );
            }

            if (params.isSelected !== undefined) {
                const isSelectedFilter =
                    typeof params.isSelected === 'string'
                        ? params.isSelected === 'true'
                        : Boolean(params.isSelected);
                filteredRepositories = filteredRepositories.filter(
                    (repo) => repo.selected === isSelectedFilter,
                );
            }

            const total = filteredRepositories.length;

            if (params.page !== undefined || params.perPage !== undefined) {
                const page =
                    Number(params.page ?? 1) > 0 ? Number(params.page ?? 1) : 1;
                const perPage =
                    Number(params.perPage ?? 20) > 0
                        ? Number(params.perPage ?? 20)
                        : 20;

                const startIndex = (page - 1) * perPage;
                const paginatedRepositories = filteredRepositories.slice(
                    startIndex,
                    startIndex + perPage,
                );

                return {
                    data: paginatedRepositories,
                    pagination: {
                        page,
                        perPage,
                        total,
                    },
                };
            }

            return filteredRepositories;
        } catch (error) {
            this.logger.error({
                message: 'Error while getting repositories',
                context: GetRepositoriesUseCase.name,
                error: error,
                metadata: {
                    organizationAndTeamData: {
                        organizationId: this.request.user.organization.uuid,
                        teamId: params.teamId,
                    },
                },
            });
            throw error;
        }
    }
}
