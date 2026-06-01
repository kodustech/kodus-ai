import { Badge } from "@components/ui/badge";

import type { CliReviewStatus } from "@services/cli-reviews/types";

const STATUS_VARIANT: Record<
    CliReviewStatus,
    {
        variant: React.ComponentProps<typeof Badge>["variant"];
        label: string;
    }
> = {
    in_progress: { variant: "in-progress", label: "In progress" },
    pending: { variant: "tertiary", label: "Pending" },
    success: { variant: "success", label: "Success" },
    error: { variant: "error", label: "Error" },
    skipped: { variant: "helper", label: "Skipped" },
    partial_error: { variant: "secondary", label: "Partial" },
};

export function CliReviewStatusBadge({
    status,
}: {
    status: CliReviewStatus;
}) {
    const cfg = STATUS_VARIANT[status] ?? STATUS_VARIANT.in_progress;
    return <Badge variant={cfg.variant}>{cfg.label}</Badge>;
}
