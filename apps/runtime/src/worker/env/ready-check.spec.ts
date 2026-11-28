import { exitedMessage, readyTarget, readyWaitSeconds, resetTimeoutMs, RUN_READY_INTERVAL_MS, STABLE_ERROR_TRIES, STABLE_ERROR_WINDOW_MS, waitUntilReady } from './ready-check';

const unreachable = { code: 'vm_unhealthy', stepId: 's', vmHealth: 'unreachable' } as const;
const exitedApp = { name: 'grafana', state: 'exited', exitCode: 1, logTail: ['seed failed: relation "x" does not exist'] };
const answered = (status: number) => ({ stepId: 's', http: { status } }) as any;

describe('ready check', () => {
    it('targets the public http service, else the first http one, with the recipe path and a bounded wait', () => {
        const expose = [
            { service: 'db', port: 5432, kind: 'postgres' },
            { service: 'web', port: 80, kind: 'http' },
            { service: 'grafana', port: 3000, kind: 'http' },
        ];
        expect(readyTarget(expose, { public: 'grafana', health: '/api/health', healthTimeoutSeconds: 60 })).toEqual({ service: 'grafana', port: 3000, path: '/api/health', waitSeconds: 60 });
        expect(readyTarget(expose, {}, '/ping')).toEqual({ service: 'web', port: 80, path: '/ping', waitSeconds: 120 });
        expect(readyTarget([{ service: 'db', port: 5432, kind: 'postgres' }], {})).toBeUndefined();
        expect(readyWaitSeconds(5_000)).toBe(900);
    });

    it("a round's reset may take as long as the recipe lets the app start, never less than two minutes", () => {
        expect(resetTimeoutMs({ waitSeconds: 900 })).toBe(900_000);
        expect(resetTimeoutMs({ waitSeconds: 60 })).toBe(120_000);
        expect(resetTimeoutMs(undefined)).toBe(120_000);
        expect(resetTimeoutMs({ waitSeconds: 5_000 })).toBe(900_000);
    });

    it('asks again while nothing listens and stops at the first answer under 500', async () => {
        let clock = 0;
        const outs = [unreachable, answered(503), answered(200)];
        const probe = jest.fn(async () => outs.shift() as any);
        const r = await waitUntilReady({
            env: { probe },
            claimId: 'c',
            target: { service: 'grafana', port: 3000, path: '/api/health', waitSeconds: 60 },
            who: { id: 'run-ready', purpose: 'p' },
            stepIdOf: (i) => `step-${i}`,
            now: () => clock,
            sleep: async (ms) => {
                clock += ms;
            },
        });
        expect(r).toMatchObject({ ready: true, tries: 3, waitedMs: 10_000 });
        expect(probe.mock.calls.map((c: any[]) => c[2])).toEqual(['step-0', 'step-1', 'step-2']);
    });

    // kr-remix on release v1l: a cell that predates the fix reads a port still starting as a lost transport.
    it('asks again after a lost transport, and stops at once when the cell itself is gone', async () => {
        const run = async (outs: unknown[]) => {
            let clock = 0;
            const probe = jest.fn(async () => outs.shift() as any);
            const r = await waitUntilReady({
                env: { probe },
                claimId: 'c',
                target: { service: 'app', port: 44100, path: '/', waitSeconds: 60 },
                who: { id: 'run-ready', purpose: 'p' },
                stepIdOf: (i) => `step-${i}`,
                now: () => clock,
                sleep: async (ms) => {
                    clock += ms;
                },
            });
            return r;
        };
        expect(await run([{ code: 'transport_lost', stepId: 's' }, answered(200)])).toMatchObject({ ready: true, tries: 2 });
        expect(await run([{ code: 'cell_unavailable', cellId: 'cell-1' }, answered(200)])).toMatchObject({ ready: false, tries: 1 });
    });

    it('at a one-second cadence, an app that comes up is asked within a second of it', async () => {
        let clock = 0;
        const upAt = 80_300; // demo-twenty's app listens again about 80 s after a reset
        const probe = jest.fn(async () => (clock >= upAt ? answered(200) : unreachable) as any);
        const r = await waitUntilReady({
            env: { probe },
            claimId: 'c',
            target: { service: 'server', port: 3000, path: '/healthz', waitSeconds: 300 },
            who: { id: 'run-ready', purpose: 'p' },
            stepIdOf: (i) => `s${i}`,
            now: () => clock,
            sleep: async (ms) => {
                clock += ms;
            },
            intervalMs: RUN_READY_INTERVAL_MS,
        });
        expect(r.ready).toBe(true);
        expect(r.waitedMs - upAt).toBeLessThan(1_000);
    });

    it('gives up when the next try would start past the wait', async () => {
        let clock = 0;
        const probe = jest.fn(async () => unreachable as any);
        const r = await waitUntilReady({
            env: { probe },
            claimId: 'c',
            target: { service: 'grafana', port: 3000, path: '/', waitSeconds: 12 },
            who: { id: 'run-ready', purpose: 'p' },
            stepIdOf: (i) => `s${i}`,
            now: () => clock,
            sleep: async (ms) => {
                clock += ms;
            },
        });
        expect(r.ready).toBe(false);
        expect(r.tries).toBe(3);
    });

    describe('a stable 5xx after a reset', () => {
        const run = (answers: Array<number | 'down'>, acceptStableError: boolean, waitSeconds = 600, intervalMs?: number, started: { answeredBefore?: boolean; bootMs?: number } = { answeredBefore: true }) => {
            let clock = 0;
            let n = 0;
            const probe = jest.fn(async (_c: string, _p: unknown, stepId: string) => {
                const a = answers[Math.min(n++, answers.length - 1)];
                return a === 'down' ? { code: 'vm_unhealthy', stepId } : { stepId, http: { status: a, headers: {}, body: '' } };
            });
            return waitUntilReady({
                env: { probe } as any,
                claimId: 'c',
                target: { service: 'grafana', port: 3000, path: '/api/health', waitSeconds, ...(started.bootMs ? { bootMs: started.bootMs } : {}) },
                who: { id: 'run-ready', purpose: 'p' },
                stepIdOf: (i) => `s${i}`,
                ...(started.answeredBefore ? { answeredBefore: true } : {}),
                now: () => clock,
                sleep: async (ms) => {
                    clock += ms;
                },
                acceptStableError,
                ...(intervalMs ? { intervalMs } : {}),
            });
        };

        it("at a Run's one-second cadence, the same 5xx still has to last the whole window", async () => {
            const r = await run(['down', 503], true, 600, RUN_READY_INTERVAL_MS);
            expect(r).toMatchObject({ ready: true, stableError: 503 });
            // Not six tries six seconds apart: the 5xx answered for the 25 s the five-second cadence needed.
            expect(r.tries).toBe(1 + STABLE_ERROR_WINDOW_MS / RUN_READY_INTERVAL_MS + 1);
        });

        it('in a Run, the same 5xx in a row means the app is up and answers it: the round measures it', async () => {
            const r = await run(['down', 'down', 503], true);
            expect(r).toMatchObject({ ready: true, stableError: 503, tries: 2 + STABLE_ERROR_TRIES });
        });

        it('a 5xx that changes, or an app that stops listening, starts the count again', async () => {
            const r = await run(['down', 502, 502, 'down', 503, 503, 503, 503, 503, 503, 200], true);
            expect(r).toMatchObject({ ready: true, stableError: 503 });
            expect(r.tries).toBe(10);
        });

        it('a setup never accepts a 5xx as ready', async () => {
            const r = await run([503], false, 60);
            expect(r.ready).toBe(false);
            expect(r.stableError).toBeUndefined();
        });

        // An app that takes minutes to boot answers 503 the whole time: that is a start under way.
        it('an app that has not answered before and has no measured boot time keeps being waited for through a stable 5xx', async () => {
            const r = await run([503], true, 60, undefined, {});
            expect(r.ready).toBe(false);
            expect(r.stableError).toBeUndefined();
            expect(r.waitedMs).toBeGreaterThanOrEqual(55_000);
        });

        it('a stable 5xx counts as the answer once the setup measured boot time has passed', async () => {
            const r = await run([503], true, 600, undefined, { bootMs: 120_000 });
            expect(r).toMatchObject({ ready: true, stableError: 503 });
            expect(r.waitedMs).toBeGreaterThanOrEqual(120_000);
        });

        it('an app that comes up while it is waited for is ready at its first answer under 500', async () => {
            const r = await run([503, 503, 503, 200], true, 600, undefined, {});
            expect(r).toMatchObject({ ready: true, tries: 4 });
        });
    });

    describe('a public service that exited', () => {
        const runWith = (outs: unknown[]) => {
            let clock = 0;
            const probe = jest.fn(async () => (outs.length > 1 ? outs.shift() : outs[0]) as any);
            return waitUntilReady({
                env: { probe } as any,
                claimId: 'c',
                target: { service: 'grafana', port: 3000, path: '/api/health', waitSeconds: 900 },
                who: { id: 'run-ready', purpose: 'p' },
                stepIdOf: (i) => `s${i}`,
                now: () => clock,
                sleep: async (ms) => {
                    clock += ms;
                },
            }).then((r) => ({ r, probe }));
        };

        it('ends the wait at once with its exit code and log lines, not at the timeout', async () => {
            const { r, probe } = await runWith([{ code: 'vm_unhealthy', stepId: 's' }, { stepId: 's', services: [exitedApp] }]);
            expect(r.ready).toBe(false);
            expect(r.exited).toEqual(exitedApp);
            expect(r.tries).toBe(2);
            expect(probe).toHaveBeenCalledTimes(2);
        });

        it('reads it from a lost transport too', async () => {
            const { r } = await runWith([{ code: 'transport_lost', stepId: 's', services: [exitedApp] }]);
            expect(r).toMatchObject({ ready: false, tries: 1, exited: exitedApp });
        });

        it('says what exited, with the code and the last log lines', () => {
            expect(exitedMessage({ service: 'grafana', port: 3000, path: '/api/health' }, exitedApp)).toBe(
                'grafana exited with code 1 before it answered GET /api/health on port 3000 (exited).\nLast log lines:\nseed failed: relation "x" does not exist',
            );
        });
    });
});
