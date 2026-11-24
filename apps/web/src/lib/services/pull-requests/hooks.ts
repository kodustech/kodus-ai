import { useCallback, useEffect, useMemo, useRef } from "react";
import { fetchEventSource } from "@microsoft/fetch-event-source";
import {
    useInfiniteQuery,
    useQuery,
    useQueryClient,
    type InfiniteData,
} from "@tanstack/react-query";
import { axiosAuthorized } from "src/core/utils/axios";

import {
    PULL_REQUEST_API,
    PULL_REQUEST_SSE,
    type PullRequestFilters,
} from "./fetch";
import {
    createExecutionRefreshers,
    executionsTotalsQueryOptions,
    PULL_REQUEST_QUERY_ROOT,
} from "./query-options";
import type {
    AwaitingPullRequestsResponse,
    PullRequestAuthorsResponse,
    PullRequestExecution,
    PullRequestExecutionsPayload,
    PullRequestExecutionsResponse,
    PullRequestFilesResponse,
    PullRequestsDailyDigestField,
    PullRequestsDailyDigestResponse,
    PullRequestsFacetName,
    PullRequestsFacetsResponse,
    PullRequestSuggestionsResponse,
} from "./types";

const normalizeExecutions = (
    payload: PullRequestExecutionsPayload,
): PullRequestExecution[] => {
    if (!payload) return [];

    if (Array.isArray(payload)) return payload;

    if (Array.isArray(payload.data)) return payload.data;

    if (Array.isArray(payload._page_data)) return payload._page_data;

    return [];
};

// Distinct-PR total carried on the list's first page. Only an API that
// predates GET /pull-requests/executions/totals still sends it (the list
// stopped counting), so this is the fallback for that case; undefined
// otherwise.
const pickDistinctPrTotal = (
    payload: PullRequestExecutionsPayload,
): number | undefined => {
    if (!payload || Array.isArray(payload)) return undefined;
    return payload.pagination?.distinctPrTotal ?? undefined;
};

const DEFAULT_PAGE_SIZE = 30;

/** Order-independent query-key part for a `fields` list. */
const fieldsQueryKey = (fields?: readonly string[]) =>
    fields?.length ? [...fields].sort().join(",") : "all";

export const useInfinitePullRequestExecutions = (
    filters?: PullRequestFilters,
    options?: {
        pageSize?: number;
        poll?: boolean;
        // Ask the backend for the distinct-PR total of these filters. Off by
        // default: counting walks every matching execution, so only a view
        // that is about to show the number should pay for it.
        withTotal?: boolean;
    },
) => {
    const pageSize = options?.pageSize ?? filters?.limit ?? DEFAULT_PAGE_SIZE;
    // Poll the first page as a fallback refresh. Callers that already mount
    // `usePullRequestExecutionSSE` (which invalidates this query on every
    // `execution_updated` event) should pass `poll: false` to avoid the
    // redundant 30s refetch. Defaults to true so views without SSE (e.g. the
    // PR detail page) keep auto-refreshing.
    const poll = options?.poll ?? true;
    const baseFilters = useMemo<PullRequestFilters>(() => {
        const next: PullRequestFilters = { limit: pageSize };

        if (filters?.teamId) next.teamId = filters.teamId;
        if (filters?.repositoryId) next.repositoryId = filters.repositoryId;
        if (filters?.repositoryName)
            next.repositoryName = filters.repositoryName;

        const title = filters?.pullRequestTitle?.trim();
        if (title) {
            next.pullRequestTitle = title;
        }

        const number = filters?.pullRequestNumber?.trim();
        if (number) {
            next.pullRequestNumber = number;
        }

        if (typeof filters?.hasSentSuggestions === "boolean") {
            next.hasSentSuggestions = filters.hasSentSuggestions;
        }

        if (filters?.authorPolicy) {
            next.authorPolicy = filters.authorPolicy;
        }

        if (filters?.status) {
            next.status = filters.status;
        }

        if (filters?.createdAtFrom) next.createdAtFrom = filters.createdAtFrom;
        if (filters?.createdAtTo) next.createdAtTo = filters.createdAtTo;
        if (filters?.severity) next.severity = filters.severity;
        if (filters?.category) next.category = filters.category;
        if (filters?.needsAttention) next.needsAttention = true;
        if (filters?.author) next.author = filters.author;
        if (filters?.prState) next.prState = filters.prState;

        return next;
    }, [
        filters?.teamId,
        filters?.repositoryId,
        filters?.repositoryName,
        filters?.pullRequestTitle,
        filters?.pullRequestNumber,
        filters?.hasSentSuggestions,
        filters?.authorPolicy,
        filters?.status,
        filters?.createdAtFrom,
        filters?.createdAtTo,
        filters?.severity,
        filters?.category,
        filters?.needsAttention,
        filters?.author,
        filters?.prState,
        pageSize,
    ]);

    // Paged by cursor, not by page number. The backend fills a page by
    // discarding executions that fail a post-query filter, so it reads more
    // rows than it returns; `page * limit` restarted inside the window the
    // previous page had already served, and every fetch came back mostly
    // repeats. The Map below hid that (repeats overwrite), leaving a scroll
    // that loaded a full page and grew by a handful of rows — and, when the
    // filters were aggressive enough, never terminated. `nextCursor` is the
    // position the last page stopped READING at.
    const { data: infiniteData, ...query } = useInfiniteQuery<
        PullRequestExecutionsResponse,
        Error,
        InfiniteData<PullRequestExecutionsResponse, string | undefined>,
        [string, PullRequestFilters],
        string | undefined
    >({
        queryKey: [PULL_REQUEST_QUERY_ROOT.list, baseFilters],
        initialPageParam: undefined,
        queryFn: async ({ pageParam }) => {
            const params = pageParam
                ? { ...baseFilters, cursor: pageParam }
                : baseFilters;
            const url = PULL_REQUEST_API.GET_EXECUTIONS(params);

            return axiosAuthorized.fetcher<PullRequestExecutionsResponse>(url);
        },
        getNextPageParam: (lastPage) => {
            const payload = lastPage?.data;
            if (!payload || Array.isArray(payload)) {
                return undefined;
            }

            // Absent once the scan is exhausted, which is also the only thing
            // that ends the list — page length no longer decides, because a
            // page can be short while more rows remain behind the filters.
            return payload.pagination?.nextCursor ?? undefined;
        },
        retry: false,
        // Fallback refresh for views without SSE. React Query skips the ticks
        // of a hidden tab (a hidden tab used to poll all day) and, with
        // "always", refreshes as soon as the tab is looked at again. It
        // refreshes every loaded page; the only poller left is the PR detail
        // view, which loads one.
        refetchInterval: poll ? 30_000 : false,
        refetchOnWindowFocus: poll ? "always" : false,
    });

    const items = useMemo(() => {
        const pages = infiniteData?.pages ?? [];
        const map = new Map<string, PullRequestExecution>();

        let fallbackKeyIndex = 0;
        pages.forEach((page) => {
            normalizeExecutions(page?.data).forEach((pr) => {
                const timestamp =
                    pr.automationExecution?.createdAt ??
                    pr.updatedAt ??
                    pr.createdAt;
                const executionKey =
                    pr.executionId ||
                    pr.automationExecution?.uuid ||
                    (timestamp
                        ? `${pr.prId}-${timestamp}`
                        : `${pr.prId}-fallback-${fallbackKeyIndex++}`);

                if (pr?.prId) {
                    map.set(executionKey, pr);
                }
            });
        });

        return Array.from(map.values());
    }, [infiniteData]);

    // Accurate distinct-PR total for the active filters. Its own request, so
    // the rows above never wait for the count. Undefined until it answers, when
    // it was not asked for, or when the backend couldn't compute it — callers
    // fall back to the loaded count.
    const withTotal = options?.withTotal ?? false;
    const { data: totals } = useQuery({
        ...executionsTotalsQueryOptions(baseFilters, withTotal),
        select: (response) => response.data,
    });
    const filteredPrTotal = useMemo(() => {
        if (!withTotal) return undefined;
        if (typeof totals?.distinctPrTotal === "number") {
            return totals.distinctPrTotal;
        }
        return pickDistinctPrTotal(infiniteData?.pages?.[0]?.data);
    }, [withTotal, totals, infiniteData]);

    return { ...query, data: infiniteData, items, filteredPrTotal };
};

export const usePullRequestsDailyDigest = (
    teamId?: string,
    // The counts this view renders — see usePullRequestsFacets. Omit for all.
    fields?: readonly PullRequestsDailyDigestField[],
) => {
    const fieldsKey = fieldsQueryKey(fields);
    return useQuery({
        queryKey: [PULL_REQUEST_QUERY_ROOT.digest, teamId, fieldsKey],
        queryFn: () =>
            axiosAuthorized.fetcher<PullRequestsDailyDigestResponse>(
                PULL_REQUEST_API.GET_DAILY_DIGEST(teamId, fields),
            ),
        enabled: !!teamId,
        retry: false,
        staleTime: 60_000,
        select: (response) => response.data,
    });
};

export const usePullRequestsFacets = (
    teamId?: string,
    scope?: "mine" | "team",
    // The counters this view renders. The backend runs one query per counter
    // (two of them over the team's whole review history), so naming them keeps
    // a view that shows two numbers from paying for five. Omit for all.
    fields?: readonly PullRequestsFacetName[],
) => {
    const fieldsKey = fieldsQueryKey(fields);
    return useQuery({
        queryKey: [
            PULL_REQUEST_QUERY_ROOT.facets,
            teamId,
            scope ?? "team",
            fieldsKey,
        ],
        queryFn: () =>
            axiosAuthorized.fetcher<PullRequestsFacetsResponse>(
                PULL_REQUEST_API.GET_FACETS(teamId, scope, fields),
            ),
        enabled: !!teamId,
        retry: false,
        // No polling here on purpose: the facets (Needs attention / Awaiting
        // cards) are refreshed reactively via usePullRequestExecutionSSE. The
        // verification pass emits `execution_updated` right after it persists
        // suggestion statuses, so invalidating on that event refetches the
        // cards at the exact moment the counts change — no periodic load.
        staleTime: 60_000,
        select: (response) => response.data,
    });
};

export const usePullRequestsAwaiting = (teamId?: string) => {
    return useQuery({
        queryKey: ["pull-requests-awaiting", teamId],
        queryFn: () =>
            axiosAuthorized.fetcher<AwaitingPullRequestsResponse>(
                PULL_REQUEST_API.GET_AWAITING(teamId),
            ),
        enabled: !!teamId,
        retry: false,
        staleTime: 60_000,
        select: (response) => response.data,
    });
};

// Author-search autocomplete options. Loads the full (server-cached) author
// list once per team and lets the caller filter client-side — so typing does
// NOT hit the backend per keystroke (the distinct-authors aggregation is
// expensive). staleTime keeps it cached across opens.
export const usePullRequestAuthors = (teamId?: string, enabled = true) => {
    return useQuery({
        queryKey: ["pull-requests-authors", teamId],
        queryFn: () =>
            axiosAuthorized.fetcher<PullRequestAuthorsResponse>(
                PULL_REQUEST_API.GET_AUTHORS(teamId, undefined, 500),
            ),
        enabled: !!teamId && enabled,
        retry: false,
        staleTime: 5 * 60_000,
        select: (response) => response.data,
    });
};

// Key + fetcher shared by the hook and the hover-prefetch below, so the
// prefetched entry lands under the EXACT key the screen's useQuery reads —
// any drift and the prefetch silently misses and the screen refetches anyway.
const suggestionsQuery = (
    repositoryId: string | undefined,
    prNumber: number | undefined,
    filters?: { severity?: string; category?: string },
) => ({
    queryKey: ["pull-request-suggestions", repositoryId, prNumber, filters],
    queryFn: () =>
        axiosAuthorized.fetcher<PullRequestSuggestionsResponse>(
            PULL_REQUEST_API.GET_SUGGESTIONS({
                repositoryId: repositoryId!,
                prNumber: prNumber!,
                ...filters,
            }),
        ),
});

export const usePullRequestSuggestions = (
    repositoryId: string | undefined,
    prNumber: number | undefined,
    filters?: { severity?: string; category?: string },
) => {
    return useQuery({
        ...suggestionsQuery(repositoryId, prNumber, filters),
        enabled: !!repositoryId && !!prNumber,
        retry: false,
    });
};

/**
 * Warms the react-query cache for a PR's suggestions on hover/focus of a link
 * into its review screen. `next/link` already prefetches the ROUTE; this
 * prefetches the DATA the screen blocks on (page.client gates the whole view
 * on suggestionsLoading), so an intentful hover turns the open from
 * spinner→content into content-immediately. The 30s staleTime dedupes repeated
 * hovers; the screen still background-revalidates on mount, so freshness is
 * unchanged — this only buys a head start.
 */
export const usePrefetchPullRequestReview = () => {
    const queryClient = useQueryClient();
    return useCallback(
        (repositoryId: string, prNumber: number) => {
            // prefetchQuery swallows its own errors; fire-and-forget matches
            // the codebase's other prefetch call sites (navbar).
            queryClient.prefetchQuery({
                ...suggestionsQuery(repositoryId, prNumber),
                staleTime: 30_000,
            });
        },
        [queryClient],
    );
};

export const usePullRequestFiles = (
    repositoryId: string | undefined,
    prNumber: number | undefined,
    teamId: string | undefined,
    repositoryName?: string,
) => {
    return useQuery({
        queryKey: [
            "pull-request-files",
            repositoryId,
            prNumber,
            teamId,
            repositoryName,
        ],
        queryFn: () =>
            axiosAuthorized.fetcher<PullRequestFilesResponse>(
                PULL_REQUEST_API.GET_FILES({
                    repositoryId: repositoryId!,
                    prNumber: prNumber!,
                    teamId: teamId!,
                    repositoryName,
                }),
            ),
        enabled: !!repositoryId && !!prNumber && !!teamId,
        retry: 1,
        staleTime: 5 * 60 * 1000,
    });
};

export const usePullRequestExecutionSSE = (enabled = true) => {
    const queryClient = useQueryClient();
    const controllerRef = useRef<AbortController | null>(null);

    const refreshers = useMemo(
        () => createExecutionRefreshers(queryClient),
        [queryClient],
    );

    const invalidate = useCallback(() => {
        refreshers.list();
        refreshers.counters();
    }, [refreshers]);

    // A refresh still waiting for its interval has nothing left to refresh
    // once the screen is gone.
    useEffect(
        () => () => {
            refreshers.list.cancel();
            refreshers.counters.cancel();
        },
        [refreshers],
    );

    useEffect(() => {
        if (!enabled) return;

        let cancelled = false;

        const connect = async () => {
            controllerRef.current?.abort();
            const controller = new AbortController();
            controllerRef.current = controller;

            if (cancelled) return;

            await fetchEventSource(PULL_REQUEST_SSE.EXECUTION_EVENTS, {
                // The /api/proxy route injects the Bearer from the httpOnly
                // session cookie server-side (and ignores any client-sent
                // Authorization), so the browser only needs to send the cookie
                // — no need to fetch /api/auth/session for a token here.
                signal: controller.signal,
                openWhenHidden: false,

                onmessage(event) {
                    if (!event.data) return;

                    try {
                        const parsed = JSON.parse(event.data);
                        if (parsed?.type === "execution_updated") {
                            invalidate();
                        }
                    } catch {
                        // ignore parse errors
                    }
                },

                onerror() {
                    // fetchEventSource will auto-retry; return nothing to keep default behavior
                },
            });
        };

        connect().catch(() => {
            // Silently handle fatal SSE connection errors (e.g., 401, 500)
        });

        return () => {
            cancelled = true;
            controllerRef.current?.abort();
        };
    }, [enabled, invalidate]);
};
