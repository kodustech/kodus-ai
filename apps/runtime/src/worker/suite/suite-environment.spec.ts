import type { AcquireRequest, Claim, EnvironmentRuntime } from '@libs/runtime/environment';
import { isBlocked } from '@libs/runtime/environment';

import { ExecArtifactSource } from './suite-artifacts';
import { execInService, suiteEnvironment } from './suite-environment';

// The cell revokes a repository download token once it fetched with it, so a suite run, which holds one claim per shard
// plus the fresh host and the main host, needs one token per claim. Each claim is acquired by a client built with its own.

const req = (key: string): AcquireRequest => ({ organizationId: 'org-a', environmentId: 'env-1', ref: { side: 'pr', sha: 'a'.repeat(40) }, consumer: 'suite', idempotencyKey: key });

function world(tokens: string[], renewal?: Parameters<typeof suiteEnvironment>[2]) {
    const acquired: Array<{ token: string; key: string }> = [];
    const calls: string[] = [];
    const client = (token: string): EnvironmentRuntime =>
        ({
            renew: async (claimId: string, consumer: string) => {
                calls.push(`renew:${token}:${claimId}:${consumer}`);
                return { status: 'renewed' as const, leaseExpiresAt: '', hardExpiresAt: '', atCeiling: false };
            },
            acquire: async (r: AcquireRequest) => {
                acquired.push({ token, key: r.idempotencyKey });
                return { claimId: `claim-${r.idempotencyKey}` } as Claim;
            },
            exec: async (claimId: string) => {
                calls.push(`exec:${token}:${claimId}`);
                return { stepId: 's', exitCode: 0, stdout: '', stderr: '', truncated: false, durationMs: 1, transport: 'ok' as const };
            },
            release: async (claimId: string) => void calls.push(`release:${token}:${claimId}`),
        }) as unknown as EnvironmentRuntime;
    return { env: suiteEnvironment(client, tokens, renewal), acquired, calls };
}

describe('the environment of a suite run', () => {
    it('acquires each claim with a token of its own, in the order the claims are asked for', async () => {
        const w = world(['t1', 't2', 't3']);
        await w.env.acquire(req('k0'));
        await w.env.acquire(req('k1'));
        expect(w.acquired).toEqual([{ token: 't1', key: 'k0' }, { token: 't2', key: 'k1' }]);
    });

    it('asked again for a claim it already acquired, spends no second token', async () => {
        const w = world(['t1', 't2']);
        await w.env.acquire(req('k0'));
        await w.env.acquire(req('k0'));
        await w.env.acquire(req('k1'));
        expect(w.acquired.map((a) => a.token)).toEqual(['t1', 't1', 't2']);
    });

    it('answers a typed blocker when the tokens run out, so the engine reads it as infra and never a failure of the PR', async () => {
        const w = world(['t1']);
        await w.env.acquire(req('k0'));
        const out = await w.env.acquire(req('k1'));
        expect(isBlocked(out)).toBe(true);
        expect((out as { blockers: Array<{ signature: string }> }).blockers[0].signature).toBe('suite_tokens_exhausted');
        expect(w.acquired).toHaveLength(1);
    });

    it('runs commands and releases through any of its clients', async () => {
        const w = world(['t1']);
        await w.env.acquire(req('k0'));
        await w.env.exec('claim-k0', { stepId: 's', command: 'true', timeoutMs: 1000 });
        await w.env.release('claim-k0');
        expect(w.calls).toEqual(['exec:t1:claim-k0', 'release:t1:claim-k0']);
    });

    // A claim's lease is 45 minutes from its acquire and a suite outlasts it: while the engine holds a claim, it is renewed as consumer suite.
    it('keeps every claim it acquired leased as consumer suite, until the claim is released', async () => {
        const fire: Array<() => void> = [];
        const w = world(['t1', 't2'], { timers: { setTimeout: (fn: () => void) => (fire.push(fn), fire.length), clearTimeout: () => undefined }, everyMs: 1000 });
        await w.env.acquire(req('k0'));
        await w.env.acquire(req('k1'));
        fire.shift()!();
        await new Promise((r) => setImmediate(r));
        expect(w.calls.filter((c) => c.startsWith('renew:'))).toEqual(['renew:t1:claim-k0:suite']);
        await w.env.release('claim-k0');
        w.calls.length = 0;
        fire.shift()!();
        await new Promise((r) => setImmediate(r));
        // The first claim's renewal is stopped; the second's keeps going.
        expect(w.calls.filter((c) => c.startsWith('renew:'))).toEqual(['renew:t2:claim-k1:suite']);
    });
});

describe('exec in the suite service', () => {
    const seen: Array<{ service?: string; command: string }> = [];
    const base = {
        exec: async (_claimId: string, r: { stepId: string; command: string; service?: string }) => {
            seen.push({ command: r.command, ...(r.service !== undefined ? { service: r.service } : {}) });
            return { stepId: r.stepId, exitCode: 0, stdout: '', stderr: '', truncated: false, durationMs: 1, transport: 'ok' as const };
        },
    };
    beforeEach(() => (seen.length = 0));

    it('names the service on every exec, and keeps one a request already names', async () => {
        const env = execInService(base, 'e2e');
        await env.exec('c1', { stepId: 's1', command: 'ls', timeoutMs: 1 });
        await env.exec('c1', { stepId: 's2', command: 'id', timeoutMs: 1, service: 'other' });
        expect(seen).toEqual([{ command: 'ls', service: 'e2e' }, { command: 'id', service: 'other' }]);
    });

    it('is the environment itself when the recipe names no service', async () => {
        expect(execInService(base, undefined)).toBe(base);
    });

    it('the artifact source reads the runner\'s files in that service', async () => {
        await new ExecArtifactSource(execInService(base, 'e2e'), 'art-1').list('c1', { cwd: 'apps/dashboard', dirs: ['cypress/screenshots'] });
        expect(seen).toHaveLength(1);
        expect(seen[0].service).toBe('e2e');
    });
});
