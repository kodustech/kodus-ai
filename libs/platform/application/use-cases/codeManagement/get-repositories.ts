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

export class GetRepositoriesUseCase implements IUseCase {
    private readonly logger = createLogger(GetRepositoriesUseCase.name);

    constructor(
        private readonly codeManagementService: CodeManagementService,
        private readonly authorizationService: AuthorizationService,

        @Inject(REQUEST)
        private readonly request: UserRequest,
    ) {}

    public async execute(params: {
        teamId: string;
        organizationSelected: any;
        isSelected?: boolean;
        page?: number;
        perPage?: number;
    }) {
        try {
            const repositories =
                await this.codeManagementService.getRepositories({
                    organizationAndTeamData: {
                        organizationId: this.request.user.organization.uuid,
                        teamId: params?.teamId,
                    },
                    filters: {
                        organizationSelected: params?.organizationSelected,
                    },
                });

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
            return [];
        }
    }
}
