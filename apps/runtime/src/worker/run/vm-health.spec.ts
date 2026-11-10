import { FakeEnvironmentRuntime } from '@libs/runtime/environment';
import type { Probe } from '@libs/runtime/probe';

import { toGateStep } from './probe-fields';
import { replayProbe } from './replay';

// vmHealth from step.result reaches the gate: an OOM on the PR side while
// the base stays healthy is pr_destabilizes_machine, not a lost transport.

const probe: Probe = {
    id: 'p1',
    origin: 'agent',
    purpose: 'list orders',
    expected: '200',
    compare: ['status'],
    spec: { kind: 'http', target: { service: 'api', port: 3000 }, method: 'GET', path: '/orders', timeoutMs: 1_000 },
} as Probe;
const STEP = '0b9c8d7e-6f50-4a1b-9c2d-3e4f5a6b7c8d';

describe('vmHealth into the gate', () => {
    it('keeps vmHealth of a probe result and of a vm_unhealthy error', () => {
        const ok = toGateStep({ probe, side: 'pr', round: 1, stepId: STEP, result: { stepId: STEP, executor: 'observer', imageId: 'img', requests: [], durationMs: 1, transport: 'ok', vmHealth: 'oom' } });
        expect(ok).toMatchObject({ vmHealth: 'oom', transport: 'ok' });
        const err = toGateStep({ probe, side: 'pr', round: 1, stepId: STEP, result: { code: 'vm_unhealthy', stepId: STEP, vmHealth: 'crashed' } });
        expect(err).toMatchObject({ vmHealth: 'crashed', transport: 'ok' });
    });

    it('an OOM on the PR side in every round is pr_destabilizes_machine', async () => {
        const env = new FakeEnvironmentRuntime({
            shop: {
                imageId: 'img-1',
                expose: [{ service: 'api', port: 3000, kind: 'http' }],
                probes: {
                    p1: {
                        base: () => ({ http: { status: 200, headers: {}, body: '[]' } }),
                        pr: () => ({ transport: 'lost', vmHealth: 'oom' }),
                    },
                },
            },
        });
        const acquire = (side: 'base' | 'pr') =>
            env.acquire({ organizationId: 'org', environmentId: 'shop', imageId: 'img-1', ref: { side, sha: 'a'.repeat(40) }, consumer: 'runtime', idempotencyKey: side });
        const base = (await acquire('base')) as { claimId: string };
        const pr = (await acquire('pr')) as { claimId: string };
        const { decision, steps } = await replayProbe({ run: { runId: 'run-vm', attempt: 1 }, index: 0, probe, claims: { base: base.claimId, pr: pr.claimId }, pinnedImageId: 'img-1', env, step: (_n, f) => f() });
        expect(steps.filter((s) => s.side === 'pr').every((s) => s.vmHealth === 'oom')).toBe(true);
        expect(decision).toMatchObject({ verdict: 'finding', findingKind: 'pr_destabilizes_machine' });
    });
});
