import { useCallback, useEffect, useMemo, useRef } from "react";
import { fetchEventSource } from "@microsoft/fetch-event-source";
import {
    useInfiniteQuery,
    useQuery,
    useQueryClient,
    type InfiniteData,
} from "@tanstack/react-query";
import { axiosAuthorized } from "src/core/utils/axios";
import { getJWTToken } from "src/core/utils/session";

import {
    PULL_REQUEST_API,
    PULL_REQUEST_SSE,
    type PullRequestFilters,
} from "./fetch";
import type {
    PullRequestExecution,
    PullRequestExecutionsPayload,
    PullRequestExecutionsResponse,
    PullRequestFilesResponse,
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

const DEFAULT_PAGE_SIZE = 30;

export const useInfinitePullRequestExecutions = (
    filters?: PullRequestFilters,
    options?: { pageSize?: number },
) => {
    const pageSize = options?.pageSize ?? filters?.limit ?? DEFAULT_PAGE_SIZE;
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

        return next;
    }, [
        filters?.teamId,
        filters?.repositoryId,
        filters?.repositoryName,
        filters?.pullRequestTitle,
        filters?.pullRequestNumber,
        filters?.hasSentSuggestions,
        filters?.authorPolicy,
        pageSize,
    ]);

    const { data: infiniteData, ...query } = useInfiniteQuery<
        PullRequestExecutionsResponse,
        Error,
        InfiniteData<PullRequestExecutionsResponse, number>,
        [string, PullRequestFilters],
        number
    >({
        queryKey: ["pull-request-executions", baseFilters],
        initialPageParam: 1,
        queryFn: async ({ pageParam = 1 }) => {
            const params = { ...baseFilters, page: pageParam };
            const url = PULL_REQUEST_API.GET_EXECUTIONS(params);

            return axiosAuthorized.fetcher<PullRequestExecutionsResponse>(url);
        },
        getNextPageParam: (lastPage, allPages) => {
            const lastPageSize = normalizeExecutions(lastPage?.data).length;

            if (lastPageSize < pageSize) {
                return undefined;
            }

            return allPages.length + 1;
        },
        retry: false,
    });

    // Poll only the first page every 30s (avoids refetching all loaded pages)
    const { refetch } = query;
    useEffect(() => {
        const id = setInterval(() => {
            refetch({ refetchPage: (_page, index) => index === 0 });
        }, 30_000);
        return () => clearInterval(id);
    }, [refetch]);

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

    return { ...query, data: infiniteData, items };
};

export const usePullRequestSuggestions = (
    repositoryId: string | undefined,
    prNumber: number | undefined,
    filters?: { severity?: string; category?: string },
) => {
    return useQuery({
        queryKey: ["pull-request-suggestions", repositoryId, prNumber, filters],
        queryFn: () =>
            axiosAuthorized.fetcher<PullRequestSuggestionsResponse>(
                PULL_REQUEST_API.GET_SUGGESTIONS({
                    repositoryId: repositoryId!,
                    prNumber: prNumber!,
                    ...filters,
                }),
            ),
        enabled: !!repositoryId && !!prNumber,
        retry: false,
    });
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

    const invalidate = useCallback(() => {
        queryClient.invalidateQueries({
            queryKey: ["pull-request-executions"],
        });
    }, [queryClient]);

    useEffect(() => {
        if (!enabled) return;

        let cancelled = false;

        const connect = async () => {
            controllerRef.current?.abort();
            const controller = new AbortController();
            controllerRef.current = controller;

            const accessToken = await getJWTToken();
            if (!accessToken || cancelled) return;

            await fetchEventSource(PULL_REQUEST_SSE.EXECUTION_EVENTS, {
                headers: { Authorization: `Bearer ${accessToken}` },
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
