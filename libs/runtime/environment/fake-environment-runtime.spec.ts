import type { Probe } from '@libs/runtime/probe';

import { isBlocked, isEnvError } from './environment-runtime';
import { FakeEnvironmentRuntime } from './fake-environment-runtime';

const SHA = 'a'.repeat(40);
const STEP = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';

const httpProbe: Probe = {
    id: 'orders-empty',
    origin: 'agent',
    purpose: 'empty cart on POST /orders',
    expected: '400',
    compare: ['status'],
    spec: { kind: 'http', target: { service: 'web', port: 3000 }, method: 'POST', path: '/orders', body: '{"items":[]}', timeoutMs: 1_000 },
};

const make = (now = () => new Date('2026-10-29T12:00:00Z')) =>
    new FakeEnvironmentRuntime(
        {
            shop: {
                imageId: 'ami-1',
                expose: [{ service: 'web', port: 3000, kind: 'http' }],
                probes: {
                    'orders-empty': {
                        base: () => ({ http: { status: 400, headers: {}, body: '' } }),
                        pr: () => ({ http: { status: 500, headers: {}, body: '' } }),
                    },
                },
            },
            broken: { imageId: 'ami-2', expose: [], blockers: [{ kind: 'missing_env', signature: 'STRIPE_KEY', message: 'needs a fake' }] },
        },
        now,
    );

const req = (side: 'base' | 'pr', key = side) => ({
    organizationId: 'org-1',
    environmentId: 'shop',
    runId: 'run-1',
    imageId: 'ami-1',
    ref: { side, sha: SHA },
    consumer: 'runtime' as const,
    idempotencyKey: `run-1:${key}:1`,
});

describe('FakeEnvironmentRuntime', () => {
    it('returns a claim with a ready observer and the exposed ports', async () => {
        const claim = await make().acquire(req('base'));
        expect(isBlocked(claim)).toBe(false);
        if (!isBlocked(claim)) {
            expect(claim.observer.state).toBe('ready');
            expect(claim.manifest.expose[0].port).toBe(3000);
            expect(claim.hardExpiresAt > claim.leaseExpiresAt).toBe(true);
        }
    });

    it('is idempotent on the same key', async () => {
        const env = make();
        const a = await env.acquire(req('base'));
        const b = await env.acquire(req('base'));
        expect(a).toEqual(b);
    });

    it('returns Blocked instead of hanging when the environment cannot boot', async () => {
        const r = await make().acquire({ ...req('base'), environmentId: 'broken' });
        expect(r).toMatchObject({ status: 'blocked', blockers: [{ kind: 'missing_env' }] });
    });

    it('answers probes per side from the observer', async () => {
        const env = make();
        const base = await env.acquire(req('base'));
        const pr = await env.acquire(req('pr'));
        if (isBlocked(base) || isBlocked(pr)) throw new Error('blocked');
        const b = await env.probe(base.claimId, httpProbe, STEP);
        const p = await env.probe(pr.claimId, httpProbe, STEP);
        expect(b).toMatchObject({ executor: 'observer', http: { status: 400 } });
        expect(p).toMatchObject({ executor: 'observer', http: { status: 500 } });
    });

    it('refuses to run a shell probe on the observer', async () => {
        const env = make();
        const c = await env.acquire(req('base'));
        if (isBlocked(c)) throw new Error('blocked');
        const shell: Probe = { ...httpProbe, spec: { kind: 'shell', command: 'pnpm test', timeoutMs: 1_000 } };
        await expect(env.probe(c.claimId, shell, STEP)).rejects.toThrow(/inside the VM/);
    });

    it('stops answering after release and after the hard expiry', async () => {
        let now = new Date('2026-10-29T12:00:00Z');
        const env = make(() => now);
        const c = await env.acquire(req('base'));
        if (isBlocked(c)) throw new Error('blocked');
        now = new Date('2026-10-29T13:01:00Z');
        expect(isEnvError(await env.probe(c.claimId, httpProbe, STEP))).toBe(true);

        const env2 = make();
        const c2 = await env2.acquire(req('base'));
        if (isBlocked(c2)) throw new Error('blocked');
        await env2.release(c2.claimId);
        expect(await env2.reset(c2.claimId)).toEqual({ code: 'lease_expired' });
    });
});
