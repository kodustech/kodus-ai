import { afterLostClaim, batchSize, leaseExpired, QUEUE_BATCH_MAX_SPECS, QUEUE_BATCH_TARGET_MS, QUEUE_MAX_ATTEMPTS, queueEntries } from './queue';

const file = (path: string, sizeBytes = 100) => ({ path, sizeBytes });

describe('queueEntries', () => {
    // The queue hands out the longest spec first, by the stored duration.
    it('orders by the stored duration, longest first', () => {
        const out = queueEntries({ specs: [file('a'), file('b'), file('c')], stats: { a: { p50Ms: 10_000 }, b: { p50Ms: 90_000 }, c: { p50Ms: 40_000 } } });
        expect(out.map((e) => e.spec)).toEqual(['b', 'c', 'a']);
        expect(out.map((e) => e.estMs)).toEqual([90_000, 40_000, 10_000]);
    });

    // A spec the stats never saw is queued with the average of the known ones, as the balance gives it.
    it('gives a spec with no stat the average of the known ones', () => {
        const out = queueEntries({ specs: [file('known1'), file('known2'), file('fresh')], stats: { known1: { p50Ms: 10_000 }, known2: { p50Ms: 30_000 } } });
        expect(out.find((e) => e.spec === 'fresh')?.estMs).toBe(20_000);
    });

    // With no duration stored at all the order is by file size and nothing claims to be an estimate.
    it('orders by file size and carries no estimate when no duration is stored', () => {
        const out = queueEntries({ specs: [file('small', 10), file('big', 900), file('mid', 400)], stats: {} });
        expect(out.map((e) => e.spec)).toEqual(['big', 'mid', 'small']);
        expect(out.every((e) => e.estMs === undefined)).toBe(true);
    });

    // The risk-first order of the design stays: a spec red on the previous push, then one that covers the diff, come before a longer spec.
    it('puts specs red before, then specs covering the diff, ahead of longer ones', () => {
        const out = queueEntries({
            specs: [file('long'), file('covers'), file('redBefore'), file('plain')],
            stats: { long: { p50Ms: 100_000 }, covers: { p50Ms: 5_000 }, redBefore: { p50Ms: 1_000 }, plain: { p50Ms: 50_000 } },
            failedBefore: ['redBefore'],
            diffCoverage: { covers: 2 },
        });
        expect(out.map((e) => e.spec)).toEqual(['redBefore', 'covers', 'long', 'plain']);
        expect(out.map((e) => e.priority)).toEqual([0, 1, 2, 2]);
    });

    // Equal weights never depend on the order the specs arrive in.
    it('breaks a tie by path, whatever the input order', () => {
        const stats = { a: { p50Ms: 1_000 }, b: { p50Ms: 1_000 } };
        expect(queueEntries({ specs: [file('b'), file('a')], stats }).map((e) => e.spec)).toEqual(['a', 'b']);
    });
});

describe('batchSize', () => {
    // A long spec (past the target on its own) is pulled alone: the next one would wait for it.
    it('takes a spec at or over the target alone', () => {
        expect(batchSize([{ estMs: QUEUE_BATCH_TARGET_MS }, { estMs: 1_000 }])).toBe(1);
    });

    // Short specs ride together until their estimates add up to the target, so one runner start serves them all.
    it('takes short specs until their estimates add up to the target', () => {
        expect(batchSize([{ estMs: 20_000 }, { estMs: 20_000 }, { estMs: 20_000 }, { estMs: 20_000 }])).toBe(3);
    });

    // However short they are, a pull never holds more than the maximum.
    it('never takes more than the maximum', () => {
        expect(batchSize(Array.from({ length: 20 }, () => ({ estMs: 1 })))).toBe(QUEUE_BATCH_MAX_SPECS);
    });

    // A spec with no estimate counts as the whole target, so with nothing known every pull is one spec.
    it('takes one spec at a time when nothing is estimated', () => {
        expect(batchSize([{}, {}, {}])).toBe(1);
    });

    // An empty queue gives an empty pull.
    it('takes nothing from an empty queue', () => {
        expect(batchSize([])).toBe(0);
    });
});

describe('lost claims', () => {
    // A spec whose shard was lost once goes back to the queue; one already handed out the maximum times is abandoned.
    it('re-queues while attempts are left and abandons after the last', () => {
        expect(afterLostClaim(1)).toBe('queued');
        expect(afterLostClaim(QUEUE_MAX_ATTEMPTS)).toBe('abandoned');
    });

    // A lease is over at its expiry instant, not before.
    it('says a lease expired at its expiry and not before', () => {
        expect(leaseExpired(1_000, 999)).toBe(false);
        expect(leaseExpired(1_000, 1_000)).toBe(true);
    });
});
