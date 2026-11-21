"use client";

import { useMemo } from "react";
import NextLink from "next/link";
import { RelativeTime } from "@components/runtime/relative-time";
import { RerunButton } from "@components/runtime/run-actions";
import { StatusChip } from "@components/runtime/status-chip";
import {
    durationBetween,
    formatDurationMs,
    shortRepositoryName,
    shortSha,
} from "@services/runtime/format";
import { ranWithOf } from "@services/runtime/model/environment-repositories";
import {
    cannotRequestRunReason,
    canRequestRun,
    environmentNameOf,
    isLiveRunState,
    mainRunOf,
    requestRunRepositoryIds,
    runHref,
    runVerdictWords,
    type PrRuntime,
} from "@services/runtime/model/pull-request-runs";
import { usePullRequestRuns } from "@services/runtime/pull-request-runs";
import { useRuntimeRun } from "@services/runtime/queries";

import {
    OtherEnvironmentsHint,
    RequestRunButton,
} from "../../../_components/pr-runtime";

/**
 * The Runtime state of one PR: the same call the list makes, for one PR, so
 * the tab badge, the card and the list read the same answer.
 */
export const usePrRuntime = (
    repositoryId: string,
    prNumber: number,
    enabled: boolean,
): PrRuntime | undefined => {
    const pullRequests = useMemo(
        () => [{ repositoryId, prNumber }],
        [repositoryId, prNumber],
    );
    const { byPullRequest } = usePullRequestRuns(pullRequests, enabled);
    return [...byPullRequest.values()][0];
};

const Row = ({
    label,
    children,
}: {
    label: string;
    children: React.ReactNode;
}) => (
    <div className="flex items-baseline justify-between gap-3 text-xs">
        <span className="text-[var(--text-dim)]">{label}</span>
        <span className="min-w-0 truncate text-right text-[var(--text-muted)]">
            {children}
        </span>
    </div>
);

/**
 * "Kody Runtime" at the top of the PR page's right rail: the latest Run's
 * verdict, where and on what it ran, and the way into it. A repository with
 * no Runtime environment shows no card.
 */
export const PrRuntimeCard = ({
    runtime,
    repositoryId,
    prNumber,
}: {
    runtime: PrRuntime;
    repositoryId: string;
    prNumber: number;
}) => {
    // The verdict of the environment the repository is the primary of, when
    // it is in several; the others are listed under "+N environments".
    const latest = mainRunOf(runtime);
    // The detail is read only for what the summary does not carry (the
    // other repositories the Run booted with), which a Run fixes when it
    // starts: read once, not polled (the summary's chunk keeps the verdict moving).
    const detail = useRuntimeRun(latest?.runId, { poll: false });
    const workspace = ranWithOf(detail.data);
    const shownName = latest
        ? (environmentNameOf(runtime, latest.environmentId) ??
          runtime.environment?.name)
        : runtime.environment?.name;
    const environmentName = shortRepositoryName(shownName) ?? shownName;

    if (!latest) {
        if (!runtime.environment) return null;
        const canRequest = canRequestRun(runtime);
        const several = (runtime.environments?.length ?? 0) > 1;
        return (
            <section
                aria-label="Kody Runtime"
                className="space-y-2.5 rounded-xl border border-[var(--border)] bg-[var(--bg-2)]/70 px-3.5 py-3"
                style={{ boxShadow: "var(--shadow-card)" }}>
                <h3 className="text-3xs font-semibold tracking-[0.14em] text-[var(--text-dim)] uppercase">
                    Kody Runtime
                </h3>
                <p className="text-xs text-[var(--text-muted)]">
                    {canRequest
                        ? several
                            ? `Not run on this pull request yet. It runs in ${runtime.environments!.filter((e) => e.triggers !== false).length} environments: one Run each.`
                            : "Not run on this pull request yet."
                        : (cannotRequestRunReason(runtime) ??
                          "Not run on this pull request yet.")}
                </p>
                <OtherEnvironmentsHint runtime={runtime} />
                {canRequest && (
                    <RequestRunButton
                        repositoryId={repositoryId}
                        prNumber={prNumber}
                        repositoryIds={requestRunRepositoryIds(runtime)}
                        size="sm"
                    />
                )}
            </section>
        );
    }

    const verdict = runVerdictWords(latest);
    const live = isLiveRunState(latest.state);
    const took = durationBetween(
        latest.startedAt ?? latest.requestedAt,
        latest.finishedAt,
    );
    return (
        <section
            aria-label="Kody Runtime"
            className="space-y-2.5 rounded-xl border border-[var(--border)] bg-[var(--bg-2)]/70 px-3.5 py-3"
            style={{ boxShadow: "var(--shadow-card)" }}>
            <div className="flex items-center justify-between gap-2">
                <h3 className="text-3xs font-semibold tracking-[0.14em] text-[var(--text-dim)] uppercase">
                    Kody Runtime
                </h3>
                <StatusChip tone={verdict.tone}>{verdict.label}</StatusChip>
            </div>
            <div className="space-y-1">
                {environmentName && (
                    <Row label="Environment">{environmentName}</Row>
                )}
                <Row label="Commit">
                    <span className="font-mono">
                        {shortSha(latest.headSha)}
                    </span>
                </Row>
                <Row label={live ? "Running for" : "Took"}>
                    {live
                        ? formatDurationMs(
                              durationBetween(
                                  latest.startedAt ?? latest.requestedAt,
                                  new Date().toISOString(),
                              ),
                          )
                        : formatDurationMs(took)}
                </Row>
                <Row label={live ? "Started" : "Finished"}>
                    <RelativeTime
                        at={
                            live
                                ? (latest.startedAt ?? latest.requestedAt)
                                : (latest.finishedAt ?? latest.requestedAt)
                        }
                    />
                </Row>
            </div>
            {workspace.length > 0 && (
                <div className="space-y-0.5 border-t border-[var(--border)]/60 pt-2 text-xs text-[var(--text-muted)]">
                    <span className="text-[var(--text-dim)]">Ran with</span>
                    <ul aria-label="Ran with" className="space-y-0.5">
                        {workspace.map((w) => (
                            <li
                                key={`${w.alias}:${w.sha}`}
                                className="truncate">
                                <span className="text-[var(--text)]">
                                    {w.alias}
                                </span>{" "}
                                <span className="font-mono">
                                    {shortSha(w.sha)}
                                </span>{" "}
                                ({w.from})
                            </li>
                        ))}
                    </ul>
                </div>
            )}
            <OtherEnvironmentsHint runtime={runtime} />
            <div className="flex flex-wrap items-center gap-3 pt-0.5">
                <NextLink
                    href={runHref(latest.runId)}
                    className="text-xs font-medium text-[var(--accent)] hover:underline">
                    Open the Run
                </NextLink>
                <RerunButton
                    run={{
                        runId: latest.runId,
                        repositoryId,
                        state: latest.state,
                        workspace: detail.data?.workspace,
                    }}
                    size="xs"
                    variant="helper"
                />
            </div>
        </section>
    );
};
