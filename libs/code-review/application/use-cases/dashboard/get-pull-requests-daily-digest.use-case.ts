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
import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import { createLogger } from '@libs/core/log/logger';
import { Inject, Injectable } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import {
    AUTOMATION_EXECUTION_SERVICE_TOKEN,
    IAutomationExecutionService,
} from '@libs/automation/domain/automationExecution/contracts/automation-execution.service';
import { AuthorizationService } from '@libs/identity/infrastructure/adapters/services/permissions/authorization.service';
import { resolveDashboardRepositoryScope } from './utils/team-repository-scope.util';

export interface PullRequestsDailyDigest {
    // ISO start-of-day (UTC) the digest is scoped to.
    date: string;
    // Distinct PRs that had a Kody review today.
    reviewedToday: number;
    // Of today's reviewed PRs, how many delivered at least one critical/high.
    needsAttention: number;
    // Distinct PRs whose review errored (error / partial_error) today.
    erroredToday: number;
    // PRs opened today, still open, with no Kody review yet.
    awaitingReview: number;
}

@Injectable()
export class GetPullRequestsDailyDigestUseCase implements IUseCase {
    private readonly logger = createLogger(
        GetPullRequestsDailyDigestUseCase.name,
    );

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

    async execute(query: {
        teamId?: string;
    }): Promise<PullRequestsDailyDigest> {
        const organizationId = this.request.user?.organization?.uuid;
        if (!organizationId) {
            throw new Error('No organization found in request');
        }

        const { date, empty } = this.buildScope();

        try {
            const organizationAndTeamData: OrganizationAndTeamData = {
                organizationId,
                teamId: query.teamId,
            };

            // Same team/repo scope resolution as the facets, so reviewed/errored
            // (Postgres) and awaiting (Mongo) all count the same set of PRs.
            const scope = await resolveDashboardRepositoryScope({
                authorizationService: this.authorizationService,
                integrationConfigService: this.integrationConfigService,
                user: this.request.user,
                organizationAndTeamData,
                onError: (error) =>
                    this.logger.warn({
                        message:
                            'Failed to resolve repository scope for daily digest',
                        context: GetPullRequestsDailyDigestUseCase.name,
                        error: error as Error,
                        metadata: { organizationId, teamId: query.teamId },
                    }),
            });
            if (!scope) {
                return empty;
            }
            const { repositoryIds } = scope;

            // 1. Today's distinct reviewed PRs + which of them errored, counted
            //    DB-side (DISTINCT PR + bool_or on error status) scoped to
            //    today. Replaces the old "scan up to N executions and dedup in
            //    memory" approach — no cap, no unbounded in-memory load.
            const reviewedKeyRows =
                await this.automationExecutionService.getDistinctReviewedPullRequestKeys(
                    {
                        organizationAndTeamData,
                        repositoryIds,
                        createdAtFrom: date,
                    },
                );

            const reviewedCriteria: Array<{
                number: number;
                repositoryId: string;
            }> = [];
            let erroredToday = 0;
            const reviewedToday = reviewedKeyRows.length;

            for (const row of reviewedKeyRows) {
                reviewedCriteria.push({
                    number: row.pullRequestNumber,
                    repositoryId: row.repositoryId,
                });
                if (row.hasError) {
                    erroredToday++;
                }
            }

            // 2. Needs attention: today's reviewed PRs with a delivered
            //    critical/high suggestion.
            let needsAttention = 0;
            if (reviewedCriteria.length) {
                const counts =
                    await this.pullRequestsService.findSuggestionCountsByNumbersAndRepositoryIds(
                        reviewedCriteria,
                        organizationId,
                    );

                for (const value of counts.values()) {
                    const bySeverity = value.bySeverity;
                    if (
                        bySeverity &&
                        bySeverity.critical + bySeverity.high > 0
                    ) {
                        needsAttention++;
                    }
                }
            }

            // 3. Awaiting review: PRs Kody was triggered on today but skipped and
            //    never reviewed — every execution today was status='skipped' (no
            //    license, BYOK, manual/paused cadence, ignored user). Sourced
            //    from automation_execution (the table that drives the list), so
            //    a PR counts as awaiting iff it's on the screen and still unseen.
            const awaitingKeys =
                await this.automationExecutionService.getAwaitingReviewPullRequestKeys(
                    {
                        organizationAndTeamData,
                        repositoryIds,
                        createdAtFrom: date,
                    },
                );

            const awaitingReview = awaitingKeys.length;

            return {
                date,
                reviewedToday,
                needsAttention,
                erroredToday,
                awaitingReview,
            };
        } catch (error) {
            this.logger.error({
                message: 'Error building pull requests daily digest',
                context: GetPullRequestsDailyDigestUseCase.name,
                error,
                metadata: { organizationId },
            });
            throw error;
        }
    }

    private buildScope(): { date: string; empty: PullRequestsDailyDigest } {
        const now = new Date();
        const todayStart = new Date(
            Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
        );
        const date = todayStart.toISOString();

        return {
            date,
            empty: {
                date,
                reviewedToday: 0,
                needsAttention: 0,
                erroredToday: 0,
                awaitingReview: 0,
            },
        };
    }
}
