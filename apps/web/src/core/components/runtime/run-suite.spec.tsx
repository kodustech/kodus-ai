/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import { usePermissionOnEvery } from "@services/permissions/hooks";
import { getRunSuiteArtifactUrl } from "@services/runtime/api";
import type { RuntimeRun, RuntimeSuiteRun } from "@services/runtime/contracts";
import { useRetryRunSuite } from "@services/runtime/queries";
import {
    fireEvent,
    render,
    screen,
    waitFor,
    within,
} from "@testing-library/react";

import { RunSuiteTab } from "./run-suite";

jest.mock("@services/permissions/hooks", () => ({
    usePermissionOnEvery: jest.fn(),
}));
jest.mock("@services/runtime/queries", () => ({ useRetryRunSuite: jest.fn() }));
jest.mock("@services/runtime/api", () => ({
    getRunSuiteArtifactUrl: jest.fn(),
}));
jest.mock("@components/ui/toaster/use-toast", () => ({ toast: jest.fn() }));

const MAIN = "a41c0d3".padEnd(40, "0");
const run = {
    runId: "run-1",
    repositoryId: "repo-1",
    state: "regression",
} as RuntimeRun;
const suite: RuntimeSuiteRun = {
    suiteRunId: "sr-1",
    environmentId: "env-1",
    mode: "run",
    state: "failed",
    requestedAt: "2026-11-24T10:00:00.000Z",
    finishedAt: "2026-11-24T10:06:12.000Z",
    durationMs: 372_000,
    mainSha: MAIN,
    baseDrift: 2,
    selection: {
        mode: "selected",
        selected: 9,
        total: 24,
        reachedBy: {
            "src/routes/cart.js": ["checkout.spec.ts", "cart.spec.ts"],
        },
    },
    specs: { ran: 9, total: 24 },
    totals: { passed: 6, failed: 3, skipped: 0, notRun: 0 },
    classes: { regression: 1, preExisting: 1, flaky: 1, unclassified: 0 },
    machine: { firstPassMs: 660_000, rerunMs: 180_000 },
    hosts: 2,
    shards: [
        {
            shard: 0,
            specs: 5,
            passed: 3,
            failed: 2,
            notRun: 0,
            specMs: 348_000,
        },
        {
            shard: 1,
            specs: 4,
            passed: 3,
            failed: 1,
            notRun: 0,
            specMs: 302_000,
        },
    ],
    specRows: [
        {
            spec: "e2e/cart.spec.ts",
            shard: 0,
            result: "passed",
            durationMs: 40_000,
            tests: [
                {
                    title: "adds an item",
                    status: "passed",
                    attempts: ["passed"],
                },
            ],
            artifacts: [],
        },
        {
            spec: "e2e/checkout.spec.ts",
            shard: 0,
            result: "failed",
            group: "regression",
            durationMs: 90_000,
            tests: [
                {
                    title: "applies a discount code",
                    status: "failed",
                    attempts: ["failed", "failed"],
                },
            ],
            artifacts: ["trace.zip"],
        },
        {
            spec: "e2e/order.spec.ts",
            shard: 1,
            result: "flaky",
            durationMs: 70_000,
            tests: [
                {
                    title: "shows the confirmation",
                    status: "passed",
                    attempts: ["failed", "passed"],
                },
            ],
            artifacts: [],
        },
        {
            spec: "e2e/search.spec.ts",
            shard: 1,
            result: "passed",
            durationMs: 120_000,
            tests: [
                {
                    title: "finds a product",
                    status: "passed",
                    attempts: ["passed"],
                },
            ],
            artifacts: [],
        },
    ],
    hostTimes: [
        {
            shard: 0,
            role: "shard",
            requestedAt: "2026-11-24T10:01:00.000Z",
            readyAt: "2026-11-24T10:01:20.000Z",
            startedAt: "2026-11-24T10:02:00.000Z",
            finishedAt: "2026-11-24T10:05:30.000Z",
        },
        {
            shard: 1,
            role: "shard",
            requestedAt: "2026-11-24T10:01:00.000Z",
            readyAt: "2026-11-24T10:01:25.000Z",
            startedAt: "2026-11-24T10:02:05.000Z",
            finishedAt: "2026-11-24T10:06:00.000Z",
        },
    ],
    failures: [
        {
            spec: "e2e/checkout.spec.ts",
            title: "applies a discount code",
            group: "regression",
            detail: "regression",
            error: "expect(received).toBe(expected) total 100.00, expected 90.00",
            pr: { attempts: 2, failed: 2 },
            main: { sha: MAIN, outcome: "passed", sameError: false },
            reachedBy: ["src/routes/cart.js"],
            artifacts: [
                {
                    name: "trace.zip",
                    contentType: "application/zip",
                    bytes: 10,
                },
                { name: "shot.png", contentType: "image/png", bytes: 10 },
            ],
        },
        {
            spec: "e2e/catalog.spec.ts",
            title: "lists products by price",
            group: "pre_existing",
            detail: "pre_existing",
            pr: { attempts: 2, failed: 2 },
            main: { sha: MAIN, outcome: "failed", sameError: true },
            reachedBy: [],
            artifacts: [],
        },
        {
            spec: "e2e/order.spec.ts",
            title: "shows the order confirmation",
            group: "flaky",
            detail: "flaky",
            pr: { attempts: 2, failed: 1 },
            reachedBy: [],
            artifacts: [],
        },
    ],
    passed: ["cart.spec.ts", "search.spec.ts"],
    canRetry: true,
};

const mutate = jest.fn();
beforeEach(() => {
    mutate.mockReset();
    (usePermissionOnEvery as jest.Mock).mockReturnValue(true);
    (useRetryRunSuite as jest.Mock).mockReturnValue({
        mutate,
        isPending: false,
    });
    (getRunSuiteArtifactUrl as jest.Mock).mockReset();
});

describe("the e2e suite tab of a Run", () => {
    it("opens with the verdict sentence, from the run's fields", () => {
        render(<RunSuiteTab run={run} suite={suite} />);
        const verdict = screen.getByRole("region", { name: "Verdict" });
        expect(
            within(verdict).getByText("1 regression, the check failed"),
        ).toBeInTheDocument();
        expect(verdict).toHaveTextContent(
            "checkout.spec.ts › applies a discount code passes on main and fails on this PR, twice.",
        );
        expect(verdict).toHaveTextContent("neither blocks");
    });

    it("shows the four key facts with their hints", () => {
        render(<RunSuiteTab run={run} suite={suite} />);
        const facts = screen.getByRole("region", { name: "Key facts" });
        for (const text of [
            "Specs run",
            "9 of 24",
            "Selected by coverage of the diff",
            "Duration",
            "6 min 12 s",
            "2 hosts, one shard each",
            "Compared against",
            "main a41c0d3",
            "Merge base, 2 commits behind main",
            "Machine time",
            "14 min",
            "First pass 11 · re-runs 3",
        ])
            expect(within(facts).getByText(text)).toBeInTheDocument();
    });

    it("groups the failed tests as accordions: the regression open with its error, attempts, main and the file that reaches it", () => {
        render(<RunSuiteTab run={run} suite={suite} />);
        const list = screen.getByRole("region", { name: "Failed tests" });
        const items = within(list).getAllByRole("group");
        expect(items.map((d) => (d as HTMLDetailsElement).open)).toEqual([
            true,
            false,
            false,
        ]);
        const regression = items[0];
        expect(within(regression).getByText("Regression")).toBeInTheDocument();
        expect(
            within(regression).getByText("applies a discount code"),
        ).toBeInTheDocument();
        expect(
            within(regression).getByText("e2e/checkout.spec.ts"),
        ).toBeInTheDocument();
        expect(regression).toHaveTextContent(
            "expect(received).toBe(expected) total 100.00, expected 90.00",
        );
        expect(regression).toHaveTextContent("This PR · failed 2 of 2");
        expect(regression).toHaveTextContent("main a41c0d3 · passed");
        expect(regression).toHaveTextContent("Reached by · src/routes/cart.js");
        expect(
            within(items[1]).getByText("Already failing on main"),
        ).toBeInTheDocument();
        expect(items[1]).toHaveTextContent(
            "main a41c0d3 · failed, the same error",
        );
        expect(within(items[2]).getByText("Flaky")).toBeInTheDocument();
    });

    it("opens a kept file through the API's short URL, never a key", async () => {
        (getRunSuiteArtifactUrl as jest.Mock).mockResolvedValue({
            url: "https://evidence.example.test/x?sig=1",
        });
        window.open = jest.fn();
        render(<RunSuiteTab run={run} suite={suite} />);
        fireEvent.click(screen.getByRole("button", { name: "Trace" }));
        await waitFor(() =>
            expect(getRunSuiteArtifactUrl).toHaveBeenCalledWith({
                runId: "run-1",
                spec: "e2e/checkout.spec.ts",
                name: "trace.zip",
            }),
        );
        expect(
            screen.getByRole("button", { name: "Screenshot" }),
        ).toBeInTheDocument();
    });

    it("keeps why these specs closed, with the file to specs map inside", () => {
        render(<RunSuiteTab run={run} suite={suite} />);
        const why = screen
            .getByRole("heading", { name: "Why these 9 specs" })
            .closest("details")!;
        expect(why).not.toHaveAttribute("open");
        expect(why).toHaveTextContent(
            "src/routes/cart.js → checkout.spec.ts, cart.spec.ts",
        );
    });

    it("lists every spec, failures first, and opens one for its tests and its kept files", () => {
        render(<RunSuiteTab run={run} suite={suite} />);
        const table = within(screen.getByRole("region", { name: "Specs" }));
        const specs = table
            .getAllByRole("row")
            .slice(1)
            .map((r) => r.querySelector("td")?.textContent);
        expect(specs).toEqual([
            "e2e/checkout.spec.ts",
            "e2e/order.spec.ts",
            "e2e/search.spec.ts",
            "e2e/cart.spec.ts",
        ]);
        expect(table.getByText("Regression")).toBeInTheDocument();
        expect(table.getByText("Flaky")).toBeInTheDocument();
        fireEvent.click(table.getByText("e2e/order.spec.ts"));
        expect(table.getByText("shows the confirmation")).toBeInTheDocument();
        expect(table.getByText("2 tries")).toBeInTheDocument();
    });

    it("filters the specs by result and by a test's title", () => {
        render(<RunSuiteTab run={run} suite={suite} />);
        const region = within(screen.getByRole("region", { name: "Specs" }));
        fireEvent.click(region.getByRole("button", { name: "Passed 2" }));
        expect(
            region
                .getAllByRole("row")
                .slice(1)
                .map((r) => r.querySelector("td")?.textContent),
        ).toEqual(["e2e/search.spec.ts", "e2e/cart.spec.ts"]);
        fireEvent.click(region.getByRole("button", { name: "All 4" }));
        fireEvent.change(
            region.getByRole("searchbox", { name: "Search a spec or a test" }),
            { target: { value: "discount" } },
        );
        expect(
            region
                .getAllByRole("row")
                .slice(1)
                .map((r) => r.querySelector("td")?.textContent),
        ).toEqual(["e2e/checkout.spec.ts"]);
    });

    it("says where the run's time went, and each host's boot, app and specs", () => {
        render(<RunSuiteTab run={run} suite={suite} />);
        const time = screen.getByRole("region", {
            name: "Where the time went",
        });
        expect(within(time).getByRole("heading")).toHaveTextContent(
            "Where the 6 min 12 s went",
        );
        expect(time).toHaveTextContent(
            "Host 1 · 5 specs · boot 20 s · app up 40 s · specs 3 min 30 s",
        );
        expect(time).toHaveTextContent("Running the specs");
    });

    it("offers Re-run failed to who may run the Run again, and asks the API for it once", () => {
        render(<RunSuiteTab run={run} suite={suite} />);
        fireEvent.click(screen.getByRole("button", { name: "Re-run failed" }));
        expect(mutate).toHaveBeenCalledWith("run-1", expect.anything());
    });

    it("hides Re-run failed from who may not, while the suite runs, and when nothing is left to run", () => {
        (usePermissionOnEvery as jest.Mock).mockReturnValue(false);
        const { rerender } = render(<RunSuiteTab run={run} suite={suite} />);
        expect(
            screen.queryByRole("button", { name: "Re-run failed" }),
        ).not.toBeInTheDocument();
        (usePermissionOnEvery as jest.Mock).mockReturnValue(true);
        rerender(
            <RunSuiteTab run={run} suite={{ ...suite, canRetry: false }} />,
        );
        expect(
            screen.queryByRole("button", { name: "Re-run failed" }),
        ).not.toBeInTheDocument();
    });

    it("a green suite has no failed tests section and says so in the banner", () => {
        render(
            <RunSuiteTab
                run={run}
                suite={{
                    ...suite,
                    state: "passed",
                    failures: [],
                    classes: {
                        regression: 0,
                        preExisting: 0,
                        flaky: 0,
                        unclassified: 0,
                    },
                    canRetry: false,
                    totals: { passed: 9, failed: 0, skipped: 0, notRun: 0 },
                }}
            />,
        );
        expect(
            screen.getByText("No regressions, 9 specs passed"),
        ).toBeInTheDocument();
        expect(
            screen.queryByRole("region", { name: "Failed tests" }),
        ).not.toBeInTheDocument();
    });
});
