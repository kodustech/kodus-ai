import { type AcquireRequest, type Blocked, FakeEnvironmentRuntime } from '@libs/runtime/environment';

import { SCENARIOS } from '../../fake-cell/scenarios';
import { shopRunRequest } from '../../e2e/fixtures';
import { CellUnavailableError } from '../../shared/errors';
import { acquireWaitingForRoom } from '../env/capacity-wait';
import { inMemoryRunDeps } from './in-memory-deps';
import { RUN_TIMEOUT_MS, runRuntimeRun } from './run-orchestrator';

// A Run whose claims find no room on a cell waits for it (ADR-070): the
// incident on cell-dev-1 was two PR builds admitted at once, one dying of
// memory. Now the second waits, queued for capacity, and then runs.

const noRoom = (ahead = 0): Blocked => ({
    status: 'blocked',
    blockers: [{ kind: 'resources', signature: 'no_capacity', message: 'the claim needs 14336 MB of memory and 409 of the cell’s 14745 MB are free; nothing was started, the claim waits for room' }],
    capacity: { cellId: 'cell-dev-1', needMb: 14_336, freeMb: 409, allocatableMb: 14_745, ahead },
});

const seed = async (projection: any, req: ReturnType<typeof shopRunRequest>) =>
    projection.upsert(req.runId, { attempt: req.attempt, organizationId: req.organizationId, state: 'queued', requestedAt: req.requestedAt });

describe('waiting for room on a cell', () => {
    it('does not wait inside an admitted execution when its reserved capacity is unavailable', async () => {
        const env = new FakeEnvironmentRuntime(SCENARIOS);
        const acquire = jest.spyOn(env, 'acquire').mockResolvedValue(noRoom());
        const h = inMemoryRunDeps({ env });
        let time = Date.now();
        h.deps.now = () => new Date(time);
        h.deps.sleep = jest.fn(async (ms) => { time += ms; });
        const request = shopRunRequest();
        await seed(h.projection, request);
        const result = await runRuntimeRun(request, h.deps, { noCapacityWait: true } as any);
        expect(result.state).toBe('errored');
        expect(acquire).toHaveBeenCalledTimes(2);
        expect(h.deps.sleep).not.toHaveBeenCalled();
    });
    it('passes the acquire step cancellation signal through without retrying or publishing an error', async () => {
        const env = new FakeEnvironmentRuntime(SCENARIOS, () => new Date());
        const controller = new AbortController();
        const cancellation = Object.assign(new Error('workflow cancelled'), { name: 'DBOSWorkflowCancelledError' });
        const acquire = jest.spyOn(env, 'acquire').mockImplementation(async () => {
            controller.abort(cancellation);
            return noRoom();
        });
        const { deps, projection, published } = inMemoryRunDeps({ env });
        let inAcquireStep = false;
        const step = deps.step;
        deps.step = async (name, fn) => step(name, async () => {
            if (name.startsWith('acquire:')) inAcquireStep = true;
            try {
                return await fn();
            } finally {
                if (name.startsWith('acquire:')) inAcquireStep = false;
            }
        });
        deps.cancellationSignal = () => {
            expect(inAcquireStep).toBe(true);
            return controller.signal;
        };
        const req = shopRunRequest();
        await seed(projection, req);

        await expect(runRuntimeRun(req, deps)).rejects.toBe(cancellation);
        // Both sides may already be dispatched; neither starts another acquire.
        expect(acquire.mock.calls.length).toBeLessThanOrEqual(2);
        expect(published.some((p) => p.check?.status === 'completed')).toBe(false);
        expect((await projection.get(req.runId))?.state).toBe('booting');
    });

    it('a Run refused for memory waits, shows it as queued for capacity, then boots and finishes as if it had not waited', async () => {
        const env = new FakeEnvironmentRuntime(SCENARIOS, () => new Date());
        const real = env.acquire.bind(env);
        const refusals: Record<string, number> = { base: 2, pr: 3 };
        const asked: string[] = [];
        env.acquire = async (req: AcquireRequest) => {
            asked.push(`${req.ref.side}:${req.idempotencyKey}`);
            if (refusals[req.ref.side]-- > 0) return noRoom(1);
            return real(req);
        };
        const { deps, projection, stream } = inMemoryRunDeps({ env });
        const sleeps: number[] = [];
        let clock = Date.now();
        deps.now = () => new Date(clock);
        deps.sleep = async (ms) => {
            sleeps.push(ms);
            clock += ms;
        };
        const phases: string[] = [];
        const upsert = projection.upsert.bind(projection);
        projection.upsert = async (runId, patch) => {
            if (patch.phase) phases.push(patch.phase);
            return upsert(runId, patch);
        };
        const req = shopRunRequest();
        await seed(projection, req);

        const result = await runRuntimeRun(req, deps);
        expect(result.state).toBe('regression');
        // Each side asked again with the same claim (idempotency key), never a new one.
        expect(new Set(asked.filter((a) => a.startsWith('pr:')))).toEqual(new Set([`pr:${req.runId}:pr:${req.attempt}`]));
        expect(asked.filter((a) => a.startsWith('pr:'))).toHaveLength(4);
        expect(sleeps.length).toBe(5);
        expect(phases).toContain('capacity');
        expect(phases.indexOf('booting')).toBeGreaterThan(phases.indexOf('capacity'));
        const run = (await projection.get(req.runId))!;
        expect(run.capacityWait).toBeNull();
        expect(run.capacityWaitMs).toBeGreaterThan(0);
        // The 45 min limit counts from when both sides had room.
        expect(Date.parse(run.bootingAt!)).toBeGreaterThan(Date.parse(run.startedAt!));
        const events = (await stream.read(req.organizationId, req.runId))!.events;
        const capacity = events.filter((e: any) => e.type === 'phase' && e.data?.phase === 'capacity');
        expect(capacity.map((e: any) => e.data.side).sort()).toEqual(['base', 'pr']);
        expect(capacity[0].data).toMatchObject({ needMb: 14_336, freeMb: 409, ahead: 1, cellId: 'cell-dev-1' });
    });

    it('a Run that waits past its queue budget times out, never fails, and boots nothing', async () => {
        const env = new FakeEnvironmentRuntime(SCENARIOS, () => new Date());
        env.acquire = async () => noRoom();
        const { deps, projection, published } = inMemoryRunDeps({ env });
        let clock = Date.now();
        deps.now = () => new Date(clock);
        deps.sleep = async (ms) => void (clock += ms);
        const req = shopRunRequest();
        await seed(projection, req);
        const result = await runRuntimeRun(req, deps);
        expect(result).toMatchObject({ state: 'timed_out', conclusion: 'timed_out' });
        const run = (await projection.get(req.runId))!;
        expect(run.reason).toMatch(/waited \d+ min for room on a cell/);
        expect(run.findings ?? []).toEqual([]);
        expect(published.some((p) => p.kind === 'check')).toBe(true);
    });

    /** A Run whose PR side is refused for room for about `waitMin` minutes while the base boots at once; the agent's plan takes `planMin`. */
    async function longPrWait(waitMin: number, planMin: number) {
        let clock = Date.parse('2026-11-07T12:00:00Z');
        const env = new FakeEnvironmentRuntime(SCENARIOS, () => new Date(clock));
        const real = env.acquire.bind(env);
        const asked: string[] = [];
        const waitUntil = clock + waitMin * 60_000;
        env.acquire = async (r: AcquireRequest) => {
            asked.push(`${r.ref.side}:${r.idempotencyKey}`);
            if (r.ref.side === 'pr' && clock < waitUntil) return noRoom(1);
            return real(r);
        };
        const probed = new Set<string>();
        const probe = env.probe.bind(env);
        env.probe = async (claimId, p, stepId, ev) => (probed.add(claimId), probe(claimId, p, stepId, ev));
        const { deps, projection, claims } = inMemoryRunDeps({ env });
        deps.now = () => new Date(clock);
        deps.sleep = async (ms) => void (clock += ms);
        const step = deps.step;
        deps.step = async (name, fn) => {
            if (name === 'agent:plan') clock += planMin * 60_000;
            return step(name, fn);
        };
        const capacityAts: string[] = [];
        const upsert = projection.upsert.bind(projection);
        projection.upsert = async (runId, patch) => {
            if (patch.capacityWait?.at) capacityAts.push(patch.capacityWait.at);
            return upsert(runId, patch);
        };
        const req = shopRunRequest({ requestedAt: new Date(clock).toISOString() });
        await seed(projection, req);
        const result = await runRuntimeRun(req, deps);
        return { result, asked, req, run: (await projection.get(req.runId))!, claims, probed, capacityAts };
    }

    it('a base whose machines would be destroyed before the Run ends, after a long wait for the PR, is booted again on a fresh claim', async () => {
        // The PR waits 25 min: the base acquired at t0 is destroyed at t0+60, but the Run's 45 min
        // run from when both had room (t0+25) to t0+70. The agent plans for 40 min.
        const { result, asked, req, run, claims, probed } = await longPrWait(25, 40);
        expect(result.state).toBe('regression');
        expect(asked.filter((a) => a.startsWith('base:'))).toEqual([`base:${req.runId}:base:${req.attempt}`, `base:${req.runId}:base:${req.attempt}:renewed`]);
        // Every claim the Run tested on lives to the end of its 45 min.
        const runEnd = Date.parse(run.bootingAt!) + RUN_TIMEOUT_MS;
        expect(probed.size).toBeGreaterThan(0);
        for (const id of probed) expect(Date.parse(claims.claims.get(id)!.hardExpiresAt)).toBeGreaterThanOrEqual(runEnd);
        // The first base claim was given back.
        expect([...claims.claims.values()].filter((c) => c.side === 'base').map((c) => c.released)).toEqual([true, true]);
    });

    it('a short wait for room keeps the base it booted', async () => {
        const { result, asked, req } = await longPrWait(5, 1);
        expect(result.state).toBe('regression');
        expect(asked.filter((a) => a.startsWith('base:'))).toEqual([`base:${req.runId}:base:${req.attempt}`]);
    });

    it('records when the claim was last refused, so the sweeper counts the 45 min from when it had room', async () => {
        const { capacityAts } = await longPrWait(5, 1);
        expect(capacityAts.length).toBeGreaterThan(1);
        expect(Date.parse(capacityAts[capacityAts.length - 1])).toBeGreaterThan(Date.parse(capacityAts[0]));
    });

    it('acquireWaitingForRoom returns at once what is not a wait for room, and stops before its budget', async () => {
        const failed: Blocked = { status: 'blocked', blockers: [{ kind: 'resources', signature: 'out_of_memory', message: 'build passed 12g' }] };
        let calls = 0;
        const now = () => new Date(1_000);
        const r1 = await acquireWaitingForRoom({ acquire: async () => (calls++, failed) }, {} as AcquireRequest, { until: 10_000_000, now, sleep: async () => undefined });
        expect(r1).toEqual({ claim: failed, waitedMs: 0, rounds: 1 });
        expect(calls).toBe(1);
        // org_capacity is a wait too; the budget ends before the first pause.
        const capped: Blocked = { status: 'blocked', blockers: [{ kind: 'resources', signature: 'org_capacity', message: 'cap 8' }] };
        const r2 = await acquireWaitingForRoom({ acquire: async () => capped }, {} as AcquireRequest, { until: 2_000, now, sleep: async () => undefined, jitter: () => 1 });
        expect(r2).toMatchObject({ claim: capped, rounds: 1 });
    });

    it('a hub that restarts while a claim waits for room is a pause: the claim keeps waiting, then boots', async () => {
        const answers: Array<() => Promise<any>> = [
            async () => noRoom(),
            async () => {
                throw new CellUnavailableError('hub unreachable: ECONNREFUSED');
            },
            async () => noRoom(),
            async () => ({ status: 'ready', claimId: 'c1' }),
        ];
        let t = 0;
        const r = await acquireWaitingForRoom({ acquire: () => answers.shift()!() } as any, {} as AcquireRequest, {
            until: 10_000_000,
            now: () => new Date(t),
            sleep: async (ms) => void (t += ms),
            jitter: () => 1,
        });
        expect(r.claim).toEqual({ status: 'ready', claimId: 'c1' });
        expect(r.rounds).toBe(4);
    });

    it('a hub that is unreachable on the first ask still fails the acquire, as before', async () => {
        await expect(
            acquireWaitingForRoom(
                {
                    acquire: async () => {
                        throw new CellUnavailableError('hub unreachable: ECONNREFUSED');
                    },
                } as any,
                {} as AcquireRequest,
                { until: 10_000_000, now: () => new Date(0), sleep: async () => undefined },
            ),
        ).rejects.toBeInstanceOf(CellUnavailableError);
    });
});
