import { Badge } from "@components/ui/badge";
import type { PullRequestExecution } from "@services/pull-requests";

type ReviewMode = NonNullable<PullRequestExecution["reviewMode"]>;

const LABELS: Record<ReviewMode, string> = {
    balanced: "Balanced",
    heavy: "Heavy",
    ultra: "Ultra",
};

/** The mode of the most recent execution that reviewed; a skipped one has none. */
export const latestReviewMode = (
    executions: PullRequestExecution[],
): ReviewMode | undefined => executions.find((e) => e.reviewMode)?.reviewMode;

export const ReviewModeTag = ({ mode }: { mode?: ReviewMode }) => {
    if (!mode) return null;
    return (
        <Badge
            variant={mode === "balanced" ? "helper" : "primary-dark"}
            className="whitespace-nowrap"
            title={`Reviewed in ${LABELS[mode].toLowerCase()} mode`}>
            {LABELS[mode]}
        </Badge>
    );
};
