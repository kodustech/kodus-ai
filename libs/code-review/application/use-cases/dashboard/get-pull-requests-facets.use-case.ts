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
import { findOpenAwaitingPullRequests } from './utils/open-awaiting-pull-requests.util';
import { parseRequestedFields } from './utils/requested-fields.util';
import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import { createLogger } from '@libs/core/log/logger';
import { Inject, Injectable } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import {
    AUTOMATION_EXECUTION_SERVICE_TOKEN,
    IAutomationExecutionService,
} from '@libs/automation/domain/automationExecution/contracts/automation-execution.service';
import { AuthorizationService } from '@libs/identity/infrastructure/adapters/services/permissions/authorization.service';

/**
 * One number per segment of the Reviews screen. `null` means the number is not
 * known — it was not asked for, or the query behind it failed — and must be
 * shown as unavailable. It never stands in for zero: a counter that reads 0
 * when the count timed out tells the reader there is nothing to look at.
 */
export interface PullRequestsFacets {
    // Distinct reviewed PRs (org/team + repo scope), all-time.
    all: number | null;
    // Open PRs that still carry an unaddressed delivered suggestion
    // (implementationStatus ≠ implemented).
    needsAttention: number | null;
    // Reviewed PRs whose review errored.
    errored: number | null;
    // PRs Kody was triggered on but skipped and never reviewed — every
    // execution status='skipped' (no license, BYOK, manual/paused cadence,
    // ignored user). Sourced from automation_execution, the table that drives
    // the list, so awaiting = on-screen PRs still waiting for a first review.
    awaiting: number | null;
    // Reviewed PRs authored by the current user (0 if identity can't be matched).
    mine: number | null;
}

export type PullRequestsFacetName = keyof PullRequestsFacets;

export const PULL_REQUESTS_FACET_NAMES: readonly PullRequestsFacetName[] = [
    'all',
    'needsAttention',
    'errored',
    'awaiting',
    'mine',
];

/** `?fields=awaiting,needsAttention` → the facets to compute. */
export const parsePullRequestsFacetFields = (raw?: string | string[]) =>
    parseRequestedFields(raw, PULL_REQUESTS_FACET_NAMES);

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
        // The facets the caller will actually show. Each one is a scan of
        // its own (two of them over the team's whole history), so a view that
        // shows two numbers should not pay for five. Absent → every facet the
        // scope has a use for: `mine` is only ever shown in the mine view.
        fields?: PullRequestsFacetName[];
    }): Promise<PullRequestsFacets> {
        const wanted = new Set<PullRequestsFacetName>(
            query.fields?.length
                ? query.fields
                : PULL_REQUESTS_FACET_NAMES.filter(
                      (name) => name !== 'mine' || query.scope === 'mine',
                  ),
        );
        const wants = (name: PullRequestsFacetName) => wanted.has(name);

        // Nothing to count: no organization, or no repository in scope.
        const empty: PullRequestsFacets = {
            all: wants('all') ? 0 : null,
            needsAttention: wants('needsAttention') ? 0 : null,
            errored: wants('errored') ? 0 : null,
            awaiting: wants('awaiting') ? 0 : null,
            mine: wants('mine') ? 0 : null,
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

            // Each facet settles on its own: one slow or failed count must
            // not blank the others, and must not be reported as zero.
            const [reviewed, needsAttention, mine, awaiting] =
                await Promise.all([
                    // `all` and `errored` come from the same grouping.
                    wants('all') || wants('errored')
                        ? this.settle(
                              'all/errored',
                              organizationAndTeamData,
                              () =>
                                  this.automationExecutionService.getDistinctReviewedPullRequestKeys(
                                      {
                                          organizationAndTeamData,
                                          repositoryIds,
                                      },
                                  ),
                          )
                        : null,
                    // Needs attention = open PRs that still carry an unaddressed
                    // delivered suggestion (any severity, implementationStatus ≠
                    // implemented). Actionable "someone needs to look at this",
                    // not "ever delivered a crit/high" (which counted merged/
                    // resolved PRs too). Scoped to the caller in the "mine" view.
                    // Guard: in the "mine" scope with no resolvable email we'd
                    // otherwise drop authorEmail and count the WHOLE team — so
                    // answer 0 (matching the `mine` facet). Team scope always
                    // runs the (team-wide) count.
                    !wants('needsAttention')
                        ? null
                        : query.scope !== 'mine' || email
                          ? this.settle(
                                'needsAttention',
                                organizationAndTeamData,
                                () =>
                                    this.pullRequestsService.countDeliveredPullRequests(
                                        organizationId,
                                        repositoryIds,
                                        {
                                            unresolvedOnly: true,
                                            openOnly: true,
                                            authorEmail: needsAttentionAuthor,
                                        },
                                    ),
                            )
                          : 0,
                    !wants('mine')
                        ? null
                        : email
                          ? this.settle('mine', organizationAndTeamData, () =>
                                this.pullRequestsService.countDeliveredPullRequests(
                                    organizationId,
                                    repositoryIds,
                                    { authorEmail: email },
                                ),
                            )
                          : 0,
                    // Awaiting = PRs Kody was triggered on but skipped and never
                    // reviewed (every execution status='skipped': no license,
                    // BYOK, manual/paused cadence, ignored user). Sourced from
                    // automation_execution — the same table that drives the list,
                    // so a PR shows as awaiting iff it's on the screen and unseen.
                    wants('awaiting')
                        ? this.settle('awaiting', organizationAndTeamData, () =>
                              this.countAwaiting(
                                  organizationAndTeamData,
                                  repositoryIds,
                              ),
                          )
                        : null,
                ]);

            return {
                all: wants('all') && reviewed ? reviewed.length : null,
                needsAttention,
                errored:
                    wants('errored') && reviewed
                        ? reviewed.filter((key) => key.hasError).length
                        : null,
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
            return {
                all: null,
                needsAttention: null,
                errored: null,
                awaiting: null,
                mine: null,
            };
        }
    }

    // Awaiting count = skipped-only PRs that are still OPEN — the same PRs the
    // Awaiting list shows, resolved by the same helper so the badge and the
    // list agree.
    private async countAwaiting(
        organizationAndTeamData: OrganizationAndTeamData,
        repositoryIds: string[] | undefined,
    ): Promise<number> {
        const awaiting = await findOpenAwaitingPullRequests({
            automationExecutionService: this.automationExecutionService,
            pullRequestsService: this.pullRequestsService,
            organizationAndTeamData,
            repositoryIds,
        });

        return awaiting.length;
    }

    /** A facet's value, or `null` — logged — when its query fails. */
    private async settle<T>(
        facet: string,
        organizationAndTeamData: OrganizationAndTeamData,
        count: () => Promise<T>,
    ): Promise<T | null> {
        try {
            return await count();
        } catch (error) {
            this.logger.error({
                message: 'Error building pull requests facets',
                context: GetPullRequestsFacetsUseCase.name,
                error,
                metadata: { ...organizationAndTeamData, facet },
            });
            return null;
        }
    }
}
