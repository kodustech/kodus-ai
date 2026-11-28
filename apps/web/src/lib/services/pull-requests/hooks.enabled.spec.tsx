/** @jest-environment jsdom */
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { axiosAuthorized } from "src/core/utils/axios";

import { useInfinitePullRequestExecutions } from "./hooks";

jest.mock("src/core/utils/axios", () => ({
    axiosAuthorized: { fetcher: jest.fn() },
}));
jest.mock("./fetch", () => ({
    PULL_REQUEST_API: { GET_EXECUTIONS: (p: unknown) => `/executions?${JSON.stringify(p)}` },
    PULL_REQUEST_SSE: {},
}));

// WP5: the Run page reads its PR's title through the PR list query. Before
// the Run loaded it asked with no filter at all: an org-wide scan of the
// product's slowest endpoint on every Run page open.

const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        {children}
    </QueryClientProvider>
);

describe("useInfinitePullRequestExecutions with enabled", () => {
    const fetcher = axiosAuthorized.fetcher as jest.Mock;
    beforeEach(() => fetcher.mockReset().mockResolvedValue({ data: { data: [], pagination: {} } }));

    it("asks nothing while disabled, and once with the filters when enabled", async () => {
        const { rerender } = renderHook(
            ({ on }: { on: boolean }) =>
                useInfinitePullRequestExecutions(on ? { repositoryId: "repo-1", pullRequestNumber: "7" } : undefined, { pageSize: 1, poll: false, enabled: on }),
            { wrapper, initialProps: { on: false } },
        );
        await act(async () => undefined);
        expect(fetcher).not.toHaveBeenCalled();
        rerender({ on: true });
        await act(async () => undefined);
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(fetcher.mock.calls[0][0]).toContain('"repositoryId":"repo-1"');
    });
});
