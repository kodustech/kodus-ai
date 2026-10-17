// eslint-disable-next-line @typescript-eslint/no-require-imports
const { compare, decide } = require('./experiment');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { pairsOf, scoreCase } = require('./dedup-groups/run');

type Case = { id: string; checks: string; hits: number; total: number; unmeasured?: boolean };
const run = (cases: Case[]) => ({ cases });
const c = (id: string, hits: number, total: number): Case => ({ id, checks: `checks ${id}`, hits, total });

describe('evals/experiment.js compare', () => {
    it('calls two identical sides a tie with no difference', () => {
        const side = [run([c('a', 3, 4), c('b', 2, 2), c('c', 1, 3)]), run([c('a', 3, 4), c('b', 2, 2), c('c', 1, 3)])];
        const r = compare(side, side);
        expect(r).toMatchObject({ cases: 3, diff: 0, verdict: 'tie', worse: [], better: [] });
    });

    it('calls a candidate better only when the interval over the cases clears zero', () => {
        const ids = Array.from({ length: 20 }, (_, i) => `pr${i}`);
        const base = [run(ids.map((id) => c(id, 2, 4))), run(ids.map((id) => c(id, 2, 4)))];
        const cand = [run(ids.map((id) => c(id, 4, 4))), run(ids.map((id) => c(id, 4, 4)))];
        const r = compare(base, cand);
        expect(r.verdict).toBe('better');
        expect(r.diff).toBeCloseTo(0.5);
        expect(r.ci[0]).toBeGreaterThan(0);
        expect(r.better).toHaveLength(20);
    });

    it('pairs only the cases both sides measured in every run', () => {
        const base = [run([c('a', 1, 2), c('b', 2, 2)]), run([c('a', 1, 2), { ...c('b', 0, 0), unmeasured: true }])];
        const cand = [run([c('a', 2, 2), c('b', 0, 2)]), run([c('a', 2, 2), c('b', 0, 2)])];
        const r = compare(base, cand);
        expect(r.cases).toBe(1);
        expect(r.base).toBeCloseTo(0.5);
        expect(r.candidate).toBe(1);
    });

    it('lists a case that got worse, and a guard with one blocks the decision', () => {
        const base = [run([c('a', 2, 2), c('b', 1, 1)])];
        const cand = [run([c('a', 1, 2), c('b', 1, 1)])];
        const guard = compare(base, cand);
        expect(guard.worse.map((x: { id: string }) => x.id)).toEqual(['a']);
        const primary = { id: 'p', comparison: { verdict: 'better', worse: [] } };
        const usage = { usage: { in: 1, out: 1 } };
        expect(decide('dedup', primary, [{ id: 'g', comparison: guard }], { base: usage, candidate: usage }, { base: { step: 'x' }, candidate: { step: 'y' } }).decision).toBe('does not ship');
        expect(decide('dedup', primary, [], { base: usage, candidate: usage }, { base: { step: 'x' }, candidate: { step: 'x' } }).decision).toBe('no change in this step');
        expect(decide('dedup', primary, [], { base: usage, candidate: usage }, { base: { step: 'x' }, candidate: { step: 'y' } }).decision).toBe('ships');
    });
});

describe('evals/dedup-groups scoring', () => {
    const testCase = {
        id: 'pool/pr',
        groups: [['S1', 'S2', 'S3'], ['S4'], ['S5']],
        suggestions: ['S1', 'S2', 'S3', 'S4', 'S5'].map((id) => ({ id, suggestionContent: `text of ${id}` })),
    };

    it('counts every pair inside a group once', () => {
        expect([...pairsOf([['S2', 'S1', 'S3'], ['S4']])]).toEqual(['S1|S2', 'S1|S3', 'S2|S3']);
    });

    it('scores the gold pairs joined and the merges the gold keeps apart', () => {
        // The dedup kept S1 with S2 merged into it, and merged S5 into S4.
        const r = scoreCase(testCase, { groups: [[0, 1], [3, 4]], kept: [0, 2, 3], status: 'success' });
        expect(r).toMatchObject({ hits: 1, total: 3, falseMerges: 1, falseMergePairs: ['S4|S5'], kept: 3, goldGroups: 3 });
    });
});
