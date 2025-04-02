import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import { CodeManagementService } from '@/core/infrastructure/adapters/services/platformIntegration/codeManagement.service';
import { IUseCase } from '@/shared/domain/interfaces/use-case.interface';
import { Inject, Injectable } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { Request } from 'express';

@Injectable()
export class GetPRsUseCase implements IUseCase {
    constructor(
        private readonly codeManagementService: CodeManagementService,

        @Inject(REQUEST)
        private readonly request: Request & { user },
        private readonly logger: PinoLoggerService,
    ) {}

    public async execute(params: { teamId: string }) {
        try {
            const { teamId } = params;
            const organizationId = this.request.user.organization.uuid;

            const organizationAndTeamData: OrganizationAndTeamData = {
                organizationId,
                teamId,
            };

            const thirtyDaysAgo = new Date(
                Date.now() - 30 * 24 * 60 * 60 * 1000,
            );

            const today = new Date(Date.now());

            const defaultFilter = {
                startDate: thirtyDaysAgo.toISOString().split('T')[0],
                endDate: today.toISOString().split('T')[0],
            };

            const pullRequests =
                await this.codeManagementService.getPullRequests({
                    organizationAndTeamData,
                    filters: defaultFilter,
                });

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

    private getLimitedPrsByRepo(pullRequests: any[]) {
        const numberOfPRsPerRepo = 5;

        const groupedPRsByRepo = pullRequests.reduce((acc, pr) => {
            if (!acc[pr.repository]) {
                acc[pr.repository] = [];
            }

            acc[pr.repository].push(pr);
            return acc;
        }, {});

        const filteredPRs = [];

        Object.values(groupedPRsByRepo).forEach((repoPRs: any[]) => {
            filteredPRs.push(...repoPRs.splice(0, numberOfPRsPerRepo));
        });

        return filteredPRs;
    }

    private getFilteredPRs(pullRequests: any[]) {
        const filteredPrs = pullRequests.map((pr) => {
            const id = pr?.project_id || pr?.repositoryId || pr.id;
            return {
                id,
                repository: pr.repository,
                pull_number: pr.pull_number,
                title: pr.message,
                url: pr.prURL,
            };
        });

        return filteredPrs;
    }
}
