import { parseHostPool } from '@libs/runtime/fleet/pool';

import { BoatHostProvider } from './boat-provider';

// The boat spike's live check (docs/runtime/host-providers.md §13): the recorded responses against the real API.
// Skipped unless RUNTIME_BOAT_LIVE_TEST=1 and RUNTIME_BOAT_API_KEY is set. It creates one `large` sandbox (one start,
// billed by the second), lists it by label, extends it and deletes it. Needs the $20 plan or higher: the trial has
// no `large`. RUNTIME_BOAT_LIVE_FROM names a saved snapshot to create from (optional).
const live = process.env.RUNTIME_BOAT_LIVE_TEST === '1' && !!process.env.RUNTIME_BOAT_API_KEY;

(live ? describe : describe.skip)('boat live (opt-in, RUNTIME_BOAT_LIVE_TEST=1)', () => {
    const installation = `live-${Date.now().toString(36)}`;
    const provider = new BoatHostProvider({ apiUrl: process.env.RUNTIME_BOAT_API_URL || 'https://boat.dev/api/v1', apiKey: process.env.RUNTIME_BOAT_API_KEY ?? '', installation });
    const cls = parseHostPool({
        kind: 'HostPool',
        name: 'boat-live',
        scope: 'kodus',
        provider: 'boat',
        lifecycle: 'perRun',
        hostClass: { kind: 'HostClass', name: 'boat-live', provider: 'boat', boat: { type: 'large', ttlSeconds: 900 } },
    }).hostClass;
    let providerId: string | undefined;

    afterAll(async () => {
        if (providerId) await provider.destroy(providerId);
    });

    it('creates a host idempotently, lists it by installation label, extends it, destroys it, and a second destroy is fine', async () => {
        const quotas = await provider.quotas(cls);
        expect(quotas?.classAvailable).toBe(true);
        const req = {
            hostId: `${installation}-h1`,
            clientToken: `${installation}-h1`,
            cls,
            ...(process.env.RUNTIME_BOAT_LIVE_FROM ? { from: process.env.RUNTIME_BOAT_LIVE_FROM } : {}),
            bootstrap: { hubUrl: 'https://hub.invalid:3410', hubCa: '-----BEGIN CERTIFICATE-----\nlive-test\n-----END CERTIFICATE-----\n', token: 'kcf_live-test-not-a-token' },
            tags: { installation, pool: 'boat-live', host: `${installation}-h1` },
        };
        const a = await provider.create(req);
        providerId = a.providerId;
        expect((await provider.create(req)).providerId).toBe(a.providerId);
        expect((await provider.list({ installation })).map((h) => h.providerId)).toEqual([a.providerId]);
        await provider.extend(a.providerId, 900);
        await provider.destroy(a.providerId);
        await provider.destroy(a.providerId);
        providerId = undefined;
    }, 180_000);
});
