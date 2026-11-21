import { randomUUID } from 'crypto';

import { decodeFrame, PROTOCOL_VERSION } from '@libs/runtime/protocol';
import { InMemoryRunStreamStore } from '@libs/runtime/run/testing';
import { RuntimeMetrics } from '@libs/runtime/telemetry';

import { createCa } from './ca/x509';
import { CellCredential, CellHub, HubLogLine } from './cell-hub';
import { InMemoryHubStore } from './testing';

// Shared baked environments (docs/runtime/shared-baked-environments.md §8):
// the hub records what a cell pushed only for a bake it asked of that cell,
// for that org, the newest bake winning, the last two bakes kept; it hands
// the record to the org's claims on any cell that names bakeShare.

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
const SHA2 = 'b'.repeat(40);
const fp = (c: string) => c.repeat(64);
const dg = (c: string) => `sha256:${c.repeat(64)}`;
const frame = (cellId: string, type: string, body: unknown, extra: Record<string, unknown> = {}) => JSON.stringify({ v: PROTOCOL_VERSION, id: randomUUID(), cellId, type, body, ...extra });
const tick = () => new Promise((r) => setImmediate(r));
const CRED: Record<string, CellCredential> = {
    'cell-a': { cellId: 'cell-a', owner: 'kodus' },
    'cell-b': { cellId: 'cell-b', owner: 'customer', orgId: 'org-b' },
    'cell-c': { cellId: 'cell-c', owner: 'kodus' },
};
const BASE_FEATURES = ['seedsCache', 'claimSize', 'egressAllow', 'poolMachineSize', 'authoredFiles'];
const SHARING = [...BASE_FEATURES, 'bakeShare'];
const manifest = { services: [{ name: 'web', health: 'ok' }], expose: [{ service: 'web', port: 3000, kind: 'http' }], imageId: 'img-1', seedSha: 'seed-1' };

function setup() {
    const store = new InMemoryHubStore();
    const logs: HubLogLine[] = [];
    let now = Date.parse('2026-11-17T10:00:00.000Z');
    const hub = new CellHub(store, new InMemoryRunStreamStore(), new RuntimeMetrics(), {
        replicaId: 'r1',
        replicaUrl: 'http://hub',
        ca: createCa('spec CA'),
        log: (l) => void logs.push(l),
        now: () => new Date(now),
    });
    const connect = async (cellId: string, features: string[]) => {
        const sock = new FakeSocket();
        const h = hub.attach(sock, CRED[cellId]);
        await h.onMessage(frame(cellId, 'hello', { versions: [1], driver: 'docker-gvisor', isolation: 'vm', regions: ['local'], owner: CRED[cellId].owner, features, maxClaimSize: { memoryMb: 65_536, cpus: 16 } }));
        return { sock, ...h, cellId };
    };
    type Conn = Awaited<ReturnType<typeof connect>>;
    /** A claim on c, answered ready; returns the claim.acquire the cell got. */
    const acquire = async (c: Conn, over: { org?: string; consumer?: 'runtime' | 'setup'; side?: 'base' | 'pr' | 'setup'; key: string; sha?: string }) => {
        const org = over.org ?? 'org-a';
        const consumer = over.consumer ?? 'runtime';
        const p = hub.acquire(c.cellId, {
            organizationId: org,
            environmentId: 'shop',
            ...(consumer === 'setup' ? {} : { runId: 'run-1' }),
            imageId: 'img-1',
            ref: { side: over.side ?? 'base', sha: over.sha ?? SHA },
            consumer,
            idempotencyKey: over.key,
            expose: [{ service: 'web', port: 3000, kind: 'http' }],
            repo: { provider: 'github', fullName: 'acme/shop', apiBase: 'https://api.github.com' },
            repoToken: 'tok',
        });
        await tick();
        await tick();
        const req = c.sock.last('claim.acquire');
        await c.onMessage(frame(c.cellId, 'ack', {}, { re: req.id }));
        await c.onMessage(frame(c.cellId, 'claim.ready', { manifest, observer: { id: 'obs-1', state: 'ready' } }, { claimId: req.claimId }));
        return { req, claim: (await p) as any };
    };
    /** The setup claim on c, then the image.bake of its commit, accepted. */
    const bake = async (c: Conn, over: { org?: string; sha?: string; key: string }) => {
        const { claim } = await acquire(c, { org: over.org, consumer: 'setup', side: 'setup', key: over.key, sha: over.sha });
        const p = hub.bake({ organizationId: over.org ?? 'org-a', environmentId: 'shop', recipeSha: 'r1', sha: over.sha ?? SHA, claimId: claim.claimId });
        await tick();
        await tick();
        const sent = c.sock.last('image.bake');
        await c.onMessage(frame(c.cellId, 'ack', {}, { re: sent.id }));
        expect(await p).toEqual({ status: 'accepted' });
    };
    const shared = async (c: Conn, body: { org?: string; sha?: string; images: { fingerprint: string; digest: string }[] }) => {
        await c.onMessage(frame(c.cellId, 'image.shared', { orgId: body.org ?? 'org-a', environmentId: 'shop', recipeSha: 'r1', sha: body.sha ?? SHA, images: body.images }));
        return c.sock.last();
    };
    return { hub, store, logs, connect, acquire, bake, shared, advance: (ms: number) => void (now += ms) };
}

describe('shared baked environments at the hub', () => {
    it("records what a cell pushed for the bake the hub asked, and hands it to the org's next claim on another cell", async () => {
        const ctx = setup();
        const a = await ctx.connect('cell-a', SHARING);
        await ctx.bake(a, { key: 'setup:1' });
        const images = [{ fingerprint: fp('1'), digest: dg('1') }];
        expect(await ctx.shared(a, { images })).toMatchObject({ type: 'ack' });

        const c = await ctx.connect('cell-c', SHARING);
        const { req } = await ctx.acquire(c, { key: 'run-1:base:1' });
        expect(req.body.sharedImages).toEqual(images);
    });

    it('refuses a record for a bake it never asked of that cell, or for another org, and records nothing', async () => {
        const ctx = setup();
        const a = await ctx.connect('cell-a', SHARING);
        await ctx.bake(a, { key: 'setup:1' });
        const images = [{ fingerprint: fp('1'), digest: dg('1') }];
        // Another commit than the one asked.
        expect(await ctx.shared(a, { sha: SHA2, images })).toMatchObject({ type: 'nack', body: { code: 'bake_not_asked' } });
        // The bake was asked for org-a: a record for org-b names nothing asked.
        expect(await ctx.shared(a, { org: 'org-b', images })).toMatchObject({ type: 'nack', body: { code: 'bake_not_asked' } });
        // Another cell of the fleet never baked it.
        const c = await ctx.connect('cell-c', SHARING);
        expect(await ctx.shared(c, { images })).toMatchObject({ type: 'nack', body: { code: 'bake_not_asked' } });
        // A customer's cell speaks only for its own org.
        const b = await ctx.connect('cell-b', SHARING);
        expect(await ctx.shared(b, { org: 'org-a', images })).toMatchObject({ type: 'nack', body: { code: 'wrong_org' } });
        expect(await ctx.store.sharedImages('org-a', 'shop', 64)).toEqual([]);
        expect(await ctx.store.sharedImages('org-b', 'shop', 64)).toEqual([]);
    });

    it('refuses image.shared from a cell whose hello named no bakeShare', async () => {
        const ctx = setup();
        const a = await ctx.connect('cell-a', BASE_FEATURES);
        await ctx.bake(a, { key: 'setup:1' });
        expect(await ctx.shared(a, { images: [{ fingerprint: fp('1'), digest: dg('1') }] })).toMatchObject({ type: 'nack', body: { code: 'feature_not_named' } });
    });

    it('lets the newest bake win, whichever record arrives last, and keeps the last two bakes', async () => {
        const ctx = setup();
        const a = await ctx.connect('cell-a', SHARING);
        const c = await ctx.connect('cell-c', SHARING);
        await ctx.bake(a, { key: 'setup:1', sha: SHA });
        ctx.advance(60_000);
        await ctx.bake(c, { key: 'setup:2', sha: SHA2 });
        // The newer bake's push finishes first; the older one's record comes late.
        await ctx.shared(c, { sha: SHA2, images: [{ fingerprint: fp('1'), digest: dg('2') }] });
        await ctx.shared(a, { sha: SHA, images: [{ fingerprint: fp('1'), digest: dg('1') }, { fingerprint: fp('9'), digest: dg('9') }] });
        expect(await ctx.store.sharedImages('org-a', 'shop', 64)).toEqual([
            { fingerprint: fp('1'), digest: dg('2') },
            { fingerprint: fp('9'), digest: dg('9') },
        ]);
        // A third bake: the oldest one's images go (fp 9 was only its).
        ctx.advance(60_000);
        await ctx.bake(a, { key: 'setup:3', sha: 'c'.repeat(40) });
        await ctx.shared(a, { sha: 'c'.repeat(40), images: [{ fingerprint: fp('3'), digest: dg('3') }] });
        expect(await ctx.store.sharedImages('org-a', 'shop', 64)).toEqual([
            { fingerprint: fp('3'), digest: dg('3') },
            { fingerprint: fp('1'), digest: dg('2') },
        ]);
    });

    it('drops the record when the environment is removed', async () => {
        const ctx = setup();
        const a = await ctx.connect('cell-a', SHARING);
        await ctx.bake(a, { key: 'setup:1' });
        await ctx.shared(a, { images: [{ fingerprint: fp('1'), digest: dg('1') }] });
        await ctx.hub.forgetSharedImages('org-a', 'shop');
        expect(await ctx.store.sharedImages('org-a', 'shop', 64)).toEqual([]);
        const c = await ctx.connect('cell-c', SHARING);
        const { req } = await ctx.acquire(c, { key: 'run-1:base:1' });
        expect(req.body.sharedImages).toBeUndefined();
    });

    it("sends sharedImages to no older cell, to no setup, and never another org's", async () => {
        const ctx = setup();
        const a = await ctx.connect('cell-a', SHARING);
        await ctx.bake(a, { key: 'setup:1' });
        await ctx.shared(a, { images: [{ fingerprint: fp('1'), digest: dg('1') }] });

        const old = await ctx.connect('cell-c', BASE_FEATURES);
        expect((await ctx.acquire(old, { key: 'run-1:base:1' })).req.body.sharedImages).toBeUndefined();
        const c = await ctx.connect('cell-c', SHARING);
        expect((await ctx.acquire(c, { consumer: 'setup', side: 'setup', key: 'setup:2' })).req.body.sharedImages).toBeUndefined();
        expect((await ctx.acquire(c, { org: 'org-b', key: 'run-2:base:1' })).req.body.sharedImages).toBeUndefined();
    });
});
