// eslint-disable-next-line @typescript-eslint/no-require-imports
const { evalQuestion, resultProblems, poolCases, signalCases, MAX_DETAIL } = require('./eval-result');

const ok = {
    eval: 'kody-rules',
    question: 'Does the Kody Rules agent flag every place a rule is broken?',
    model: 'deepseek-v4-flash@fireworks',
    metric: { name: 'occurrence recall', value: 0.9 },
    cases: [{ id: 'a', checks: 'Flags every line that breaks "x" in r#1', hits: 3, total: 4 }],
};

describe('evals/shared/eval-result', () => {
    it("reads an eval's question from its README", () => {
        expect(evalQuestion('evals/kody-rules')).toBe('Does the Kody Rules agent flag every place a rule is broken?');
        expect(evalQuestion('evals/does-not-exist')).toBeNull();
        expect(evalQuestion(null)).toBeNull();
    });

    it('accepts a result in the shared shape and names what is missing otherwise', () => {
        expect(resultProblems(ok)).toEqual([]);
        expect(resultProblems({ ...ok, question: null })).toEqual(['missing question']);
        expect(resultProblems({ ...ok, cases: [{ id: 'a', hits: 5, total: 4 }] })).toEqual(['case a: no checks sentence', 'case a: hits/total 5/4']);
        expect(resultProblems({ ...ok, cases: [] })).toEqual(['no cases']);
        expect(resultProblems({ ...ok, cases: 14 })).toEqual(['no cases']);
    });

    it('pools two runs by case id: counts summed, an item ok only when ok in both', () => {
        const a = [{ id: 'a', checks: 'c', hits: 2, total: 2, detail: [{ what: 'x', ok: true }, { what: 'y', ok: true }] }];
        const b = [{ id: 'a', checks: 'c', hits: 1, total: 2, detail: [{ what: 'x', ok: true }, { what: 'y', ok: false }] }];
        expect(poolCases(a, b)).toEqual([{ id: 'a', checks: 'c', hits: 3, total: 4, detail: [{ what: 'x', ok: true }, { what: 'y', ok: false }] }]);
        // a case only one run has is not pooled from a single run
        expect(poolCases([...a, { id: 'only-a', checks: 'c', hits: 1, total: 1 }], [...b, { id: 'only-b', checks: 'c', hits: 1, total: 1 }]).map((c: { id: string }) => c.id)).toEqual(['a']);
    });

    it('keeps every case in the signal but caps its detail and long text', () => {
        const detail = Array.from({ length: MAX_DETAIL + 3 }, (_, i) => ({ what: `${'x'.repeat(300)}${i}`, ok: i % 2 === 0 }));
        const [c] = signalCases([{ id: 'a', checks: 'c', hits: 1, total: 15, detail }]);
        expect(c.detail).toHaveLength(MAX_DETAIL);
        expect(c.more).toBe(3);
        expect(c.detail[0].what.length).toBeLessThanOrEqual(160);
        expect(signalCases([{ id: 'b', checks: 'c', hits: 0, total: 0, unmeasured: true }])[0].unmeasured).toBe(true);
    });
});
