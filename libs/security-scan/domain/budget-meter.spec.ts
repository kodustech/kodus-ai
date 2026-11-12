import type { Admission, RequestCeiling } from '@libs/llm/usage-meter';

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

/** An admission the meter grants or refuses at once, as these cases expect. */
const admitNow = (meter: ScanBudgetMeter, request: RequestCeiling) =>
    meter.admit(request) as Admission;

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
                admitNow(meter, { inputTokens: 2, maxOutputTokens: 60 }).settle({});
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

        admitNow(meter, { inputTokens: 1_000, maxOutputTokens: 500 }).settle({
            inputTokens: 1_000,
        });
        meter.record({ usage: { inputTokens: 1_000 } });

        // The input is what it reported; the answer, its reserved cap.
        expect(meter.snapshot()).toEqual(
            expect.objectContaining({ inputTokens: 1_000, outputTokens: 500 }),
        );
    });

    it('refuses a request whose most it can cost would cross the cap even with nothing in flight', async () => {
        const meter = new ScanBudgetMeter({ maxUsd: 1 }, RATES);
        const onExhausted = jest.fn();
        meter.onExhausted(onExhausted);

        // 400k tokens of prompt (500k with the tokenizer margin) and a 100k
        // answer cap: at most $0.70.
        const { settle } = admitNow(meter, {
            inputTokens: 400_000,
            maxOutputTokens: 100_000,
        });
        // Only the one in flight crowds it out: it waits.
        const waiting = meter.admit({ inputTokens: 400_000, maxOutputTokens: 100_000 });
        expect(waiting).toBeInstanceOf(Promise);
        expect(meter.isExhausted()).toBe(false);

        // The first used all it was allowed: the second no longer fits at all.
        settle({ inputTokens: 500_000, outputTokens: 100_000 });
        await expect(waiting).rejects.toBeInstanceOf(ScanBudgetReached);
        expect(meter.isExhausted()).toBe(true);
        expect(onExhausted).toHaveBeenCalledTimes(1);
        // Nothing else leaves.
        expect(() =>
            admitNow(meter, { inputTokens: 10, maxOutputTokens: 10 }),
        ).toThrow(ScanBudgetReached);
    });

    it('lets a request crowded out by reservations in flight through once they settle small', async () => {
        // A 40k cap; each request may use 18.5k but uses 2.1k.
        const meter = new ScanBudgetMeter({ maxTokens: 40_000 }, null);
        const ask = { inputTokens: 2_000, maxOutputTokens: 16_000 };
        const first = admitNow(meter, ask);
        const second = admitNow(meter, ask);
        const third = meter.admit(ask);
        expect(third).toBeInstanceOf(Promise);

        first.settle({ inputTokens: 2_000, outputTokens: 100 });
        meter.record({ usage: { inputTokens: 2_000, outputTokens: 100 } });

        const admitted = await third;
        expect(typeof admitted.settle).toBe('function');
        expect(meter.isExhausted()).toBe(false);
        second.settle({ inputTokens: 2_000, outputTokens: 100 });
    });

    it('never spends past the cap with requests in flight at once, whatever came before', async () => {
        // The case a reserve sized from earlier requests missed: a small
        // planner first, then four large lens steps at once.
        const meter = new ScanBudgetMeter({ maxUsd: 1 }, RATES);
        const answer = (input: number, output: number) => ({
            inputTokens: input,
            outputTokens: output,
        });
        admitNow(meter, { inputTokens: 2_000, maxOutputTokens: 1_000 }).settle(
            answer(2_000, 500),
        );
        meter.record(request(2_000, 500));

        // Each one admitted uses all it was allowed, as soon as it is let in.
        const runs = Array.from({ length: 4 }, async () => {
            const admission = await meter.admit({
                inputTokens: 160_000,
                maxOutputTokens: 32_000,
            });
            admission.settle(answer(200_000, 32_000));
            meter.record(request(200_000, 32_000));
            return true;
        });
        const outcomes = await Promise.allSettled(runs);

        expect(outcomes.some((o) => o.status === 'rejected')).toBe(true);
        expect(meter.snapshot().usd).toBeLessThanOrEqual(1);
    });

    it('holds an answered request until its caller records it, and counts it once', () => {
        const meter = new ScanBudgetMeter({ maxUsd: 1 }, RATES);

        admitNow(meter, { inputTokens: 100_000, maxOutputTokens: 10_000 }).settle({
            inputTokens: 300_000,
            outputTokens: 0,
        });
        // Answered, not recorded yet: its $0.30 already counts ($0.30 +
        // $0.77 > $1).
        expect(() =>
            admitNow(meter, { inputTokens: 600_000, maxOutputTokens: 10_000 }),
        ).toThrow(ScanBudgetReached);

        const fresh = new ScanBudgetMeter({ maxUsd: 1 }, RATES);
        admitNow(fresh, { inputTokens: 100_000, maxOutputTokens: 10_000 }).settle({
            inputTokens: 300_000,
            outputTokens: 0,
        });
        fresh.record(request(300_000, 0));
        expect(fresh.snapshot().usd).toBeCloseTo(0.3);
        // Recorded, it counts once: $0.30 + $0.645 fits, where counting it
        // twice would not.
        expect(() =>
            admitNow(fresh, { inputTokens: 500_000, maxOutputTokens: 10_000 }),
        ).not.toThrow();
    });

    it('releases the held answer its record is for, when two share their token counts', () => {
        const meter = new ScanBudgetMeter({ maxUsd: 10 }, RATES);
        const full = { inputTokens: 1_000_000, outputTokens: 0 };
        const cached = { ...full, cacheReadTokens: 1_000_000 };

        // Both answered, not recorded yet: $1 and $0.10 held.
        admitNow(meter, { inputTokens: 100, maxOutputTokens: 10 }).settle(full);
        admitNow(meter, { inputTokens: 100, maxOutputTokens: 10 }).settle(cached);
        // The cached one is recorded first: its own $0.10 is released.
        meter.record({ usage: cached });

        // Spent $0.10 and still holding $1: $8.90 of room, too little for a
        // $9 request. Releasing the wrong one would leave $9.80.
        expect(() =>
            admitNow(meter, { inputTokens: 7_200_000, maxOutputTokens: 1 }),
        ).toThrow(ScanBudgetReached);
    });

    it('gives back the reservation of a request that failed unanswered', () => {
        const meter = new ScanBudgetMeter({ maxUsd: 1 }, RATES);

        admitNow(meter, { inputTokens: 600_000, maxOutputTokens: 10_000 }).settle(
            undefined,
        );

        expect(() =>
            admitNow(meter, { inputTokens: 600_000, maxOutputTokens: 10_000 }),
        ).not.toThrow();
    });

    it('reserves an uncapped answer at the scan cap and sends that cap with it', () => {
        const meter = new ScanBudgetMeter({ maxTokens: 100_000 }, null);

        const admission = admitNow(meter, { inputTokens: 1_000 });

        // The provider is told the cap that was reserved.
        expect(admission.maxOutputTokens).toBe(SCAN_ANSWER_CAP_TOKENS);
        // A request with its own cap keeps it.
        expect(
            admitNow(meter, { inputTokens: 1_000, maxOutputTokens: 500 })
                .maxOutputTokens,
        ).toBeUndefined();
        // 100,000 of prompt (with the margin) and the 16,000 cap pass 100k
        // even with nothing in flight.
        expect(() => admitNow(meter, { inputTokens: 80_000 })).toThrow(
            ScanBudgetReached,
        );
    });

    it("reserves a prompt at the byte bound the wrapper sends, not the shared tokenizer's count", () => {
        const meter = new ScanBudgetMeter({ maxTokens: 50_000 }, null);

        // 30k by the shared tokenizer, but 45k bytes: another model's
        // tokenizer may make up to 45k tokens of it.
        expect(() =>
            admitNow(meter, {
                inputTokens: 30_000,
                inputTokensUpperBound: 45_000,
                maxOutputTokens: 8_000,
            }),
        ).toThrow(ScanBudgetReached);
        expect(() =>
            admitNow(new ScanBudgetMeter({ maxTokens: 50_000 }, null), {
                inputTokens: 30_000,
                inputTokensUpperBound: 40_000,
                maxOutputTokens: 8_000,
            }),
        ).not.toThrow();
    });

    it('sends an answer cap that fits beside the prompt in a small context window', () => {
        // A 32k window: a 20k prompt (22k with the margin) leaves 10k.
        const meter = new ScanBudgetMeter({ maxTokens: 1_000_000 }, null, undefined, 32_768);

        expect(admitNow(meter, { inputTokens: 20_000 }).maxOutputTokens).toBe(10_768);
        // A large window keeps the scan's own cap.
        expect(
            admitNow(new ScanBudgetMeter({ maxTokens: 1_000_000 }, null, undefined, 200_000), {
                inputTokens: 20_000,
            }).maxOutputTokens,
        ).toBe(SCAN_ANSWER_CAP_TOKENS);
    });

    it('refuses a request whose price cannot be computed, never lets it through free', () => {
        // A manual price missing its cache rates prices every request at NaN.
        const meter = new ScanBudgetMeter({ maxUsd: 1 }, {
            input: { default: 1e-6 },
            output: { default: 1e-6 },
        } as any);

        expect(() => admitNow(meter, { inputTokens: 10, maxOutputTokens: 10 })).toThrow(
            ScanBudgetReached,
        );
    });

    it('reserves the reasoning budget the provider adds on top of the answer cap', () => {
        const meter = new ScanBudgetMeter({ maxTokens: 30_000 }, null);

        // 16k of answer and a 32k thinking budget: max_tokens 48k on the wire.
        expect(() =>
            admitNow(meter, {
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
            admitNow(meter, { inputTokens: 1_000 }).maxOutputTokens,
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
            admitNow(meter, { inputTokens: 240_000, maxOutputTokens: 1 }),
        ).toThrow(ScanBudgetReached);

        const spending = new ScanBudgetMeter({ maxUsd: 10 }, tiered);
        spending.record(request(300_000, 0));
        expect(spending.snapshot().usd).toBeCloseTo(0.6);
        spending.record(request(100_000, 0));
        expect(spending.snapshot().usd).toBeCloseTo(0.7);
    });

    it('caps by tokens when the model has no price', () => {
        const meter = new ScanBudgetMeter({ maxTokens: 10_000 }, null);

        admitNow(meter, { inputTokens: 4_000, maxOutputTokens: 1_000 }).settle({
            inputTokens: 4_000,
            outputTokens: 1_000,
        });
        meter.record(request(4_000, 1_000));

        expect(meter.snapshot().usd).toBe(0);
        expect(() =>
            admitNow(meter, { inputTokens: 4_000, maxOutputTokens: 1_000 }),
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
            admitNow(meter, { inputTokens: 100_000, maxOutputTokens: 1_000 }),
        ).toThrow(ScanBudgetReached);
    });

    it('never stops a scan without a limit, but still counts its spend', () => {
        const meter = new ScanBudgetMeter({}, RATES);

        for (let i = 0; i < 5; i++) {
            admitNow(meter, { inputTokens: 10_000_000 }).settle({
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
