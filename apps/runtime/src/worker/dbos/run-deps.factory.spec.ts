import { InMemoryRunProjectionStore } from '@libs/runtime/run/testing';
import { RuntimeMetrics } from '@libs/runtime/telemetry';

import { canaryKeyFrom, hubEnvironments, RunDependenciesFactory } from './run-deps.factory';

const options = (over: Partial<ConstructorParameters<typeof RunDependenciesFactory>[0]> = {}) => ({
    allowUnrenewedClaims: true,
    environment: () => ({}) as any,
    projection: new InMemoryRunProjectionStore(),
    claims: { forRun: async () => [], egressBlocked: async () => [], deniedEgressOfRun: async () => [], securityViolations: async () => [], hardExpired: async () => [] },
    releaser: { release: async () => undefined },
    publisher: { request: async () => undefined },
    llm: { complete: async () => ({ text: '{}', usage: { inputTokens: 0, outputTokens: 0 } }) },
    metrics: new RuntimeMetrics(),
    events: { append: async () => undefined },
    canaryKey: Buffer.alloc(32, 1),
    ...over,
});

describe('the suite stage of a Run', () => {
    const req = { runId: 'r1', correlationId: 'c', organizationId: 'o', repository: { id: 'repo', name: 'shop' }, pullRequest: { number: 1, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40) }, environment: { imageId: 'img', expose: [] } } as any;

    it("gives a Run the stage the worker built, built with the factory itself so its claims use the factory's environments", () => {
        const stage = { run: jest.fn() };
        const seen: unknown[] = [];
        const f = new RunDependenciesFactory(options({ suite: (factory) => (seen.push(factory), stage) }));
        expect(f.forRun(req).suite).toBe(stage);
        expect(seen).toEqual([f]);
    });

    it('leaves a Run with no stage where the worker has none', () => {
        expect(new RunDependenciesFactory(options()).forRun(req).suite).toBeUndefined();
    });
});

describe('the environment of a suite run', () => {
    const ctx = { organizationId: 'org-1', suiteRunId: 'sr-1', key: 'suite-key', correlationId: 'suite-sr-1', fullName: 'acme/shop', imageId: 'img-1', expose: [], tokens: ['sealed:v1:a', 'sealed:v1:b'] };

    it('builds one client per claim, each with the next sealed token bound to the command key and scoped to the suite run', async () => {
        const built: any[] = [];
        const f = new RunDependenciesFactory(options({ environment: (c) => (built.push(c), { acquire: async () => ({ claimId: 'c' }), renew: async () => ({ status: 'gone' as const }), release: async () => undefined }) as any }));
        const env = f.envForSuite(ctx);
        const acquire = (key: string) => env.acquire({ organizationId: 'org-1', environmentId: 'env-1', ref: { side: 'pr', sha: 'a'.repeat(40) }, consumer: 'suite', idempotencyKey: key });
        await acquire('k0');
        await acquire('k1');
        expect(built.map((c) => c.sealedRepoToken)).toEqual(['sealed:v1:a', 'sealed:v1:b']);
        expect(built[0]).toMatchObject({ tokenBinding: 'suite-key', fullName: 'acme/shop', organizationId: 'org-1', correlationId: 'suite-sr-1', imageId: 'img-1' });
        // The suite's claims are acquired with runId = the suite run: the hub refuses an exec scoped to anything else.
        expect(built[0].runId).toBe('sr-1');
    });

    it('refuses a production environment that cannot renew claims, as for a Run', () => {
        const f = new RunDependenciesFactory(options({ allowUnrenewedClaims: false }));
        expect(() => f.envForSuite(ctx)).not.toThrow();
        expect(() => (f.envForSuite(ctx) as any).acquire).not.toThrow();
        // The check runs when a client is built, which is at the first acquire.
        return expect(f.envForSuite(ctx).acquire({ organizationId: 'org-1', environmentId: 'e', ref: { side: 'pr', sha: 'a'.repeat(40) }, consumer: 'suite', idempotencyKey: 'k' })).rejects.toThrow('claim renewal');
    });
});

describe('control-plane reaper', () => {
    it('releases claims past their hard expiry through the hub, with their tenant, and counts reaper.terminated', async () => {
        const released: unknown[] = [];
        const metrics = new RuntimeMetrics();
        const spy = jest.spyOn(metrics, 'recordReaperTerminated');
        const f = new RunDependenciesFactory(
            options({
                metrics,
                claims: { forRun: async () => [], egressBlocked: async () => [], deniedEgressOfRun: async () => [], securityViolations: async () => [], hardExpired: async () => [{ claimId: 'c1', cellId: 'cell-1', orgId: 'org-1', runId: 'r1' }] },
                releaser: { release: async (ref) => void released.push(ref) },
            }),
        );
        expect(await f.reap(new Date(), metrics)).toBe(1);
        expect(released).toEqual([{ claimId: 'c1', organizationId: 'org-1', runId: 'r1' }]);
        expect(spy).toHaveBeenCalledWith({ cellId: 'cell-1', orgId: 'org-1', reason: 'hard_expired' });
    });

    it('a release the hub did not record is reported and left for the next tick, not counted', async () => {
        const failed: string[] = [];
        const metrics = new RuntimeMetrics();
        const spy = jest.spyOn(metrics, 'recordReaperTerminated');
        const f = new RunDependenciesFactory(
            options({
                claims: { forRun: async () => [], egressBlocked: async () => [], deniedEgressOfRun: async () => [], securityViolations: async () => [], hardExpired: async () => [{ claimId: 'c1', cellId: 'cell-1', orgId: 'org-1', runId: null }] },
                releaser: { release: async () => Promise.reject(new Error('hub unreachable')) },
                onReleaseFailed: (id) => void failed.push(id),
            }),
        );
        expect(await f.reap(new Date(), metrics)).toBe(0);
        expect(failed).toEqual(['c1']);
        expect(spy).not.toHaveBeenCalled();
    });
});

describe('canaries', () => {
    it('are keyed by a secret: another key gives other canaries for the same Run', () => {
        const run = { runId: 'r1', runToken: 'sealed:v1:x' } as any;
        const a = new RunDependenciesFactory(options({ canaryKey: canaryKeyFrom(Buffer.alloc(32, 1)) })).forStop({ runId: 'r1', correlationId: 'c', organizationId: 'o' }).canaries.forRun(run);
        const b = new RunDependenciesFactory(options({ canaryKey: canaryKeyFrom(Buffer.alloc(32, 2)) })).forStop({ runId: 'r1', correlationId: 'c', organizationId: 'o' }).canaries.forRun(run);
        expect(a.map((c) => c.value)).not.toEqual(b.map((c) => c.value));
    });
});

describe('lease renewal of a Run', () => {
    const req = { runId: 'r1', correlationId: 'c', organizationId: 'o', repoToken: 'sealed', repository: { name: 'shop' }, environment: { imageId: 'img', expose: [] } } as any;

    it('refuses an injected production environment without renewal for Runs and setups', () => {
        const f = new RunDependenciesFactory(options({ allowUnrenewedClaims: false }));
        expect(() => f.forRun(req)).toThrow('claim renewal');
        expect(() => f.envForSetup({ correlationId: 'c', organizationId: 'o', setupKey: 's', fullName: 'shop', sealedRepoToken: 'sealed', imageId: 'setup', expose: [] })).toThrow('claim renewal');
        expect(() => f.forStop(req)).not.toThrow();
    });

    it('the production hub environment implements renewal', () => {
        const environment = hubEnvironments({} as any, {} as any, { provider: 'github', apiBase: 'https://api.github.com' });
        const env = environment({ correlationId: 'c', organizationId: 'o', runId: 'r', fullName: 'shop', sealedRepoToken: 'sealed', tokenBinding: 'r', imageId: 'img', expose: [] });
        expect(typeof env.renew).toBe('function');
    });

    it('a Run whose environment renews gets a keeper that renews as consumer runtime and logs with the runId', async () => {
        const asked: unknown[] = [];
        const events: unknown[] = [];
        const fire: Array<() => void> = [];
        const env = { renew: async (claimId: string, consumer: string) => (asked.push([claimId, consumer]), { status: 'gone' as const }) };
        const f = new RunDependenciesFactory(
            options({
                environment: () => env as any,
                leaseRenewal: { timers: { setTimeout: (fn) => fire.push(fn), clearTimeout: () => undefined } },
                onLeaseEvent: (runId, e) => void events.push([runId, e]),
            }),
        );
        const deps = f.forRun(req);
        deps.leases!.keep(['c1']);
        fire.shift()!();
        await new Promise((r) => setImmediate(r));
        expect(asked).toEqual([['c1', 'runtime']]);
        expect(events).toEqual([['r1', { type: 'gone', claimId: 'c1' }]]);
    });

    it('an environment without renew gets no keeper, and a stopped Run never renews', () => {
        expect(new RunDependenciesFactory(options()).forRun(req).leases).toBeUndefined();
        const env = { renew: async () => ({ status: 'gone' as const }) };
        expect(new RunDependenciesFactory(options({ environment: () => env as any })).forStop(req).leases).toBeUndefined();
    });
});
