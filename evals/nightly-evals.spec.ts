// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require('fs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const os = require('os');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require('path');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { NIGHTLY_EVALS } = require('./nightly-evals');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { STAGES } = require('./stages');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { decide, pool, nextState } = require('./shared/nightly-verdict');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { plan } = require('./shared/nightly-plan');

const wiringSteps = Array.from(fs.readFileSync(path.join(__dirname, 'wiring-smoke.js'), 'utf8').matchAll(/\bname: '([a-z-]+)'/g), (m: RegExpMatchArray) => m[1]);

describe('evals/nightly-evals.js', () => {
    // An eval measured through the shared job is wired end to end, or the night
    // would measure it and the panel would never show it.
    it('ties every entry to its runner, its stage, its wiring step and its files', () => {
        expect(NIGHTLY_EVALS.length).toBeGreaterThan(0);
        for (const e of NIGHTLY_EVALS) {
            expect([e.id, fs.existsSync(path.join(__dirname, '..', e.run[0]))]).toEqual([e.id, true]);
            for (const f of e.files) expect([e.id, f, fs.existsSync(path.join(__dirname, '..', f))]).toEqual([e.id, f, true]);
            expect(wiringSteps).toContain(e.id);
            const stage = STAGES.find((s: { id: string }) => s.id === e.stage);
            expect([e.id, stage?.nightly, stage?.model]).toEqual([e.id, 'shared', 'real']);
        }
    });

    // Friday runs each entry on every tier-0 model, on a few cases.
    it('cuts every entry to a few cases for Friday', () => {
        for (const e of NIGHTLY_EVALS) expect([e.id, e.friday.some((a: string) => /^--limit=\d+$/.test(a))]).toEqual([e.id, true]);
    });

    it('lists every stage the shared job measures', () => {
        const shared = STAGES.filter((s: { nightly?: string }) => s.nightly === 'shared').map((s: { id: string }) => s.id);
        expect(shared.sort()).toEqual(NIGHTLY_EVALS.map((e: { stage: string }) => e.stage).sort());
    });
});

// Made-up floors: the real ones live only in each eval's targets file.
const result = (hits: number[], extra: Record<string, unknown> = {}) => ({
    eval: 'demo',
    question: 'Does it?',
    model: 'deepseek-v4-flash@fireworks',
    runs: 1,
    metric: { name: 'of cases right', value: hits.reduce((a, b) => a + b, 0) / (hits.length * 2), floor: 0.8, baseline: 0.9 },
    cases: hits.map((h, i) => ({ id: `c${i}`, checks: `Checks case ${i}`, hits: h, total: 2 })),
    tokens: { in: 1, out: 1 },
    infra: { errored: 0, total: hits.length },
    ...extra,
});

describe('evals/shared/nightly-verdict.js', () => {
    it('passes at the floor, calls an unconfirmed dip an oscillation, mentions only a confirmed new drop', () => {
        expect(decide({ first: result([2, 2, 2, 2, 2]) })).toMatchObject({ verdict: 'pass', mention: false });
        expect(decide({ first: result([1, 1, 2, 2, 1]), confirm: result([2, 2, 2, 2, 2]) })).toMatchObject({ verdict: 'oscillation', mention: false });
        expect(decide({ first: result([1, 1, 1, 2, 1]), confirm: result([1, 1, 1, 2, 1]) })).toMatchObject({ verdict: 'regression', mention: true });
    });

    it('keeps an alerted drop red without mentioning, unless it got worse, and never turns infra into a result', () => {
        const red = { verdict: 'regression', value: 0.6 };
        expect(decide({ first: result([1, 1, 1, 2, 1]), confirm: result([1, 1, 1, 2, 1]), previous: red })).toMatchObject({ verdict: 'still-red', mention: false });
        expect(decide({ first: result([0, 0, 1, 1, 1]), confirm: result([0, 0, 1, 1, 1]), previous: red })).toMatchObject({ verdict: 'regression', mention: true });
        expect(decide({ first: null })).toMatchObject({ verdict: 'infra' });
        expect(decide({ first: result([2, 2], { infra: { errored: 1, total: 2 } }) })).toMatchObject({ verdict: 'infra' });
        expect(nextState('infra', null, red)).toEqual(red);
    });

    it('never reports a model without a floor as a pass', () => {
        const noFloor = result([2, 2, 2, 2, 2]);
        noFloor.metric.floor = null as unknown as number;
        expect(decide({ first: noFloor })).toMatchObject({ verdict: 'ungated', mention: false });
    });

    it('pools the cases both runs measured into one metric', () => {
        const pooled = pool(result([2, 0]), result([2, 2]));
        expect(pooled.metric.value).toBeCloseTo(6 / 8);
        expect(pooled.cases.map((c: { hits: number; total: number }) => `${c.hits}/${c.total}`)).toEqual(['4/4', '2/4']);
    });
});

describe('evals/shared/nightly-plan.js', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightly-plan-'));
    const e = NIGHTLY_EVALS[0];
    const all = NIGHTLY_EVALS.map((x: { id: string }) => x.id);
    // Each entry's trace: its runner and an engine file of its own.
    for (const x of NIGHTLY_EVALS) fs.writeFileSync(path.join(dir, `${x.id}.txt`), `${x.run[0]}\nlibs/${x.id}/engine.ts\n`);
    const changed = (files: string[]) => {
        const f = path.join(dir, 'changed.txt');
        fs.writeFileSync(f, `${files.join('\n')}\n`);
        return f;
    };

    it('measures an eval whose files changed, a forced night, no baseline or an unknown diff, and skips the rest', () => {
        expect(plan({ filesDir: dir, changedFile: changed([`libs/${e.id}/engine.ts`]), base: 'abc' })).toEqual([e.id]);
        expect(plan({ filesDir: dir, changedFile: changed(['README.md']), base: 'abc' })).toEqual([]);
        expect(plan({ filesDir: dir, changedFile: changed([e.files[0]]), base: 'abc' })).toEqual([e.id]);
        expect(plan({ filesDir: dir, changedFile: changed(['README.md']), base: 'abc', force: true })).toEqual(all);
        expect(plan({ filesDir: dir, changedFile: changed(['README.md']), base: '' })).toEqual(all);
        expect(plan({ filesDir: dir, changedFile: path.join(dir, 'missing.txt'), base: 'abc' })).toEqual(all);
    });

    it('refuses to decide on a list without its runner', () => {
        fs.writeFileSync(path.join(dir, `${e.id}.txt`), 'libs/x/engine.ts\n');
        expect(() => plan({ filesDir: dir, changedFile: changed([]), base: 'abc' })).toThrow(/trace is incomplete/);
    });
});
