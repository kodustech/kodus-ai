"use client";

import { Card } from "@components/ui/card";
import { Skeleton } from "@components/ui/skeleton";
import type { BusinessLogicStatus } from "@services/business-logic/types";
import {
    CircleCheckIcon,
    CircleDashedIcon,
    PauseCircleIcon,
} from "lucide-react";
import { cn } from "src/core/utils/components";

const ago = (iso: string) => {
    const minutes = Math.max(
        0,
        Math.round((Date.now() - new Date(iso).getTime()) / 60_000),
    );
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 48) return `${hours} h ago`;
    return `${Math.round(hours / 24)} days ago`;
};

const REASONS: Record<string, string> = {
    task_not_found: "task doesn't exist",
    task_missing: "typo in the reference",
    tracker_unavailable: "tracker didn't answer",
    no_capable_tracker: "no connected tracker reads the reference",
    task_too_thin: "task too thin to check",
};

/**
 * Is it working, and why a PR wasn't read (UC-06, UC-07). How PRs did
 * against their tasks is the Cockpit's; this card answers the admin
 * setting it up.
 */
export const StatusStrip = ({
    status,
    isLoading,
}: {
    status?: BusinessLogicStatus;
    isLoading: boolean;
}) => {
    if (isLoading) {
        return <Skeleton className="h-14 w-full rounded-xl" />;
    }
    if (!status) {
        return null;
    }
    const paused = status.state === "paused";
    const idle = status.state === "idle";
    const { pullRequestsChecked, couldntRead, couldntReadByReason } =
        status.stats;
    const why = Object.entries(couldntReadByReason)
        .sort((a, b) => b[1] - a[1])
        .map(([reason, count]) => `${count} ${REASONS[reason] ?? reason}`)
        .join(" · ");

    return (
        <Card
            color="lv1"
            className={cn(
                "flex flex-col gap-1.5 px-5 py-3.5",
                paused && "ring-warning/40 ring-1",
            )}>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                {paused ? (
                    <PauseCircleIcon className="text-warning size-4" />
                ) : idle ? (
                    <CircleDashedIcon className="text-text-tertiary size-4" />
                ) : (
                    <CircleCheckIcon className="text-success size-4" />
                )}
                <span className="text-text-primary font-medium">
                    {paused
                        ? `Paused · ${status.paused?.tracker} isn't answering since ${new Date(status.paused!.since).toLocaleString()}`
                        : idle
                          ? "No pull request checked in the last 30 days"
                          : "Working"}
                </span>
                {paused && (
                    <span className="text-text-secondary">
                        · {status.paused?.uncheckedPullRequests} PRs
                        weren&apos;t checked. They are re-checked once it
                        answers.
                    </span>
                )}
                {!paused && !idle && (
                    <span className="text-text-secondary">
                        {status.lastTaskRead &&
                            `· last task read ${ago(status.lastTaskRead.at)} (${status.lastTaskRead.id}) `}
                        · {pullRequestsChecked}{" "}
                        {pullRequestsChecked === 1 ? "PR" : "PRs"} in 30 days
                    </span>
                )}
            </div>

            {idle && (
                <p className="text-text-secondary pl-6 text-sm">
                    Kody checks a pull request when its title, branch or
                    description names a task, e.g. SAA-96. Try one below, or
                    comment <code>@kody -v business-logic</code> on a pull
                    request.
                </p>
            )}
            {couldntRead > 0 && (
                <p className="text-text-secondary pl-6 text-xs">
                    {couldntRead} couldn&apos;t be read
                    {why ? `: ${why}` : ""}
                </p>
            )}
        </Card>
    );
};
