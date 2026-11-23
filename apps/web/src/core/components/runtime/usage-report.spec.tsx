/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import { usePermission } from "@services/permissions/hooks";
import { getRuntimeUsageCsv } from "@services/runtime/api";
import type { RuntimeUsageReport } from "@services/runtime/contracts";
import {
    useRuntimeEnvironments,
    useRuntimeSettings,
    useRuntimeUsageReport,
} from "@services/runtime/queries";
import {
    fireEvent,
    render,
    screen,
    waitFor,
    within,
} from "@testing-library/react";

import { RuntimeUsageContent } from "./usage-report";

jest.mock("next/navigation", () => ({
    usePathname: () => "/token-usage",
}));
jest.mock("@services/permissions/hooks", () => ({ usePermission: jest.fn() }));
jest.mock("@services/runtime/queries", () => ({
    useRuntimeUsageReport: jest.fn(),
    useRuntimeSettings: jest.fn(),
    useRuntimeEnvironments: jest.fn(),
}));
jest.mock("@services/runtime/api", () => ({ getRuntimeUsageCsv: jest.fn() }));
jest.mock("@components/ui/toaster/use-toast", () => ({ toast: jest.fn() }));

const machine = {
    claims: 2,
    gbMinutes: 40,
    vcpuMinutes: null,
    buildMinutes: 2,
    unmeasured: { memory: 0, cpu: 2 },
    hostUsd: 0.01,
    hostUnpriced: 0,
    unitUsd: null,
};
const report: RuntimeUsageReport = {
    organizationId: "org-a",
    month: "2026-11",
    from: "2026-11-01T00:00:00.000Z",
    to: "2026-12-01T00:00:00.000Z",
    filters: {},
    generatedAt: "2026-11-20T12:00:00.000Z",
    counts: {
        runs: 1,
        runsListed: 1,
        prs: 1,
        setups: 0,
        sandboxSessions: 0,
        sandboxOperations: {
            total: 0,
            refused: 0,
            failed: 0,
            durationMs: 0,
            partial: false,
        },
        claimsTruncated: false,
    },
    wallTime: {
        runs: { count: 1, p50Minutes: 12, p95Minutes: 12, totalMinutes: 12 },
        setups: {
            count: 0,
            p50Minutes: null,
            p95Minutes: null,
            totalMinutes: 0,
        },
        sandboxSessions: {
            count: 0,
            p50Minutes: null,
            p95Minutes: null,
            totalMinutes: 0,
        },
    },
    machine: {
        total: machine,
        byConsumer: [{ consumer: "runtime", side: "pr", ...machine }],
        unitPrices: null,
    },
    llm: { source: "not_measured", total: null, byAgent: [] },
    cost: {
        perRun: {
            runs: 1,
            completeRuns: 0,
            pricedUsd: 0.01,
            unpricedParts: { machines: 0, llm: 1, total: 1 },
            perCompleteRun: null,
        },
        kodusUsd: 0.01,
        complete: false,
    },
    pricing: {
        hosts: [],
        ownHostUsdPerHour: null,
        effectiveUsdPerGbHour: null,
        llmModels: [],
    },
    runs: [
        {
            runId: "run-1",
            repositoryId: "repo-1",
            repositoryName: "acme/shop",
            environmentId: "env-1",
            prNumber: 7,
            trigger: "comment",
            state: "regression",
            verdict: "final",
            requestedAt: "2026-11-03T10:00:00.000Z",
            finishedAt: "2026-11-03T10:12:00.000Z",
            wallMinutes: 12,
            start: "pool",
            bootMs: 120_000,
            phaseMs: { boot: 90_000, apply: 30_000 },
            bootPhases: {},
            capacityWaitMs: null,
            machine: {
                claims: 2,
                gbMinutes: 40,
                vcpuMinutes: null,
                buildMinutes: 2,
                unmeasured: { memory: 0, cpu: 2 },
                unitUsd: null,
                usd: 0.01,
                paidBy: "kodus",
            },
            llm: {
                tokens: 0,
                usd: null,
                customerUsd: 0,
                source: "not_measured",
            },
            totalUsd: 0.01,
            complete: false,
        },
    ],
};

beforeEach(() => {
    (useRuntimeSettings as jest.Mock).mockReturnValue({
        data: {
            repositories: [
                { repositoryId: "repo-1", repositoryName: "acme/shop" },
            ],
        },
    });
    (useRuntimeEnvironments as jest.Mock).mockReturnValue({ data: [] });
    (useRuntimeUsageReport as jest.Mock).mockReturnValue({
        data: report,
        isLoading: false,
        isError: false,
    });
    (getRuntimeUsageCsv as jest.Mock).mockReset().mockResolvedValue({
        filename: "kody-runtime-usage-2026-11.csv",
        text: "run_id\r\n",
    });
});

describe("the Runtime usage content", () => {
    it("shows the owner the summary first, then each Run, and 'Not measured' where nothing was read", () => {
        (usePermission as jest.Mock).mockReturnValue(true);
        render(<RuntimeUsageContent />);

        const sections = screen
            .getAllByRole("region")
            .map((s) => s.getAttribute("aria-label"));
        expect(sections).toEqual([
            "Cost of a Run",
            "How Runs are priced",
            "What would a month cost?",
            "This month",
            "LLM by agent",
            "Machine time",
            "Runs",
        ]);
        const runs = screen.getByRole("region", { name: "Runs" });
        expect(within(runs).getByText("acme/shop #7")).toBeInTheDocument();
        expect(within(runs).getByText("@kody runtime")).toBeInTheDocument();
        expect(within(runs).getByText("Ready pool")).toBeInTheDocument();
        expect(
            within(
                screen.getByRole("region", { name: "This month" }),
            ).getByText("LLM").nextSibling,
        ).toHaveTextContent("Not measured");
    });

    it("exports the month's CSV with the chosen filters", async () => {
        (usePermission as jest.Mock).mockReturnValue(true);
        const createObjectURL = jest.fn(() => "blob:usage");
        Object.assign(URL, { createObjectURL, revokeObjectURL: jest.fn() });
        const saved = jest
            .spyOn(HTMLAnchorElement.prototype, "click")
            .mockImplementation(() => undefined);
        render(<RuntimeUsageContent />);

        fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));

        await waitFor(() => expect(saved).toHaveBeenCalled());
        saved.mockRestore();
        expect(getRuntimeUsageCsv).toHaveBeenCalledWith({
            month: expect.stringMatching(/^\d{4}-\d{2}$/),
        });
    });

    it("asks anyone but the owner to ask the owner, and never fetches the report for them", () => {
        (usePermission as jest.Mock).mockReturnValue(false);
        render(<RuntimeUsageContent />);
        expect(
            screen.getByText("Usage is for the organization's owner"),
        ).toBeInTheDocument();
        expect(
            screen.queryByRole("button", { name: "Export CSV" }),
        ).not.toBeInTheDocument();
        expect(
            (useRuntimeUsageReport as jest.Mock).mock.calls.at(-1)?.[1],
        ).toBe(false);
    });
});
