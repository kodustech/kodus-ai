/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import type { ReactNode } from "react";
import type { RuntimeRunSummary } from "@services/runtime/contracts";
import { render, screen, within } from "@testing-library/react";

import { RunsPage } from "./_page-component";

const mockRuns = { data: [] as RuntimeRunSummary[] };

jest.mock("next/link", () => ({
    __esModule: true,
    default: ({
        children,
        href,
        className,
        title,
    }: {
        children: ReactNode;
        href: string;
        className?: string;
        title?: string;
    }) => (
        <a href={href} className={className} title={title}>
            {children}
        </a>
    ),
}));
const mockEnvironments = {
    query: {
        isPending: false,
        data: [
            { environmentId: "e1", repositoryId: "r1", state: "active" },
        ] as unknown[],
    },
};
jest.mock("nuqs", () => ({
    useQueryState: () => ["r1", jest.fn()],
}));
jest.mock("@services/parameters/use-code-review-scopes", () => ({
    useCodeReviewScopes: () => [{ id: "r1", name: "acme/shop" }],
}));
jest.mock("@services/runtime/api", () => ({ MAX_RUNS_PAGE: 100 }));
jest.mock("@services/runtime/queries", () => ({
    RUNS_PAGE_SIZE: 20,
    useRuntimeEnvironments: () => mockEnvironments.query,
    useRuntimeRuns: () => ({
        isLoading: false,
        isError: false,
        isFetching: false,
        data: mockRuns.data,
    }),
}));
jest.mock("@components/runtime/runtime-header", () => ({
    RuntimeHeader: () => null,
}));
jest.mock("@components/runtime/repository-select", () => ({
    RepositorySelect: () => null,
}));
jest.mock("@components/runtime/run-cost", () => ({
    RunCostTotal: () => <span>$0.12</span>,
}));

const run = (patch: Partial<RuntimeRunSummary>): RuntimeRunSummary => ({
    runId: "run-1",
    attempt: 1,
    repositoryId: "r1",
    repositoryName: "acme/shop",
    prNumber: 42,
    headSha: "a".repeat(40),
    state: "no_regressions",
    requestedAt: "2026-11-10T12:00:00.000Z",
    startedAt: "2026-11-10T12:00:00.000Z",
    finishedAt: "2026-11-10T12:04:00.000Z",
    ...patch,
});

describe("Runs list", () => {
    it("reads each Run as its pull request, one verdict, when, how long and cost", () => {
        mockRuns.data = [
            run({
                runId: "run-1",
                state: "partly_tested",
                check: {
                    conclusion: "neutral",
                    title: "Partly tested · 3 blocked outbound requests",
                },
            }),
            run({
                runId: "run-2",
                prNumber: 43,
                attempt: 2,
                state: "testing",
                finishedAt: undefined,
            }),
        ];
        render(<RunsPage />);
        const [, first, second] = screen.getAllByRole("row");

        // The check's conclusion is not a second chip next to the state.
        expect(within(first).queryByText("Neutral")).not.toBeInTheDocument();
        expect(within(first).getByText("Partly tested")).toBeInTheDocument();
        expect(
            within(first).getByText("3 blocked outbound requests"),
        ).toBeInTheDocument();
        expect(within(first).getByText("4 min 00 s")).toBeInTheDocument();
        expect(within(first).getByText("$0.12")).toBeInTheDocument();
        expect(
            within(first).getByRole("link", { name: "#42" }),
        ).toHaveAttribute("href", "/runtime/runs/run-1");

        expect(within(second).getByText(/attempt 2/)).toBeInTheDocument();
        expect(within(second).getByText("Running")).toBeInTheDocument();
    });

    it("spends no accent on the rows: a pull request rests white", () => {
        mockRuns.data = [run({})];
        render(<RunsPage />);
        const link = screen.getByRole("link", { name: "#42" });
        expect(link).toHaveClass("text-text-primary");
        expect(link).not.toHaveClass("text-primary-light");
    });

    it("reads a Run by its pull request's title, white at rest, with the number and commit under it", () => {
        const title =
            "fix(orders): the coupon total rounds down when the cart mixes currencies";
        mockRuns.data = [run({ prTitle: title, attempt: 2 })];
        render(<RunsPage />);
        const [, row] = screen.getAllByRole("row");
        const link = within(row).getByRole("link", { name: title });
        expect(link).toHaveAttribute("href", "/runtime/runs/run-1");
        // Cut to the column, the whole title one hover away.
        expect(link).toHaveAttribute("title", title);
        expect(link).toHaveClass("truncate", "text-text-primary");
        expect(link).toHaveClass("hover:text-primary-light");
        expect(link).not.toHaveClass("text-primary-light");
        expect(
            within(row).queryByRole("link", { name: "#42" }),
        ).not.toBeInTheDocument();
        expect(
            within(row).getByText("aaaaaaa").parentElement,
        ).toHaveTextContent(/^#42 · aaaaaaa · attempt 2$/);
    });

    it("an older Run without a title keeps its number as the link and its commit under it", () => {
        mockRuns.data = [run({})];
        render(<RunsPage />);
        const [, row] = screen.getAllByRole("row");
        const link = within(row).getByRole("link", { name: "#42" });
        expect(link).not.toHaveAttribute("title");
        expect(
            within(row).getByText("aaaaaaa").parentElement,
        ).toHaveTextContent(/^aaaaaaa$/);
    });

    it("offers no repository and says where to set one up when no repository has an environment", () => {
        mockEnvironments.query = { isPending: false, data: [] };
        render(<RunsPage />);
        expect(screen.getByText("No environment yet")).toBeInTheDocument();
        expect(
            screen.getByRole("link", { name: "Environments" }),
        ).toHaveAttribute("href", "/runtime/environments");
        mockEnvironments.query = {
            isPending: false,
            data: [
                { environmentId: "e1", repositoryId: "r1", state: "active" },
            ],
        };
    });
});
