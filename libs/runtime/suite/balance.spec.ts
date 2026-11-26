import { balanceSpecs, estimateTotalMs, perSpecOverheadMs, shardCount, shardTargetMs, TARGET_SHARD_MS } from './balance';

const spec = (path: string, sizeBytes = 1000) => ({ path, sizeBytes });
const stats = (o: Record<string, number>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { p50Ms: v }]));

describe('balanceSpecs', () => {
    it('puts 5 specs into 3 bins by stored durations, longest first onto the lightest bin', () => {
        const plan = balanceSpecs(
            [spec('a'), spec('b'), spec('c'), spec('d'), spec('e')],
            stats({ a: 600, b: 500, c: 400, d: 300, e: 200 }),
            3,
        );
        expect(plan.basis).toBe('duration');
        expect(plan.bins.map((b) => b.specs)).toEqual([['a'], ['b', 'e'], ['c', 'd']]);
        expect(plan.bins.map((b) => b.weight)).toEqual([600, 700, 700]);
    });

    it('gives a spec with no stored duration the average of the known ones', () => {
        const plan = balanceSpecs([spec('a'), spec('b'), spec('new')], stats({ a: 600, b: 200 }), 2);
        // new weighs 400: a (600) alone, b (200) + new (400) together
        expect(plan.bins.map((b) => b.specs)).toEqual([['a'], ['new', 'b']]);
        expect(plan.bins.map((b) => b.weight)).toEqual([600, 600]);
    });

    it('splits by file size, round-robin in sorted order, when no spec has a duration', () => {
        const plan = balanceSpecs([spec('x', 100), spec('y', 300), spec('z', 200), spec('w', 50)], {}, 2);
        expect(plan.basis).toBe('size');
        expect(plan.bins.map((b) => b.specs)).toEqual([['y', 'x'], ['z', 'w']]);
    });

    it('is the same answer for the same input whatever the order specs arrive in', () => {
        const s = stats({ a: 100, b: 100, c: 100, d: 100 });
        const one = balanceSpecs([spec('a'), spec('b'), spec('c'), spec('d')], s, 2);
        const two = balanceSpecs([spec('d'), spec('c'), spec('b'), spec('a')], s, 2);
        expect(two).toEqual(one);
    });

    it('returns as many bins as asked, leaving the extra ones empty, and never loses a spec', () => {
        const plan = balanceSpecs([spec('a'), spec('b')], stats({ a: 1, b: 1 }), 4);
        expect(plan.bins).toHaveLength(4);
        expect(plan.bins.flatMap((b) => b.specs).sort()).toEqual(['a', 'b']);
    });

    it('asks for at least one bin', () => {
        expect(balanceSpecs([spec('a')], {}, 0).bins).toHaveLength(1);
    });
});

describe('estimateTotalMs', () => {
    it('sums the durations, pricing an unknown spec at the average of the known', () => {
        expect(estimateTotalMs([spec('a'), spec('b'), spec('n')], stats({ a: 600, b: 200 }))).toBe(1200);
    });
    it('is undefined with no stored duration at all', () => {
        expect(estimateTotalMs([spec('a')], {})).toBeUndefined();
    });
});

describe('shardCount', () => {
    const MIN = 60_000;
    it('follows ceil(total / 8 min) up to the recipe ceiling', () => {
        expect(shardCount({ totalMs: 30 * MIN, maxShards: 3, headroom: 10, specCount: 50 })).toBe(3);
        expect(shardCount({ totalMs: 17 * MIN, maxShards: 5, headroom: 10, specCount: 50 })).toBe(3);
    });
    it('is one host for 6 short specs', () => {
        expect(shardCount({ totalMs: 6 * 30_000, maxShards: 3, headroom: 10, specCount: 6 })).toBe(1);
    });
    it('is bounded by the pool headroom, never below one', () => {
        expect(shardCount({ totalMs: 30 * MIN, maxShards: 3, headroom: 2, specCount: 50 })).toBe(2);
        expect(shardCount({ totalMs: 30 * MIN, maxShards: 3, headroom: 0, specCount: 50 })).toBe(1);
    });
    it('is never more than the number of specs', () => {
        expect(shardCount({ totalMs: 60 * MIN, maxShards: 3, headroom: 10, specCount: 2 })).toBe(2);
    });
    it('uses the ceiling and the headroom when no duration is known', () => {
        expect(shardCount({ totalMs: undefined, maxShards: 3, headroom: 10, specCount: 50 })).toBe(3);
        expect(shardCount({ totalMs: undefined, maxShards: 3, headroom: 2, specCount: 50 })).toBe(2);
    });
    it('takes another target shard time when given', () => {
        expect(shardCount({ totalMs: 10 * MIN, maxShards: 9, headroom: 9, specCount: 50, targetShardMs: 2 * MIN })).toBe(5);
    });
});

describe('perSpecOverheadMs', () => {
    it('is what each spec cost beyond its own duration: the shard wall time less the durations, over the specs that reported', () => {
        // 6 specs of 30 s reported over 8 minutes: the runner spent 50 s of each spec outside its own duration.
        expect(perSpecOverheadMs({ wallMs: 480_000, durationsMs: Array(6).fill(30_000) })).toBe(50_000);
    });

    it('is zero with no spec reported, and never negative when the durations add up to more than the wall time', () => {
        expect(perSpecOverheadMs({ wallMs: 90_000, durationsMs: [] })).toBe(0);
        expect(perSpecOverheadMs({ wallMs: 10_000, durationsMs: [30_000, 30_000] })).toBe(0);
    });

    it('counts the first spec like the others: one spec that took 40 s of a 100 s wall carries 60 s', () => {
        expect(perSpecOverheadMs({ wallMs: 100_000, durationsMs: [40_000] })).toBe(60_000);
    });
});

describe('shardTargetMs', () => {
    it('is the 8 minute target while the shard cap and the time left are roomy', () => {
        expect(shardTargetMs({ shardTimeoutMs: 25 * 60_000 })).toBe(TARGET_SHARD_MS);
    });

    it('is 80% of the shard cap when the cap is shorter than the target allows, and 80% of the time left to the deadline', () => {
        expect(shardTargetMs({ shardTimeoutMs: 5 * 60_000 })).toBe(4 * 60_000);
        expect(shardTargetMs({ shardTimeoutMs: 25 * 60_000, timeLeftMs: 10 * 60_000 })).toBe(8 * 60_000);
        expect(shardTargetMs({ shardTimeoutMs: 25 * 60_000, timeLeftMs: 5 * 60_000 })).toBe(4 * 60_000);
    });
});
