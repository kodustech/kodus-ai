/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import { usePermission } from "@services/permissions/hooks";
import type { RuntimeHealth, RuntimeSpeed } from "@services/runtime/contracts";
import { useRuntimeHealth, useRuntimeSpeed } from "@services/runtime/queries";
import { fireEvent, render, screen, within } from "@testing-library/react";

import { RuntimeHealthPage } from "./_page-component";

jest.mock("next/navigation", () => ({
    usePathname: () => "/runtime/settings/health",
}));
jest.mock("@services/permissions/hooks", () => ({ usePermission: jest.fn() }));
jest.mock("@services/runtime/queries", () => ({
    useRuntimeHealth: jest.fn(),
    useRuntimeSpeed: jest.fn(),
}));

const stat = (n: number, p50Ms: number | null, p95Ms = p50Ms) => ({
    n,
    tooFew: p50Ms === null,
    p50Ms,
    p95Ms,
});
const few = {
    verdict: stat(0, null),
    ready: stat(0, null),
    queue: stat(0, null),
};
const speed: RuntimeSpeed = {
    windowDays: 7,
    since: "2026-11-05T12:00:00.000Z",
    until: "2026-11-12T12:00:00.000Z",
    minRuns: 20,
    considered: 50,
    counted: 45,
    excluded: {
        cancelledOrSuperseded: 3,
        skipped: 1,
        unfinished: 1,
        noVerdict: 0,
    },
    missing: { verdict: 0, ready: 2, queue: 0 },
    truncated: false,
    all: {
        verdict: stat(45, 252_000, 600_000),
        ready: stat(43, 41_000, 95_000),
        queue: stat(45, 800, 2_000),
    },
    bySource: {
        warm_pool: {
            verdict: stat(25, 200_000),
            ready: stat(25, 9_000),
            queue: stat(25, 500),
        },
        cold_boot: {
            verdict: stat(20, 300_000),
            ready: stat(20, 71_500),
            queue: stat(20, 900),
        },
        baked: few,
        unknown: few,
    },
    byHost: {
        kodus_cloud: {
            verdict: stat(45, 252_000),
            ready: stat(43, 41_000),
            queue: stat(45, 800),
        },
        own_host: {
            verdict: stat(3, null),
            ready: stat(3, null),
            queue: stat(3, null),
        },
        unknown: few,
    },
    byEnvironment: [],
};

const health: RuntimeHealth = {
    organizationId: "org-a",
    at: "2026-11-12T12:00:00.000Z",
    summary: {
        setups: { measured: true, active: 2, blocked: 1, settingUp: 0 },
        runs: {
            measured: true,
            days: 7,
            total: 4,
            byVerdict: { no_regressions: 3, regression: 1 },
        },
        boot: {
            measured: true,
            thisWeek: { count: 4, p50Ms: 60_000, p95Ms: 120_000 },
            lastWeek: { count: 0, p50Ms: null, p95Ms: null },
            trend: "no_data",
        },
    },
    stuck: {
        measured: true,
        items: [
            {
                subject: "run",
                state: "booting",
                since: "2026-11-12T10:00:00.000Z",
                ageMs: 50 * 60_000,
                boundMs: 45 * 60_000,
                runId: "run-9",
                link: { kind: "run", runId: "run-9" },
            },
        ],
        notChecked: ["admission requests", "DBOS workflows"],
    },
    errors: {
        measured: true,
        days: 7,
        bySignature: [
            {
                signature: "missing_env:DATABASE_URL",
                kind: "missing_env",
                title: "DATABASE_URL is not set",
                count: 3,
                lastAt: "2026-11-12T11:00:00.000Z",
                environmentId: "env-b",
            },
        ],
    },
    cells: {
        measured: false,
        reason: "The Runtime database is not readable from here.",
    },
    cost: {
        today: {
            measured: true,
            llmUsd: 0.4,
            machineUsd: null,
            totalUsd: null,
            complete: false,
            gbMinutes: 12,
            vcpuMinutes: null,
        },
        usagePath: "/runtime/settings/usage",
    },
};

const asOwner = (
    data: RuntimeHealth | undefined,
    more: Record<string, unknown> = {},
) => {
    (usePermission as jest.Mock).mockReturnValue(true);
    (useRuntimeSpeed as jest.Mock).mockReturnValue({
        data: speed,
        isLoading: false,
        isError: false,
    });
    (useRuntimeHealth as jest.Mock).mockReturnValue({
        data,
        isLoading: false,
        isError: false,
        refetch: jest.fn(),
        ...more,
    });
};

describe("the Runtime Health screen", () => {
    it("shows the summary, the stuck Run with a link to its page, and errors linked to their card", () => {
        asOwner(health);
        render(<RuntimeHealthPage />);
        expect(
            screen.getByText("Environments ready").parentElement,
        ).toHaveTextContent("2");
        const stuck = screen.getByRole("region", { name: "Stuck" });
        expect(
            within(stuck).getByText(
                /Run starting its machines for 50 min 00 s; it should take at most 45 min 00 s/,
            ),
        ).toBeInTheDocument();
        expect(
            within(stuck).getByRole("link", { name: "Open" }),
        ).toHaveAttribute("href", "/runtime/runs/run-9");
        expect(
            within(stuck).getByText(
                /Not checked on this screen: admission requests and DBOS workflows/,
            ),
        ).toBeInTheDocument();
        const errors = screen.getByRole("region", {
            name: "What stopped setups and Runs",
        });
        expect(
            within(errors).getByRole("link", { name: "See the fix" }),
        ).toHaveAttribute("href", "/runtime/environments/env-b");
    });

    it("says Not measured with the reason where a source is missing, and never prints a zero for it", () => {
        asOwner(health);
        render(<RuntimeHealthPage />);
        const cells = screen.getByRole("region", { name: "Your hosts" });
        expect(cells).toHaveTextContent(
            "Not measured: The Runtime database is not readable from here.",
        );
        expect(screen.getByText("Cost today").parentElement).toHaveTextContent(
            "Not measured",
        );
        expect(screen.getByText("Cost today").parentElement).toHaveTextContent(
            "12 GB·min of machines, not priced",
        );
    });

    it("shows the Speed card: one sentence, p50/p95 per number with n, warm vs cold, too few Runs, and a 30-day window", () => {
        render(<RuntimeHealthPage />);
        const card = screen
            .getByRole("heading", { name: "Speed" })
            .closest("section")!;
        expect(card).toHaveTextContent(
            "Half the Runs reach a verdict within 4 min 12 s; warm-pool Runs are ready 1 min 3 s faster than cold boots.",
        );
        expect(
            within(card).getByText("Request to verdict, p50").parentElement,
        ).toHaveTextContent("4 min 12 s");
        expect(
            within(card).getByText("Request to verdict, p50").parentElement,
        ).toHaveTextContent("p95 10 min 0 s · 45 Runs");
        expect(
            within(card).getByText("Your own host").closest("tr"),
        ).toHaveTextContent("too few Runs");
        expect(card).toHaveTextContent(
            "45 of 50 Runs reached a verdict and are counted. Left out: 5 (3 cancelled or superseded",
        );
        fireEvent.click(within(card).getByRole("button", { name: "30 days" }));
        expect(useRuntimeSpeed).toHaveBeenLastCalledWith(30);
    });

    it("is the owner's screen: anyone else is told whom to ask, and nothing is read", () => {
        (usePermission as jest.Mock).mockReturnValue(false);
        (useRuntimeSpeed as jest.Mock).mockClear();
        (useRuntimeHealth as jest.Mock).mockReturnValue({
            data: undefined,
            isLoading: false,
            isError: false,
        });
        render(<RuntimeHealthPage />);
        expect(
            screen.getByText("Health is for the organization's owner"),
        ).toBeInTheDocument();
        expect(useRuntimeHealth).toHaveBeenCalledWith(false);
        expect(useRuntimeSpeed).not.toHaveBeenCalled();
    });
});
