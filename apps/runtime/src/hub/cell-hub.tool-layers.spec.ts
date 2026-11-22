import { randomUUID } from 'crypto';

import { computeToolLayerKey, decodeFrame, PROTOCOL_VERSION, type ToolLayerPlan } from '@libs/runtime/protocol';
import { InMemoryRunStreamStore } from '@libs/runtime/run/testing';
import { RuntimeMetrics } from '@libs/runtime/telemetry';

import { createCa } from './ca/x509';
import { CellCredential, CellHub } from './cell-hub';
import { claimIdFor } from './claims/claim.service';
import { InMemoryHubStore } from './testing';

// The hub's side of tool layers (docs/runtime/persistent-state.md 4.2, 4.5, 4.6): the keys only to a cell that names
// the feature and an image digest; hit or miss per layer from claim.ready, the registry host open only for a miss;
// a builder claim on THAT cell when it asks for one; the audit row with keys and states, never content.

class FakeSocket {
    sent: any[] = [];
    send(d: string) {
        const r = decodeFrame(d);
        if ('code' in r) throw new Error(`hub sent an invalid frame: ${r.code} ${r.message}`);
        this.sent.push(r.message);
    }
    close() {}
    all(type: string) {
        return this.sent.filter((m) => m.type === type);
    }
    last(type: string) {
        return [...this.sent].reverse().find((m) => m.type === type);
    }
}

const frame = (cellId: string, type: string, body: unknown, extra: Record<string, unknown> = {}) => JSON.stringify({ v: PROTOCOL_VERSION, id: randomUUID(), cellId, type, body, ...extra });
const CRED: CellCredential = { cellId: 'cell-a', owner: 'kodus' };
const CA = createCa('tool layers spec CA');
const tick = async () => {
    for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
};
const DIGEST = `sha256:${'d'.repeat(64)}`;
const readyBody = { manifest: { services: [], expose: [], imageId: 'sandbox', seedSha: 'none' }, observer: { id: 'kodus-sbx-workload', state: 'ready' } };
const plan = (id = 'some-cli', over: Partial<ToolLayerPlan> = {}): ToolLayerPlan => ({ id, installer: 'npm', argv: ['npm', 'install', '--ignore-scripts', '-g', `${id}@1.2.3`], binary: id, registry: 'registry.npmjs.org', ...over });
const keyOf = (p: ToolLayerPlan, arch = 'arm64') => computeToolLayerKey({ installer: p.installer, argv: p.argv, binary: p.binary, imageDigest: DIGEST, arch, registry: p.registry });
const caps = (over: Record<string, unknown> = {}) => ({ backends: ['gvisor'], snapshotMemory: false, nestedDocker: true, kvm: false, arch: 'arm64', sandboxImageDigest: DIGEST, ...over });
const hit = (id: string) => ({ id, state: 'hit', binaryPath: `/opt/kcli/${id}/.local/bin/${id}`, interpreter: 'node', digest: 'c'.repeat(64) });

function setup() {
    let nowMs = Date.parse('2026-11-22T10:00:00Z');
    const store = new InMemoryHubStore();
    const hub = new CellHub(store, new InMemoryRunStreamStore(), new RuntimeMetrics(), { replicaId: 'r1', replicaUrl: 'http://hub', ca: CA, log: () => undefined, now: () => new Date(nowMs) });
    const connect = async (features: string[], extra: Record<string, unknown> = { capabilities: caps() }) => {
        const sock = new FakeSocket();
        const h = hub.attach(sock, CRED);
        await h.onMessage(frame('cell-a', 'hello', { versions: [1], driver: 'docker-gvisor', isolation: 'sandboxed-container', regions: ['local'], owner: 'kodus', features, ...extra }));
        return { sock, ...h };
    };
    /** Opens a review sandbox planning `plans`; the cell acks and answers claim.ready with `toolLayers`. */
    const review = async (c: Awaited<ReturnType<typeof connect>>, key: string, plans: ToolLayerPlan[], toolLayers?: unknown[], extra: Record<string, unknown> = {}) => {
        const before = c.sock.all('sandbox.acquire').length;
        const { nackEgress, ...rest } = extra as { nackEgress?: boolean };
        const p = hub.acquireSandbox('cell-a', { organizationId: 'org-a', idempotencyKey: key, egressAllow: ['github.com', 'registry.npmjs.org'], toolLayers: plans, ...rest });
        await tick();
        const req = c.sock.all('sandbox.acquire')[before];
        await c.onMessage(frame('cell-a', 'ack', {}, { re: req.id }));
        await c.onMessage(frame('cell-a', 'claim.ready', { ...readyBody, ...(toolLayers ? { toolLayers } : {}) }, { claimId: req.claimId }));
        // The hub waits for the cell's ack of the egress it opens for a miss, as it does of every request.
        await tick();
        for (const e of c.sock.all('egress.policy').filter((m) => m.claimId === req.claimId)) {
            await c.onMessage(nackEgress ? frame('cell-a', 'nack', { code: 'refused', message: 'no' }, { re: e.id }) : frame('cell-a', 'ack', {}, { re: e.id }));
        }
        return { claim: (await p) as any, req };
    };
    /** The builder acquire the hub sent after the review: ack and ready as a cell does. */
    const acceptBuilder = async (c: Awaited<ReturnType<typeof connect>>, index = 0) => {
        await tick();
        const req = c.sock.all('sandbox.acquire').filter((m) => m.body.layerBuild)[index];
        if (!req) return undefined;
        await c.onMessage(frame('cell-a', 'ack', {}, { re: req.id }));
        await c.onMessage(frame('cell-a', 'claim.ready', readyBody, { claimId: req.claimId }));
        await tick();
        return req;
    };
    return { hub, store, connect, review, acceptBuilder, advance: (ms: number) => void (nowMs += ms) };
}

const ALL = ['sandbox', 'egressAllow', 'toolLayers'];

describe('tool layers on the hub', () => {
    it('sends the keys, computed from the cell digest and arch, and takes the registry out of the egress of a held layer', async () => {
        const t = setup();
        const c = await t.connect(ALL);
        const p = plan();
        const { req, claim } = await t.review(c, 'sandbox:s1', [p], [hit('some-cli')]);
        expect(req.body.toolLayers).toEqual([{ key: keyOf(p), id: 'some-cli' }]);
        // The acquire carries what the caller asked, the registry included, as it always did.
        expect(req.body.egressAllow).toEqual(['github.com', 'registry.npmjs.org']);
        expect(claim.toolLayers).toEqual([{ id: 'some-cli', state: 'hit', binaryPath: '/opt/kcli/some-cli/.local/bin/some-cli', interpreter: 'node' }]);
        // A hit installs nothing: the registry leaves the sandbox's egress before anything runs in it.
        const policy = c.sock.last('egress.policy');
        expect(policy.claimId).toBe(claim.claimId);
        expect(policy.body.allow).toEqual(['github.com']);
        expect(policy.body.sealed).toBeUndefined();
    });

    it('uses the arch the hello names, so the same plan on x86_64 is another key', async () => {
        const t = setup();
        const c = await t.connect(ALL, { capabilities: caps({ arch: 'x86_64' }) });
        const p = plan();
        const { req } = await t.review(c, 'sandbox:s1', [p], [hit('some-cli')]);
        expect(req.body.toolLayers[0].key).toBe(keyOf(p, 'x86_64'));
        expect(keyOf(p, 'x86_64')).not.toBe(keyOf(p, 'arm64'));
    });

    it.each([
        ['an older cell that names no toolLayers', ['sandbox', 'egressAllow'], { capabilities: caps() }],
        ['a cell that names toolLayers but sent no image digest', ALL, { capabilities: caps({ sandboxImageDigest: undefined }) }],
    ])('sends no layer to %s, and the registries stay in the egress as an install needs them', async (_name, features, extra) => {
        const t = setup();
        const c = await t.connect(features, extra);
        const { req, claim } = await t.review(c, 'sandbox:s1', [plan(), plan('other-cli', { registry: 'registry.example.com' })], undefined, { egressAllow: ['github.com', 'registry.example.com', 'registry.npmjs.org'] });
        expect(req.body.toolLayers).toBeUndefined();
        expect(req.body.egressAllow).toEqual(['github.com', 'registry.example.com', 'registry.npmjs.org']);
        expect(c.sock.all('egress.policy')).toHaveLength(0);
        expect(claim.toolLayers).toBeUndefined();
        expect(t.store.sandboxAudit.filter((a) => a.op === 'tool_layers')).toHaveLength(0);
    });

    it('sends no layer to a sandbox that starts from a template or a session (those mount none)', async () => {
        const t = setup();
        const c = await t.connect([...ALL, 'snapshots']);
        const { req } = await t.review(c, 'sandbox:s1', [plan()], undefined, { templateKey: 'kcli-tools', egressAllow: ['github.com', 'registry.npmjs.org'] });
        expect(req.body.toolLayers).toBeUndefined();
        expect(req.body.egressAllow).toContain('registry.npmjs.org');
    });

    it('keeps the registry host of a layer that missed and takes out only the held layers\' ones', async () => {
        const t = setup();
        const c = await t.connect(ALL);
        const hosts = ['github.com', 'registry.example.com', 'registry.npmjs.org'];
        const { claim } = await t.review(c, 'sandbox:s1', [plan('held-cli'), plan('cold-cli', { registry: 'registry.example.com' })], [hit('held-cli'), { id: 'cold-cli', state: 'miss', reason: 'no_key' }], { egressAllow: hosts });
        expect(claim.toolLayers.map((l: any) => `${l.id}:${l.state}`)).toEqual(['held-cli:hit', 'cold-cli:miss']);
        expect(c.sock.last('egress.policy').body.allow).toEqual(['github.com', 'registry.example.com']);
    });

    it('keeps a registry host that a held layer and a missed one both use', async () => {
        const t = setup();
        const c = await t.connect(ALL);
        await t.review(c, 'sandbox:s1', [plan('held-cli'), plan('cold-cli')], [hit('held-cli'), { id: 'cold-cli', state: 'miss', reason: 'no_key' }]);
        expect(c.sock.all('egress.policy')).toHaveLength(0);
    });

    it('a miss changes no egress: the install runs as today, with the registry open', async () => {
        const t = setup();
        const c = await t.connect(ALL);
        const { req } = await t.review(c, 'sandbox:s1', [plan()], [{ id: 'some-cli', state: 'miss', reason: 'no_key' }]);
        expect(req.body.egressAllow).toEqual(['github.com', 'registry.npmjs.org']);
        expect(c.sock.all('egress.policy')).toHaveLength(0);
    });

    it('a layer the cell did not answer, or a hit with a path outside its mount, is a miss and keeps its registry', async () => {
        const t = setup();
        const c = await t.connect(ALL);
        const { claim } = await t.review(c, 'sandbox:s1', [plan('a-cli'), plan('b-cli')], [{ ...hit('b-cli'), binaryPath: '/opt/kcli/other/x' }]);
        expect(claim.toolLayers).toEqual([{ id: 'a-cli', state: 'miss' }, { id: 'b-cli', state: 'miss' }]);
        expect(c.sock.all('egress.policy')).toHaveLength(0);
    });

    it('keeps the claim ready, with the registry open until the seal, when the narrowed policy is not acknowledged', async () => {
        const t = setup();
        const c = await t.connect(ALL);
        const { claim } = await t.review(c, 'sandbox:s1', [plan()], [hit('some-cli')], { nackEgress: true });
        expect(claim.toolLayers[0].state).toBe('hit');
    });

    it('audits one row per sandbox with the layer keys and states, never a path or content', async () => {
        const t = setup();
        const c = await t.connect(ALL);
        const a = plan('held-cli');
        const b = plan('cold-cli');
        const { claim } = await t.review(c, 'sandbox:s1', [a, b], [hit('held-cli'), { id: 'cold-cli', state: 'miss', reason: 'no_key' }]);
        const rows = t.store.sandboxAudit.filter((r) => r.op === 'tool_layers');
        expect(rows).toEqual([expect.objectContaining({ orgId: 'org-a', claimId: claim.claimId, cellId: 'cell-a', outcome: 'ok' })]);
        expect(rows[0].detail).toBe(`held-cli:${keyOf(a)}:hit:${'c'.repeat(64)} cold-cli:${keyOf(b)}:miss:no_key`);
        expect(JSON.stringify(rows)).not.toContain('/opt/kcli');
        expect(JSON.stringify(rows)).not.toContain('.local/bin');
    });

    describe('builders', () => {
        const miss = (id: string, build?: true) => ({ id, state: 'miss', reason: 'no_key', ...(build ? { build } : {}) });

        it('opens no builder for a miss that did not ask for one (the cell builds on its second miss only)', async () => {
            const t = setup();
            const c = await t.connect(ALL);
            await t.review(c, 'sandbox:s1', [plan()], [miss('some-cli')]);
            await tick();
            expect(c.sock.all('sandbox.acquire').filter((m) => m.body.layerBuild)).toHaveLength(0);
        });

        it('opens a builder on THAT cell for a miss with build: true, clean: only the plan, only its registry', async () => {
            const t = setup();
            const c = await t.connect(ALL);
            t.store.approvals.set('org-a/__sandbox__', ['docs.acme.dev']);
            const p = plan();
            await t.review(c, 'sandbox:s1', [p], [miss('some-cli', true)]);
            const builder = await t.acceptBuilder(c);
            expect(builder.body).toEqual({
                orgId: 'org-a',
                hardExpiresAt: expect.any(String),
                leaseExpiresAt: expect.any(String),
                egressAllow: ['registry.npmjs.org'],
                layerBuild: { key: keyOf(p), id: 'some-cli', installer: 'npm', argv: p.argv, binary: 'some-cli', registry: 'registry.npmjs.org' },
            });
            // The hub's builder is a sandbox claim of the org: no secret, no template, no layer to mount.
            expect(builder.body.secrets).toBeUndefined();
            expect(builder.body.toolLayers).toBeUndefined();
            expect((await t.store.claim(builder.claimId))?.consumer).toBe('sandbox');
        });

        it('is single-flight: two reviews missing the same key with build: true open one builder', async () => {
            const t = setup();
            const c = await t.connect(ALL);
            await t.review(c, 'sandbox:s1', [plan()], [miss('some-cli', true)]);
            await t.review(c, 'sandbox:s2', [plan()], [miss('some-cli', true)]);
            await tick();
            expect(c.sock.all('sandbox.acquire').filter((m) => m.body.layerBuild)).toHaveLength(1);
        });

        it('records the result, releases the builder claim and takes the cell\'s unknown_claim answer as normal', async () => {
            const t = setup();
            const c = await t.connect(ALL);
            const p = plan();
            await t.review(c, 'sandbox:s1', [p], [miss('some-cli', true)]);
            const builder = (await t.acceptBuilder(c))!;
            const id = randomUUID();
            await c.onMessage(frame('cell-a', 'toollayer.built', { key: keyOf(p), id: 'some-cli', digest: 'c'.repeat(64), bytes: 4096 }, { claimId: builder.claimId, ...{} }).replace(/"id":"[^"]+"/, `"id":"${id}"`));
            await tick();
            const release = c.sock.all('claim.release').find((m) => m.claimId === builder.claimId);
            expect(release).toBeDefined();
            // The cell ended the claim itself: its answer to the release is a nack, not an error.
            await c.onMessage(frame('cell-a', 'nack', { code: 'unknown_claim', message: builder.claimId }, { re: release.id }));
            await tick();
            expect(c.sock.all('ack').some((m) => m.re === id)).toBe(true);
            expect((await t.store.claim(builder.claimId))?.state).toBe('released');
        });

        it('does not build the same failed layer again for 10 minutes, then does', async () => {
            const t = setup();
            const c = await t.connect(ALL);
            const p = plan();
            await t.review(c, 'sandbox:s1', [p], [miss('some-cli', true)]);
            const builder = (await t.acceptBuilder(c))!;
            await c.onMessage(frame('cell-a', 'toollayer.failed', { key: keyOf(p), id: 'some-cli', reason: 'install_exit' }, { claimId: builder.claimId }));
            await tick();
            await t.review(c, 'sandbox:s2', [p], [miss('some-cli', true)]);
            await tick();
            expect(c.sock.all('sandbox.acquire').filter((m) => m.body.layerBuild)).toHaveLength(1);
            t.advance(10 * 60_000 + 1_000);
            await t.review(c, 'sandbox:s3', [p], [miss('some-cli', true)]);
            await tick();
            expect(c.sock.all('sandbox.acquire').filter((m) => m.body.layerBuild)).toHaveLength(2);
        });

        it('refuses a toollayer result for a claim that is no builder of the cell', async () => {
            const t = setup();
            const c = await t.connect(ALL);
            const id = randomUUID();
            await c.onMessage(frame('cell-a', 'toollayer.built', { key: 'a'.repeat(64), id: 'some-cli', digest: 'c'.repeat(64), bytes: 1 }, { claimId: claimIdFor('org-a', 'nothing') }).replace(/"id":"[^"]+"/, `"id":"${id}"`));
            expect(c.sock.all('nack').find((m) => m.re === id)?.body.code).toBe('unknown_claim');
        });

        it('never asks a cell that does not name toolLayers to build', async () => {
            const t = setup();
            const c = await t.connect(['sandbox', 'egressAllow']);
            const p = plan();
            // The review cannot get layers there, so no build is ever requested; a hand-made request is blocked.
            const out = await t.hub.claims.layers.builds.acquire('cell-a', { organizationId: 'org-a', idempotencyKey: 'toollayer-build:x', sandboxLayerBuild: { key: keyOf(p), ...p } } as never);
            expect(out).toMatchObject({ status: 'blocked', blockers: [{ signature: 'tool_layers_unsupported' }] });
            expect(c.sock.all('sandbox.acquire')).toHaveLength(0);
        });
    });
});
