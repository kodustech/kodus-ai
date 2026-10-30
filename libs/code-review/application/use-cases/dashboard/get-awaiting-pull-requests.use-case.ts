import { UserRequest } from '@libs/core/infrastructure/config/types/http/user-request.type';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import {
    IIntegrationConfigService,
    INTEGRATION_CONFIG_SERVICE_TOKEN,
} from '@libs/integrations/domain/integrationConfigs/contracts/integration-config.service.contracts';
import {
    IPullRequestsService,
    PULL_REQUESTS_SERVICE_TOKEN,
} from '@libs/platformData/domain/pullRequests/contracts/pullRequests.service.contracts';
import { resolveDashboardRepositoryScope } from './utils/team-repository-scope.util';
import { isOpenPullRequest } from './utils/pull-request-metrics';
import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import { createLogger } from '@libs/core/log/logger';
import { Inject, Injectable } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import {
    AUTOMATION_EXECUTION_SERVICE_TOKEN,
    IAutomationExecutionService,
} from '@libs/automation/domain/automationExecution/contracts/automation-execution.service';
import { AuthorizationService } from '@libs/identity/infrastructure/adapters/services/permissions/authorization.service';

export interface AwaitingPullRequest {
    prId: string;
    prNumber: number;
    title: string;
    url: string;
    repositoryName: string;
    repositoryId: string;
    author: { username: string; name?: string };
    openedAt: string;
}

// Cap on the awaiting list — this is a "needs attention" nudge, not an archive.
const MAX_AWAITING = 100;

@Injectable()
export class GetAwaitingPullRequestsUseCase implements IUseCase {
    private readonly logger = createLogger(GetAwaitingPullRequestsUseCase.name);

    constructor(
        @Inject(AUTOMATION_EXECUTION_SERVICE_TOKEN)
        private readonly automationExecutionService: IAutomationExecutionService,

        @Inject(PULL_REQUESTS_SERVICE_TOKEN)
        private readonly pullRequestsService: IPullRequestsService,

        @Inject(INTEGRATION_CONFIG_SERVICE_TOKEN)
        private readonly integrationConfigService: IIntegrationConfigService,

        @Inject(REQUEST)
        private readonly request: UserRequest,
        private readonly authorizationService: AuthorizationService,
    ) {}

    async execute(query: { teamId?: string }): Promise<AwaitingPullRequest[]> {
        const organizationId = this.request.user?.organization?.uuid;
        if (!organizationId) {
            return [];
        }

        try {
            const organizationAndTeamData: OrganizationAndTeamData = {
                organizationId,
                teamId: query.teamId,
            };

            // Team-scoped repository set — the SAME resolution the Awaiting facet
            // count uses, so the list and the badge can't disagree (this list
            // previously scoped by RBAC only, drifting from the team-scoped
            // count on multi-team orgs).
            const scope = await resolveDashboardRepositoryScope({
                authorizationService: this.authorizationService,
                integrationConfigService: this.integrationConfigService,
                user: this.request.user,
                organizationAndTeamData,
                onError: (error) =>
                    this.logger.warn({
                        message:
                            'Failed to resolve repository scope for awaiting list',
                        context: GetAwaitingPullRequestsUseCase.name,
                        error: error as Error,
                        metadata: { organizationId, teamId: query.teamId },
                    }),
            });
            if (!scope) {
                return [];
            }
            const { repositoryIds } = scope;

            // Awaiting = PRs Kody was triggered on but skipped and never
            // reviewed (every execution status='skipped'). Same source as the
            // Awaiting facet count, so the list and the badge always agree.
            const awaitingKeys =
                await this.automationExecutionService.getAwaitingReviewPullRequestKeys(
                    { organizationAndTeamData, repositoryIds },
                );

            const awaitingCriteria = awaitingKeys
                .slice(0, MAX_AWAITING)
                .map((k) => ({
                    number: k.pullRequestNumber,
                    repositoryId: k.repositoryId,
                }));

            if (!awaitingCriteria.length) {
                return [];
            }

            const prs =
                (await this.pullRequestsService.findManyByNumbersAndRepositoryIds(
                    awaitingCriteria,
                    organizationId,
                )) ?? [];

            return prs
                .filter(
                    (pr) =>
                        pr?.number != null &&
                        pr?.repository?.id &&
                        // Drop skipped PRs that were later merged/closed — a
                        // config-skip on a done PR isn't "awaiting review"
                        // anymore. Shared predicate → same rule as the facet
                        // count, so the list and the badge stay in agreement.
                        isOpenPullRequest(pr),
                )
                .map((pr) => ({
                    prId: pr.uuid!,
                    prNumber: pr.number,
                    title: pr.title,
                    url: pr.url,
                    repositoryName: pr.repository.name,
                    repositoryId: pr.repository.id,
                    author: {
                        username: pr.user?.username ?? '',
                        name: pr.user?.name,
                    },
                    openedAt: pr.openedAt,
                }))
                .sort((a, b) => (a.openedAt < b.openedAt ? 1 : -1));
        } catch (error) {
            this.logger.error({
                message: 'Error listing awaiting pull requests',
                context: GetAwaitingPullRequestsUseCase.name,
                error,
                metadata: { organizationId },
            });
            return [];
        }
    }
}
