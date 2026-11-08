import { ScanBudgetMeter, validateBudget } from './budget-meter';

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

    it('stops before the next request could cross the cap', () => {
        const meter = new ScanBudgetMeter({ maxUsd: 3 }, RATES);
        const onExhausted = jest.fn();
        meter.onExhausted(onExhausted);

        meter.record(request(1_000_000, 0)); // $1 + $1.5 reserve
        expect(meter.isExhausted()).toBe(false);
        meter.record(request(1_000_000, 0)); // $2 + $1.5 reserve > $3
        expect(meter.isExhausted()).toBe(true);
        expect(onExhausted).toHaveBeenCalledTimes(1);

        meter.record(request(10, 0));
        expect(onExhausted).toHaveBeenCalledTimes(1);
    });

    it('never lets the spend pass the cap while each request grows like a loop step', () => {
        const meter = new ScanBudgetMeter({ maxUsd: 5 }, RATES);
        let input = 100_000;
        // A request only goes out while the meter says there is room, as the
        // engine aborts the loop the moment it is exhausted.
        while (!meter.isExhausted()) {
            meter.record(request(input, 20_000));
            input = Math.round(input * 1.3);
        }
        expect(meter.snapshot().usd).toBeLessThanOrEqual(5);
        expect(meter.snapshot().requests).toBeGreaterThan(3);
    });

    it('caps by tokens when the model has no price', () => {
        const meter = new ScanBudgetMeter({ maxTokens: 1200 }, null);

        meter.record(request(300, 100)); // 400 + 600 reserve
        expect(meter.isExhausted()).toBe(false);
        meter.record(request(300, 100)); // 800 + 600 reserve
        expect(meter.isExhausted()).toBe(true);
        expect(meter.snapshot().usd).toBe(0);
    });

    it('resumes from what an earlier slice spent', () => {
        const meter = new ScanBudgetMeter({ maxUsd: 3 }, RATES, {
            usd: 2.5,
            inputTokens: 2_500_000,
            outputTokens: 0,
            requests: 10,
        });

        meter.record(request(400_000, 0));
        expect(meter.isExhausted()).toBe(true);
    });

    it('reserves room for the first request of a slice', () => {
        const meter = new ScanBudgetMeter({ maxUsd: 1 }, RATES, undefined, {
            usd: 1,
            tokens: 0,
        });
        expect(meter.isExhausted()).toBe(true);
    });
});

describe('validateBudget', () => {
    it('requires a limit', () => {
        expect(validateBudget({}, true)).toMatch(/spend limit/);
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
