import type { PullRequestExecution } from "@services/pull-requests";

export type ReviewRunStatus = NonNullable<
    PullRequestExecution["automationExecution"]
>["status"];

/**
 * The run the empty state speaks for, from the PR's runs newest first. The
 * findings on screen are aggregated across every run, so a later skipped or
 * failed run (a push with incremental review off, a provider hiccup) must not
 * hide a review that did finish clean. While older runs are still unread
 * (paging, a failed page, the MAX_RUN_PAGES cap), a failed or skipped latest
 * run with no clean one loaded is unknown, not failed.
 */
export function effectiveReviewStatus(
    runsNewestFirst: Array<ReviewRunStatus | undefined>,
    olderRunsUnread = false,
): ReviewRunStatus | undefined {
    const [latest] = runsNewestFirst;
    if (latest !== "error" && latest !== "skipped") return latest;
    if (runsNewestFirst.includes("success")) return "success";
    return olderRunsUnread ? undefined : latest;
}

/** Pages of 20 runs: plenty for any realistic PR, bounded for one with
 *  hundreds of failed pushes. */
export const MAX_RUN_PAGES = 5;

/**
 * Whether to load another page of the PR's runs. effectiveReviewStatus only
 * needs to know whether a clean run exists, so stop as soon as one is loaded.
 * Also stop while a fetch is in flight, after any failed fetch — a page or the
 * hook's 30s poll refetch (hasNextPage stays true after an error, so re-firing
 * would retry with no backoff; a successful poll clears the error and lets
 * paging resume) — and at MAX_RUN_PAGES.
 */
export function shouldLoadMoreRuns(state: {
    hasNextPage: boolean;
    hasCleanRun: boolean;
    isFetching: boolean;
    lastFetchFailed: boolean;
    pagesLoaded: number;
}): boolean {
    return (
        state.hasNextPage &&
        !state.hasCleanRun &&
        !state.isFetching &&
        !state.lastFetchFailed &&
        state.pagesLoaded < MAX_RUN_PAGES
    );
}

/**
 * What to say when the PR has no findings. "Nothing to flag." is only true
 * when the review actually ran: a failed or skipped run also has zero
 * findings, and must not read as a clean pass. An unknown status (the
 * executions query still loading, failed, or no record) claims nothing.
 */
export function emptyFindingsLabel(status?: ReviewRunStatus): {
    text: string;
    tone: "clean" | "danger" | "warning" | "muted";
} {
    switch (status) {
        case "error":
            return { text: "Review failed — nothing to show.", tone: "danger" };
        case "partial_error":
            return {
                text: "Review finished with errors — no findings in what it covered.",
                tone: "warning",
            };
        case "skipped":
            return { text: "Review skipped.", tone: "muted" };
        case "pending":
        case "in_progress":
            return { text: "Review in progress…", tone: "muted" };
        case "success":
            return { text: "Nothing to flag.", tone: "clean" };
        default:
            return { text: "No findings.", tone: "muted" };
    }
}
