"use client";

import { useMemo, useRef } from "react";
import { typedFetch } from "@services/fetch";
import {
    keepPreviousData,
    useMutation,
    useQueries,
    useQueryClient,
} from "@tanstack/react-query";
import { pathToApiUrl } from "src/core/utils/helpers";

import {
    prRuntimeKey,
    type PrRuntime,
    type PrRunView,
} from "./model/pull-request-runs";
import { runsListRefetchInterval } from "./polling";
import { markRunsStarted, runtimeKeys } from "./queries";

// The Runtime state of the pull requests screens: one POST per chunk of PRs,
// never one request per PR. Keyed under runtimeKeys.runsAll() so every Run
// action (Run again, approve) refreshes the list too.

export const PULL_REQUEST_RUNS_PATHS = {
    LIST: () => pathToApiUrl("/runtime/pull-request-runs"),
    REQUEST: () => pathToApiUrl("/runtime/pull-request-runs/request"),
} as const;

/** PRs per call: half the API's cap (MAX_PULL_REQUESTS_PER_READ = 100), so a page of rows fits one or two calls. */
export const PULL_REQUESTS_PER_CALL = 50;

export type PullRequestRef = { repositoryId: string; prNumber: number };

const unwrap = <T>(payload: unknown): T =>
    payload &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    "data" in payload
        ? (payload as { data: T }).data
        : (payload as T);

export const listPullRequestRuns = async (
    pullRequests: PullRequestRef[],
): Promise<PrRuntime[]> => {
    const body = unwrap<{ pullRequests?: PrRuntime[] }>(
        await typedFetch<unknown>(PULL_REQUEST_RUNS_PATHS.LIST(), {
            method: "POST",
            body: JSON.stringify({ pullRequests }),
        }),
    );
    return Array.isArray(body?.pullRequests) ? body.pullRequests : [];
};

type QueuedRun = { runId: string; attempt: number; state: "queued" };

/**
 * What "Run on this PR" answers: the first Run queued and, when the
 * repository is in several environments that run its PRs, every one of them.
 */
export type RequestedPullRequestRuns = QueuedRun & {
    runs?: Array<QueuedRun & { environmentId: string }>;
};

/**
 * "Run on this PR": a Run on the PR's current head. Without `environmentId`
 * the API starts one Run per environment that runs the repository's PRs.
 */
export const requestPullRequestRun = async (
    pr: PullRequestRef & { environmentId?: string },
) =>
    unwrap<RequestedPullRequestRuns>(
        await typedFetch<unknown>(PULL_REQUEST_RUNS_PATHS.REQUEST(), {
            method: "POST",
            body: JSON.stringify(pr),
        }),
    );

export const pullRequestRunsKey = (chunk: PullRequestRef[]) =>
    [
        ...runtimeKeys.runsAll(),
        "pull-requests",
        chunk.map((pr) => prRuntimeKey(pr.repositoryId, pr.prNumber)),
    ] as const;

/**
 * Splits the PRs into calls of at most `size`, in the order given, each one
 * sorted so a chunk's key does not depend on how rows moved inside it.
 */
export const chunkPullRequests = (
    pullRequests: PullRequestRef[],
    size = PULL_REQUESTS_PER_CALL,
): PullRequestRef[][] => {
    const seen = new Set<string>();
    const unique = pullRequests.filter((pr) => {
        const key = prRuntimeKey(pr.repositoryId, pr.prNumber);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
    const out: PullRequestRef[][] = [];
    for (let i = 0; i < unique.length; i += size)
        out.push(
            unique
                .slice(i, i + size)
                .sort((a, b) =>
                    prRuntimeKey(a.repositoryId, a.prNumber).localeCompare(
                        prRuntimeKey(b.repositoryId, b.prNumber),
                    ),
                ),
        );
    return out;
};

/**
 * The chunks to ask for: the ones already asked for that still hold a PR on
 * screen, as they were, then the PRs no chunk holds yet, in new chunks. A
 * re-sort, a new PR at the top or the next page never moves a PR to another
 * chunk, so no chunk changes key and nothing already answered is asked
 * again (WP2: paging by 30 and every SSE re-sort re-keyed every chunk).
 * Once that leaves more than MAX_EXTRA_CHUNKS chunks beyond what the shown
 * PRs need (each SSE batch of new PRs is a chunk, each polling while a Run
 * is live), the shown PRs are chunked again: one re-key, then few calls.
 */
const MAX_EXTRA_CHUNKS = 3;
export const extendPullRequestChunks = (
    previous: PullRequestRef[][],
    pullRequests: PullRequestRef[],
    size = PULL_REQUESTS_PER_CALL,
): PullRequestRef[][] => {
    const shown = new Set(
        pullRequests.map((pr) => prRuntimeKey(pr.repositoryId, pr.prNumber)),
    );
    const kept = previous.filter((chunk) =>
        chunk.some((pr) => shown.has(prRuntimeKey(pr.repositoryId, pr.prNumber))),
    );
    const held = new Set(
        kept.flat().map((pr) => prRuntimeKey(pr.repositoryId, pr.prNumber)),
    );
    const fresh = pullRequests.filter(
        (pr) => !held.has(prRuntimeKey(pr.repositoryId, pr.prNumber)),
    );
    const next = [...kept, ...chunkPullRequests(fresh, size)];
    const needed = Math.ceil(shown.size / size);
    return next.length > needed + MAX_EXTRA_CHUNKS
        ? chunkPullRequests(pullRequests, size)
        : next;
};

const liveRunsOf = (list: PrRuntime[] | undefined): PrRunView[] =>
    (list ?? []).flatMap((pr) => (pr.latest ? [pr.latest] : []));

/**
 * The Runtime state of these PRs, by prRuntimeKey. A loaded page keeps its
 * answer while the next one loads; a live Run keeps its chunk refreshing.
 */
export const usePullRequestRuns = (
    pullRequests: PullRequestRef[],
    enabled = true,
) => {
    // The chunks asked for so far: kept across renders so a PR stays in its chunk.
    const asked = useRef<PullRequestRef[][]>([]);
    const chunks = useMemo(() => {
        asked.current = enabled
            ? extendPullRequestChunks(asked.current, pullRequests)
            : [];
        return asked.current;
    }, [pullRequests, enabled]);
    const results = useQueries({
        queries: chunks.map((chunk) => ({
            queryKey: pullRequestRunsKey(chunk),
            queryFn: () => listPullRequestRuns(chunk),
            placeholderData: keepPreviousData,
            staleTime: 30_000,
            retry: false,
            refetchInterval: (query: {
                state: { data?: PrRuntime[]; fetchFailureCount: number };
            }) =>
                runsListRefetchInterval(liveRunsOf(query.state.data), {
                    failures: query.state.fetchFailureCount,
                }),
        })),
    });
    const dataKey = results.map((r) => r.dataUpdatedAt).join(",");
    const byPullRequest = useMemo(() => {
        const map = new Map<string, PrRuntime>();
        for (const r of results)
            for (const pr of r.data ?? [])
                map.set(prRuntimeKey(pr.repositoryId, pr.prNumber), pr);
        return map;
        // `results` is a new array every render; its data only moves with dataUpdatedAt.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [dataKey]);
    // The PRs of a failed call that its last answer (if any) does not cover:
    // their state is unknown, which is not "no environment".
    const errorKey = results
        .map((r) => (r.isError ? r.errorUpdatedAt : 0))
        .join(",");
    const unavailable = useMemo(() => {
        const keys = new Set<string>();
        results.forEach((r, i) => {
            if (!r.isError) return;
            const answered = new Set(
                (r.data ?? []).map((pr) =>
                    prRuntimeKey(pr.repositoryId, pr.prNumber),
                ),
            );
            for (const pr of chunks[i] ?? []) {
                const key = prRuntimeKey(pr.repositoryId, pr.prNumber);
                if (!answered.has(key)) keys.add(key);
            }
        });
        return keys;
        // `results` is a new array every render; errors only move with errorUpdatedAt.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [errorKey, dataKey, chunks]);
    const retry = () => {
        for (const r of results) if (r.isError) void r.refetch();
    };
    return {
        byPullRequest,
        isLoading: results.some((r) => r.isLoading),
        isError: results.some((r) => r.isError),
        unavailable,
        retry,
    };
};

export const useRequestPullRequestRun = () => {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: requestPullRequestRun,
        onSuccess: (answer) => {
            // Its chip opens the Run before the worker records it: the page waits.
            markRunsStarted(queryClient, answer);
            return queryClient.invalidateQueries({
                queryKey: runtimeKeys.runsAll(),
            });
        },
    });
};
