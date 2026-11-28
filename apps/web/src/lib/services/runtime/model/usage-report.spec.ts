import type { RuntimeUsageReport } from "../contracts";
import {
    consumerLabel,
    NOT_MEASURED,
    startLabel,
    usageCaveats,
    usageMonthOptions,
    usageSummaryTiles,
} from "./usage-report";

const machine = (patch = {}) => ({
    claims: 4,
    gbMinutes: 1_234,
    vcpuMinutes: 480,
    buildMinutes: 12,
    unmeasured: { memory: 0, cpu: 0 },
    hostUsd: 0.4,
    hostUnpriced: 0,
    unitUsd: null,
    ...patch,
});

const llm = (patch = {}) => ({
    inputTokens: 1_000_000,
    outputTokens: 20_000,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 1_020_000,
    aboveBaseTierTokens: 0,
    pricedUsd: 3.2,
    usd: 3.2,
    kodusUsd: 3.2,
    customerUsd: 0,
    unpricedTokens: 0,
    ...patch,
});

const report = (
    patch: Partial<RuntimeUsageReport> = {},
): RuntimeUsageReport => ({
    organizationId: "org-a",
    month: "2026-11",
    from: "2026-11-01T00:00:00.000Z",
    to: "2026-12-01T00:00:00.000Z",
    filters: {},
    generatedAt: "2026-11-20T12:00:00.000Z",
    counts: {
        runs: 12,
        runsListed: 12,
        prs: 8,
        setups: 3,
        sandboxSessions: 2,
        sandboxOperations: {
            total: 40,
            refused: 2,
            failed: 1,
            durationMs: 60_000,
            partial: false,
        },
        claimsTruncated: false,
    },
    wallTime: {
        runs: { count: 12, p50Minutes: 9, p95Minutes: 31, totalMinutes: 140 },
        setups: { count: 3, p50Minutes: 6, p95Minutes: 8, totalMinutes: 20 },
        sandboxSessions: {
            count: 2,
            p50Minutes: 4,
            p95Minutes: 5,
            totalMinutes: 9,
        },
    },
    machine: { total: machine(), byConsumer: [], unitPrices: null },
    llm: { source: "telemetry", total: llm(), byAgent: [] },
    cost: {
        perRun: {
            runs: 12,
            completeRuns: 10,
            pricedUsd: 4,
            unpricedParts: { machines: 2, llm: 0, total: 2 },
            perCompleteRun: {
                medianUsd: 0.31,
                maxUsd: 0.9,
                medianMachinesUsd: 0.07,
                medianLlmManagedUsd: 0.2,
                medianLlmByokUsd: 0.04,
            },
        },
        kodusUsd: 3.6,
        complete: false,
    },
    pricing: {
        hosts: [],
        ownHostUsdPerHour: null,
        effectiveUsdPerGbHour: null,
        llmModels: [],
    },
    runs: [],
    ...patch,
});

const tile = (r: RuntimeUsageReport, label: string) =>
    usageSummaryTiles(r).find((t) => t.label === label)!;

describe("the Usage screen's summary", () => {
    it("counts preview starts with their machine time and opens, once a preview started this month", () => {
        expect(usageSummaryTiles(report()).some((t) => t.label === "Previews")).toBe(false);
        const withPreviews = { ...report(), previews: { starts: 3, heldMinutes: 41.6, sessions: 5 } };
        expect(usageSummaryTiles(withPreviews).find((t) => t.label === "Previews")).toEqual({ label: "Previews", value: "3", hint: "42 machine-min · 5 opens" });
    });

    it("shows what ran, how long, on what and what it cost, in that order", () => {
        expect(
            usageSummaryTiles(report()).map((t) => [t.label, t.value]),
        ).toEqual([
            ["Runs", "12"],
            ["Setups", "3"],
            ["Sandbox sessions", "2"],
            ["Sandbox operations", "40"],
            ["Run time", "9 min · 31 min"],
            ["Memory", "1,234 GB·min"],
            ["vCPU", "480 vCPU·min"],
            ["Build time", "12 min"],
            ["LLM", "$3.20"],
            ["Cost per Run", "$0.31"],
            ["Machine cost at your unit price", "No price set"],
        ]);
    });

    it('says "Not measured" where a source is missing, never a zero', () => {
        const r = report({
            machine: {
                total: machine({
                    gbMinutes: null,
                    vcpuMinutes: null,
                    unmeasured: { memory: 4, cpu: 4 },
                }),
                byConsumer: [],
                unitPrices: null,
            },
            llm: { source: "not_measured", total: null, byAgent: [] },
            cost: {
                ...report().cost,
                perRun: {
                    ...report().cost.perRun,
                    completeRuns: 0,
                    perCompleteRun: null,
                },
            },
        });
        expect(tile(r, "Memory")).toMatchObject({
            value: NOT_MEASURED,
            hint: "4 machines did not report memory",
        });
        expect(tile(r, "vCPU").value).toBe(NOT_MEASURED);
        expect(tile(r, "LLM").value).toBe(NOT_MEASURED);
        expect(tile(r, "Cost per Run").value).toBe(NOT_MEASURED);
        expect(usageCaveats(r)).toContain(
            "LLM usage is not readable on this deployment.",
        );
    });

    it("says why some machines are not priced, and where the org prices its own hosts", () => {
        const r = report({
            machine: { ...report().machine, total: machine({ hostUnpriced: 2 }) },
        });
        expect(usageCaveats(r)).toContain(
            "2 machines could not be priced (your own host with no price per host-hour in Runtime settings, or a Kodus host without a list price).",
        );
    });

    it("marks an LLM total with unpriced tokens as a lower bound, and what the org's own keys paid", () => {
        const r = report({
            llm: {
                source: "telemetry",
                total: llm({
                    usd: null,
                    pricedUsd: 2.5,
                    customerUsd: 1,
                    unpricedTokens: 5_000,
                }),
                byAgent: [],
            },
        });
        expect(tile(r, "LLM").value).toBe("≥ $2.50");
        expect(tile(r, "LLM").hint).toBe(
            "1.02M tokens · $1.00 on your own keys · 5K without a price",
        );
    });

    it("has no sandbox figure under a repository filter", () => {
        const r = report({
            counts: {
                ...report().counts,
                sandboxSessions: null,
                sandboxOperations: null,
            },
        });
        expect(tile(r, "Sandbox sessions")).toMatchObject({
            value: "n/a",
            hint: "Not tied to a repository",
        });
        expect(tile(r, "Sandbox operations").value).toBe("n/a");
    });

    it("counts sandbox operations with what was refused, and says when the audit no longer covers the month", () => {
        expect(tile(report(), "Sandbox operations")).toEqual({
            label: "Sandbox operations",
            value: "40",
            hint: "2 refused, 1 failed",
        });
        const old = report({
            counts: {
                ...report().counts,
                sandboxOperations: {
                    ...report().counts.sandboxOperations!,
                    partial: true,
                },
            },
        });
        expect(tile(old, "Sandbox operations").value).toBe("40+");
        expect(usageCaveats(old)).toContain(
            "The sandbox audit keeps 30 days: this month's sandbox operations are a lower bound.",
        );
        const unreadable = report({
            counts: { ...report().counts, sandboxOperations: null },
        });
        expect(tile(unreadable, "Sandbox operations").value).toBe(
            NOT_MEASURED,
        );
    });

    it("says where each Run's machines came from, and counts the Runs whose cell did not say", () => {
        expect(startLabel("pool")).toBe("Ready pool");
        expect(startLabel("bake")).toBe("Bake");
        expect(startLabel("cold")).toBe("Cold build");
        expect(startLabel(null)).toBe(NOT_MEASURED);
        const run = (start: "cold" | null) =>
            ({ runId: `r-${start}`, start }) as RuntimeUsageReport["runs"][number];
        expect(usageCaveats(report({ runs: [run("cold"), run(null)] }))).toContain(
            "1 Run did not say whether its machines started cold, from the pool or from a bake (a host on an older release).",
        );
        expect(
            usageCaveats(report({ runs: [run("cold")] })).join(" "),
        ).not.toMatch(/did not say/);
    });

    it("prices machine time only with a unit price set", () => {
        const r = report({
            machine: {
                total: machine({ unitUsd: 1.5 }),
                byConsumer: [],
                unitPrices: { usdPerGbMinute: 0.001, usdPerVcpuMinute: 0.0005 },
            },
        });
        expect(tile(r, "Machine cost at your unit price")).toMatchObject({
            value: "$1.50",
            hint: "$0.001/GB·min, $0.0005/vCPU·min",
        });
    });
});

describe("months and labels", () => {
    it("offers the current UTC month and the eleven before it", () => {
        const months = usageMonthOptions(new Date("2026-01-15T00:00:00Z"));
        expect(months).toHaveLength(12);
        expect(months[0]).toEqual({ value: "2026-01", label: "January 2026" });
        expect(months[1]).toEqual({ value: "2025-12", label: "December 2025" });
    });

    it("names each consumer from the user's side", () => {
        expect(consumerLabel("runtime", "base")).toBe("Runs · main");
        expect(consumerLabel("runtime", "pr")).toBe("Runs · pull request");
        expect(consumerLabel("sandbox", "pr")).toBe("Sandbox sessions");
    });
});
