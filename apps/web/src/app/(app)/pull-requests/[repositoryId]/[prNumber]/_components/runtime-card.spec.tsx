/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import type { ReactNode } from "react";
import { TooltipProvider } from "@components/ui/tooltip";
import { usePermission } from "@services/permissions/hooks";
import type { PrRuntime } from "@services/runtime/model/pull-request-runs";
import { useRequestPullRequestRun } from "@services/runtime/pull-request-runs";
import { useRuntimeRun } from "@services/runtime/queries";
import { render, screen } from "@testing-library/react";

import { PrRuntimeCard } from "./runtime-card";
import { PrHeader } from "./try-port/PrHeader";

jest.mock("@services/runtime/queries", () => ({ useRuntimeRun: jest.fn() }));
jest.mock("@services/runtime/pull-request-runs", () => ({
    usePullRequestRuns: jest.fn(),
    useRequestPullRequestRun: jest.fn(),
}));
jest.mock("@services/permissions/hooks", () => {
    const usePermission = jest.fn();
    return {
        usePermission,
        usePermissionOnEvery: (...args: unknown[]) => usePermission(...args),
    };
});
jest.mock("@components/runtime/run-actions", () => ({
    RerunButton: ({ run }: { run: { runId: string } }) => (
        <button type="button">Run again {run.runId}</button>
    ),
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

const SHA = "3c9e1aa".padEnd(40, "0");

const runtime = (patch: Partial<PrRuntime> = {}): PrRuntime => ({
    repositoryId: "repo-1",
    prNumber: 7,
    environment: {
        environmentId: "env-1",
        name: "acme/shop",
        ready: true,
        on: true,
    },
    latest: {
        runId: "run-1",
        attempt: 1,
        headSha: SHA,
        environmentId: "env-1",
        state: "regression",
        requestedAt: "2026-11-10T10:00:00.000Z",
        startedAt: "2026-11-10T10:00:00.000Z",
        finishedAt: "2026-11-10T10:03:05.000Z",
        regressions: 2,
        probes: 5,
    },
    commits: [],
    ...patch,
});

beforeEach(() => {
    (useRuntimeRun as jest.Mock).mockReturnValue({ data: undefined });
    (usePermission as jest.Mock).mockReturnValue(true);
    (useRequestPullRequestRun as jest.Mock).mockReturnValue({
        mutate: jest.fn(),
        isPending: false,
    });
});

const card = (r: PrRuntime) =>
    render(<PrRuntimeCard runtime={r} repositoryId="repo-1" prNumber={7} />);

describe("the Kody Runtime card of the PR page", () => {
    it("says the latest Run's verdict, environment, commit and time, with the way in and Run again", () => {
        card(runtime());
        expect(screen.getByText("2 regressions")).toBeInTheDocument();
        expect(screen.getByText("shop")).toBeInTheDocument();
        expect(screen.getByText("3c9e1aa")).toBeInTheDocument();
        expect(screen.getByText("3 min 05 s")).toBeInTheDocument();
        expect(
            screen.getByRole("link", { name: "Open the Run" }),
        ).toHaveAttribute("href", "/runtime/runs/run-1");
        expect(
            screen.getByRole("button", { name: "Run again run-1" }),
        ).toBeInTheDocument();
    });

    it("lists the other repositories the Run booted with, and tolerates a Run without them", () => {
        (useRuntimeRun as jest.Mock).mockReturnValue({
            data: {
                workspace: [
                    {
                        repositoryId: "repo-1",
                        alias: "shop",
                        baseSha: "1".repeat(40),
                        headSha: SHA,
                        source: "pull_request",
                    },
                    {
                        repositoryId: "repo-2",
                        alias: "billing-api",
                        baseSha: "9f8e7d6".padEnd(40, "1"),
                        headSha: "9f8e7d6".padEnd(40, "1"),
                        source: "default_branch",
                        branch: "main",
                    },
                    {
                        repositoryId: "repo-3",
                        alias: "auth",
                        baseSha: "4c5d6e7".padEnd(40, "2"),
                        headSha: "5d6e7f8".padEnd(40, "3"),
                        source: "paired",
                        pairedPrNumber: 77,
                    },
                ],
            },
        });
        card(runtime());
        expect(
            screen
                .getByRole("list", { name: "Ran with" })
                .querySelectorAll("li"),
        ).toHaveLength(2);
        const ranWith = screen.getByRole("list", { name: "Ran with" });
        // Each repository with the commit it booted at and where it came from.
        expect(ranWith).toHaveTextContent("9f8e7d6");
        expect(ranWith).toHaveTextContent("#77");
    });

    it("offers a Run on a PR that never ran, and shows nothing without an environment", () => {
        const { unmount } = card(runtime({ latest: null }));
        expect(
            screen.getByRole("button", { name: /Run on this PR/ }),
        ).toBeInTheDocument();
        unmount();
        const { container } = card(
            runtime({ latest: null, environment: null }),
        );
        expect(container).toBeEmptyDOMElement();
    });

    it("offers no Run when none can start, or when the viewer may not start Runs on every repository it would hold", () => {
        const refused = card(runtime({ latest: null, canRequestRun: false }));
        expect(screen.queryByRole("button")).toBeNull();
        refused.unmount();

        (usePermission as jest.Mock).mockImplementation(
            (_a: string, _r: string, ids: string[]) =>
                ids.every((id) => id === "repo-1"),
        );
        card(
            runtime({
                latest: null,
                canRequestRun: true,
                environment: {
                    environmentId: "env-1",
                    name: "acme/shop",
                    ready: true,
                    on: true,
                    triggers: true,
                    repositoryIds: ["repo-1", "repo-2"],
                },
            }),
        );
        expect(screen.queryByRole("button")).toBeNull();
    });
});

describe("the card of a PR whose repository is in several environments", () => {
    const own = {
        environmentId: "env-1",
        name: "acme/shop",
        ready: true,
        on: true,
        role: "primary" as const,
        triggers: true,
    };
    const platform = {
        environmentId: "env-2",
        name: "acme/platform",
        ready: true,
        on: true,
        role: "member" as const,
        triggers: true,
    };

    it("shows the primary's verdict and hints the other environment with its own", () => {
        const base = runtime();
        const platformRun = {
            ...base.latest!,
            runId: "run-2",
            environmentId: "env-2",
            state: "no_regressions" as const,
            regressions: 0,
            requestedAt: "2026-11-10T11:00:00.000Z",
        };
        render(
            <TooltipProvider>
                <PrRuntimeCard
                    runtime={runtime({
                        environment: own,
                        environments: [own, platform],
                        latest: platformRun,
                        commits: [platformRun, base.latest!],
                    })}
                    repositoryId="repo-1"
                    prNumber={7}
                />
            </TooltipProvider>,
        );
        expect(screen.getByText("2 regressions")).toBeInTheDocument();
        expect(
            screen.getByRole("link", { name: "Open the Run" }),
        ).toHaveAttribute("href", "/runtime/runs/run-1");
        expect(
            screen.getByRole("button", {
                name: "+1 environment. platform: No regression.",
            }),
        ).toBeInTheDocument();
    });
});

describe("the Runtime tab's badge", () => {
    const pr = { number: 7, title: "t", state: "open" } as any;
    it("counts the latest Run's regressions", () => {
        render(
            <PrHeader
                pr={pr}
                suggestionCount={0}
                activeTab="review"
                onTabChange={() => undefined}
                tabs={["review", "runtime"]}
                runtimeRegressions={2}
            />,
        );
        expect(
            screen.getByRole("button", { name: /^Runtime.*2 regressions$/ }),
        ).toBeInTheDocument();
    });

    it("has no badge when nothing regressed", () => {
        render(
            <PrHeader
                pr={pr}
                suggestionCount={0}
                activeTab="review"
                onTabChange={() => undefined}
                tabs={["review", "runtime"]}
                runtimeRegressions={0}
            />,
        );
        expect(
            screen.getByRole("button", { name: "Runtime" }),
        ).toBeInTheDocument();
    });
});
