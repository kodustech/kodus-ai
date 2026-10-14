import * as fs from 'fs';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { STAGES, GROUPS, PLUMBING } = require('./stages');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { wiringRows, nightlyRows } = require('./stage-signals');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { tier0 } = require('./shared/tier0-models');

type Stage = { id: string; name: string; group: string; eval: string | null; model: string; wiring: string[]; pipeline: string[] | null; nightly?: boolean; friday?: string; byHand?: string[] };
type Row = { name: string; status: string; value: number | null; meta: Record<string, unknown> };

// Steps of evals/wiring-smoke.js that check the harness, not a review stage.
const NOT_A_STAGE = ['preflight'];

const wiringSteps = Array.from(
    fs.readFileSync(path.join(__dirname, 'wiring-smoke.js'), 'utf8').matchAll(/\bname: '([a-z-]+)'/g),
    (m) => m[1],
);

// The stages the review pipeline runs, read from its strategy's constructor.
const pipelineStages = Array.from(
    fs
        .readFileSync(path.join(__dirname, '../libs/code-review/pipeline/strategy/code-review-pipeline.strategy.ts'), 'utf8')
        .matchAll(/private readonly \w+: (\w+Stage)\b/g),
    (m) => m[1],
);

const allOk = (steps: string[]) => steps.map((step) => ({ step, ok: true, problem: null, ms: 1, calls: 1 }));

describe('evals/stages.js', () => {
    it('gives every stage a unique id that makes a valid signal name', () => {
        const ids = STAGES.map((s: Stage) => s.id);
        expect(new Set(ids).size).toBe(ids.length);
        for (const id of ids) expect(`evals.stage.${id}`).toMatch(/^[a-z0-9_-]+(\.[a-z0-9_-]+)+$/);
    });

    // The panel lists stages by group, one line each.
    it('gives every stage a short name and a group, with each group in one run', () => {
        for (const stage of STAGES as Stage[]) {
            expect(stage.name.length).toBeGreaterThan(0);
            expect(stage.name.length).toBeLessThanOrEqual(20);
            expect(GROUPS).toContain(stage.group);
        }
        const runs = (STAGES as Stage[]).map((s) => s.group).filter((g, i, all) => g !== all[i - 1]);
        expect(runs).toEqual(GROUPS);
    });

    // A new eval added to the wiring smoke without a stage would never reach the panel.
    it('claims every wiring smoke step, and names only steps that exist', () => {
        const claimed = STAGES.flatMap((s: Stage) => s.wiring);
        expect(wiringSteps.length).toBeGreaterThan(5);
        expect(wiringSteps.filter((step) => !claimed.includes(step) && !NOT_A_STAGE.includes(step))).toEqual([]);
        expect(claimed.filter((step: string) => !wiringSteps.includes(step))).toEqual([]);
    });

    // Adding a pipeline stage means saying how it is tested: a stage here, or plumbing.
    it('places every review pipeline stage in a stage or in PLUMBING, and nowhere else', () => {
        const staged = STAGES.flatMap((s: Stage) => s.pipeline || []);
        const plumbing = Object.keys(PLUMBING);
        expect(pipelineStages.length).toBeGreaterThan(10);
        expect(pipelineStages.filter((c) => !staged.includes(c) && !plumbing.includes(c))).toEqual([]);
        expect([...staged, ...plumbing].filter((c) => !pipelineStages.includes(c))).toEqual([]);
        expect(plumbing.filter((c) => staged.includes(c))).toEqual([]);
    });

    // The panel reads a Friday stage's outcome from this key of evals.tier0.<model>'s meta.
    it('names, for a Friday stage, a key the Friday check writes', () => {
        const tier0Meta = fs.readFileSync(path.join(__dirname, '../.github/workflows/code-review-evals-tier0.yml'), 'utf8').match(/out\(\\?"meta\\?", JSON\.stringify\(\{ review:.*$/m)?.[0] ?? '';
        expect(tier0Meta).not.toBe('');
        const keys = (STAGES as Stage[]).filter((s) => s.friday).map((s) => s.friday as string);
        expect(keys.sort()).toEqual(['pr_summary', 'review']);
        for (const key of keys) expect(tier0Meta).toContain(`${key}:`);
    });

    it('points every eval at a path that exists, and only "none" at no eval', () => {
        for (const stage of STAGES as Stage[]) {
            if (stage.model === 'none') expect(stage.eval).toBeNull();
            else expect(fs.existsSync(path.join(__dirname, '..', stage.eval as string))).toBe(true);
            for (const evalPath of stage.byHand ?? []) expect(fs.existsSync(path.join(__dirname, '..', evalPath))).toBe(true);
        }
    });
});

describe('stage-signals', () => {
    const scheduled = (STAGES as Stage[]).filter((s) => !s.nightly && s.wiring.length);

    it('reports every non-nightly stage from the wiring smoke, green when its steps pass', () => {
        const rows: Row[] = wiringRows(allOk(wiringSteps));
        expect(rows.map((r) => r.name).sort()).toEqual(
            (STAGES as Stage[]).filter((s) => !s.nightly).map((s) => `evals.stage.${s.id}`).sort(),
        );
        for (const stage of scheduled) expect(rows.find((r) => r.name === `evals.stage.${stage.id}`)?.status).toBe('green');
    });

    it('marks a stage with no scheduled eval as skipped, with its note', () => {
        const rows: Row[] = wiringRows(allOk(wiringSteps));
        const posting = rows.find((r) => r.name === 'evals.stage.posting');
        expect(posting?.status).toBe('skipped');
        expect(posting?.meta.note).toBe('no eval for this stage');
        expect(posting?.meta.order).toBe(STAGES.findIndex((s: Stage) => s.id === 'posting') + 1);
        expect(posting?.meta).toMatchObject({ name: 'Posting', group: 'On the PR' });
    });

    it('turns a failed step red and a step that did not run into infra', () => {
        const results = allOk(wiringSteps.filter((step) => step !== 'anchoring')).map((r) =>
            r.step === 'dedup-engine' ? { ...r, ok: false, problem: 'exit 1' } : r,
        );
        const rows: Row[] = wiringRows(results);
        const dedup = rows.find((r) => r.name === 'evals.stage.dedup');
        expect(dedup?.status).toBe('red');
        expect(dedup?.meta.reason).toBe('dedup-engine: exit 1');
        expect(rows.find((r) => r.name === 'evals.stage.anchoring')?.status).toBe('infra');
        expect(wiringRows(null).find((r: Row) => r.name === 'evals.stage.dedup')?.status).toBe('infra');
    });

    it('turns every wired stage into infra when the smoke fails a check no stage owns', () => {
        const results = [...allOk(wiringSteps), { step: 'pr-paths-filter', ok: false, problem: 'incomplete trace', ms: 0, calls: 0 }];
        const rows: Row[] = wiringRows(results);
        for (const stage of scheduled) expect(rows.find((r) => r.name === `evals.stage.${stage.id}`)?.status).toBe('infra');
        expect(rows.find((r) => r.name === 'evals.stage.dedup')?.meta.reason).toBe('wiring smoke failed: pr-paths-filter: incomplete trace');
        expect(rows.find((r) => r.name === 'evals.stage.posting')?.status).toBe('skipped');
        expect(wiringRows([...allOk(wiringSteps), { step: 'pr-paths-filter', ok: true, problem: null }]).find((r: Row) => r.name === 'evals.stage.dedup')?.status).toBe('green');
    });

    it('reports the finder from the nightly: recall against the floor, status from the verdict', () => {
        const nightly = {
            model: 'deepseek-v4-flash@fireworks',
            cases: 30,
            unmeasured: 0,
            metrics: { recall_mean: 0.4, precision_mean: 0.5 },
            gate: { checks: [{ name: 'recall_mean', floor: 0.24 }], observed: { recall_mean: 0.357 } },
        };
        const [finder]: Row[] = nightlyRows(nightly, 'regression');
        expect(finder).toMatchObject({ name: 'evals.stage.finder', status: 'red', value: 0.4 });
        expect(finder.meta).toMatchObject({ floor: 0.24, baseline: 0.357, precision: 0.5 });
        expect(nightlyRows(nightly, 'pass')[0].status).toBe('green');
        expect(nightlyRows(null, 'infra')[0]).toMatchObject({ status: 'infra', value: null });
    });

    it('lists the tier-0 models a Friday stage runs on, and no models for any other stage', () => {
        const nightly = { model: 'deepseek-v4-flash@fireworks', metrics: { recall_mean: 0.4 }, gate: {} };
        expect(nightlyRows(nightly, 'pass')[0].meta.friday).toEqual({ models: tier0(), result: 'review' });
        const rows: Row[] = wiringRows(allOk(wiringSteps));
        expect(rows.find((r) => r.name === 'evals.stage.pr-summary')?.meta.friday).toEqual({ models: tier0(), result: 'pr_summary' });
        expect(rows.find((r) => r.name === 'evals.stage.dedup')?.meta.friday).toBeUndefined();
    });
});
