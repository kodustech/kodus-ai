import { kodusModelUsageCostUsd, kodusUsageCostUsd } from './usage-cost';

describe('kodusUsageCostUsd — the one billing formula', () => {
    const sonnet = {
        inputPerMillion: 2,
        outputPerMillion: 10,
        cacheReadPerMillion: 0.2,
        cacheWritePerMillion: 2.5,
    };

    it('bills uncached input, output, cache reads and cache writes at their own rates', () => {
        // 1M input of which 400K read from cache and 100K written to cache.
        const usd = kodusUsageCostUsd(
            { input: 1_000_000, output: 100_000, cacheRead: 400_000, cacheWrite: 100_000 },
            sonnet,
        );
        // uncached 500K × $2 + read 400K × $0.2 + write 100K × $2.5 + out 100K × $10
        expect(usd).toBeCloseTo(1 + 0.08 + 0.25 + 1, 6);
    });

    it('never bills cached tokens twice (cache is a subset of input)', () => {
        const all = kodusUsageCostUsd(
            { input: 1_000_000, output: 0, cacheRead: 1_000_000 },
            sonnet,
        );
        expect(all).toBeCloseTo(0.2, 6);
    });

    it('falls back to the input rate when a provider has no cache rate', () => {
        const openai = { inputPerMillion: 2.5, outputPerMillion: 15, cacheReadPerMillion: 0.25 };
        const usd = kodusUsageCostUsd(
            { input: 1_000_000, output: 0, cacheWrite: 200_000 },
            openai,
        );
        // no cacheWrite rate → written tokens cost input price: 800K×2.5 + 200K×2.5
        expect(usd).toBeCloseTo(2.5, 6);
    });

    it('treats junk counts as zero and rounds to 6 decimals', () => {
        expect(
            kodusUsageCostUsd({ input: NaN, output: -5, cacheRead: undefined }, sonnet),
        ).toBe(0);
        expect(kodusUsageCostUsd({ input: 1, output: 1 }, sonnet)).toBe(0.000012);
    });

    it('prices only catalog ids; anything else is null (never silently free)', () => {
        expect(
            kodusModelUsageCostUsd('anthropic/claude-sonnet-5', { input: 1_000_000, output: 0 }),
        ).toBeCloseTo(2, 6);
        expect(kodusModelUsageCostUsd('claude-sonnet-5', { input: 1, output: 1 })).toBeNull();
        expect(kodusModelUsageCostUsd('openai/gpt-4o', { input: 1, output: 1 })).toBeNull();
    });
});
