import type { CreateHostRequest, HostProvider } from './host-provider';
import type { GrantRepo, ImageStoreConfig, ImageStoreProvider, StoreGrant } from './image-store';
import type { HostClass } from './pool';
import { isProviderError, ProviderError, type ProviderErrorKind } from './provider-error';

export { FakeHostProvider } from './fake-provider';

// The conformance suite every adapter runs (docs/runtime/host-providers.md
// §4.2), and the fake provider for specs. Specs only.

export interface ConformanceHarness {
    provider: HostProvider;
    cls: HostClass;
    /** The installation the provider was built for (default 'it-installation'). */
    installation?: string;
    /** The provider's next create fails the way its API would for this kind. */
    failNextCreate(kind: ProviderErrorKind): void;
    /** A host the provider holds for another installation; resolves to its provider id. */
    addForeignHost(): Promise<string>;
}

/** The rules every HostProvider keeps (docs/runtime/host-providers.md §4.2). */
export function describeHostProviderConformance(name: string, make: () => ConformanceHarness) {
    describe(`HostProvider conformance: ${name}`, () => {
        const request = (h: ConformanceHarness, hostId: string): CreateHostRequest => ({
            hostId,
            clientToken: hostId,
            cls: h.cls,
            from: 'kodus-env-template',
            bootstrap: { hubUrl: 'https://hub.example:3410', hubCa: '-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----\n', token: `kcf_${'a'.repeat(43)}` },
            tags: { installation: h.installation ?? 'it-installation', pool: 'boat-eu-perrun', host: hostId },
        });

        it('creating twice with the same client token yields one host', async () => {
            const h = make();
            const a = await h.provider.create(request(h, 'host-1'));
            const b = await h.provider.create(request(h, 'host-1'));
            expect(b.providerId).toBe(a.providerId);
            expect((await h.provider.list({ installation: h.installation ?? 'it-installation' })).map((x) => x.providerId)).toEqual([a.providerId]);
        });

        it('list returns every host of this installation, across pages, and no other', async () => {
            const h = make();
            const ids = [];
            for (const id of ['host-1', 'host-2', 'host-3']) ids.push((await h.provider.create(request(h, id))).providerId);
            await h.addForeignHost();
            const listed = await h.provider.list({ installation: h.installation ?? 'it-installation' });
            expect(listed.map((x) => x.providerId).sort()).toEqual([...ids].sort());
            for (const x of listed) expect(x.tags.installation).toBe(h.installation ?? 'it-installation');
        });

        it('destroy of a host already gone succeeds, and get then says null', async () => {
            const h = make();
            const a = await h.provider.create(request(h, 'host-1'));
            await h.provider.destroy(a.providerId);
            await expect(h.provider.destroy(a.providerId)).resolves.toBeUndefined();
            expect(await h.provider.get(a.providerId)).toBeNull();
        });

        it('destroy never takes a host of another installation', async () => {
            const h = make();
            const foreign = await h.addForeignHost();
            await h.provider.destroy(foreign).catch(() => undefined);
            expect(await h.provider.get(foreign)).not.toBeNull();
        });

        it.each(['throttled', 'quota_exceeded', 'capacity_unavailable', 'unauthorized', 'invalid_class', 'transient'] as const)('a failed create is a typed %s ProviderError', async (kind) => {
            const h = make();
            h.failNextCreate(kind);
            const e = await h.provider.create(request(h, 'host-1')).then(() => null, (x: unknown) => x);
            expect(isProviderError(e)).toBe(true);
            expect((e as ProviderError).kind).toBe(kind);
        });
    });
}

export { FakeImageStoreProvider } from './image-store-fake';

// The conformance suite every image store provider runs (docs/runtime/shared-image-store.md section 2). Specs only.

export interface ImageStoreConformanceHarness {
    provider: ImageStoreProvider;
    config: ImageStoreConfig;
    /** The repositories the token a grant returned names, with what it may do: how this provider's token is read back. */
    namedBy(grant: StoreGrant): Array<{ name: string; pull: boolean; push: boolean }>;
}

export function describeImageStoreConformance(name: string, make: () => ImageStoreConformanceHarness) {
    const repos = (): GrantRepo[] => [
        { scope: 'pr', name: 'p/o-a/e-b/pr-c', pull: true, push: true },
        { scope: 'main', name: 'p/o-a/e-b/main', pull: true, push: false },
    ];
    const now = new Date('2026-11-27T12:00:00.000Z');
    describe(`image store provider conformance: ${name}`, () => {
        it('a grant names exactly the repositories it was asked for, with the same rights, and no more', async () => {
            const h = make();
            const g = await h.provider.grant(h.config, { claimId: 'c1', organizationId: 'o', repos: repos(), ttlSeconds: 600 }, now);
            expect(h.namedBy(g).sort((a, b) => a.name.localeCompare(b.name))).toEqual([
                { name: 'p/o-a/e-b/main', pull: true, push: false },
                { name: 'p/o-a/e-b/pr-c', pull: true, push: true },
            ]);
        });

        it('a grant expires ttlSeconds after now, never later', async () => {
            const h = make();
            const g = await h.provider.grant(h.config, { claimId: 'c1', organizationId: 'o', repos: repos(), ttlSeconds: 600 }, now);
            expect(g.expiresAt).toBe('2026-11-27T12:10:00.000Z');
        });

        it('the endpoint and prefix of a grant are the ones endpointFor says, so the cell and the registry agree', async () => {
            const h = make();
            const g = await h.provider.grant(h.config, { claimId: 'c1', organizationId: 'o', repos: repos(), ttlSeconds: 600 }, now);
            expect({ endpoint: g.endpoint, prefix: g.prefix }).toEqual(h.provider.endpointFor(h.config));
        });

        it('a grant for a claim with no repositories is refused, so no empty credential is ever handed out', async () => {
            const h = make();
            await expect(h.provider.grant(h.config, { claimId: 'c1', organizationId: 'o', repos: [], ttlSeconds: 600 }, now)).rejects.toThrow();
        });

        it('revoke is idempotent', async () => {
            const h = make();
            await expect(h.provider.revoke('c1')).resolves.toBeUndefined();
            await expect(h.provider.revoke('c1')).resolves.toBeUndefined();
        });
    });
}
