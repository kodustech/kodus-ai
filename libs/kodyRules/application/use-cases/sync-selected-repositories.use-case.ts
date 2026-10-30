import { createLogger } from '@libs/core/log/logger';
import { Injectable, Inject } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { Request } from 'express';

import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { KodyRulesSyncService } from '@libs/kodyRules/infrastructure/adapters/services/kodyRulesSync.service';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';

@Injectable()
export class SyncSelectedRepositoriesKodyRulesUseCase {
    private readonly logger = createLogger(
        SyncSelectedRepositoriesKodyRulesUseCase.name,
    );
    constructor(
        private readonly codeManagementService: CodeManagementService,
        private readonly kodyRulesSyncService: KodyRulesSyncService,
        @Inject(REQUEST)
        private readonly request: Request & {
            user: { organization: { uuid: string } };
        },
    ) {}

    async execute(params: {
        teamId: string;
        repositoriesIds?: Array<string | number>;
        /**
         * Explicit org id for callers that run OUTSIDE the request scope (e.g.
         * finish-onboarding schedules this via setImmediate, after the HTTP
         * response — by then `this.request` may be disposed). In-request callers
         * can omit it and fall back to the request-scoped value.
         */
        organizationId?: string;
    }): Promise<void> {
        const organizationAndTeamData: OrganizationAndTeamData = {
            organizationId:
                params.organizationId ??
                this.request.user?.organization?.uuid,
            teamId: params.teamId,
        };

        try {
            const repos = await this.codeManagementService.getRepositories({
                organizationAndTeamData,
            });

            if (!Array.isArray(repos) || repos.length === 0) {
                return;
            }

            const filtered = repos
                .filter(
                    (r: any) =>
                        r && (r.selected === true || r.isSelected === true),
                )
                .filter((r: any) =>
                    params.repositoriesIds && params.repositoriesIds.length > 0
                        ? params.repositoriesIds.includes(r.id) ||
                          params.repositoriesIds.includes(String(r.id))
                        : true,
                );

            for (const repo of filtered) {
                await this.kodyRulesSyncService.syncRepositoryMain({
                    organizationAndTeamData,
                    repository: {
                        id: String(repo.id),
                        name: repo.name,
                        fullName:
                            (repo as any)?.fullName ||
                            `${(repo as any)?.organizationName || ''}/${repo.name}`,
                        defaultBranch: (repo as any)?.default_branch,
                    },
                });
            }
        } catch (error) {
            this.logger.error({
                message: 'Failed to sync selected repositories Kody Rules',
                context: SyncSelectedRepositoriesKodyRulesUseCase.name,
                error,
                metadata: {
                    organizationAndTeamData,
                    params,
                },
            });
        }
    }
}
