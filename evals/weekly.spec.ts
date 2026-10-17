import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { plan, report, PARTS, FULL_MODEL } = require('./weekly');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { WEEKLY_EVALS } = require('./nightly-evals');

type Job = { model: string; set: string; part: string; only: string; tests: boolean };

describe('evals/weekly.js', () => {
    it('puts every weekly eval in one part, and only those', () => {
        const parted = PARTS.flatMap((p: { evals: string[] }) => p.evals);
        expect(new Set(parted).size).toBe(parted.length);
        expect(parted.sort()).toEqual(WEEKLY_EVALS.map((e: { id: string }) => e.id).sort());
    });

    // Every tier-0 model on the controlled set; the nightly's model on the full set too.
    it('runs every part on every model, and the parts with a full set on DeepSeek again', () => {
        const jobs: Job[] = plan(['m1', FULL_MODEL]);
        expect(jobs.filter((j) => j.model === 'm1').map((j) => [j.set, j.part])).toEqual(PARTS.map((p: { part: string }) => ['controlled', p.part]));
        const full = jobs.filter((j) => j.set === 'full');
        expect(full.every((j) => j.model === FULL_MODEL)).toBe(true);
        expect(full.map((j) => j.only)).toEqual(['finder-recall', 'funnel-verify,funnel-dedup,funnel-severity', 'reply-addressing']);
        // The PR summary's contract runs on every model, once.
        expect(jobs.filter((j) => j.tests).map((j) => [j.model, j.set])).toEqual([['m1', 'controlled'], [FULL_MODEL, 'controlled']]);
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
});
