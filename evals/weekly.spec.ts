import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { main, plan, report, finderVerdict, PARTS } = require('./weekly');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { WEEKLY_EVALS } = require('./nightly-evals');

type Job = { model: string; set: string; part: string; only: string; tests: boolean };

describe('evals/weekly.js', () => {
    it('puts every weekly eval in one part, and only those', () => {
        const parted = PARTS.flatMap((p: { evals: string[] }) => p.evals);
        expect(new Set(parted).size).toBe(parted.length);
        expect(parted.sort()).toEqual(WEEKLY_EVALS.map((e: { id: string }) => e.id).sort());
    });

    // Every tier-0 model on the controlled set; the full sets run on demand only.
    it('runs every part on every model, on the controlled set only', () => {
        const jobs: Job[] = plan(['m1', 'm2']);
        expect(jobs.filter((j) => j.model === 'm1').map((j) => [j.set, j.part])).toEqual(PARTS.map((p: { part: string }) => ['controlled', p.part]));
        expect(jobs.every((j) => j.set === 'controlled')).toBe(true);
        // The PR summary's contract runs on every model, once.
        expect(jobs.filter((j) => j.tests).map((j) => j.model)).toEqual(['m1', 'm2']);
    });

    it('reports red only for a confirmed drop, names what did not measure, and never calls an empty week green', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weekly-report-'));
        const write = (job: string, model: string, set: string, results: unknown[]) => {
            fs.mkdirSync(path.join(dir, job), { recursive: true });
            fs.writeFileSync(path.join(dir, job, 'summary.json'), JSON.stringify({ model, set, results }));
        };
        expect(report(dir)).toMatchObject({ status: 'cancelled', title: expect.stringContaining('no result') });
        write('weekly-0', 'm1', 'controlled', [{ id: 'conversation', stage: 'conversation', verdict: 'pass', value: 1, floor: 0.9 }, { id: 'format', stage: 'format', verdict: 'ungated', value: 0.9, floor: null }]);
        expect(report(dir)).toMatchObject({ status: 'success', title: expect.stringContaining('at or above') });
        write('weekly-1', 'm2', 'controlled', [{ id: 'kody-rules', stage: 'kody-rules', verdict: 'infra', value: null, floor: null }]);
        expect(report(dir)).toMatchObject({ status: 'cancelled', description: expect.stringContaining('`m2` kody-rules') });
        write('weekly-2', 'm2', 'full', [{ id: 'finder-recall', stage: 'finder', verdict: 'regression', value: 0.2, floor: 0.3 }]);
        const red = report(dir);
        expect(red.status).toBe('failure');
        expect(red.description.split('\n')[0]).toBe('🔴 `m2` finder (full set) 20% · floor 30%');
    });

    // A job that ended before its upload (install failure, timeout) leaves its evals not measured.
    it('names every planned eval whose job never reported as not measured', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weekly-report-'));
        fs.mkdirSync(path.join(dir, 'weekly-0'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'weekly-0', 'summary.json'), JSON.stringify({ model: 'm1', set: 'controlled', results: [{ id: 'finder-recall', stage: 'finder', verdict: 'pass', value: 0.5, floor: 0.3 }] }));
        const expected = plan(['m1']).filter((j: Job) => ['finder', 'funnel'].includes(j.part));
        expect(report(dir).status).toBe('success');
        const r = report(dir, expected);
        expect(r.status).toBe('cancelled');
        expect(r.title).toBe('⚠️ Weekly evals: 3 not measured');
        expect(r.description).toContain('⚠️ `m1` verify · its job ended before reporting');
        expect(r.description).not.toContain('finder');
    });

    // An uncalibrated model's finder run that did not measure is infra, not "no floor yet".
    it('calls a finder run ungated only when it measured within its budget', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weekly-finder-'));
        const first = path.join(dir, 'first.json');
        const files = { first, confirm: path.join(dir, 'confirm.json'), final: path.join(dir, 'final.json') };
        const gate = { status: 'skipped', reason: 'no target for m1 on the controlled set' };
        const measure = jest.fn();
        fs.writeFileSync(first, JSON.stringify({ metrics: { recall_mean: 0.4 }, unmeasured: 0, infraBudget: 1, gate }));
        expect(finderVerdict({}, 'controlled', files, 2, measure).verdict).toBe('ungated');
        fs.writeFileSync(first, JSON.stringify({ metrics: { recall_mean: 0.4 }, unmeasured: 9, infraBudget: 1, gate }));
        expect(finderVerdict({}, 'controlled', files, 2, measure).verdict).toBe('infra');
        fs.writeFileSync(first, JSON.stringify({ metrics: { recall_mean: null }, unmeasured: 15, infraBudget: 1, gate }));
        expect(finderVerdict({}, 'controlled', files, 2, measure).verdict).toBe('infra');
        expect(measure).not.toHaveBeenCalled();
    });

    // One eval that throws is that eval not measured; the job still writes its report.
    it('records an eval that throws as not measured and still writes the summary', () => {
        const out = fs.mkdtempSync(path.join(os.tmpdir(), 'weekly-out-'));
        fs.writeFileSync(path.join(out, 'format'), 'a file where the eval wants its directory');
        const argv = process.argv;
        const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
        try {
            process.argv = ['node', 'weekly.js', '--model=m1', '--set=controlled', '--only=format', `--out=${out}`];
            expect(main()).toBe(2);
        } finally {
            process.argv = argv;
            error.mockRestore();
        }
        const summary = JSON.parse(fs.readFileSync(path.join(out, 'summary.json'), 'utf8'));
        expect(summary.results).toEqual([expect.objectContaining({ id: 'format', verdict: 'infra' })]);
        const rows = JSON.parse(fs.readFileSync(path.join(out, 'rows.json'), 'utf8'));
        expect(rows).toEqual([expect.objectContaining({ status: 'infra' })]);
    });
});
