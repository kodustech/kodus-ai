/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import type { ReactNode } from "react";
import { toast } from "@components/ui/toaster/use-toast";
import { TooltipProvider } from "@components/ui/tooltip";
import type {
    PrRuntime,
    PrRuntimeCell,
} from "@services/runtime/model/pull-request-runs";
import { useRequestPullRequestRun } from "@services/runtime/pull-request-runs";
import { fireEvent, render, screen } from "@testing-library/react";

import { PrDataTable } from "./pr-data-table";
import { PrRuntimeColumn } from "./pr-runtime";

// The viewer may start Runs on these repositories only.
let mockAllowedRepositories = new Set<string>();
jest.mock("@services/permissions/hooks", () => ({
    usePermissionOnEvery: (_a: string, _r: string, ids: string[]) =>
        ids.every((id) => mockAllowedRepositories.has(id)),
}));
jest.mock("@services/runtime/pull-request-runs", () => ({
    useRequestPullRequestRun: jest.fn(),
}));
jest.mock("@components/ui/toaster/use-toast", () => ({ toast: jest.fn() }));
jest.mock("next/navigation", () => ({
    useRouter: () => ({ push: jest.fn() }),
}));
jest.mock("next/link", () => ({
    __esModule: true,
    default: ({ children, href }: { children: ReactNode; href: string }) => (
        <a href={href}>{children}</a>
    ),
}));
jest.mock("@services/organizationParameters/hooks", () => ({
    useGetTimezone: () => "UTC",
}));
jest.mock("@services/pull-requests", () => {
    const actual = jest.requireActual("@services/pull-requests/utils");
    return { ...actual, usePrefetchPullRequestReview: () => jest.fn() };
});
jest.mock("./pr-commit-timeline", () => ({ PrCommitTimeline: () => null }));

const mutate = jest.fn();
beforeEach(() => {
    mutate.mockReset();
    mockAllowedRepositories = new Set(["repo-1"]);
    (useRequestPullRequestRun as jest.Mock).mockReturnValue({
        mutate,
        isPending: false,
    });
});

const cellView = (cell: PrRuntimeCell | undefined, runtime?: PrRuntime) =>
    render(
        <PrRuntimeColumn
            cell={cell}
            repositoryId="repo-1"
            prNumber={7}
            runtime={runtime}
        />,
    );

describe("the Runtime column", () => {
    it("links regressions to the Run", () => {
        cellView({ kind: "regression", count: 2, runId: "run-9" });
        expect(
            screen.getByRole("link", { name: "2 regressions" }),
        ).toHaveAttribute("href", "/runtime/runs/run-9");
    });

    it("says a clean Run with its probes, a live one with its phase, a boot failure with its side", () => {
        const { unmount } = cellView({ kind: "clean", probes: 1, runId: "r" });
        expect(screen.getByText(/No regression/)).toBeInTheDocument();
        unmount();
        const live = cellView({
            kind: "running",
            label: "booting",
            runId: "r",
        });
        expect(screen.getByText(/booting/)).toBeInTheDocument();
        live.unmount();
        cellView({ kind: "could_not_boot", where: "environment", runId: "r" });
        expect(
            screen.getByText(/environment/),
        ).toBeInTheDocument();
    });

    it("adds the commit the Run was on when the latest commit did not run", () => {
        cellView({ kind: "clean", probes: 3, runId: "r", stale: "3c9e1aa" });
        expect(screen.getByText(/latest not run/)).toHaveTextContent(
            "on 3c9e1aa · latest not run",
        );
    });

    it("says the state could not be read, and asks again on retry", () => {
        const onRetry = jest.fn();
        render(
            <PrRuntimeColumn
                cell={{ kind: "unavailable" }}
                repositoryId="repo-1"
                prNumber={7}
                onRetry={onRetry}
            />,
        );
        expect(screen.getByText("Unavailable")).toBeInTheDocument();
        expect(screen.queryByText("—")).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: /retry/i }));
        expect(onRetry).toHaveBeenCalled();
    });

    it("shows a dash without an environment", () => {
        cellView({ kind: "no_environment" });
        expect(screen.getByText("—")).toBeInTheDocument();
        expect(screen.queryByRole("button")).toBeNull();
    });

    it("asks for a Run on a PR that never ran, only for whoever may ask", () => {
        const { unmount } = cellView({ kind: "not_run", canRequest: true });
        fireEvent.click(screen.getByRole("button", { name: /Run on this PR/ }));
        expect(mutate).toHaveBeenCalledWith(
            { repositoryId: "repo-1", prNumber: 7 },
            expect.anything(),
        );
        unmount();

        // The environment that would run holds another repository the viewer may not start Runs on.
        const denied = cellView(
            { kind: "not_run", canRequest: true },
            {
                repositoryId: "repo-1",
                prNumber: 7,
                environment: {
                    environmentId: "env-1",
                    name: "acme/shop",
                    ready: true,
                    on: true,
                    triggers: true,
                    repositoryIds: ["repo-1", "repo-2"],
                },
                canRequestRun: true,
                latest: null,
                commits: [],
            },
        );
        expect(screen.queryByRole("button")).toBeNull();
        expect(screen.getByText("Not run")).toBeInTheDocument();
        denied.unmount();

        cellView({
            kind: "not_run",
            canRequest: false,
            reason: "The environment is not ready yet.",
        });
        expect(
            screen.getByText("The environment is not ready yet."),
        ).toBeInTheDocument();
        expect(screen.queryByRole("button")).toBeNull();
    });
});

describe("the Runtime column of a PR in several environments", () => {
    const run = (patch: Record<string, unknown>) => ({
        runId: "run-1",
        attempt: 1,
        headSha: "a".repeat(40),
        environmentId: "env-1",
        state: "regression" as const,
        requestedAt: "2026-11-10T10:00:00.000Z",
        regressions: 1,
        probes: 3,
        ...patch,
    });
    const env = (
        environmentId: string,
        name: string,
        role: "primary" | "member",
        triggers = true,
    ) => ({
        environmentId,
        name,
        ready: true,
        on: true,
        role,
        triggers,
    });
    const several = (latest: ReturnType<typeof run>, commits = [latest]) => ({
        repositoryId: "repo-1",
        prNumber: 7,
        environment: env("env-1", "acme/auth", "primary"),
        environments: [
            env("env-1", "acme/auth", "primary"),
            env("env-2", "acme/platform", "member"),
            env("env-3", "acme/checkout", "member", false),
        ],
        latest,
        commits,
    });

    it("hints the other environments, each with its own state", () => {
        const own = run({});
        const platform = run({
            runId: "run-2",
            environmentId: "env-2",
            state: "no_regressions",
            regressions: 0,
        });
        render(
            <TooltipProvider>
                <PrRuntimeColumn
                    cell={{ kind: "regression", count: 1, runId: "run-1" }}
                    repositoryId="repo-1"
                    prNumber={7}
                    runtime={several(platform, [platform, own])}
                />
            </TooltipProvider>,
        );
        expect(
            screen.getByRole("button", {
                name: "+2 environments. platform: No regression. checkout: does not run this repository's PRs.",
            }),
        ).toBeInTheDocument();
        expect(screen.queryByText(/^in /)).toBeNull();
    });

    it("names the environment of the verdict when the main one's Run is not in the answer", () => {
        const platform = run({ runId: "run-2", environmentId: "env-2" });
        render(
            <TooltipProvider>
                <PrRuntimeColumn
                    cell={{ kind: "regression", count: 1, runId: "run-2" }}
                    repositoryId="repo-1"
                    prNumber={7}
                    runtime={several(platform)}
                />
            </TooltipProvider>,
        );
        expect(screen.getByText("in platform")).toBeInTheDocument();
    });

    it("starts every environment's Run at once and says how many", () => {
        cellView({ kind: "not_run", canRequest: true });
        fireEvent.click(screen.getByRole("button", { name: /Run on this PR/ }));
        const [, options] = mutate.mock.calls[0];
        options.onSuccess({
            runId: "r1",
            attempt: 1,
            state: "queued",
            runs: [
                {
                    environmentId: "env-1",
                    runId: "r1",
                    attempt: 1,
                    state: "queued",
                },
                {
                    environmentId: "env-2",
                    runId: "r2",
                    attempt: 1,
                    state: "queued",
                },
            ],
        });
        expect(toast).toHaveBeenCalledWith(
            expect.objectContaining({ title: "2 runs queued" }),
        );
    });
});

const group = (n: number, repositoryId = "repo-1") => ({
    prId: `pr-${n}`,
    latest: {
        prId: `pr-${n}`,
        prNumber: n,
        repositoryId,
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

const renderTable = (runtime?: Parameters<typeof PrDataTable>[0]["runtime"]) =>
    render(
        <TooltipProvider>
            <PrDataTable data={[group(1) as any]} runtime={runtime} />
        </TooltipProvider>,
    );

describe("the Runtime column in the table", () => {
    beforeAll(() => {
        global.IntersectionObserver = class {
            observe() {}
            disconnect() {}
        } as any;
    });

    it("is absent for a viewer who reads no Runtime Runs", () => {
        renderTable(undefined);
        expect(screen.queryByText("Runtime")).toBeNull();
    });

    it("shows the row's verdict where the viewer may read the repository's Runs", () => {
        renderTable({
            rowOf: () => ({
                canRead: true,
                cell: { kind: "regression", count: 1, runId: "run-1" },
            }),
        });
        expect(screen.getByText("Runtime")).toBeInTheDocument();
    });

    it("renders nothing in the row for a repository the viewer may not read", () => {
        renderTable({
            rowOf: () => ({
                canRead: false,
                cell: { kind: "regression", count: 1, runId: "run-1" },
            }),
        });
        expect(screen.getByText("Runtime")).toBeInTheDocument();
        expect(screen.queryByText("1 regression")).toBeNull();
    });
});
