import { QueryClient, QueryObserver } from "@tanstack/react-query";

import {
    COUNTERS_REFRESH_INTERVAL_MS,
    createExecutionRefreshers,
    executionsTotalsQueryOptions,
    LIST_REFRESH_INTERVAL_MS,
    PULL_REQUEST_QUERY_ROOT,
} from "./query-options";

const fetcherMock = jest.fn();
jest.mock("src/core/utils/axios", () => ({
    axiosAuthorized: { fetcher: (...args: unknown[]) => fetcherMock(...args) },
}));
jest.mock("@services/fetch", () => ({ authorizedFetch: jest.fn() }));
jest.mock("src/core/utils/helpers", () => ({
    pathToApiUrl: (path: string) => path,
}));

const filters = { teamId: "team-1", limit: 30, status: "error" as const };

const newClient = () =>
    new QueryClient({ defaultOptions: { queries: { retry: false } } });

/** Mounts the query the way a rendered `useQuery` would. */
const mount = (client: QueryClient, withTotal: boolean) => {
    const observer = new QueryObserver(
        client,
        executionsTotalsQueryOptions(filters, withTotal),
    );
    return observer.subscribe(() => {});
};

describe("executionsTotalsQueryOptions", () => {
    beforeEach(() => {
        fetcherMock.mockReset();
        fetcherMock.mockResolvedValue({ data: { distinctPrTotal: 7 } });
    });

    it("issues no count request for a view that does not show the total", async () => {
        const client = newClient();
        const unsubscribe = mount(client, false);
        await Promise.resolve();

        expect(fetcherMock).not.toHaveBeenCalled();
        unsubscribe();
    });

    it("issues one request to the totals endpoint when the total is shown", async () => {
        const client = newClient();
        const unsubscribe = mount(client, true);
        await Promise.resolve();

        expect(fetcherMock).toHaveBeenCalledTimes(1);
        const [url] = fetcherMock.mock.calls[0] as [string];
        expect(url.split("?")[0]).toBe("/pull-requests/executions/totals");
        unsubscribe();
    });

    it("does not count without a team", async () => {
        const client = newClient();
        const observer = new QueryObserver(
            client,
            executionsTotalsQueryOptions({ limit: 30 }, true),
        );
        const unsubscribe = observer.subscribe(() => {});
        await Promise.resolve();

        expect(fetcherMock).not.toHaveBeenCalled();
        unsubscribe();
    });
});

describe("createExecutionRefreshers", () => {
    const listKey = [PULL_REQUEST_QUERY_ROOT.list, filters];
    const totalsKey = executionsTotalsQueryOptions(filters, true).queryKey;
    const digestKey = [PULL_REQUEST_QUERY_ROOT.digest, "team-1", ""];
    const facetsKey = [PULL_REQUEST_QUERY_ROOT.facets, "team-1", "team", ""];

    const seeded = () => {
        const client = newClient();
        for (const key of [listKey, totalsKey, digestKey, facetsKey]) {
            client.setQueryData(key, { data: {} });
        }
        return client;
    };
    const invalidated = (client: QueryClient, key: readonly unknown[]) =>
        client.getQueryState(key)?.isInvalidated;

    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    it("refreshing the list leaves the count and the counters alone", () => {
        const client = seeded();
        const refreshers = createExecutionRefreshers(client);

        refreshers.list();

        expect(invalidated(client, listKey)).toBe(true);
        expect(invalidated(client, totalsKey)).toBe(false);
        expect(invalidated(client, digestKey)).toBe(false);
        expect(invalidated(client, facetsKey)).toBe(false);
    });

    it("refreshes the count with the counters, not with the list", () => {
        const client = seeded();
        const refreshers = createExecutionRefreshers(client);

        refreshers.counters();

        expect(invalidated(client, totalsKey)).toBe(true);
        expect(invalidated(client, digestKey)).toBe(true);
        expect(invalidated(client, facetsKey)).toBe(true);
        expect(invalidated(client, listKey)).toBe(false);
    });

    it("a burst of events refreshes the count once per counters interval", () => {
        const client = seeded();
        const invalidate = jest.spyOn(client, "invalidateQueries");
        const refreshers = createExecutionRefreshers(client);
        const totalsRefreshes = () =>
            invalidate.mock.calls.filter(
                ([arg]) =>
                    (arg?.queryKey as unknown[] | undefined)?.[0] ===
                    PULL_REQUEST_QUERY_ROOT.totals,
            ).length;

        // One event per second for as long as a counters interval lasts.
        for (
            let elapsed = 0;
            elapsed < COUNTERS_REFRESH_INTERVAL_MS;
            elapsed += 1_000
        ) {
            refreshers.list();
            refreshers.counters();
            jest.advanceTimersByTime(1_000);
        }

        // The first event, plus the one folded in at the end of the interval.
        expect(totalsRefreshes()).toBe(2);
        expect(COUNTERS_REFRESH_INTERVAL_MS).toBeGreaterThan(
            LIST_REFRESH_INTERVAL_MS,
        );
    });
});
