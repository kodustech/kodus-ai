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

export interface PullRequestsFacets {
    // Distinct reviewed PRs (org/team + repo scope), all-time.
    all: number;
    // Open PRs that still carry an unaddressed delivered suggestion
    // (implementationStatus ≠ implemented).
    needsAttention: number;
    // Reviewed PRs whose review errored.
    errored: number;
    // PRs Kody was triggered on but skipped and never reviewed — every
    // execution status='skipped' (no license, BYOK, manual/paused cadence,
    // ignored user). Sourced from automation_execution, the table that drives
    // the list, so awaiting = on-screen PRs still waiting for a first review.
    awaiting: number;
    // Reviewed PRs authored by the current user (0 if identity can't be matched).
    mine: number;
}

@Injectable()
export class GetPullRequestsFacetsUseCase implements IUseCase {
    private readonly logger = createLogger(GetPullRequestsFacetsUseCase.name);

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
        // 'mine' narrows the actionable facet (needsAttention) to the caller's
        // own PRs — powers the dev "Minha fila" view, whose cards must count only
        // my work. 'team' (default) counts the whole team scope. `all`/`errored`/
        // `awaiting` stay team-wide (they aren't shown in the mine view).
        scope?: 'mine' | 'team';
    }): Promise<PullRequestsFacets> {
        const empty: PullRequestsFacets = {
            all: 0,
            needsAttention: 0,
            errored: 0,
            awaiting: 0,
            mine: 0,
        };

        const organizationId = this.request.user?.organization?.uuid;
        if (!organizationId) {
            return empty;
        }

        try {
            const organizationAndTeamData: OrganizationAndTeamData = {
                organizationId,
                teamId: query.teamId,
            };

            // Team-scoped repository set every facet counts against — resolved
            // once, here, so `all`/`errored` (Postgres join) and the Mongo-backed
            // facets (needsAttention/mine/awaiting) all count the same PRs.
            const scope = await resolveDashboardRepositoryScope({
                authorizationService: this.authorizationService,
                integrationConfigService: this.integrationConfigService,
                user: this.request.user,
                organizationAndTeamData,
                onError: (error) =>
                    this.logger.warn({
                        message:
                            'Failed to resolve repository scope for facets',
                        context: GetPullRequestsFacetsUseCase.name,
                        error: error as Error,
                        metadata: { organizationId, teamId: query.teamId },
                    }),
            });
            if (!scope) {
                return empty;
            }
            const { repositoryIds } = scope;

            const email = this.request.user?.email;
            // In the "mine" scope the actionable card counts only my open PRs
            // with an unaddressed suggestion — same predicate, plus the author.
            // countDeliveredPullRequests ANDs authorEmail with the other flags,
            // so this reuses the existing query (no new scan).
            // `&& email` here (not just at the call site below) so a mine-scope
            // caller with no resolvable email never falls back to an undefined
            // authorEmail (which would count the whole team).
            const needsAttentionAuthor =
                query.scope === 'mine' && email ? email : undefined;

            const [reviewedKeys, needsAttention, mine, awaitingKeys] =
                await Promise.all([
                    this.automationExecutionService.getDistinctReviewedPullRequestKeys(
                        { organizationAndTeamData, repositoryIds },
                    ),
                    // Needs attention = open PRs that still carry an unaddressed
                    // delivered suggestion (any severity, implementationStatus ≠
                    // implemented). Actionable "someone needs to look at this",
                    // not "ever delivered a crit/high" (which counted merged/
                    // resolved PRs too). Scoped to the caller in the "mine" view.
                    // Guard: in the "mine" scope with no resolvable email we'd
                    // otherwise drop authorEmail and count the WHOLE team — so
                    // return 0 (matching the `mine` facet). Team scope always
                    // runs the (team-wide) count.
                    query.scope !== 'mine' || email
                        ? this.pullRequestsService.countDeliveredPullRequests(
                              organizationId,
                              repositoryIds,
                              {
                                  unresolvedOnly: true,
                                  openOnly: true,
                                  authorEmail: needsAttentionAuthor,
                              },
                          )
                        : Promise.resolve(0),
                    email
                        ? this.pullRequestsService.countDeliveredPullRequests(
                              organizationId,
                              repositoryIds,
                              { authorEmail: email },
                          )
                        : Promise.resolve(0),
                    // Awaiting = PRs Kody was triggered on but skipped and never
                    // reviewed (every execution status='skipped': no license,
                    // BYOK, manual/paused cadence, ignored user). Sourced from
                    // automation_execution — the same table that drives the list,
                    // so a PR shows as awaiting iff it's on the screen and unseen.
                    this.automationExecutionService.getAwaitingReviewPullRequestKeys(
                        { organizationAndTeamData, repositoryIds },
                    ),
                ]);

            const errored = reviewedKeys.filter((k) => k.hasError).length;
            // Awaiting count = skipped-only PRs that are still OPEN. Hydrate just
            // the awaiting keys (bounded — usually a handful) instead of scanning
            // every open PR for the org, and apply the SAME case-insensitive open
            // predicate the Awaiting list uses so the badge and the list agree.
            let awaiting = 0;
            if (awaitingKeys.length) {
                const awaitingPrs =
                    (await this.pullRequestsService.findManyByNumbersAndRepositoryIds(
                        awaitingKeys.map((k) => ({
                            number: k.pullRequestNumber,
                            repositoryId: k.repositoryId,
                        })),
                        organizationId,
                    )) ?? [];
                awaiting = awaitingPrs.filter((pr) =>
                    isOpenPullRequest(pr),
                ).length;
            }

            return {
                all: reviewedKeys.length,
                needsAttention,
                errored,
                awaiting,
                mine,
            };
        } catch (error) {
            this.logger.error({
                message: 'Error building pull requests facets',
                context: GetPullRequestsFacetsUseCase.name,
                error,
                metadata: { organizationId },
            });
            return empty;
        }
    }
}
