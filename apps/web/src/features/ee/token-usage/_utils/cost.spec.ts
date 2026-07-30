import { cacheSavings, rowCost } from "./cost";
import type {
    BaseUsageContract,
    ModelPricingInfo,
    TokenPrice,
} from "@services/usage/types";

/** Build a ModelPricingInfo from per-token rates (tiers optional). */
const pricing = (opts: {
    input: number;
    output: number;
    cacheRead?: number;
    cacheWrite?: number;
    inputTier?: number;
    outputTier?: number;
}): ModelPricingInfo => {
    const price = (base: number, tier?: number): TokenPrice => ({
        default: base,
        ...(tier !== undefined
            ? { tiers: [{ threshold: 200_000, rate: tier }] }
            : {}),
    });
    return {
        id: "m",
        pricing: {
            input: price(opts.input, opts.inputTier),
            output: price(opts.output, opts.outputTier),
            cacheRead: price(opts.cacheRead ?? 0),
            cacheWrite: price(opts.cacheWrite ?? 0),
            prompt: opts.input,
            completion: opts.output,
            internal_reasoning: opts.output,
        },
    };
};

const flatRow = (o: Partial<BaseUsageContract>): BaseUsageContract => ({
    model: "m",
    input: 0,
    output: 0,
    total: 0,
    outputReasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    ...o,
});

describe("rowCost", () => {
    it("returns zeros when the model has no pricing", () => {
        const cost = rowCost(flatRow({ input: 1000, output: 500 }), undefined);
        expect(cost).toEqual({
            uncachedInput: 0,
            cacheRead: 0,
            output: 0,
            reasoning: 0,
            total: 0,
        });
    });

    it("prices a flat row per token type", () => {
        const cost = rowCost(
            flatRow({ input: 1000, output: 400, total: 1400 }),
            pricing({ input: 2e-6, output: 10e-6 }),
        );
        expect(cost.uncachedInput).toBeCloseTo(1000 * 2e-6, 12);
        expect(cost.output).toBeCloseTo(400 * 10e-6, 12);
        expect(cost.reasoning).toBe(0);
        expect(cost.cacheRead).toBe(0);
        expect(cost.total).toBeCloseTo(cost.uncachedInput + cost.output, 12);
    });

    it("breaks cache reads out of input and prices them at the cache rate", () => {
        // 1000 input tokens, 400 of them served from cache.
        const cost = rowCost(
            flatRow({ input: 1000, cacheRead: 400, output: 0 }),
            pricing({ input: 2e-6, output: 10e-6, cacheRead: 0.2e-6 }),
        );
        // uncached input excludes the 400 cached tokens
        expect(cost.uncachedInput).toBeCloseTo(600 * 2e-6, 12);
        expect(cost.cacheRead).toBeCloseTo(400 * 0.2e-6, 12);
        // never charge the full input rate for cached tokens
        expect(cost.total).toBeCloseTo(600 * 2e-6 + 400 * 0.2e-6, 12);
    });

    it("splits reasoning out of output so it is never double counted", () => {
        // output_tokens includes the 300 reasoning tokens.
        const cost = rowCost(
            flatRow({ input: 0, output: 1000, outputReasoning: 300 }),
            pricing({ input: 2e-6, output: 10e-6 }),
        );
        expect(cost.output).toBeCloseTo(700 * 10e-6, 12);
        expect(cost.reasoning).toBeCloseTo(300 * 10e-6, 12);
        // output + reasoning still equals the full 1000 × rate, not 1300
        expect(cost.output + cost.reasoning).toBeCloseTo(1000 * 10e-6, 12);
    });

    it("prices each tier bucket at its own rate for a tiered model", () => {
        const row = flatRow({
            input: 300_000,
            output: 0,
            byTier: [
                    {
                    input: 100_000,
                    output: 0,
                    total: 100_000,
                    outputReasoning: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                },
                    {
                    input: 200_000,
                    output: 0,
                    total: 200_000,
                    outputReasoning: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                },
                ],
        });
        const cost = rowCost(
            row,
            pricing({ input: 1e-6, output: 5e-6, inputTier: 2e-6 }),
        );
        // le priced at default (1e-6), gt priced at the tier rate (2e-6)
        expect(cost.uncachedInput).toBeCloseTo(
            100_000 * 1e-6 + 200_000 * 2e-6,
            9,
        );
    });
});

describe("cacheSavings", () => {
    it("sums cacheRead × (input rate − cache rate) across models", () => {
        const rows = [
            { ...flatRow({ cacheRead: 1_000_000 }), model: "a" },
            { ...flatRow({ cacheRead: 500_000 }), model: "b" },
        ];
        const prices = {
            a: pricing({ input: 3e-6, output: 0, cacheRead: 0.3e-6 }),
            b: pricing({ input: 1e-6, output: 0, cacheRead: 0.1e-6 }),
        };
        const saved = cacheSavings(rows, prices);
        // a: 1e6 × (3 − 0.3)e-6 = 2.7 ; b: 5e5 × (1 − 0.1)e-6 = 0.45
        expect(saved).toBeCloseTo(2.7 + 0.45, 9);
    });

    it("ignores models with no pricing", () => {
        const rows = [{ ...flatRow({ cacheRead: 1_000_000 }), model: "x" }];
        expect(cacheSavings(rows, {})).toBe(0);
    });
});
