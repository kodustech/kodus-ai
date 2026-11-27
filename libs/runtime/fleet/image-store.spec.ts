import { boundKeyKind, ImageStoreConfigSchema, planGrant, storeHash, storeRepoName } from './image-store';
import { parseHostPool, poolSpecHash } from './pool';
import { describeImageStoreConformance, FakeImageStoreProvider } from './testing';

const ORG = 'org-1';
const ENV = 'env-1';
const SHA = 'a'.repeat(40);
const ask = (boundKey: string | undefined, side: 'base' | 'pr') => ({ organizationId: ORG, environmentId: ENV, boundKey, side, sha: SHA });
const summary = (g: ReturnType<typeof planGrant>) => g?.map((r) => `${r.scope}:${r.pull ? 'r' : ''}${r.push ? 'w' : ''}`).sort();

describe('image store naming', () => {
    // The cell names repositories with remotecache.hashOf: the same bytes, or a scoped token would name the wrong repository.
    it('the store hash is the cell hash: sha256 over length-prefixed parts, 32 hex', () => {
        // The same values the Go cell computes (remotecache.hashOf), checked by running it.
        expect(storeHash('a', 'bc')).toBe('5310a58788781ab25d5ad7c3f8503582');
        expect(storeHash('org-é', 'e')).toBe('52f0a376b865b7839e331812677fb355');
        expect(storeHash('ab', 'c')).not.toBe(storeHash('a', 'bc'));
    });

    it("one org's repositories all share the org's own path segment, and another org's never do", () => {
        const a = storeRepoName('kodus-ci', 'org-a', 'e', 'main');
        const b = storeRepoName('kodus-ci', 'org-b', 'e', 'main');
        expect(a.startsWith(`kodus-ci/o-${storeHash('org-a')}/`)).toBe(true);
        expect(a.split('/')[1]).not.toBe(b.split('/')[1]);
    });

    it('each PR sha has its own repository, so one token can never overwrite another PR tag', () => {
        expect(storeRepoName('p', 'o', 'e', 'pr', 'a'.repeat(40))).not.toBe(storeRepoName('p', 'o', 'e', 'pr', 'b'.repeat(40)));
    });
});

describe('who may read and write what', () => {
    it('the PR side of a Run reads main and cache and writes only its own PR repository', () => {
        expect(summary(planGrant(ask(`run:${ORG}/r1`, 'pr'), 'p'))).toEqual(['cache:r', 'main:r', 'pr:rw']);
    });

    it('the base side of a Run only reads main', () => {
        expect(summary(planGrant(ask(`run:${ORG}/r1`, 'base'), 'p'))).toEqual(['main:r']);
    });

    it('a suite shard reads its PR repository and main and writes nothing', () => {
        expect(summary(planGrant(ask(`suite:${ORG}/s1/0`, 'pr'), 'p'))).toEqual(['main:r', 'pr:r']);
    });

    it('a default-branch setup writes main and cache, and a setup of a PR writes nothing (S-52)', () => {
        expect(summary(planGrant(ask(`setup:${ORG}/abc`, 'base'), 'p'))).toEqual(['cache:rw', 'main:rw']);
        expect(summary(planGrant(ask(`setup:${ORG}/abc`, 'pr'), 'p'))).toEqual(['cache:r', 'main:r']);
    });

    it('a template setup host only reads main', () => {
        expect(summary(planGrant(ask(`template:${ORG}/env-1`, 'base'), 'p'))).toEqual(['main:r']);
    });

    it('a host with no bound key, or a key of another org, gets no grant at all', () => {
        expect(planGrant(ask(undefined, 'pr'), 'p')).toBeNull();
        expect(planGrant(ask('run:other-org/r1', 'pr'), 'p')).toBeNull();
        expect(boundKeyKind(ORG, `run:${ORG}x/r1`)).toBeNull();
    });

    it('a PR claim that builds reads main and cache and never writes either, whatever its bound key kind', () => {
        for (const key of [`run:${ORG}/r`, `setup:${ORG}/h`]) {
            const grant = planGrant(ask(key, 'pr'), 'p') ?? [];
            for (const scope of ['main', 'cache'] as const) {
                const r = grant.find((g) => g.scope === scope);
                expect({ key, scope, pull: r?.pull, push: r?.push }).toEqual({ key, scope, pull: true, push: false });
            }
        }
    });

    it('no grant ever lets a PR side write main or cache', () => {
        for (const key of [`run:${ORG}/r`, `suite:${ORG}/s/0`, `setup:${ORG}/h`, `template:${ORG}/e`]) {
            const writes = planGrant(ask(key, 'pr'), 'p')?.filter((r) => r.push).map((r) => r.scope) ?? [];
            expect(writes.filter((s) => s !== 'pr')).toEqual([]);
        }
    });
});

describe('the pool config', () => {
    const pool = (imageStore?: unknown) => ({ kind: 'HostPool', name: 'boat-eu', scope: 'kodus', provider: 'boat', lifecycle: 'perRun', hostClass: { kind: 'HostClass', name: 'b', provider: 'boat', boat: { type: 'large' } }, ...(imageStore ? { imageStore } : {}) });

    it('a pool names its store by provider and endpoint, with the safe defaults', () => {
        expect(parseHostPool(pool({ provider: 'oci-registry', endpoint: 'https://store.example' })).imageStore).toEqual({ provider: 'oci-registry', endpoint: 'https://store.example', prefix: 'kodus-ci', service: 'kodus-image-store', tokenTtlSeconds: 600 });
    });

    it('plain HTTP is refused except for a loopback registry, and a token cannot live past 15 minutes', () => {
        expect(() => ImageStoreConfigSchema.parse({ provider: 'oci-registry', endpoint: 'http://store.example' })).toThrow();
        expect(() => ImageStoreConfigSchema.parse({ provider: 'oci-registry', endpoint: 'http://localhost:5000' })).not.toThrow();
        expect(() => ImageStoreConfigSchema.parse({ provider: 'oci-registry', endpoint: 'https://s.example', tokenTtlSeconds: 3600 })).toThrow();
    });

    it('swapping the provider changes only config: the spec hash of the hosts is the same', () => {
        const a = parseHostPool(pool({ provider: 'oci-registry', endpoint: 'https://store.example' }));
        const b = parseHostPool(pool({ provider: 'fake' }));
        expect(poolSpecHash(a)).toBe(poolSpecHash(b));
        expect(poolSpecHash(a)).toBe(poolSpecHash(parseHostPool(pool())));
    });
});

describeImageStoreConformance('fake', () => {
    const provider = new FakeImageStoreProvider();
    return {
        provider,
        config: ImageStoreConfigSchema.parse({ provider: 'fake' }),
        namedBy: (g) => g.repos.map((r) => ({ name: r.name, pull: r.pull, push: r.push })),
    };
});
