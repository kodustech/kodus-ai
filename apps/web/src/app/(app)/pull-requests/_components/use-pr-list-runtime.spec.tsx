/** @jest-environment jsdom */
import { usePullRequestRuns } from "@services/runtime/pull-request-runs";
import { renderHook } from "@testing-library/react";
import { useFeatureFlags } from "src/app/(app)/settings/_components/context";
import { usePermissions } from "src/core/providers/permissions.provider";

import { usePrListRuntime } from "./use-pr-list-runtime";

jest.mock("@services/runtime/pull-request-runs", () => ({
    usePullRequestRuns: jest.fn(),
}));
jest.mock("src/core/providers/auth.provider", () => ({
    useAuth: () => ({ organizationId: "org-1" }),
}));
jest.mock("src/app/(app)/settings/_components/context", () => ({
    useFeatureFlags: jest.fn(),
}));
jest.mock("src/core/providers/permissions.provider", () => ({
    usePermissions: jest.fn(),
}));

const group = (prNumber: number, repositoryId: string) =>
    ({
        prId: `${repositoryId}-${prNumber}`,
        latest: {
            prId: `${repositoryId}-${prNumber}`,
            prNumber,
            repositoryId,
            reviewedCommitSha: "b".repeat(40),
            createdAt: "2026-11-10T12:00:00.000Z",
        },
        executions: [],
        reviewCount: 1,
    }) as any;

const groups = [group(1, "repo-1"), group(2, "repo-2")];

beforeEach(() => {
    // Kody Runtime is released to the org (alpha track and flag) unless a test says otherwise.
    (useFeatureFlags as jest.Mock).mockReturnValue({ kodyRuntime: true });
    (usePullRequestRuns as jest.Mock).mockReturnValue({
        byPullRequest: new Map([
            [
                "repo-1#1",
                {
                    repositoryId: "repo-1",
                    prNumber: 1,
                    environment: {
                        environmentId: "e",
                        name: "r",
                        ready: true,
                        on: true,
                    },
                    latest: {
                        runId: "run-1",
                        attempt: 1,
                        headSha: "a".repeat(40),
                        environmentId: "e",
                        state: "regression",
                        requestedAt: "2026-11-10T10:00:00.000Z",
                        regressions: 1,
                        probes: 2,
                    },
                    commits: [],
                },
            ],
        ]),
        isLoading: false,
        isError: false,
        unavailable: new Set(),
        retry: jest.fn(),
    });
});

describe("the Runtime state of the list", () => {
    it("asks nothing and shows no column for a viewer who reads no Runtime Runs", () => {
        (usePermissions as jest.Mock).mockReturnValue({});
        const { result } = renderHook(() => usePrListRuntime(groups));
        expect(result.current.enabled).toBe(false);
        expect(usePullRequestRuns).toHaveBeenLastCalledWith([], false);
    });

    it("asks nothing and shows no column, filter or count for an org Kody Runtime is not released to", () => {
        (useFeatureFlags as jest.Mock).mockReturnValue({ kodyRuntime: false });
        (usePermissions as jest.Mock).mockReturnValue({
            runtime_run: {
                read: { organizationId: "org-1", repoId: ["repo-1"] },
            },
        });
        const { result } = renderHook(() => usePrListRuntime(groups));
        expect(result.current.enabled).toBe(false);
        expect(usePullRequestRuns).toHaveBeenLastCalledWith([], false);
    });

    it("asks once for the PRs of the repositories the viewer may read, and none of the others", () => {
        (usePermissions as jest.Mock).mockReturnValue({
            runtime_run: {
                read: { organizationId: "org-1", repoId: ["repo-1"] },
            },
        });
        const { result } = renderHook(() => usePrListRuntime(groups));
        expect(result.current.enabled).toBe(true);
        expect(usePullRequestRuns).toHaveBeenLastCalledWith(
            [{ repositoryId: "repo-1", prNumber: 1 }],
            true,
        );
        expect(result.current.rowOf(groups[0])).toMatchObject({
            canRead: true,
            cell: { kind: "regression", count: 1, stale: "aaaaaaa" },
        });
        expect(result.current.rowOf(groups[1]).canRead).toBe(false);
        expect(result.current.regressionCount).toBe(1);
    });

    it("says a PR whose Runtime read failed is unavailable, and the regression count is unknown, not 0", () => {
        const retry = jest.fn();
        (usePullRequestRuns as jest.Mock).mockReturnValue({
            byPullRequest: new Map(),
            isLoading: false,
            isError: true,
            unavailable: new Set(["repo-1#1"]),
            retry,
        });
        (usePermissions as jest.Mock).mockReturnValue({
            runtime_run: {
                read: { organizationId: "org-1", repoId: ["repo-1"] },
            },
        });
        const { result } = renderHook(() => usePrListRuntime(groups));
        const row = result.current.rowOf(groups[0]);
        expect(row.cell).toEqual({ kind: "unavailable" });
        row.retry?.();
        expect(retry).toHaveBeenCalled();
        expect(result.current.regressionCount).toBeNull();
    });
});
