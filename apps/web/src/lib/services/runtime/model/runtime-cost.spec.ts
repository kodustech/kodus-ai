import type { RuntimeUsageReport } from "../contracts";
import {
    costOfRunView,
    estimateMonth,
    formatRate,
    monthSeed,
    perMillionLine,
    setupsAndPreviews,
} from "./runtime-cost";

type Patch = {
    counts?: Partial<RuntimeUsageReport["counts"]>;
    cost?: Partial<RuntimeUsageReport["cost"]>;
    byConsumer?: Array<Record<string, unknown>>;
};

/** Only the parts of the report these functions read. */
const report = (p: Patch = {}) =>
    ({
        counts: { runs: 12, runsListed: 12, prs: 8, ...p.counts },
        machine: { byConsumer: p.byConsumer ?? [] },
        cost: {
            perRun: {
                runs: 12,
                completeRuns: 10,
                pricedUsd: 4,
                unpricedParts: { machines: 2, llm: 0, total: 2 },
                perCompleteRun: {
                    medianUsd: 0.31,
                    maxUsd: 1.92,
                    medianMachinesUsd: 0.07,
                    medianLlmManagedUsd: 0.2,
                    medianLlmByokUsd: 0.04,
                },
            },
            ...p.cost,
        },
    }) as unknown as RuntimeUsageReport;

describe("what the calculator starts from", () => {
    it("seeds PRs and Runs per PR from the Runs the report lists, and the cost per Run from the median", () => {
        expect(monthSeed(report())).toEqual({
            prs: 8,
            runsPerPr: 1.5,
            costPerRunUsd: 0.31,
        });
    });

    it("has nothing to seed with when no PR or no priced Run was seen, never a zero", () => {
        const none = report({
            counts: { runs: 0, runsListed: 0, prs: 0 },
            cost: {
                perRun: {
                    runs: 0,
                    completeRuns: 0,
                    pricedUsd: 0,
                    unpricedParts: { machines: 0, llm: 0, total: 0 },
                    perCompleteRun: null,
                },
            },
        });
        expect(monthSeed(none)).toEqual({
            prs: null,
            runsPerPr: null,
            costPerRunUsd: null,
        });
    });
});

describe("the month estimate", () => {
    it("is PRs per month times Runs per PR times the cost per Run", () => {
        expect(
            estimateMonth({ prs: 300, runsPerPr: 1.5, costPerRunUsd: 0.31 }),
        ).toBeCloseTo(139.5, 6);
    });

    it("is not an estimate when an input is missing, negative or not a number", () => {
        expect(estimateMonth({ prs: null, runsPerPr: 1, costPerRunUsd: 1 })).toBeNull();
        expect(estimateMonth({ prs: 10, runsPerPr: -1, costPerRunUsd: 1 })).toBeNull();
        expect(estimateMonth({ prs: 10, runsPerPr: 1, costPerRunUsd: Number.NaN })).toBeNull();
    });
});

describe("the cost of a Run", () => {
    it("gives the median and max, machines apart from managed and own-key LLM, and how many Runs were priced in full", () => {
        expect(costOfRunView(report())).toEqual({
            medianUsd: 0.31,
            maxUsd: 1.92,
            machinesUsd: 0.07,
            llmManagedUsd: 0.2,
            llmByokUsd: 0.04,
            pricedInFull: 10,
            runs: 12,
        });
    });

    it("is null when no Run was priced in full", () => {
        const r = report();
        r.cost.perRun.perCompleteRun = null;
        expect(costOfRunView(r)).toBeNull();
    });
});

describe("setups and previews of the month", () => {
    const row = (consumer: string, patch = {}) => ({
        consumer,
        side: "setup",
        claims: 2,
        gbMinutes: 30,
        hostUsd: 0.02,
        ...patch,
    });

    it("adds the machine time and the host estimate of setups and previews, and leaves Runs and sandboxes out", () => {
        const r = report({
            byConsumer: [
                row("runtime", { gbMinutes: 999, hostUsd: 9 }),
                row("setup"),
                row("preview", { gbMinutes: 10, hostUsd: 0.01 }),
            ],
        });
        expect(setupsAndPreviews(r)).toEqual({
            claims: 4,
            gbMinutes: 40,
            usd: 0.03,
        });
    });

    it("does not price what has no price, and is null when no setup or preview ran", () => {
        expect(
            setupsAndPreviews(report({ byConsumer: [row("setup", { hostUsd: null })] })),
        ).toEqual({ claims: 2, gbMinutes: 30, usd: null });
        expect(setupsAndPreviews(report())).toBeNull();
    });
});

describe("how rates read", () => {
    it("keeps four decimals on a rate under a cent and cents above, and says not set for none", () => {
        expect(formatRate(0.0093)).toBe("$0.0093");
        expect(formatRate(0.1344)).toBe("$0.1344");
        expect(formatRate(2)).toBe("$2.00");
        expect(formatRate(null)).toBe("not set");
    });

    it("reads a model's price per 1M tokens as what the month's tokens cost, with the tier note when some were above it", () => {
        const m = {
            model: "model-a",
            paidBy: "kodus" as const,
            totalTokens: 2_000_000,
            inputTokens: 1_900_000,
            outputTokens: 100_000,
            aboveBaseTierTokens: 500_000,
            usd: 4,
            usdPerMillionTokens: 2,
        };
        expect(perMillionLine(m)).toBe(
            "$2.00 per 1M tokens (blended), 500K tokens priced at a higher tier",
        );
        expect(
            perMillionLine({ ...m, aboveBaseTierTokens: 0 }),
        ).toBe("$2.00 per 1M tokens (blended)");
        expect(
            perMillionLine({ ...m, usd: null, usdPerMillionTokens: null }),
        ).toBe("not set: the price list has no price for this model");
    });
});
