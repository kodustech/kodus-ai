"use client";

import { Fragment, useEffect, useState } from "react";
import NextLink from "next/link";
import { Badge } from "@components/ui/badge";
import { buttonVariants } from "@components/ui/button";
import { Link } from "@components/ui/link";
import { Spinner } from "@components/ui/spinner";
import { TableCell, TableRow } from "@components/ui/table";
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@components/ui/tooltip";
import { useGetTimezone } from "@services/organizationParameters/hooks";
import {
    buildPullRequestUrl,
    type CodeReviewTimelineItem,
} from "@services/pull-requests";
import { ChevronDownIcon, ExternalLinkIcon, GitBranchIcon } from "lucide-react";
import { cn } from "src/core/utils/components";

import type { PullRequestExecutionGroup } from "./types";

interface PrListItemProps {
    group: PullRequestExecutionGroup;
}

const formatDateTime = (dateString: string, timezone: string | null) => {
    const tz = timezone || "UTC";
    try {
        const date = new Date(dateString);
        const year = date.toLocaleString("en-CA", {
            timeZone: tz,
            year: "numeric",
        });
        const month = date.toLocaleString("en-CA", {
            timeZone: tz,
            month: "2-digit",
        });
        const day = date.toLocaleString("en-CA", {
            timeZone: tz,
            day: "2-digit",
        });
        const hour = date.toLocaleString("en-GB", {
            timeZone: tz,
            hour: "2-digit",
            hour12: false,
        });
        const minute = date.toLocaleString("en-GB", {
            timeZone: tz,
            minute: "2-digit",
        });
        return `${year}-${month}-${day} ${hour}:${minute.padStart(2, "0")}`;
    } catch {
        return dateString;
    }
};

const formatTimeAgo = (dateString: string) => {
    const now = new Date();
    const date = new Date(dateString);
    const diffInMs = now.getTime() - date.getTime();
    const diffInMinutes = Math.floor(diffInMs / (1000 * 60));
    const diffInHours = Math.floor(diffInMinutes / 60);
    const diffInDays = Math.floor(diffInHours / 24);
    const diffInWeeks = Math.floor(diffInDays / 7);
    const diffInMonths = Math.floor(diffInDays / 30);

    if (diffInMinutes < 1) return "less than 1 minute ago";
    if (diffInMinutes < 60)
        return `${diffInMinutes} minute${diffInMinutes > 1 ? "s" : ""} ago`;
    if (diffInHours < 24)
        return `${diffInHours} hour${diffInHours > 1 ? "s" : ""} ago`;
    if (diffInDays < 7)
        return `${diffInDays} day${diffInDays > 1 ? "s" : ""} ago`;
    if (diffInWeeks < 4)
        return `${diffInWeeks} week${diffInWeeks > 1 ? "s" : ""} ago`;
    return `${diffInMonths} month${diffInMonths > 1 ? "s" : ""} ago`;
};

const TimeAgoDisplay = ({
    dateString,
    timezone,
}: {
    dateString: string;
    timezone: string | null;
}) => {
    const [displayedTime, setDisplayedTime] = useState(dateString);

    useEffect(() => {
        setDisplayedTime(formatTimeAgo(dateString));
    }, [dateString]);

    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <span className="cursor-default">{displayedTime}</span>
            </TooltipTrigger>
            <TooltipContent className="text-xs">
                {formatDateTime(dateString, timezone)}
            </TooltipContent>
        </Tooltip>
    );
};

const formatDuration = (start: string, end?: string | null) => {
    const startMs = Date.parse(start);
    const endMs = end ? Date.parse(end) : Date.now();

    if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
        return null;
    }

    const diffMs = Math.max(0, endMs - startMs);
    if (diffMs < 1000) {
        if (diffMs === 0) return "<1s";
        return `${Math.max(1, Math.round(diffMs))}ms`;
    }

    const totalSeconds = Math.floor(diffMs / 1000);
    const seconds = totalSeconds % 60;
    const totalMinutes = Math.floor(totalSeconds / 60);
    const minutes = totalMinutes % 60;
    const totalHours = Math.floor(totalMinutes / 60);
    const hours = totalHours % 24;
    const days = Math.floor(totalHours / 24);

    if (days > 0) {
        return `${days}d ${hours}h`;
    }

    if (totalHours > 0) {
        return `${totalHours}h ${minutes}m`;
    }

    if (totalMinutes > 0) {
        return `${totalMinutes}m ${seconds}s`;
    }

    return `${seconds}s`;
};

const getStatusBadge = (status: string, merged: boolean) => {
    if (merged) {
        return (
            <Badge variant="primary" className="whitespace-nowrap">
                Merged
            </Badge>
        );
    }

    switch (status) {
        case "success":
            return (
                <Badge variant="success" className="whitespace-nowrap">
                    Success
                </Badge>
            );
        case "error":
            return (
                <Badge variant="error" className="whitespace-nowrap">
                    Error
                </Badge>
            );
        case "in_progress":
            return (
                <Badge variant="in-progress" className="whitespace-nowrap">
                    In Progress
                </Badge>
            );
        case "skipped":
            return (
                <Badge variant="helper" className="whitespace-nowrap">
                    Skipped
                </Badge>
            );
        case "partial_error":
            return (
                <Badge
                    variant="helper"
                    className="bg-warning/10 text-warning ring-warning/40 whitespace-nowrap ring-1">
                    Partial Error
                </Badge>
            );
        case "pending":
            return (
                <Badge variant="helper" className="whitespace-nowrap">
                    Pending
                </Badge>
            );
        default:
            return (
                <Badge variant="helper" className="whitespace-nowrap">
                    {status}
                </Badge>
            );
    }
};

const getTimelineStatusColor = (status: string) => {
    switch (status) {
        case "success":
            return "bg-success border-success";
        case "error":
            return "bg-error border-error";
        case "in_progress":
            return "bg-in-progress border-in-progress";
        case "skipped":
            return "bg-card-lv2 border-border";
        case "partial_error":
            return "bg-warning border-warning";
        default:
            return "bg-card-lv2 border-border";
    }
};

const formatStageName = (raw: string) => {
    return raw
        .replace(/Stage$/i, "")
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .trim();
};

const normalizeStageLabel = (label: string) => {
    const trimmed = label.trim();
    if (!trimmed) return trimmed;

    if (/[a-z][A-Z]/.test(trimmed) || /Stage$/i.test(trimmed)) {
        return formatStageName(trimmed);
    }

    return trimmed;
};

const formatSha = (sha?: string | null) => {
    if (!sha) return null;
    return sha.length > 8 ? sha.slice(0, 7) : sha;
};

const getMetadataCta = (
    metadata?: CodeReviewTimelineItem["metadata"] | null,
): { label: string; href: string; external?: boolean } | null => {
    if (!metadata || typeof metadata !== "object") return null;
    const cta = (metadata as Record<string, any>).cta;
    if (!cta || typeof cta !== "object") return null;
    if (typeof cta.label !== "string" || typeof cta.href !== "string") {
        return null;
    }

    return {
        label: cta.label,
        href: cta.href,
        external: Boolean(cta.external),
    };
};

const getPartialErrors = (
    metadata?: CodeReviewTimelineItem["metadata"] | null,
): string[] => {
    if (!metadata || typeof metadata !== "object") return [];
    const raw = (metadata as Record<string, any>).partialErrors;
    if (!Array.isArray(raw)) return [];

    return raw
        .map((entry) => {
            if (typeof entry === "string") return entry;
            if (entry && typeof entry === "object") {
                const file =
                    entry.path ||
                    entry.file ||
                    entry.filename ||
                    entry.name ||
                    "";
                const message = entry.message || entry.error || "";
                const timeoutTag = entry.isTimeout ? " \u23F1" : "";

                if (file && message) {
                    return `${file} — ${message}${timeoutTag}`;
                }

                return file || message || JSON.stringify(entry);
            }
            return null;
        })
        .filter((value): value is string => Boolean(value && value.trim()))
        .map((value) => value.trim());
};

const formatFileTime = (ms: number): string => {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    const mins = Math.floor(ms / 60000);
    const secs = Math.round((ms % 60000) / 1000);
    return `${mins}m ${secs.toString().padStart(2, "0")}s`;
};

const getFileTimings = (
    metadata?: CodeReviewTimelineItem["metadata"] | null,
): Array<{ file: string; durationMs: number; status: string }> | null => {
    if (!metadata || typeof metadata !== "object") return null;
    const raw = (metadata as Record<string, any>).fileTimings;
    if (!Array.isArray(raw) || raw.length === 0) return null;
    return raw;
};

const getStageDisplay = (item: CodeReviewTimelineItem) => {
    const labelFromMetadata =
        item.metadata &&
        typeof item.metadata === "object" &&
        typeof (item.metadata as Record<string, any>).label === "string" &&
        (item.metadata as Record<string, any>).label.trim()
            ? (item.metadata as Record<string, any>).label.trim()
            : null;
    const labelFromStage = item.stageLabel
        ? normalizeStageLabel(item.stageLabel)
        : null;
    const label =
        labelFromMetadata ||
        labelFromStage ||
        (item.stageName ? formatStageName(item.stageName) : item.message);
    const cta = getMetadataCta(item.metadata);
    const partialErrors = getPartialErrors(item.metadata);
    const fileTimings = getFileTimings(item.metadata);

    return {
        label,
        message: item.message,
        cta,
        partialErrors,
        fileTimings,
        visibility:
            item.metadata && typeof item.metadata === "object"
                ? (item.metadata as Record<string, any>).visibility
                : undefined,
        duration: formatDuration(
            item.createdAt,
            item.status === "in_progress"
                ? undefined
                : (item.finishedAt ?? item.updatedAt ?? item.createdAt),
        ),
    };
};

const getOriginLabel = (origin: string) => {
    const o = origin?.toLowerCase?.() || "";
    if (o === "system") return "Automatic";
    if (o === "command") return "User Command";
    return origin;
};

const isAutomationStartMessage = (message: string) => {
    const m = message?.toLowerCase?.() || "";
    return m.includes("automation") && m.includes("start");
};

export const PrListItem = ({ group }: PrListItemProps) => {
    const { latest, executions, reviewCount } = group;
    const timezone = useGetTimezone();
    const [isOpen, setIsOpen] = useState(false);
    const [collapsedReviews, setCollapsedReviews] = useState<Set<number>>(
        () => new Set(executions.slice(1).map((_, i) => i + 1)),
    );
    const [debugVisibleByExecution, setDebugVisibleByExecution] = useState<
        Record<string, boolean>
    >({});
    const prUrl = buildPullRequestUrl(latest);

    const toggleReview = (index: number) => {
        setCollapsedReviews((prev) => {
            const next = new Set(prev);
            if (next.has(index)) {
                next.delete(index);
            } else {
                next.add(index);
            }
            return next;
        });
    };

    const toggleDebugVisibility = (key: string) => {
        setDebugVisibleByExecution((prev) => ({
            ...prev,
            [key]: !prev[key],
        }));
    };

    return (
        <Fragment>
            <TableRow
                className={cn(
                    "cursor-pointer",
                    isOpen
                        ? "bg-card-lv2/40 hover:bg-card-lv2/50"
                        : "hover:bg-card-lv1/70",
                )}
                onClick={() => setIsOpen(!isOpen)}>
                <TableCell className="w-8 px-4">
                    <ChevronDownIcon
                        className={cn(
                            "text-text-tertiary size-4 shrink-0 transition-transform duration-200",
                            isOpen && "text-text-secondary rotate-180",
                        )}
                    />
                </TableCell>
                <TableCell className="text-text-secondary w-20 font-mono text-sm tabular-nums">
                    #{latest.prNumber}
                </TableCell>
                <TableCell className="max-w-[360px]">
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Link
                                href={prUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-text-primary hover:text-primary-light flex max-w-[360px] items-center gap-1.5 font-medium hover:underline"
                                onClick={(e) => e.stopPropagation()}>
                                <span className="truncate">{latest.title}</span>
                                <ExternalLinkIcon className="text-text-tertiary size-3 shrink-0" />
                            </Link>
                        </TooltipTrigger>
                        <TooltipContent className="max-w-sm">
                            {latest.title}
                        </TooltipContent>
                    </Tooltip>
                </TableCell>
                <TableCell className="w-32">
                    <span className="text-text-secondary block truncate text-sm">
                        {latest.repositoryName}
                    </span>
                </TableCell>
                <TableCell className="w-40">
                    <div className="text-text-tertiary flex w-full max-w-[10rem] items-center gap-1.5 text-sm">
                        <GitBranchIcon className="size-3 shrink-0" />
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <span className="truncate font-mono text-xs">
                                    {latest.headBranchRef}
                                </span>
                            </TooltipTrigger>
                            <TooltipContent>
                                {latest.headBranchRef}
                            </TooltipContent>
                        </Tooltip>
                    </div>
                </TableCell>
                <TableCell className="w-40">
                    <span className="text-text-secondary block truncate text-sm">
                        {latest.author.name}
                    </span>
                </TableCell>
                <TableCell className="w-20 text-center">
                    <span className="text-text-primary text-sm font-medium tabular-nums">
                        {reviewCount}
                    </span>
                </TableCell>
                <TableCell className="w-32">
                    <span className="text-text-tertiary text-sm tabular-nums">
                        <TimeAgoDisplay
                            dateString={latest.createdAt}
                            timezone={timezone}
                        />
                    </span>
                </TableCell>
                <TableCell className="w-20 text-center">
                    <NextLink
                        href={`/pull-requests/${latest.repositoryId}/${latest.prNumber}`}
                        onClick={(e) => e.stopPropagation()}
                        className="hover:bg-card-lv3/50 flex justify-center gap-1.5 rounded-md px-1 py-0.5 transition-colors">
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <span className="bg-success/10 text-success inline-flex min-w-7 items-center justify-center rounded-md px-2 py-0.5 text-xs font-medium tabular-nums">
                                    {latest.suggestionsCount.sent}
                                </span>
                            </TooltipTrigger>
                            <TooltipContent className="text-xs">
                                View review details
                            </TooltipContent>
                        </Tooltip>
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <span className="bg-danger/10 text-danger inline-flex min-w-7 items-center justify-center rounded-md px-2 py-0.5 text-xs font-medium tabular-nums">
                                    {latest.suggestionsCount.filtered}
                                </span>
                            </TooltipTrigger>
                            <TooltipContent className="text-xs">
                                Suggestions filtered out by your configuration
                            </TooltipContent>
                        </Tooltip>
                    </NextLink>
                </TableCell>
                <TableCell className="w-32 text-center">
                    {getStatusBadge(
                        latest.automationExecution?.status || "pending",
                        latest.merged,
                    )}
                </TableCell>
            </TableRow>

            {isOpen && (
                <TableRow className="hover:bg-transparent">
                    <TableCell
                        colSpan={10}
                        className="border-b-card-lv3/60 bg-card-lv2/20 px-4 pt-2 pb-6">
                        <div className="ml-10 pt-2">
                            <div className="space-y-3">
                                {executions.map((execution, index) => {
                                    const executionKey =
                                        execution.executionId ||
                                        execution.automationExecution?.uuid ||
                                        `${execution.prId}-${execution.automationExecution?.createdAt ?? execution.updatedAt ?? execution.createdAt}-${index}`;
                                    const executionOrigin =
                                        execution.automationExecution?.origin ||
                                        "";
                                    const executionStartedAt =
                                        execution.automationExecution
                                            ?.createdAt ?? execution.createdAt;
                                    const executionFinishedAt =
                                        execution.automationExecution
                                            ?.updatedAt ?? execution.updatedAt;
                                    const executionDuration = formatDuration(
                                        executionStartedAt,
                                        executionFinishedAt,
                                    );
                                    const executionStatus =
                                        execution.automationExecution?.status ||
                                        "pending";
                                    const isReviewCollapsed =
                                        collapsedReviews.has(index);
                                    const hasSecondarySteps =
                                        execution.codeReviewTimeline.some(
                                            (item) =>
                                                item.metadata &&
                                                typeof item.metadata ===
                                                    "object" &&
                                                (
                                                    item.metadata as Record<
                                                        string,
                                                        any
                                                    >
                                                ).visibility === "secondary",
                                        );
                                    const isDebugVisible =
                                        debugVisibleByExecution[executionKey] ??
                                        false;
                                    const timelineItems = isDebugVisible
                                        ? execution.codeReviewTimeline
                                        : execution.codeReviewTimeline.filter(
                                              (item) =>
                                                  !(
                                                      item.metadata &&
                                                      typeof item.metadata ===
                                                          "object" &&
                                                      (
                                                          item.metadata as Record<
                                                              string,
                                                              any
                                                          >
                                                      ).visibility ===
                                                          "secondary"
                                                  ),
                                          );
                                    const timelineItemsSorted = [
                                        ...timelineItems,
                                    ].sort((a, b) => {
                                        const aTime = Date.parse(
                                            a.createdAt ?? "",
                                        );
                                        const bTime = Date.parse(
                                            b.createdAt ?? "",
                                        );
                                        const safeATime = Number.isNaN(aTime)
                                            ? 0
                                            : aTime;
                                        const safeBTime = Number.isNaN(bTime)
                                            ? 0
                                            : bTime;

                                        return safeATime - safeBTime;
                                    });

                                    return (
                                        <div
                                            key={executionKey}
                                            className="border-card-lv3/50 bg-card-lv1/60 rounded-xl border">
                                            <button
                                                type="button"
                                                className="flex w-full cursor-pointer items-center justify-between gap-2 p-4"
                                                onClick={() =>
                                                    toggleReview(index)
                                                }>
                                                <div className="flex flex-wrap items-center gap-2.5">
                                                    <ChevronDownIcon
                                                        className={cn(
                                                            "text-text-tertiary size-4 shrink-0 transition-transform duration-200",
                                                            !isReviewCollapsed &&
                                                                "text-text-secondary rotate-180",
                                                        )}
                                                    />
                                                    <span className="text-text-primary text-sm font-semibold tabular-nums">
                                                        Review{" "}
                                                        {reviewCount - index}
                                                    </span>
                                                    {getStatusBadge(
                                                        executionStatus,
                                                        false,
                                                    )}
                                                    {executionDuration && (
                                                        <span className="text-text-tertiary text-xs tabular-nums">
                                                            {executionStatus ===
                                                            "in_progress"
                                                                ? "Elapsed: "
                                                                : "Duration: "}
                                                            {executionDuration}
                                                        </span>
                                                    )}
                                                </div>
                                                {executionStartedAt && (
                                                    <span className="text-text-tertiary text-xs tabular-nums">
                                                        <TimeAgoDisplay
                                                            dateString={
                                                                executionStartedAt
                                                            }
                                                            timezone={timezone}
                                                        />
                                                    </span>
                                                )}
                                            </button>
                                            {!isReviewCollapsed && (
                                                <div className="border-card-lv3/30 border-t px-4 pt-3 pb-4">
                                                    {(execution.reviewedCommitSha ||
                                                        execution.reviewedCommitUrl) && (
                                                        <div className="mb-4 flex flex-wrap items-center gap-3 text-xs">
                                                            {execution.reviewedCommitUrl ? (
                                                                <Link
                                                                    href={
                                                                        execution.reviewedCommitUrl
                                                                    }
                                                                    target="_blank"
                                                                    rel="noopener noreferrer"
                                                                    className="text-text-secondary hover:text-primary-light font-mono">
                                                                    {formatSha(
                                                                        execution.reviewedCommitSha,
                                                                    ) ||
                                                                        "View commit"}
                                                                </Link>
                                                            ) : (
                                                                execution.reviewedCommitSha && (
                                                                    <span className="text-text-secondary font-mono">
                                                                        {formatSha(
                                                                            execution.reviewedCommitSha,
                                                                        )}
                                                                    </span>
                                                                )
                                                            )}
                                                        </div>
                                                    )}
                                                    {hasSecondarySteps && (
                                                        <div className="mb-3 flex justify-end">
                                                            <button
                                                                type="button"
                                                                className={buttonVariants(
                                                                    {
                                                                        variant:
                                                                            "helper",
                                                                        size: "xs",
                                                                    },
                                                                )}
                                                                onClick={(
                                                                    event,
                                                                ) => {
                                                                    event.stopPropagation();
                                                                    toggleDebugVisibility(
                                                                        executionKey,
                                                                    );
                                                                }}>
                                                                {isDebugVisible
                                                                    ? "Hide Debug/Technical Steps"
                                                                    : "Show Debug/Technical Steps"}
                                                            </button>
                                                        </div>
                                                    )}
                                                    <div className="relative pl-6">
                                                        <div className="bg-card-lv3/70 absolute top-2 left-[0.5625rem] h-[calc(100%-0.75rem)] w-px" />
                                                        <div className="space-y-3">
                                                            {timelineItemsSorted.map(
                                                                (item) => {
                                                                    const isActiveStage =
                                                                        item.status ===
                                                                            "in_progress" &&
                                                                        !isAutomationStartMessage(
                                                                            item.message,
                                                                        );
                                                                    const stageInfo =
                                                                        getStageDisplay(
                                                                            item,
                                                                        );
                                                                    const isAutomationStart =
                                                                        isAutomationStartMessage(
                                                                            item.message,
                                                                        );

                                                                    return (
                                                                        <div
                                                                            key={
                                                                                item.uuid
                                                                            }
                                                                            className={cn(
                                                                                "group flex gap-3",
                                                                                isActiveStage &&
                                                                                    "border-in-progress bg-card-lv2/60 rounded-lg border-l-2 px-3 py-2",
                                                                            )}>
                                                                            <div className="relative flex w-4 justify-center">
                                                                                <span
                                                                                    className={cn(
                                                                                        "mt-1.5 size-2.5 rounded-full border-2",
                                                                                        isActiveStage &&
                                                                                            "size-3",
                                                                                        getTimelineStatusColor(
                                                                                            isAutomationStart
                                                                                                ? "skipped"
                                                                                                : item.status,
                                                                                        ),
                                                                                    )}
                                                                                />
                                                                            </div>
                                                                            <div className="min-w-0 flex-1 py-0.5">
                                                                                <div className="mb-0.5 flex flex-wrap items-center gap-2">
                                                                                    <span
                                                                                        className={cn(
                                                                                            "text-sm",
                                                                                            isAutomationStart
                                                                                                ? "text-text-tertiary"
                                                                                                : "text-text-primary font-medium",
                                                                                        )}>
                                                                                        {
                                                                                            stageInfo.label
                                                                                        }
                                                                                    </span>
                                                                                    {!isAutomationStart &&
                                                                                        item.status ===
                                                                                            "in_progress" && (
                                                                                            <Spinner className="text-in-progress size-3" />
                                                                                        )}
                                                                                    {!isAutomationStart &&
                                                                                        getStatusBadge(
                                                                                            item.status,
                                                                                            false,
                                                                                        )}
                                                                                    {executionOrigin &&
                                                                                        isAutomationStart && (
                                                                                            <Tooltip>
                                                                                                <TooltipTrigger
                                                                                                    asChild>
                                                                                                    <span className="text-text-tertiary text-xs whitespace-nowrap">
                                                                                                        ·{" "}
                                                                                                        {getOriginLabel(
                                                                                                            executionOrigin,
                                                                                                        )}
                                                                                                    </span>
                                                                                                </TooltipTrigger>
                                                                                                <TooltipContent className="text-xs">
                                                                                                    {executionOrigin?.toLowerCase?.() ===
                                                                                                    "system"
                                                                                                        ? "Triggered automatically by system"
                                                                                                        : "Triggered by user command"}
                                                                                                </TooltipContent>
                                                                                            </Tooltip>
                                                                                        )}
                                                                                </div>
                                                                                <p className="text-text-tertiary text-xs">
                                                                                    {
                                                                                        stageInfo.message
                                                                                    }
                                                                                </p>
                                                                                {stageInfo.duration &&
                                                                                    !isAutomationStart && (
                                                                                        <p className="text-text-tertiary text-xs tabular-nums">
                                                                                            {item.status ===
                                                                                            "in_progress"
                                                                                                ? "Elapsed: "
                                                                                                : "Duration: "}
                                                                                            {
                                                                                                stageInfo.duration
                                                                                            }
                                                                                        </p>
                                                                                    )}
                                                                                {item.createdAt &&
                                                                                    !isAutomationStart && (
                                                                                        <p className="text-text-tertiary text-xs tabular-nums">
                                                                                            Started:{" "}
                                                                                            {formatDateTime(
                                                                                                item.createdAt,
                                                                                                timezone,
                                                                                            )}
                                                                                        </p>
                                                                                    )}
                                                                                {item.status ===
                                                                                    "partial_error" &&
                                                                                    stageInfo
                                                                                        .partialErrors
                                                                                        .length >
                                                                                        0 && (
                                                                                        <details className="text-warning/90 mt-2 text-xs">
                                                                                            <summary className="cursor-pointer">
                                                                                                View
                                                                                                failed
                                                                                                files
                                                                                                (
                                                                                                {
                                                                                                    stageInfo
                                                                                                        .partialErrors
                                                                                                        .length
                                                                                                }

                                                                                                )
                                                                                            </summary>
                                                                                            <ul className="mt-2 space-y-1 pl-4">
                                                                                                {stageInfo.partialErrors.map(
                                                                                                    (
                                                                                                        entry,
                                                                                                    ) => (
                                                                                                        <li
                                                                                                            key={
                                                                                                                entry
                                                                                                            }
                                                                                                            className="text-text-tertiary font-mono text-xs">
                                                                                                            {
                                                                                                                entry
                                                                                                            }
                                                                                                        </li>
                                                                                                    ),
                                                                                                )}
                                                                                            </ul>
                                                                                        </details>
                                                                                    )}
                                                                                {stageInfo.fileTimings &&
                                                                                    stageInfo
                                                                                        .fileTimings
                                                                                        .length >
                                                                                        0 && (
                                                                                        <details className="text-text-tertiary mt-2 text-xs">
                                                                                            <summary className="cursor-pointer">
                                                                                                File
                                                                                                timings
                                                                                                (
                                                                                                {
                                                                                                    stageInfo
                                                                                                        .fileTimings
                                                                                                        .length
                                                                                                }

                                                                                                )
                                                                                            </summary>
                                                                                            <ul className="mt-2 space-y-1 pl-4">
                                                                                                {stageInfo.fileTimings.map(
                                                                                                    (
                                                                                                        ft,
                                                                                                    ) => (
                                                                                                        <li
                                                                                                            key={
                                                                                                                ft.file
                                                                                                            }
                                                                                                            className="font-mono text-xs">
                                                                                                            {
                                                                                                                ft.file
                                                                                                            }{" "}
                                                                                                            &mdash;{" "}
                                                                                                            {formatFileTime(
                                                                                                                ft.durationMs,
                                                                                                            )}{" "}
                                                                                                            {ft.status ===
                                                                                                            "timeout"
                                                                                                                ? "\u23F1 timeout"
                                                                                                                : ft.status ===
                                                                                                                    "error"
                                                                                                                  ? "\u2717"
                                                                                                                  : "\u2713"}
                                                                                                        </li>
                                                                                                    ),
                                                                                                )}
                                                                                            </ul>
                                                                                        </details>
                                                                                    )}
                                                                                {stageInfo.cta && (
                                                                                    <NextLink
                                                                                        href={
                                                                                            stageInfo
                                                                                                .cta
                                                                                                .href
                                                                                        }
                                                                                        target={
                                                                                            stageInfo
                                                                                                .cta
                                                                                                .external
                                                                                                ? "_blank"
                                                                                                : undefined
                                                                                        }
                                                                                        rel={
                                                                                            stageInfo
                                                                                                .cta
                                                                                                .external
                                                                                                ? "noopener noreferrer"
                                                                                                : undefined
                                                                                        }
                                                                                        className={cn(
                                                                                            buttonVariants(
                                                                                                {
                                                                                                    variant:
                                                                                                        "helper",
                                                                                                    size: "xs",
                                                                                                },
                                                                                            ),
                                                                                            "mt-1.5",
                                                                                        )}>
                                                                                        {
                                                                                            stageInfo
                                                                                                .cta
                                                                                                .label
                                                                                        }
                                                                                    </NextLink>
                                                                                )}
                                                                            </div>
                                                                        </div>
                                                                    );
                                                                },
                                                            )}
                                                        </div>
                                                    </div>
                                                </div>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    </TableCell>
                </TableRow>
            )}
        </Fragment>
    );
};
