import { Inject } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';

import { IntegrationConfigKey } from '@libs/core/domain/enums/Integration-config-key.enum';
import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import { UserRequest } from '@libs/core/infrastructure/config/types/http/user-request.type';
import {
    Action,
    ResourceType,
} from '@libs/identity/domain/permissions/enums/permissions.enum';
import { AuthorizationService } from '@libs/identity/infrastructure/adapters/services/permissions/authorization.service';
import {
    IIntegrationConfigService,
    INTEGRATION_CONFIG_SERVICE_TOKEN,
} from '@libs/integrations/domain/integrationConfigs/contracts/integration-config.service.contracts';
import { Repositories } from '@libs/platform/domain/platformIntegrations/types/codeManagement/repositories.type';
import { createLogger } from '@libs/core/log/logger';

export class GetSelectedRepositoriesUseCase implements IUseCase {
    private readonly logger = createLogger(GetSelectedRepositoriesUseCase.name);

    constructor(
        @Inject(INTEGRATION_CONFIG_SERVICE_TOKEN)
        private readonly integrationConfigService: IIntegrationConfigService,
        private readonly authorizationService: AuthorizationService,

        @Inject(REQUEST)
        private readonly request: UserRequest,
    ) {}

    public async execute(params: {
        teamId: string;
        page?: number;
        perPage?: number;
    }): Promise<
        | Repositories[]
        | {
              data: Repositories[];
              pagination: { page: number; perPage: number; total: number };
          }
    > {
        try {
            const organizationId = this.request.user.organization.uuid;

            const repositories =
                await this.integrationConfigService.findIntegrationConfigFormatted<
                    Repositories[]
                >(IntegrationConfigKey.REPOSITORIES, {
                    organizationId,
                    teamId: params.teamId,
                });

            if (!repositories || !Array.isArray(repositories)) {
                return [];
            }

            const assignedRepositoryIds =
                await this.authorizationService.getRepositoryScope({
                    user: this.request.user,
                    action: Action.Read,
                    resource: ResourceType.CodeReviewSettings,
                });

            let filteredRepositories = repositories;

            if (assignedRepositoryIds !== null) {
                const assignedRepositoryIdsSet = new Set(assignedRepositoryIds);
                filteredRepositories = filteredRepositories.filter((repo) =>
                    assignedRepositoryIdsSet.has(repo.id),
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
                message: 'Error while getting selected repositories',
                context: GetSelectedRepositoriesUseCase.name,
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
