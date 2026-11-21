"use client";

import { Fragment, useMemo, useState, type ReactNode } from "react";
import NextLink from "next/link";
import { RelativeTime } from "@components/runtime/relative-time";
import { Spinner } from "@components/ui/spinner";
import {
    usePullRequestFiles,
    type PullRequestExecution,
} from "@services/pull-requests";
import { shortSha } from "@services/runtime/format";
import { runStateLabel } from "@services/runtime/labels";
import {
    buildCommitTimeline,
    canRequestRun,
    failureWords,
    isLiveRunState,
    regressionSentence,
    requestRunRepositoryIds,
    runCell,
    runHref,
    type PrRuntime,
    type PrRunView,
    type TimelineCommit,
} from "@services/runtime/model/pull-request-runs";
import {
    AlertTriangleIcon,
    ArrowRightIcon,
    CheckIcon,
    ChevronRightIcon,
    CircleCheckIcon,
    CircleSlashIcon,
    CircleXIcon,
    FilterIcon,
    XIcon,
} from "lucide-react";
import { cn } from "src/core/utils/components";

import { RequestRunButton } from "./pr-runtime";
import type { PullRequestExecutionGroup } from "./types";

/** A review of the PR, numbered as the list counts them (Review 1 is the first). */
export type NumberedReview = {
    execution: PullRequestExecution;
    number: number;
    key: string;
};

export const reviewKeyOf = (execution: PullRequestExecution, index: number) =>
    execution.executionId ||
    execution.automationExecution?.uuid ||
    `${execution.prId}-${execution.automationExecution?.createdAt ?? execution.updatedAt ?? execution.createdAt}-${index}`;

type ReviewTone = "success" | "danger" | "warning" | "info" | "muted";

/**
 * What a review came to, in a word and a tone. A review the pipeline marks
 * skipped after one of its steps failed did not skip: it failed there.
 */
export const reviewOutcome = (
    execution: PullRequestExecution,
): { word: string; tone: ReviewTone } => {
    const status = execution.automationExecution?.status ?? "pending";
    const stepFailed = (execution.codeReviewTimeline ?? []).some(
        (item) => item.status === "error",
    );
    switch (status) {
        case "success":
            return { word: "passed", tone: "success" };
        case "error":
            return { word: "failed", tone: "danger" };
        case "partial_error":
            return { word: "partly failed", tone: "warning" };
        case "in_progress":
            return { word: "running", tone: "info" };
        case "skipped":
            return stepFailed
                ? { word: "failed", tone: "danger" }
                : { word: "skipped", tone: "muted" };
        default:
            return { word: "queued", tone: "muted" };
    }
};

/** A plain sentence for a step error whose cause is known, else null. */
export const knownStageErrorHint = (message: string | undefined) => {
    const m = message ?? "";
    if (/installation-access-token/i.test(m) && /not found/i.test(m))
        return "GitHub can't find the Kodus app on this repository: reinstall the app or give it access to the repository, then review again.";
    return null;
};

const stepName = (item: {
    message: string;
    stageName?: string | null;
    stageLabel?: string | null;
    metadata?: unknown;
}) => {
    const fromMetadata = (item.metadata as { label?: unknown } | null)?.label;
    if (typeof fromMetadata === "string" && fromMetadata.trim())
        return fromMetadata.trim();
    const raw = item.stageLabel || item.stageName;
    if (raw)
        return raw
            .trim()
            .replace(/Stage$/i, "")
            .replace(/([a-z])([A-Z])/g, "$1 $2")
            .trim();
    return item.message;
};

/** The step a review stopped at: its name, its raw error and, when known, why in plain words. */
export const failedStepOf = (execution: PullRequestExecution) => {
    const item = (execution.codeReviewTimeline ?? []).find(
        (t) => t.status === "error",
    );
    if (!item) return null;
    return {
        name: stepName(item),
        message: item.message,
        hint: knownStageErrorHint(item.message),
    };
};

const TONE_TEXT: Record<ReviewTone, string> = {
    success: "text-success",
    danger: "text-danger",
    warning: "text-warning",
    info: "text-info",
    muted: "text-text-tertiary",
};

const TONE_ICON: Record<ReviewTone, ReactNode> = {
    success: <CircleCheckIcon className="size-3.5 shrink-0" />,
    danger: <CircleXIcon className="size-3.5 shrink-0" />,
    warning: <AlertTriangleIcon className="size-3.5 shrink-0" />,
    info: <Spinner className="size-3 shrink-0" />,
    muted: <CircleSlashIcon className="size-3.5 shrink-0" />,
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The Runtime cell of one commit. */
const CommitRuntime = ({
    run,
    commit,
    runtime,
    repositoryId,
    prNumber,
}: {
    run?: PrRunView;
    commit: TimelineCommit<NumberedReview>;
    runtime: PrRuntime | undefined;
    repositoryId: string;
    prNumber: number;
}) => {
    if (!run) {
        if (!runtime?.environment)
            return <span className="text-text-tertiary text-xs">—</span>;
        // The PR row already offers "Run on this PR" while nothing ran;
        // the head offers it here only when an older commit's Run hides it.
        const canRequest =
            commit.isHead &&
            canRequestRun(runtime) &&
            (runtime.commits?.length ?? 0) > 0;
        return (
            <span className="text-text-tertiary flex items-center gap-2 text-xs">
                Not run
                {canRequest && (
                    <RequestRunButton
                        repositoryId={repositoryId}
                        prNumber={prNumber}
                        repositoryIds={requestRunRepositoryIds(runtime)}
                        label="Run"
                    />
                )}
            </span>
        );
    }
    const link = (className: string, children: ReactNode) => (
        <NextLink
            href={runHref(run.runId)}
            onClick={(e) => e.stopPropagation()}
            className={cn(
                "flex w-fit items-center gap-1 text-xs font-medium hover:underline",
                className,
            )}>
            {children}
        </NextLink>
    );
    if (isLiveRunState(run.state))
        return link(
            "text-info",
            <>
                <span
                    aria-hidden
                    className="bg-info size-1.5 animate-pulse rounded-full"
                />
                Running
            </>,
        );
    const cell = runCell(run);
    if (cell.kind === "regression")
        return link(
            "text-danger",
            <>
                <XIcon className="size-3.5" />
                {failureWords(cell)}
            </>,
        );
    if (run.state === "no_regressions")
        return link("text-success", "No regression");
    if (run.state === "could_not_boot")
        return link("text-warning", "Could not boot");
    return link("text-text-secondary", runStateLabel(run.state));
};

const CommitIdentity = ({
    commit,
}: {
    commit: TimelineCommit<NumberedReview>;
}) => {
    if (!commit.sha)
        return (
            <span
                className="text-text-tertiary text-xs"
                title="These reviews stopped before reading the PR's commits">
                Commit not recorded
            </span>
        );
    const sha = (
        <span className="text-text-secondary shrink-0 font-mono text-xs">
            {shortSha(commit.sha)}
        </span>
    );
    return (
        <div className="flex min-w-0 items-center gap-2 text-xs">
            {commit.url ? (
                <a
                    href={commit.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    className="hover:text-primary-light shrink-0 hover:underline">
                    {sha}
                </a>
            ) : (
                sha
            )}
            {commit.message && (
                <span
                    className="text-text-primary min-w-0 truncate text-sm font-medium"
                    title={commit.message}>
                    {commit.message}
                </span>
            )}
            {commit.at && (
                <span className="text-text-tertiary shrink-0 tabular-nums">
                    <RelativeTime at={commit.at} />
                </span>
            )}
            {commit.isHead && (
                <span className="bg-primary-light/10 text-primary-light text-3xs shrink-0 rounded px-1.5 py-px font-semibold tracking-wide uppercase">
                    latest
                </span>
            )}
            {!commit.onBranch && (
                <span className="text-text-tertiary shrink-0 italic">
                    no longer on the branch
                </span>
            )}
        </div>
    );
};

/** The rail of the timeline: a line, and the commit's node (red when its Run found a regression). */
const Rail = ({
    node,
    first,
    last,
}: {
    node: "regression" | "head" | "plain" | "fold";
    first: boolean;
    last: boolean;
}) => (
    <div aria-hidden className="relative flex h-full min-h-6 justify-center">
        <span
            className={cn(
                "bg-card-lv3/70 absolute left-1/2 w-px -translate-x-1/2",
                first ? "top-1/2" : "-top-2",
                last ? "bottom-1/2" : "-bottom-2",
            )}
        />
        <span
            className={cn(
                "relative top-1/2 size-2.5 -translate-y-1/2 rounded-full",
                node === "regression" && "bg-danger ring-danger/25 ring-2",
                node === "head" && "bg-text-secondary",
                node === "plain" && "bg-card-lv1 border-text-tertiary border",
                node === "fold" &&
                    "bg-card-lv1 border-text-tertiary size-1.5 border border-dashed",
            )}
        />
    </div>
);

/**
 * The expanded row: the PR by commit, newest first, each commit on the
 * parent table's columns — its review, its suggestions and its Runtime
 * result. With the Runtime column, the branch's commits load when the row
 * opens; until then, without the column, or when the provider fails, the
 * commits Kody reviewed or ran on are listed.
 */
export const PrCommitTimeline = ({
    group,
    teamId,
    grid,
    runtime,
    hasRuntimeColumn,
    showRuntime,
    renderReviewDetail,
}: {
    group: PullRequestExecutionGroup;
    /** The team the list reads; without it the branch's commits are not fetched. */
    teamId?: string;
    grid: string;
    runtime: PrRuntime | undefined;
    /** The table has a Runtime column. */
    hasRuntimeColumn: boolean;
    /** The viewer may read this repository's Runs: the column has content. */
    showRuntime: boolean;
    renderReviewDetail: (execution: PullRequestExecution) => ReactNode;
}) => {
    const { latest, executions, reviewCount } = group;
    const repoName = latest.repositoryName?.split("/").pop();
    // The branch's commits come with the PR's files (every patch, one Git
    // provider call): asked for only where the Runtime column is, whose Runs
    // sit on commits Kody did not review. Elsewhere the row lists the commits
    // Kody reviewed, and opening it costs no provider call.
    const files = usePullRequestFiles(
        latest.repositoryId,
        latest.prNumber,
        hasRuntimeColumn ? teamId : undefined,
        repoName,
    );
    const [openFolds, setOpenFolds] = useState<Set<number>>(() => new Set());
    const [openReviews, setOpenReviews] = useState<Set<string>>(
        () => new Set(),
    );

    const rows = useMemo(() => {
        const reviews = executions.map((execution, index) => ({
            sha: execution.reviewedCommitSha,
            at: execution.automationExecution?.createdAt ?? execution.createdAt,
            review: {
                execution,
                number: reviewCount - index,
                key: reviewKeyOf(execution, index),
            },
        }));
        return buildCommitTimeline<NumberedReview>({
            commits: files.data?.data?.commits,
            reviews,
            runs: showRuntime ? (runtime?.commits ?? []) : [],
            headSha: latest.reviewedCommitSha,
        });
    }, [
        executions,
        reviewCount,
        files.data,
        runtime?.commits,
        showRuntime,
        latest.reviewedCommitSha,
    ]);

    const toggle = <T,>(set: Set<T>, value: T) => {
        const next = new Set(set);
        if (next.has(value)) next.delete(value);
        else next.add(value);
        return next;
    };

    const flat: Array<
        | { kind: "commit"; commit: TimelineCommit<NumberedReview> }
        | { kind: "fold"; index: number; count: number }
    > = [];
    rows.forEach((row, index) => {
        if (row.kind === "commit") flat.push(row);
        else if (openFolds.has(index))
            row.commits.forEach((commit) =>
                flat.push({ kind: "commit", commit }),
            );
        else flat.push({ kind: "fold", index, count: row.commits.length });
    });

    return (
        <div
            className="py-1"
            role="list"
            aria-label="Commits of this pull request">
            {flat.map((item, i) => {
                const first = i === 0;
                const last = i === flat.length - 1;
                if (item.kind === "fold")
                    return (
                        <div
                            key={`fold-${item.index}`}
                            role="listitem"
                            className={cn(grid, "px-5 py-1")}>
                            <Rail node="fold" first={first} last={last} />
                            <button
                                type="button"
                                onClick={() =>
                                    setOpenFolds((s) => toggle(s, item.index))
                                }
                                className="text-text-tertiary hover:text-text-secondary w-fit text-xs">
                                {plural(item.count, "more commit")}
                            </button>
                        </div>
                    );
                const { commit } = item;
                const [review, ...olderReviews] = commit.reviews;
                const run = commit.run;
                const regression =
                    run && (run.state === "regression" || run.regressions > 0);
                const reviewOpen = review && openReviews.has(review.key);
                const outcome = review ? reviewOutcome(review.execution) : null;
                const failed = review ? failedStepOf(review.execution) : null;
                return (
                    <Fragment key={commit.sha ?? `unrecorded-${i}`}>
                        <div
                            role="listitem"
                            onClick={(e) => {
                                // The row opens its review's steps; its own
                                // links and buttons keep their clicks.
                                if (
                                    !review ||
                                    (e.target as HTMLElement).closest(
                                        "a,button",
                                    )
                                )
                                    return;
                                setOpenReviews((s) => toggle(s, review.key));
                            }}
                            className={cn(
                                grid,
                                "px-5 py-2",
                                review && "hover:bg-card-lv2/30 cursor-pointer",
                            )}>
                            <Rail
                                node={
                                    regression || failed
                                        ? "regression"
                                        : commit.isHead
                                          ? "head"
                                          : "plain"
                                }
                                first={first}
                                last={last && !reviewOpen && !regression}
                            />
                            <div className="flex min-w-0 flex-col gap-1">
                                <div className="flex min-w-0 items-center gap-1.5">
                                    {review ? (
                                        <button
                                            type="button"
                                            aria-expanded={!!reviewOpen}
                                            aria-label={
                                                reviewOpen
                                                    ? "Hide the review's steps"
                                                    : "Show the review's steps"
                                            }
                                            onClick={() =>
                                                setOpenReviews((s) =>
                                                    toggle(s, review.key),
                                                )
                                            }
                                            className="text-text-secondary hover:text-text-primary hover:bg-card-lv3/50 -ml-1 flex size-5 shrink-0 items-center justify-center rounded">
                                            <ChevronRightIcon
                                                className={cn(
                                                    "size-4 transition-transform",
                                                    reviewOpen && "rotate-90",
                                                )}
                                            />
                                        </button>
                                    ) : (
                                        <span
                                            aria-hidden
                                            className="size-5 shrink-0"
                                        />
                                    )}
                                    <CommitIdentity commit={commit} />
                                </div>
                                {review && failed && (
                                    <p className="text-text-secondary pl-6 text-xs">
                                        Kody stopped at{" "}
                                        <span className="text-text-primary font-medium">
                                            {failed.name}
                                        </span>
                                        : {failed.hint ?? failed.message}
                                    </p>
                                )}
                            </div>
                            <div className="flex min-w-0 items-center gap-1.5 text-xs">
                                {review && outcome ? (
                                    <button
                                        type="button"
                                        aria-expanded={!!reviewOpen}
                                        title={
                                            commit.unrecordedReviews?.includes(
                                                review,
                                            )
                                                ? "This review stopped before reading the commits; it ran when this was the latest commit"
                                                : reviewOpen
                                                  ? "Hide its steps"
                                                  : "Show its steps"
                                        }
                                        onClick={() =>
                                            setOpenReviews((s) =>
                                                toggle(s, review.key),
                                            )
                                        }
                                        className="text-text-primary inline-flex items-center gap-1.5 whitespace-nowrap tabular-nums hover:underline">
                                        <span
                                            className={TONE_TEXT[outcome.tone]}>
                                            {TONE_ICON[outcome.tone]}
                                        </span>
                                        Review {review.number} {outcome.word}
                                    </button>
                                ) : (
                                    <span
                                        className="text-text-tertiary"
                                        title="No review on this commit">
                                        <span aria-hidden>—</span>
                                        <span className="sr-only">
                                            No review
                                        </span>
                                    </span>
                                )}
                                {olderReviews.length > 0 && (
                                    <span
                                        className="text-text-tertiary"
                                        title={olderReviews
                                            .map((r) => `Review ${r.number}`)
                                            .join(", ")}>
                                        +{olderReviews.length}
                                    </span>
                                )}
                            </div>
                            <div className="flex items-center gap-2 text-xs tabular-nums">
                                {review && (
                                    <>
                                        <span
                                            title="Delivered on this commit"
                                            className={cn(
                                                "flex items-center gap-1",
                                                review.execution
                                                    .suggestionsCount?.sent > 0
                                                    ? "text-success"
                                                    : "text-text-tertiary",
                                            )}>
                                            <CheckIcon className="size-3" />
                                            {review.execution.suggestionsCount
                                                ?.sent ?? 0}
                                        </span>
                                        <span
                                            title="Held back by your review configuration"
                                            className={cn(
                                                "flex items-center gap-1",
                                                review.execution
                                                    .suggestionsCount
                                                    ?.filtered > 0
                                                    ? "text-danger"
                                                    : "text-text-tertiary",
                                            )}>
                                            <FilterIcon className="size-3" />
                                            {review.execution.suggestionsCount
                                                ?.filtered ?? 0}
                                        </span>
                                    </>
                                )}
                            </div>
                            {hasRuntimeColumn &&
                                (showRuntime ? (
                                    <CommitRuntime
                                        run={run}
                                        commit={commit}
                                        runtime={runtime}
                                        repositoryId={latest.repositoryId}
                                        prNumber={latest.prNumber}
                                    />
                                ) : (
                                    <span aria-hidden />
                                ))}
                            <span aria-hidden />
                        </div>
                        {regression && run.firstRegression && (
                            <div className={cn(grid, "px-5 pb-1.5")}>
                                <Rail
                                    node="fold"
                                    first={false}
                                    last={last && !reviewOpen}
                                />
                                <p className="text-text-secondary col-[2/-1] pl-3 text-xs">
                                    {regressionSentence(
                                        run.firstRegression,
                                        run.baseBranch,
                                    )}
                                    {run.regressions > 1 && (
                                        <span className="text-text-tertiary">
                                            {" "}
                                            (+
                                            {plural(
                                                run.regressions - 1,
                                                "more finding",
                                            )}
                                            )
                                        </span>
                                    )}{" "}
                                    <NextLink
                                        href={runHref(run.runId)}
                                        onClick={(e) => e.stopPropagation()}
                                        className="text-primary-light inline-flex items-center gap-0.5 font-medium whitespace-nowrap hover:underline">
                                        Open the Run
                                        <ArrowRightIcon className="size-3" />
                                    </NextLink>
                                </p>
                            </div>
                        )}
                        {reviewOpen && (
                            <div className={cn(grid, "px-5 pb-2")}>
                                <Rail node="fold" first={false} last={last} />
                                <div className="col-[2/-1] pb-1">
                                    {renderReviewDetail(review.execution)}
                                </div>
                            </div>
                        )}
                    </Fragment>
                );
            })}
            {files.isLoading && (
                <div className={cn(grid, "px-5 py-1.5")}>
                    <span aria-hidden />
                    <span className="text-text-tertiary flex items-center gap-2 text-xs">
                        <Spinner className="size-3" /> Loading the commits…
                    </span>
                </div>
            )}
            {files.isError && (
                <div className={cn(grid, "px-5 py-1.5")}>
                    <span aria-hidden />
                    <span className="text-text-tertiary col-[2/-1] text-xs">
                        Couldn&apos;t load the branch&apos;s commits; showing
                        the commits Kody reviewed or ran on.
                    </span>
                </div>
            )}
        </div>
    );
};
