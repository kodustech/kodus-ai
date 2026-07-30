import { createLogger } from '@libs/core/log/logger';
import { Inject, Injectable } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { Request } from 'express';

import { IntegrationConfigKey } from '@libs/core/domain/enums/Integration-config-key.enum';
import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import {
    IIntegrationConfigService,
    INTEGRATION_CONFIG_SERVICE_TOKEN,
} from '@libs/integrations/domain/integrationConfigs/contracts/integration-config.service.contracts';
import { PullRequest } from '@libs/platform/domain/platformIntegrations/types/codeManagement/pullRequests.type';
import { Repositories } from '@libs/platform/domain/platformIntegrations/types/codeManagement/repositories.type';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';

@Injectable()
export class GetPRsUseCase implements IUseCase {
    private readonly logger = createLogger(GetPRsUseCase.name);
    constructor(
        private readonly codeManagementService: CodeManagementService,
        @Inject(INTEGRATION_CONFIG_SERVICE_TOKEN)
        private readonly integrationConfigService: IIntegrationConfigService,
        @Inject(REQUEST)
        private readonly request: Request & { user },
    ) {}

    public async execute(params: {
        teamId: string;
        number?: number;
        title?: string;
        url?: string;
        repositoryId?: string;
        repositoryName?: string;
        repository?: string;
    }) {
        try {
            const { teamId } = params;
            const organizationId = this.request.user.organization.uuid;

            const organizationAndTeamData: OrganizationAndTeamData = {
                organizationId,
                teamId,
            };
            const repositoryName = params.repositoryName ?? params.repository;
            const repository = await this.resolveRepository({
                organizationAndTeamData,
                repositoryId: params.repositoryId,
                repositoryName,
            });

            if ((params.repositoryId || repositoryName) && !repository) {
                this.logger.warn({
                    message: 'Repository filter did not match any repository',
                    context: GetPRsUseCase.name,
                    metadata: {
                        organizationAndTeamData,
                        repositoryId: params.repositoryId,
                        repositoryName,
                    },
                });
                return [];
            }

            const thirtyDaysAgo = new Date(
                Date.now() - 30 * 24 * 60 * 60 * 1000,
            );

            const today = new Date(Date.now());

            const defaultFilter = {
                startDate: thirtyDaysAgo,
                endDate: today,
                number: params.number,
                title: params.title,
                url: params.url,
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
                context: GetPRsUseCase.name,
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

    private async resolveRepository(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repositoryId?: string;
        repositoryName?: string;
    }): Promise<{ id: string; name: string } | undefined> {
        const { organizationAndTeamData, repositoryId, repositoryName } =
            params;

        if (!repositoryId && !repositoryName) {
            return undefined;
        }

        try {
            const repositories =
                await this.integrationConfigService.findIntegrationConfigFormatted<
                    Repositories[]
                >(IntegrationConfigKey.REPOSITORIES, organizationAndTeamData);

            if (!repositories?.length) {
                return undefined;
            }

            const normalizedId = repositoryId
                ? String(repositoryId).trim()
                : undefined;
            const normalizedName = repositoryName
                ? repositoryName.trim().toLowerCase()
                : undefined;

            const matchesName = (repo: Repositories) => {
                if (!normalizedName) {
                    return false;
                }

                const candidates = [
                    repo.name,
                    (repo as { fullName?: string }).fullName,
                    (repo as { full_name?: string }).full_name,
                    repo.organizationName
                        ? `${repo.organizationName}/${repo.name}`
                        : undefined,
                ].filter(Boolean) as string[];

                return candidates.some(
                    (candidate) => candidate.toLowerCase() === normalizedName,
                );
            };

            const match = repositories.find((repo) => {
                if (normalizedId && String(repo.id) === normalizedId) {
                    return true;
                }

                return matchesName(repo);
            });

            if (!match) {
                return undefined;
            }

            return {
                id: String(match.id),
                name: match.name,
            };
        } catch (error) {
            this.logger.warn({
                message: 'Failed to resolve repository filter',
                context: GetPRsUseCase.name,
                error,
                metadata: {
                    organizationAndTeamData,
                    repositoryId,
                    repositoryName,
                },
            });
            return undefined;
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
}
