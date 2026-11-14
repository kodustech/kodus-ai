import type { QueryClient } from "@tanstack/react-query";
import { axiosAuthorized } from "src/core/utils/axios";

import { PULL_REQUEST_API, type PullRequestFilters } from "./fetch";
import { throttle, type Throttled } from "./throttle";
import type { PullRequestExecutionsTotalsResponse } from "./types";

// Each root is its own prefix on purpose. `invalidateQueries` matches by
// prefix, so the totals living under the list's root would be refetched every
// time the list is.
export const PULL_REQUEST_QUERY_ROOT = {
    list: "pull-request-executions",
    totals: "pull-request-executions-totals",
    digest: "pull-requests-daily-digest",
    facets: "pull-requests-facets",
} as const;

/**
 * The distinct-PR total of a set of filters, as its own request so the rows
 * never wait for the count. Disabled unless the view is about to show it:
 * counting walks every matching execution.
 */
export const executionsTotalsQueryOptions = (
    filters: PullRequestFilters,
    withTotal: boolean,
) => ({
    queryKey: [PULL_REQUEST_QUERY_ROOT.totals, filters] as const,
    queryFn: () =>
        axiosAuthorized.fetcher<PullRequestExecutionsTotalsResponse>(
            PULL_REQUEST_API.GET_EXECUTIONS_TOTALS(filters),
        ),
    enabled: withTotal && !!filters.teamId,
    retry: false as const,
    staleTime: 60_000,
});

// How often a stream of `execution_updated` events may refresh each part of
// the screen. A review emits one event per stage and a busy team runs many at
// once, so refreshing on every event re-ran the list and every counter several
// times a second. The rows are cheap and are what the reader watches change;
// the counters scan far more and move far less.
export const LIST_REFRESH_INTERVAL_MS = 5_000;
export const COUNTERS_REFRESH_INTERVAL_MS = 60_000;

export type ExecutionRefreshers = {
    list: Throttled;
    counters: Throttled;
};

export const createExecutionRefreshers = (
    queryClient: QueryClient,
): ExecutionRefreshers => ({
    list: throttle(() => {
        queryClient.invalidateQueries({
            queryKey: [PULL_REQUEST_QUERY_ROOT.list],
        });
    }, LIST_REFRESH_INTERVAL_MS),
    // Totals, digest and facets are the numbers on the screen. The suggestion
    // verification pass emits `execution_updated` after persisting statuses
    // (see ImplementationVerificationProcessor), so the first event still
    // refreshes them right away; a burst then costs one more refresh at the
    // end of the interval, not one per event.
    counters: throttle(() => {
        for (const root of [
            PULL_REQUEST_QUERY_ROOT.totals,
            PULL_REQUEST_QUERY_ROOT.digest,
            PULL_REQUEST_QUERY_ROOT.facets,
        ]) {
            queryClient.invalidateQueries({ queryKey: [root] });
        }
    }, COUNTERS_REFRESH_INTERVAL_MS),
});
