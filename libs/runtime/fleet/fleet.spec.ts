import { isProviderError, ProviderError } from './provider-error';
import { HostPoolSchema, isControlled, parseHostPool, poolSpecHash } from './pool';
import { describeHostProviderConformance, FakeHostProvider } from './testing';

const boatPool = {
    kind: 'HostPool',
    name: 'boat-eu-perrun',
    scope: 'kodus',
    provider: 'boat',
    lifecycle: 'perRun',
    labels: { region: 'eu-central', residency: 'eu', backend: 'microvm' },
    weight: 100,
    admission: { allowOrgs: ['org-kodus'] },
    hostClass: { kind: 'HostClass', name: 'boat-large-cell', provider: 'boat', boat: { type: 'large', ttlSeconds: 7200 } },
};

describe('host pools', () => {
    it('a perRun boat pool parses with the safe defaults: no env, no snapshots, no monitoring, fail fast', () => {
        const pool = parseHostPool(boatPool);
        expect(pool.lifecycle).toBe('perRun');
        expect(pool.hostClass.provider === 'boat' && pool.hostClass.boat).toEqual({ type: 'large', ttlSeconds: 7200, noEnv: true, snapshots: false, monitoring: false, failFast: true });
        expect(pool.perRun).toEqual({ registrationTimeoutSeconds: 600, maxRunMinutes: 120 });
    });

    it("a boat class may name the cell base its Run hosts start from: a kodus-cell- saved image, never an environment template", () => {
        const cls = (base: string) => ({ kind: 'HostPool', name: 'boat-eu', scope: 'kodus', provider: 'boat', lifecycle: 'perRun', hostClass: { kind: 'HostClass', name: 'boat-l', provider: 'boat', boat: { type: 'large', base } } });
        expect(parseHostPool(cls('kodus-cell-r42-gvisor')).hostClass).toMatchObject({ boat: { base: 'kodus-cell-r42-gvisor' } });
        for (const base of ['kodus-env-0a1b2c3d4e-5f6a7b8c9d-0011223344556677', 'my-snapshot', `kodus-cell-${'a'.repeat(53)}`]) expect(() => parseHostPool(cls(base))).toThrow();
    });

    it('a pool whose class is another provider than its own is refused', () => {
        expect(() => parseHostPool({ ...boatPool, provider: 'aws' })).toThrow(/provider/);
    });

    it('a pooled pool must say its capacity, with min at most max', () => {
        const pooled = { ...boatPool, lifecycle: 'pooled' };
        expect(HostPoolSchema.safeParse(pooled).success).toBe(false);
        expect(HostPoolSchema.safeParse({ ...pooled, capacity: { min: 3, max: 2, warm: 0 } }).success).toBe(false);
        expect(HostPoolSchema.safeParse({ ...pooled, capacity: { min: 0, max: 2, warm: 1 } }).success).toBe(true);
    });

    it('a static pool is pooled, needs no capacity, and no controller acts on it', () => {
        const pool = parseHostPool({ kind: 'HostPool', name: 'kodus-static', scope: 'kodus', provider: 'static', lifecycle: 'pooled', hostClass: { kind: 'HostClass', name: 'static', provider: 'static' } });
        expect(pool.lifecycle).toBe('pooled');
        expect(isControlled(pool)).toBe(false);
        expect(isControlled(parseHostPool(boatPool))).toBe(true);
    });

    it('an org-scoped pool names the org, and a pool name is a short slug', () => {
        expect(HostPoolSchema.safeParse({ ...boatPool, scope: 'org:' }).success).toBe(false);
        expect(HostPoolSchema.safeParse({ ...boatPool, scope: 'org:acme' }).success).toBe(true);
        expect(HostPoolSchema.safeParse({ ...boatPool, name: 'Has Spaces' }).success).toBe(false);
    });

    it('the spec hash follows what shapes a host, not behaviour fields', () => {
        const a = parseHostPool(boatPool);
        expect(poolSpecHash(parseHostPool({ ...boatPool, weight: 5 }))).toBe(poolSpecHash(a));
        expect(poolSpecHash(parseHostPool({ ...boatPool, hostClass: { ...boatPool.hostClass, boat: { type: 'xlarge' } } }))).not.toBe(poolSpecHash(a));
    });
});

describe('provider errors', () => {
    it('are typed, and only throttled, capacity and transient errors are retried', () => {
        const e = new ProviderError('throttled', 'rate_limited', { retryAfterMs: 5000, window: 'minute' });
        expect(isProviderError(e)).toBe(true);
        expect(isProviderError(new Error('x'))).toBe(false);
        expect(e.retryable).toBe(true);
        expect(new ProviderError('capacity_unavailable', 'no_ready_machine').retryable).toBe(true);
        expect(new ProviderError('transient', 'http_503').retryable).toBe(true);
        for (const kind of ['quota_exceeded', 'invalid_class', 'unauthorized'] as const) expect(new ProviderError(kind, 'x').retryable).toBe(false);
    });
});

describeHostProviderConformance('fake', () => {
    const provider = new FakeHostProvider({ pageSize: 2 });
    return {
        provider,
        cls: parseHostPool(boatPool).hostClass,
        failNextCreate: (kind) => provider.failNext('create', new ProviderError(kind, `fake_${kind}`)),
        addForeignHost: async () => provider.addForeign(),
    };
});
