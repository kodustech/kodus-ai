"use client";

import NextLink from "next/link";
import { Badge } from "@components/ui/badge";
import { Link } from "@components/ui/link";
import { Skeleton } from "@components/ui/skeleton";
import {
    usePullRequestsAwaiting,
    type AwaitingPullRequest,
} from "@services/pull-requests";
import {
    ClockIcon,
    ExternalLinkIcon,
    GitPullRequestIcon,
    UserIcon,
} from "lucide-react";

const formatDate = (iso: string) => {
    try {
        return new Date(iso).toLocaleDateString("en-CA");
    } catch {
        return iso;
    }
};

export const AwaitingList = ({ teamId }: { teamId: string }) => {
    const { data, isLoading } = usePullRequestsAwaiting(teamId);

    if (isLoading) {
        return (
            <div className="border-card-lv3/40 bg-card-lv1/50 divide-card-lv3/30 flex flex-col divide-y overflow-hidden rounded-xl border">
                {Array.from({ length: 5 }).map((_, i) => (
                    <div key={i} className="flex items-start gap-3 px-5 py-4">
                        <Skeleton className="mt-1 size-4 shrink-0 rounded" />
                        <div className="flex-1 space-y-2">
                            <Skeleton className="h-4 w-2/5" />
                            <Skeleton className="h-3 w-3/5" />
                        </div>
                    </div>
                ))}
            </div>
        );
    }

    if (!data?.length) {
        return (
            <div className="border-card-lv3/40 bg-card-lv1/50 flex flex-col items-center justify-center gap-3 rounded-xl border py-16 text-center">
                <div className="bg-card-lv2/60 text-text-tertiary flex size-11 items-center justify-center rounded-full">
                    <ClockIcon className="size-5" />
                </div>
                <p className="text-text-secondary text-sm">
                    No open pull requests are awaiting review. 🎉
                </p>
            </div>
        );
    }

    return (
        <div className="border-card-lv3/40 bg-card-lv1/50 divide-card-lv3/30 flex flex-col divide-y overflow-hidden rounded-xl border">
            {data.map((pr: AwaitingPullRequest) => (
                <div
                    key={pr.prId}
                    className="hover:bg-card-lv1/70 flex items-start gap-3 px-5 py-4 transition-colors">
                    <GitPullRequestIcon className="text-text-tertiary mt-0.5 size-4 shrink-0" />
                    <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                            <span className="text-text-tertiary shrink-0 font-mono text-xs tabular-nums">
                                #{pr.prNumber}
                            </span>
                            <Link
                                href={pr.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-text-primary hover:text-primary-light group/title flex min-w-0 items-center gap-1.5 text-sm font-semibold hover:underline">
                                <span className="truncate">{pr.title}</span>
                                <ExternalLinkIcon className="text-text-tertiary size-3 shrink-0 opacity-0 transition-opacity group-hover/title:opacity-100" />
                            </Link>
                        </div>
                        <div className="text-text-tertiary mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                            <span className="text-text-secondary max-w-[16rem] truncate">
                                {pr.repositoryName}
                            </span>
                            {pr.author?.name && (
                                <span className="flex items-center gap-1">
                                    <UserIcon className="size-3 shrink-0" />
                                    {pr.author.name}
                                </span>
                            )}
                            <span className="tabular-nums">
                                opened {formatDate(pr.openedAt)}
                            </span>
                        </div>
                    </div>
                    {/* These PRs were triggered but skipped by config (no
                        license / BYOK / manual cadence) and never reviewed —
                        same "Skipped" badge the main list uses for status. */}
                    <Badge
                        variant="helper"
                        className="shrink-0 whitespace-nowrap"
                        title="Kody was triggered but skipped this PR by configuration (no license, BYOK, or manual/paused cadence)">
                        Skipped
                    </Badge>
                </div>
            ))}
        </div>
    );
};
