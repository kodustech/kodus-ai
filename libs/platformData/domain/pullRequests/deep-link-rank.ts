/**
 * Ranking shared by the two places that pick the PR-list deep-link target:
 * the Mongo aggregation in PullRequestsRepository and the in-memory fallback
 * in GetEnrichedPullRequestsUseCase. They must agree — a reviewer should land
 * on the same finding whichever path computed the counts.
 *
 * It lives here, in the lower layer, so the repository can use it without
 * code-review having to depend upwards.
 */

/** Unresolved dominates severity: any open finding outranks any applied one. */
export const UNRESOLVED_RANK_BONUS = 10;

export const SEVERITY_RANK: Readonly<Record<string, number>> = {
    critical: 4,
    high: 3,
    medium: 2,
    low: 1,
};
