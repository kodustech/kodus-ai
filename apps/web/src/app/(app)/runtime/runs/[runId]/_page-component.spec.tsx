/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import type { ReactNode } from "react";
import type { RuntimeRun, RuntimeSuiteRun } from "@services/runtime/contracts";
import {
    bootFailureRun,
    newRouteRun,
    newRouteView,
    partlyTestedView,
    regressionRun,
    regressionView,
    sumdbBootFailure,
} from "@services/runtime/model/__fixtures__/run-detail";
import type { RunStreamView } from "@services/runtime/stream";
import { fireEvent, render, screen, within } from "@testing-library/react";

import { RunDetailPage } from "./_page-component";

const mockState: {
    run?: RuntimeRun;
    view?: RunStreamView;
    suite?: RuntimeSuiteRun | null;
} = {};
/** Kodus's own record of the PR (its code review executions); none by default. */
const mockExecutions: { items: Array<Record<string, unknown>> } = { items: [] };
const mockIntent = jest.fn();

jest.mock("next/link", () => ({
    __esModule: true,
    default: ({
        href,
        children,
        ...rest
    }: {
        href: string;
        children: ReactNode;
    }) => (
        <a href={href} {...rest}>
            {children}
        </a>
    ),
}));
const mockSearch = { tab: null as string | null };
jest.mock("next/navigation", () => ({
    useRouter: () => ({ push: jest.fn() }),
    useSearchParams: () => ({ get: () => mockSearch.tab }),
}));
jest.mock("@components/ui/toaster/use-toast", () => ({ toast: jest.fn() }));
jest.mock("@components/runtime/browser-evidence", () => ({
    BrowserEvidence: () => null,
}));
jest.mock("@services/runtime/api", () => ({ getRunEvidenceUrl: jest.fn() }));
jest.mock("src/core/providers/auth.provider", () => ({
    useAuth: () => ({ userId: "u-1" }),
}));
jest.mock("@services/permissions/hooks", () => ({
    usePermission: () => true,
    usePermissionOnEvery: () => true,
}));
jest.mock("@services/pull-requests/hooks", () => ({
    useInfinitePullRequestExecutions: () => ({ items: mockExecutions.items }),
}));
jest.mock("@services/runtime/queries", () => {
    const idle = () => ({ mutate: jest.fn(), isPending: false });
    return {
        useRuntimeRun: () => ({
            data: mockState.run,
            isLoading: false,
            isError: false,
        }),
        useRunBeingRecorded: () => false,
        useRunStream: () => ({ view: mockState.view, status: "done" }),
        useRunSuite: () => ({ data: mockState.suite }),
        useRetryRunSuite: idle,
        useFindingFeedback: idle,
        useFindingIntent: () => ({ mutate: mockIntent, isPending: false }),
        useRuntimeEnvironment: () => ({ data: undefined }),
        useRunPreviews: () => ({ data: undefined }),
        useStopRunPreview: idle,
        useRerunRun: idle,
        useApproveRun: idle,
        useRunReproduction: () => ({ isPending: true }),
    };
});

const show = (run: RuntimeRun, view: RunStreamView) => {
    mockState.run = run;
    mockState.view = view;
    return render(<RunDetailPage runId={run.runId} />);
};

/** The <details> a section heading sits in. */
const section = (name: string | RegExp) =>
    screen.getByRole("heading", { name }).closest("details")!;

describe("RunDetailPage", () => {
    beforeEach(() => {
        mockIntent.mockReset();
        mockExecutions.items = [];
        mockState.suite = undefined;
        mockSearch.tab = null;
    });

    describe("the e2e suite tab", () => {
        const suite = {
            suiteRunId: "sr-1",
            environmentId: "env-1",
            mode: "run",
            state: "failed",
            requestedAt: "2026-11-24T10:00:00.000Z",
            mainSha: "a".repeat(40),
            selection: { mode: "full", total: 3 },
            specs: { ran: 3, total: 3 },
            totals: { passed: 2, failed: 1, skipped: 0, notRun: 0 },
            classes: {
                regression: 0,
                preExisting: 0,
                flaky: 0,
                unclassified: 0,
            },
            hosts: 1,
            shards: [],
            failures: [],
            passed: ["a.spec.ts"],
            canRetry: false,
        } as unknown as RuntimeSuiteRun;

        it("is not offered for a Run with no suite: the page is what it was", () => {
            show(regressionRun(), regressionView());
            expect(
                screen.queryByRole("link", { name: "e2e suite" }),
            ).not.toBeInTheDocument();
            expect(
                screen.queryByRole("navigation", { name: "Run sections" }),
            ).not.toBeInTheDocument();
        });

        it("is a tab beside the Run when the Run has a suite, and the Run's sections stay the first tab", () => {
            mockState.suite = suite;
            show(regressionRun(), regressionView());
            const nav = screen.getByRole("navigation", {
                name: "Run sections",
            });
            expect(
                within(nav).getByRole("link", { name: "e2e suite" }),
            ).toHaveAttribute(
                "href",
                expect.stringContaining("?tab=e2e-suite"),
            );
            expect(
                screen.getByRole("heading", { name: "Logs" }),
            ).toBeInTheDocument();
            expect(
                screen.queryByRole("region", { name: "Verdict" }),
            ).not.toBeInTheDocument();
        });

        it("shows the suite instead of the Run's sections on its tab", () => {
            mockState.suite = suite;
            mockSearch.tab = "e2e-suite";
            show(regressionRun(), regressionView());
            expect(
                screen.getByRole("region", { name: "Verdict" }),
            ).toBeInTheDocument();
            expect(
                screen.queryByRole("heading", { name: "Logs" }),
            ).not.toBeInTheDocument();
        });

        it("ignores the tab for a Run with no suite", () => {
            mockSearch.tab = "e2e-suite";
            show(regressionRun(), regressionView());
            expect(
                screen.getByRole("heading", { name: "Logs" }),
            ).toBeInTheDocument();
        });
    });

    it("shows one status line instead of the stat tiles and the generated headline", () => {
        show(regressionRun(), regressionView());
        expect(screen.getByText(/^✕ \d+ regression/)).toHaveTextContent(
            /5d49b8a vs main$/,
        );
        expect(screen.queryByText(/How sure/)).not.toBeInTheDocument();
        expect(screen.queryByText(/Open the finding/)).not.toBeInTheDocument();
        expect(screen.queryByText(/Why it took/)).not.toBeInTheDocument();
    });

    it("renders the same finding card with Details closed", () => {
        show(regressionRun(), regressionView());
        const [card] = screen.getAllByRole("article");
        expect(
            within(card).getByRole("region", { name: "Proof" }),
        ).toBeInTheDocument();
        expect(
            within(card).getByText("Details").closest("details"),
        ).not.toHaveAttribute("open");
    });

    it("keeps the logs in one closed section", () => {
        show(regressionRun(), regressionView());
        expect(section("Logs")).not.toHaveAttribute("open");
    });

    it("says nothing about the PR when everything posted", () => {
        show(regressionRun(), regressionView());
        expect(screen.queryByText(/not posted/i)).not.toBeInTheDocument();
    });

    it("warns when the check could not be posted, with the fix on demand", () => {
        const run = regressionRun({
            publication: {
                postsToPullRequest: true,
                check: {
                    status: "skipped",
                    reason: "status_permission_missing",
                },
                comment: { status: "published" },
            },
        } as Partial<RuntimeRun>);
        show(run, regressionView());
        expect(
            screen.getByText(
                /Check not posted: the GitHub token can't write commit statuses/,
            ),
        ).toBeInTheDocument();
        expect(screen.getByText("How to fix ›")).toBeInTheDocument();
    });

    it("names the PR by the title the Run recorded when Kodus has no review of it", () => {
        show(
            regressionRun({ prTitle: "fix(orders): coupon total" }),
            regressionView(),
        );
        expect(
            screen.getByText("fix(orders): coupon total"),
        ).toBeInTheDocument();
    });

    it("prefers the title of Kodus's own record of the PR over the Run's", () => {
        const run = regressionRun({
            prTitle: "the title when the Run started",
        });
        mockExecutions.items = [
            {
                prNumber: run.prNumber,
                title: "the title now",
                url: "https://example.test/pr/3",
                provider: "GITHUB",
            },
        ];
        show(run, regressionView());
        expect(screen.getByText("the title now")).toBeInTheDocument();
        expect(
            screen.queryByText("the title when the Run started"),
        ).not.toBeInTheDocument();
    });

    it("an older Run Kodus never reviewed shows only its repository and number", () => {
        const run = regressionRun();
        show(run, regressionView());
        const heading = screen.getByRole("heading", { level: 1 });
        expect(heading).toHaveTextContent(
            `${run.repositoryName} #${run.prNumber}`,
        );
        expect(heading.parentElement?.childElementCount).toBe(1);
    });
});
