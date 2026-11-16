import { IAutomationExecutionService } from '@libs/automation/domain/automationExecution/contracts/automation-execution.service';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { IPullRequestsService } from '@libs/platformData/domain/pullRequests/contracts/pullRequests.service.contracts';
import { PullRequestsEntity } from '@libs/platformData/domain/pullRequests/entities/pullRequests.entity';

import { isOpenPullRequest } from './pull-request-metrics';

/**
 * Up to this many skipped-only PRs are simply loaded and checked for "still
 * open". Past it, they are narrowed to the open ones first (see below).
 */
const LOAD_BY_KEY_LIMIT = 200;

/**
 * How many open pull request keys are worth reading to narrow a larger set.
 * Past this the keys stop being a shortcut — most of the recent history is
 * open anyway — and the caller keeps its own path.
 */
export const MAX_OPEN_PULL_REQUEST_KEYS = 5000;

type PullRequestKey = { number: number; repositoryId: string };

const keyOf = (key: PullRequestKey) => `${key.repositoryId}#${key.number}`;

/** The keys of `left` that are also in `right`. */
export const intersectPullRequestKeys = <T extends PullRequestKey>(
    left: T[],
    right: PullRequestKey[],
): T[] => {
    const keys = new Set(right.map(keyOf));
    return left.filter((key) => keys.has(keyOf(key)));
};

/**
 * The pull requests Kody was triggered on, skipped every time, and that are
 * still open — "Kody skipped" on the Reviews screen, both the counter and the
 * list, so the two cannot disagree.
 *
 * The skipped-only PRs come from the executions and span the team's whole
 * history; a team that runs without licences or on a manual cadence has
 * thousands, nearly all long closed. Loading every one of them to keep the
 * open few is what this used to do. When there are many, the keys of the open
 * PRs are read first and only the PRs in both sets are loaded. Either way the
 * answer is the same: in the skipped-only set, present in MongoDB, and open by
 * `isOpenPullRequest`.
 */
export async function findOpenAwaitingPullRequests(params: {
    automationExecutionService: Pick<
        IAutomationExecutionService,
        'getAwaitingReviewPullRequestKeys'
    >;
    pullRequestsService: Pick<
        IPullRequestsService,
        'findManyByNumbersAndRepositoryIds' | 'findOpenPullRequestKeys'
    >;
    organizationAndTeamData: OrganizationAndTeamData;
    repositoryIds: string[] | undefined;
}): Promise<PullRequestsEntity[]> {
    const {
        automationExecutionService,
        pullRequestsService,
        organizationAndTeamData,
        repositoryIds,
    } = params;
    const { organizationId } = organizationAndTeamData;

    const awaitingKeys =
        await automationExecutionService.getAwaitingReviewPullRequestKeys({
            organizationAndTeamData,
            repositoryIds,
        });

    let candidates: PullRequestKey[] = awaitingKeys.map((key) => ({
        number: key.pullRequestNumber,
        repositoryId: key.repositoryId,
    }));

    if (candidates.length > LOAD_BY_KEY_LIMIT) {
        const open = await pullRequestsService.findOpenPullRequestKeys(
            organizationId,
            repositoryIds,
            { limit: MAX_OPEN_PULL_REQUEST_KEYS },
        );
        if (!open.truncated) {
            candidates = intersectPullRequestKeys(candidates, open.keys);
        }
    }

    if (!candidates.length) {
        return [];
    }

    const pullRequests =
        (await pullRequestsService.findManyByNumbersAndRepositoryIds(
            candidates,
            organizationId,
        )) ?? [];

    return pullRequests.filter(
        (pr) =>
            pr?.number != null &&
            pr?.repository?.id != null &&
            isOpenPullRequest(pr),
    );
}
