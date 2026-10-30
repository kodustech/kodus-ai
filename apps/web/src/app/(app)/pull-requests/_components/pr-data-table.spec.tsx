/** @jest-environment jsdom */
// @ts-nocheck
import "@testing-library/jest-dom";

import { TooltipProvider } from "@components/ui/tooltip";
import { fireEvent, render, screen } from "@testing-library/react";

import { PrDataTable } from "./pr-data-table";

jest.mock("@services/organizationParameters/hooks", () => ({
    useGetTimezone: () => "UTC",
}));

jest.mock("@services/pull-requests", () => {
    const actual = jest.requireActual("@services/pull-requests/utils");
    return { ...actual, usePrefetchPullRequestReview: () => jest.fn() };
});

// jsdom has no IntersectionObserver and never scrolls, so the only thing that
// can call fetchNextPage here is the on-settle auto-pull — which is the point.
// Every rect is 0×0, which reads as "the sentinel is still in view": the
// under-filled list this effect exists for.
beforeAll(() => {
    global.IntersectionObserver = class {
        observe() {}
        disconnect() {}
    };
});

const group = (n) => ({
    prId: `pr-${n}`,
    latest: {
        prId: `pr-${n}`,
        prNumber: n,
        repositoryId: "repo-1",
        repositoryName: "kodus-ai",
        title: `feat: ${n}`,
        headBranchRef: "feature",
        merged: false,
        createdAt: "2026-08-01T00:00:00.000Z",
        author: { name: "someone" },
        suggestionsCount: { sent: 0, filtered: 0 },
    },
    executions: [],
    reviewCount: 1,
});

const renderTable = (props = {}) => {
    const fetchNextPage = jest.fn();
    const view = render(
        <TooltipProvider>
            <PrDataTable
                data={[group(1)]}
                hasNextPage
                fetchNextPage={fetchNextPage}
                {...props}
            />
        </TooltipProvider>,
    );
    // Each settle: a fetch starts, then ends without adding rows (every row of
    // the page was discarded by a post-query filter).
    const settle = () => {
        for (const isFetchingNextPage of [true, false]) {
            view.rerender(
                <TooltipProvider>
                    <PrDataTable
                        data={[group(1)]}
                        hasNextPage
                        isFetchingNextPage={isFetchingNextPage}
                        fetchNextPage={fetchNextPage}
                        {...props}
                    />
                </TooltipProvider>,
            );
        }
    };
    return { fetchNextPage, settle };
};

/**
 * `getNextPageParam` keeps `hasNextPage` true while the backend still has
 * history to scan, and the query runs with `retry: false`. So an auto-pull that
 * re-fires on every settle would hammer a failing endpoint with no backoff, and
 * would read the whole history behind a selective filter unattended. It must
 * stop by itself and leave the reader a way to continue.
 */
describe("PrDataTable — auto-pull when a page under-fills the window", () => {
    it("does not pull again after a page failed", () => {
        const { fetchNextPage, settle } = renderTable({
            fetchNextPageFailed: true,
        });
        settle();
        settle();
        expect(fetchNextPage).not.toHaveBeenCalled();
        expect(
            screen.getByRole("button", { name: "Try again" }),
        ).toBeInTheDocument();
    });

    it("retries only when the reader asks", () => {
        const { fetchNextPage } = renderTable({ fetchNextPageFailed: true });
        fireEvent.click(screen.getByRole("button", { name: "Try again" }));
        expect(fetchNextPage).toHaveBeenCalledTimes(1);
    });

    it("stops after its budget and offers the rest as a button", () => {
        const { fetchNextPage, settle } = renderTable();
        for (let i = 0; i < 20; i += 1) settle();
        expect(fetchNextPage).toHaveBeenCalledTimes(10);
        expect(
            screen.getByRole("button", { name: "Load more" }),
        ).toBeInTheDocument();
    });

    it("keeps filling while it has budget", () => {
        const { fetchNextPage, settle } = renderTable();
        settle();
        expect(fetchNextPage).toHaveBeenCalled();
        expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
    });
});
