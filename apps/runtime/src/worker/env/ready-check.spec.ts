import { readyTarget, readyWaitSeconds, STABLE_ERROR_TRIES, waitUntilReady } from './ready-check';

const unreachable = { code: 'vm_unhealthy', stepId: 's', vmHealth: 'unreachable' } as const;
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
        const run = (answers: Array<number | 'down'>, acceptStableError: boolean, waitSeconds = 600) => {
            let clock = 0;
            let n = 0;
            const probe = jest.fn(async (_c: string, _p: unknown, stepId: string) => {
                const a = answers[Math.min(n++, answers.length - 1)];
                return a === 'down' ? { code: 'vm_unhealthy', stepId } : { stepId, http: { status: a, headers: {}, body: '' } };
            });
            return waitUntilReady({
                env: { probe } as any,
                claimId: 'c',
                target: { service: 'grafana', port: 3000, path: '/api/health', waitSeconds },
                who: { id: 'run-ready', purpose: 'p' },
                stepIdOf: (i) => `s${i}`,
                now: () => clock,
                sleep: async (ms) => {
                    clock += ms;
                },
                acceptStableError,
            });
        };

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
    });
});
