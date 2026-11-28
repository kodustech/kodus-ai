"use client";

import { useEffect, useRef, useState } from "react";
import {
    keepPreviousData,
    useMutation,
    useQuery,
    useQueryClient,
} from "@tanstack/react-query";

import {
    addEnvironmentRepository,
    applyBlockerFix,
    approveEgressHost,
    approveRun,
    createCellRegistrationToken,
    createRuntimeEnvironment,
    getEnvironmentPreview,
    getOrgEgress,
    getPreviewSettings,
    getSandboxCapacity,
    updateSandboxCapacity,
    getRunPreview,
    getRunPreviews,
    getRunReproduction,
    getEnvironmentSuite,
    getRunSuite,
    getRuntimeEnvironment,
    getRuntimeHealth,
    getRuntimeMachineMinutes,
    getRuntimeRun,
    getRuntimeSettings,
    getRuntimeSpeed,
    getRuntimeUsageReport,
    grantRunPreview,
    listCellRegistrationTokens,
    listEnvironmentBlockers,
    listEnvironmentLessons,
    listPreviewActivity,
    listRuntimeCells,
    listRuntimeEnvironments,
    listRuntimeEnvironmentStatuses,
    listRuntimeRuns,
    openEnvironmentPreview,
    openRunPreview,
    proposeInferredRecipe,
    readRunStreamPage,
    removeEnvironmentRepository,
    requestEnvironmentSetup,
    rerunRun,
    resumeRuntime,
    resumeSuiteSelection,
    retryRunSuite,
    revokeCellRegistrationToken,
    revokeEgressHost,
    revokeRuntimeCell,
    setFindingFeedback,
    setFindingIntent,
    simulateRun,
    stopRunPreview,
    stopRuntime,
    updateEnvironmentLesson,
    updateEnvironmentRepository,
    updateEnvironmentSettings,
    updateOrgEgressSettings,
    updatePreviewSettings,
    updateRuntimeMachineMinutes,
    updateRuntimeOrgSettings,
    updateRuntimeRepositorySettings,
    type RuntimeUsageQuery,
} from "./api";
import type {
    EnvironmentRepositoriesResult,
    PreviewSide,
    RunState,
    RuntimeEnvironment,
    RuntimeLesson,
    RuntimeRun,
    SpeedWindowDays,
} from "./contracts";
import { isTerminalRunState } from "./labels";
import { withRepositoriesAnswer } from "./model/environment-repositories";
import { withIntentResult } from "./model/findings";
import { PREVIEW_POLL_MS, previewStep } from "./model/preview";
import { isEnvironmentBusy } from "./model/environment";
import {
    changedEnvironmentIds,
    environmentsRefetchInterval,
    isRunBeingRecorded,
    previewCardRefetchInterval,
    runRefetchInterval,
    runsListRefetchInterval,
    startedRunIdsOf,
} from "./polling";
import {
    EMPTY_RUN_STREAM_VIEW,
    followRunStream,
    reduceRunStream,
    type RunStreamView,
} from "./stream";

export const runtimeKeys = {
    all: ["runtime"] as const,
    orgEgress: () => ["runtime", "egress"] as const,
    runsAll: () => ["runtime", "runs"] as const,
    runs: (filter: {
        repositoryId?: string;
        prNumber?: number;
        limit?: number;
    }) =>
        [
            "runtime",
            "runs",
            {
                repositoryId: filter.repositoryId ?? null,
                prNumber: filter.prNumber ?? null,
                limit: filter.limit ?? null,
            },
        ] as const,
    run: (runId: string) => ["runtime", "run", runId] as const,
    /** The Run's e2e suite: under the Run, so a change to the Run reads it again. */
    runSuite: (runId: string) => ["runtime", "run", runId, "suite"] as const,
    /** Whether this browser follows the Run's stream live (set by useRunStream, read by useRuntimeRun). */
    runStreamLive: (runId: string) =>
        ["runtime", "run-stream-live", runId] as const,
    /** When this browser started the Run (ms), until the worker records it. */
    startedRun: (runId: string) => ["runtime", "started-run", runId] as const,
    reproduction: (runId: string, probeId: string) =>
        ["runtime", "run", runId, "reproduction-data-v1", probeId] as const,
    environments: () => ["runtime", "environments"] as const,
    /** Not under environments(): reading the list again must not read the status again. */
    environmentStatuses: () => ["runtime", "environment-statuses"] as const,
    environment: (environmentId: string) =>
        ["runtime", "environment", environmentId] as const,
    /** Settings, e2e suite: under the environment, so saving its settings reads it again. */
    environmentSuite: (environmentId: string) =>
        ["runtime", "environment", environmentId, "suite"] as const,
    blockers: (environmentId: string) =>
        ["runtime", "environment", environmentId, "blockers"] as const,
    cells: () => ["runtime", "cells"] as const,
    cellTokens: () => ["runtime", "cells", "registration-tokens"] as const,
    settings: () => ["runtime", "settings"] as const,
    machineMinutes: () => ["runtime", "settings", "machine-minutes"] as const,
    health: () => ["runtime", "settings", "health"] as const,
    speed: (windowDays: number) =>
        ["runtime", "settings", "health", "speed", windowDays] as const,
    usage: (q: RuntimeUsageQuery) =>
        [
            "runtime",
            "settings",
            "usage",
            q.month,
            q.repositoryId ?? "",
            q.environmentId ?? "",
        ] as const,
};

export const RUNS_PAGE_SIZE = 50;
/** How often a Run's suite is read while it runs. */
const SUITE_POLL_MS = 5_000;

export const useRuntimeRuns = (filter: {
    repositoryId: string | undefined;
    prNumber?: number;
    limit?: number;
}) =>
    useQuery({
        queryKey: runtimeKeys.runs(filter),
        queryFn: () =>
            listRuntimeRuns({
                repositoryId: filter.repositoryId,
                prNumber: filter.prNumber,
                limit: filter.limit,
            }),
        enabled: !!filter.repositoryId,
        // "Show more" raises the limit: keep the rows on screen meanwhile.
        placeholderData: keepPreviousData,
        refetchInterval: (query) =>
            runsListRefetchInterval(query.state.data, {
                failures: query.state.fetchFailureCount,
            }),
        retry: false,
    });

/** Versioned reproduction data of one finding, fetched when the dialog opens. */
export const useRunReproduction = (
    runId: string,
    probeId: string,
    enabled: boolean,
) =>
    useQuery({
        queryKey: runtimeKeys.reproduction(runId, probeId),
        queryFn: () => getRunReproduction(runId, probeId),
        enabled,
        retry: false,
        staleTime: Infinity,
    });

/**
 * Remembers the Runs a start answered: the API knows them only once the
 * worker recorded them, so their page waits instead of saying "not found".
 */
export const markRunsStarted = (
    queryClient: ReturnType<typeof useQueryClient>,
    answer: Parameters<typeof startedRunIdsOf>[0],
    at = Date.now(),
) => {
    for (const runId of startedRunIdsOf(answer))
        queryClient.setQueryData(runtimeKeys.startedRun(runId), at);
};

const startedAtOf = (
    queryClient: ReturnType<typeof useQueryClient>,
    runId: string | undefined,
) =>
    runId
        ? queryClient.getQueryData<number>(runtimeKeys.startedRun(runId))
        : undefined;

export const useRuntimeRun = (
    runId: string | undefined,
    /**
     * `poll: false` for a caller that reads only what a Run fixes when it
     * starts (its workspace): read once, never polled on its own (WP6).
     */
    opts: { poll?: boolean } = {},
) => {
    const queryClient = useQueryClient();
    const poll = opts.poll ?? true;
    return useQuery({
        queryKey: runtimeKeys.run(runId ?? ""),
        queryFn: () => getRuntimeRun(runId!),
        enabled: !!runId,
        retry: false,
        // The stream refreshes it on each state event; this keeps a live Run
        // moving when the stream is down, and stops once it is terminal. A
        // Run this browser just started is asked for until it is recorded.
        refetchInterval: (q) =>
            poll &&
            runRefetchInterval(q.state.data, {
                now: Date.now(),
                failures: q.state.fetchFailureCount,
                startedAt: startedAtOf(queryClient, runId),
                answeredAt: q.state.dataUpdatedAt,
                streamLive:
                    !!runId &&
                    queryClient.getQueryData<boolean>(
                        runtimeKeys.runStreamLive(runId),
                    ) === true,
            }),
    });
};

/** A hidden tab (WP8): the stream pauses until it is shown again. */
const tabHidden = () =>
    typeof document !== "undefined" && document.visibilityState === "hidden";

const untilTabVisible = (signal: AbortSignal) =>
    new Promise<void>((resolve) => {
        const done = () => {
            document.removeEventListener("visibilitychange", onChange);
            signal.removeEventListener("abort", done);
            resolve();
        };
        const onChange = () => {
            if (!tabHidden()) done();
        };
        document.addEventListener("visibilitychange", onChange);
        signal.addEventListener("abort", done, { once: true });
    });

/**
 * The API does not know this Run yet (`null`), but this browser started it
 * a moment ago: the worker is still recording it. Reads the query's last
 * answer time, so the page and the polling agree on when the wait ends.
 */
export const useRunBeingRecorded = (
    runId: string | undefined,
    query: { data: unknown; dataUpdatedAt: number },
) => {
    const queryClient = useQueryClient();
    return (
        query.data === null &&
        isRunBeingRecorded(startedAtOf(queryClient, runId), query.dataUpdatedAt)
    );
};

const invalidateRun = (
    queryClient: ReturnType<typeof useQueryClient>,
    runId?: string,
) => {
    queryClient.invalidateQueries({ queryKey: runtimeKeys.runsAll() });
    if (runId)
        queryClient.invalidateQueries({ queryKey: runtimeKeys.run(runId) });
};

export const useRerunRun = () => {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: rerunRun,
        onSuccess: (next, runId) => {
            markRunsStarted(queryClient, next);
            return invalidateRun(queryClient, runId);
        },
    });
};

/**
 * The Run's e2e suite (`null`: the Run has none). It is read again while the Run or its suite runs, so the tab appears when the
 * suite starts and its failures when it ends.
 */
export const useRunSuite = (runId: string, runIsLive: boolean) =>
    useQuery({
        queryKey: runtimeKeys.runSuite(runId),
        queryFn: () => getRunSuite(runId),
        retry: false,
        refetchInterval: (query) => {
            const suite = query.state.data;
            const running = suite
                ? !suite.finishedAt
                : runIsLive;
            return running ? SUITE_POLL_MS : false;
        },
    });

/** "Re-run failed" on a Run's suite. */
export const useRetryRunSuite = () => {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: retryRunSuite,
        onSuccess: (_res, runId) =>
            queryClient.invalidateQueries({
                queryKey: runtimeKeys.runSuite(runId),
            }),
    });
};

/** Opens (or finds) the preview of one side of a Run. */
export const useOpenRunPreview = () =>
    useMutation({
        mutationFn: ({ runId, side }: { runId: string; side: PreviewSide }) =>
            openRunPreview(runId, side),
    });

/**
 * The preview while the page waits on it: read every PREVIEW_POLL_MS until
 * it can be entered (or has ended). Never cached: a grant follows at once.
 */
export const useRunPreview = (previewId: string | undefined) =>
    useQuery({
        queryKey: ["runtime", "preview", previewId],
        queryFn: () => getRunPreview(previewId!),
        enabled: !!previewId,
        gcTime: 0,
        refetchInterval: (query) => {
            const step = previewStep(query.state.data);
            return step.kind === "wait" || step.kind === "blocked"
                ? PREVIEW_POLL_MS
                : false;
        },
    });


/** The Run page's preview card: both sides and whether they can open. */
export const useRunPreviews = (runId: string, enabled = true) =>
    useQuery({
        queryKey: ["runtime", "run-previews", runId],
        queryFn: () => getRunPreviews(runId),
        enabled,
        refetchInterval: (query) =>
            previewCardRefetchInterval(
                Object.values(query.state.data?.sides ?? {}),
            ),
    });

/** The environment page's "Preview main". */
export const useEnvironmentPreview = (environmentId: string, enabled = true) =>
    useQuery({
        queryKey: ["runtime", "environment-preview", environmentId],
        queryFn: () => getEnvironmentPreview(environmentId),
        enabled,
        refetchInterval: (query) =>
            previewCardRefetchInterval([query.state.data?.preview]),
    });

export const useOpenEnvironmentPreview = () =>
    useMutation({
        mutationFn: (environmentId: string) =>
            openEnvironmentPreview(environmentId),
    });

/** Stops a preview (its opener or an owner) and reads the cards again. */
export const useStopRunPreview = () => {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (previewId: string) => stopRunPreview(previewId),
        onSuccess: () => {
            queryClient.invalidateQueries({
                queryKey: ["runtime", "run-previews"],
            });
            queryClient.invalidateQueries({
                queryKey: ["runtime", "environment-preview"],
            });
        },
    });
};

export const usePreviewSettings = (enabled = true) =>
    useQuery({
        queryKey: ["runtime", "preview-settings"],
        queryFn: getPreviewSettings,
        enabled,
    });

export const useUpdatePreviewSettings = () => {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: updatePreviewSettings,
        onSuccess: (view) =>
            queryClient.setQueryData(["runtime", "preview-settings"], view),
    });
};

export const usePreviewActivity = (enabled = true) =>
    useQuery({
        queryKey: ["runtime", "preview-activity"],
        queryFn: () => listPreviewActivity(),
        enabled,
    });

/** A single-use grant: the caller sends the browser to its URL at once. */
export const useGrantRunPreview = () =>
    useMutation({
        mutationFn: (previewId: string) => grantRunPreview(previewId),
    });

export const useApproveRun = () => {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: approveRun,
        onSuccess: (_res, runId) => invalidateRun(queryClient, runId),
    });
};

export const useFindingFeedback = () => {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: setFindingFeedback,
        onSuccess: (feedback, variables) =>
            queryClient.setQueryData<RuntimeRun | null>(
                runtimeKeys.run(variables.runId),
                (run) =>
                    run
                        ? {
                              ...run,
                              feedback: {
                                  ...run.feedback,
                                  [variables.probeId]: feedback,
                              },
                          }
                        : run,
            ),
    });
};

/** "This change is intended" or undo: the page shows the mark; the Run and its check stay as Kody measured. */
export const useFindingIntent = () => {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: setFindingIntent,
        onSuccess: (result, variables) =>
            queryClient.setQueryData<RuntimeRun | null>(
                runtimeKeys.run(variables.runId),
                (run) =>
                    run
                        ? withIntentResult(run, variables.probeId, result)
                        : run,
            ),
    });
};

export const useSimulateRun = () => {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: simulateRun,
        onSuccess: (started) => {
            markRunsStarted(queryClient, started);
            return invalidateRun(queryClient);
        },
    });
};

export type RunStreamStatus =
    | "idle"
    | "live"
    | "reconnecting"
    | "waiting"
    | "paused"
    | "done"
    | "failed";

/**
 * The live view of a Run: long-polls the stream from the last offset, keeps
 * that offset across errors (so a reconnect loses nothing) and refreshes the
 * projection whenever the stream reports a new state. A stream that is
 * refused or never appears ends as `failed`; the projection's own polling
 * (useRuntimeRun) keeps the Run moving then.
 */
export const useRunStream = (
    runId: string | undefined,
    projectionState: RunState | undefined,
) => {
    const queryClient = useQueryClient();
    // Keyed by runId, so moving to another Run starts from an empty view
    // without resetting state inside the effect.
    const [live, setLive] = useState<{
        runId?: string;
        view: RunStreamView;
        status: RunStreamStatus;
    }>({ view: EMPTY_RUN_STREAM_VIEW, status: "idle" });
    const terminalRef = useRef(false);
    useEffect(() => {
        terminalRef.current =
            projectionState !== undefined &&
            isTerminalRunState(projectionState);
    }, [projectionState]);

    useEffect(() => {
        if (!runId) return;
        const controller = new AbortController();
        const forThisRun = (
            update: (current: {
                view: RunStreamView;
                status: RunStreamStatus;
            }) => { view: RunStreamView; status: RunStreamStatus },
        ) =>
            setLive((prev) => ({
                runId,
                ...update(
                    prev.runId === runId
                        ? prev
                        : { view: EMPTY_RUN_STREAM_VIEW, status: "idle" },
                ),
            }));

        followRunStream({
            signal: controller.signal,
            readPage: (offset, signal) =>
                readRunStreamPage(runId, offset, signal),
            isTerminal: () => terminalRef.current,
            isHidden: tabHidden,
            untilVisible: untilTabVisible,
            onStatus: (status) => {
                queryClient.setQueryData(
                    runtimeKeys.runStreamLive(runId),
                    status === "live",
                );
                forThisRun((cur) => ({ ...cur, status }));
            },
            onEvents: (events) => {
                forThisRun((cur) => ({
                    ...cur,
                    view: reduceRunStream(events, cur.view),
                }));
                if (
                    events.some(
                        (e) => e.type === "state" || e.type === "verdict",
                    )
                ) {
                    queryClient.invalidateQueries({
                        queryKey: runtimeKeys.run(runId),
                    });
                }
            },
        }).catch((error: unknown) => {
            // Only a RunStreamFatalError gets here (403, invalid offset, a
            // stream that never appeared): every other failure is retried
            // inside the loop.
            if (controller.signal.aborted) return;
            console.warn("[Kody Runtime] live view stopped", {
                runId,
                statusCode: (error as { statusCode?: number })?.statusCode,
            });
            queryClient.setQueryData(runtimeKeys.runStreamLive(runId), false);
            forThisRun((cur) => ({ ...cur, status: "failed" }));
        });

        return () => {
            controller.abort();
            queryClient.setQueryData(runtimeKeys.runStreamLive(runId), false);
        };
    }, [runId, queryClient]);

    return live.runId === runId
        ? { view: live.view, status: live.status }
        : { view: EMPTY_RUN_STREAM_VIEW, status: "idle" as RunStreamStatus };
};

/**
 * While a setup on screen is requested or running, polls the small status
 * route (GET /runtime/environments/status, a few queries whatever the number
 * of environments) at the setup pace, and reads again only the views it says
 * moved. The views themselves (metrics, Runs, the setup record) are never
 * polled: an org with 50 environments paid about 250 queries per tab every
 * 3 s for them. Stops once nothing on screen is busy.
 */
const useEnvironmentSetupWatch = (
    shown: RuntimeEnvironment[] | null | undefined,
    shownAt: number,
    opts: { complete: boolean; progress?: boolean },
) => {
    const queryClient = useQueryClient();
    const busy = (shown ?? []).some((e) => isEnvironmentBusy(e));
    const statuses = useQuery({
        queryKey: runtimeKeys.environmentStatuses(),
        queryFn: listRuntimeEnvironmentStatuses,
        enabled: busy,
        retry: false,
        refetchInterval: (query) =>
            environmentsRefetchInterval(shown, {
                now: Date.now(),
                failures: query.state.fetchFailureCount,
            }),
    });
    const answeredAt = statuses.dataUpdatedAt;
    useEffect(() => {
        // Only an answer newer than the views can say they are stale.
        if (!busy || !statuses.data || answeredAt <= shownAt) return;
        const changed = changedEnvironmentIds(shown, statuses.data, opts);
        if (!changed.length) return;
        void queryClient.invalidateQueries({
            queryKey: runtimeKeys.environments(),
        });
        for (const id of changed)
            void queryClient.invalidateQueries({
                queryKey: runtimeKeys.environment(id),
            });
        // The answer is what moves; the views it is compared with are read at shownAt.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [answeredAt, shownAt, busy]);
};

export const useRuntimeEnvironments = () => {
    const query = useQuery({
        queryKey: runtimeKeys.environments(),
        queryFn: listRuntimeEnvironments,
        retry: false,
    });
    // The list shows no live progress: only a state or a setup that moved reads it again.
    useEnvironmentSetupWatch(query.data, query.dataUpdatedAt, {
        complete: true,
        progress: false,
    });
    return query;
};

export const useRuntimeEnvironment = (environmentId: string | undefined) => {
    const query = useQuery({
        queryKey: runtimeKeys.environment(environmentId ?? ""),
        queryFn: () => getRuntimeEnvironment(environmentId!),
        enabled: !!environmentId,
        retry: false,
    });
    // A setup in progress moves on its own (the worker records each step).
    useEnvironmentSetupWatch(
        query.data ? [query.data] : [],
        query.dataUpdatedAt,
        { complete: false },
    );
    return query;
};

/** Settings, e2e suite of one environment. */
export const useEnvironmentSuite = (
    environmentId: string | undefined,
    /** Read again this often (ms) while a change the Runtime applies is awaited. */
    refetchMs: number | false = false,
) =>
    useQuery({
        queryKey: runtimeKeys.environmentSuite(environmentId ?? ""),
        queryFn: () => getEnvironmentSuite(environmentId!),
        enabled: !!environmentId,
        retry: false,
        refetchInterval: refetchMs,
    });

/** "Resume selection" after the shadow check paused it; the Runtime applies it, so the state is read again a moment later. */
export const useResumeSuiteSelection = () => {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: resumeSuiteSelection,
        onSuccess: (_res, environmentId) =>
            queryClient.invalidateQueries({
                queryKey: runtimeKeys.environmentSuite(environmentId),
            }),
    });
};

export const useEnvironmentBlockers = (environmentId: string | undefined) =>
    useQuery({
        queryKey: runtimeKeys.blockers(environmentId ?? ""),
        queryFn: () => listEnvironmentBlockers(environmentId!),
        enabled: !!environmentId,
        retry: false,
    });

export const useEnvironmentLessons = (environmentId: string | undefined) =>
    useQuery({
        queryKey: [...runtimeKeys.environment(environmentId ?? ""), "lessons"],
        queryFn: () => listEnvironmentLessons(environmentId!),
        enabled: !!environmentId,
        retry: false,
    });

export const useUpdateEnvironmentLesson = () => {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: updateEnvironmentLesson,
        // The worker applies it from the queue, a moment later: the list shows
        // the change now, and the environment is read again after that.
        onSuccess: (_d, v) => {
            queryClient.setQueryData<RuntimeLesson[]>(
                [...runtimeKeys.environment(v.environmentId), "lessons"],
                (list) =>
                    v.action === "retire"
                        ? list?.filter((l) => l.lessonId !== v.lessonId)
                        : list?.map((l) =>
                              l.lessonId === v.lessonId
                                  ? { ...l, scope: "org" as const }
                                  : l,
                          ),
            );
            setTimeout(
                () =>
                    queryClient.invalidateQueries({
                        queryKey: runtimeKeys.environment(v.environmentId),
                    }),
                5000,
            );
        },
    });
};

export const useApplyBlockerFix = () => {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: applyBlockerFix,
        onSuccess: (_data, variables) =>
            Promise.all([
                queryClient.invalidateQueries({
                    queryKey: runtimeKeys.environment(variables.environmentId),
                }),
                queryClient.invalidateQueries({
                    queryKey: runtimeKeys.blockers(variables.environmentId),
                }),
            ]),
    });
};

/** Opens the inferred recipe PR; the environment reloads after it. */
export const useProposeInferredRecipe = () => {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: proposeInferredRecipe,
        onSuccess: (_data, environmentId) =>
            queryClient.invalidateQueries({
                queryKey: runtimeKeys.environment(environmentId),
            }),
    });
};

export const useApproveEgressHost = () => {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: approveEgressHost,
        onSuccess: (_data, variables) =>
            queryClient.invalidateQueries({
                queryKey:
                    variables.environmentId === "*"
                        ? runtimeKeys.orgEgress()
                        : runtimeKeys.environment(variables.environmentId),
            }),
    });
};

export const useRevokeEgressHost = () => {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: revokeEgressHost,
        onSuccess: (_data, variables) =>
            queryClient.invalidateQueries({
                queryKey:
                    variables.environmentId === "*"
                        ? runtimeKeys.orgEgress()
                        : runtimeKeys.environment(variables.environmentId),
            }),
    });
};

/** The org's outbound access (recommended list, org list, settings, audit). */
export const useOrgEgress = (enabled = true) =>
    useQuery({
        queryKey: runtimeKeys.orgEgress(),
        queryFn: getOrgEgress,
        enabled,
        retry: false,
    });

export const useUpdateOrgEgressSettings = () => {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: updateOrgEgressSettings,
        onSuccess: () =>
            queryClient.invalidateQueries({
                queryKey: runtimeKeys.orgEgress(),
            }),
    });
};

export const useRuntimeCells = (enabled = true) =>
    useQuery({
        queryKey: runtimeKeys.cells(),
        queryFn: listRuntimeCells,
        enabled,
        retry: false,
    });

export const useCreateCellRegistrationToken = () => {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: createCellRegistrationToken,
        // The answer is a one-time token: dropped as soon as the dialog that
        // shows it is gone, not after the cache's default five minutes.
        gcTime: 0,
        onSuccess: () =>
            queryClient.invalidateQueries({
                queryKey: runtimeKeys.cellTokens(),
            }),
    });
};

export const useCellRegistrationTokens = (enabled = true) =>
    useQuery({
        queryKey: runtimeKeys.cellTokens(),
        queryFn: listCellRegistrationTokens,
        enabled,
        retry: false,
        // A pending token turns used when its cell registers.
        refetchInterval: 15_000,
    });

export const useRevokeCellRegistrationToken = () => {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: revokeCellRegistrationToken,
        onSuccess: () =>
            queryClient.invalidateQueries({
                queryKey: runtimeKeys.cellTokens(),
            }),
    });
};

export const useRevokeRuntimeCell = () => {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: revokeRuntimeCell,
        onSuccess: () =>
            queryClient.invalidateQueries({ queryKey: runtimeKeys.cells() }),
    });
};

export const useStopRuntime = () => {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: stopRuntime,
        onSuccess: () =>
            queryClient.invalidateQueries({ queryKey: runtimeKeys.all }),
    });
};

export const useResumeRuntime = () => {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: resumeRuntime,
        onSuccess: () =>
            queryClient.invalidateQueries({ queryKey: runtimeKeys.all }),
    });
};

/** `enabled` false: not asked for (a screen that only needs it for an action the viewer cannot take). */
export const useRuntimeSettings = (enabled = true) =>
    useQuery({
        queryKey: runtimeKeys.settings(),
        queryFn: getRuntimeSettings,
        enabled,
        retry: false,
    });

/** Today's machine minutes of the org; refreshed every minute while machines run. */
export const useRuntimeMachineMinutes = () =>
    useQuery({
        queryKey: runtimeKeys.machineMinutes(),
        queryFn: getRuntimeMachineMinutes,
        retry: false,
        refetchInterval: (query) =>
            (query.state.data?.openRounds ?? 0) > 0 ? 60_000 : false,
    });

/** The owner's usage report of one month; only fetched when `enabled` (the owner). */
/** The owner's Health view; read again every minute while the screen is open (stuck items age). */
export const useRuntimeHealth = (enabled = true) =>
    useQuery({
        queryKey: runtimeKeys.health(),
        queryFn: () => getRuntimeHealth(),
        enabled,
        retry: false,
        refetchInterval: 60_000,
    });

export const useRuntimeSpeed = (windowDays: SpeedWindowDays, enabled = true) =>
    useQuery({
        queryKey: runtimeKeys.speed(windowDays),
        queryFn: () => getRuntimeSpeed(windowDays),
        enabled,
        retry: false,
        staleTime: 5 * 60_000,
    });

export const useRuntimeUsageReport = (q: RuntimeUsageQuery, enabled = true) =>
    useQuery({
        queryKey: runtimeKeys.usage(q),
        queryFn: () => getRuntimeUsageReport(q),
        enabled,
        retry: false,
    });

/** The org's own daily machine minutes; today's view is read again so the screen shows the limit that holds. */
export const useUpdateRuntimeMachineMinutes = () => {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: updateRuntimeMachineMinutes,
        onSuccess: () =>
            queryClient.invalidateQueries({
                queryKey: runtimeKeys.machineMinutes(),
            }),
    });
};

export const useUpdateRuntimeOrgSettings = () => {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: updateRuntimeOrgSettings,
        onSuccess: () =>
            queryClient.invalidateQueries({
                queryKey: runtimeKeys.settings(),
            }),
    });
};

export const useUpdateEnvironmentSettings = () => {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: updateEnvironmentSettings,
        onSuccess: (_res, variables) =>
            queryClient.invalidateQueries({
                queryKey: runtimeKeys.environment(variables.environmentId),
            }),
    });
};

export const useUpdateRuntimeRepositorySettings = () => {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: updateRuntimeRepositorySettings,
        onSuccess: () => {
            queryClient.invalidateQueries({
                queryKey: runtimeKeys.settings(),
            });
            // Leaving `off` creates the environment and asks for its setup.
            queryClient.invalidateQueries({
                queryKey: runtimeKeys.environments(),
            });
        },
    });
};

export const useCreateRuntimeEnvironment = () => {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: createRuntimeEnvironment,
        onSuccess: () =>
            queryClient.invalidateQueries({
                queryKey: runtimeKeys.environments(),
            }),
    });
};

export const useRequestEnvironmentSetup = () => {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: requestEnvironmentSetup,
        onSuccess: (_data, environmentId) => {
            queryClient.invalidateQueries({
                queryKey: runtimeKeys.environments(),
            });
            queryClient.invalidateQueries({
                queryKey: runtimeKeys.environment(environmentId),
            });
        },
    });
};

/**
 * After a change of an environment's repositories: the answer's list goes on
 * the page at once, then the environment (its setup), the list of
 * environments (the chips) and the blockers (a membership card clears) are
 * read again.
 */
const afterRepositoriesChange = (
    queryClient: ReturnType<typeof useQueryClient>,
    environmentId: string,
    result: EnvironmentRepositoriesResult | undefined,
) => {
    if (result?.repositories)
        queryClient.setQueryData<RuntimeEnvironment | null>(
            runtimeKeys.environment(environmentId),
            (env) =>
                env
                    ? {
                          ...env,
                          repositories: withRepositoriesAnswer(
                              env.repositories,
                              result.repositories,
                          ),
                      }
                    : env,
        );
    return Promise.all([
        queryClient.invalidateQueries({
            queryKey: runtimeKeys.environment(environmentId),
        }),
        queryClient.invalidateQueries({
            queryKey: runtimeKeys.environments(),
        }),
    ]);
};

export const useAddEnvironmentRepository = () => {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: addEnvironmentRepository,
        onSuccess: (result, v) =>
            afterRepositoriesChange(queryClient, v.environmentId, result),
    });
};

export const useUpdateEnvironmentRepository = () => {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: updateEnvironmentRepository,
        onSuccess: (result, v) =>
            afterRepositoriesChange(queryClient, v.environmentId, result),
    });
};

export const useRemoveEnvironmentRepository = () => {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: removeEnvironmentRepository,
        onSuccess: (result, v) =>
            afterRepositoriesChange(queryClient, v.environmentId, result),
    });
};

/** Live numbers: refreshed every 10 s while the screen is open. */
export const SANDBOX_CAPACITY_POLL_MS = 10_000;

export const useSandboxCapacity = (enabled = true) =>
    useQuery({
        queryKey: ["runtime", "sandbox-capacity"],
        queryFn: getSandboxCapacity,
        enabled,
        refetchInterval: SANDBOX_CAPACITY_POLL_MS,
    });

export const useUpdateSandboxCapacity = () => {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: updateSandboxCapacity,
        onSuccess: (view) =>
            queryClient.setQueryData(["runtime", "sandbox-capacity"], view),
    });
};
