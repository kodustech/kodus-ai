import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { KodyRulesSyncService } from '@/core/infrastructure/adapters/services/kodyRules/kodyRulesSync.service';
import { CodeManagementService } from '@/core/infrastructure/adapters/services/platformIntegration/codeManagement.service';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import { Inject, Injectable } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { Request } from 'express';

@Injectable()
export class FastSyncIdeRulesUseCase {
    constructor(
        private readonly kodyRulesSyncService: KodyRulesSyncService,
        private readonly codeManagementService: CodeManagementService,
        private readonly logger: PinoLoggerService,
        @Inject(REQUEST)
        private readonly request: Request & {
            user: { organization: { uuid: string } };
        },
    ) {}

    async execute(params: {
        teamId: string;
        repositoryId: string;
        maxFiles?: number;
        maxFileSizeBytes?: number;
        maxTotalBytes?: number;
        maxConcurrent?: number;
    }) {
        const organizationId = this.request.user?.organization?.uuid;
        if (!organizationId) {
            throw new Error('Organization ID not found');
        }

        const organizationAndTeamData: OrganizationAndTeamData = {
            organizationId,
            teamId: params.teamId,
        };

        try {
            const repositories = await this.codeManagementService.getRepositories(
                {
                    organizationAndTeamData,
                },
            );

            const repository = (repositories || []).find(
                (repo: any) =>
                    repo?.id === params.repositoryId ||
                    repo?.id === Number(params.repositoryId) ||
                    repo?.id === String(params.repositoryId),
            );

            if (!repository) {
                throw new Error('Repository not found');
            }

            return await this.kodyRulesSyncService.syncRepositoryMainFast({
                organizationAndTeamData,
                repository: {
                    id: String(repository.id),
                    name: repository.name,
                    fullName:
                        (repository as any)?.fullName ||
                        `${(repository as any)?.organizationName || ''}/${repository.name}`,
                    defaultBranch: (repository as any)?.default_branch,
                },
                maxFiles: params.maxFiles,
                maxFileSizeBytes: params.maxFileSizeBytes,
                maxTotalBytes: params.maxTotalBytes,
                maxConcurrent: params.maxConcurrent,
            });
        } catch (error) {
            this.logger.error({
                message: 'Failed to fast sync IDE rules',
                context: FastSyncIdeRulesUseCase.name,
                error,
                metadata: {
                    organizationAndTeamData,
                    params,
                },
            });

            throw error;
        }
    }
}
