"use client";

import { useEffect, useState } from "react";
import NextLink from "next/link";
import { Badge } from "@components/ui/badge";
import { buttonVariants } from "@components/ui/button";
import { Link } from "@components/ui/link";
import { Spinner } from "@components/ui/spinner";
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@components/ui/tooltip";
import { useGetTimezone } from "@services/organizationParameters/hooks";
import {
    buildPullRequestUrl,
    usePrefetchPullRequestReview,
    type CodeReviewTimelineItem,
    type ReviewWarning,
    type ReviewWarningKind,
} from "@services/pull-requests";
import {
    AlertTriangleIcon,
    ArrowRightIcon,
    ChevronDownIcon,
    ClockIcon,
    ExternalLinkIcon,
    FolderIcon,
    GitBranchIcon,
    GitPullRequestIcon,
    MessageSquareIcon,
    UserIcon,
} from "lucide-react";
import { cn } from "src/core/utils/components";

import type { PullRequestExecutionGroup } from "./types";

interface PrListItemProps {
    group: PullRequestExecutionGroup;
}

// Shared column template for the collapsed row AND the table header in
// pr-data-table.tsx, so the two stay aligned. Fixed trailing columns are
// deterministic across every virtualized row (same container width → same
// widths), and the identity column flexes + truncates. Columns:
// chevron | pull request (identity) | reviews | suggestions | status.
export const PR_ROW_GRID =
    "grid grid-cols-[1.25rem_minmax(0,1fr)_8rem_6.5rem_8.5rem] items-center gap-x-4";

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

    // Deferred on purpose: SSR renders the raw timestamp, then the client swaps
    // to relative time ("2 hours ago") after mount. formatTimeAgo() reads
    // `new Date()`, so computing it during render would hydration-mismatch.
    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect
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

// The review-run status (automation_execution / code_review_execution share the
// same AutomationStatus enum). PR merge-state is rendered separately — it must
// not mask whether the review itself succeeded or errored.
const getStatusBadge = (status: string) => {
    // Mirrors the automation_execution status values verbatim.
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

const getAgentTrace = (metadata?: any) => {
    if (!metadata || typeof metadata !== "object") return null;
    const trace = metadata.agentTrace;
    if (!trace || typeof trace !== "object") return null;
    return trace as {
        steps?: number;
        findings?: number;
        durationMs?: number;
        totalTokens?: number;
        toolCalls?: Array<{ tool: string; args: string }>;
        toolSummary?: Record<string, number>;
    };
};

const formatToolSummary = (toolSummary: Record<string, number>): string => {
    const total = Object.values(toolSummary).reduce((a, b) => a + b, 0);
    const parts = Object.entries(toolSummary)
        .sort(([, a], [, b]) => b - a)
        .map(([tool, count]) => `${tool}: ${count}`)
        .join(", ");
    return `${total} tool call${total !== 1 ? "s" : ""} (${parts})`;
};

const MAX_TOOL_CALLS_DISPLAY = 20;

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
    const agentTrace = getAgentTrace(item.metadata);

    return {
        label,
        message: item.message,
        cta,
        partialErrors,
        fileTimings,
        agentTrace,
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
    const prefetchReview = usePrefetchPullRequestReview();
    // Warm the review screen's blocking query on intent (hover/focus of a link
    // into it). Idempotent and deduped by a staleTime, so wiring it to several
    // entry points costs nothing extra.
    const prefetchThisReview = () =>
        prefetchReview(latest.repositoryId, latest.prNumber);
    const [isOpen, setIsOpen] = useState(false);
    const [collapsedReviews, setCollapsedReviews] = useState<Set<number>>(
        () => new Set(executions.slice(1).map((_, i) => i + 1)),
    );
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

    return (
        <div className="border-card-lv3/30 border-b">
            <div
                role="button"
                tabIndex={0}
                className={cn(
                    "cursor-pointer px-5 py-4",
                    PR_ROW_GRID,
                    isOpen
                        ? "bg-card-lv2/40 hover:bg-card-lv2/50"
                        : "hover:bg-card-lv1/70",
                )}
                onClick={() => setIsOpen(!isOpen)}>
                <ChevronDownIcon
                    className={cn(
                        "text-text-tertiary size-4 shrink-0 transition-transform duration-200",
                        isOpen && "text-text-secondary rotate-180",
                    )}
                />

                {/* Identity column: PR# + title (links out to the provider) with
                    a metadata subline (repo · branch · opened · author). Keeps
                    the card richness inside a single aligned table column. */}
                <div className="min-w-0">
                    <div className="flex min-w-0 items-center gap-2">
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <span className="text-text-secondary flex shrink-0 items-center gap-1 font-mono text-xs tabular-nums">
                                    <GitPullRequestIcon className="size-3.5 shrink-0" />
                                    #{latest.prNumber}
                                </span>
                            </TooltipTrigger>
                            <TooltipContent className="text-xs">
                                Pull request number
                            </TooltipContent>
                        </Tooltip>
                        {/* Native title attribute instead of a Radix tooltip:
                            the tooltip rendered the full title in a box directly
                            over the title itself (redundant + overlapping). The
                            browser tooltip only surfaces when the text is actually
                            truncated and never overlaps the row. */}
                        {/* External link to the PR on the provider. The ↗ is
                            always visible (not hover-revealed) so the title
                            reads as a link at rest; hover adds the DS accent +
                            underline. Title stays text-primary so the list isn't
                            a wall of accent color — the icon carries the "opens
                            elsewhere" signal. */}
                        <Link
                            href={prUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            title={latest.title}
                            className="text-text-primary hover:text-primary-light group/title flex min-w-0 items-center gap-1.5 text-sm font-semibold hover:underline"
                            onClick={(e) => e.stopPropagation()}>
                            <span className="truncate">{latest.title}</span>
                            <ExternalLinkIcon className="text-text-tertiary group-hover/title:text-primary-light size-3.5 shrink-0 transition-colors" />
                        </Link>
                    </div>

                    <div className="text-text-secondary mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                        {/* Field-name tooltips on the icon-only metadata. The
                            shared TooltipContent now portals to <body>, so these
                            no longer clip against the scroll container / sticky
                            header. */}
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <span className="flex max-w-[16rem] min-w-0 items-center gap-1">
                                    <FolderIcon className="size-3 shrink-0" />
                                    <span className="truncate">
                                        {latest.repositoryName}
                                    </span>
                                </span>
                            </TooltipTrigger>
                            <TooltipContent className="text-xs">
                                Repository
                            </TooltipContent>
                        </Tooltip>
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <span className="flex max-w-[14rem] min-w-0 items-center gap-1">
                                    <GitBranchIcon className="size-3 shrink-0" />
                                    <span className="truncate font-mono">
                                        {latest.headBranchRef}
                                    </span>
                                </span>
                            </TooltipTrigger>
                            <TooltipContent className="text-xs">
                                Source branch
                            </TooltipContent>
                        </Tooltip>
                        {/* "opened" already carries its own label + the
                            TimeAgoDisplay tooltip shows the exact date. */}
                        <span className="flex items-center gap-1 tabular-nums">
                            <ClockIcon className="size-3 shrink-0" />
                            <span>
                                opened{" "}
                                <TimeAgoDisplay
                                    dateString={latest.createdAt}
                                    timezone={timezone}
                                />
                            </span>
                        </span>
                        {latest.author?.name && (
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <span className="flex min-w-0 items-center gap-1">
                                        <UserIcon className="size-3 shrink-0" />
                                        <span className="max-w-[12rem] truncate">
                                            {latest.author.name}
                                        </span>
                                    </span>
                                </TooltipTrigger>
                                <TooltipContent className="text-xs">
                                    Author
                                </TooltipContent>
                            </Tooltip>
                        )}
                    </div>
                </div>

                {/* Reviews column: how many times Kody reviewed this PR and how
                    recently — the core "is the review keeping up?" signal.
                    Labeled by the table header. */}
                <div className="text-text-secondary flex min-w-0 flex-col gap-0.5 text-xs tabular-nums">
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <span className="text-text-primary flex w-fit items-center gap-1 font-medium">
                                <MessageSquareIcon className="text-text-tertiary size-3.5 shrink-0" />
                                {reviewCount}
                            </span>
                        </TooltipTrigger>
                        <TooltipContent className="text-xs">
                            {reviewCount === 1
                                ? "1 Kody review on this PR"
                                : `${reviewCount} Kody reviews on this PR`}
                        </TooltipContent>
                    </Tooltip>
                    {latest.automationExecution?.createdAt && (
                        <span className="text-text-tertiary truncate">
                            <TimeAgoDisplay
                                dateString={
                                    latest.automationExecution.createdAt
                                }
                                timezone={timezone}
                            />
                        </span>
                    )}
                </div>

                {/* Suggestions column: delivered (green) / filtered (red),
                    straight from the code_review_execution counts. Both always
                    shown so "0 / 0" reads as "reviewed, nothing to send" — not
                    as missing data. */}
                <NextLink
                    href={`/pull-requests/${latest.repositoryId}/${latest.prNumber}`}
                    onClick={(e) => e.stopPropagation()}
                    onMouseEnter={prefetchThisReview}
                    onFocus={prefetchThisReview}
                    className="hover:bg-card-lv3/40 flex w-fit items-center gap-1.5 rounded-md px-1 py-1 transition-colors">
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <span className="bg-success/10 text-success inline-flex min-w-7 items-center justify-center rounded-md px-2 py-0.5 text-xs font-medium tabular-nums">
                                {latest.suggestionsCount.sent}
                            </span>
                        </TooltipTrigger>
                        <TooltipContent className="text-xs">
                            Suggestions delivered on this PR
                        </TooltipContent>
                    </Tooltip>
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <span className="bg-danger/10 text-danger inline-flex min-w-7 items-center justify-center rounded-md px-2 py-0.5 text-xs font-medium tabular-nums">
                                {latest.suggestionsCount.filtered}
                            </span>
                        </TooltipTrigger>
                        <TooltipContent className="text-xs">
                            Held back by your review configuration
                        </TooltipContent>
                    </Tooltip>
                </NextLink>

                {/* Status column — "Merged" is a terminal state: a merged PR
                    reads as "Merged", full stop (no review-status chip stacked
                    next to it). Only when the PR is NOT merged do we surface the
                    review-run status (success/error/skipped/…). "Heavy" (review
                    ran in heavy mode) shows in either case. */}
                <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                    {latest.merged ? (
                        <Badge variant="primary" className="whitespace-nowrap">
                            Merged
                        </Badge>
                    ) : (
                        getStatusBadge(
                            latest.automationExecution?.status || "pending",
                        )
                    )}
                    {latest.heavy && (
                        <Badge variant="helper" title="Reviewed in heavy mode">
                            Heavy
                        </Badge>
                    )}
                </div>
            </div>

            {isOpen && (
                <div className="bg-card-lv2/20">
                    <div className="px-4 pt-2 pb-6">
                        {/* Quiet entry into the full review screen. Lives
                                here (not on the row/title) because the row click
                                is the inline expand and the title links out to
                                the provider. Kept low-key — a text link, not a
                                filled button — so it reads as "there's more"
                                without competing with the timeline below. */}
                        <div className="mt-1 mb-1 flex justify-end">
                            <NextLink
                                href={`/pull-requests/${latest.repositoryId}/${latest.prNumber}`}
                                onClick={(e) => e.stopPropagation()}
                                onMouseEnter={prefetchThisReview}
                                onFocus={prefetchThisReview}
                                className="text-text-tertiary hover:text-primary-light inline-flex items-center gap-1 text-xs font-medium transition-colors">
                                Open full review
                                <ArrowRightIcon className="size-3.5" />
                            </NextLink>
                        </div>
                        <div className="pt-2">
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
                                    // Always show all timeline items including agent traces (secondary)
                                    const timelineItems =
                                        execution.codeReviewTimeline;
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
                                                    {execution.reviewWarnings &&
                                                        execution.reviewWarnings
                                                            .length > 0 && (
                                                            <ReviewNotices
                                                                warnings={
                                                                    execution.reviewWarnings
                                                                }
                                                            />
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
                                                                                {stageInfo.agentTrace &&
                                                                                    stageInfo
                                                                                        .agentTrace
                                                                                        .toolSummary && (
                                                                                        <details className="text-text-tertiary mt-2 text-xs">
                                                                                            <summary className="cursor-pointer">
                                                                                                {formatToolSummary(
                                                                                                    stageInfo
                                                                                                        .agentTrace
                                                                                                        .toolSummary,
                                                                                                )}
                                                                                            </summary>
                                                                                            {stageInfo
                                                                                                .agentTrace
                                                                                                .toolCalls &&
                                                                                                stageInfo
                                                                                                    .agentTrace
                                                                                                    .toolCalls
                                                                                                    .length >
                                                                                                    0 && (
                                                                                                    <ul className="mt-2 space-y-1 pl-4">
                                                                                                        {stageInfo.agentTrace.toolCalls
                                                                                                            .slice(
                                                                                                                0,
                                                                                                                MAX_TOOL_CALLS_DISPLAY,
                                                                                                            )
                                                                                                            .map(
                                                                                                                (
                                                                                                                    tc,
                                                                                                                    tcIdx,
                                                                                                                ) => (
                                                                                                                    <li
                                                                                                                        key={
                                                                                                                            tcIdx
                                                                                                                        }
                                                                                                                        className="truncate font-mono text-xs">
                                                                                                                        {
                                                                                                                            tc.tool
                                                                                                                        }

                                                                                                                        (
                                                                                                                        {typeof tc.args ===
                                                                                                                        "string"
                                                                                                                            ? tc.args
                                                                                                                            : JSON.stringify(
                                                                                                                                  tc.args,
                                                                                                                              )}

                                                                                                                        )
                                                                                                                    </li>
                                                                                                                ),
                                                                                                            )}
                                                                                                        {stageInfo
                                                                                                            .agentTrace
                                                                                                            .toolCalls
                                                                                                            .length >
                                                                                                            MAX_TOOL_CALLS_DISPLAY && (
                                                                                                            <li className="text-text-tertiary text-xs italic">
                                                                                                                ...
                                                                                                                and{" "}
                                                                                                                {stageInfo
                                                                                                                    .agentTrace
                                                                                                                    .toolCalls
                                                                                                                    .length -
                                                                                                                    MAX_TOOL_CALLS_DISPLAY}{" "}
                                                                                                                more
                                                                                                            </li>
                                                                                                        )}
                                                                                                    </ul>
                                                                                                )}
                                                                                        </details>
                                                                                    )}
                                                                                {(item.status ===
                                                                                    "partial_error" ||
                                                                                    item.status ===
                                                                                        "error") &&
                                                                                    // Only render the collapsible when there
                                                                                    // are multiple distinct errors — for a
                                                                                    // single error the stage's top-level
                                                                                    // message already shows it, and the
                                                                                    // collapsible just repeats the same text.
                                                                                    stageInfo
                                                                                        .partialErrors
                                                                                        .length >
                                                                                        1 && (
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
                    </div>
                </div>
            )}
        </div>
    );
};

const WARNING_KIND_LABEL: Record<ReviewWarningKind, string> = {
    PROMPT_COMPACTED: "Compact system prompt (workflow + most rules trimmed)",
    CALLGRAPH_DROPPED: "Pre-computed call graph omitted",
    HUNK_HEADERS_ONLY:
        "File diffs sent as hunk headers only; agent reads on demand",
    DIFF_TRUNCATED: "Long file diffs truncated to fit the window",
    LOW_SIGNAL_FILES_DROPPED: "Low-signal files (tests, docs, styles) dropped",
    HEAVY_PASSES_SKIPPED: "Verifier / second-chance / rescue passes skipped",
    // Rendered by ProviderFallbackNotice, not the fidelity list — label kept
    // for exhaustiveness.
    PROVIDER_FALLBACK: "Main provider failed; ran on fallback",
};

/**
 * Admin-only notice surfaced inside the expanded execution row when the
 * agent pipeline emitted adaptive-fit warnings (small context window
 * forced a degraded review path). Intentionally NOT shown to PR authors
 * in the GitHub comment — see commentManager.service.ts.
 */
/**
 * Splits review notices by category so a provider failover (the review ran on
 * the BYOK fallback because main failed) isn't mislabeled as a context-window
 * "fidelity reduced" degradation. Renders each category with its own framing.
 */
const ReviewNotices = ({ warnings }: { warnings: ReviewWarning[] }) => {
    const fallbackWarnings = warnings.filter(
        (w) => w.kind === "PROVIDER_FALLBACK",
    );
    const fidelityWarnings = warnings.filter(
        (w) => w.kind !== "PROVIDER_FALLBACK",
    );
    return (
        <>
            {fallbackWarnings.length > 0 && (
                <ProviderFallbackNotice warnings={fallbackWarnings} />
            )}
            {fidelityWarnings.length > 0 && (
                <ReviewFidelityNotice warnings={fidelityWarnings} />
            )}
        </>
    );
};

/**
 * The BYOK main provider failed and the review completed on the configured
 * fallback. Not a fidelity/context-window issue — the review ran at full
 * fidelity, just on a different provider.
 */
const ProviderFallbackNotice = ({
    warnings,
}: {
    warnings: ReviewWarning[];
}) => {
    const seen = new Set<string>();
    const unique = warnings.filter((w) => {
        if (seen.has(w.modelName)) return false;
        seen.add(w.modelName);
        return true;
    });
    return (
        <div className="border-warning/30 bg-warning/5 mb-4 rounded-lg border p-3">
            <div className="mb-2 flex items-center gap-2">
                <AlertTriangleIcon className="text-warning size-4 shrink-0" />
                <span className="text-text-primary text-sm font-medium">
                    Ran on fallback provider
                </span>
            </div>
            <ul className="text-text-secondary space-y-1 text-xs">
                {unique.map((w, idx) => (
                    <li key={`fallback-${idx}`} className="flex gap-1.5">
                        <span className="text-text-tertiary">•</span>
                        <span>
                            {w.detail ??
                                `Review ran on fallback model ${w.modelName}.`}
                        </span>
                    </li>
                ))}
            </ul>
        </div>
    );
};

const ReviewFidelityNotice = ({ warnings }: { warnings: ReviewWarning[] }) => {
    // Group by (kind, modelName, contextWindowTokens) so the same warning
    // emitted by multiple agents collapses into one bullet. The backend
    // already dedups in the orchestrator, but executions persisted
    // before that dedup landed (or future per-agent agentName variance)
    // could still produce duplicates here.
    const seen = new Set<string>();
    const unique = warnings.filter((w) => {
        const key = `${w.kind}::${w.modelName}::${w.contextWindowTokens}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
    const head = unique[0];
    return (
        <div className="border-warning/30 bg-warning/5 mb-4 rounded-lg border p-3">
            <div className="mb-2 flex items-center gap-2">
                <AlertTriangleIcon className="text-warning size-4 shrink-0" />
                <span className="text-text-primary text-sm font-medium">
                    Review fidelity reduced
                </span>
            </div>
            <p className="text-text-tertiary mb-2 text-xs leading-snug">
                Model{" "}
                <code className="text-text-secondary font-mono">
                    {head.modelName}
                </code>{" "}
                has a context window of{" "}
                <span className="tabular-nums">
                    {head.contextWindowTokens.toLocaleString()}
                </span>{" "}
                tokens — the pipeline applied the following counter-measures to
                fit:
            </p>
            <ul className="text-text-secondary space-y-1 text-xs">
                {unique.map((w, idx) => (
                    <li key={`${w.kind}-${idx}`} className="flex gap-1.5">
                        <span className="text-text-tertiary">•</span>
                        <span>
                            {WARNING_KIND_LABEL[w.kind] ?? w.kind}
                            {w.detail && (
                                <span className="text-text-tertiary">
                                    {" "}
                                    ({w.detail})
                                </span>
                            )}
                        </span>
                    </li>
                ))}
            </ul>
        </div>
    );
};
