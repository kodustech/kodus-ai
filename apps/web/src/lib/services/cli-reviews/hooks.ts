import { useMemo } from "react";
import {
    useInfiniteQuery,
    useQuery,
    type InfiniteData,
} from "@tanstack/react-query";

import { axiosAuthorized } from "src/core/utils/axios";

import { CLI_REVIEWS_API, type CliReviewFilters } from "./fetch";
import type { CliReviewDetail, PaginatedCliReviews } from "./types";

const DEFAULT_PAGE_SIZE = 30;

/**
 * The API wraps every response in `{ data, statusCode, type }`. The shared
 * `axiosAuthorized.fetcher` does not unwrap it, so we do it here to expose
 * the typed payload directly to the hook consumers.
 */
function unwrap<T>(payload: unknown): T {
    if (payload && typeof payload === "object" && "data" in payload) {
        return (payload as { data: T }).data;
    }
    return payload as T;
}

export const useInfiniteCliReviews = (
    filters?: CliReviewFilters,
    options?: { pageSize?: number },
) => {
    const pageSize = options?.pageSize ?? filters?.pageSize ?? DEFAULT_PAGE_SIZE;

    const baseFilters = useMemo<CliReviewFilters>(() => {
        const next: CliReviewFilters = { pageSize };

        if (filters?.teamId) next.teamId = filters.teamId;
        if (filters?.repositoryId) next.repositoryId = filters.repositoryId;
        if (filters?.userEmail) next.userEmail = filters.userEmail;
        if (filters?.since) next.since = filters.since;

        return next;
    }, [
        filters?.teamId,
        filters?.repositoryId,
        filters?.userEmail,
        filters?.since,
        pageSize,
    ]);

    const { data: infiniteData, ...query } = useInfiniteQuery<
        PaginatedCliReviews,
        Error,
        InfiniteData<PaginatedCliReviews, number>,
        [string, CliReviewFilters],
        number
    >({
        queryKey: ["cli-reviews", baseFilters],
        initialPageParam: 1,
        queryFn: async ({ pageParam = 1 }) => {
            const params = { ...baseFilters, page: pageParam };
            const url = CLI_REVIEWS_API.LIST(params);
            const raw = await axiosAuthorized.fetcher<unknown>(url);
            return unwrap<PaginatedCliReviews>(raw);
        },
        getNextPageParam: (lastPage) => {
            if (!lastPage?.hasMore) return undefined;
            return (lastPage.page ?? 1) + 1;
        },
        refetchInterval: 30_000,
        staleTime: 0,
    });

    const flat = useMemo(
        () => infiniteData?.pages.flatMap((p) => p.data) ?? [],
        [infiniteData],
    );

    const total = infiniteData?.pages[0]?.total ?? 0;

    return {
        ...query,
        data: flat,
        total,
        infiniteData,
    };
};

export const useCliReviewDetail = (executionUuid?: string) =>
    useQuery<CliReviewDetail, Error>({
        queryKey: ["cli-review-detail", executionUuid],
        enabled: !!executionUuid,
        queryFn: async () => {
            const url = CLI_REVIEWS_API.DETAIL(executionUuid!);
            const raw = await axiosAuthorized.fetcher<unknown>(url);
            return unwrap<CliReviewDetail>(raw);
        },
        refetchInterval: (q) => {
            const data = q.state.data;
            if (!data) return 5_000;
            const terminal =
                data.status === "success" ||
                data.status === "error" ||
                data.status === "skipped" ||
                data.status === "partial_error";
            return terminal ? false : 5_000;
        },
        staleTime: 0,
    });
