import { randomUUID } from 'crypto';

import { decodeFrame, PROTOCOL_VERSION } from '@libs/runtime/protocol';
import { InMemoryRunStreamStore } from '@libs/runtime/run/testing';
import { RuntimeMetrics } from '@libs/runtime/telemetry';

import { createCa } from './ca/x509';
import { CellCredential, CellHub, HubLogLine } from './cell-hub';
import { claimIdFor } from './claims/claim.service';
import { InMemoryHubStore } from './testing';

// A claim of consumer suite (docs/runtime/e2e-suites.md section 4): a Run-like claim for one shard of the repository's
// own e2e suite. A cell that does not name the suite feature refuses its consumer name at decode, so the hub never
// sends it one. The claim keeps a Run's egress, secrets and lease; its ceiling is the PR build plus the suite total.

class FakeSocket {
    sent: any[] = [];
    send(d: string) {
        const r = decodeFrame(d);
        if ('code' in r) throw new Error(`hub sent an invalid frame: ${r.code} ${r.message}`);
        this.sent.push(r.message);
    }
    close() {}
}

const SHA = 'a'.repeat(40);
const MIN = 60_000;
const frame = (cellId: string, type: string, body: unknown, extra: Record<string, unknown> = {}) => JSON.stringify({ v: PROTOCOL_VERSION, id: randomUUID(), cellId, type, body, ...extra });
const CRED: CellCredential = { cellId: 'cell-a', owner: 'kodus' };
const CA = createCa('skip bake spec CA');
const manifest = { services: [{ name: 'web', health: 'ok' }], expose: [{ service: 'web', port: 3000, kind: 'http' }], imageId: 'img-1', seedSha: 'seed-1' };
const tick = () => new Promise((r) => setImmediate(r));
const BASE_FEATURES = ['seedsCache', 'claimSize', 'egressAllow', 'poolMachineSize', 'authoredFiles'];

function setup() {
    const store = new InMemoryHubStore();
    const logs: HubLogLine[] = [];
    const hub = new CellHub(store, new InMemoryRunStreamStore(), new RuntimeMetrics(), { replicaId: 'r1', replicaUrl: 'http://hub', ca: CA, log: (l) => void logs.push(l) });
    const connect = async (features: string[]) => {
        const sock = new FakeSocket();
        const h = hub.attach(sock, CRED);
        await h.onMessage(frame('cell-a', 'hello', { versions: [1], driver: 'fake', isolation: 'vm', regions: ['local'], owner: 'kodus', features }));
        return { sock, ...h };
    };
    const acquire = async (c: Awaited<ReturnType<typeof connect>>, key: string, over: Record<string, unknown> = {}) => {
        const at = Date.now();
        const before = c.sock.sent.filter((m) => m.type === 'claim.acquire').length;
        const p = hub.acquire('cell-a', {
            organizationId: 'org-a',
            environmentId: 'shop',
            imageId: 'latest',
            ref: { side: 'base', sha: SHA },
            consumer: 'runtime',
            idempotencyKey: key,
            expose: [{ service: 'web', port: 3000, kind: 'http' }],
            repo: { provider: 'github', fullName: 'acme/app', apiBase: 'https://api.github.com' },
            repoToken: 'ghs_primary_token_app',
            ...over,
        } as any);
        // The hub sends claim.acquire after a few awaits (placement, secrets, approvals): wait for it, but not forever.
        for (let i = 0; i < 50 && c.sock.sent.filter((m) => m.type === 'claim.acquire').length === before; i++) await tick();
        const sent = c.sock.sent.filter((m) => m.type === 'claim.acquire');
        const req = sent.length > before ? sent[sent.length - 1] : undefined;
        if (req) {
            await c.onMessage(frame('cell-a', 'ack', {}, { re: req.id }));
            await c.onMessage(frame('cell-a', 'claim.ready', { manifest, observer: { id: 'obs-1', state: 'ready' } }, { claimId: req.claimId }));
            // The approved hosts are pushed once the claim is ready, and the hub waits for the cell's ack.
            await tick();
            for (const m of c.sock.sent.filter((x) => x.type === 'egress.policy' && x.claimId === req.claimId)) await c.onMessage(frame('cell-a', 'ack', {}, { re: m.id }));
        }
        return { claim: (await p) as any, req, at };
    };
    return { hub, store, logs, connect, acquire };
}

describe('a claim that skips the bake', () => {
    it('is blocked before anything is recorded or sent on a cell that does not name skipBake', async () => {
        const ctx = setup();
        const c = await ctx.connect(BASE_FEATURES);
        const { claim, req } = await ctx.acquire(c, 'run-1:base:1:cold', { runId: 'run-1', skipBake: true });
        expect(req).toBeUndefined();
        expect(claim).toMatchObject({ status: 'blocked', blockers: [{ kind: 'platform', signature: 'skip_bake_unsupported' }] });
        expect(await ctx.store.claim(claimIdFor('org-a', 'run-1:base:1:cold'))).toBeNull();
    });

    it('reaches a cell that names it with skipBake, and a claim that does not ask carries none', async () => {
        const ctx = setup();
        const c = await ctx.connect([...BASE_FEATURES, 'skipBake']);
        const cold = await ctx.acquire(c, 'run-1:base:1:cold', { runId: 'run-1', skipBake: true });
        expect(cold.req.body).toMatchObject({ side: 'base', consumer: 'runtime', skipBake: true });
        const plain = await ctx.acquire(c, 'run-1:base:1', { runId: 'run-1' });
        expect(plain.req.body.skipBake).toBeUndefined();
    });
});
