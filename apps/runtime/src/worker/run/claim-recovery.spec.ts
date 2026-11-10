import { FakeEnvironmentRuntime, type LeaseRenewal } from '@libs/runtime/environment';

import { shopRunRequest } from '../../e2e/fixtures';
import { SCENARIOS } from '../../fake-cell/scenarios';
import { runPlannedTests } from '../intent/test-runs';
import { inMemoryRunDeps } from './in-memory-deps';
import type { StepRunner } from './ports';
import { replayProbe } from './replay';
import { runRuntimeRun } from './run-orchestrator';

class DBOSWorkflowCancelledError extends Error {
    name = 'DBOSWorkflowCancelledError';
}

/** Completed callback outputs replay; the paused callback itself has no checkpoint. */
function journal(paused: string) {
    const outputs = new Map<string, unknown>();
    let pause = true;
    const step: StepRunner = async (name, fn) => {
        if (outputs.has(name)) return structuredClone(outputs.get(name)) as any;
        if (pause && name === paused) throw new DBOSWorkflowCancelledError('synthetic process interruption');
        const value = await fn();
        outputs.set(name, structuredClone(value));
        return value;
    };
    return { step, outputs, resume: () => { pause = false; } };
}

const live = (): LeaseRenewal => ({ status: 'renewed', leaseExpiresAt: '2030-01-01T00:45:00.000Z', hardExpiresAt: '2030-01-01T01:00:00.000Z', atCeiling: false });

describe('claim authority after checkpoint recovery', () => {
    async function interruptedRun() {
        const memory = inMemoryRunDeps();
        const saved = journal('agent:plan');
        const acquire = jest.spyOn(memory.deps.env, 'acquire');
        const plan = jest.spyOn(memory.deps.agent, 'plan');
        const renew = jest.fn(async (_id: string) => live());
        memory.deps.env.renew = renew;
        memory.deps.step = saved.step;
        const req = shopRunRequest();
        await memory.projection.upsert(req.runId, { state: 'queued', organizationId: req.organizationId, requestedAt: req.requestedAt });
        await expect(runRuntimeRun(req, memory.deps)).rejects.toBeInstanceOf(DBOSWorkflowCancelledError);
        saved.resume();
        return { ...memory, req, saved, acquire, plan, renew };
    }

    it('does not start a planner on an expired restored claim or silently acquire another one', async () => {
        const h = await interruptedRun();
        h.renew.mockResolvedValue({ status: 'gone' });
        expect(await runRuntimeRun(h.req, h.deps)).toMatchObject({ state: 'errored' });
        expect(h.plan).not.toHaveBeenCalled();
        expect(h.acquire).toHaveBeenCalledTimes(2);
        expect((await h.projection.get(h.req.runId))!.reason).toContain('claim_lease_unavailable');
        const checks = h.renew.mock.calls.length;
        // A recorded guard failure is replayed as data, not checked again under another identity.
        expect(await runRuntimeRun(h.req, h.deps)).toMatchObject({ state: 'errored' });
        expect(h.renew).toHaveBeenCalledTimes(checks);
    });

    it('renews both restored claims before a live Run enters the planner', async () => {
        const h = await interruptedRun();
        const original = h.plan.getMockImplementation();
        h.plan.mockImplementationOnce(async (...args) => {
            expect(h.renew).toHaveBeenCalledTimes(2);
            return original ? original.apply(h.deps.agent, args) : Object.getPrototypeOf(h.deps.agent).plan.apply(h.deps.agent, args);
        });
        expect(await runRuntimeRun(h.req, h.deps)).toMatchObject({ state: 'regression' });
        expect(h.acquire).toHaveBeenCalledTimes(2);
    });

    it('does not pay for planning when renewal authority is unreachable', async () => {
        const h = await interruptedRun();
        h.deps.env.renew = jest.fn(async () => ({ code: 'cell_unavailable' as const, cellId: 'unknown' }));
        expect(await runRuntimeRun(h.req, h.deps)).toMatchObject({ state: 'errored' });
        expect(h.plan).not.toHaveBeenCalled();
        expect(h.acquire).toHaveBeenCalledTimes(2);
    });

    it('preserves a recorded security violation when renewal reports gone', async () => {
        const h = await interruptedRun();
        const pr = [...h.claims.claims.values()].find((c) => c.side === 'pr')!;
        h.renew.mockImplementation(async (id) => id === pr.claimId ? { status: 'gone' } : live());
        h.claims.violations.push({ claimId: pr.claimId, side: 'pr', signature: 'exfiltration' });
        expect(await runRuntimeRun(h.req, h.deps)).toMatchObject({ state: 'halted', conclusion: 'failure' });
        expect(h.plan).not.toHaveBeenCalled();
        expect((await h.projection.get(h.req.runId))!.securityEvent).toMatchObject({ where: 'pr', signature: 'exfiltration' });
    });

    async function machine() {
        const env = new FakeEnvironmentRuntime(SCENARIOS);
        const claim = async (side: 'base' | 'pr') => env.acquire({ organizationId: 'o', environmentId: 'shop', runId: 'recovery', imageId: 'img-shop-1', ref: { side, sha: 'a'.repeat(40) }, consumer: 'runtime', idempotencyKey: side });
        const [base, pr] = await Promise.all([claim('base'), claim('pr')]);
        const claims = { base: (base as any).claimId, pr: (pr as any).claimId };
        const reset = jest.spyOn(env, 'reset');
        const exec = jest.spyOn(env, 'exec');
        const probe = jest.spyOn(env, 'probe');
        const renew = jest.fn(async (_id: string): Promise<LeaseRenewal> => live());
        Object.assign(env, { renew });
        return { env, claims, reset, exec, probe, renew };
    }

    it('checks the pending PR probe round after replaying cached base rounds', async () => {
        const h = await machine();
        const saved = journal('probe:0:orders-empty-cart:pr:1');
        const probe = { id: 'orders-empty-cart', origin: 'agent', purpose: 'p', expected: '400', compare: ['status'], spec: { kind: 'http', target: { service: 'web', port: 3000 }, method: 'POST', path: '/orders', timeoutMs: 1000 } } as any;
        const args = { run: { runId: 'recovery', attempt: 1 }, index: 0, probe, claims: h.claims, pinnedImageId: 'img-shop-1', env: h.env, step: saved.step };
        await expect(replayProbe(args)).rejects.toBeInstanceOf(DBOSWorkflowCancelledError);
        const sent = h.probe.mock.calls.length;
        const resets = h.reset.mock.calls.length;
        const checked = h.renew.mock.calls.length;
        saved.resume();
        h.renew.mockImplementation(async (id) => id === h.claims.pr ? { status: 'gone' } : live());
        await expect(replayProbe(args)).rejects.toMatchObject({ code: 'claim_lease_unavailable' });
        expect(h.renew).toHaveBeenCalledTimes(checked + 1);
        expect(h.probe).toHaveBeenCalledTimes(sent);
        expect(h.reset).toHaveBeenCalledTimes(resets);
    });

    it('checks the pending repository-test side before reset or exec', async () => {
        const h = await machine();
        const saved = journal('test:0:orders-spec:pr');
        const args = { run: { runId: 'recovery', attempt: 1 }, tests: [{ id: 'orders-spec', path: 'test/orders.spec.ts', command: 'npm test', entryPoint: 'POST /orders' }], claims: h.claims, env: h.env, step: saved.step };
        await expect(runPlannedTests(args)).rejects.toBeInstanceOf(DBOSWorkflowCancelledError);
        const resets = h.reset.mock.calls.length;
        const execs = h.exec.mock.calls.length;
        saved.resume();
        h.renew.mockImplementation(async (id) => id === h.claims.pr ? { status: 'gone' } : live());
        await expect(runPlannedTests(args)).rejects.toMatchObject({ code: 'claim_lease_unavailable' });
        expect(h.exec).toHaveBeenCalledTimes(execs);
        expect(h.reset).toHaveBeenCalledTimes(resets);
    });
});
