"use client";

import { useMemo } from "react";
import NextLink from "next/link";
import { ConnectedFindings } from "@components/runtime/connected-findings";
import { RuntimeErrorState } from "@components/runtime/empty-state";
import { RecipeChangedNotice } from "@components/runtime/recipe-changed-notice";
import { ApproveRunButton, RerunButton } from "@components/runtime/run-actions";
import { RunCostTotal } from "@components/runtime/run-cost";
import { TestedPaths, testedSummary } from "@components/runtime/tested-paths";
import { Skeleton } from "@components/ui/skeleton";
import { shortSha } from "@services/runtime/format";
import {
    cellOwnerLabel,
    isTerminalRunState,
    runStateLabel,
} from "@services/runtime/labels";
import { buildFindings } from "@services/runtime/model/findings";
import { buildRunPaths } from "@services/runtime/model/run-paths";
import {
    useRunStream,
    useRuntimeRun,
    useRuntimeRuns,
} from "@services/runtime/queries";

/**
 * The Kody Runtime tab of a PR (screen 8): the latest Run of this PR, one row
 * per tested path. The Run page keeps the full log and the states.
 *
 * Only the latest Run is asked for (limit 1, newest first); its detail and
 * its stream then load side by side.
 */
export function PrRuntimeTab({
    repositoryId,
    prNumber,
    patchFiles,
}: {
    repositoryId: string;
    prNumber: number;
    /** The files the Files view already loaded: the finding's diff hunk is cut from them. */
    patchFiles?: { filename: string; patch?: string }[];
}) {
    const patchOf = (file: string) =>
        patchFiles?.find((f) => f.filename === file)?.patch;
    const runs = useRuntimeRuns({ repositoryId, prNumber, limit: 1 });
    const latest = runs.data?.[0];
    const runQuery = useRuntimeRun(latest?.runId);
    const { view } = useRunStream(
        latest?.runId,
        runQuery.data?.state ?? latest?.state,
    );
    const run = runQuery.data ?? undefined;
    const runPaths = useMemo(
        () => (run ? buildRunPaths(run, view.steps) : undefined),
        [run, view.steps],
    );
    const findings = useMemo(
        () => (run ? buildFindings(run, view.steps) : []),
        [run, view.steps],
    );

    if (runs.isLoading || (latest && runQuery.isLoading)) {
        return (
            <div className="mt-6 flex flex-col gap-3" aria-busy="true">
                <span className="sr-only">Loading the Runtime run…</span>
                <Skeleton className="h-6 w-96" />
                <Skeleton className="h-32 w-full" />
            </div>
        );
    }
    if (runs.isError || runQuery.isError) {
        return (
            <div className="mt-6">
                <RuntimeErrorState
                    what="the Runtime run"
                    error={runs.error ?? runQuery.error}
                    onRetry={() =>
                        runs.isError ? runs.refetch() : runQuery.refetch()
                    }
                />
            </div>
        );
    }
    if (!run || !runPaths) {
        return (
            <div className="mt-6 flex flex-col gap-1 text-sm">
                <p className="text-text-primary">
                    Kody Runtime has not run on this pull request.
                </p>
                <p className="text-text-secondary">
                    Comment <code className="font-mono">@kody runtime</code> on
                    the PR, or set when it runs in the{" "}
                    <NextLink
                        href={`/settings/code-review/${encodeURIComponent(repositoryId)}/kody-runtime`}
                        className="text-primary-light hover:underline">
                        repository settings
                    </NextLink>
                    .
                </p>
            </div>
        );
    }

    const regressions = findings.filter((f) => !f.intended).length;
    return (
        <div className="mt-4 flex flex-col gap-4">
            <div className="text-text-secondary flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
                <h2 className="text-text-primary text-sm font-medium">
                    {regressions > 0
                        ? `✕ ${regressions} ${regressions === 1 ? "regression" : "regressions"}`
                        : runStateLabel(run.state)}{" "}
                    · <span className="font-mono">{shortSha(run.headSha)}</span>
                </h2>
                <span className="ml-auto flex items-center gap-3">
                    <NextLink
                        href={`/runtime/runs/${encodeURIComponent(run.runId)}`}
                        className="text-text-tertiary text-xs hover:underline">
                        Full log
                    </NextLink>
                    <ApproveRunButton run={run} size="sm" />
                    <RerunButton run={run} size="sm" variant="secondary" />
                </span>
            </div>
            <RecipeChangedNotice run={run} />
            <ConnectedFindings
                run={run}
                findings={findings}
                runPaths={runPaths}
                live={!isTerminalRunState(run.state)}
                patchOf={patchOf}
            />
            <details className="text-sm">
                <summary className="text-text-secondary cursor-pointer">
                    Details
                </summary>
                <div className="mt-3 flex flex-col gap-3">
                    <p className="text-text-secondary">
                        {testedSummary(runPaths)} ·{" "}
                        {cellOwnerLabel(run.cellOwner)} · Cost{" "}
                        <RunCostTotal cost={run.cost} />
                    </p>
                    <TestedPaths run={run} runPaths={runPaths} />
                </div>
            </details>
        </div>
    );
}
