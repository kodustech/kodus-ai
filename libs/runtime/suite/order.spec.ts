import { balanceSpecs } from './balance';
import { planReruns } from './classifier';
import { failFast, orderBin, orderBins } from './order';

const stats = (o: Record<string, number>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { p50Ms: v }]));

describe('orderBin (risk first)', () => {
    const durations = { a: 100, b: 500, c: 300, d: 200, e: 400 };
    it('runs the specs that failed before first, then those covering the diff (more changed files first), then the rest by duration', () => {
        const order = orderBin(['a', 'b', 'c', 'd', 'e'], { failedBefore: ['a'], diffCoverage: { c: 1, d: 3 }, durations });
        expect(order).toEqual(['a', 'd', 'c', 'b', 'e']);
    });
    it('orders the rest longest first, ties by path', () => {
        expect(orderBin(['a', 'd', 'c'], { failedBefore: [], diffCoverage: {}, durations: { a: 100, c: 100, d: 100 } })).toEqual(['a', 'c', 'd']);
        expect(orderBin(['a', 'b', 'c'], { failedBefore: [], diffCoverage: {}, durations })).toEqual(['b', 'c', 'a']);
    });
    it('a spec that failed before and covers the diff stays among the failed-before ones, by coverage', () => {
        expect(orderBin(['a', 'b', 'c'], { failedBefore: ['a', 'b'], diffCoverage: { b: 2 }, durations })).toEqual(['b', 'a', 'c']);
    });
    it('keeps every spec exactly once and invents none', () => {
        const order = orderBin(['a', 'b', 'c'], { failedBefore: ['zzz'], diffCoverage: { yyy: 4 }, durations });
        expect([...order].sort()).toEqual(['a', 'b', 'c']);
    });
    it('without any duration it keeps the order it was given for the rest', () => {
        expect(orderBin(['x', 'y', 'z'], { failedBefore: [], diffCoverage: {}, durations: {} })).toEqual(['x', 'y', 'z']);
    });
});

describe('orderBins', () => {
    it('reorders inside each bin and leaves which bin a spec is in as the balance decided', () => {
        const files = ['a', 'b', 'c', 'd', 'e'].map((path) => ({ path, sizeBytes: 1 }));
        const s = stats({ a: 600, b: 500, c: 400, d: 300, e: 200 });
        const plan = balanceSpecs(files, s, 3);
        const ordered = orderBins(plan, { failedBefore: ['e'], diffCoverage: {}, durations: { a: 600, b: 500, c: 400, d: 300, e: 200 } });
        expect(ordered.map((b) => [...b].sort())).toEqual(plan.bins.map((b) => [...b.specs].sort()));
        expect(ordered[1]).toEqual(['e', 'b']);
    });
});

describe('failFast', () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `s${i}`);
    const results = (failed: boolean[]) => failed.map((f, i) => ({ spec: `s${i}`, failed: f }));

    it('stops the first pass when 3 of the first 10 specs failed, and marks the rest not_run', () => {
        const r = failFast({ allSpecs: ids(100), finished: results([true, false, true, false, false, true, false, false, false, false]) });
        expect(r.stop).toBe(true);
        expect(r.notRun).toHaveLength(90);
        expect(r.notRun[0]).toBe('s10');
    });
    it('does not stop at 2 of the first 10', () => {
        const r = failFast({ allSpecs: ids(100), finished: results([true, false, true, false, false, false, false, false, false, false]) });
        expect(r).toEqual({ stop: false, notRun: [] });
    });
    it('stops as soon as the failures already exceed a quarter of the first batch', () => {
        const r = failFast({ allSpecs: ids(100), finished: results([true, true, true]) });
        expect(r.stop).toBe(true);
        expect(r.notRun).toHaveLength(97);
    });
    it('does not stop early on fewer failures than that', () => {
        expect(failFast({ allSpecs: ids(100), finished: results([true, true]) }).stop).toBe(false);
    });
    it('the first batch is at least 5 specs: a 20-spec suite looks at 5', () => {
        expect(failFast({ allSpecs: ids(20), finished: results([true, true]) }).stop).toBe(true); // 2 of 5 is 40%
        expect(failFast({ allSpecs: ids(20), finished: results([true, false, false, false, false]) }).stop).toBe(false); // 1 of 5 is 20%
    });
    it('only the first batch counts: failures later do not stop it', () => {
        const finished = results([...Array(10).fill(false), true, true, true, true, true]);
        expect(failFast({ allSpecs: ids(100), finished }).stop).toBe(false);
    });
    it('a suite smaller than the batch looks at all of it', () => {
        expect(failFast({ allSpecs: ids(3), finished: results([true, true, false]) }).stop).toBe(true);
    });
});

describe('failFast feeds the classifier', () => {
    it('a stopped first pass is a mass failure over the specs that ran, so nothing is re-run', () => {
        const allSpecs = Array.from({ length: 100 }, (_, i) => `s${i}`);
        const finished = [true, true, true, false, false, false, false, false, false, false].map((failed, i) => ({ spec: `s${i}`, failed }));
        expect(failFast({ allSpecs, finished }).stop).toBe(true);
        const failures = finished.filter((r) => r.failed).map((r) => ({ spec: r.spec, title: 't', kind: 'test' as const, timedOut: false, errorSignature: 'E' }));
        expect(planReruns({ specsRun: finished.length, failures })).toMatchObject({ massFailure: true, rerunSpecs: [] });
    });
});
