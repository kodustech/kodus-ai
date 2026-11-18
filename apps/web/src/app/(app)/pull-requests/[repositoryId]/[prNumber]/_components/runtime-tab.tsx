"use client";

import { useMemo } from "react";
import NextLink from "next/link";
import { RuntimeErrorState } from "@components/runtime/empty-state";
import { RecipeChangedNotice } from "@components/runtime/recipe-changed-notice";
import { RunCostTotal } from "@components/runtime/run-cost";
import { ApproveRunButton, RerunButton } from "@components/runtime/run-actions";
import { StatusChip } from "@components/runtime/status-chip";
import { TestedPaths, testedSummary } from "@components/runtime/tested-paths";
import { Skeleton } from "@components/ui/skeleton";
import { shortSha } from "@services/runtime/format";
import {
    cellOwnerLabel,
    checkConclusionLabel,
    checkConclusionTone,
    isCheckFinal,
    runStateLabel,
    runStateTone,
} from "@services/runtime/labels";
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
}: {
    repositoryId: string;
    prNumber: number;
}) {
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

    const check = isCheckFinal(run.state) ? run.check : undefined;
    return (
        <div className="mt-4 flex flex-col gap-4">
            <div className="text-text-secondary flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
                {check ? (
                    <StatusChip tone={checkConclusionTone(check.conclusion)}>
                        {checkConclusionLabel(check.conclusion)}
                    </StatusChip>
                ) : (
                    <StatusChip tone={runStateTone(run.state)}>
                        {runStateLabel(run.state)}
                    </StatusChip>
                )}
                {check && (
                    <span className="text-text-primary font-medium">
                        {check.title}
                    </span>
                )}
                <span>
                    {testedSummary(runPaths)} · on{" "}
                    <span className="font-mono">{shortSha(run.headSha)}</span>
                </span>
                <span>{cellOwnerLabel(run.cellOwner)}</span>
                <span className="flex items-center gap-1">
                    Cost <RunCostTotal cost={run.cost} />
                </span>
                <span className="ml-auto flex items-center gap-3">
                    <NextLink
                        href={`/runtime/runs/${encodeURIComponent(run.runId)}`}
                        className="text-primary-light hover:underline">
                        Full run log
                    </NextLink>
                    <ApproveRunButton run={run} size="sm" />
                    <RerunButton run={run} size="sm" variant="secondary" />
                </span>
            </div>
            <RecipeChangedNotice run={run} />
            <TestedPaths run={run} runPaths={runPaths} />
        </div>
    );
}
