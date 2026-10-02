import type { PullRequestExecution } from "@services/pull-requests";

export type ReviewRunStatus = NonNullable<
    PullRequestExecution["automationExecution"]
>["status"];

/**
 * What to say when the PR has no findings. "Nothing to flag." is only true
 * when the review actually ran: a failed or skipped run also has zero
 * findings, and must not read as a clean pass. Unknown status (no execution
 * record) keeps the old behaviour.
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
        default:
            return { text: "Nothing to flag.", tone: "clean" };
    }
}
