import {
    ScanBudgetMeter,
    ScanBudgetReached,
    SCAN_ANSWER_CAP_TOKENS,
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

    it('charges an answer that reported no usage at what was reserved for it', () => {
        // A 100-token cap; each request asks for at most 63 (60 of answer).
        const meter = new ScanBudgetMeter({ maxTokens: 100 }, RATES);
        let answered = 0;
        for (let i = 0; i < 10; i++) {
            try {
                meter.admit({ inputTokens: 2, maxOutputTokens: 60 }).settle({});
                answered++;
            } catch (error) {
                expect(error).toBeInstanceOf(ScanBudgetReached);
            }
        }

        expect(answered).toBe(1);
        expect(meter.snapshot()).toEqual(
            expect.objectContaining({ inputTokens: 3, outputTokens: 60 }),
        );
    });

    it('charges only the total the provider left out', () => {
        const meter = new ScanBudgetMeter({ maxUsd: 10 }, RATES);

        meter.admit({ inputTokens: 1_000, maxOutputTokens: 500 }).settle({
            inputTokens: 1_000,
        });
        meter.record({ usage: { inputTokens: 1_000 } });

        // The input is what it reported; the answer, its reserved cap.
        expect(meter.snapshot()).toEqual(
            expect.objectContaining({ inputTokens: 1_000, outputTokens: 500 }),
        );
    });

    it('refuses a request whose most it can cost would cross the cap', () => {
        const meter = new ScanBudgetMeter({ maxUsd: 1 }, RATES);
        const onExhausted = jest.fn();
        meter.onExhausted(onExhausted);

        // 400k tokens of prompt (500k with the tokenizer margin) and a 100k
        // answer cap: at most $0.70.
        meter.admit({ inputTokens: 400_000, maxOutputTokens: 100_000 }).settle(
            undefined,
        );
        expect(meter.isExhausted()).toBe(false);

        const { settle } = meter.admit({
            inputTokens: 400_000,
            maxOutputTokens: 100_000,
        });
        expect(() =>
            meter.admit({ inputTokens: 400_000, maxOutputTokens: 100_000 }),
        ).toThrow(ScanBudgetReached);
        expect(meter.isExhausted()).toBe(true);
        expect(onExhausted).toHaveBeenCalledTimes(1);

        // The aborted request gives its room back, but nothing else leaves.
        settle(undefined);
        expect(() =>
            meter.admit({ inputTokens: 10, maxOutputTokens: 10 }),
        ).toThrow(ScanBudgetReached);
    });

    it('never spends past the cap with requests in flight at once, whatever came before', () => {
        // The case a reserve sized from earlier requests missed: a small
        // planner first, then four large lens steps at once.
        const meter = new ScanBudgetMeter({ maxUsd: 1 }, RATES);
        const answer = (input: number, output: number) => ({
            inputTokens: input,
            outputTokens: output,
        });
        meter.admit({ inputTokens: 2_000, maxOutputTokens: 1_000 }).settle(
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
                    }).settle,
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

        meter.admit({ inputTokens: 100_000, maxOutputTokens: 10_000 }).settle({
            inputTokens: 300_000,
            outputTokens: 0,
        });
        // Answered, not recorded yet: its $0.30 already counts ($0.30 +
        // $0.77 > $1).
        expect(() =>
            meter.admit({ inputTokens: 600_000, maxOutputTokens: 10_000 }),
        ).toThrow(ScanBudgetReached);

        const fresh = new ScanBudgetMeter({ maxUsd: 1 }, RATES);
        fresh.admit({ inputTokens: 100_000, maxOutputTokens: 10_000 }).settle({
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

    it('releases the held answer its record is for, when two share their token counts', () => {
        const meter = new ScanBudgetMeter({ maxUsd: 10 }, RATES);
        const full = { inputTokens: 1_000_000, outputTokens: 0 };
        const cached = { ...full, cacheReadTokens: 1_000_000 };

        // Both answered, not recorded yet: $1 and $0.10 held.
        meter.admit({ inputTokens: 100, maxOutputTokens: 10 }).settle(full);
        meter.admit({ inputTokens: 100, maxOutputTokens: 10 }).settle(cached);
        // The cached one is recorded first: its own $0.10 is released.
        meter.record({ usage: cached });

        // Spent $0.10 and still holding $1: $8.90 of room, too little for a
        // $9 request. Releasing the wrong one would leave $9.80.
        expect(() =>
            meter.admit({ inputTokens: 7_200_000, maxOutputTokens: 1 }),
        ).toThrow(ScanBudgetReached);
    });

    it('gives back the reservation of a request that failed unanswered', () => {
        const meter = new ScanBudgetMeter({ maxUsd: 1 }, RATES);

        meter.admit({ inputTokens: 600_000, maxOutputTokens: 10_000 }).settle(
            undefined,
        );

        expect(() =>
            meter.admit({ inputTokens: 600_000, maxOutputTokens: 10_000 }),
        ).not.toThrow();
    });

    it('reserves an uncapped answer at the scan cap and sends that cap with it', () => {
        const meter = new ScanBudgetMeter({ maxTokens: 100_000 }, null);

        const admission = meter.admit({ inputTokens: 1_000 });

        // The provider is told the cap that was reserved.
        expect(admission.maxOutputTokens).toBe(SCAN_ANSWER_CAP_TOKENS);
        // A request with its own cap keeps it.
        expect(
            meter.admit({ inputTokens: 1_000, maxOutputTokens: 500 })
                .maxOutputTokens,
        ).toBeUndefined();
        // 19,000 reserved in flight; 75,000 of prompt and the 16,000 cap
        // would take it past 100k.
        expect(() => meter.admit({ inputTokens: 60_000 })).toThrow(
            ScanBudgetReached,
        );
    });

    it('reserves the reasoning budget the provider adds on top of the answer cap', () => {
        const meter = new ScanBudgetMeter({ maxTokens: 30_000 }, null);

        // 16k of answer and a 32k thinking budget: max_tokens 48k on the wire.
        expect(() =>
            meter.admit({
                inputTokens: 100,
                maxOutputTokens: 16_000,
                reasoningBudgetTokens: 32_000,
            }),
        ).toThrow(ScanBudgetReached);
        // Without the budget the same request fits.
        expect(() =>
            new ScanBudgetMeter({ maxTokens: 30_000 }, null).admit({
                inputTokens: 100,
                maxOutputTokens: 16_000,
            }),
        ).not.toThrow();
    });

    it('leaves the answer uncapped when the scan has no limit', () => {
        const meter = new ScanBudgetMeter({}, RATES);

        expect(
            meter.admit({ inputTokens: 1_000 }).maxOutputTokens,
        ).toBeUndefined();
    });

    it('prices a request at the tier its input falls in, when admitting and when spending', () => {
        // Input doubles past 200k tokens of context.
        const tiered = {
            ...RATES,
            input: { default: 1e-6, tiers: [{ threshold: 200_000, rate: 2e-6 }] },
        };
        const meter = new ScanBudgetMeter({ maxUsd: 0.5 }, tiered);

        // 240k tokens of prompt (300k with the margin) cost $0.60 at the
        // upper tier: refused under $0.50, where the flat rate said $0.30.
        expect(() =>
            meter.admit({ inputTokens: 240_000, maxOutputTokens: 1 }),
        ).toThrow(ScanBudgetReached);

        const spending = new ScanBudgetMeter({ maxUsd: 10 }, tiered);
        spending.record(request(300_000, 0));
        expect(spending.snapshot().usd).toBeCloseTo(0.6);
        spending.record(request(100_000, 0));
        expect(spending.snapshot().usd).toBeCloseTo(0.7);
    });

    it('caps by tokens when the model has no price', () => {
        const meter = new ScanBudgetMeter({ maxTokens: 10_000 }, null);

        meter.admit({ inputTokens: 4_000, maxOutputTokens: 1_000 }).settle({
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
            meter.admit({ inputTokens: 10_000_000 }).settle({
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
