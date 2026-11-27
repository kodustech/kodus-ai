import { randomUUID } from 'crypto';

import { ImageStoreConfigSchema } from '@libs/runtime/fleet/image-store';
import { FakeImageStoreProvider } from '@libs/runtime/fleet/testing';
import { decodeFrame, PROTOCOL_VERSION } from '@libs/runtime/protocol';
import { InMemoryRunStreamStore } from '@libs/runtime/run/testing';
import { RuntimeMetrics } from '@libs/runtime/telemetry';

import { createCa } from './ca/x509';
import { CellCredential, CellHub } from './cell-hub';
import { InMemoryHubStore, InMemoryImageStoreBook } from './testing';

// The shared image store at the hub (docs/runtime/shared-image-store.md sections 4 to 6): what a claim.acquire carries,
// what image.pushed records, what a shard is told, what renewal sends. Real frames, the hub's own store and book.

class FakeSocket {
    sent: any[] = [];
    send(d: string) {
        const r = decodeFrame(d);
        if ('code' in r) throw new Error(`hub sent an invalid frame: ${r.code} ${r.message}`);
        this.sent.push(r.message);
    }
    close() {}
    last(type?: string) {
        return [...this.sent].reverse().find((m) => !type || m.type === type);
    }
}

const SHA = 'a'.repeat(40);
const fp = (c: string) => c.repeat(64);
const dg = (c: string) => `sha256:${c.repeat(64)}`;
const frame = (cellId: string, type: string, body: unknown, extra: Record<string, unknown> = {}) => JSON.stringify({ v: PROTOCOL_VERSION, id: randomUUID(), cellId, type, body, ...extra });
const tick = () => new Promise((r) => setImmediate(r));
const CRED: CellCredential = { cellId: 'cell-a', owner: 'kodus' };
const FEATURES = ['seedsCache', 'claimSize', 'egressAllow', 'poolMachineSize', 'authoredFiles'];
const manifest = { services: [{ name: 'web', health: 'ok' }], expose: [{ service: 'web', port: 3000, kind: 'http' }], imageId: 'img-1', seedSha: 'seed-1' };

function setup(opts: { provider?: FakeImageStoreProvider; poolHasStore?: boolean } = {}) {
    const store = new InMemoryHubStore();
    const book = new InMemoryImageStoreBook();
    const provider = opts.provider ?? new FakeImageStoreProvider();
    const config = ImageStoreConfigSchema.parse({ provider: 'fake' });
    const hub = new CellHub(store, new InMemoryRunStreamStore(), new RuntimeMetrics(), {
        replicaId: 'r1',
        replicaUrl: 'http://hub',
        ca: createCa('spec CA'),
        log: () => undefined,
        now: () => new Date('2026-11-27T12:00:00.000Z'),
        imageStore: { book, pools: { imageStoreOf: async () => (opts.poolHasStore === false ? null : config) }, providerFor: () => provider, waitMs: 0 },
    });
    /** A cell bound to `boundKey` in pool `boat`, which names (or not) the imageStore feature. */
    const connect = async (features: string[], boundKey: string) => {
        const sock = new FakeSocket();
        const h = hub.attach(sock, CRED);
        await h.onMessage(frame('cell-a', 'hello', { versions: [1], driver: 'docker-gvisor', isolation: 'vm', regions: ['local'], owner: 'kodus', features, maxClaimSize: { memoryMb: 65_536, cpus: 16 } }));
        Object.assign(store.sessions.get('cell-a')!, { poolId: 'boat', boundKey });
        return { sock, ...h };
    };
    type Conn = Awaited<ReturnType<typeof connect>>;
    const acquire = async (c: Conn, over: { side: 'base' | 'pr'; key: string; org?: string }) => {
        const p = hub.acquire('cell-a', {
            organizationId: over.org ?? 'org-a',
            environmentId: 'shop',
            runId: 'run-1',
            imageId: 'img-1',
            ref: { side: over.side, sha: SHA },
            consumer: 'runtime',
            idempotencyKey: over.key,
            expose: [{ service: 'web', port: 3000, kind: 'http' }],
            repo: { provider: 'github', fullName: 'acme/shop', apiBase: 'https://api.github.com' },
            repoToken: 'tok',
        });
        await tick();
        await tick();
        const req = c.sock.last('claim.acquire');
        await c.onMessage(frame('cell-a', 'ack', {}, { re: req.id }));
        await c.onMessage(frame('cell-a', 'claim.ready', { manifest, observer: { id: 'obs-1', state: 'ready' } }, { claimId: req.claimId }));
        await p;
        return req;
    };
    return { hub, store, book, provider, connect, acquire };
}

const WITH_STORE = [...FEATURES, 'imageStore'];

describe('the shared image store at the hub', () => {
    // The scope comes from the bound key of the claim's host, never from the cell.
    it("gives the Run's PR side a grant that reads main and cache and writes only its own PR repository, and no digests", async () => {
        const ctx = setup();
        const c = await ctx.connect(WITH_STORE, 'run:org-a/run-1');
        const req = await ctx.acquire(c, { side: 'pr', key: 'run-1:pr' });
        const grant = req.body.imageStore.grant;
        expect(grant.repos.map((r: any) => `${r.scope}:${r.push ? 'rw' : 'r'}`).sort()).toEqual(['cache:r', 'main:r', 'pr:rw']);
        expect(grant.token).toContain('fake.');
        expect(req.body.imageStore.prImages).toBeUndefined();
        expect(await ctx.book.prImage('org-a', 'shop', SHA)).toMatchObject({ state: 'pending', builderClaim: req.claimId });
    });

    it('records the digest the builder pushed and tells the suite shard of the same PR to pull it, with a read-only grant', async () => {
        const ctx = setup();
        const c = await ctx.connect(WITH_STORE, 'run:org-a/run-1');
        const builder = await ctx.acquire(c, { side: 'pr', key: 'run-1:pr' });
        await c.onMessage(frame('cell-a', 'image.pushed', { status: 'ok', images: [{ fingerprint: fp('1'), digest: dg('1'), bytes: 10, pushMs: 5 }] }, { claimId: builder.claimId }));
        expect(c.sock.last()).toMatchObject({ type: 'ack' });

        const s = await ctx.connect(WITH_STORE, 'suite:org-a/suite-1/0');
        const shard = await ctx.acquire(s, { side: 'pr', key: 'suite-1:0' });
        expect(shard.body.imageStore.prImages).toEqual([{ fingerprint: fp('1'), digest: dg('1') }]);
        expect(shard.body.imageStore.grant.repos.every((r: any) => !r.push)).toBe(true);
    });

    it('sends nothing to a cell that does not name the feature: it builds as before', async () => {
        const ctx = setup();
        const c = await ctx.connect(FEATURES, 'run:org-a/run-1');
        const req = await ctx.acquire(c, { side: 'pr', key: 'run-1:pr' });
        expect(req.body.imageStore).toBeUndefined();
        expect(ctx.provider.grants).toEqual([]);
    });

    it('sends nothing for a pool with no store, or a host bound to another org, and the claim still becomes ready', async () => {
        const noStore = setup({ poolHasStore: false });
        const a = await noStore.connect(WITH_STORE, 'run:org-a/run-1');
        expect((await noStore.acquire(a, { side: 'pr', key: 'run-1:pr' })).body.imageStore).toBeUndefined();

        const other = setup();
        const b = await other.connect(WITH_STORE, 'run:org-z/run-1');
        expect((await other.acquire(b, { side: 'pr', key: 'run-1:pr' })).body.imageStore).toBeUndefined();
    });

    // The store only makes things faster: no store failure fails a Run.
    it('starts the claim with no store when the provider fails to mint, and counts nothing as pending', async () => {
        const provider = new FakeImageStoreProvider();
        provider.failNext();
        const ctx = setup({ provider });
        const c = await ctx.connect(WITH_STORE, 'run:org-a/run-1');
        const req = await ctx.acquire(c, { side: 'pr', key: 'run-1:pr' });
        expect(req.body.imageStore).toBeUndefined();
        expect(await ctx.book.prImage('org-a', 'shop', SHA)).toBeNull();
    });

    it('refuses nothing and records nothing for an image.pushed from a claim that was not granted the write', async () => {
        const ctx = setup();
        const c = await ctx.connect(WITH_STORE, 'run:org-a/run-1');
        const base = await ctx.acquire(c, { side: 'base', key: 'run-1:base' });
        await c.onMessage(frame('cell-a', 'image.pushed', { status: 'ok', images: [{ fingerprint: fp('1'), digest: dg('1'), bytes: 10, pushMs: 5 }] }, { claimId: base.claimId }));
        expect(await ctx.book.prImage('org-a', 'shop', SHA)).toBeNull();
    });

    it("renews the claim's credential with its lease, for the same repositories and a later expiry", async () => {
        const ctx = setup();
        const c = await ctx.connect(WITH_STORE, 'run:org-a/run-1');
        const builder = await ctx.acquire(c, { side: 'pr', key: 'run-1:pr' });
        const p = ctx.hub.leases.renew({ claimId: builder.claimId, organizationId: 'org-a' }, 'runtime');
        await tick();
        await tick();
        const renew = c.sock.last('claim.renew');
        expect(renew.body.imageStoreGrant.repos.map((r: any) => r.scope).sort()).toEqual(['cache', 'main', 'pr']);
        await c.onMessage(frame('cell-a', 'ack', {}, { re: renew.id }));
        await p;
        expect((await ctx.book.grantOf(builder.claimId))?.renewals).toBe(1);
    });

    it('ends the claim: its credential is no longer renewed and a PR image it never finished is failed, so shards stop waiting', async () => {
        const ctx = setup();
        const c = await ctx.connect(WITH_STORE, 'run:org-a/run-1');
        const builder = await ctx.acquire(c, { side: 'pr', key: 'run-1:pr' });
        const released = ctx.hub.claims.release({ claimId: builder.claimId, organizationId: 'org-a' });
        await tick();
        await tick();
        await c.onMessage(frame('cell-a', 'ack', {}, { re: c.sock.last('claim.release').id }));
        await released;
        await tick();
        expect(await ctx.book.grantOf(builder.claimId)).toBeNull();
        expect(await ctx.book.prImage('org-a', 'shop', SHA)).toMatchObject({ state: 'failed', reason: 'builder_ended' });
    });
});
