import { IAutomationExecutionService } from '@libs/automation/domain/automationExecution/contracts/automation-execution.service';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { IPullRequestsService } from '@libs/platformData/domain/pullRequests/contracts/pullRequests.service.contracts';
import { PullRequestsEntity } from '@libs/platformData/domain/pullRequests/entities/pullRequests.entity';

import { isOpenPullRequest } from './pull-request-metrics';

/**
 * Up to this many skipped-only PRs are simply loaded and checked for "still
 * open". Past it, the open PRs are read instead (see below).
 */
const LOAD_BY_KEY_LIMIT = 200;

/** More open PRs than this and reading them all is no longer the cheaper side. */
const MAX_OPEN_PULL_REQUESTS = 5000;

const keyOf = (repositoryId: unknown, number: unknown) =>
    `${String(repositoryId)}#${String(number)}`;

/**
 * The pull requests Kody was triggered on, skipped every time, and that are
 * still open — "Kody skipped" on the Reviews screen, both the counter and the
 * list, so the two cannot disagree.
 *
 * The skipped-only PRs come from the executions and span the team's whole
 * history; a team that runs without licences or on a manual cadence has
 * thousands, nearly all long closed. Loading every one of them to keep the
 * open few is what this used to do. When there are many, the open PRs are the
 * smaller set, so those are read and intersected instead. Both routes answer
 * the same PRs: in the skipped-only set, present in MongoDB, and open by
 * `isOpenPullRequest`.
 */
export async function findOpenAwaitingPullRequests(params: {
    automationExecutionService: Pick<
        IAutomationExecutionService,
        'getAwaitingReviewPullRequestKeys'
    >;
    pullRequestsService: Pick<
        IPullRequestsService,
        'findManyByNumbersAndRepositoryIds' | 'findOpenPullRequests'
    >;
    organizationAndTeamData: OrganizationAndTeamData;
    repositoryIds: string[] | undefined;
    /** Rethrow a failed execution query instead of reading it as "none". */
    failOnError?: boolean;
}): Promise<PullRequestsEntity[]> {
    const {
        automationExecutionService,
        pullRequestsService,
        organizationAndTeamData,
        repositoryIds,
        failOnError,
    } = params;

    const awaitingKeys =
        await automationExecutionService.getAwaitingReviewPullRequestKeys({
            organizationAndTeamData,
            repositoryIds,
            failOnError,
        });
    if (!awaitingKeys.length) {
        return [];
    }

    if (awaitingKeys.length > LOAD_BY_KEY_LIMIT) {
        const openPullRequests = await pullRequestsService.findOpenPullRequests(
            organizationAndTeamData.organizationId,
            repositoryIds,
            MAX_OPEN_PULL_REQUESTS,
        );

        if (openPullRequests) {
            const awaiting = new Set(
                awaitingKeys.map((key) =>
                    keyOf(key.repositoryId, key.pullRequestNumber),
                ),
            );

            return openPullRequests.filter(
                (pr) =>
                    pr?.number != null &&
                    pr?.repository?.id != null &&
                    awaiting.has(keyOf(pr.repository.id, pr.number)) &&
                    isOpenPullRequest(pr),
            );
        }
    }

    const pullRequests =
        (await pullRequestsService.findManyByNumbersAndRepositoryIds(
            awaitingKeys.map((key) => ({
                number: key.pullRequestNumber,
                repositoryId: key.repositoryId,
            })),
            organizationAndTeamData.organizationId,
        )) ?? [];

    return pullRequests.filter(
        (pr) =>
            pr?.number != null &&
            pr?.repository?.id != null &&
            isOpenPullRequest(pr),
    );
}
