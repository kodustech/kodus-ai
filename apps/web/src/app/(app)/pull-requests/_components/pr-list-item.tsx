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
    buildReviewDeepLinkUrl,
    usePrefetchPullRequestReview,
    type CodeReviewTimelineItem,
    type PullRequestExecution,
    type ReviewWarning,
    type ReviewWarningKind,
} from "@services/pull-requests";
import type {
    PrRuntime,
    PrRuntimeCell,
} from "@services/runtime/model/pull-request-runs";
import {
    AlertTriangleIcon,
    ArrowRightIcon,
    CheckIcon,
    ChevronDownIcon,
    CircleCheckIcon,
    CircleDashedIcon,
    CircleXIcon,
    ClockIcon,
    ExternalLinkIcon,
    FilterIcon,
    FolderIcon,
    GitBranchIcon,
    GitPullRequestIcon,
    MessageSquareIcon,
    PlayIcon,
    UserIcon,
} from "lucide-react";
import { cn } from "src/core/utils/components";

import { PrCommitTimeline, reviewOutcome } from "./pr-commit-timeline";
import { PrRuntimeColumn } from "./pr-runtime";
import { latestReviewMode, ReviewModeTag } from "./review-mode-tag";
import { getSpecialists, SpecialistAgentsTable } from "./specialist-agents";
import type { PullRequestExecutionGroup } from "./types";

/** The Runtime state of one row: what the viewer may read, and the page's answer for this PR. */
export interface PrRowRuntime {
    /** The viewer may read Runtime Runs of this PR's repository. */
    canRead: boolean;
    data?: PrRuntime;
    /** Absent while the page's Runtime state loads. */
    cell?: PrRuntimeCell;
    /** Asks again for the Runtime state that could not be read. */
    retry?: () => void;
}

interface PrListItemProps {
    group: PullRequestExecutionGroup;
    /** The team the list reads: the expanded row fetches the branch's commits with it. */
    teamId?: string;
    /** The table has a Runtime column; absent for viewers who read no Runtime Runs. */
    showRuntime?: boolean;
    runtime?: PrRowRuntime;
}

// Shared column template for the collapsed row AND the table header in
// pr-data-table.tsx, so the two stay aligned. Fixed trailing columns are
// deterministic across every virtualized row (same container width → same
// widths), and the identity column flexes + truncates. Columns:
// chevron | pull request (identity, grows) | reviews | suggestions | status.
// Identity takes all free space so the three metric columns sit flush at the
// right edge and the grid always fits its container (no trailing slack track,
// which on wide viewports left a large dead zone on the right). Rows and the
// header share this template, so they stay aligned.
export const PR_ROW_GRID =
    "grid grid-cols-[1.25rem_minmax(0,1fr)_8rem_6.5rem_8.5rem] items-center gap-x-4";
// The same template with the Runtime column between suggestions and status,
// for viewers who may read Runtime Runs.
export const PR_ROW_GRID_WITH_RUNTIME =
    "grid grid-cols-[1.25rem_minmax(0,1fr)_8rem_6.5rem_11rem_8.5rem] items-center gap-x-4";

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
const getStatusBadge = (status: string, errorMessage?: string | null) => {
    // Mirrors the automation_execution status values verbatim.
    switch (status) {
        case "success":
            return (
                <Badge variant="success" className="whitespace-nowrap">
                    Success
                </Badge>
            );
        case "error": {
            // Muted outline red — a failed review shouldn't be the loudest thing
            // in the row. When we know why it failed, surface the cause on hover.
            const badge = (
                <Badge
                    variant="helper"
                    className="bg-danger/10 text-danger ring-danger/40 whitespace-nowrap ring-1">
                    Review failed
                </Badge>
            );
            if (!errorMessage) return badge;
            return (
                <Tooltip>
                    <TooltipTrigger asChild>{badge}</TooltipTrigger>
                    <TooltipContent className="max-w-xs text-xs normal-case">
                        {errorMessage}
                    </TooltipContent>
                </Tooltip>
            );
        }
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
    const specialists = getSpecialists(item.metadata);

    return {
        label,
        message: item.message,
        cta,
        partialErrors,
        fileTimings,
        agentTrace,
        specialists,
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

export const PrListItem = ({
    group,
    teamId,
    showRuntime,
    runtime,
}: PrListItemProps) => {
    const { latest, executions, reviewCount } = group;
    const grid = showRuntime ? PR_ROW_GRID_WITH_RUNTIME : PR_ROW_GRID;
    const timezone = useGetTimezone();
    const prefetchReview = usePrefetchPullRequestReview();
    // Warm the review screen's blocking query on intent (hover/focus of a link
    // into it). Idempotent and deduped by a staleTime, so wiring it to several
    // entry points costs nothing extra.
    const prefetchThisReview = () =>
        prefetchReview(latest.repositoryId, latest.prNumber);

    // Status cue on the row's leading edge so a failed review is caught on the
    // first downward scan, not last (it lives in the far-right STATUS column).
    // Saturated color is reserved for actionable failures — every other state
    // (success / merged / skipped / pending) keeps a transparent edge so the
    // list stays quiet and the red/amber bars are the only things that pop.
    const rowStatus = latest.merged
        ? "merged"
        : latest.automationExecution?.status || "pending";
    const rowAccent =
        latest.approvalReasonDeliveryFailure || rowStatus === "error"
            ? "border-l-danger/70"
            : rowStatus === "partial_error"
              ? "border-l-warning/70"
              : "border-l-transparent";
    const [isOpen, setIsOpen] = useState(false);
    const prUrl = buildPullRequestUrl(latest);
    // The review screen already deep-links to a finding via
    // `?file=<path>&suggestion=<id>` (scrolls to it and lights it up). The list
    // only knows counts, so the backend tags each row with the delivered
    // finding that most wants attention; pass it through so the count click
    // lands on that comment instead of the top of a large diff.
    const reviewHref = buildReviewDeepLinkUrl(
        latest.repositoryId,
        latest.prNumber,
        latest.firstSentSuggestion,
    );

    return (
        <div
            className={cn("border-card-lv3/30 border-b border-l-2", rowAccent)}>
            <div
                role="button"
                tabIndex={0}
                className={cn(
                    "cursor-pointer px-5 py-3",
                    grid,
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
                        {/* Title is the row's primary action: it routes to the
                            internal review-detail view and prefetches it on
                            intent. White at rest, the accent only under the
                            pointer: a list of amber titles spends the one
                            accent on every row. stopPropagation
                            keeps a title click a navigation, not a row-expand.
                            The native title attribute surfaces the full text
                            only when it's truncated. */}
                        <NextLink
                            href={`/pull-requests/${latest.repositoryId}/${latest.prNumber}`}
                            title={latest.title}
                            onClick={(e) => e.stopPropagation()}
                            onMouseEnter={prefetchThisReview}
                            onFocus={prefetchThisReview}
                            className="text-text-primary hover:text-primary-light min-w-0 truncate text-sm font-semibold transition-colors hover:underline">
                            {latest.title}
                        </NextLink>
                        {/* Secondary escape hatch: open the PR on its Git
                            provider. Muted at rest so it reads as secondary to
                            the internal title link; labeled for screen readers
                            and hover. */}
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <a
                                    href={prUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    aria-label="Open on Git provider"
                                    onClick={(e) => e.stopPropagation()}
                                    className="text-text-tertiary hover:text-primary-light shrink-0 transition-colors">
                                    <ExternalLinkIcon className="size-3.5" />
                                </a>
                            </TooltipTrigger>
                            <TooltipContent className="text-xs">
                                Open on Git provider
                            </TooltipContent>
                        </Tooltip>
                    </div>

                    <div className="text-text-secondary mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
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
                                {/* A ceiling, not a width: `min-w-0` lets this
                                    shrink and truncate exactly as before when
                                    the row is tight, so the wider cap only
                                    cashes out on screens that have the room.
                                    14rem cut most branch names in half while
                                    the column beside them sat empty. */}
                                <span className="flex max-w-[26rem] min-w-0 items-center gap-1">
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
                        <ReviewModeTag mode={latestReviewMode(executions)} />
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
                        <span className="text-text-secondary truncate">
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
                    href={reviewHref}
                    // Icons and bare numbers give this link no accessible name
                    // of its own; spell out where it goes.
                    aria-label="Open review at the delivered suggestions"
                    onClick={(e) => e.stopPropagation()}
                    onMouseEnter={prefetchThisReview}
                    onFocus={prefetchThisReview}
                    className="hover:bg-card-lv3/40 flex w-fit items-center gap-1.5 rounded-md px-1 py-1 transition-colors">
                    {/* Delivered — check icon disambiguates it from the
                        held-back chip beside it. Green only when there's
                        something to celebrate; a 0 is neutral grey, not green. */}
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <span
                                className={cn(
                                    "inline-flex min-w-7 items-center justify-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium tabular-nums",
                                    latest.suggestionsCount.sent > 0
                                        ? "bg-success/10 text-success"
                                        : "text-text-tertiary",
                                )}>
                                <CheckIcon className="size-3 shrink-0" />
                                {latest.suggestionsCount.sent}
                            </span>
                        </TooltipTrigger>
                        <TooltipContent className="text-xs">
                            Delivered on this PR
                        </TooltipContent>
                    </Tooltip>
                    {/* Held back by config — filter icon. Muted red only when
                        non-zero; a 0 is neutral grey. */}
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <span
                                className={cn(
                                    "inline-flex min-w-7 items-center justify-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium tabular-nums",
                                    latest.suggestionsCount.filtered > 0
                                        ? "bg-danger/10 text-danger"
                                        : "text-text-tertiary",
                                )}>
                                <FilterIcon className="size-3 shrink-0" />
                                {latest.suggestionsCount.filtered}
                            </span>
                        </TooltipTrigger>
                        <TooltipContent className="text-xs">
                            Held back by your review configuration
                        </TooltipContent>
                    </Tooltip>
                </NextLink>

                {/* Runtime column: the latest Runtime Run of this PR. Empty for
                    a repository whose Runs this viewer may not read. */}
                {showRuntime &&
                    (runtime?.canRead ? (
                        <PrRuntimeColumn
                            cell={runtime.cell}
                            repositoryId={latest.repositoryId}
                            prNumber={latest.prNumber}
                            runtime={runtime.data}
                            onRetry={runtime.retry}
                        />
                    ) : (
                        <span aria-hidden />
                    ))}

                {/* The approval notice is separate from review execution status.
                    Keep it visible even if the PR has since been merged. */}
                <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                    {latest.approvalReasonDeliveryFailure && (
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <Badge
                                    tabIndex={0}
                                    variant="helper"
                                    className="bg-danger/10 text-danger ring-danger/40 whitespace-nowrap ring-1">
                                    Approval note unverified
                                </Badge>
                            </TooltipTrigger>
                            <TooltipContent className="max-w-sm text-xs break-words normal-case">
                                Kody could not confirm the{" "}
                                {latest.approvalReasonDeliveryFailure
                                    .decision === "hold"
                                    ? "hold"
                                    : "approval"}{" "}
                                reason appeared on the PR. Kody's reason:{" "}
                                {latest.approvalReasonDeliveryFailure.reason}
                                {
                                    " Check the repository integration permissions and the PR comments."
                                }
                            </TooltipContent>
                        </Tooltip>
                    )}
                    {latest.merged ? (
                        <Badge variant="primary" className="whitespace-nowrap">
                            Merged
                        </Badge>
                    ) : (
                        getStatusBadge(
                            latest.automationExecution?.status || "pending",
                            latest.automationExecution?.errorMessage,
                        )
                    )}
                </div>
            </div>

            {isOpen && (
                <div className="bg-card-lv2/20 border-card-lv3/30 border-t">
                    {/* The section's header: what follows (the PR by
                        commit) and the way into the full review screen,
                        which lives here because the row click is the inline
                        expand. A helper button, not the accent: the amber
                        stays on the title. */}
                    <div className="flex items-center justify-between gap-3 px-5 pt-3 pb-1">
                        <span className="text-text-tertiary text-2xs font-semibold tracking-wide uppercase">
                            By commit
                        </span>
                        <NextLink
                            href={`/pull-requests/${latest.repositoryId}/${latest.prNumber}`}
                            onClick={(e) => e.stopPropagation()}
                            onMouseEnter={prefetchThisReview}
                            onFocus={prefetchThisReview}
                            className={buttonVariants({
                                variant: "helper",
                                size: "xs",
                            })}>
                            Open full review
                            <ArrowRightIcon />
                        </NextLink>
                    </div>
                    <div className="pb-4">
                        <PrCommitTimeline
                            group={group}
                            teamId={teamId}
                            grid={grid}
                            runtime={runtime?.data}
                            hasRuntimeColumn={!!showRuntime}
                            showRuntime={!!showRuntime && !!runtime?.canRead}
                            renderReviewDetail={(execution) => (
                                <ReviewExecutionDetail execution={execution} />
                            )}
                        />
                    </div>
                </div>
            )}
        </div>
    );
};

const StageStatusIcon = ({ status }: { status: string }) => {
    switch (status) {
        case "success":
            return <CircleCheckIcon className="text-success size-4 shrink-0" />;
        case "error":
            return <CircleXIcon className="text-danger size-4 shrink-0" />;
        case "partial_error":
            return (
                <AlertTriangleIcon className="text-warning size-4 shrink-0" />
            );
        case "in_progress":
            return <Spinner className="text-in-progress size-3.5 shrink-0" />;
        case "start":
            return (
                <PlayIcon className="text-text-tertiary size-3.5 shrink-0" />
            );
        default:
            return (
                <CircleDashedIcon className="text-text-tertiary size-4 shrink-0" />
            );
    }
};

/**
 * One review's detail, opened from its commit in the timeline: how it ran,
 * the commit it read, what it ran with less of, and its stages in order.
 */
export const ReviewExecutionDetail = ({
    execution,
}: {
    execution: PullRequestExecution;
}) => {
    const timezone = useGetTimezone();
    const executionOrigin = execution.automationExecution?.origin || "";
    const executionStartedAt =
        execution.automationExecution?.createdAt ?? execution.createdAt;
    const executionFinishedAt =
        execution.automationExecution?.updatedAt ?? execution.updatedAt;
    const executionStatus = execution.automationExecution?.status || "pending";
    const executionDuration = formatDuration(
        executionStartedAt,
        executionStatus === "in_progress" ? undefined : executionFinishedAt,
    );
    const timelineItemsSorted = [...(execution.codeReviewTimeline ?? [])].sort(
        (a, b) => {
            const aTime = Date.parse(a.createdAt ?? "");
            const bTime = Date.parse(b.createdAt ?? "");
            return (
                (Number.isNaN(aTime) ? 0 : aTime) -
                (Number.isNaN(bTime) ? 0 : bTime)
            );
        },
    );

    const outcome = reviewOutcome(execution);
    // Steps that did not run in a row read as one line.
    const stepRows: Array<
        | { kind: "step"; item: (typeof timelineItemsSorted)[number] }
        | { kind: "notRun"; items: typeof timelineItemsSorted }
    > = [];
    for (const item of timelineItemsSorted) {
        const last = stepRows[stepRows.length - 1];
        if (
            item.status === "skipped" &&
            !isAutomationStartMessage(item.message)
        ) {
            if (last?.kind === "notRun") last.items.push(item);
            else stepRows.push({ kind: "notRun", items: [item] });
        } else stepRows.push({ kind: "step", item });
    }

    return (
        <div className="flex flex-col gap-2">
            {execution.reviewWarnings &&
                execution.reviewWarnings.length > 0 && (
                    <ReviewNotices warnings={execution.reviewWarnings} />
                )}
            <ol className="flex flex-col">
                {stepRows.map((row) => {
                    if (row.kind === "notRun")
                        return (
                            <li
                                key={row.items[0].uuid}
                                className="flex items-center gap-2.5 py-1 text-sm">
                                <StageStatusIcon status="skipped" />
                                <span className="text-text-tertiary min-w-0 flex-1 truncate">
                                    {row.items
                                        .map((i) => getStageDisplay(i).label)
                                        .join(", ")}
                                </span>
                                <span className="text-text-tertiary font-mono text-xs">
                                    not run
                                </span>
                            </li>
                        );
                    const { item } = row;
                    const isAutomationStart = isAutomationStartMessage(
                        item.message,
                    );
                    const stageInfo = getStageDisplay(item);
                    const status = isAutomationStart ? "start" : item.status;
                    const failed =
                        item.status === "error" ||
                        item.status === "partial_error";
                    const muted =
                        isAutomationStart || item.status === "skipped";
                    const showMessage =
                        !isAutomationStart &&
                        !!item.message &&
                        item.message.trim() !== stageInfo.label.trim();
                    return (
                        <li key={item.uuid} className="py-1">
                            <div className="flex items-center gap-2.5 text-sm">
                                <StageStatusIcon status={status} />
                                <span
                                    className={cn(
                                        "min-w-0 flex-1 truncate",
                                        muted
                                            ? "text-text-tertiary"
                                            : "text-text-primary",
                                        failed && "font-medium",
                                    )}>
                                    {stageInfo.label}
                                </span>
                                {stageInfo.duration && !isAutomationStart && (
                                    <span
                                        className="text-text-tertiary font-mono text-xs tabular-nums"
                                        title={
                                            item.createdAt
                                                ? `Started ${formatDateTime(item.createdAt, timezone)}`
                                                : undefined
                                        }>
                                        {item.status === "skipped"
                                            ? "not run"
                                            : stageInfo.duration}
                                    </span>
                                )}
                            </div>
                            {showMessage && (
                                <div className="mt-1 flex flex-col gap-1.5 pl-6">
                                    {showMessage &&
                                        (failed ? (
                                            <p className="bg-danger/5 border-danger/25 text-text-secondary rounded-md border px-2.5 py-1.5 font-mono text-xs break-all">
                                                {item.message}
                                            </p>
                                        ) : (
                                            <p className="text-text-tertiary text-xs">
                                                {item.message}
                                            </p>
                                        ))}
                                </div>
                            )}
                            <div className="pl-6">
                                {stageInfo.specialists && (
                                    <SpecialistAgentsTable
                                        rows={stageInfo.specialists}
                                    />
                                )}
                                {stageInfo.agentTrace?.toolSummary && (
                                    <details className="text-text-tertiary mt-1.5 text-xs">
                                        <summary className="cursor-pointer">
                                            {formatToolSummary(
                                                stageInfo.agentTrace
                                                    .toolSummary,
                                            )}
                                        </summary>
                                        {(stageInfo.agentTrace.toolCalls
                                            ?.length ?? 0) > 0 && (
                                            <ul className="mt-2 space-y-1 pl-4">
                                                {stageInfo.agentTrace
                                                    .toolCalls!.slice(
                                                        0,
                                                        MAX_TOOL_CALLS_DISPLAY,
                                                    )
                                                    .map((tc, tcIdx) => (
                                                        <li
                                                            key={tcIdx}
                                                            className="truncate font-mono text-xs">
                                                            {tc.tool}(
                                                            {typeof tc.args ===
                                                            "string"
                                                                ? tc.args
                                                                : JSON.stringify(
                                                                      tc.args,
                                                                  )}
                                                            )
                                                        </li>
                                                    ))}
                                                {stageInfo.agentTrace.toolCalls!
                                                    .length >
                                                    MAX_TOOL_CALLS_DISPLAY && (
                                                    <li className="text-text-tertiary text-xs italic">
                                                        ... and{" "}
                                                        {stageInfo.agentTrace
                                                            .toolCalls!.length -
                                                            MAX_TOOL_CALLS_DISPLAY}{" "}
                                                        more
                                                    </li>
                                                )}
                                            </ul>
                                        )}
                                    </details>
                                )}
                                {failed &&
                                    // A single error is the stage's message already.
                                    stageInfo.partialErrors.length > 1 && (
                                        <details className="text-warning/90 mt-1.5 text-xs">
                                            <summary className="cursor-pointer">
                                                View failed files (
                                                {stageInfo.partialErrors.length}
                                                )
                                            </summary>
                                            <ul className="mt-2 space-y-1 pl-4">
                                                {stageInfo.partialErrors.map(
                                                    (entry) => (
                                                        <li
                                                            key={entry}
                                                            className="text-text-tertiary font-mono text-xs">
                                                            {entry}
                                                        </li>
                                                    ),
                                                )}
                                            </ul>
                                        </details>
                                    )}
                                {stageInfo.fileTimings &&
                                    stageInfo.fileTimings.length > 0 && (
                                        <details className="text-text-tertiary mt-1.5 text-xs">
                                            <summary className="cursor-pointer">
                                                File timings (
                                                {stageInfo.fileTimings.length})
                                            </summary>
                                            <ul className="mt-2 space-y-1 pl-4">
                                                {stageInfo.fileTimings.map(
                                                    (ft) => (
                                                        <li
                                                            key={ft.file}
                                                            className="font-mono text-xs">
                                                            {ft.file} &mdash;{" "}
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
                                        href={stageInfo.cta.href}
                                        target={
                                            stageInfo.cta.external
                                                ? "_blank"
                                                : undefined
                                        }
                                        rel={
                                            stageInfo.cta.external
                                                ? "noopener noreferrer"
                                                : undefined
                                        }
                                        className={cn(
                                            buttonVariants({
                                                variant: "helper",
                                                size: "xs",
                                            }),
                                            "mt-1.5",
                                        )}>
                                        {stageInfo.cta.label}
                                    </NextLink>
                                )}
                            </div>
                        </li>
                    );
                })}
            </ol>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 pl-6 text-xs">
                <span className="text-text-tertiary">
                    Review {outcome.word}
                </span>
                <ReviewModeTag mode={execution.reviewMode} />
                {executionDuration && (
                    <span className="text-text-tertiary tabular-nums">
                        · {executionDuration}
                        {executionStatus === "in_progress" && " so far"}
                    </span>
                )}
                {executionStartedAt && (
                    <span className="text-text-tertiary tabular-nums">
                        ·{" "}
                        <TimeAgoDisplay
                            dateString={executionStartedAt}
                            timezone={timezone}
                        />
                    </span>
                )}
                {executionOrigin && (
                    <span className="text-text-tertiary">
                        · {getOriginLabel(executionOrigin)}
                    </span>
                )}
                {execution.reviewedCommitSha && (
                    <span className="text-text-tertiary">
                        · on{" "}
                        {execution.reviewedCommitUrl ? (
                            <Link
                                href={execution.reviewedCommitUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-text-secondary hover:text-primary-light font-mono">
                                {formatSha(execution.reviewedCommitSha)}
                            </Link>
                        ) : (
                            <span className="text-text-secondary font-mono">
                                {formatSha(execution.reviewedCommitSha)}
                            </span>
                        )}
                    </span>
                )}
            </div>
        </div>
    );
};

const WARNING_KIND_LABEL: Record<ReviewWarningKind, string> = {
    PROMPT_COMPACTED: "Compact system prompt (workflow + most rules trimmed)",
    CALLGRAPH_DROPPED: "Pre-computed call graph omitted",
    HUNK_HEADERS_ONLY:
        "File diffs sent as hunk headers only; agent reads on demand",
    DIFF_TRUNCATED: "Long file diffs truncated",
    LOW_SIGNAL_FILES_DROPPED: "Low-signal files (tests, docs, styles) dropped",
    HEAVY_PASSES_SKIPPED: "Verifier / second-chance / rescue passes skipped",
    // Rendered by ProviderFallbackNotice, not the fidelity list — label kept
    // for exhaustiveness.
    PROVIDER_FALLBACK: "Main provider failed; ran on fallback",
    RULE_CONTEXT_UNAVAILABLE:
        "Kody Rules not evaluated (repository context unavailable)",
    BAD_FIX_DOWNGRADED: "Unusable fixes posted as plain comments",
    SANDBOX_UNAVAILABLE: "Reviewed the diff only (repository not checked out)",
    CALLGRAPH_FAILED: "Call graph unavailable",
    SUGGESTIONS_DROPPED_PATH_MISMATCH:
        "Findings dropped (file not in the pull request)",
    KODY_RULES_PARTIAL: "Some Kody Rules checks failed to run",
    VERIFY_UNAVAILABLE: "Findings not posted (verification failed to run)",
    SKILL_NOT_FOUND: "Linked skill not found on the target branch",
    SKILL_INVALID: "Linked skill skipped (invalid skill format)",
    SKILL_CHANGED_IN_PR:
        "Skill or doc edited in this PR (target-branch version used)",
    DOC_NOT_FOUND: "Linked doc not found on the target branch",
    KNOWLEDGE_TRUNCATED: "Skills or docs cut to fit their budget",
    KNOWLEDGE_UNAVAILABLE:
        "Reviewed without skills and docs (could not be read)",
    SKILL_COMPATIBILITY: "Skill requirements may not be met by the reviewer",
    CLI_INSTALL_FAILED: "Custom agent ran without a CLI",
    CROSS_REPO_UNAVAILABLE:
        "Linked repositories not read (repository not checked out)",
    AST_GREP_UNAVAILABLE: "Custom agent ran without ast-grep",
    CONFIG_FILE_KEY_IGNORED: "kodus-config.yml key ignored (set in the app)",
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
export const ReviewNotices = ({ warnings }: { warnings: ReviewWarning[] }) => {
    const fallbackWarnings = warnings.filter(
        (w) => w.kind === "PROVIDER_FALLBACK",
    );
    // Only a small context window is a "fidelity" counter-measure; the other
    // causes would otherwise render under "has a context window of 0 tokens".
    const fidelityWarnings = warnings.filter(
        (w) =>
            w.kind !== "PROVIDER_FALLBACK" &&
            w.reason === "small_context_window",
    );
    const degradedWarnings = warnings.filter(
        (w) =>
            w.kind !== "PROVIDER_FALLBACK" &&
            w.reason !== "small_context_window",
    );
    return (
        <>
            {fallbackWarnings.length > 0 && (
                <ProviderFallbackNotice warnings={fallbackWarnings} />
            )}
            {fidelityWarnings.length > 0 && (
                <ReviewFidelityNotice warnings={fidelityWarnings} />
            )}
            {degradedWarnings.length > 0 && (
                <ReviewDegradedNotice warnings={degradedWarnings} />
            )}
        </>
    );
};

/**
 * The review succeeded but worked with less than it should have: no
 * repository checkout, no call graph, findings or rules that were dropped.
 * Each line names what was lost; none of it is shown on the pull request.
 */
const ReviewDegradedNotice = ({ warnings }: { warnings: ReviewWarning[] }) => {
    const seen = new Set<string>();
    const unique = warnings.filter((w) => {
        const key = `${w.kind}::${w.detail ?? ""}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
    return (
        <div className="border-warning/30 bg-warning/5 mb-4 rounded-lg border p-3">
            <div className="mb-2 flex items-center gap-2">
                <AlertTriangleIcon className="text-warning size-4 shrink-0" />
                <span className="text-text-primary text-sm font-medium">
                    Review ran with less context
                </span>
            </div>
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
