/** @jest-environment jsdom */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";

import { useRefreshIssuesAsScansProgress } from "./use-refresh-issues-as-scans-progress";

jest.mock("src/core/utils/helpers", () => ({
    pathToApiUrl: (path: string) => path,
}));

const scan = (uuid: string, status: string, created = 0) =>
    ({ uuid, status, outcome: { created, reopened: 0, resolved: 0 } }) as any;

function hookWith(queryClient: QueryClient) {
    const wrapper = ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    return renderHook(
        ({ scans }: { scans: any[] }) => useRefreshIssuesAsScansProgress(scans, true),
        { wrapper, initialProps: { scans: [] as any[] } },
    );
}

describe("useRefreshIssuesAsScansProgress", () => {
    it("refreshes the issues for a scan that shows up already finished", () => {
        const queryClient = new QueryClient();
        const invalidate = jest.spyOn(queryClient, "invalidateQueries");
        const { rerender } = hookWith(queryClient);

        // A short scan, started and done before the next poll.
        rerender({ scans: [scan("s-1", "completed", 3)] });

        expect(invalidate).toHaveBeenCalledWith({ queryKey: ["/issues"] });
    });

    it("waits for a scan that shows up running until its state moves", () => {
        const queryClient = new QueryClient();
        const invalidate = jest.spyOn(queryClient, "invalidateQueries");
        const { rerender } = hookWith(queryClient);

        rerender({ scans: [scan("s-1", "running")] });
        expect(invalidate).not.toHaveBeenCalled();

        rerender({ scans: [scan("s-1", "running", 2)] });
        expect(invalidate).toHaveBeenCalledWith({ queryKey: ["/issues"] });
    });
});
