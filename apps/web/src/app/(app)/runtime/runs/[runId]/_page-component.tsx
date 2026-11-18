"use client";

import { useMemo } from "react";
import NextLink from "next/link";
import { BootFailurePanel } from "@components/runtime/boot-failure";
import {
    openDisclosure,
    RuntimeDisclosure,
} from "@components/runtime/disclosure";
import {
    RuntimeEmptyState,
    RuntimeErrorState,
} from "@components/runtime/empty-state";
import { RecipeChangedNotice } from "@components/runtime/recipe-changed-notice";
import { RelativeTime } from "@components/runtime/relative-time";
import { RichTextView } from "@components/runtime/rich-text";
import { ApproveRunButton, RerunButton } from "@components/runtime/run-actions";
import { RunCostBreakdown } from "@components/runtime/run-cost";
import {
    ExercisedFilesList,
    RunCoverageList,
} from "@components/runtime/run-coverage";
import {
    findingAnchorId,
    RunFindingsView,
} from "@components/runtime/run-findings";
import { RunLogView } from "@components/runtime/run-log";
import { RunPreviewCard } from "@components/runtime/run-preview";
import { RunTimingView } from "@components/runtime/run-timing";
import {
    PRIMARY_ACTION_CLASS,
    RunVerdictSummary,
} from "@components/runtime/run-verdict-summary";
import { RunWorkspaceSection } from "@components/runtime/run-workspace";
import { Fact, RuntimeSection } from "@components/runtime/section";
import { StuckNotice } from "@components/runtime/stuck-notice";
import { Button } from "@components/ui/button";
import { Heading } from "@components/ui/heading";
import { Page } from "@components/ui/page";
import { Skeleton } from "@components/ui/skeleton";
import { toast } from "@components/ui/toaster/use-toast";
import { usePermissionOnEvery } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import { useInfinitePullRequestExecutions } from "@services/pull-requests/hooks";
import type { RuntimeRun } from "@services/runtime/contracts";
import {
    formatDurationMs,
    formatEstimatedUsd,
    shortSha,
} from "@services/runtime/format";
import {
    cellOwnerLabel,
    isCheckFinal,
    isTerminalRunState,
} from "@services/runtime/labels";
import { baseVersionLabel } from "@services/runtime/model/base-version";
import { bootFailureOf } from "@services/runtime/model/boot-failure";
import { coverageRows } from "@services/runtime/model/coverage";
import {
    ENVIRONMENT_SECTION,
    environmentHref,
} from "@services/runtime/model/environment";
import {
    pullRequestBranchOf,
    repositoryIdsOfRun,
    repositoryLabel,
    workspaceSideRows,
} from "@services/runtime/model/environment-repositories";
import { runtimeErrorMessage } from "@services/runtime/model/errors";
import { buildFindings } from "@services/runtime/model/findings";
import { runFacts } from "@services/runtime/model/run-facts";
import { buildRunLog } from "@services/runtime/model/run-log";
import { buildRunPaths } from "@services/runtime/model/run-paths";
import { runStats, runSummary } from "@services/runtime/model/run-summary";
import { runTiming, timingTakeaway } from "@services/runtime/model/run-timing";
import {
    useFindingFeedback,
    useFindingIntent,
    useRunBeingRecorded,
    useRunStream,
    useRuntimeEnvironment,
    useRuntimeRun,
    type RunStreamStatus,
} from "@services/runtime/queries";
import { ArrowLeftIcon, ExternalLinkIcon } from "lucide-react";

const STREAM_STATUS_LABEL: Record<RunStreamStatus, string> = {
    idle: "Connecting",
    live: "Live",
    reconnecting: "Reconnecting",
    waiting: "Waiting for the first event",
    paused: "Paused while this tab is hidden",
    done: "Finished",
    failed: "Live view unavailable · refreshing every few seconds",
};

const PLATFORM: Record<string, string> = {
    GITHUB: "GitHub",
    GITLAB: "GitLab",
    BITBUCKET: "Bitbucket",
    AZURE_REPOS: "Azure Repos",
};

/** States whose recorded reason says why there is no verdict. */
const REASON_STATES = new Set<RuntimeRun["state"]>([
    "skipped",
    "could_not_boot",
    "errored",
    "cancelled",
    "timed_out",
]);

/**
 * The PR's title, link and platform, from Kodus's own record of the pull
 * request (its code review executions). The Run projection has only the
 * title the Run was requested with (`prTitle`, absent on older Runs): the
 * header falls back to it, and a PR Kodus never reviewed has no link.
 */
const usePullRequestMeta = (run: RuntimeRun | undefined) => {
    const { items } = useInfinitePullRequestExecutions(
        run
            ? {
                  teamId: run.teamId,
                  repositoryId: run.repositoryId,
                  pullRequestNumber: String(run.prNumber),
              }
            : undefined,
        // Not before the Run is known: without its filters this is an org-wide scan (WP5).
        { pageSize: 1, poll: false, enabled: !!run },
    );
    const pr = run ? items.find((e) => e.prNumber === run.prNumber) : undefined;
    return pr
        ? {
              title: pr.title,
              url: pr.url,
              author: pr.author?.username,
              platform: PLATFORM[pr.provider],
          }
        : undefined;
};

/** "Kodus cloud · setup file from main at abc1234 · 3 repositories": what was running, on one line. */
const whatWasRunningLine = (
    run: RuntimeRun,
    baseLabel: string,
    repositories: number,
) =>
    [
        `On ${cellOwnerLabel(run.cellOwner)}`,
        run.recipe?.state === "absent"
            ? "no setup file"
            : run.recipe?.sha
              ? `setup file from ${baseLabel} at ${shortSha(run.recipe.sha)}`
              : "the environment's setup file",
        repositories > 0 ? `${repositories} repositories` : undefined,
    ]
        .filter(Boolean)
        .join(" · ");

/** What started the Run, in the header's words. */
const TRIGGER_LABEL: Record<NonNullable<RuntimeRun["trigger"]>, string> = {
    pull_request: "Started by a pull request event",
    comment: "Asked with @kody runtime",
    run_again: "Run again",
    simulate: "Simulation · nothing is posted",
};

export const RunDetailPage = ({ runId }: { runId: string }) => {
    const runQuery = useRuntimeRun(runId);
    const run = runQuery.data ?? undefined;
    // Started a moment ago ("Run again", "Run on this PR"): the worker has
    // not recorded it yet, so the page waits for it instead of "not found".
    const recording = useRunBeingRecorded(runId, runQuery);
    // The stream starts with the projection, not after it; once the Run is
    // known not to exist (null), it is not followed at all.
    const { view, status } = useRunStream(
        runQuery.data === null ? undefined : runId,
        run?.state,
    );
    const pr = usePullRequestMeta(run);
    const prTitle = pr?.title || run?.prTitle;
    const vote = useFindingFeedback();
    const intent = useFindingIntent();
    // Marking a finding intended is gated like "Run again": write on Runs of this repository.
    const canMarkIntended = usePermissionOnEvery(
        Action.Create,
        ResourceType.RuntimeRun,
        run ? repositoryIdsOfRun(run) : [],
    );

    // A multi-repository Run names its repositories by id and folder: the
    // environment, read once, gives their names (a removed one keeps its folder).
    const environment = useRuntimeEnvironment(
        run?.workspace?.length ? run.environmentId : undefined,
    );
    const workspaceRows = useMemo(() => {
        if (!run?.workspace?.length) return [];
        const names = new Map<string, string>(
            (environment.data?.repositories ?? []).map((r) => [
                r.repositoryId,
                repositoryLabel(r),
            ]),
        );
        names.set(
            run.repositoryId,
            repositoryLabel({
                repositoryName: run.repositoryName,
                fullName: run.repositoryName,
            }),
        );
        return workspaceSideRows(run, names);
    }, [run, environment.data]);

    const derived = useMemo(() => {
        if (!run) return undefined;
        const runPaths = buildRunPaths(run, view.steps);
        const findings = buildFindings(run, view.steps);
        const timing = runTiming(run, view);
        return {
            runPaths,
            findings,
            timing,
            summary: runSummary(run, runPaths, findings, runFacts(run, view)),
            stats: runStats(runPaths, timing.totalMs),
            coverage: coverageRows(runPaths, run),
            log: buildRunLog(run, view, runPaths, timing),
            bootFailure: bootFailureOf(run),
            timingLine: timingTakeaway(timing, {
                live: !isTerminalRunState(run.state),
            }),
        };
    }, [run, view]);

    if (runQuery.isLoading) {
        return (
            <Page.Root>
                <Page.Content>
                    <Skeleton className="h-10 w-80" />
                    <Skeleton className="h-64 w-full" />
                </Page.Content>
            </Page.Root>
        );
    }

    if (runQuery.isError || !run || !derived) {
        return (
            <Page.Root>
                <Page.Content>
                    {runQuery.isError ? (
                        <RuntimeErrorState
                            what="this run"
                            error={runQuery.error}
                            onRetry={() => runQuery.refetch()}
                        />
                    ) : recording ? (
                        <RuntimeEmptyState title="Run queued" role="status">
                            Kody Runtime is recording this Run. This page opens
                            it as soon as it starts.
                        </RuntimeEmptyState>
                    ) : (
                        <RuntimeEmptyState title="Run not found">
                            It may belong to another organization, or the Run
                            was never recorded.{" "}
                            <NextLink
                                href="/runtime/runs"
                                className="text-primary-light hover:underline">
                                Back to runs
                            </NextLink>
                        </RuntimeEmptyState>
                    )}
                </Page.Content>
            </Page.Root>
        );
    }

    const baseLabel = baseVersionLabel(run);
    const live = !isTerminalRunState(run.state);
    const check =
        view.verdict?.check ??
        (isCheckFinal(run.state) ? run.check : undefined);
    const {
        runPaths,
        findings,
        timing,
        summary,
        stats,
        coverage,
        log,
        bootFailure,
        timingLine,
    } = derived;
    const logNote =
        status === "failed"
            ? "The live view could not be opened for this Run: the log shows what the Run record kept."
            : !live && status === "done" && view.states.length === 0
              ? "The step-by-step stream of this Run is gone (it is kept 30 days): the log shows what the Run record kept."
              : undefined;
    const openPrClass =
        "bg-card-lv2 text-text-primary focus-visible:ring-ring inline-flex min-h-12 items-center gap-2 rounded-xl px-6 text-sm font-semibold hover:brightness-120 focus-visible:ring-3 focus-visible:outline-none";

    const markIntended = (probeId: string, intended: boolean) =>
        intent.mutate(
            { runId: run.runId, probeId, intended },
            {
                onError: (error) =>
                    toast({
                        variant: "danger",
                        title: "Couldn't save the mark",
                        description: runtimeErrorMessage(error, {
                            fallback: "Try again in a moment.",
                        }),
                    }),
            },
        );

    // The verdict card's one action, by state (run-summary's `todo.action`).
    const action = summary.todo?.action;
    const openFinding = (probeId: string) => (
        <a
            href={`#${findingAnchorId(probeId)}`}
            onClick={() => openDisclosure(findingAnchorId(probeId))}
            className={PRIMARY_ACTION_CLASS}>
            Open the finding
        </a>
    );
    const primaryAction =
        action?.kind === "run_again" ? (
            <RerunButton run={run} size="md" />
        ) : action?.kind === "mark_intended" ? (
            canMarkIntended ? (
                <Button
                    size="md"
                    variant="primary"
                    loading={
                        intent.isPending &&
                        intent.variables?.probeId === action.probeId
                    }
                    title="Kody keeps it to learn from. The check and the PR comment keep what Kody measured."
                    onClick={() => markIntended(action.probeId, true)}>
                    This change is intended
                </Button>
            ) : (
                openFinding(action.probeId)
            )
        ) : action?.kind === "open_finding" ? (
            openFinding(action.probeId)
        ) : undefined;
    const elapsed =
        timing.totalMs !== undefined
            ? formatDurationMs(timing.totalMs)
            : undefined;

    return (
        <Page.Root>
            <Page.Header>
                <div className="flex min-w-0 flex-col gap-2">
                    <NextLink
                        href={`/runtime/runs?repositoryId=${encodeURIComponent(run.repositoryId)}`}
                        className="text-text-secondary inline-flex min-h-11 w-fit items-center gap-1 text-sm hover:underline">
                        <ArrowLeftIcon className="size-4" aria-hidden /> Runs of{" "}
                        {run.repositoryName}
                    </NextLink>
                    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                        <Heading variant="h1">
                            {run.repositoryName} #{run.prNumber}
                        </Heading>
                        {prTitle && (
                            <span className="text-text-secondary text-lg font-medium">
                                {prTitle}
                            </span>
                        )}
                    </div>
                    <p className="text-text-secondary text-sm">
                        {pr?.author && (
                            <>
                                PR by{" "}
                                <span className="text-text-primary">
                                    @{pr.author}
                                </span>{" "}
                                ·{" "}
                            </>
                        )}
                        {run.trigger && `${TRIGGER_LABEL[run.trigger]} · `}
                        Requested <RelativeTime at={run.requestedAt} />
                        {run.attempt > 1 && ` · run ${run.attempt}`} · this PR{" "}
                        <code className="text-text-primary font-mono">
                            {shortSha(run.headSha)}
                        </code>{" "}
                        vs {baseLabel}{" "}
                        <code className="text-text-primary font-mono">
                            {shortSha(run.baseSha)}
                        </code>
                        {live && (
                            <span role="status" aria-live="polite">
                                {" "}
                                · {STREAM_STATUS_LABEL[status]}
                            </span>
                        )}
                    </p>
                </div>
                <Page.HeaderActions>
                    {pr?.url ? (
                        <a
                            href={pr.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className={openPrClass}>
                            Open the PR
                            <ExternalLinkIcon className="size-4" aria-hidden />
                            <span className="sr-only">
                                (opens in a new tab)
                            </span>
                        </a>
                    ) : (
                        <NextLink
                            href={`/pull-requests/${encodeURIComponent(run.repositoryId)}/${run.prNumber}`}
                            className={openPrClass}>
                            Open the PR
                        </NextLink>
                    )}
                    <ApproveRunButton run={run} size="lg" />
                    {/* The verdict card carries "Run again" when it is the thing to do: one amber button, not two. */}
                    {action?.kind !== "run_again" && (
                        <RerunButton run={run} size="lg" variant="helper" />
                    )}
                </Page.HeaderActions>
            </Page.Header>

            <Page.Content>
                <RunVerdictSummary
                    state={run.state}
                    check={check}
                    checkPlatform={pr?.platform}
                    summary={summary}
                    stats={stats}
                    costUsd={run.cost?.totalUsd}
                    publication={run.publication}
                    reason={
                        REASON_STATES.has(run.state) ? run.reason : undefined
                    }
                    primaryAction={primaryAction}
                />

                <StuckNotice what="Run" stuck={run.stuck} />

                {bootFailure && (
                    <RuntimeSection
                        title={
                            bootFailure.kodusSide
                                ? "What failed on Kodus's side"
                                : bootFailure.side === "pr"
                                  ? "Why this PR did not boot"
                                  : `Why ${baseLabel} did not boot`
                        }
                        description="What the machine saw, with the last log lines it kept · secrets and tokens redacted."
                        aside={
                            // The verdict card already links the setup file when the boot is the whole story.
                            !bootFailure.kodusSide &&
                            run.state !== "could_not_boot" && (
                                <NextLink
                                    href={environmentHref(
                                        run.environmentId,
                                        ENVIRONMENT_SECTION.recipe,
                                    )}
                                    className="text-primary-light text-sm hover:underline">
                                    See the setup file
                                </NextLink>
                            )
                        }>
                        <BootFailurePanel failure={bootFailure} />
                    </RuntimeSection>
                )}

                <RuntimeSection
                    title="Findings"
                    description="What behaves differently on this PR, with the proof.">
                    <RunFindingsView
                        runId={run.runId}
                        findings={findings}
                        baseLabel={baseLabel}
                        pullRequestUrl={pr?.url}
                        bootFailure={bootFailure}
                        live={live}
                        compared={runPaths.testedCount > 0}
                        newEndpoints={
                            runPaths.paths.filter(
                                (p) => p.outcome === "new_endpoint",
                            ).length
                        }
                        missing={
                            run.state === "regression" && findings.length === 0
                        }
                        feedback={run.feedback}
                        votePendingFor={
                            vote.isPending ? vote.variables?.probeId : undefined
                        }
                        intentPendingFor={
                            intent.isPending
                                ? intent.variables?.probeId
                                : undefined
                        }
                        onMarkIntended={
                            canMarkIntended ? markIntended : undefined
                        }
                        onVote={(probeId, value) =>
                            vote.mutate(
                                { runId: run.runId, probeId, value },
                                {
                                    onError: (error) =>
                                        toast({
                                            variant: "danger",
                                            title: "Couldn't save your feedback",
                                            description: runtimeErrorMessage(
                                                error,
                                                {
                                                    fallback:
                                                        "Try again in a moment.",
                                                },
                                            ),
                                        }),
                                },
                            )
                        }
                    />
                </RuntimeSection>

                <RuntimeSection
                    title="What Kody tested"
                    description={
                        runPaths.totalCount === 0
                            ? `The same request sent to ${baseLabel} and to this PR`
                            : `${runPaths.testedCount} of ${runPaths.totalCount} ${runPaths.totalCount === 1 ? "path" : "paths"} of this PR · the same request sent to ${baseLabel} and to this PR`
                    }>
                    <div className="flex flex-col gap-4">
                        <RunCoverageList
                            runId={run.runId}
                            rows={coverage}
                            live={live}
                        />
                        <ExercisedFilesList
                            files={run.exercised?.files ?? []}
                        />
                    </div>
                </RuntimeSection>

                <RuntimeDisclosure
                    id="run-timing"
                    title={
                        elapsed === undefined
                            ? "Where the time went"
                            : live
                              ? `Time so far: ${elapsed}`
                              : `Why it took ${elapsed}`
                    }
                    summary={
                        timingLine ? (
                            <RichTextView text={timingLine} />
                        ) : (
                            "The phases appear once a machine takes the Run."
                        )
                    }
                    defaultOpen={live}>
                    <RunTimingView timing={timing} />
                </RuntimeDisclosure>

                <RuntimeDisclosure
                    id="what-was-running"
                    title="What was running"
                    summary={whatWasRunningLine(
                        run,
                        baseLabel,
                        workspaceRows.length,
                    )}>
                    <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                        <Fact label="Commits">
                            this PR{" "}
                            <code className="font-mono">
                                {shortSha(run.headSha)}
                            </code>{" "}
                            · {baseLabel}{" "}
                            <code className="font-mono">
                                {shortSha(run.baseSha)}
                            </code>
                        </Fact>
                        <Fact label="Environment">
                            <NextLink
                                href={environmentHref(run.environmentId)}
                                className="text-primary-light underline-offset-2 hover:underline">
                                Open the environment
                            </NextLink>
                        </Fact>
                        <Fact label="Setup file">
                            <NextLink
                                href={environmentHref(
                                    run.environmentId,
                                    ENVIRONMENT_SECTION.recipe,
                                )}
                                className="text-primary-light underline-offset-2 hover:underline">
                                {run.recipe?.state === "absent"
                                    ? "No setup file"
                                    : run.recipe?.sha
                                      ? `Read from ${baseLabel} at ${shortSha(run.recipe.sha)}`
                                      : "Open the setup file"}
                            </NextLink>
                        </Fact>
                        <Fact label="Machine">
                            {cellOwnerLabel(run.cellOwner)}
                        </Fact>
                    </dl>
                    {!summary.saysSetupFileChange && (
                        <RecipeChangedNotice run={run} />
                    )}
                    <RunWorkspaceSection
                        embedded
                        rows={workspaceRows}
                        pullRequestBranch={pullRequestBranchOf(run.workspace)}
                    />
                    <RunPreviewCard run={run} embedded />
                </RuntimeDisclosure>

                <RuntimeDisclosure
                    id="run-log"
                    title="Run log"
                    summary="Everything the machines ran, in order · secrets and tokens redacted."
                    defaultOpen={live}>
                    <RunLogView runId={run.runId} groups={log} note={logNote} />
                </RuntimeDisclosure>

                {run.cost && (
                    <RuntimeDisclosure
                        id="run-cost"
                        title="Cost"
                        summary={`${formatEstimatedUsd(run.cost.totalUsd)} · machine time and LLM tokens at list prices`}>
                        <RunCostBreakdown cost={run.cost} />
                    </RuntimeDisclosure>
                )}
            </Page.Content>
        </Page.Root>
    );
};
