"use client";

import { useEffect, useState } from "react";
import NextLink from "next/link";
import {
    RuntimeEmptyState,
    RuntimeErrorState,
} from "@components/runtime/empty-state";
import { RelativeTime } from "@components/runtime/relative-time";
import { RepositorySelect } from "@components/runtime/repository-select";
import { RunCostTotal } from "@components/runtime/run-cost";
import { RuntimeHeader } from "@components/runtime/runtime-header";
import { StatusChip } from "@components/runtime/status-chip";
import { Button } from "@components/ui/button";
import { Page } from "@components/ui/page";
import { Skeleton } from "@components/ui/skeleton";
import {
    Table,
    TableBody,
    TableCell,
    TableContainer,
    TableHead,
    TableHeader,
    TableRow,
} from "@components/ui/table";
import { useCodeReviewScopes } from "@services/parameters/use-code-review-scopes";
import { MAX_RUNS_PAGE } from "@services/runtime/api";
import { shortSha } from "@services/runtime/format";
import { runListRow } from "@services/runtime/model/run-list";
import { RUNS_PAGE_SIZE, useRuntimeRuns } from "@services/runtime/queries";
import { useQueryState } from "nuqs";

export const RunsPage = () => {
    const repositories = useCodeReviewScopes();
    const [repositoryId, setRepositoryId] = useQueryState("repositoryId");
    const [limit, setLimit] = useState(RUNS_PAGE_SIZE);

    // The list is per repository (GET /runtime/runs?repositoryId=): open on
    // the first one instead of an empty screen.
    useEffect(() => {
        if (!repositoryId && repositories.length > 0)
            setRepositoryId(repositories[0].id);
    }, [repositoryId, repositories, setRepositoryId]);

    const runs = useRuntimeRuns({
        repositoryId: repositoryId ?? undefined,
        limit,
    });
    // The API has no cursor: "Show more" asks for a bigger page, up to its cap.
    const mayHaveMore =
        !!runs.data && runs.data.length >= limit && limit < MAX_RUNS_PAGE;

    return (
        <Page.Root>
            <RuntimeHeader />
            <Page.Content>
                <div className="flex flex-wrap items-center gap-3">
                    <RepositorySelect
                        repositories={repositories}
                        value={repositoryId ?? undefined}
                        onChange={(id) => {
                            setLimit(RUNS_PAGE_SIZE);
                            setRepositoryId(id);
                        }}
                    />
                    <p className="text-text-tertiary text-xs">
                        Each Run boots the base branch and the pull request the
                        same way and compares what they answer.
                    </p>
                </div>

                {!repositoryId ? (
                    <RuntimeEmptyState title="No repository yet">
                        Connect a repository to see its Runtime runs.
                    </RuntimeEmptyState>
                ) : runs.isLoading ? (
                    <Skeleton className="h-48 w-full" />
                ) : runs.isError ? (
                    <RuntimeErrorState
                        what="runs"
                        error={runs.error}
                        onRetry={() => runs.refetch()}
                    />
                ) : !runs.data?.length ? (
                    <RuntimeEmptyState title="No runs for this repository">
                        A Run starts when a PR matches the repository&apos;s
                        rules, or when someone comments{" "}
                        <code className="font-mono">@kody runtime</code> on it.
                    </RuntimeEmptyState>
                ) : (
                    <>
                        <TableContainer>
                            <Table>
                                <TableHeader>
                                    <TableRow>
                                        <TableHead>Pull request</TableHead>
                                        <TableHead>Verdict</TableHead>
                                        <TableHead>Requested</TableHead>
                                        <TableHead align="right">
                                            Duration
                                        </TableHead>
                                        <TableHead align="right">
                                            Cost (estimate)
                                        </TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {runs.data.map((run) => {
                                        const row = runListRow(run);
                                        return (
                                            <TableRow key={run.runId}>
                                                <TableCell>
                                                    {/* White at rest, the accent only under the pointer, as on the PR list. */}
                                                    {/* The title is the author's text: rendered as text, cut to the column, whole on hover. */}
                                                    <span className="flex max-w-md min-w-0 flex-col gap-0.5">
                                                        <NextLink
                                                            href={`/runtime/runs/${encodeURIComponent(run.runId)}`}
                                                            title={row.prTitle}
                                                            className="text-text-primary hover:text-primary-light w-fit max-w-full truncate text-sm font-semibold transition-colors hover:underline">
                                                            {row.prTitle ??
                                                                `#${run.prNumber}`}
                                                        </NextLink>
                                                        <span className="text-text-tertiary text-xs">
                                                            {row.prTitle &&
                                                                `#${run.prNumber} · `}
                                                            <span className="font-mono">
                                                                {shortSha(
                                                                    run.headSha,
                                                                )}
                                                            </span>
                                                            {row.attempt &&
                                                                ` · ${row.attempt}`}
                                                        </span>
                                                    </span>
                                                </TableCell>
                                                <TableCell>
                                                    <span className="flex max-w-md flex-col gap-1">
                                                        <StatusChip
                                                            tone={
                                                                row.verdict.tone
                                                            }>
                                                            {row.verdict.label}
                                                        </StatusChip>
                                                        {row.detail && (
                                                            <span className="text-text-secondary truncate text-xs">
                                                                {row.detail}
                                                            </span>
                                                        )}
                                                    </span>
                                                </TableCell>
                                                <TableCell className="text-text-secondary text-sm">
                                                    <RelativeTime
                                                        at={run.requestedAt}
                                                    />
                                                </TableCell>
                                                <TableCell
                                                    align="right"
                                                    className={
                                                        row.duration.measured
                                                            ? "font-mono text-xs tabular-nums"
                                                            : "text-text-tertiary text-xs"
                                                    }>
                                                    {row.duration.text}
                                                </TableCell>
                                                <TableCell align="right">
                                                    <RunCostTotal
                                                        cost={run.cost}
                                                    />
                                                </TableCell>
                                            </TableRow>
                                        );
                                    })}
                                </TableBody>
                            </Table>
                        </TableContainer>
                        {mayHaveMore && (
                            <Button
                                size="sm"
                                variant="helper"
                                className="w-fit self-center"
                                loading={runs.isFetching}
                                onClick={() =>
                                    setLimit((l) =>
                                        Math.min(
                                            MAX_RUNS_PAGE,
                                            l + RUNS_PAGE_SIZE,
                                        ),
                                    )
                                }>
                                Show more
                            </Button>
                        )}
                    </>
                )}
            </Page.Content>
        </Page.Root>
    );
};
