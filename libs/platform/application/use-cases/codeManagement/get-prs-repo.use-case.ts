import { createLogger } from '@libs/core/log/logger';
import { Inject, Injectable } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { Request } from 'express';

import { IntegrationConfigKey } from '@libs/core/domain/enums/Integration-config-key.enum';
import { PullRequestState } from '@libs/core/domain/enums/pullRequestState.enum';
import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { ExecuteDryRunUseCase } from '@libs/dryRun/application/use-cases/execute-dry-run.use-case';
import {
    IIntegrationConfigService,
    INTEGRATION_CONFIG_SERVICE_TOKEN,
} from '@libs/integrations/domain/integrationConfigs/contracts/integration-config.service.contracts';
import { PullRequest } from '@libs/platform/domain/platformIntegrations/types/codeManagement/pullRequests.type';
import { Repositories } from '@libs/platform/domain/platformIntegrations/types/codeManagement/repositories.type';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';

@Injectable()
export class GetPRsByRepoUseCase implements IUseCase {
    private readonly logger = createLogger(GetPRsByRepoUseCase.name);
    constructor(
        private readonly codeManagementService: CodeManagementService,
        @Inject(REQUEST)
        private readonly request: Request & { user },
        @Inject(INTEGRATION_CONFIG_SERVICE_TOKEN)
        private readonly integrationConfigService: IIntegrationConfigService,
    ) {}

    public async execute(params: {
        teamId: string;
        repositoryId: string;
        filters?: {
            number?: number;
            startDate?: string;
            endDate?: string;
            author?: string;
            branch?: string;
            title?: string;
            state?: PullRequestState;
        };
    }) {
        try {
            const { teamId, filters = {} } = params;
            const organizationId = this.request.user.organization.uuid;

            const organizationAndTeamData: OrganizationAndTeamData = {
                organizationId,
                teamId,
            };

            const repository = await this.getRepository(
                params.repositoryId,
                organizationAndTeamData,
            );

            const startDate = filters.startDate
                ? new Date(filters.startDate)
                : null;
            const endDate = filters.endDate ? new Date(filters.endDate) : null;

            const thirtyDaysAgo = new Date(
                Date.now() - 30 * 24 * 60 * 60 * 1000,
            );

            const today = new Date(Date.now());

            const defaultFilter = {
                ...filters,
                startDate: startDate ?? thirtyDaysAgo,
                endDate: endDate ?? today,
            };

            const pullRequests =
                await this.codeManagementService.getPullRequests({
                    organizationAndTeamData,
                    repository,
                    filters: defaultFilter,
                });

            if (!pullRequests?.length) {
                return [];
            }

            const limitedPRs = this.getLimitedPrsByRepo(pullRequests);

            const filteredPRs = this.getFilteredPRs(limitedPRs);

            return filteredPRs;
        } catch (error) {
            this.logger.error({
                message: 'Error while creating or updating parameters',
                context: GetPRsByRepoUseCase.name,
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

    private getLimitedPrsByRepo(pullRequests: PullRequest[]): PullRequest[] {
        const numberOfPRsPerRepo = 20;

        const groupedPRsByRepo = pullRequests?.reduce(
            (acc, pr) => {
                if (!acc[pr.repositoryData.name]) {
                    acc[pr.repositoryData.name] = [];
                }

                acc[pr.repositoryData.name].push(pr);
                return acc;
            },
            {} as Record<string, PullRequest[]>,
        );

        const filteredPRs = [] as PullRequest[];

        Object.values(groupedPRsByRepo).forEach((repoPRs) => {
            filteredPRs.push(...repoPRs.splice(0, numberOfPRsPerRepo));
        });

        return filteredPRs;
    }

    private getFilteredPRs(pullRequests: PullRequest[]) {
        const filteredPrs = pullRequests.map((pr) => {
            const id = pr?.id ?? pr?.repositoryData.id;
            return {
                id,
                repository: pr.repositoryData,
                pull_number: pr.number,
                title: pr?.message || pr?.title,
                url: pr.prURL,
            };
        });

        return filteredPrs;
    }

    private async getRepository(
        repositoryId: string,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<Repositories> {
        if (repositoryId === 'global') {
            return undefined;
        }

        const repositories =
            await this.integrationConfigService.findIntegrationConfigFormatted<
                Repositories[]
            >(IntegrationConfigKey.REPOSITORIES, organizationAndTeamData);

        const repository = repositories.find(
            (repo) => repo.id === repositoryId,
        );

        if (!repository) {
            this.logger.warn({
                message: 'Repository not found for dry run',
                context: ExecuteDryRunUseCase.name,
                serviceName: ExecuteDryRunUseCase.name,
                metadata: {
                    organizationAndTeamData,
                    repositoryId,
                },
            });

            throw new Error('Repository not found');
        }

        return repository;
    }
}
