"use client";

import { Fragment, useMemo, useState } from "react";
import {
    ChevronDownIcon,
    GitBranchIcon,
    GitCommitIcon,
    ListFilterIcon,
    TerminalIcon,
    XIcon,
} from "lucide-react";

import { Badge } from "@components/ui/badge";
import { Button } from "@components/ui/button";
import { Input } from "@components/ui/input";
import { Label } from "@components/ui/label";
import { Page } from "@components/ui/page";
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "@components/ui/popover";
import { Spinner } from "@components/ui/spinner";
import {
    Table,
    TableBody,
    TableCell,
    TableContainer,
    TableHead,
    TableHeader,
    TableRow,
} from "@components/ui/table";
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@components/ui/tooltip";
import {
    useCliReviewDetail,
    useInfiniteCliReviews,
} from "@services/cli-reviews/hooks";
import type {
    CliReviewIssue,
    CliReviewStatus,
    CliReviewSummary,
    CliReviewTimelineItem,
} from "@services/cli-reviews/types";
import { cn } from "src/core/utils/components";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";

const TABLE_COL_COUNT = 9;

function formatRelative(iso: string): string {
    const date = new Date(iso);
    const diffMs = Date.now() - date.getTime();
    const sec = Math.round(diffMs / 1000);
    if (sec < 60) return `${sec}s ago`;
    const min = Math.round(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.round(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const days = Math.round(hr / 24);
    if (days < 7) return `${days}d ago`;
    return date.toLocaleDateString();
}

function formatDuration(ms?: number | null): string {
    if (ms == null || !Number.isFinite(ms)) return "—";
    if (ms < 1000) return `${ms}ms`;
    const sec = Math.round(ms / 1000);
    if (sec < 60) return `${sec}s`;
    const min = Math.floor(sec / 60);
    const rem = sec % 60;
    return rem ? `${min}m ${rem}s` : `${min}m`;
}

function formatStageRange(start: string, end?: string | null): string | null {
    const startMs = Date.parse(start);
    const endMs = end ? Date.parse(end) : Date.now();
    if (Number.isNaN(startMs) || Number.isNaN(endMs)) return null;
    return formatDuration(Math.max(0, endMs - startMs));
}

function shortSha(sha?: string | null): string | null {
    if (!sha) return null;
    return sha.substring(0, 7);
}

function repoLabel(row: CliReviewSummary): string | null {
    if (row.repositoryName) return row.repositoryName;
    if (!row.git?.remote) return null;
    try {
        const cleaned = row.git.remote
            .replace(/\.git$/, "")
            .replace(/\/$/, "");
        const parts = cleaned.split(/[/:]/).filter(Boolean);
        if (parts.length >= 2) return parts.slice(-2).join("/");
    } catch {
        // fall through
    }
    return null;
}

function formatStageName(raw: string): string {
    return raw
        .replace(/Stage$/i, "")
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .replace(/::/g, " · ")
        .replace(/_/g, " ")
        .trim();
}

function normalizeStageLabel(label: string): string {
    const trimmed = label.trim();
    if (!trimmed) return trimmed;
    if (/[a-z][A-Z]/.test(trimmed) || /Stage$/i.test(trimmed)) {
        return formatStageName(trimmed);
    }
    return trimmed;
}

function stageDisplay(item: CliReviewTimelineItem) {
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

    return {
        label,
        message: item.message,
        duration: formatStageRange(
            item.createdAt,
            item.status === "in_progress"
                ? undefined
                : item.finishedAt ?? item.updatedAt,
        ),
        agentTrace: getAgentTrace(item.metadata),
        visibility:
            item.metadata && typeof item.metadata === "object"
                ? (item.metadata as Record<string, any>).visibility
                : undefined,
    };
}

function getAgentTrace(metadata?: unknown) {
    if (!metadata || typeof metadata !== "object") return null;
    const trace = (metadata as Record<string, any>).agentTrace;
    if (!trace || typeof trace !== "object") return null;
    return trace as {
        steps?: number;
        findings?: number;
        durationMs?: number;
        totalTokens?: number;
        toolCalls?: Array<{ tool: string; args: string | object }>;
        toolSummary?: Record<string, number>;
    };
}

function formatToolSummary(toolSummary: Record<string, number>): string {
    const total = Object.values(toolSummary).reduce((a, b) => a + b, 0);
    const parts = Object.entries(toolSummary)
        .sort(([, a], [, b]) => b - a)
        .map(([tool, count]) => `${tool}: ${count}`)
        .join(", ");
    return `${total} tool call${total !== 1 ? "s" : ""} (${parts})`;
}

function formatTimelineDateTime(iso?: string | null): string {
    if (!iso) return "—";
    try {
        return new Date(iso).toLocaleString();
    } catch {
        return iso;
    }
}

const MAX_TOOL_CALLS_DISPLAY = 20;

function getSuggestionsPreview(metadata?: unknown): CliReviewIssue[] {
    if (!metadata || typeof metadata !== "object") return [];
    const raw = (metadata as Record<string, any>).suggestionsPreview;
    if (!Array.isArray(raw)) return [];
    return raw.map((s) => ({
        file: s?.relevantFile,
        line: s?.relevantLinesStart,
        severity: s?.severity,
        category: s?.label,
        title: s?.oneSentenceSummary,
    }));
}

function timelineDotColor(status: string): string {
    switch (status) {
        case "success":
            return "bg-success border-success";
        case "error":
            return "bg-danger border-danger";
        case "in_progress":
        case "pending":
            return "bg-card-lv1 border-primary-light";
        case "skipped":
            return "bg-card-lv2 border-card-lv3";
        case "partial_error":
            return "bg-warning border-warning";
        default:
            return "bg-card-lv2 border-card-lv3";
    }
}

function statusBadge(status: CliReviewStatus) {
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
}

const HEAD_CLS =
    "text-text-tertiary text-xs font-medium tracking-wide uppercase";

export function CliReviewsPageClient() {
    const { teamId } = useSelectedTeamId();

    const [emailFilter, setEmailFilter] = useState("");

    const filters = useMemo(
        () => ({
            teamId: teamId ?? undefined,
            userEmail: emailFilter.trim() || undefined,
        }),
        [teamId, emailFilter],
    );

    const {
        data: reviews,
        total,
        fetchNextPage,
        hasNextPage,
        isFetchingNextPage,
        isLoading,
        isError,
        error,
    } = useInfiniteCliReviews(filters);

    const showEmpty = !isLoading && !isError && reviews.length === 0;

    return (
        <Page.Root className="pb-0">
            <Page.Header className="max-w-full">
                <div className="flex w-full items-center justify-between">
                    <div className="flex items-center gap-4">
                        <Page.Title className="text-balance">
                            CLI Reviews
                        </Page.Title>
                        {!isLoading && total > 0 && (
                            <span className="text-text-tertiary text-sm tabular-nums">
                                {total} review{total === 1 ? "" : "s"}
                                {emailFilter && (
                                    <>
                                        {" "}
                                        from{" "}
                                        <span className="text-text-secondary font-medium">
                                            {emailFilter}
                                        </span>
                                    </>
                                )}
                            </span>
                        )}
                    </div>
                    <div className="ml-auto flex flex-wrap items-center gap-3">
                        <EmailFilterPopover
                            value={emailFilter}
                            onChange={setEmailFilter}
                        />
                    </div>
                </div>
            </Page.Header>

            <Page.Content className="max-w-full px-6">
                {isError ? (
                    <div className="py-12 text-center">
                        <p className="text-danger text-sm">
                            Failed to load CLI reviews. Please try again.
                        </p>
                        {error?.message && (
                            <p className="text-text-tertiary mt-1 text-xs">
                                {error.message}
                            </p>
                        )}
                    </div>
                ) : isLoading ? (
                    <div className="flex items-center justify-center py-12">
                        <Spinner className="size-7" />
                    </div>
                ) : showEmpty ? (
                    <EmptyState />
                ) : (
                    <>
                        <TableContainer className="border-card-lv3/40 bg-card-lv1/50 max-h-[calc(100dvh-13rem)] overflow-auto rounded-xl border">
                            <Table className="w-full">
                                <TableHeader sticky>
                                    <TableRow className="hover:bg-transparent">
                                        <TableHead className="w-8" />
                                        <TableHead className={cn(HEAD_CLS, "w-32")}>
                                            When
                                        </TableHead>
                                        <TableHead
                                            className={cn(
                                                HEAD_CLS,
                                                "min-w-[14rem]",
                                            )}>
                                            User
                                        </TableHead>
                                        <TableHead className={cn(HEAD_CLS, "w-40")}>
                                            Repo
                                        </TableHead>
                                        <TableHead
                                            className={cn(
                                                HEAD_CLS,
                                                "hidden w-40 xl:table-cell",
                                            )}>
                                            Branch
                                        </TableHead>
                                        <TableHead
                                            className={cn(
                                                HEAD_CLS,
                                                "hidden w-28 lg:table-cell",
                                            )}>
                                            Commit
                                        </TableHead>
                                        <TableHead className={cn(HEAD_CLS, "w-28")}>
                                            Status
                                        </TableHead>
                                        <TableHead
                                            className={cn(HEAD_CLS, "w-20")}
                                            align="right">
                                            Issues
                                        </TableHead>
                                        <TableHead
                                            className={cn(
                                                HEAD_CLS,
                                                "hidden w-24 md:table-cell",
                                            )}
                                            align="right">
                                            Duration
                                        </TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {reviews.map((row) => (
                                        <CliReviewRow
                                            key={row.executionUuid}
                                            row={row}
                                        />
                                    ))}
                                </TableBody>
                            </Table>
                        </TableContainer>

                        {hasNextPage && (
                            <div className="flex justify-center py-4">
                                <Button
                                    variant="cancel"
                                    size="md"
                                    onClick={() => fetchNextPage()}
                                    disabled={isFetchingNextPage}>
                                    {isFetchingNextPage
                                        ? "Loading…"
                                        : "Load more"}
                                </Button>
                            </div>
                        )}
                    </>
                )}
            </Page.Content>
        </Page.Root>
    );
}

function CliReviewRow({ row }: { row: CliReviewSummary }) {
    const [isOpen, setIsOpen] = useState(false);
    const repo = repoLabel(row);
    const sha = shortSha(row.git?.commitSha);
    const branch = row.git?.branch;

    return (
        <Fragment>
            <TableRow
                className={cn(
                    "cursor-pointer",
                    isOpen
                        ? "bg-card-lv2/40 hover:bg-card-lv2/50"
                        : "hover:bg-card-lv1/70",
                )}
                onClick={() => setIsOpen((v) => !v)}>
                <TableCell className="w-8 px-4">
                    <ChevronDownIcon
                        aria-hidden
                        className={cn(
                            "text-text-tertiary size-4 shrink-0 transition-transform duration-200",
                            isOpen && "text-text-secondary rotate-180",
                        )}
                    />
                </TableCell>
                <TableCell className="w-32">
                    <span className="text-text-tertiary text-sm tabular-nums">
                        {formatRelative(row.createdAt)}
                    </span>
                </TableCell>
                <TableCell className="min-w-0 max-w-[16rem]">
                    <UserCell row={row} />
                </TableCell>
                <TableCell className="max-w-[10rem]">
                    {repo ? (
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <span className="text-text-secondary block max-w-[10rem] cursor-default truncate text-sm">
                                    <TruncateStart text={repo} />
                                </span>
                            </TooltipTrigger>
                            <TooltipContent className="font-mono text-xs">
                                {repo}
                            </TooltipContent>
                        </Tooltip>
                    ) : (
                        <span className="text-text-tertiary text-sm">—</span>
                    )}
                </TableCell>
                <TableCell className="hidden max-w-[10rem] xl:table-cell">
                    {branch ? (
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <span className="text-text-tertiary flex max-w-[10rem] cursor-default items-center gap-1.5 font-mono text-xs">
                                    <GitBranchIcon
                                        aria-hidden
                                        className="size-3 shrink-0"
                                    />
                                    <TruncateStart text={branch} />
                                </span>
                            </TooltipTrigger>
                            <TooltipContent className="font-mono text-xs">
                                {branch}
                            </TooltipContent>
                        </Tooltip>
                    ) : (
                        <span className="text-text-tertiary text-xs">—</span>
                    )}
                </TableCell>
                <TableCell className="hidden lg:table-cell">
                    {sha ? (
                        <span className="text-text-tertiary flex items-center gap-1.5 font-mono text-xs tabular-nums">
                            <GitCommitIcon
                                aria-hidden
                                className="size-3 shrink-0"
                            />
                            {sha}
                        </span>
                    ) : (
                        <span className="text-text-tertiary text-xs">—</span>
                    )}
                </TableCell>
                <TableCell>
                    {statusBadge(row.status as CliReviewStatus)}
                </TableCell>
                <TableCell align="right">
                    <IssuesCell count={row.issuesFound} />
                </TableCell>
                <TableCell
                    align="right"
                    className="text-text-tertiary hidden text-sm tabular-nums md:table-cell">
                    {formatDuration(row.durationMs)}
                </TableCell>
            </TableRow>

            {isOpen && (
                <TableRow className="hover:bg-transparent">
                    <TableCell
                        colSpan={TABLE_COL_COUNT}
                        className="border-b-card-lv3/60 bg-card-lv2/20 p-0">
                        <div className="max-w-[calc(100vw-6rem)] px-4 pt-2 pb-6">
                            <ReviewExpansion
                                executionUuid={row.executionUuid}
                                summary={row}
                            />
                        </div>
                    </TableCell>
                </TableRow>
            )}
        </Fragment>
    );
}

function ReviewExpansion({
    executionUuid,
    summary,
}: {
    executionUuid: string;
    summary: CliReviewSummary;
}) {
    const { data, isLoading, isError } = useCliReviewDetail(executionUuid);

    if (isLoading) {
        return (
            <div className="flex items-center justify-center py-6">
                <Spinner className="size-5" />
            </div>
        );
    }

    if (isError) {
        return (
            <div className="border-card-lv3/50 bg-card-lv1/60 rounded-xl border p-4">
                <p className="text-danger text-sm">
                    Failed to load review details.
                </p>
            </div>
        );
    }

    const timeline = data?.timeline ?? [];
    const issues = data?.result?.issues ?? [];

    let fallbackIssues: CliReviewIssue[] = [];
    if (issues.length === 0) {
        for (const item of timeline) {
            const previewed = getSuggestionsPreview(item.metadata);
            if (previewed.length > 0) {
                fallbackIssues = previewed;
                break;
            }
        }
    }

    const displayIssues = issues.length > 0 ? issues : fallbackIssues;

    const sortedTimeline = [...timeline].sort((a, b) => {
        const at = Date.parse(a.createdAt ?? "");
        const bt = Date.parse(b.createdAt ?? "");
        return (Number.isNaN(at) ? 0 : at) - (Number.isNaN(bt) ? 0 : bt);
    });

    return (
        <div className="space-y-3 pt-2">
            <div className="border-card-lv3/50 bg-card-lv1/60 rounded-xl border p-4">
                <div className="flex flex-wrap items-center gap-2.5">
                    <span className="text-text-primary text-sm font-semibold">
                        Review timeline
                    </span>
                    {statusBadge(summary.status as CliReviewStatus)}
                    {summary.durationMs != null && (
                        <span className="text-text-tertiary text-xs tabular-nums">
                            Duration: {formatDuration(summary.durationMs)}
                        </span>
                    )}
                    {summary.cliVersion && (
                        <span className="text-text-tertiary ml-auto text-xs">
                            Kodus CLI {summary.cliVersion}
                        </span>
                    )}
                </div>

                {summary.errorMessage && (
                    <div className="bg-danger/10 text-danger mt-3 rounded-md p-3 text-xs whitespace-pre-wrap">
                        {summary.errorMessage}
                    </div>
                )}

                {sortedTimeline.length === 0 ? (
                    <p className="text-text-tertiary mt-4 text-xs">
                        No timeline events recorded yet.
                    </p>
                ) : (
                    <div className="relative mt-4 pl-6">
                        <div className="bg-card-lv3/70 absolute top-2 left-[0.5625rem] h-[calc(100%-0.75rem)] w-px" />
                        <div className="space-y-3">
                            {sortedTimeline.map((item) => (
                                <TimelineRow key={item.uuid} item={item} />
                            ))}
                        </div>
                    </div>
                )}
            </div>

            {displayIssues.length > 0 && (
                <SuggestionsList
                    issues={displayIssues}
                    isPreview={issues.length === 0}
                />
            )}
        </div>
    );
}

function TimelineRow({ item }: { item: CliReviewTimelineItem }) {
    const stage = stageDisplay(item);
    const isActive = item.status === "in_progress";
    const showMessage =
        Boolean(stage.message) &&
        stage.message !== stage.label &&
        !stage.message.toLowerCase().includes("automation");

    return (
        <div
            className={cn(
                "flex gap-3",
                isActive &&
                    "border-primary-light bg-card-lv2/60 rounded-lg border-l-2 px-3 py-2",
            )}>
            <div className="relative flex w-4 justify-center">
                <span
                    aria-hidden
                    className={cn(
                        "mt-1.5 size-2.5 shrink-0 rounded-full border-2",
                        isActive && "size-3",
                        timelineDotColor(item.status),
                    )}
                />
            </div>
            <div className="min-w-0 flex-1 py-0.5">
                <div className="mb-0.5 flex flex-wrap items-center gap-2">
                    <span className="text-text-primary truncate text-sm font-medium">
                        {stage.label}
                    </span>
                    {isActive && <Spinner className="text-primary-light size-3" />}
                    {!isActive && statusBadge(item.status as CliReviewStatus)}
                </div>
                {showMessage && (
                    <p className="text-text-tertiary text-xs text-pretty">
                        {stage.message}
                    </p>
                )}
                {stage.duration && (
                    <p className="text-text-tertiary text-xs tabular-nums">
                        {isActive ? "Elapsed: " : "Duration: "}
                        {stage.duration}
                    </p>
                )}
                {item.createdAt && (
                    <p className="text-text-tertiary text-xs tabular-nums">
                        Started: {formatTimelineDateTime(item.createdAt)}
                    </p>
                )}
                {stage.agentTrace && (
                    <AgentTraceDetails trace={stage.agentTrace} />
                )}
            </div>
        </div>
    );
}

function AgentTraceDetails({
    trace,
}: {
    trace: NonNullable<ReturnType<typeof getAgentTrace>>;
}) {
    const totalToolCalls = trace.toolSummary
        ? Object.values(trace.toolSummary).reduce((a, b) => a + b, 0)
        : 0;
    const tokenLabel =
        trace.totalTokens != null
            ? `${trace.totalTokens.toLocaleString()} tokens`
            : null;

    if (totalToolCalls === 0) {
        // Match the PR pattern: when there are no tool calls, just show a
        // compact one-liner with steps/tokens. Don't open a <details> with
        // an empty list.
        const bits: string[] = [];
        if (trace.steps != null)
            bits.push(`${trace.steps} step${trace.steps === 1 ? "" : "s"}`);
        if (tokenLabel) bits.push(tokenLabel);
        bits.push("no tool calls");
        return (
            <p className="text-text-tertiary mt-1 text-xs">
                {bits.join(" · ")}
            </p>
        );
    }

    const toolCalls = trace.toolCalls ?? [];

    return (
        <details className="text-text-tertiary mt-2 text-xs">
            <summary className="hover:text-text-secondary cursor-pointer select-none">
                {formatToolSummary(trace.toolSummary ?? {})}
                {tokenLabel && (
                    <span className="text-text-tertiary"> · {tokenLabel}</span>
                )}
            </summary>
            {toolCalls.length > 0 && (
                <ul className="mt-2 space-y-1 pl-4">
                    {toolCalls
                        .slice(0, MAX_TOOL_CALLS_DISPLAY)
                        .map((tc, idx) => (
                            <li
                                key={idx}
                                className="truncate font-mono text-[11px]">
                                {tc.tool}(
                                {typeof tc.args === "string"
                                    ? tc.args
                                    : JSON.stringify(tc.args)}
                                )
                            </li>
                        ))}
                    {toolCalls.length > MAX_TOOL_CALLS_DISPLAY && (
                        <li className="text-text-tertiary text-[11px] italic">
                            … and {toolCalls.length - MAX_TOOL_CALLS_DISPLAY}{" "}
                            more
                        </li>
                    )}
                </ul>
            )}
        </details>
    );
}

function SuggestionsList({
    issues,
    isPreview,
}: {
    issues: CliReviewIssue[];
    isPreview: boolean;
}) {
    return (
        <div className="border-card-lv3/50 bg-card-lv1/60 rounded-xl border p-4">
            <div className="mb-3 flex items-center gap-2">
                <span className="text-text-primary text-sm font-semibold">
                    Suggestions
                </span>
                <span className="text-text-tertiary text-xs tabular-nums">
                    ({issues.length})
                </span>
                {isPreview && (
                    <span className="text-text-tertiary text-[11px]">
                        · preview from agent run (not yet finalized)
                    </span>
                )}
            </div>
            <ul className="flex flex-col gap-2">
                {issues.map((issue, idx) => (
                    <SuggestionItem
                        key={`${issue.file ?? "pr"}-${issue.line ?? idx}-${idx}`}
                        issue={issue}
                    />
                ))}
            </ul>
        </div>
    );
}

const SEVERITY_BADGE: Record<
    string,
    { className: string; label: string }
> = {
    critical: {
        className: "bg-danger/10 text-danger",
        label: "Critical",
    },
    high: {
        className: "bg-warning/10 text-warning",
        label: "High",
    },
    medium: {
        className: "bg-primary-light/10 text-primary-light",
        label: "Medium",
    },
    low: {
        className: "bg-card-lv2 text-text-secondary",
        label: "Low",
    },
};

function SuggestionItem({ issue }: { issue: CliReviewIssue }) {
    const sev = (issue.severity ?? "").toLowerCase();
    const sevStyle = SEVERITY_BADGE[sev] ?? SEVERITY_BADGE.low;

    return (
        <li className="bg-card-lv2/40 rounded-lg p-3">
            <div className="flex flex-wrap items-center gap-2 text-[11px]">
                <span
                    className={cn(
                        "rounded px-1.5 py-0.5 font-medium uppercase",
                        sevStyle.className,
                    )}>
                    {sevStyle.label}
                </span>
                {issue.category && (
                    <span className="text-text-tertiary">{issue.category}</span>
                )}
                {issue.file && (
                    <span className="text-text-tertiary truncate font-mono">
                        {issue.file}
                        {issue.line ? `:${issue.line}` : ""}
                    </span>
                )}
            </div>
            {issue.title && (
                <p className="text-text-primary mt-1.5 text-sm text-pretty">
                    {issue.title}
                </p>
            )}
            {issue.message && (
                <p className="text-text-secondary mt-1 text-sm whitespace-pre-wrap text-pretty">
                    {issue.message}
                </p>
            )}
            {issue.suggestion && (
                <pre className="bg-card-lv1 mt-2 overflow-x-auto rounded-md p-2 text-xs">
                    {issue.suggestion}
                </pre>
            )}
        </li>
    );
}

/**
 * Truncate a string from the start, keeping the tail visible. CSS does this
 * with `direction: rtl` (so the ellipsis falls on the left), but RTL also
 * reorders inline content like `:` and `/`. We pin direction back to `ltr`
 * on an inner wrapper so the visible glyphs stay in their natural order —
 * only the truncation side moves. Used for repo (`org/repo`) and branch
 * (`feat/long/path`) cells where the suffix is the identifier.
 */
function TruncateStart({ text }: { text: string }) {
    return (
        <span
            className="min-w-0 flex-1 truncate"
            style={{ direction: "rtl" }}>
            <span style={{ direction: "ltr", unicodeBidi: "embed" }}>
                {text}
            </span>
        </span>
    );
}

function UserCell({ row }: { row: CliReviewSummary }) {
    const loggedIn = row.cliAuth?.loggedInUserEmail ?? null;
    const gitUser = row.userEmail ?? null;
    const showGit = loggedIn && gitUser && loggedIn !== gitUser;
    const primary = loggedIn ?? gitUser ?? "Anonymous";

    return (
        <div className="flex min-w-0 flex-col gap-0.5">
            <Tooltip>
                <TooltipTrigger asChild>
                    <span className="text-text-primary block max-w-[16rem] cursor-default truncate text-sm font-medium">
                        {primary}
                    </span>
                </TooltipTrigger>
                <TooltipContent className="text-xs">{primary}</TooltipContent>
            </Tooltip>

            <CliAuthLine auth={row.cliAuth} gitUser={showGit ? gitUser : null} />
        </div>
    );
}

/**
 * Compact metadata line directly under the user email. Renders as a single
 * row of text with a colored dot for the auth mode and, when the dev's git
 * config differs from the logged-in Kodus account, a dimmer suffix with
 * the git email. Replaces the old boxed badges, which felt disconnected
 * from the email above them in a dense table row.
 */
function CliAuthLine({
    auth,
    gitUser,
}: {
    auth?: CliReviewSummary["cliAuth"];
    gitUser?: string | null;
}) {
    if (!auth?.mode && !gitUser) return null;

    return (
        <div className="text-text-tertiary flex max-w-[16rem] min-w-0 items-center gap-1.5 text-[11px]">
            {auth?.mode === "team-key" ? (
                <Tooltip>
                    <TooltipTrigger asChild>
                        <span className="inline-flex min-w-0 cursor-default items-center gap-1">
                            <span
                                aria-hidden
                                className="bg-primary-light/80 size-1.5 shrink-0 rounded-full"
                            />
                            <span className="text-text-secondary">Team</span>
                            {auth.teamKeyName && (
                                <span className="text-text-tertiary truncate font-mono">
                                    · {auth.teamKeyName}
                                </span>
                            )}
                        </span>
                    </TooltipTrigger>
                    <TooltipContent className="text-xs">
                        Authenticated with team CLI key
                        {auth.teamKeyName ? (
                            <>
                                {" "}
                                <span className="font-mono">
                                    {auth.teamKeyName}
                                </span>
                            </>
                        ) : null}
                    </TooltipContent>
                </Tooltip>
            ) : auth?.mode === "personal" ? (
                <span className="inline-flex shrink-0 items-center gap-1">
                    <span
                        aria-hidden
                        className="bg-success/80 size-1.5 shrink-0 rounded-full"
                    />
                    <span className="text-text-secondary">Personal</span>
                </span>
            ) : null}

            {gitUser && (
                <>
                    {auth?.mode && (
                        <span className="text-text-tertiary/60" aria-hidden>
                            ·
                        </span>
                    )}
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <span className="text-text-tertiary min-w-0 cursor-default truncate">
                                git: {gitUser}
                            </span>
                        </TooltipTrigger>
                        <TooltipContent className="text-xs">
                            Local <code>git config user.email</code> on the
                            machine that ran the review (may differ from the
                            Kodus account).
                        </TooltipContent>
                    </Tooltip>
                </>
            )}
        </div>
    );
}

function IssuesCell({ count }: { count?: number | null }) {
    if (count == null) {
        return <span className="text-text-tertiary text-sm">—</span>;
    }
    if (count === 0) {
        return (
            <span className="bg-success/10 text-success inline-flex min-w-7 items-center justify-center rounded-md px-2 py-0.5 text-xs font-medium tabular-nums">
                0
            </span>
        );
    }
    return (
        <span className="bg-warning/10 text-warning inline-flex min-w-7 items-center justify-center rounded-md px-2 py-0.5 text-xs font-medium tabular-nums">
            {count}
        </span>
    );
}

function EmailFilterPopover({
    value,
    onChange,
}: {
    value: string;
    onChange: (value: string) => void;
}) {
    const [open, setOpen] = useState(false);
    const [draft, setDraft] = useState(value);

    return (
        <Popover
            open={open}
            onOpenChange={(next) => {
                setOpen(next);
                if (next) setDraft(value);
            }}>
            <PopoverTrigger asChild>
                <Button
                    size="xs"
                    variant="helper"
                    leftIcon={<ListFilterIcon />}>
                    Filters
                    {value && (
                        <span className="text-text-secondary">{` (1)`}</span>
                    )}
                </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-80">
                <div className="flex flex-col gap-3">
                    <div className="flex flex-col gap-1.5">
                        <Label htmlFor="cli-review-email">User email</Label>
                        <Input
                            id="cli-review-email"
                            placeholder="dev@kodus.io"
                            value={draft}
                            onChange={(e) => setDraft(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                    onChange(draft);
                                    setOpen(false);
                                }
                            }}
                        />
                    </div>
                    <div className="flex justify-end gap-2">
                        {value && (
                            <Button
                                variant="cancel"
                                size="sm"
                                onClick={() => {
                                    setDraft("");
                                    onChange("");
                                    setOpen(false);
                                }}
                                leftIcon={<XIcon className="size-3.5" />}>
                                Clear
                            </Button>
                        )}
                        <Button
                            variant="primary-dark"
                            size="sm"
                            onClick={() => {
                                onChange(draft);
                                setOpen(false);
                            }}>
                            Apply
                        </Button>
                    </div>
                </div>
            </PopoverContent>
        </Popover>
    );
}

function EmptyState() {
    return (
        <div className="flex flex-col items-center gap-3 py-16 text-center">
            <div className="bg-card-lv1 text-text-secondary flex size-12 items-center justify-center rounded-full">
                <TerminalIcon aria-hidden className="size-5" />
            </div>
            <div className="flex flex-col gap-1">
                <p className="text-text-primary text-balance text-base font-medium">
                    No CLI reviews yet
                </p>
                <p className="text-text-tertiary max-w-sm text-pretty text-sm">
                    Reviews triggered with the Kodus CLI by your team will
                    appear here.
                </p>
            </div>
        </div>
    );
}
