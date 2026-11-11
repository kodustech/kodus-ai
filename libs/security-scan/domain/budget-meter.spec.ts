import {
    ScanBudgetMeter,
    ScanBudgetReached,
    UNCAPPED_ANSWER_TOKENS,
    validateBudget,
} from './budget-meter';

// $1 per 1M input tokens, $2 per 1M output, cache reads at a tenth.
const RATES = {
    input: { default: 1e-6 },
    output: { default: 2e-6 },
    cacheRead: { default: 1e-7 },
    cacheWrite: { default: 1e-6 },
};

const request = (input: number, output: number, cacheRead = 0) => ({
    usage: { inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead },
});

describe('ScanBudgetMeter', () => {
    it('adds up what each request costs', () => {
        const meter = new ScanBudgetMeter({ maxUsd: 10 }, RATES);

        meter.record(request(1_000_000, 0));
        meter.record(request(0, 500_000));

        expect(meter.snapshot()).toEqual({
            usd: 2,
            inputTokens: 1_000_000,
            outputTokens: 500_000,
            requests: 2,
        });
    });

    it('bills cached input at the cache rate', () => {
        const meter = new ScanBudgetMeter({ maxUsd: 10 }, RATES);

        meter.record(request(1_000_000, 0, 1_000_000));

        expect(meter.snapshot().usd).toBeCloseTo(0.1);
    });

    it('refuses a request whose most it can cost would cross the cap', () => {
        const meter = new ScanBudgetMeter({ maxUsd: 1 }, RATES);
        const onExhausted = jest.fn();
        meter.onExhausted(onExhausted);

        // 400k tokens of prompt (500k with the tokenizer margin) and a 100k
        // answer cap: at most $0.70.
        meter.admit({ inputTokens: 400_000, maxOutputTokens: 100_000 })(
            undefined,
        );
        expect(meter.isExhausted()).toBe(false);

        const settle = meter.admit({
            inputTokens: 400_000,
            maxOutputTokens: 100_000,
        });
        expect(() =>
            meter.admit({ inputTokens: 400_000, maxOutputTokens: 100_000 }),
        ).toThrow(ScanBudgetReached);
        expect(meter.isExhausted()).toBe(true);
        expect(onExhausted).toHaveBeenCalledTimes(1);
        settle(undefined);
    });

    it('never spends past the cap with requests in flight at once, whatever came before', () => {
        // The case a reserve sized from earlier requests missed: a small
        // planner first, then four large lens steps at once.
        const meter = new ScanBudgetMeter({ maxUsd: 1 }, RATES);
        const answer = (input: number, output: number) => ({
            inputTokens: input,
            outputTokens: output,
        });
        meter.admit({ inputTokens: 2_000, maxOutputTokens: 1_000 })(
            answer(2_000, 500),
        );
        meter.record(request(2_000, 500));

        const admitted: Array<(u: any) => void> = [];
        for (let i = 0; i < 4; i++) {
            try {
                admitted.push(
                    meter.admit({
                        inputTokens: 160_000,
                        maxOutputTokens: 32_000,
                    }),
                );
            } catch (error) {
                expect(error).toBeInstanceOf(ScanBudgetReached);
            }
        }
        // Each uses all it was allowed.
        for (const settle of admitted) {
            settle(answer(200_000, 32_000));
            meter.record(request(200_000, 32_000));
        }

        expect(admitted.length).toBeLessThan(4);
        expect(meter.snapshot().usd).toBeLessThanOrEqual(1);
    });

    it('holds an answered request until its caller records it, and counts it once', () => {
        const meter = new ScanBudgetMeter({ maxUsd: 1 }, RATES);

        meter.admit({ inputTokens: 100_000, maxOutputTokens: 10_000 })({
            inputTokens: 300_000,
            outputTokens: 0,
        });
        // Answered, not recorded yet: its $0.30 already counts ($0.30 +
        // $0.77 > $1).
        expect(() =>
            meter.admit({ inputTokens: 600_000, maxOutputTokens: 10_000 }),
        ).toThrow(ScanBudgetReached);

        const fresh = new ScanBudgetMeter({ maxUsd: 1 }, RATES);
        fresh.admit({ inputTokens: 100_000, maxOutputTokens: 10_000 })({
            inputTokens: 300_000,
            outputTokens: 0,
        });
        fresh.record(request(300_000, 0));
        expect(fresh.snapshot().usd).toBeCloseTo(0.3);
        // Recorded, it counts once: $0.30 + $0.645 fits, where counting it
        // twice would not.
        expect(() =>
            fresh.admit({ inputTokens: 500_000, maxOutputTokens: 10_000 }),
        ).not.toThrow();
    });

    it('gives back the reservation of a request that failed unanswered', () => {
        const meter = new ScanBudgetMeter({ maxUsd: 1 }, RATES);

        meter.admit({ inputTokens: 600_000, maxOutputTokens: 10_000 })(
            undefined,
        );

        expect(() =>
            meter.admit({ inputTokens: 600_000, maxOutputTokens: 10_000 }),
        ).not.toThrow();
    });

    it('reserves an uncapped answer at the scan default', () => {
        const meter = new ScanBudgetMeter(
            { maxTokens: UNCAPPED_ANSWER_TOKENS },
            null,
        );

        // 1,250 tokens of prompt and the default answer do not fit.
        expect(() => meter.admit({ inputTokens: 1_000 })).toThrow(
            ScanBudgetReached,
        );
    });

    it('caps by tokens when the model has no price', () => {
        const meter = new ScanBudgetMeter({ maxTokens: 10_000 }, null);

        meter.admit({ inputTokens: 4_000, maxOutputTokens: 1_000 })({
            inputTokens: 4_000,
            outputTokens: 1_000,
        });
        meter.record(request(4_000, 1_000));

        expect(meter.snapshot().usd).toBe(0);
        expect(() =>
            meter.admit({ inputTokens: 4_000, maxOutputTokens: 1_000 }),
        ).toThrow(ScanBudgetReached);
    });

    it('resumes from what an earlier slice spent', () => {
        const meter = new ScanBudgetMeter({ maxUsd: 1 }, RATES, {
            usd: 0.9,
            inputTokens: 900_000,
            outputTokens: 0,
            requests: 3,
        });

        expect(() =>
            meter.admit({ inputTokens: 100_000, maxOutputTokens: 1_000 }),
        ).toThrow(ScanBudgetReached);
    });

    it('never stops a scan without a limit, but still counts its spend', () => {
        const meter = new ScanBudgetMeter({}, RATES);

        for (let i = 0; i < 5; i++) {
            meter.admit({ inputTokens: 10_000_000 })({
                inputTokens: 1_000_000,
                outputTokens: 0,
            });
            meter.record(request(1_000_000, 0));
        }

        expect(meter.isExhausted()).toBe(false);
        expect(meter.snapshot().usd).toBe(5);
    });
});

describe('validateBudget', () => {
    it('accepts no limit, priced or not', () => {
        expect(validateBudget({}, true)).toBeNull();
        expect(validateBudget({}, false)).toBeNull();
    });

    it('refuses a USD cap for a model without a price', () => {
        expect(validateBudget({ maxUsd: 20 }, false)).toMatch(/no known price/);
    });

    it('accepts a token cap for a model without a price', () => {
        expect(validateBudget({ maxTokens: 2_000_000 }, false)).toBeNull();
    });

    it('rejects a non-positive limit', () => {
        expect(validateBudget({ maxUsd: 0 }, true)).toMatch(/greater than zero/);
        expect(validateBudget({ maxTokens: -1 }, true)).toMatch(/greater than zero/);
    });
});
