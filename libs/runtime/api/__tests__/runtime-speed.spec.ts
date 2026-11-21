import { GetRuntimeSpeedUseCase } from '../application/use-cases/runtime-speed.use-case';
import { buildRuntimeSpeed, nearestRank, SPEED_MIN_RUNS, type SpeedRunRow } from '../domain/runtime-speed';

const NOW = new Date('2026-11-17T12:00:00.000Z');
const T0 = Date.parse('2026-11-16T10:00:00.000Z');
const at = (ms: number) => new Date(T0 + ms).toISOString();

/** A Run that reached a verdict: queued `queueMs`, both sides probed `readyMs` after the request, verdict `verdictMs` after it. */
const run = (i: number, over: Partial<SpeedRunRow> & { queueMs?: number; readyMs?: number; verdictMs?: number } = {}): SpeedRunRow => {
    const { queueMs = 1_000, readyMs = 30_000, verdictMs = 120_000, ...rest } = over;
    return {
        runId: `run-${i}`,
        environmentId: 'env-a',
        state: 'no_regressions',
        requestedAt: at(0),
        startedAt: at(queueMs),
        finishedAt: at(verdictMs),
        firstProbeAt: { base: at(readyMs - 5_000), pr: at(readyMs) },
        sideStarts: ['pool', 'pool'],
        sideOwners: ['kodus', 'kodus'],
        ...rest,
    };
};
const many = (n: number, f: (i: number) => SpeedRunRow) => Array.from({ length: n }, (_, i) => f(i));

describe('nearestRank', () => {
    it('picks the value at rank ceil(p/100 * n) of the sorted values', () => {
        const values = [5, 1, 4, 2, 3, 10, 9, 8, 7, 6];
        expect(nearestRank(values, 50)).toBe(5);
        expect(nearestRank(values, 95)).toBe(10);
        expect(nearestRank([42], 95)).toBe(42);
    });

    it('has no value for no values', () => {
        expect(nearestRank([], 50)).toBeNull();
    });
});

describe('buildRuntimeSpeed', () => {
    it('gives p50/p95 of request to verdict, request to both sides ready and queue wait, with n', () => {
        const rows = many(20, (i) => run(i, { verdictMs: (i + 1) * 10_000, readyMs: (i + 1) * 1_000 + 5_000, queueMs: i + 1 }));
        const speed = buildRuntimeSpeed({ rows, windowDays: 7, now: NOW });
        expect(speed.all.verdict).toEqual({ n: 20, tooFew: false, p50Ms: 100_000, p95Ms: 190_000 });
        expect(speed.all.ready).toEqual({ n: 20, tooFew: false, p50Ms: 15_000, p95Ms: 24_000 });
        expect(speed.all.queue).toEqual({ n: 20, tooFew: false, p50Ms: 10, p95Ms: 19 });
    });

    it('shows "too few Runs" instead of a number for a bucket under 20 Runs, and still says how many', () => {
        const speed = buildRuntimeSpeed({ rows: many(SPEED_MIN_RUNS - 1, (i) => run(i)), windowDays: 7, now: NOW });
        expect(speed.all.verdict).toEqual({ n: 19, tooFew: true, p50Ms: null, p95Ms: null });
    });

    it('leaves cancelled, superseded, skipped, unfinished and verdict-less Runs out and counts each reason', () => {
        const rows = [
            ...many(20, (i) => run(i)),
            run(100, { state: 'cancelled' }),
            run(101, { state: 'superseded' }),
            run(102, { state: 'skipped' }),
            run(103, { state: 'testing', finishedAt: null }),
            run(104, { state: 'awaiting_approval', finishedAt: null }),
            run(105, { state: 'errored' }),
            run(106, { state: 'timed_out' }),
            run(107, { state: 'halted' }),
        ];
        const speed = buildRuntimeSpeed({ rows, windowDays: 7, now: NOW });
        expect(speed.considered).toBe(28);
        expect(speed.counted).toBe(20);
        expect(speed.excluded).toEqual({ cancelledOrSuperseded: 2, skipped: 1, unfinished: 2, noVerdict: 3 });
        expect(speed.all.verdict.n).toBe(20);
    });

    it('leaves a Run out of a number whose timestamps it lacks, and counts it as missing for that number only', () => {
        const rows = [
            ...many(20, (i) => run(i)),
            run(200, { firstProbeAt: { base: at(1_000) } }), // the PR side never ran a probe
            run(201, { state: 'nothing_to_test', firstProbeAt: {} }),
            run(202, { startedAt: null }),
            run(203, { finishedAt: at(-5) }), // a clock that went back is no duration
        ];
        const speed = buildRuntimeSpeed({ rows, windowDays: 7, now: NOW });
        expect(speed.missing).toEqual({ verdict: 1, ready: 2, queue: 1 });
        expect(speed.all.verdict.n).toBe(23);
        expect(speed.all.ready.n).toBe(22);
        expect(speed.all.queue.n).toBe(23);
    });

    it('splits by machine source: warm pool when every side came from the pool, cold boot when any side booted cold', () => {
        const rows = [
            ...many(20, (i) => run(i, { readyMs: 10_000 })),
            ...many(20, (i) => run(100 + i, { readyMs: 90_000, sideStarts: ['pool', 'cold'] })),
            run(300, { sideStarts: ['bake', 'pool'] }),
            run(301, { sideStarts: [null, 'pool'] }),
            run(302, { sideStarts: [] }),
        ];
        const speed = buildRuntimeSpeed({ rows, windowDays: 7, now: NOW });
        expect(speed.bySource.warm_pool.ready).toEqual({ n: 20, tooFew: false, p50Ms: 10_000, p95Ms: 10_000 });
        expect(speed.bySource.cold_boot.ready).toEqual({ n: 20, tooFew: false, p50Ms: 90_000, p95Ms: 90_000 });
        expect(speed.bySource.baked.ready.n).toBe(1);
        expect(speed.bySource.unknown.ready.n).toBe(2);
    });

    it("splits by host: Kodus cloud when every side ran on a Kodus cell, own host when any ran on the customer's", () => {
        const rows = [run(1), run(2, { sideOwners: ['customer', 'customer'] }), run(3, { sideOwners: ['kodus', 'customer'] }), run(4, { sideOwners: [null] })];
        const speed = buildRuntimeSpeed({ rows, windowDays: 7, now: NOW });
        expect(speed.byHost.kodus_cloud.verdict.n).toBe(1);
        expect(speed.byHost.own_host.verdict.n).toBe(2);
        expect(speed.byHost.unknown.verdict.n).toBe(1);
    });

    it('splits by environment, the busiest first', () => {
        const rows = [run(1, { environmentId: 'env-b' }), run(2), run(3), run(4, { environmentId: null })];
        const speed = buildRuntimeSpeed({ rows, windowDays: 7, now: NOW });
        expect(speed.byEnvironment.map((e) => [e.environmentId, e.verdict.n])).toEqual([
            ['env-a', 2],
            ['env-b', 1],
            [null, 1],
        ]);
    });

    it('names the window it covers', () => {
        const speed = buildRuntimeSpeed({ rows: [], windowDays: 30, now: NOW, truncated: true });
        expect(speed).toMatchObject({ windowDays: 30, since: '2026-10-18T12:00:00.000Z', until: NOW.toISOString(), minRuns: 20, truncated: true, considered: 0 });
        expect(speed.all.verdict).toEqual({ n: 0, tooFew: true, p50Ms: null, p95Ms: null });
    });
});

describe('GetRuntimeSpeedUseCase', () => {
    const user = { organization: { uuid: 'org-1' } } as any;
    const reader = (rows: SpeedRunRow[] = []) => ({ speedRuns: jest.fn(async () => rows) });

    it("reads the caller's org over the window it names, 7 days by default", async () => {
        const r = reader();
        await new GetRuntimeSpeedUseCase(r, () => NOW).execute({ user });
        await new GetRuntimeSpeedUseCase(r, () => NOW).execute({ user, windowDays: '30' });
        expect(r.speedRuns).toHaveBeenNthCalledWith(1, 'org-1', new Date('2026-11-10T12:00:00.000Z'), 10_000);
        expect(r.speedRuns).toHaveBeenNthCalledWith(2, 'org-1', new Date('2026-10-18T12:00:00.000Z'), 10_000);
    });

    it('refuses a window other than 7 or 30 days', async () => {
        await expect(new GetRuntimeSpeedUseCase(reader(), () => NOW).execute({ user, windowDays: '90' })).rejects.toThrow('windowDays must be one of 7, 30');
    });

    it('answers 404 without an organization', async () => {
        await expect(new GetRuntimeSpeedUseCase(reader(), () => NOW).execute({ user: {} })).rejects.toThrow('Organization not found');
    });
});
