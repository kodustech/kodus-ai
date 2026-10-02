import type { PullRequestExecution } from "@services/pull-requests";

export type ReviewRunStatus = NonNullable<
    PullRequestExecution["automationExecution"]
>["status"];

/**
 * The run the empty state speaks for, from the PR's runs newest first. The
 * findings on screen are aggregated across every run, so a later skipped or
 * failed run (a push with incremental review off, a provider hiccup) must not
 * hide a review that did finish clean.
 */
export function effectiveReviewStatus(
    runsNewestFirst: Array<ReviewRunStatus | undefined>,
): ReviewRunStatus | undefined {
    const [latest] = runsNewestFirst;
    if (
        (latest === "error" || latest === "skipped") &&
        runsNewestFirst.includes("success")
    ) {
        return "success";
    }
    return latest;
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
