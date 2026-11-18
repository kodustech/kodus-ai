import { z } from 'zod';

import { FakeEnvironmentRuntime } from '@libs/runtime/environment';
import { ProbeSchema } from '@libs/runtime/probe';

import { SCENARIOS } from '../../fake-cell/scenarios';
import { RecordedLlmGateway } from '../agent/llm-gateway';
import { RuntimeAgent } from '../agent/runtime-agent';
import type { StepRunner } from './ports';
import { replayProbe } from './replay';
import { stableStepId } from './step-id';

const RUN = { runId: '7d0f3c1e-5b8a-4c2e-9f1d-2a3b4c5d6e7f', attempt: 1 };

describe('Shop HTTP expectation replay', () => {
    const scenario = async (quantity: number, assertions?: { kind: 'http'; status: number; bodyIncludes?: string }) => {
        const sent: unknown[] = [];
        const p = ProbeSchema.parse({
            ...probe,
            id: `post-order-${quantity}`,
            expected: quantity === 0 ? "400 with error 'item and quantity are required'" : '201 with the created order',
            spec: { ...probe.spec, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ item: 'keyboard', quantity }) },
        });
        const env = {
            reset: async () => ({ ok: true }),
            probe: async (claim: string, played: typeof p, stepId: string) => {
                sent.push(played);
                const refused = quantity === 0 && claim === 'base';
                return {
                    stepId, executor: 'observer', imageId: 'img', transport: 'ok', vmHealth: 'ok', durationMs: 1,
                    http: { status: refused ? 400 : 201, headers: {}, body: refused ? '{"error":"item and quantity are required"}' : JSON.stringify({ id: 1, item: 'keyboard', quantity }) },
                    requests: [{ method: 'POST', route: '/orders', status: refused ? 400 : 201 }],
                };
            },
        } as any;
        const out = await replayProbe({ run: RUN, index: 0, probe: p, assertions, claims: { base: 'base', pr: 'pr' }, pinnedImageId: 'img', env, step: (_n, fn) => fn() });
        return { ...out, sent, probe: p };
    };

    it('finds the zero-quantity regression only after the PR repeats', async () => {
        const out = await scenario(0, { kind: 'http', status: 400, bodyIncludes: 'item and quantity are required' });
        expect(out.decision).toMatchObject({ verdict: 'finding', findingKind: 'behavior_change' });
        expect(out.steps.map((s) => [s.side, s.round, s.expectedHolds])).toEqual([['base', 1, true], ['base', 2, true], ['pr', 1, false], ['pr', 2, false]]);
        expect(out.sent).toEqual(out.steps.map(() => out.probe));
        for (const sent of out.sent) expect(sent).not.toHaveProperty('assertions');
    });

    it('settles the valid-order positive control with typed status assertions', async () => {
        const out = await scenario(1, { kind: 'http', status: 201 });
        expect(out.decision).toMatchObject({ verdict: 'not_reproduced' });
        expect(out.steps.every((s) => s.expectedHolds === true)).toBe(true);
        expect(out.steps).toHaveLength(3);
    });

    it('does not call an unevaluable legacy positive control pre_existing', async () => {
        expect((await scenario(1)).decision).toMatchObject({ verdict: 'inconclusive' });
    });
});

/** Runs the step body, throws once after it ran (a lost checkpoint), then retries it like DBOS does. */
const retryingStep = (): StepRunner & { names: string[] } => {
    const failed = new Set<string>();
    const names: string[] = [];
    const runner = (async <T>(name: string, fn: () => Promise<T>) => {
        names.push(name);
        const out = await fn();
        if (!failed.has(name)) {
            failed.add(name);
            return (await fn()) as T; // the retry
        }
        return out;
    }) as StepRunner & { names: string[] };
    runner.names = names;
    return runner;
};

const probe = ProbeSchema.parse({
    id: 'orders-empty-cart',
    origin: 'agent',
    purpose: 'an empty cart is refused',
    expected: '400',
    compare: ['status'],
    spec: { kind: 'http', target: { service: 'web', port: 3000 }, method: 'POST', path: '/orders', timeoutMs: 1_000 },
});

async function shopClaims(env: FakeEnvironmentRuntime) {
    const ask = (side: 'base' | 'pr') =>
        env.acquire({ organizationId: 'o', environmentId: 'shop', runId: RUN.runId, imageId: 'img-shop-1', ref: { side, sha: side.repeat(20).slice(0, 40) }, consumer: 'runtime', idempotencyKey: side });
    const [base, pr] = [await ask('base'), await ask('pr')];
    return { base: (base as any).claimId as string, pr: (pr as any).claimId as string };
}

describe('stable stepId', () => {
    it('is a valid protocol uuid, deterministic, and distinct per name, run and attempt', () => {
        const a = stableStepId(RUN.runId, 1, 'probe:0:x:base:1');
        expect(z.uuid().safeParse(a).success).toBe(true);
        expect(stableStepId(RUN.runId, 1, 'probe:0:x:base:1')).toBe(a);
        expect(stableStepId(RUN.runId, 1, 'probe:0:x:base:2')).not.toBe(a);
        expect(stableStepId(RUN.runId, 2, 'probe:0:x:base:1')).not.toBe(a);
        expect(stableStepId('another-run', 1, 'probe:0:x:base:1')).not.toBe(a);
    });

    it('a retried replay step sends the same stepId; rounds and sides get different ids', async () => {
        const env = new FakeEnvironmentRuntime(SCENARIOS);
        const claims = await shopClaims(env);
        const seen: { side: string; stepId: string }[] = [];
        const probeFn = env.probe.bind(env);
        env.probe = async (claimId, p, stepId) => {
            seen.push({ side: claimId === claims.base ? 'base' : 'pr', stepId });
            return probeFn(claimId, p, stepId);
        };
        const step = retryingStep();

        const { decision, steps } = await replayProbe({ run: RUN, index: 0, probe, claims, pinnedImageId: 'img-shop-1', env, step });

        expect(decision.verdict).toBe('finding');
        // Every step ran twice (first try + retry) with the same id; the two sides' rounds may interleave.
        expect(seen.length).toBe(steps.length * 2);
        const tries = new Map<string, number>();
        for (const s of seen) tries.set(s.stepId, (tries.get(s.stepId) ?? 0) + 1);
        expect([...tries.values()].every((n) => n === 2)).toBe(true);
        const ids = steps.map((s) => s.stepId);
        expect(new Set(ids).size).toBe(ids.length);
        expect(ids.every((id) => z.uuid().safeParse(id).success)).toBe(true);
        expect(new Set(step.names).size).toBe(steps.length);
        expect(step.names[0]).toBe('probe:0:orders-empty-cart:base:1');
    });

    it('the same probe id at another plan index gets other stepIds', async () => {
        const env = new FakeEnvironmentRuntime(SCENARIOS);
        const claims = await shopClaims(env);
        const step: StepRunner = (_n, fn) => fn();
        const a = await replayProbe({ run: RUN, index: 0, probe, claims, pinnedImageId: 'img-shop-1', env, step });
        const b = await replayProbe({ run: RUN, index: 1, probe, claims, pinnedImageId: 'img-shop-1', env, step });
        expect(a.steps.map((s) => s.stepId).filter((id) => b.steps.some((x) => x.stepId === id))).toEqual([]);
    });

    it('a re-executed agent plan step explores with the same stepIds', async () => {
        const env = new FakeEnvironmentRuntime(SCENARIOS);
        const claims = await shopClaims(env);
        const ids: string[] = [];
        const exec = env.exec.bind(env);
        env.exec = async (claimId, req) => {
            ids.push(req.stepId);
            return exec(claimId, req);
        };
        const turns = [
            { task: 'runtime.plan' as const, text: '{"explore":["cat /app/routes.txt","ls /app"]}', usage: { inputTokens: 1, outputTokens: 1 } },
            { task: 'runtime.plan' as const, text: '{"probes":[]}', usage: { inputTokens: 1, outputTokens: 1 } },
        ];
        const input = { ...RUN, organizationId: 'o', runToken: 't', entryPoints: [], diffSummary: '', baseClaimId: claims.base };
        await new RuntimeAgent(new RecordedLlmGateway(turns, { maxTokensPerRun: 1_000 }), env).plan(input);
        await new RuntimeAgent(new RecordedLlmGateway(turns, { maxTokensPerRun: 1_000 }), env).plan(input);
        expect(ids.length).toBe(4);
        expect(ids.slice(2)).toEqual(ids.slice(0, 2));
        expect(ids[0]).not.toBe(ids[1]);
    });
});

describe('ready check after the reset', () => {
    it('waits for the app to answer again before each round sends its probe', async () => {
        const calls: string[] = [];
        const notYet = new Map<string, number>();
        const env = {
            reset: async (claimId: string) => {
                calls.push(`reset:${claimId}`);
                notYet.set(claimId, 2); // the app takes two tries to listen again
                return { ok: true };
            },
            probe: async (claimId: string, p: { id: string }, stepId: string) => {
                calls.push(`${p.id}:${claimId}`);
                if (p.id === 'run-ready') {
                    const left = notYet.get(claimId) ?? 0;
                    notYet.set(claimId, left - 1);
                    return left > 0 ? { code: 'vm_unhealthy', stepId, vmHealth: 'unreachable' } : { stepId, http: { status: 200, headers: {}, body: '' } };
                }
                return { stepId, http: { status: 400, headers: {}, body: '' } };
            },
        } as any;
        let clock = 0;
        const slept: number[] = [];
        const step = (async <T>(_n: string, fn: () => Promise<T>) => fn()) as StepRunner;
        const out = await replayProbe({
            run: RUN,
            index: 0,
            probe,
            claims: { base: 'b', pr: 'p' },
            pinnedImageId: 'img',
            env,
            step,
            ready: { service: 'web', port: 3000, path: '/health', waitSeconds: 60 },
            now: () => clock,
            sleep: async (ms) => {
                slept.push(ms);
                clock += ms;
            },
        });
        expect(out.steps.length).toBeGreaterThanOrEqual(3);
        // After a reset the round asks every second, not every five.
        expect(new Set(slept)).toEqual(new Set([1_000]));
        // Every round of a claim: reset, the ready check until it answers, then the probe; never the probe on a cold app.
        // The two claims' rounds run side by side, so each claim's calls are read on their own.
        for (const claim of ['b', 'p']) {
            const own = calls.filter((c) => c.endsWith(`:${claim}`));
            for (const [i, c] of own.entries()) {
                if (c.startsWith(`${probe.id}:`)) expect(own[i - 1]).toBe(`run-ready:${claim}`);
            }
            expect(own.slice(0, 5)).toEqual([`reset:${claim}`, `run-ready:${claim}`, `run-ready:${claim}`, `run-ready:${claim}`, `${probe.id}:${claim}`]);
        }
    });
});

describe('round evidence', () => {
    const evidenceOf = () => {
        const objects = new Map<string, any>();
        return { objects, target: { organizationId: 'o', store: { put: async (k: string, b: string | Buffer) => void objects.set(k, JSON.parse(String(b))) } } };
    };
    const step: StepRunner = (_n, fn) => fn();

    // A round without a result used to write nothing: the Run page linked
    // "Open" to an object that did not exist.
    it('a round whose probe failed says why, at the round step', async () => {
        const env = {
            reset: async () => undefined,
            probe: async (_c: string, _p: unknown, stepId: string) => ({ code: 'vm_unhealthy', stepId, vmHealth: 'unreachable' }),
        } as any;
        const { objects, target } = evidenceOf();
        const out = await replayProbe({ run: RUN, index: 0, probe, claims: { base: 'b', pr: 'p' }, pinnedImageId: 'img', env, step, evidence: target, maxRoundsPerSide: 1 });
        const first = out.steps[0];
        expect(objects.get(`o/${RUN.runId}/base/${first.stepId}/output`)).toEqual({
            probeId: probe.id,
            side: 'base',
            round: 1,
            stepId: first.stepId,
            stage: 'probe',
            error: { code: 'vm_unhealthy', reason: 'the machine did not answer (unreachable)', vmHealth: 'unreachable' },
        });
        expect(objects.size).toBe(out.steps.length);
    });

    it('a round whose reset failed says so', async () => {
        const env = { reset: async () => ({ code: 'timeout', afterMs: 60_000 }), probe: jest.fn() } as any;
        const { objects, target } = evidenceOf();
        const out = await replayProbe({ run: RUN, index: 0, probe, claims: { base: 'b', pr: 'p' }, pinnedImageId: 'img', env, step, evidence: target, maxRoundsPerSide: 1 });
        expect(env.probe).not.toHaveBeenCalled();
        expect(objects.get(`o/${RUN.runId}/base/${out.steps[0].stepId}/output`)).toMatchObject({
            stage: 'reset',
            error: { code: 'timeout', reason: 'no answer after 60000 ms', afterMs: 60_000 },
        });
    });

    it('a write that fails reaches onError and the round still counts', async () => {
        const env = new FakeEnvironmentRuntime(SCENARIOS);
        const claims = await shopClaims(env);
        const errors: unknown[] = [];
        const evidence = { organizationId: 'o', store: { put: async () => Promise.reject(new Error('disk full')) }, onError: (e: unknown) => void errors.push(e) };
        const out = await replayProbe({ run: RUN, index: 0, probe, claims, pinnedImageId: 'img-shop-1', env, step, evidence });
        expect(out.decision.verdict).toBe('finding');
        expect(errors).toHaveLength(out.steps.length);
    });

    it('a key the evidence store refuses goes to onError instead of failing the round', async () => {
        const env = new FakeEnvironmentRuntime(SCENARIOS);
        const claims = await shopClaims(env);
        const errors: unknown[] = [];
        const put = jest.fn();
        const evidence = { organizationId: 'not/an/org', store: { put }, onError: (e: unknown) => void errors.push(e) };
        const out = await replayProbe({ run: RUN, index: 0, probe, claims, pinnedImageId: 'img-shop-1', env, step, evidence });
        expect(out.decision.verdict).toBe('finding');
        expect(put).not.toHaveBeenCalled();
        expect(errors.length).toBe(out.steps.length);
    });
});


describe('Replay canonical reset image (#2505)', () => {
    it('forwards the durable image pin before every probe round', async () => {
        const env = new FakeEnvironmentRuntime(SCENARIOS);
        const claims = await shopClaims(env);
        const reset = jest.spyOn(env, 'reset');
        const result = await replayProbe({ run: RUN, index: 0, probe, claims, pinnedImageId: 'img-shop-1', env, step: (_name, fn) => fn() });
        expect(reset.mock.calls).toHaveLength(result.steps.length);
        // One reset per round, each with the pin; the two sides' rounds run side by side, so in any order.
        const sorted = (calls: unknown[][]) => calls.map((c) => c.join(' ')).sort();
        expect(sorted(reset.mock.calls)).toEqual(sorted(result.steps.map((s) => [claims[s.side], 'img-shop-1'])));
    });
});

describe('base and PR rounds side by side', () => {
    /** A probe whose base answers 400 and PR 201: a finding after two base rounds and two PR rounds. */
    const differing = () => ({
        reset: jest.fn(async () => ({ ok: true })),
        probe: async (claim: string, _p: unknown, stepId: string) => ({
            stepId, executor: 'observer', imageId: 'img', transport: 'ok', vmHealth: 'ok', durationMs: 1,
            http: { status: claim === 'base' ? 400 : 201, headers: {}, body: '{}' },
            requests: [{ method: 'POST', route: '/orders', status: claim === 'base' ? 400 : 201 }],
        }),
    });

    it("starts the PR side's round while the base side's round is still running", async () => {
        const env = differing() as any;
        let releaseBase!: () => void;
        const baseHeld = new Promise<void>((r) => (releaseBase = r));
        const started: string[] = [];
        env.reset = jest.fn(async (claim: string) => {
            started.push(claim);
            if (claim === 'base' && started.length === 1) await baseHeld;
            return { ok: true };
        });
        const out = replayProbe({ run: RUN, index: 0, probe, claims: { base: 'base', pr: 'pr' }, pinnedImageId: 'img', env, step: (_n, fn) => fn() });
        await new Promise((r) => setImmediate(r));
        // The base round is held in its reset, and the PR round has started anyway.
        expect(started).toEqual(['base', 'pr']);
        releaseBase();
        const done = await out;
        expect(done.decision).toMatchObject({ verdict: 'finding' });
        // Kept as one round after the other kept them: the batch's base rounds, then its PR round.
        expect(done.steps.map((s) => [s.side, s.round])).toEqual([['base', 1], ['base', 2], ['pr', 1], ['pr', 2]]);
    });

    it('starts the steps in the same order whichever side ends first, so a resumed workflow numbers them the same', async () => {
        const order = async (slow: 'base' | 'pr') => {
            const env = differing() as any;
            env.reset = async (claim: string) => {
                await new Promise((r) => setTimeout(r, claim === slow ? 20 : 0));
                return { ok: true };
            };
            const names: string[] = [];
            const step: StepRunner = (name, fn) => {
                names.push(name);
                return fn();
            };
            await replayProbe({ run: RUN, index: 0, probe, claims: { base: 'base', pr: 'pr' }, pinnedImageId: 'img', env, step });
            return names;
        };
        const whenBaseIsSlow = await order('base');
        expect(whenBaseIsSlow).toEqual(await order('pr'));
        expect(whenBaseIsSlow).toEqual([
            'probe:0:orders-empty-cart:base:1',
            'probe:0:orders-empty-cart:pr:1',
            'probe:0:orders-empty-cart:base:2',
            'probe:0:orders-empty-cart:pr:2',
        ]);
    });

    it('a security violation on the base round halts only once the PR round beside it has ended', async () => {
        let prEnded = false;
        const env = {
            reset: async (claim: string) => {
                if (claim === 'base') return { code: 'security_violation', signature: 'egress:exfil' };
                await new Promise((r) => setTimeout(r, 20));
                prEnded = true;
                return { ok: true };
            },
            probe: async (_c: string, _p: unknown, stepId: string) => ({ stepId, executor: 'observer', imageId: 'img', transport: 'ok', vmHealth: 'ok', durationMs: 1, http: { status: 200, headers: {}, body: '{}' }, requests: [] }),
        } as any;
        await expect(
            replayProbe({ run: RUN, index: 0, probe, claims: { base: 'base', pr: 'pr' }, pinnedImageId: 'img', env, step: (_n, fn) => fn() }),
        ).rejects.toMatchObject({ side: 'base' });
        // No step is left running when the halt is thrown.
        expect(prEnded).toBe(true);
    });
});

describe('stability history (ADR-050)', () => {
    const plain: StepRunner = (_name, fn) => fn();

    it('a probe known unstable on the base starts with three base rounds; without history, two', async () => {
        const rounds = async (stability?: { baseRounds: number; knownUnstableFields: string[] }) => {
            const env = new FakeEnvironmentRuntime(SCENARIOS);
            const claims = await shopClaims(env);
            const { steps } = await replayProbe({ run: RUN, index: 0, probe, claims, pinnedImageId: 'img-shop-1', env, step: plain, ...(stability ? { stability } : {}) });
            return steps.filter((s) => s.side === 'base').length;
        };
        expect(await rounds()).toBe(2);
        expect(await rounds({ baseRounds: 3, knownUnstableFields: [] })).toBe(3);
    });

    it('never starts below the two base rounds the table needs, nor above the ceiling', async () => {
        const env = new FakeEnvironmentRuntime(SCENARIOS);
        const claims = await shopClaims(env);
        const { steps } = await replayProbe({ run: RUN, index: 0, probe, claims, pinnedImageId: 'img-shop-1', env, step: plain, stability: { baseRounds: 0, knownUnstableFields: [] } });
        expect(steps.filter((s) => s.side === 'base').length).toBe(2);
    });
});
