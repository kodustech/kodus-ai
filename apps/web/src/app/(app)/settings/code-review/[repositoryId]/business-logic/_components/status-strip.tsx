"use client";

import { Card } from "@components/ui/card";
import { Skeleton } from "@components/ui/skeleton";
import type { BusinessLogicStatus } from "@services/business-logic/types";
import { CircleCheckIcon, PauseCircleIcon } from "lucide-react";
import { cn } from "src/core/utils/components";

const percent = (value?: number) =>
    value === undefined ? "—" : `${Math.round(value * 100)}%`;

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
    task_not_found: "the referenced task doesn't exist",
    task_missing: "the reference looks like a typo",
    tracker_unavailable: "the tracker didn't answer",
    no_capable_tracker: "no connected tracker reads that kind of reference",
    task_too_thin: "the task has too little in it",
};

/** Is it working, and what happened in the last 30 days (UC-06, UC-07). */
export const StatusStrip = ({
    status,
    isLoading,
}: {
    status?: BusinessLogicStatus;
    isLoading: boolean;
}) => {
    if (isLoading) {
        return <Skeleton className="h-24 w-full rounded-xl" />;
    }
    if (!status) {
        return null;
    }
    const paused = status.state === "paused";
    const why = Object.entries(status.stats.couldntReadByReason)
        .sort((a, b) => b[1] - a[1])
        .map(([reason, count]) => `${count}: ${REASONS[reason] ?? reason}`)
        .join(" · ");

    return (
        <Card
            color="lv1"
            className={cn(
                "flex flex-col gap-3 px-5 py-4",
                paused && "ring-warning/40 ring-1",
            )}>
            <div className="flex flex-wrap items-center gap-2 text-sm">
                {paused ? (
                    <PauseCircleIcon className="text-warning size-4" />
                ) : (
                    <CircleCheckIcon className="text-success size-4" />
                )}
                <span className="text-text-primary font-medium">
                    {paused
                        ? `Paused · ${status.paused?.tracker} isn't answering since ${new Date(status.paused!.since).toLocaleString()}`
                        : status.state === "idle"
                          ? "Not used yet"
                          : "Working"}
                </span>
                {!paused && status.lastTaskRead && (
                    <span className="text-text-secondary">
                        · last task read {ago(status.lastTaskRead.at)} (
                        {status.lastTaskRead.id})
                    </span>
                )}
                {paused && (
                    <span className="text-text-secondary">
                        · {status.paused?.uncheckedPullRequests} PRs
                        weren&apos;t checked. They are re-checked once it
                        answers.
                    </span>
                )}
            </div>

            <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
                <div>
                    <dt className="text-text-secondary text-xs">PRs checked</dt>
                    <dd className="text-text-primary text-lg font-semibold">
                        {status.stats.pullRequestsChecked}
                    </dd>
                </div>
                <div>
                    <dt className="text-text-secondary text-xs">
                        Met their task
                    </dt>
                    <dd className="text-text-primary text-lg font-semibold">
                        {percent(status.stats.metRate)}
                    </dd>
                </div>
                <div>
                    <dt className="text-text-secondary text-xs">
                        Findings devs agreed with
                    </dt>
                    <dd className="text-text-primary text-lg font-semibold">
                        {percent(status.stats.agreedRate)}
                    </dd>
                </div>
                <div>
                    <dt className="text-text-secondary text-xs">
                        Couldn&apos;t read
                    </dt>
                    <dd
                        className="text-text-primary text-lg font-semibold"
                        title={why || undefined}>
                        {status.stats.couldntRead}
                    </dd>
                </div>
            </dl>
            {why && <p className="text-text-secondary text-xs">Why: {why}</p>}
            <p className="text-text-tertiary text-xs">Last 30 days</p>
        </Card>
    );
};
