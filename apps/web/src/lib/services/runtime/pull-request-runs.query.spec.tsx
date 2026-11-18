/** @jest-environment jsdom */
import type { ReactNode } from "react";
import { typedFetch } from "@services/fetch";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";

import { usePullRequestRuns } from "./pull-request-runs";

jest.mock("@services/fetch", () => ({ typedFetch: jest.fn() }));
jest.mock("src/core/utils/helpers", () => ({
    pathToApiUrl: (path: string) => `/api/proxy${path}`,
}));
jest.mock("./queries", () => ({
    runtimeKeys: { runsAll: () => ["runtime", "runs"] },
    markRunsStarted: jest.fn(),
}));

const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider
        client={
            new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }>
        {children}
    </QueryClientProvider>
);

const prs = [
    { repositoryId: "repo-1", prNumber: 1 },
    { repositoryId: "repo-1", prNumber: 2 },
];

describe("the Runtime state of the PR list as it pages and re-sorts", () => {
    beforeEach(() =>
        (typedFetch as jest.Mock)
            .mockReset()
            .mockImplementation(async (_url: string, init: { body: string }) => ({
                pullRequests: JSON.parse(init.body).pullRequests.map((p: object) => ({ ...p, commits: [] })),
            })),
    );

    it("asks only for the PRs it has not asked for yet (WP2)", async () => {
        const list = (n: number) => Array.from({ length: n }, (_, i) => ({ repositoryId: "repo-1", prNumber: i + 1 }));
        const { result, rerender } = renderHook(({ shown }) => usePullRequestRuns(shown), {
            wrapper,
            initialProps: { shown: list(30) },
        });
        await waitFor(() => expect(result.current.byPullRequest.size).toBe(30));
        // The next page: 30 more rows.
        rerender({ shown: list(60) });
        await waitFor(() => expect(result.current.byPullRequest.size).toBe(60));
        // An SSE update re-sorts the list, and a new PR comes in at the top.
        rerender({ shown: [{ repositoryId: "repo-1", prNumber: 61 }, ...list(60).reverse()] });
        await waitFor(() => expect(result.current.byPullRequest.size).toBe(61));
        // Before: 5 calls (each page and each re-sort re-keyed the chunks). Now one per new set of PRs.
        expect(typedFetch).toHaveBeenCalledTimes(3);
        const asked = (typedFetch as jest.Mock).mock.calls.map(([, init]) => JSON.parse(init.body).pullRequests.length);
        expect(asked).toEqual([30, 30, 1]);
    });
});

describe("the Runtime state of a page of PRs when the API fails", () => {
    beforeEach(() => (typedFetch as jest.Mock).mockReset());

    it("says the PRs of a failed call are unavailable, not that they have no environment", async () => {
        (typedFetch as jest.Mock).mockRejectedValue(new Error("503"));
        const { result } = renderHook(() => usePullRequestRuns(prs), {
            wrapper,
        });
        await waitFor(() => expect(result.current.isError).toBe(true));
        expect([...result.current.unavailable].sort()).toEqual([
            "repo-1#1",
            "repo-1#2",
        ]);
        expect(result.current.byPullRequest.size).toBe(0);
    });

    it("asks again for the failed call on retry, and the answer replaces the error", async () => {
        (typedFetch as jest.Mock).mockRejectedValueOnce(new Error("503"));
        const { result } = renderHook(() => usePullRequestRuns(prs), {
            wrapper,
        });
        await waitFor(() => expect(result.current.isError).toBe(true));
        (typedFetch as jest.Mock).mockResolvedValueOnce({
            pullRequests: [{ repositoryId: "repo-1", prNumber: 1, commits: [] }],
        });
        result.current.retry();
        await waitFor(() => expect(result.current.isError).toBe(false));
        expect(result.current.unavailable.size).toBe(0);
        expect(result.current.byPullRequest.has("repo-1#1")).toBe(true);
    });
});
