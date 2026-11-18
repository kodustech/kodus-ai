/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import type { ReactNode } from "react";
import type { RuntimeRun } from "@services/runtime/contracts";
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

const mockState: { run?: RuntimeRun; view?: RunStreamView } = {};
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
jest.mock("next/navigation", () => ({
    useRouter: () => ({ push: jest.fn() }),
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
    });

    it("keeps the header to who, what started it, when and the two commits", () => {
        show(regressionRun(), regressionView());
        const meta = screen.getByText(/^Requested/).closest("p")!;
        expect(meta).toHaveTextContent(/this PR 5d49b8a vs main ee53311$/);
        expect(within(meta).queryByRole("link")).toBeNull();
        expect(meta).not.toHaveTextContent(/Recipe|Environment|Kodus cloud/);
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

    it("puts the deep data in closed sections whose summary still informs", () => {
        show(regressionRun(), regressionView());
        const timing = section("Why it took 9 min 51 s");
        expect(timing.open).toBe(false);
        expect(timing.querySelector("summary")).toHaveTextContent(
            /^Why it took 9 min 51 sMost of it was building this PR \(7 min 51 s\)/,
        );
        const running = section("What was running");
        expect(running.open).toBe(false);
        expect(running.querySelector("summary")).toHaveTextContent(
            "On Kodus cloud · the environment's setup file",
        );
        expect(
            within(running).getByRole("link", { name: "Open the environment" }),
        ).toHaveAttribute("href", "/runtime/environments/env-1");
        expect(section("Run log").open).toBe(false);
        const cost = section("Cost");
        expect(cost.open).toBe(false);
        expect(cost.querySelector("summary")).toHaveTextContent("$0.14");
        // Findings and what Kody tested stay in view.
        expect(
            screen.getByRole("region", { name: "Findings" }),
        ).toBeInTheDocument();
        expect(
            screen.getByRole("region", { name: "What Kody tested" }),
        ).toBeInTheDocument();
    });

    it("a real regression's one action opens its finding", () => {
        show(regressionRun(), regressionView());
        const open = screen.getByRole("link", { name: "Open the finding" });
        expect(open).toHaveAttribute("href", "#finding-orders-coupon");
        expect(document.getElementById("finding-orders-coupon")).toBeTruthy();
    });

    it("keeps the timing and the log open while the Run is live", () => {
        const run = regressionRun({
            state: "testing",
            finishedAt: undefined,
        });
        const view = partlyTestedView();
        show(run, {
            ...view,
            states: view.states.slice(0, 3),
            verdict: undefined,
            published: [],
        });
        expect(section(/^Time so far: /).open).toBe(true);
        expect(section("Run log").open).toBe(true);
    });

    it("a boot that failed on Kodus's side offers Run again once, and never sends the reader to fix their environment", () => {
        show(
            bootFailureRun({
                state: "could_not_boot",
                reason: "platform:repo_fetch",
                probes: [],
                uncoveredEntryPoints: [],
                uncovered: [],
                bootFailure: {
                    ...sumdbBootFailure(),
                    signature: "repo_fetch",
                    title: "Kodus failed while downloading the repository",
                },
            }),
            partlyTestedView(),
        );
        expect(
            screen.getByRole("heading", {
                name: "Kodus could not start this Run",
            }),
        ).toBeInTheDocument();
        expect(
            screen.getAllByRole("button", { name: "Run again" }),
        ).toHaveLength(1);
        expect(
            screen.getByRole("region", { name: "What failed on Kodus's side" }),
        ).toBeInTheDocument();
        // The only environment links left are inside "What was running".
        const running = section("What was running");
        for (const link of screen.queryAllByRole("link", {
            name: /environment|setup file/i,
        }))
            expect(running).toContainElement(link);
    });

    it("new behavior that matches what the PR expected makes 'This change is intended' the card's action", () => {
        show(newRouteRun(), newRouteView());
        const marks = screen.getAllByRole("button", {
            name: "This change is intended",
        });
        // The card's (primary) and the finding's own (amber on deep, not a second lamp).
        expect(marks[0].className).toContain("var(--color-primary-light)");
        expect(marks[1].className).toContain(
            "[--button-background:var(--color-primary-dark)]",
        );
        fireEvent.click(marks[0]);
        expect(mockIntent).toHaveBeenCalledWith(
            {
                runId: "run-new-route",
                probeId: "orders-export",
                intended: true,
            },
            expect.anything(),
        );
    });
});
