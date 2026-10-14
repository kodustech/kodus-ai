import * as fs from 'fs';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { STAGES } = require('./stages');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { wiringRows, nightlyRows } = require('./stage-signals');

type Stage = { id: string; eval: string | null; model: string; wiring: string[]; nightly?: boolean };
type Row = { name: string; status: string; value: number | null; meta: Record<string, unknown> };

// Steps of evals/wiring-smoke.js that check the harness, not a review stage.
const NOT_A_STAGE = ['preflight'];

const wiringSteps = Array.from(
    fs.readFileSync(path.join(__dirname, 'wiring-smoke.js'), 'utf8').matchAll(/\bname: '([a-z-]+)'/g),
    (m) => m[1],
);

const allOk = (steps: string[]) => steps.map((step) => ({ step, ok: true, problem: null, ms: 1, calls: 1 }));

describe('evals/stages.js', () => {
    it('gives every stage a unique id that makes a valid signal name', () => {
        const ids = STAGES.map((s: Stage) => s.id);
        expect(new Set(ids).size).toBe(ids.length);
        for (const id of ids) expect(`evals.stage.${id}`).toMatch(/^[a-z0-9_-]+(\.[a-z0-9_-]+)+$/);
    });

    // A new eval added to the wiring smoke without a stage would never reach the panel.
    it('claims every wiring smoke step, and names only steps that exist', () => {
        const claimed = STAGES.flatMap((s: Stage) => s.wiring);
        expect(wiringSteps.length).toBeGreaterThan(5);
        expect(wiringSteps.filter((step) => !claimed.includes(step) && !NOT_A_STAGE.includes(step))).toEqual([]);
        expect(claimed.filter((step: string) => !wiringSteps.includes(step))).toEqual([]);
    });

    it('points every eval at a folder that exists, and only "none" at no eval', () => {
        for (const stage of STAGES as Stage[]) {
            if (stage.model === 'none') expect(stage.eval).toBeNull();
            else expect(fs.existsSync(path.join(__dirname, '..', stage.eval as string))).toBe(true);
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
});
