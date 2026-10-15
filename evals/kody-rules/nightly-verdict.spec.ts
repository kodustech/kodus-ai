// eslint-disable-next-line @typescript-eslint/no-require-imports
const { decide, pool, nextState } = require('./nightly-verdict');

// Made-up floors: the real ones live only in kody-targets.json.
const floors = { occurrenceRecall: 0.8, specificity: 0.9 };
const run = (caught: number, extra: { falseAlarmFiles?: number; errored?: number; sites?: number; flagged?: number; offSite?: number } = {}) => {
    const sites = extra.sites ?? 43;
    const cleanFiles = 138;
    const falseAlarmFiles = extra.falseAlarmFiles ?? 0;
    return {
        eval: 'kody-rules',
        question: 'Does the Kody Rules agent flag every place a rule is broken?',
        model: 'deepseek-v4-flash@fireworks',
        runs: 1,
        metric: { name: 'occurrence recall', value: sites ? caught / sites : null, floor: floors.occurrenceRecall, baseline: 0.9 },
        specificity: { value: (cleanFiles - falseAlarmFiles) / cleanFiles, floor: floors.specificity, baseline: 1 },
        linePrecision: 1,
        counts: { sites, caught, flagged: extra.flagged ?? caught, offSite: extra.offSite ?? 0, cleanFiles, falseAlarmFiles },
        cases: [{ id: 'repo#1::rule', checks: 'Flags every line that breaks "rule" in repo#1', hits: caught, total: sites, detail: [{ what: 'a.ts:1', ok: caught === sites }] }],
        tokens: { in: 100, out: 10, cacheRead: 0, cacheWrite: 0 },
        infra: { errored: extra.errored ?? 0, total: 14 },
    };
};

describe('kody-rules nightly verdict', () => {
    it('passes a first run at or above both floors, without a second run', () => {
        expect(decide({ first: run(40) })).toMatchObject({ verdict: 'pass', mention: false });
    });

    it('calls a dip that the pooled runs do not confirm an oscillation', () => {
        const out = decide({ first: run(33), confirm: run(42) });
        expect(out).toMatchObject({ verdict: 'oscillation', mention: false });
        expect(out.final.counts).toMatchObject({ sites: 86, caught: 75 });
        expect(out.final.cases[0]).toMatchObject({ hits: 75, total: 86 });
    });

    it('mentions people only for a confirmed new drop', () => {
        expect(decide({ first: run(30), confirm: run(31) })).toMatchObject({ verdict: 'regression', mention: true });
    });

    it('keeps a drop that already alerted red without mentioning, unless it got worse', () => {
        const previous = { verdict: 'regression', occurrenceRecall: 0.72 };
        expect(decide({ first: run(30), confirm: run(31), previous })).toMatchObject({ verdict: 'still-red', mention: false });
        expect(decide({ first: run(25), confirm: run(26), previous })).toMatchObject({ verdict: 'regression', mention: true });
    });

    it('fails on clean files flagged even when recall holds', () => {
        const noisy = (caught: number) => run(caught, { falseAlarmFiles: 20 });
        expect(decide({ first: noisy(42), confirm: noisy(42) })).toMatchObject({ verdict: 'regression' });
    });

    it('never turns a run that did not measure into a quality result', () => {
        expect(decide({ first: null })).toMatchObject({ verdict: 'infra', mention: false });
        expect(decide({ first: run(0, { errored: 10 }) })).toMatchObject({ verdict: 'infra', mention: false });
        expect(decide({ first: run(30), confirm: null })).toMatchObject({ verdict: 'infra', mention: false });
    });

    it('keeps the last measured state through a night that did not measure, so a drop does not alert twice', () => {
        const red = { verdict: 'regression', occurrenceRecall: 0.7, specificity: 1 };
        const kept = nextState('infra', null, red);
        expect(kept).toEqual(red);
        expect(decide({ first: run(30), confirm: run(31), previous: kept })).toMatchObject({ verdict: 'still-red', mention: false });
        expect(nextState('infra', null, null)).toMatchObject({ verdict: 'infra' });
        expect(nextState('pass', run(40), red)).toMatchObject({ verdict: 'pass', occurrenceRecall: 40 / 43 });
    });

    it('writes results in the shape every eval writes', () => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { resultProblems } = require('../shared/eval-result');
        expect(resultProblems(run(40))).toEqual([]);
        expect(resultProblems(decide({ first: run(30), confirm: run(31) }).final)).toEqual([]);
    });

    it('pools counts, not rates', () => {
        const pooled = pool(run(43), run(30, { flagged: 32, offSite: 2 }));
        expect(pooled.metric.value).toBeCloseTo(73 / 86);
        expect(pooled.linePrecision).toBeCloseTo((75 - 2) / 75);
        expect(pooled.tokens.in).toBe(200);
        expect(pooled.cases[0].detail[0].ok).toBe(false);
    });
});
