"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { ReviewsSourceTabs } from "@components/system/reviews-source-tabs";
import { Badge } from "@components/ui/badge";
import { Button } from "@components/ui/button";
import { Page } from "@components/ui/page";
import { Skeleton } from "@components/ui/skeleton";
import { Spinner } from "@components/ui/spinner";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@components/ui/table";
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@components/ui/tooltip";
import { useDebounce } from "@hooks/use-debounce";
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
import { useGetSelectedRepositories } from "@services/codeManagement/hooks";
import {
    ChevronDownIcon,
    GitBranchIcon,
    GitCommitIcon,
    TerminalIcon,
    UserIcon,
    XIcon,
} from "lucide-react";
import { parseAsString, parseAsStringLiteral, useQueryState } from "nuqs";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";
import { cn } from "src/core/utils/components";

import {
    CliReviewsFilters,
    SINCE_LABEL,
    SINCE_PRESETS,
    sinceFromPreset,
} from "./cli-reviews-filters";

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
        const cleaned = row.git.remote.replace(/\.git$/, "").replace(/\/$/, "");
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
                : (item.finishedAt ?? item.updatedAt),
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
    "text-text-secondary text-2xs font-medium tracking-wide uppercase";

// Filters live in the URL (nuqs) so a filtered view is shareable and survives
// reload — same pattern as the Pull Requests tab. Writes are shallow with
// history:replace so typing doesn't spam the back button.
const urlOpts = { shallow: true, history: "replace" } as const;

const PULSE_CHIP =
    "inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1 text-left transition";

export function CliReviewsPageClient() {
    const { teamId } = useSelectedTeamId();

    const [searchQuery, setSearchQuery] = useQueryState(
        "q",
        parseAsString.withOptions(urlOpts),
    );
    const [repositoryId, setRepositoryId] = useQueryState(
        "repo",
        parseAsString.withOptions(urlOpts),
    );
    const [sincePreset, setSincePreset] = useQueryState(
        "since",
        parseAsStringLiteral(SINCE_PRESETS).withOptions(urlOpts),
    );
    const debouncedQuery = useDebounce(searchQuery ?? "", 400);

    const filters = useMemo(
        () => ({
            teamId: teamId ?? undefined,
            userEmail: debouncedQuery.trim() || undefined,
            repositoryId: repositoryId ?? undefined,
            since: sinceFromPreset(sincePreset),
        }),
        [teamId, debouncedQuery, repositoryId, sincePreset],
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

    // Pulse: team-wide "ran today" count, independent of the list filters.
    const todayFilters = useMemo(
        () => ({
            teamId: teamId ?? undefined,
            since: sinceFromPreset("today"),
        }),
        [teamId],
    );
    const today = useInfiniteCliReviews(todayFilters, { pageSize: 1 });
    const reviewedTodayActive = sincePreset === "today";

    const { data: repositories } = useGetSelectedRepositories(teamId);
    const repoName = repositoryId
        ? (Array.isArray(repositories) ? repositories : []).find(
              (repo) => String(repo.id) === repositoryId,
          )?.name
        : undefined;

    const activeChips: { key: string; label: string; clear: () => void }[] = [];
    if (searchQuery) {
        activeChips.push({
            key: "q",
            label: `User: ${searchQuery}`,
            clear: () => setSearchQuery(null),
        });
    }
    if (repositoryId) {
        activeChips.push({
            key: "repo",
            label: `Repository: ${repoName ?? repositoryId}`,
            clear: () => setRepositoryId(null),
        });
    }
    if (sincePreset) {
        activeChips.push({
            key: "since",
            label: SINCE_LABEL[sincePreset],
            clear: () => setSincePreset(null),
        });
    }
    const clearAllFilters = () => {
        setSearchQuery(null);
        setRepositoryId(null);
        setSincePreset(null);
    };

    return (
        <Page.Root scrollable={false} className="min-h-0 gap-3 pt-6 pb-0">
            <Page.Header>
                {/* One compact band, like the Pull Requests tab: source tabs +
                    count on the left, the pulse chip on the right, so the
                    table starts near the top. */}
                <div className="flex w-full flex-wrap items-center justify-between gap-x-4 gap-y-2">
                    <div className="flex items-center gap-3">
                        <ReviewsSourceTabs />
                        {!isLoading && total > 0 && (
                            <span className="text-text-tertiary text-sm tabular-nums">
                                {total} review{total === 1 ? "" : "s"}
                                {repoName && (
                                    <>
                                        {" "}
                                        in{" "}
                                        <span className="text-text-secondary font-medium">
                                            {repoName}
                                        </span>
                                    </>
                                )}
                            </span>
                        )}
                    </div>

                    <button
                        type="button"
                        aria-pressed={reviewedTodayActive}
                        title="CLI reviews your team ran today. Click to show only today's."
                        onClick={() =>
                            setSincePreset(reviewedTodayActive ? null : "today")
                        }
                        className={cn(
                            PULSE_CHIP,
                            reviewedTodayActive
                                ? "border-primary-light/60 bg-primary/5 ring-primary-light/15 ring-2"
                                : "border-card-lv3 bg-card-lv2 hover:border-primary-light/40 hover:bg-card-lv1/70",
                        )}>
                        <span className="text-text-secondary text-xs font-medium">
                            Reviewed today
                        </span>
                        <span
                            className={cn(
                                "text-xs font-semibold tabular-nums",
                                today.total === 0
                                    ? "text-text-tertiary"
                                    : "text-success",
                            )}>
                            {today.total}
                        </span>
                    </button>
                </div>
            </Page.Header>

            <Page.Content className="min-h-0 gap-3">
                {/* Toolbar — search + structured filters on one wrapping row. */}
                <div className="flex flex-wrap items-center gap-2">
                    <div className="border-card-lv3 bg-card-lv2 focus-within:border-primary-light/50 focus-within:ring-primary-light/15 flex h-9 min-w-[18rem] flex-1 items-center gap-2 rounded-xl border pr-1.5 pl-3 transition focus-within:ring-3">
                        <UserIcon className="text-text-tertiary size-4 shrink-0" />
                        <input
                            className="text-text-primary placeholder:text-text-tertiary/70 h-full min-w-0 flex-1 bg-transparent text-sm outline-none"
                            type="search"
                            inputMode="email"
                            placeholder="Search by user email…"
                            aria-label="Search by user email"
                            value={searchQuery ?? ""}
                            onChange={(event) =>
                                setSearchQuery(event.target.value || null)
                            }
                        />
                        {searchQuery && (
                            <Button
                                size="icon-xs"
                                variant="cancel"
                                aria-label="Clear search"
                                onClick={() => setSearchQuery(null)}>
                                <XIcon />
                            </Button>
                        )}
                    </div>

                    <CliReviewsFilters
                        teamId={teamId}
                        repositoryId={repositoryId}
                        onRepositoryChange={(value) =>
                            setRepositoryId(value ?? null)
                        }
                        since={sincePreset}
                        onSinceChange={setSincePreset}
                    />
                </div>

                {activeChips.length > 0 && (
                    <div className="flex flex-wrap items-center gap-2">
                        {activeChips.map((chip) => (
                            <Button
                                key={chip.key}
                                size="xs"
                                variant="helper"
                                rightIcon={<XIcon />}
                                onClick={chip.clear}>
                                {chip.label}
                            </Button>
                        ))}
                        <Button
                            size="xs"
                            variant="cancel"
                            onClick={clearAllFilters}>
                            Clear all
                        </Button>
                    </div>
                )}

                {isError ? (
                    <div className="min-h-0 flex-1 overflow-y-auto py-12 text-center">
                        <p className="text-danger text-sm">
                            Failed to load CLI reviews. Please try again.
                        </p>
                        {error?.message && (
                            <p className="text-text-tertiary mt-1 text-xs">
                                {error.message}
                            </p>
                        )}
                    </div>
                ) : (
                    <CliReviewsTable
                        rows={reviews}
                        loading={isLoading && !reviews.length}
                        hasNextPage={hasNextPage}
                        isFetchingNextPage={isFetchingNextPage}
                        fetchNextPage={fetchNextPage}
                        hasActiveFilters={activeChips.length > 0}
                        onClearFilters={clearAllFilters}
                    />
                )}
            </Page.Content>
        </Page.Root>
    );
}

/**
 * Same shell as the Pull Requests table: one bordered scroll container, a
 * sticky header row, infinite scroll at the bottom, skeleton while loading
 * and a card-shaped empty state.
 */
function CliReviewsTable({
    rows,
    loading,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
    hasActiveFilters,
    onClearFilters,
}: {
    rows: CliReviewSummary[];
    loading: boolean;
    hasNextPage?: boolean;
    isFetchingNextPage: boolean;
    fetchNextPage: () => void;
    hasActiveFilters: boolean;
    onClearFilters: () => void;
}) {
    const scrollRef = useRef<HTMLDivElement | null>(null);
    const loadMoreRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        const node = loadMoreRef.current;
        const root = scrollRef.current;
        if (!node || !root) return;

        const observer = new IntersectionObserver(
            (entries) => {
                if (
                    entries[0]?.isIntersecting &&
                    hasNextPage &&
                    !isFetchingNextPage
                ) {
                    fetchNextPage();
                }
            },
            { root, rootMargin: "0px 0px 400px 0px" },
        );
        observer.observe(node);
        return () => observer.disconnect();
    }, [fetchNextPage, hasNextPage, isFetchingNextPage]);

    if (loading) {
        return (
            <div className="border-card-lv3/40 bg-card-lv1/50 divide-card-lv3/30 flex flex-col divide-y overflow-hidden rounded-xl border">
                {Array.from({ length: 8 }).map((_, i) => (
                    <div key={i} className="flex items-center gap-3 px-5 py-4">
                        <Skeleton className="size-4 shrink-0 rounded" />
                        <Skeleton className="h-4 w-24" />
                        <Skeleton className="h-4 w-2/5" />
                        <Skeleton className="ml-auto h-5 w-20 rounded-md" />
                    </div>
                ))}
            </div>
        );
    }

    if (!rows.length) {
        return (
            <EmptyState
                hasActiveFilters={hasActiveFilters}
                onClearFilters={onClearFilters}
            />
        );
    }

    return (
        <div
            ref={scrollRef}
            className="border-card-lv3/60 bg-card-lv1 min-h-0 flex-1 overflow-y-auto rounded-xl border">
            <Table className="w-full">
                <TableHeader sticky className="bg-card-lv1/95 backdrop-blur">
                    <TableRow className="hover:bg-transparent">
                        <TableHead className="w-8" />
                        <TableHead className={cn(HEAD_CLS, "w-32")}>
                            When
                        </TableHead>
                        <TableHead className={cn(HEAD_CLS, "min-w-[14rem]")}>
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
                    {rows.map((row) => (
                        <CliReviewRow key={row.executionUuid} row={row} />
                    ))}
                </TableBody>
            </Table>

            <div ref={loadMoreRef} className="h-1 w-full" aria-hidden />
            {isFetchingNextPage && (
                <div className="flex justify-center py-4">
                    <Spinner className="size-5" />
                </div>
            )}
        </div>
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
                <TableCell className="max-w-[16rem] min-w-0">
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
                    {isActive && (
                        <Spinner className="text-primary-light size-3" />
                    )}
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

const SEVERITY_BADGE: Record<string, { className: string; label: string }> = {
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
                <p className="text-text-secondary mt-1 text-sm text-pretty whitespace-pre-wrap">
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
        <span className="min-w-0 flex-1 truncate" style={{ direction: "rtl" }}>
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

            <CliAuthLine
                auth={row.cliAuth}
                gitUser={showGit ? gitUser : null}
            />
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

function EmptyState({
    hasActiveFilters,
    onClearFilters,
}: {
    hasActiveFilters: boolean;
    onClearFilters: () => void;
}) {
    return (
        <div className="border-card-lv3/40 bg-card-lv1/50 flex flex-col items-center justify-center gap-3 rounded-xl border py-16 text-center">
            <div className="bg-card-lv2/60 text-text-tertiary flex size-11 items-center justify-center rounded-full">
                <TerminalIcon aria-hidden className="size-5" />
            </div>
            {hasActiveFilters ? (
                <>
                    <p className="text-text-secondary text-sm">
                        No CLI reviews match these filters.
                    </p>
                    <Button size="xs" variant="helper" onClick={onClearFilters}>
                        Clear filters
                    </Button>
                </>
            ) : (
                <p className="text-text-secondary max-w-sm text-sm text-pretty">
                    No CLI reviews yet. Reviews your team runs with the Kodus
                    CLI will appear here.
                </p>
            )}
        </div>
    );
}
