/**
 * suggestion-enrichment scores what ships: the title the stage resolves, the fix
 * the publication gate keeps, and each metric over the cases it covers.
 */
const { shipped, scoreCase, metricsOf, belowFloors } = require('./run');
const { casesOf } = require('./catalog');

const pass = { titleNamesProblem: true, titleReason: '', fix: 'PASS', fixReason: '' };

describe('suggestion-enrichment scoring', () => {
    it('ships the model title without a trailing period, or the first sentence when it wrote none', () => {
        expect(shipped({ oneSentenceSummary: 'Total ignores quantity.', suggestionContent: 'x' }).title).toBe('Total ignores quantity');
        const fallback = shipped({ suggestionContent: 'The total ignores the quantity. It is wrong.' });
        expect(fallback.title).toBe('The total ignores the quantity');
        expect(fallback.wroteTitle).toBe(false);
    });

    it('ships no code the publication gate drops', () => {
        expect(shipped({ existingCode: 'a = 1', improvedCode: 'a = 1', language: 'python' }).code).toBeNull();
        expect(shipped({ existingCode: 'a = 1', improvedCode: 'a = 2', language: 'python' }).code).toBe('a = 2');
        expect(shipped({ existingCode: 'a = 1' }).code).toBeNull();
    });

    it('counts a title right only when the judge passes it and it fits 80 characters', () => {
        const c = { mustFix: true };
        expect(scoreCase(c, { title: 'Short title', code: 'x' }, pass).title).toBe(true);
        expect(scoreCase(c, { title: 'x'.repeat(81), code: 'x' }, pass).title).toBe(false);
        expect(scoreCase(c, { title: 'Short title', code: 'x' }, { ...pass, titleNamesProblem: false }).title).toBe(false);
    });

    it('scores a fixable finding on its fix and the others on shipping no code', () => {
        expect(scoreCase({ mustFix: true }, { title: 't', code: null }, pass)).toMatchObject({ fix: false, noCode: null });
        expect(scoreCase({ mustFix: true }, { title: 't', code: 'x' }, pass)).toMatchObject({ fix: true, noCode: null });
        expect(scoreCase({ mustFix: false }, { title: 't', code: null }, pass)).toMatchObject({ fix: null, noCode: true });
        expect(scoreCase({ mustFix: false }, { title: 't', code: 'x' }, pass)).toMatchObject({ fix: null, noCode: false });
    });

    it('reports each metric over its cases and the floors it falls below', () => {
        const metrics = metricsOf([
            { fix: true, noCode: null, title: true },
            { fix: false, noCode: null, title: true },
            { fix: null, noCode: true, title: false },
            { unmeasured: true },
        ]);
        expect(metrics.fix).toEqual({ right: 1, total: 2, value: 0.5 });
        expect(metrics.noCode).toEqual({ right: 1, total: 1, value: 1 });
        expect(metrics.title.value).toBeCloseTo(2 / 3);
        expect(belowFloors(metrics, { fix: { floor: 0.8 }, noCode: { floor: 0.8 }, title: { floor: 0.6 } })).toEqual(['fix 50.0% < 80%']);
    });

    it('pairs the cases: 100 must get a fix, 50 must get none', () => {
        const cases = casesOf();
        expect(cases).toHaveLength(150);
        expect(cases.filter((c: any) => c.mustFix)).toHaveLength(100);
    });
});
