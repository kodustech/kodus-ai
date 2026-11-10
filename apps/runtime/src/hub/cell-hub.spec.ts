import { decideProbe } from '@libs/runtime/gate/gate';
import { toGateStep } from '../worker/run/probe-fields';
import type { Probe, ProbeResult } from '@libs/runtime/probe';
import { generateKeyPairSync, randomUUID, X509Certificate } from 'crypto';

import { decodeFrame, PROTOCOL_VERSION } from '@libs/runtime/protocol';
import { InMemoryRunStreamStore } from '@libs/runtime/run/testing';
import { RuntimeMetrics } from '@libs/runtime/telemetry';

import { generateCellRegistrationToken } from '@libs/runtime/api/domain/cell-token';

import { createCa, createCsr, normalizeSerial } from './ca/x509';
import { CellCredential, CellHub, HubLogLine } from './cell-hub';
import { InternalController } from './http/internal.controller';
import { claimIdFor } from './claims/claim.service';
import { InMemoryHubStore } from './hub-store';

class FakeSocket {
    sent: any[] = [];
    closed = false;
    send(d: string) {
        const r = decodeFrame(d);
        if ('code' in r) throw new Error(`hub sent an invalid frame: ${r.code} ${r.message}`);
        this.sent.push(r.message);
    }
    close() {
        this.closed = true;
    }
    last(type?: string) {
        return [...this.sent].reverse().find((m) => !type || m.type === type);
    }
}

const SHA = 'a'.repeat(40);
const frame = (cellId: string, type: string, body: unknown, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ v: PROTOCOL_VERSION, id: randomUUID(), cellId, type, body, ...extra });
/** What a hello may add (absent: an older cell that names nothing). */
type HelloCaps = { features?: string[]; maxClaimSize?: { memoryMb: number; cpus: number } };
const hello = (cellId: string, owner = 'kodus', caps: HelloCaps = {}) => frame(cellId, 'hello', { versions: [1], driver: 'fake', isolation: 'vm', regions: ['local'], owner, ...caps });
/** A cell of this build: it decodes every optional claim.acquire field and grants up to 64 GB / 16 CPUs. */
const CURRENT_CELL: HelloCaps = { features: ['seedsCache', 'claimSize', 'egressAllow', 'poolMachineSize', 'authoredFiles'], maxClaimSize: { memoryMb: 65_536, cpus: 16 } };
const CRED: Record<string, CellCredential> = {
    'cell-a': { cellId: 'cell-a', owner: 'kodus' },
    'cell-b': { cellId: 'cell-b', owner: 'customer', orgId: 'org-b' },
    'cell-c': { cellId: 'cell-c', owner: 'kodus' },
};
const CA = createCa('spec CA');
const manifest = { services: [{ name: 'web', health: 'ok' }], expose: [{ service: 'web', port: 3000, kind: 'http' }], imageId: 'img-1', seedSha: 'seed-1' };
const tick = () => new Promise((r) => setImmediate(r));
/** The claim as the worker names it: with its tenant (org-a, as every claim below). */
const ref = (claimId: string, organizationId = 'org-a') => ({ claimId, organizationId });

const probe = {
    id: 'p1',
    origin: 'agent' as const,
    purpose: 'x',
    expected: '400',
    compare: ['status' as const],
    spec: { kind: 'http' as const, target: { service: 'web', port: 3000 }, method: 'POST' as const, path: '/orders', timeoutMs: 1_000 },
};

function setup(extra: { allowInsecureCells?: boolean; readyTimeoutMs?: number; now?: () => Date } = {}) {
    const store = new InMemoryHubStore();
    const streams = new InMemoryRunStreamStore();
    const metrics = new RuntimeMetrics();
    const violations: string[] = [];
    const logs: HubLogLine[] = [];
    jest.spyOn(metrics, 'recordProtocolViolation').mockImplementation((a) => void violations.push(a.code));
    const hub = new CellHub(store, streams, metrics, {
        replicaId: 'r1',
        replicaUrl: 'http://hub',
        ca: CA,
        log: (l) => void logs.push(l),
        ...extra,
    });
    const connect = async (cellId: string, owner = 'kodus', caps: HelloCaps = {}) => {
        const sock = new FakeSocket();
        const h = hub.attach(sock, CRED[cellId]);
        await h.onMessage(hello(cellId, owner, caps));
        return { sock, ...h };
    };
    const acquireOn = async (c: Awaited<ReturnType<typeof connect>>, cellId: string, org = 'org-a', then: 'ready' | 'failed' | 'none' = 'ready', ready: Record<string, unknown> = {}) => {
        const p = hub.acquire(cellId, {
            organizationId: org,
            environmentId: 'shop',
            runId: 'run-1',
            imageId: 'img-1',
            ref: { side: 'base', sha: SHA },
            consumer: 'runtime',
            idempotencyKey: 'run-1:base:1',
            expose: [{ service: 'web', port: 3000, kind: 'http' }],
            repo: { provider: 'github', fullName: 'acme/shop', apiBase: 'https://api.github.com' },
            repoToken: 'tok',
        });
        await tick();
        await tick();
        const req = c.sock.last('claim.acquire');
        if (req) await c.onMessage(frame(cellId, 'ack', {}, { re: req.id }));
        if (req && then === 'ready') await c.onMessage(frame(cellId, 'claim.ready', { manifest, observer: { id: 'obs-1', state: 'ready' }, ...ready }, { claimId: req.claimId }));
        if (req && then === 'failed') await c.onMessage(frame(cellId, 'claim.failed', { kind: 'resources', signature: 'create_workload', reason: 'no capacity' }, { claimId: req.claimId }));
        return p;
    };
    return { hub, store, streams, violations, logs, connect, acquireOn };
}

describe('cell session fencing', () => {
    it('serializes a replaced hello whose session write finishes after the next hello starts', async () => {
        const { hub, store } = setup();
        let entered!: () => void; let release!: () => void;
        const began = new Promise<void>((resolve) => { entered = resolve; });
        const gate = new Promise<void>((resolve) => { release = resolve; });
        const persist = store.upsertSession.bind(store);
        jest.spyOn(store, 'upsertSession').mockImplementationOnce(async (session) => { entered(); await gate; await persist(session); });
        const old = hub.attach(new FakeSocket(), CRED['cell-a']);
        const oldHello = old.onMessage(hello('cell-a')); await began;
        const nextSocket = new FakeSocket(); const next = hub.attach(nextSocket, CRED['cell-a']);
        const nextHello = next.onMessage(hello('cell-a'));
        await tick(); await tick();
        // Another cell's hello is independent of the blocked cell.
        const otherSocket = new FakeSocket(); const other = hub.attach(otherSocket, CRED['cell-c']);
        await other.onMessage(hello('cell-c')); expect(otherSocket.last()?.type).toBe('ack');
        release(); await Promise.all([oldHello, nextHello]);
        expect(nextSocket.last()?.type).toBe('ack');
        expect((await store.session('cell-a'))?.sessionEpoch).toBe(hub.connections.require('cell-a').sessionEpoch);
        await next.onMessage(frame('cell-a', 'heartbeat', { claims: [], freeSlots: 7 }));
        expect(store.sessions.get('cell-a')?.freeSlots).toBe(7);
    });

    it('ignores a heartbeat queued on a replaced connection', async () => {
        const { hub, store, connect } = setup();
        const old = await connect('cell-a');
        await connect('cell-a');
        await old.onMessage(
            frame('cell-a', 'heartbeat', { freeSlots: 9, claims: [] }),
        );
        expect(store.sessions.get('cell-a')?.freeSlots).toBe(0);
        expect(hub.claims.memory.view('cell-a')).toBeNull();
    });

    it('does not apply a heartbeat after its connection was replaced during persistence', async () => {
        const { hub, store, connect } = setup();
        const old = await connect('cell-a');
        let unblock!: () => void;
        let entered!: () => void;
        const enteredPromise = new Promise<void>((r) => {
            entered = r;
        });
        const gate = new Promise<void>((r) => {
            unblock = r;
        });
        const original = store.heartbeat.bind(store);
        jest.spyOn(store, 'heartbeat').mockImplementation(async (...args) => {
            entered();
            await gate;
            return original(...args);
        });
        const pending = old.onMessage(
            frame('cell-a', 'heartbeat', { freeSlots: 9, claims: [] }),
        );
        await enteredPromise;
        await connect('cell-a');
        unblock();
        await pending;
        expect(store.sessions.get('cell-a')?.freeSlots).toBe(0);
        expect(hub.claims.memory.view('cell-a')).toBeNull();
    });
});

describe('CellHub', () => {
    it('records the session on hello and refuses frames before it or for another cell', async () => {
        const { hub, store, violations } = setup();
        const sock = new FakeSocket();
        const h = hub.attach(sock, CRED['cell-a']);
        await h.onMessage(frame('cell-a', 'heartbeat', { claims: [], freeSlots: 1 }));
        expect(sock.last().body.code).toBe('hello_first');
        await h.onMessage(hello('cell-a'));
        expect(sock.last()).toMatchObject({ type: 'ack', body: { version: PROTOCOL_VERSION } });
        expect((await store.session('cell-a'))!.replicaId).toBe('r1');
        await h.onMessage(frame('cell-b', 'heartbeat', { claims: [], freeSlots: 1 }));
        expect(sock.last().body.code).toBe('wrong_cell');
        // A frame that does not decode has no id to answer: counted, not nacked.
        const sentBefore = sock.sent.length;
        await h.onMessage('{"v":1,"v":1}');
        expect(sock.sent).toHaveLength(sentBefore);
        await h.onMessage(frame('cell-a', 'exec', { stepId: randomUUID(), command: 'id', timeoutMs: 10 }, { claimId: 'claim-x' }));
        expect(sock.last().body.code).toBe('wrong_direction');
        expect(violations).toEqual(['hello_first', 'wrong_cell', 'duplicate_key', 'wrong_direction']);
    });

    it('binds a claim, routes a probe and accepts only the result of a step it sent', async () => {
        const { hub, streams, violations, connect, acquireOn } = setup();
        const c = await connect('cell-a');
        const claim: any = await acquireOn(c, 'cell-a');
        expect(claim.claimId).toMatch(/^claim-/);

        const forged = randomUUID();
        await c.onMessage(frame('cell-a', 'step.result', { stepId: forged, executor: 'observer', imageId: 'img-1', vmHealth: 'ok' }, { claimId: claim.claimId }));
        expect(violations).toContain('unknown_step');

        const pending = hub.probe(ref(claim.claimId), probe);
        await tick();
        await tick();
        await tick();
        const sent = c.sock.last('probe.run');
        expect(sent.claimId).toBe(claim.claimId);
        const stepId = sent.body.stepId;
        await c.onMessage(
            frame(
                'cell-a',
                'step.result',
                {
                    stepId,
                    executor: 'observer',
                    imageId: 'img-1',
                    vmHealth: 'ok',
                    probe: { stepId, executor: 'observer', imageId: 'img-1', http: { status: 400, headers: {}, body: '' }, requests: [], durationMs: 3, transport: 'ok' },
                },
                { claimId: claim.claimId },
            ),
        );
        const result: any = await pending;
        expect(result.http.status).toBe(400);
        const events = (await streams.read('org-a', 'run-1'))!.events.map((e) => e.type);
        expect(events).toEqual(['step.started', 'step.finished']);

        // The same step answered twice is refused: at most once.
        await c.onMessage(frame('cell-a', 'step.result', { stepId, executor: 'observer', imageId: 'img-1', vmHealth: 'ok' }, { claimId: claim.claimId }));
        expect(violations.filter((v) => v === 'unknown_step')).toHaveLength(2);
    });

    // The cell answers the step frame itself before its step.result: an ack
    // admits it (no unknown_correlation back), a nack ends the step at once
    // with the cell's reason instead of at the probe's timeout.
    it('a step the cell admits is not nacked back, and one it refuses ends now', async () => {
        const { hub, violations, connect, acquireOn } = setup();
        const c = await connect('cell-a');
        const claim: any = await acquireOn(c, 'cell-a');

        const admitted = hub.probe(ref(claim.claimId), probe);
        await tick();
        await tick();
        await tick();
        const first = c.sock.last('probe.run');
        await c.onMessage(frame('cell-a', 'ack', {}, { re: first.id }));
        expect(violations).not.toContain('unknown_correlation');
        expect(c.sock.sent.filter((m) => m.type === 'nack')).toHaveLength(0);
        const stepId = first.body.stepId;
        await c.onMessage(
            frame('cell-a', 'step.result', { stepId, executor: 'observer', imageId: 'img-1', vmHealth: 'ok', probe: { stepId, executor: 'observer', imageId: 'img-1', http: { status: 200, headers: {}, body: '' }, requests: [], durationMs: 1, transport: 'ok' } }, { claimId: claim.claimId }),
        );
        expect(((await admitted) as any).http.status).toBe(200);

        const refused = hub.probe(ref(claim.claimId), probe);
        await tick();
        await tick();
        await tick();
        const second = c.sock.last('probe.run');
        const started = Date.now();
        await c.onMessage(frame('cell-a', 'nack', { code: 'not_accepting', message: 'cell lost the hub' }, { re: second.id }));
        expect(await refused).toMatchObject({ code: 'cell_unavailable', cellId: 'cell-a' });
        expect(Date.now() - started).toBeLessThan(1_000);
    });

    it('a step in flight when the connection drops becomes transport lost, never resent', async () => {
        const { hub, connect, acquireOn } = setup();
        const c = await connect('cell-a');
        const claim: any = await acquireOn(c, 'cell-a');
        const pending = hub.probe(ref(claim.claimId), probe);
        await tick();
        await tick();
        await tick();
        const before = c.sock.sent.filter((m) => m.type === 'probe.run').length;
        await c.onClose();
        expect(await pending).toMatchObject({ code: 'transport_lost' });
        expect(c.sock.sent.filter((m) => m.type === 'probe.run').length).toBe(before);
    });

    it('refuses a customer cell for another org and records egress only for its own claims', async () => {
        const { hub, store, violations, connect, acquireOn } = setup();
        const b = await connect('cell-b', 'customer');
        await expect(acquireOn(b, 'cell-b', 'org-a')).rejects.toThrow('does not serve this organization');
        expect(violations).toContain('cross_org_claim');

        const a = await connect('cell-a');
        const claim: any = await acquireOn(a, 'cell-a');
        await a.onMessage(frame('cell-a', 'egress.blocked', { host: 'evil.test', port: 443, phase: 'test', at: new Date().toISOString() }, { claimId: claim.claimId }));
        expect(store.egress).toHaveLength(1);
        await b.onMessage(frame('cell-b', 'egress.blocked', { host: 'x.test', port: 443, phase: 'test', at: new Date().toISOString() }, { claimId: claim.claimId }));
        expect(store.egress).toHaveLength(1);
        expect(violations).toContain('unknown_claim');
    });

    it("keeps a claim's preparation progress from its own cell, for its own org only", async () => {
        const { hub, violations, connect, acquireOn } = setup();
        const a = await connect('cell-a');
        const claim: any = await acquireOn(a, 'cell-a');
        const at = new Date().toISOString();
        await a.onMessage(frame('cell-a', 'claim.progress', { phase: 'compose', state: 'started', at }, { claimId: claim.claimId }));
        await a.onMessage(frame('cell-a', 'claim.progress', { phase: 'compose', state: 'started', at, lines: ['#13 RUN go mod download'] }, { claimId: claim.claimId }));
        await a.onMessage(frame('cell-a', 'claim.progress', { phase: 'fetch', state: 'done', at, ms: 9323 }, { claimId: claim.claimId }));
        expect(hub.claimProgress(claim.claimId, 'org-a')).toMatchObject({
            phases: [
                { phase: 'compose', state: 'started' },
                { phase: 'fetch', state: 'done', ms: 9323 },
            ],
            lines: ['#13 RUN go mod download'],
        });
        expect(hub.claimProgress(claim.claimId, 'org-b')).toBeNull();

        const b = await connect('cell-b', 'customer');
        await b.onMessage(frame('cell-b', 'claim.progress', { phase: 'fetch', state: 'started', at }, { claimId: claim.claimId }));
        expect(violations).toContain('unknown_claim');
    });

    it('handles the frames of one connection in order (hello is done before the next frame)', async () => {
        const { hub, violations } = setup();
        const sock = new FakeSocket();
        const h = hub.attach(sock, CRED['cell-a']);
        void h.onMessage(hello('cell-a'));
        await h.onMessage(frame('cell-a', 'step.result', { stepId: randomUUID(), executor: 'observer', imageId: 'img', vmHealth: 'ok' }, { claimId: 'x' }));
        expect(violations).toEqual(['unknown_step']);
    });

    it('a blocked reply becomes Blocked', async () => {
        const { hub, connect } = setup();
        const c = await connect('cell-a');
        const p = hub.acquire('cell-a', {
            organizationId: 'org-a',
            environmentId: 'broken',
            runId: 'run-2',
            ref: { side: 'base', sha: SHA },
            consumer: 'runtime',
            idempotencyKey: 'run-2:base:1',
            expose: [],
            repo: { provider: 'github', fullName: 'acme/shop', apiBase: 'https://api.github.com' },
            repoToken: 'tok',
        });
        await tick();
        await tick();
        const req = c.sock.last('claim.acquire');
        await c.onMessage(frame('cell-a', 'blocked', { kind: 'missing_env', signature: 'KEY', message: 'needs a fake' }, { re: req.id, claimId: req.claimId }));
        expect(await p).toEqual({ status: 'blocked', blockers: [{ kind: 'missing_env', signature: 'KEY', message: 'needs a fake' }] });
    });

    it('registers a customer cell from a CSR: 24 h cert, CN = cellId, pinned serial, refused once revoked', async () => {
        const { hub, store } = setup();
        const { token, tokenHash } = generateCellRegistrationToken();
        await store.ledger.record({ tokenHash, organizationId: 'org-b', topology: 'hybrid', expiresAt: new Date(Date.now() + 60_000).toISOString(), issuedBy: 'admin' });
        const key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey;

        expect(await hub.register(token, 'hybrid', 'not a csr')).toMatchObject({ ok: false });
        const reg: any = await hub.register(token, 'hybrid', createCsr(key));
        expect(reg.ok).toBe(true);
        expect(await hub.register(token, 'hybrid', createCsr(key))).toEqual({ ok: false, reason: 'unknown_or_used' });

        const x = new X509Certificate(reg.certificate);
        expect(x.verify(new X509Certificate(CA.certPem).publicKey)).toBe(true);
        expect(x.subject).toContain(`CN=${reg.cellId}`);
        expect(Date.parse(x.validTo) - Date.now()).toBeLessThanOrEqual(24 * 3_600_000);
        expect(store.cells.get(reg.cellId)!.certificateSerial).toBe(normalizeSerial(x.serialNumber));

        const peer = { authorized: true, role: 'cell', cn: reg.cellId, serial: x.serialNumber };
        const cred = await hub.authenticateCell(peer);
        expect(cred).toEqual({ cellId: reg.cellId, owner: 'customer', orgId: 'org-b' });
        expect(await hub.authenticateCell({ ...peer, authorized: false })).toBeNull();
        expect(await hub.authenticateCell({ ...peer, role: 'worker' })).toBeNull();
        expect(await hub.authenticateCell({ ...peer, serial: 'ABCDEF' })).toBeNull();
        await hub.refreshPins();
        expect(hub.handshakeAllowed({ ...peer, presented: true })).toBe(true);
        expect(hub.handshakeAllowed({ ...peer, presented: true, serial: 'ABCDEF' })).toBe(false);

        // Renewal moves the pin: the old certificate is refused from then on.
        const renewed: any = await hub.renew(cred!, createCsr(key));
        expect(renewed.ok).toBe(true);
        expect(await hub.authenticateCell(peer)).toBeNull();
        expect(hub.handshakeAllowed({ ...peer, presented: true })).toBe(false);
        const peer2 = { ...peer, serial: new X509Certificate(renewed.certificate).serialNumber };
        expect(await hub.authenticateCell(peer2)).toEqual(cred);

        const sock = new FakeSocket();
        const h = hub.attach(sock, cred!);
        await h.onMessage(hello(reg.cellId, 'customer'));
        store.cells.get(reg.cellId)!.status = 'revoked';
        expect(await hub.enforceRevocations()).toEqual([reg.cellId]);
        expect(sock.last('cell.revoked')).toBeDefined();
        expect(sock.closed).toBe(true);
        expect(await hub.authenticateCell(peer2)).toBeNull();
        // The revoked serial is refused at the TLS handshake on this replica.
        expect(hub.handshakeAllowed({ ...peer2, presented: true })).toBe(false);
        expect(await hub.renew(cred!, createCsr(key))).toEqual({ ok: false, reason: 'revoked' });
    });

    it('managed cells from config get a row and a pin', async () => {
        const { hub, store } = setup();
        await hub.ensureManagedCells({ 'cell-m': '0a:bc' }, new Date(Date.now() + 3_600_000).toISOString());
        expect(store.cells.get('cell-m')).toMatchObject({ owner: 'kodus', certificateSerial: 'ABC' });
        expect(await hub.authenticateCell({ authorized: true, role: 'cell', cn: 'cell-m', serial: '0ABC' })).toEqual({ cellId: 'cell-m', owner: 'kodus', orgId: undefined });
    });

    it('a managed cell that renewed keeps its pin across a hub restart; a new config serial re-pins it', async () => {
        const { hub, store } = setup();
        const exp = new Date(Date.now() + 3_600_000).toISOString();
        await hub.ensureManagedCells({ 'cell-m': 'AA01' }, exp);
        const key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey;
        const renewed: any = await hub.renew({ cellId: 'cell-m', owner: 'kodus' }, createCsr(key));
        const serial = normalizeSerial(new X509Certificate(renewed.certificate).serialNumber);
        expect(store.cells.get('cell-m')!.certificateSerial).toBe(serial);

        // The hub restarts with the same RUNTIME_MANAGED_CELLS: the renewed pin stays.
        const restarted = new CellHub(store, new InMemoryRunStreamStore(), new RuntimeMetrics(), { replicaId: 'r2', replicaUrl: 'http://hub2', ca: CA, log: () => undefined });
        await restarted.ensureManagedCells({ 'cell-m': 'AA01' }, exp);
        expect(store.cells.get('cell-m')!.certificateSerial).toBe(serial);
        expect(await restarted.authenticateCell({ authorized: true, role: 'cell', cn: 'cell-m', serial })).toMatchObject({ cellId: 'cell-m' });
        expect(restarted.handshakeAllowed({ authorized: true, role: 'cell', cn: 'cell-m', serial: 'AA01', presented: true })).toBe(false);

        // dev-ca.sh ran again: the config names a new serial and it wins.
        await restarted.ensureManagedCells({ 'cell-m': 'BB02' }, exp);
        expect(store.cells.get('cell-m')!.certificateSerial).toBe('BB02');
        // A revoked managed cell is never re-pinned.
        store.cells.get('cell-m')!.status = 'revoked';
        await restarted.ensureManagedCells({ 'cell-m': 'CC03' }, exp);
        expect(store.cells.get('cell-m')!).toMatchObject({ status: 'revoked', certificateSerial: 'BB02' });
    });

    it('a fresh replica refuses client certificates until it has loaded the pins and revocations', async () => {
        const { hub, store } = setup();
        store.cells.set('cell-r', { cellId: 'cell-r', organizationId: null, owner: 'kodus', topology: 'managed', status: 'revoked', certificateSerial: 'DEAD', certificateExpiresAt: new Date(Date.now() + 3_600_000).toISOString() });
        store.cells.set('cell-ok', { cellId: 'cell-ok', organizationId: null, owner: 'kodus', topology: 'managed', status: 'disconnected', certificateSerial: 'BEEF', certificateExpiresAt: new Date(Date.now() + 3_600_000).toISOString() });
        const revoked = { authorized: true, role: 'cell', cn: 'cell-r', serial: 'DEAD', presented: true };
        const good = { authorized: true, role: 'cell', cn: 'cell-ok', serial: 'BEEF', presented: true };
        expect(hub.handshakeAllowed(good)).toBe(false);
        expect(hub.handshakeAllowed(revoked)).toBe(false);
        expect(hub.handshakeAllowed({ authorized: false, presented: false })).toBe(true); // /cells/register, /health
        await hub.refreshPins();
        expect(hub.handshakeAllowed(good)).toBe(true);
        expect(hub.handshakeAllowed(revoked)).toBe(false);
    });

    it('refuses isolation none unless the dev flag is set, and warns when it allows it', async () => {
        const none = (id: string) => frame(id, 'hello', { versions: [1], driver: 'local-docker', isolation: 'none', regions: [], owner: 'kodus' });
        const off = setup();
        const s1 = new FakeSocket();
        await off.hub.attach(s1, CRED['cell-a']).onMessage(none('cell-a'));
        expect(s1.last()).toMatchObject({ type: 'nack', body: { code: 'insecure_isolation' } });
        const on = setup({ allowInsecureCells: true });
        const s2 = new FakeSocket();
        await on.hub.attach(s2, CRED['cell-a']).onMessage(none('cell-a'));
        expect(s2.last()).toMatchObject({ type: 'ack', body: { version: PROTOCOL_VERSION } });
        expect(on.logs.find((l) => l.msg === 'cell.insecure_isolation')).toMatchObject({ level: 'warn', cellId: 'cell-a' });
    });

    it('a claim is bound only on claim.ready, with the manifest the cell sent', async () => {
        const { hub, store, connect } = setup();
        const c = await connect('cell-a');
        let settled = false;
        const p = hub
            .acquire('cell-a', {
                organizationId: 'org-a',
                environmentId: 'shop',
                runId: 'run-3',
                ref: { side: 'base', sha: SHA },
                consumer: 'runtime',
                idempotencyKey: 'run-3:base:1',
                expose: [],
                repo: { provider: 'github', fullName: 'acme/shop', apiBase: 'https://api.github.com' },
                repoToken: 'tok',
            })
            .finally(() => (settled = true));
        await tick();
        await tick();
        const req = c.sock.last('claim.acquire');
        await c.onMessage(frame('cell-a', 'ack', {}, { re: req.id }));
        await tick();
        expect(settled).toBe(false);
        expect((await store.claim(req.claimId))!.state).toBe('pending');
        // Another cell cannot make it ready.
        const b = await connect('cell-b', 'customer');
        await b.onMessage(frame('cell-b', 'claim.ready', { manifest, observer: { id: 'o', state: 'ready' } }, { claimId: req.claimId }));
        expect(b.sock.last()).toMatchObject({ type: 'nack', body: { code: 'unknown_claim' } });
        await c.onMessage(frame('cell-a', 'claim.ready', { manifest, observer: { id: 'obs-9', state: 'ready' } }, { claimId: req.claimId }));
        expect(c.sock.last().type).toBe('ack');
        expect(await p).toMatchObject({ claimId: req.claimId, manifest: { seedSha: 'seed-1', imageId: 'img-1' }, observer: { id: 'obs-9' } });
        expect((await store.claim(req.claimId))!).toMatchObject({ state: 'bound', environmentId: 'shop' });
    });

    it('a retried acquire binds on the cell it went to: after a lost round on another cell, or on the same one', async () => {
        let t = Date.parse('2026-11-06T10:00:00.000Z');
        const { store, connect, acquireOn, logs } = setup({ now: () => new Date(t) });
        const a = await connect('cell-a');
        const lost = acquireOn(a, 'cell-a', 'org-a', 'none');
        for (let i = 0; i < 5; i++) await tick();
        await a.onClose();
        expect(await lost).toMatchObject({ status: 'blocked', blockers: [{ kind: 'platform', signature: 'cell_lost' }] });
        const claimId = [...store.claims.keys()][0];
        expect((await store.claim(claimId))!).toMatchObject({ cellId: 'cell-a', state: 'failed' });

        // The worker retries on another cell: that cell's claim.ready binds it, a new boot with its own deadlines.
        const firstHard = (await store.claim(claimId))!.hardExpiresAt;
        t += 10 * 60_000;
        const c = await connect('cell-c');
        expect(await acquireOn(c, 'cell-c')).toMatchObject({ claimId, cellId: 'cell-c', hardExpiresAt: new Date(Date.parse(firstHard) + 10 * 60_000).toISOString() });
        expect((await store.claim(claimId))!).toMatchObject({ cellId: 'cell-c', state: 'bound' });
        expect(logs.find((l) => l.msg === 'claim.rebound')).toMatchObject({ previousCellId: 'cell-a', previousState: 'failed' });
    });

    it("a retry on the cell the claim went to carries the first round's deadlines, which a cell that rejoins it keeps", async () => {
        let t = Date.parse('2026-11-06T10:00:00.000Z');
        const { store, connect, acquireOn } = setup({ now: () => new Date(t) });
        const a = await connect('cell-a');
        const lost = acquireOn(a, 'cell-a', 'org-a', 'none');
        for (let i = 0; i < 5; i++) await tick();
        const first = a.sock.last('claim.acquire').body;
        await a.onClose();
        await lost;

        // The cell kept booting the claim; the worker retries ten minutes later.
        t += 10 * 60_000;
        const again = await connect('cell-a');
        const claim = await acquireOn(again, 'cell-a');
        const sent = again.sock.last('claim.acquire').body;
        const deadlines = { leaseExpiresAt: first.leaseExpiresAt, hardExpiresAt: first.hardExpiresAt };
        expect(sent).toMatchObject(deadlines);
        expect(claim).toMatchObject(deadlines);
        expect([...store.claims.values()][0]).toMatchObject({ state: 'bound', ...deadlines });
    });

    it('a retry under a minute before the kept ceiling does not wait for a boot the cell is about to destroy', async () => {
        let t = Date.parse('2026-11-06T10:00:00.000Z');
        const { connect, acquireOn } = setup({ now: () => new Date(t) });
        const a = await connect('cell-a');
        const lost = acquireOn(a, 'cell-a', 'org-a', 'none');
        for (let i = 0; i < 5; i++) await tick();
        await a.onClose();
        await lost;
        t += 59.5 * 60_000; // a runtime claim's ceiling is 60 min
        const again = await connect('cell-a');
        expect(await acquireOn(again, 'cell-a', 'org-a', 'none')).toMatchObject({ status: 'blocked', blockers: [{ signature: 'boot_timeout' }] });
    });

    it('a retry on the same cell after claim.failed is pending again and binds on claim.ready', async () => {
        const { store, connect, acquireOn } = setup();
        const a = await connect('cell-a');
        await acquireOn(a, 'cell-a', 'org-a', 'failed');
        expect(await acquireOn(a, 'cell-a')).toMatchObject({ cellId: 'cell-a' });
        expect([...store.claims.values()][0].state).toBe('bound');
    });

    it('claim.failed fails the claim with its kind and signature', async () => {
        const { hub, store, connect, acquireOn } = setup();
        const c = await connect('cell-a');
        const r: any = await acquireOn(c, 'cell-a', 'org-a', 'failed');
        expect(r).toEqual({ status: 'blocked', blockers: [{ kind: 'resources', signature: 'create_workload', message: 'no capacity' }], cellId: 'cell-a' });
        expect([...store.claims.values()][0].state).toBe('failed');
    });

    it('claim.failed keeps the blocker with its error line and a bounded, redacted tail of the build output', async () => {
        const { hub, store, connect } = setup();
        const c = await connect('cell-a');
        const p = hub.acquire('cell-a', {
            organizationId: 'org-a',
            environmentId: 'shop',
            runId: 'run-1',
            imageId: 'img-1',
            ref: { side: 'pr', sha: SHA },
            consumer: 'runtime',
            idempotencyKey: 'run-1:pr:1',
            expose: [],
            repo: { provider: 'github', fullName: 'acme/shop', apiBase: 'https://api.github.com' },
            repoToken: 'tok',
        });
        await tick();
        await tick();
        const req = c.sock.last('claim.acquire');
        await c.onMessage(frame('cell-a', 'ack', {}, { re: req.id }));
        const reason = [
            'compose up: exit 1',
            ...Array.from({ length: 60 }, (_, i) => `#12 ${i}.0 step ${i}`),
            '#12 1.2 go: verifying module: github.com/a/b@v1.2.3: Get "https://sum.golang.org/lookup/github.com/a/b@v1.2.3": dial tcp: lookup sum.golang.org on 10.0.0.2:53: no such host',
            '#12 1.3 token ghp_0123456789abcdefghijklmnopqrstuvwxyzAB',
            `#12 ERROR: process "/bin/sh -c go work sync" did not complete successfully: exit code: 1 ${'x'.repeat(500)}`,
        ].join('\n');
        await c.onMessage(frame('cell-a', 'claim.failed', { kind: 'unknown', signature: 'compose_up', reason }, { claimId: req.claimId }));
        const r: any = await p;
        expect(r.blockers[0]).toMatchObject({ kind: 'unknown', signature: 'compose_up', message: reason });
        const [row] = await store.claimBlockers([req.claimId]);
        expect(row).toMatchObject({ claimId: req.claimId, orgId: 'org-a', runId: 'run-1', side: 'pr', kind: 'unknown', signature: 'compose_up' });
        expect(row.message).toContain('lookup sum.golang.org on 10.0.0.2:53: no such host');
        expect(row.logTail).toHaveLength(40);
        expect(row.logTail!.every((l) => l.length <= 300)).toBe(true);
        expect(row.logTail!.at(-1)).toMatch(/^#12 ERROR: process .*…x+$/);
        expect(JSON.stringify(row)).not.toContain('ghp_0123456789');
    });

    it("a boot that outlives the wait is the repository's timeout, and the cell is told to stop it at once", async () => {
        const { store, connect, acquireOn } = setup({ readyTimeoutMs: 30 });
        const c = await connect('cell-a');
        const r = await acquireOn(c, 'cell-a', 'org-a', 'none');
        expect(r).toMatchObject({ status: 'blocked', blockers: [{ kind: 'resources', signature: 'boot_timeout', message: expect.stringContaining('the most a setup waits') }] });
        const claimId = [...store.claims.keys()][0];
        expect((await store.claim(claimId))!.state).toBe('failed');
        await tick();
        expect(c.sock.sent.filter((m) => m.type === 'claim.release').map((m) => m.claimId)).toEqual([claimId]);
    });

    it('a claim pending when the connection drops is not bound', async () => {
        const { hub, connect, acquireOn } = setup();
        const c = await connect('cell-a');
        const p = acquireOn(c, 'cell-a', 'org-a', 'none');
        for (let i = 0; i < 5; i++) await tick();
        // Acked (accepted) but never ready: the drop resolves it as not ready.
        expect(c.sock.sent.some((m) => m.type === 'claim.acquire')).toBe(true);
        await c.onClose();
        expect(await p).toMatchObject({ status: 'blocked', blockers: [{ kind: 'platform', signature: 'cell_lost' }] });
        expect(hub.isConnected('cell-a')).toBe(false);
    });

    it('S-15: a step.result is accepted only from the connection the step was sent on', async () => {
        const { hub, violations, connect, acquireOn } = setup();
        const a = await connect('cell-a');
        const claim: any = await acquireOn(a, 'cell-a');
        const pending = hub.probe(ref(claim.claimId), probe);
        await tick();
        await tick();
        await tick();
        const stepId = a.sock.last('probe.run').body.stepId;
        const result = { stepId, executor: 'observer', imageId: 'img-1', vmHealth: 'ok' };
        // A different cell, and the same cell on a second connection, are both refused.
        const b = await connect('cell-b', 'customer');
        await b.onMessage(frame('cell-b', 'step.result', result, { claimId: claim.claimId }));
        expect(violations).toContain('unknown_step');
        await a.onMessage(frame('cell-a', 'step.result', { ...result, vmHealth: 'oom' }, { claimId: claim.claimId }));
        expect(a.sock.last()).toMatchObject({ type: 'ack' });
        expect(await pending).toMatchObject({ code: 'vm_unhealthy', vmHealth: 'oom' });
    });

    it('pushes egress.policy to the live claims of the environment only', async () => {
        const { hub, connect, acquireOn } = setup();
        const c = await connect('cell-a');
        const claim: any = await acquireOn(c, 'cell-a');
        const p = hub.pushEgressPolicy('org-a', 'shop', ['Registry.npmjs.org', 'api.stripe.com', 'api.stripe.com']);
        await tick();
        await tick();
        const sent = c.sock.last('egress.policy');
        expect(sent).toMatchObject({ claimId: claim.claimId, body: { allow: ['api.stripe.com', 'registry.npmjs.org'] } });
        await c.onMessage(frame('cell-a', 'ack', {}, { re: sent.id }));
        expect(await p).toEqual([claim.claimId]);
        expect(await hub.pushEgressPolicy('org-a', 'other-env', ['x.test'])).toEqual([]);
        expect(await hub.pushEgressPolicy('org-z', 'shop', ['x.test'])).toEqual([]);
    });

    it('acks a resent claim.ready or claim.failed by claimId and refuses the other outcome', async () => {
        const { store, violations, connect, acquireOn } = setup();
        const c = await connect('cell-a');
        const claim: any = await acquireOn(c, 'cell-a');
        const ready = frame('cell-a', 'claim.ready', { manifest, observer: { id: 'obs-1', state: 'ready' } }, { claimId: claim.claimId });
        await c.onMessage(ready);
        expect(c.sock.last()).toMatchObject({ type: 'ack' });
        await c.onMessage(frame('cell-a', 'claim.failed', { kind: 'resources', signature: 'x', reason: 'y' }, { claimId: claim.claimId }));
        expect(c.sock.last()).toMatchObject({ type: 'nack', body: { code: 'claim_settled' } });
        expect((await store.claim(claim.claimId))!.state).toBe('bound');
        expect(violations).toEqual(['claim_settled']);

        const other = setup();
        const failed = await other.connect('cell-a');
        const r: any = await other.acquireOn(failed, 'cell-a', 'org-a', 'failed');
        expect(r.status).toBe('blocked');
        const id = [...other.store.claims.values()].find((x) => x.state === 'failed')!.claimId;
        await failed.onMessage(frame('cell-a', 'claim.failed', { kind: 'resources', signature: 'create_workload', reason: 'no capacity' }, { claimId: id }));
        expect(failed.sock.last()).toMatchObject({ type: 'ack' });
    });

    it('sends the approved hosts of the environment in claim.acquire and again after claim.ready', async () => {
        const { hub, store, logs, connect } = setup();
        store.approvals.set('org-a/shop', ['Api.Stripe.com', 'registry.npmjs.org']);
        const c = await connect('cell-a', 'kodus', CURRENT_CELL);
        const p = hub.acquire('cell-a', {
            organizationId: 'org-a',
            environmentId: 'shop',
            runId: 'run-7',
            ref: { side: 'pr', sha: SHA },
            consumer: 'runtime',
            idempotencyKey: 'run-7:pr:1',
            expose: [],
            repo: { provider: 'github', fullName: 'acme/shop', apiBase: 'https://api.github.com' },
            repoToken: 'ghs_secret_token',
        });
        await tick();
        await tick();
        const req = c.sock.last('claim.acquire');
        expect(req.body.runId).toBe('run-7');
        // In the acquire itself: the project builds while the claim is prepared (a Dockerfile's apk add),
        // so the policy the cell pushes before the build has them, with no race against a later frame.
        expect(req.body.egressAllow).toEqual(['api.stripe.com', 'registry.npmjs.org']);
        // The hub's lease goes with it: the machines' first expiry, so a long boot is not swept (runtime: 45 min, under the 60 min ceiling).
        const lease = Date.parse(req.body.leaseExpiresAt) - Date.parse(req.body.hardExpiresAt);
        expect(lease).toBe(-15 * 60_000);
        await c.onMessage(frame('cell-a', 'ack', {}, { re: req.id }));
        for (let i = 0; i < 5; i++) await tick();
        expect(c.sock.last('egress.policy')).toBeUndefined();
        const timing = { prepareMs: 4210, bootMs: 3500, buildMs: 100, upMs: 2900, seedMs: 200, readyMs: 300 };
        await c.onMessage(frame('cell-a', 'claim.ready', { manifest, observer: { id: 'obs-1', state: 'ready' }, timing }, { claimId: req.claimId }));
        for (let i = 0; i < 5; i++) await tick();
        const policy = c.sock.last('egress.policy');
        expect(policy).toMatchObject({ claimId: req.claimId, body: { allow: ['api.stripe.com', 'registry.npmjs.org'] } });
        await c.onMessage(frame('cell-a', 'ack', {}, { re: policy.id }));
        const claim: any = await p;
        expect(claim).toMatchObject({ claimId: req.claimId, timing });

        // Per-claim log lines carry the ids and never the repo token.
        const msgs = logs.map((l) => l.msg);
        expect(msgs).toEqual(expect.arrayContaining(['claim.acquire', 'claim.ready', 'claim.egress_policy']));
        for (const l of logs.filter((x) => x.msg.startsWith('claim.'))) expect(l).toMatchObject({ cellId: 'cell-a', claimId: req.claimId, runId: 'run-7', replicaId: 'r1' });
        expect(logs.find((l) => l.msg === 'claim.ready')).toMatchObject({ prepareMs: 4210, upMs: 2900 });
        expect(JSON.stringify(logs)).not.toContain('ghs_secret_token');
    });

    it('a cell that does not name egressAllow gets the approved hosts only in the push after claim.ready', async () => {
        const { store, connect, acquireOn } = setup();
        store.approvals.set('org-a/shop', ['registry.npmjs.org']);
        // A cell built before the field: its strict decoder refuses a claim.acquire that carries it.
        const c = await connect('cell-a', 'kodus', { features: ['seedsCache', 'claimSize'] });
        const p = acquireOn(c, 'cell-a');
        for (let i = 0; i < 5; i++) await tick();
        expect(c.sock.last('claim.acquire').body).not.toHaveProperty('egressAllow');
        const policy = c.sock.last('egress.policy');
        expect(policy).toMatchObject({ body: { allow: ['registry.npmjs.org'] } });
        await c.onMessage(frame('cell-a', 'ack', {}, { re: policy.id }));
        expect(await p).toMatchObject({ cellId: 'cell-a' });
    });

    it('a claim with no approved hosts gets no egress.policy; machine.reset reports the cell duration', async () => {
        const { hub, streams, logs, connect, acquireOn } = setup();
        const c = await connect('cell-a');
        const claim: any = await acquireOn(c, 'cell-a');
        expect(c.sock.last('egress.policy')).toBeUndefined();
        const pending = hub.reset(ref(claim.claimId), 'img-1');
        for (let i = 0; i < 4; i++) await tick();
        const sent = c.sock.last('machine.reset');
        await c.onMessage(frame('cell-a', 'step.result', { stepId: sent.body.stepId, executor: 'vm', imageId: 'img-1', vmHealth: 'ok', durationMs: 13_600 }, { claimId: claim.claimId }));
        expect(await pending).toEqual({ ok: true, durationMs: 13_600 });
        const finished = (await streams.read('org-a', 'run-1'))!.events.find((e) => e.type === 'step.finished')!;
        expect(finished.data).toMatchObject({ stepId: sent.body.stepId, cellDurationMs: 13_600 });
        expect(logs.find((l) => l.msg === 'step.result')).toMatchObject({ stepId: sent.body.stepId, claimId: claim.claimId, runId: 'run-1', cellDurationMs: 13_600 });

        const rel = hub.release(ref(claim.claimId));
        for (let i = 0; i < 3; i++) await tick();
        await c.onMessage(frame('cell-a', 'ack', {}, { re: c.sock.last('claim.release').id }));
        await rel;
        expect(logs.find((l) => l.msg === 'claim.release')).toMatchObject({ claimId: claim.claimId, runId: 'run-1', reply: 'ack' });
    });

    it('acks heartbeats', async () => {
        const { connect } = setup();
        const c = await connect('cell-a');
        await c.onMessage(frame('cell-a', 'heartbeat', { claims: [], freeSlots: 3 }));
        expect(c.sock.last().type).toBe('ack');
    });

    describe('S-51, S-52 and the diagnostic hold', () => {
        const acquireAs = async (
            ctx: ReturnType<typeof setup>,
            c: Awaited<ReturnType<ReturnType<typeof setup>['connect']>>,
            over: {
                side: 'base' | 'pr' | 'setup';
                consumer: 'runtime' | 'setup';
                runId?: string;
                diagnosticHold?: boolean;
                seedsCache?: boolean;
                size?: { memoryMb: number; cpus: number };
                canaries?: { slot: 'npmrc' | 'config' | 'seed'; value: string }[];
                key: string;
            },
            reply: (claimId: string) => string,
        ) => {
            const p = ctx.hub.acquire('cell-a', {
                organizationId: 'org-a',
                environmentId: 'shop',
                ...(over.runId ? { runId: over.runId } : {}),
                imageId: 'img-1',
                ref: { side: over.side, sha: SHA },
                consumer: over.consumer,
                idempotencyKey: over.key,
                expose: [{ service: 'web', port: 3000, kind: 'http' }],
                repo: { provider: 'github', fullName: 'acme/shop', apiBase: 'https://api.github.com' },
                repoToken: 'tok',
                ...(over.diagnosticHold ? { diagnosticHold: true } : {}),
                ...(over.seedsCache ? { seedsCache: true } : {}),
                ...(over.size ? { size: over.size } : {}),
                ...(over.canaries ? { canaries: over.canaries } : {}),
            });
            await tick();
            await tick();
            const req = c.sock.last('claim.acquire');
            await c.onMessage(frame('cell-a', 'ack', {}, { re: req.id }));
            await c.onMessage(reply(req.claimId));
            return { claim: (await p) as any, req };
        };
        const ready = (claimId: string) => frame('cell-a', 'claim.ready', { manifest, observer: { id: 'obs-1', state: 'ready' } }, { claimId });

        it('S-52: refuses image.bake and pool.target tied to a PR claim before they reach the cell', async () => {
            const ctx = setup();
            const c = await ctx.connect('cell-a', 'kodus', CURRENT_CELL);
            const { claim } = await acquireAs(ctx, c, { side: 'pr', consumer: 'runtime', runId: 'run-1', key: 'run-1:pr:1' }, ready);
            const sentBefore = c.sock.sent.length;
            expect(await ctx.hub.bake({ organizationId: 'org-a', environmentId: 'shop', recipeSha: SHA, sha: SHA, claimId: claim.claimId })).toMatchObject({ status: 'refused', code: 'pr_claim' });
            expect(await ctx.hub.poolTarget('cell-a', { organizationId: 'org-a', environmentId: 'shop', imageId: 'img-1', size: 1, claimId: claim.claimId })).toMatchObject({
                status: 'refused',
                code: 'pr_claim',
            });
            expect(c.sock.sent.length).toBe(sentBefore);
            expect(ctx.violations).toContain('bake_from_pr');
            // A Run's base claim does not bake either.
            const base = await acquireAs(ctx, c, { side: 'base', consumer: 'runtime', runId: 'run-1', key: 'run-1:base:1' }, ready);
            expect(await ctx.hub.bake({ organizationId: 'org-a', environmentId: 'shop', recipeSha: SHA, sha: SHA, claimId: base.claim.claimId })).toMatchObject({ code: 'not_setup_claim' });
        });

        it("S-29: hands a Run's canaries to a cell that plants them, never to an older cell, a setup or the log", async () => {
            const canaries = [
                { slot: 'config' as const, value: 'kdx_live_0123456789abcdef0123456789abcdef' },
                { slot: 'npmrc' as const, value: 'npm_0123456789abcdef0123456789abcdef' },
            ];
            const ctx = setup();
            const c = await ctx.connect('cell-a', 'kodus', { ...CURRENT_CELL, features: [...CURRENT_CELL.features, 'canaries'] });
            const run = await acquireAs(ctx, c, { side: 'pr', consumer: 'runtime', runId: 'run-1', key: 'run-1:pr:1', canaries }, ready);
            expect(run.req.body.canaries).toEqual(canaries);
            // A setup's workload may be baked: a decoy in it would reach every later claim.
            const setupClaim = await acquireAs(ctx, c, { side: 'setup', consumer: 'setup', key: 'setup:c', canaries }, ready);
            expect(setupClaim.req.body).not.toHaveProperty('canaries');
            // A cell built before the field: its strict decoder would refuse the claim.
            const old = setup();
            const oc = await old.connect('cell-a', 'kodus', CURRENT_CELL);
            const older = await acquireAs(old, oc, { side: 'pr', consumer: 'runtime', runId: 'run-1', key: 'run-1:pr:1', canaries }, ready);
            expect(older.req.body).not.toHaveProperty('canaries');
            for (const v of canaries) expect(JSON.stringify([ctx.logs, old.logs])).not.toContain(v.value);
        });

        it('S-52: sends image.bake for a setup claim and returns what the cell answered', async () => {
            const ctx = setup();
            const c = await ctx.connect('cell-a', 'kodus', CURRENT_CELL);
            const { claim } = await acquireAs(ctx, c, { side: 'setup', consumer: 'setup', key: 'setup:1' }, ready);
            const p = ctx.hub.bake({ organizationId: 'org-a', environmentId: 'shop', recipeSha: SHA, sha: SHA, claimId: claim.claimId });
            await tick();
            await tick();
            const sent = c.sock.last('image.bake');
            expect(sent).toMatchObject({ claimId: claim.claimId, body: { orgId: 'org-a', environmentId: 'shop', sha: SHA } });
            await c.onMessage(frame('cell-a', 'nack', { code: 'sha_mismatch', message: 'x' }, { re: sent.id }));
            expect(await p).toEqual({ status: 'refused', code: 'sha_mismatch', message: 'x' });
        });

        it("sends the environment's machine size on pool.target to a cell that makes sized pools", async () => {
            const ctx = setup();
            const c = await ctx.connect('cell-a', 'kodus', CURRENT_CELL);
            const big = { memoryMb: 16_384, cpus: 8 };
            const p = ctx.hub.poolTarget('cell-a', { organizationId: 'org-a', environmentId: 'shop', imageId: 'latest', size: 2, machineSize: big });
            await tick();
            const sent = c.sock.last('pool.target');
            expect(sent.body).toEqual({ orgId: 'org-a', environmentId: 'shop', imageId: 'latest', size: 2, machineSize: big });
            await c.onMessage(frame('cell-a', 'ack', {}, { re: sent.id }));
            expect(await p).toEqual({ status: 'accepted' });
        });

        it('drains the pool of a sized environment on a cell that makes pools only at its default size, and says so', async () => {
            const ctx = setup();
            const c = await ctx.connect('cell-a', 'kodus', { ...CURRENT_CELL, features: ['seedsCache', 'claimSize', 'egressAllow'] });
            const p = ctx.hub.poolTarget('cell-a', { organizationId: 'org-a', environmentId: 'shop', imageId: 'latest', size: 2, machineSize: { memoryMb: 16_384, cpus: 8 } });
            await tick();
            const sent = c.sock.last('pool.target');
            // The older cell's strict decoder never sees machineSize; default-size machines no Run adopts are not kept.
            expect(sent.body).toEqual({ orgId: 'org-a', environmentId: 'shop', imageId: 'latest', size: 0 });
            await c.onMessage(frame('cell-a', 'ack', {}, { re: sent.id }));
            expect(await p).toMatchObject({ status: 'refused', code: 'pool_size_unsupported' });
            // An environment at the default size keeps its pool there.
            const q = ctx.hub.poolTarget('cell-a', { organizationId: 'org-a', environmentId: 'shop', imageId: 'latest', size: 2 });
            await tick();
            const plain = c.sock.last('pool.target');
            expect(plain.body).toEqual({ orgId: 'org-a', environmentId: 'shop', imageId: 'latest', size: 2 });
            await c.onMessage(frame('cell-a', 'ack', {}, { re: plain.id }));
            expect(await q).toEqual({ status: 'accepted' });
        });

        it('a failed setup with the hold is held: bundle on the blocker, exec allowed, probe refused', async () => {
            const ctx = setup();
            const c = await ctx.connect('cell-a', 'kodus', CURRENT_CELL);
            const bundle = { services: [], ports: [], disk: [], deniedEgress: [], redactions: 0, truncated: false, collectedAt: '2026-10-31T12:00:00Z' };
            const { claim, req } = await acquireAs(ctx, c, { side: 'setup', consumer: 'setup', diagnosticHold: true, key: 'setup:2' }, (claimId) =>
                frame('cell-a', 'claim.failed', { kind: 'platform', signature: 'repo_upload', reason: 'up failed', bundle, held: true }, { claimId }),
            );
            expect(req.body.diagnosticHold).toBe(true);
            expect(claim).toMatchObject({ status: 'blocked', blockers: [{ signature: 'repo_upload', bundle }], held: { claimId: req.claimId, cellId: 'cell-a' }, cellId: 'cell-a' });
            expect((await ctx.store.claim(req.claimId))!.state).toBe('held');
            expect(await ctx.hub.probe(ref(req.claimId), probe)).toEqual({ code: 'lease_expired' });
            const exec = ctx.hub.exec(ref(req.claimId), { stepId: randomUUID(), command: 'docker ps', timeoutMs: 1_000 });
            await tick();
            await tick();
            await tick();
            const sent = c.sock.last('exec');
            expect(sent.claimId).toBe(req.claimId);
            await c.onMessage(
                frame(
                    'cell-a',
                    'step.result',
                    { stepId: sent.body.stepId, executor: 'vm', imageId: 'img-1', vmHealth: 'ok', exec: { exitCode: 0, stdout: '[redacted:jwt]', stderr: '', truncated: false, durationMs: 1 }, redactions: 1 },
                    { claimId: req.claimId },
                ),
            );
            // S-51: the count reaches the step result.
            expect(await exec).toMatchObject({ exitCode: 0, stdout: '[redacted:jwt]', redactions: 1 });
        });

        it('never asks a hold for a PR claim', async () => {
            const ctx = setup();
            const c = await ctx.connect('cell-a', 'kodus', CURRENT_CELL);
            const { req } = await acquireAs(ctx, c, { side: 'pr', consumer: 'setup', diagnosticHold: true, key: 'setup:pr' }, ready);
            expect(req.body.diagnosticHold).toBeUndefined();
        });

        it('passes the environment machine size to the cell, and none when the environment asks none', async () => {
            const ctx = setup();
            const c = await ctx.connect('cell-a', 'kodus', CURRENT_CELL);
            const sized = await acquireAs(ctx, c, { side: 'setup', consumer: 'setup', size: { memoryMb: 16_384, cpus: 8 }, key: 'setup:sized' }, ready);
            expect(sized.req.body.size).toEqual({ memoryMb: 16_384, cpus: 8 });
            const run = await acquireAs(ctx, c, { side: 'pr', consumer: 'runtime', runId: 'run-s', size: { memoryMb: 8_192, cpus: 4 }, key: 'run-s:pr:1' }, ready);
            expect(run.req.body.size).toEqual({ memoryMb: 8_192, cpus: 4 });
            const plain = await acquireAs(ctx, c, { side: 'setup', consumer: 'setup', key: 'setup:plain' }, ready);
            expect(plain.req.body).not.toHaveProperty('size');
        });

        it('a size the cell refuses although its hello granted it comes back as its blocker, nothing bound', async () => {
            const ctx = setup();
            const c = await ctx.connect('cell-a', 'kodus', CURRENT_CELL);
            const failed = (claimId: string) =>
                frame('cell-a', 'claim.failed', { kind: 'resources', signature: 'size_unavailable', reason: 'asked 65536 MB / 16 CPUs, this cell grants at most 16384 MB / 8 CPUs' }, { claimId });
            const { claim, req } = await acquireAs(ctx, c, { side: 'setup', consumer: 'setup', size: { memoryMb: 65_536, cpus: 16 }, key: 'setup:huge' }, failed);
            expect(claim).toMatchObject({ status: 'blocked', blockers: [{ kind: 'resources', signature: 'size_unavailable' }] });
            expect((await ctx.store.claim(req.claimId))!.state).toBe('failed');
        });

        it('S-52: only a setup claim that is not a PR seeds the build cache', async () => {
            const ctx = setup();
            const c = await ctx.connect('cell-a', 'kodus', CURRENT_CELL);
            const seeded = await acquireAs(ctx, c, { side: 'setup', consumer: 'setup', seedsCache: true, key: 'setup:seed' }, ready);
            expect(seeded.req.body.seedsCache).toBe(true);
            for (const over of [
                { side: 'pr' as const, consumer: 'setup' as const, key: 'setup:seed-pr' },
                { side: 'base' as const, consumer: 'runtime' as const, runId: 'run-seed', key: 'run:seed' },
            ]) {
                const { req } = await acquireAs(ctx, c, { ...over, seedsCache: true }, ready);
                expect(req.body.seedsCache).toBeUndefined();
            }
        });
    });

    describe('cell-sent fields the hub accepts (hello ack accepts)', () => {
        const buildSteps = { steps: 14, done: 9, cached: 5, errored: 0, slowest: [{ service: 'grafana', name: '[build 5/6] RUN go build ./pkg/cmd/grafana', ms: 380_200 }] };

        it('a cell that names readyBuildSteps hears it accepted in the hello ack', async () => {
            const ctx = setup();
            const c = await ctx.connect('cell-a', 'kodus', { ...CURRENT_CELL, features: [...CURRENT_CELL.features!, 'readyBuildSteps'] });
            expect(c.sock.last('ack').body).toEqual({ version: PROTOCOL_VERSION, accepts: ['readyBuildSteps'] });
        });

        it('a cell that does not name it gets the ack it always got, without accepts', async () => {
            const ctx = setup();
            const old = await ctx.connect('cell-a', 'kodus', CURRENT_CELL);
            expect(old.sock.last('ack').body).toEqual({ version: PROTOCOL_VERSION });
            const older = await ctx.connect('cell-c');
            expect(older.sock.last('ack').body).toEqual({ version: PROTOCOL_VERSION });
        });

        it("the steps reach the claim with the timing, and the claim.ready line counts them without the steps' names", async () => {
            const ctx = setup();
            const c = await ctx.connect('cell-a', 'kodus', { ...CURRENT_CELL, features: [...CURRENT_CELL.features!, 'readyBuildSteps'] });
            const timing = { prepareMs: 462_000, buildMs: 450_000, buildSteps };
            const claim: any = await ctx.acquireOn(c, 'cell-a', 'org-a', 'ready', { timing });
            expect(claim.timing).toEqual(timing);
            const line = ctx.logs.find((l) => l.msg === 'claim.ready')!;
            expect(line).toMatchObject({ prepareMs: 462_000, buildMs: 450_000, buildSteps: 14, buildStepsCached: 5, slowestBuildStepMs: 380_200 });
            expect(JSON.stringify(line)).not.toContain('go build');
        });

        it("an older cell's ready, without buildSteps or without timing, binds as before", async () => {
            const ctx = setup();
            const c = await ctx.connect('cell-a', 'kodus', CURRENT_CELL);
            const claim: any = await ctx.acquireOn(c, 'cell-a', 'org-a', 'ready', { timing: { prepareMs: 4_210, buildMs: 100 } });
            expect(claim).toMatchObject({ timing: { prepareMs: 4_210, buildMs: 100 } });
            expect(claim.timing).not.toHaveProperty('buildSteps');
            expect(ctx.logs.find((l) => l.msg === 'claim.ready')).not.toHaveProperty('buildSteps');
        });
    });

    describe('evidence capture (EVIDENCE-CAPTURE-DESIGN): only what the cell named', () => {
        const grant = (type: 'logs' | 'db') => ({
            type,
            url: `https://evidence.kodus.test/org-a/run-1/pr/0b9c8d7e-6f50-4a1b-9c2d-3e4f5a6b7c8d/${type}?exp=1&max=1&nonce=AAAAAAAAAAAAAAAA&sig=x`,
            contentType: 'text/plain' as const,
            maxBytes: 1,
            expiresAt: '2026-11-06T12:00:00.000Z',
        });
        const evidence = { capture: ['logs', 'db', 'outbound'] as Array<'logs' | 'db' | 'outbound'>, uploads: [grant('logs'), grant('db')] };
        const answer = async (c: any, claimId: string, extra: Record<string, unknown> = {}) => {
            await tick();
            await tick();
            await tick();
            const sent = c.sock.last('probe.run');
            const stepId = sent.body.stepId;
            await c.onMessage(
                frame(
                    'cell-a',
                    'step.result',
                    { stepId, executor: 'observer', imageId: 'img-1', vmHealth: 'ok', probe: { stepId, executor: 'observer', imageId: 'img-1', requests: [], durationMs: 3, transport: 'ok', ...extra } },
                    { claimId },
                ),
            );
            return sent;
        };

        it('an older cell gets probe.run without evidence', async () => {
            const ctx = setup();
            const c = await ctx.connect('cell-a', 'kodus', CURRENT_CELL);
            const claim: any = await ctx.acquireOn(c, 'cell-a');
            const pending = ctx.hub.probe(ref(claim.claimId), probe, undefined, evidence);
            const sent = await answer(c, claim.claimId);
            await pending;
            expect(sent.body).not.toHaveProperty('evidence');
        });

        it('a cell that names serviceLogs only gets the logs capture and its grant, and its evidence reaches the worker', async () => {
            const ctx = setup();
            const c = await ctx.connect('cell-a', 'kodus', { ...CURRENT_CELL, features: [...CURRENT_CELL.features!, 'serviceLogs', 'timedRequests'] });
            expect(c.sock.last('ack').body.accepts).toEqual(['timedRequests', 'serviceLogs']);
            const claim: any = await ctx.acquireOn(c, 'cell-a');
            const pending = ctx.hub.probe(ref(claim.claimId), probe, undefined, evidence);
            const ev = { t0: '2026-11-06T12:00:00.000Z', windowMs: 3, logs: { lines: 1, truncated: false, tail: [{ at: 1, service: 'api', text: 'ok' }] } };
            const sent = await answer(c, claim.claimId, { evidence: ev });
            expect(sent.body.evidence).toEqual({ capture: ['logs'], uploads: [grant('logs')] });
            expect(((await pending) as any).evidence).toEqual(ev);
        });
    });

    describe('capability negotiation (hello features and max claim size)', () => {
        const SETUP = {
            organizationId: 'org-a',
            environmentId: 'shop',
            imageId: 'img-1',
            ref: { side: 'setup' as const, sha: SHA },
            consumer: 'setup' as const,
            expose: [{ service: 'web', port: 3000, kind: 'http' as const }],
            repo: { provider: 'github' as const, fullName: 'acme/shop', apiBase: 'https://api.github.com' },
            repoToken: 'tok',
        };
        /** A setup acquire on cell-a; answered ready when the hub sent claim.acquire, else what the hub returned. */
        const setupOn = async (ctx: ReturnType<typeof setup>, c: Awaited<ReturnType<ReturnType<typeof setup>['connect']>>, key: string, over: { seedsCache?: boolean; size?: { memoryMb: number; cpus: number }; recipe?: { path: string; content: string | null; digest?: string; files?: Array<{ path: string; content: string }> } }) => {
            const before = c.sock.sent.filter((m) => m.type === 'claim.acquire').length;
            const p = ctx.hub.acquire('cell-a', { ...SETUP, idempotencyKey: key, ...over });
            await tick();
            await tick();
            const sent = c.sock.sent.filter((m) => m.type === 'claim.acquire');
            const req = sent.length > before ? sent[sent.length - 1] : undefined;
            if (req) {
                await c.onMessage(frame('cell-a', 'ack', {}, { re: req.id }));
                await c.onMessage(frame('cell-a', 'claim.ready', { manifest, observer: { id: 'obs-1', state: 'ready' } }, { claimId: req.claimId }));
            }
            return { claim: (await p) as any, req };
        };

        it('stores what the hello named, ignoring a feature it does not know and a size without claimSize', async () => {
            const ctx = setup();
            await ctx.connect('cell-a', 'kodus', CURRENT_CELL);
            expect(await ctx.store.session('cell-a')).toMatchObject({ features: ['seedsCache', 'claimSize', 'egressAllow', 'poolMachineSize', 'authoredFiles'], maxClaimSize: { memoryMb: 65_536, cpus: 16 } });
            await ctx.connect('cell-c', 'kodus', { features: ['seedsCache', 'someFutureField'], maxClaimSize: { memoryMb: 8_192, cpus: 4 } });
            // A cell that does not decode size grants none, whatever it says its driver could.
            expect(await ctx.store.session('cell-c')).toMatchObject({ features: ['seedsCache'], maxClaimSize: null });
            expect(ctx.logs.find((l) => l.msg === 'cell.hello' && l.cellId === 'cell-a')).toMatchObject({ features: 'seedsCache,claimSize,egressAllow,poolMachineSize,authoredFiles', maxClaimMemoryMb: 65_536, maxClaimCpus: 16 });
        });

        it('an older cell (hello without features) never gets seedsCache, and a sized claim is refused before it reaches it', async () => {
            const ctx = setup();
            const c = await ctx.connect('cell-a');
            expect(await ctx.store.session('cell-a')).toMatchObject({ features: [], maxClaimSize: null });

            const seeded = await setupOn(ctx, c, 'setup:old-seed', { seedsCache: true });
            expect(seeded.req).toBeDefined();
            expect(seeded.req.body).not.toHaveProperty('seedsCache');
            expect(seeded.claim).toMatchObject({ claimId: seeded.req.claimId });

            const sized = await setupOn(ctx, c, 'setup:old-size', { size: { memoryMb: 8_192, cpus: 4 } });
            expect(sized.req).toBeUndefined();
            expect(sized.claim).toEqual({
                status: 'blocked',
                blockers: [{ kind: 'resources', signature: 'size_unavailable', message: 'asked 8192 MB / 4 CPUs, this cell grants no machine size' }],
            });
            // Nothing was recorded for a claim that never left the hub.
            expect(await ctx.store.claim(claimIdFor('org-a', 'setup:old-size'))).toBeNull();
            expect(ctx.logs.find((l) => l.msg === 'claim.size_unavailable')).toMatchObject({ cellId: 'cell-a', memoryMb: 8_192, cpus: 4 });
        });

        it("a recipe with Kody's files never boots on a cell that cannot write them: blocked before it reaches the cell", async () => {
            const ctx = setup();
            const files = [{ path: '.kodus/Dockerfile', content: 'FROM node:22-bookworm-slim\n' }];
            const recipe = { path: '.kodus/workspace.yaml', content: 'version: 1\n', digest: 'sha256:both', files };
            const old = await ctx.connect('cell-a', 'kodus', { features: ['seedsCache', 'claimSize', 'egressAllow'] });
            const refused = await setupOn(ctx, old, 'setup:old-files', { recipe });
            expect(refused.req).toBeUndefined();
            expect(refused.claim).toEqual({
                status: 'blocked',
                blockers: [{ kind: 'platform', signature: 'authored_files_unsupported', message: expect.stringContaining('older than the build files Kody writes') }],
            });
            expect(await ctx.store.claim(claimIdFor('org-a', 'setup:old-files'))).toBeNull();
            expect(ctx.logs.find((l) => l.msg === 'claim.authored_files_unsupported')).toMatchObject({ cellId: 'cell-a', files: 1 });
            // The same cell still takes a recipe without files, and the field never reaches it.
            const plain = await setupOn(ctx, old, 'setup:old-plain', { recipe: { path: '.kodus/workspace.yaml', content: 'version: 1\n' } });
            expect(plain.req.body.recipe).toEqual({ path: '.kodus/workspace.yaml', content: 'version: 1\n' });

            const fresh = setup();
            const current = await fresh.connect('cell-a', 'kodus', CURRENT_CELL);
            const sent = await setupOn(fresh, current, 'setup:new-files', { recipe });
            expect(sent.req.body.recipe).toEqual(recipe);
        });

        it('a cell that names the features gets seedsCache and the size it grants', async () => {
            const ctx = setup();
            const c = await ctx.connect('cell-a', 'kodus', CURRENT_CELL);
            const { req } = await setupOn(ctx, c, 'setup:new', { seedsCache: true, size: { memoryMb: 65_536, cpus: 16 } });
            expect(req.body).toMatchObject({ seedsCache: true, size: { memoryMb: 65_536, cpus: 16 } });
        });

        it('a size above the max the cell named is refused before it reaches the cell, naming that max', async () => {
            const ctx = setup();
            const c = await ctx.connect('cell-a', 'kodus', CURRENT_CELL);
            for (const size of [
                { memoryMb: 131_072, cpus: 16 },
                { memoryMb: 65_536, cpus: 32 },
            ]) {
                const { claim, req } = await setupOn(ctx, c, `setup:${size.memoryMb}:${size.cpus}`, { size });
                expect(req).toBeUndefined();
                expect(claim.blockers[0]).toEqual({
                    kind: 'resources',
                    signature: 'size_unavailable',
                    message: `asked ${size.memoryMb} MB / ${size.cpus} CPUs, this cell grants at most 65536 MB / 16 CPUs`,
                });
            }
        });

        it('a cell that names claimSize but no max grants no size', async () => {
            const ctx = setup();
            const c = await ctx.connect('cell-a', 'kodus', { features: ['claimSize'] });
            const { claim, req } = await setupOn(ctx, c, 'setup:no-max', { size: { memoryMb: 4_096, cpus: 2 } });
            expect(req).toBeUndefined();
            expect(claim.blockers[0].message).toBe('asked 4096 MB / 2 CPUs, this cell grants no machine size');
        });
    });
});

const exploreRequest = { steps: [{ goto: '/' }], viewport: { width: 800, height: 600 }, timeoutMs: 1000 };
const exploreResult = { status: 'observed', snapshot: 'button Cart [ref=e1]', candidates: [{ ref: 'e1', selector: '#cart' }], actionsCompleted: 1, durationMs: 2, cliCalls: 3, truncated: false };
describe('local browser exploration transport', () => {
    it('negotiates capability from hello and dispatches one scoped observer step, never a proof', async () => {
        const t = setup(); const c = await t.connect('cell-a', 'kodus', { features: ['browserExplore'] });
        expect(c.sock.last('ack').body.accepts).toContain('browserExplore');
        const claim = await t.acquireOn(c, 'cell-a');
        expect(claim).toMatchObject({ capabilities: { browserExplore: 'v1' } });
        if ('status' in claim) throw new Error('blocked');
        const id = randomUUID(); const out = t.hub.exploreBrowser(ref(claim.claimId), exploreRequest, id);
        await tick(); await tick();
        const sent = c.sock.last('browser.explore');
        expect(sent).toMatchObject({ claimId: claim.claimId, body: { stepId: id, request: exploreRequest } });
        await c.onMessage(frame('cell-a', 'step.result', { stepId: id, executor: 'observer', imageId: 'img-1', vmHealth: 'ok', browserExploration: exploreResult }, { claimId: claim.claimId }));
        expect(await out).toEqual(exploreResult);
        expect(c.sock.sent.filter(m => m.type === 'probe.run')).toEqual([]);
        expect(await t.hub.exploreBrowser(ref(claim.claimId), exploreRequest, id)).toEqual({ code: 'transport_lost', stepId: id });
        expect(c.sock.sent.filter(m => m.type === 'browser.explore')).toHaveLength(1);
        await expect(t.hub.exploreBrowser(ref(claim.claimId, 'org-other'), exploreRequest, randomUUID())).rejects.toThrow();
    });

    it('refuses held, PR and malformed jobs without sending them, and a disconnect never resends a pending job', async () => {
        const t = setup(); const c = await t.connect('cell-a', 'kodus', { features: ['browserExplore'] });
        const claim = await t.acquireOn(c, 'cell-a');
        if ('status' in claim) throw new Error('blocked');
        const row = t.store.claims.get(claim.claimId)!;
        row.side = 'pr';
        expect(await t.hub.exploreBrowser(ref(claim.claimId), exploreRequest, randomUUID())).toMatchObject({ status: 'unavailable' });
        row.side = 'base'; row.state = 'held';
        expect(await t.hub.exploreBrowser(ref(claim.claimId), exploreRequest, randomUUID())).toEqual({ code: 'lease_expired' });
        row.state = 'bound';
        expect(await t.hub.exploreBrowser(ref(claim.claimId), { ...exploreRequest, steps: [{ goto: '/' }, { click: '@e1' }] }, randomUUID())).toMatchObject({ status: 'unavailable' });
        expect(c.sock.sent.some(m => m.type === 'browser.explore')).toBe(false);
        const id = randomUUID(); const out = t.hub.exploreBrowser(ref(claim.claimId), exploreRequest, id);
        await tick(); await tick();
        await c.onClose();
        expect(await out).toEqual({ code: 'transport_lost', stepId: id });
        const next = await t.connect('cell-a', 'kodus', { features: ['browserExplore'] });
        expect(await t.hub.exploreBrowser(ref(claim.claimId), exploreRequest, id)).toEqual({ code: 'transport_lost', stepId: id });
        expect(next.sock.sent.some(m => m.type === 'browser.explore')).toBe(false);
    });

    it('validates the internal browser route and maps a foreign tenant to 404 without forwarding a job', async () => {
        const t = setup(); const c = await t.connect('cell-a', 'kodus', { features: ['browserExplore'] });
        const claim = await t.acquireOn(c, 'cell-a');
        if ('status' in claim) throw new Error('blocked');
        const controller = new InternalController(t.hub);
        const body = { organizationId: 'org-a', runId: 'run-1', stepId: randomUUID(), request: exploreRequest };
        await expect(controller.exploreBrowser(claim.claimId, { ...body, request: { ...exploreRequest, provider: 'external' } })).rejects.toMatchObject({ status: 400 });
        await expect(controller.exploreBrowser(claim.claimId, { ...body, organizationId: 'org-foreign' })).rejects.toMatchObject({ status: 404 });
        expect(c.sock.sent.some(m => m.type === 'browser.explore')).toBe(false);
    });

    it('does not send a new frame when an older cell replaces the negotiated session during dispatch', async () => {
        const t = setup(); const c = await t.connect('cell-a', 'kodus', { features: ['browserExplore'] });
        const claim = await t.acquireOn(c, 'cell-a');
        if ('status' in claim) throw new Error('blocked');
        const session = t.store.session.bind(t.store);
        let replacement: Awaited<ReturnType<typeof t.connect>> | undefined;
        jest.spyOn(t.store, 'session').mockImplementationOnce(async (cellId) => {
            const old = await session(cellId);
            replacement = await t.connect('cell-a', 'kodus', { features: ['browser'] });
            return old;
        });
        const id = randomUUID();
        const out = t.hub.exploreBrowser(ref(claim.claimId), exploreRequest, id);
        await tick(); await tick(); await tick();
        expect(replacement).toBeDefined();
        expect(replacement!.sock.sent.some(m => m.type === 'browser.explore')).toBe(false);
        await replacement!.onClose();
        expect(await out).toMatchObject({ code: 'cell_unavailable' });
    });

    it('does not offer or send exploration to an older cell with only browser evidence support', async () => {
        const t = setup(); const c = await t.connect('cell-a', 'kodus', { features: ['browser'] });
        const claim = await t.acquireOn(c, 'cell-a');
        expect(claim).not.toHaveProperty('capabilities');
        if ('status' in claim) throw new Error('blocked');
        expect(await t.hub.exploreBrowser(ref(claim.claimId), exploreRequest, randomUUID())).toMatchObject({ status: 'unavailable' });
        expect(c.sock.sent.some(m => m.type === 'browser.explore')).toBe(false);
    });
});


describe('browser observer refusal is not an app regression (#2486)', () => {
    it('keeps PR-only policy refusal inconclusive through hub and the production gate', async () => {
        const t = setup();
        const c = await t.connect('cell-a', 'kodus', { features: ['browser'] });
        const claim = await t.acquireOn(c, 'cell-a');
        if ('status' in claim) throw new Error('claim blocked');
        t.store.claims.get(claim.claimId)!.side = 'pr';
        const recorded: Probe = { id: 'owned-page', origin: 'agent', purpose: 'read heading', expected: 'Ready', compare: ['dom'], spec: { kind: 'browser', steps: [{ goto: '/' }, { expectText: ['h1', 'Ready'] }], viewport: { width: 640, height: 480 }, timeoutMs: 1000 } };
        const result: ProbeResult = { stepId: randomUUID(), executor: 'observer', imageId: 'img-1', browser: { network: [], console: [], steps: [{ index: 0, kind: 'goto', ok: true, startMs: 0, endMs: 1 }, { index: 1, kind: 'expectText', ok: true, value: 'Ready', startMs: 1, endMs: 2 }] }, requests: [{ method: 'GET', route: '/', status: 200 }], durationMs: 2, transport: 'ok' };
        const steps = Array.from({ length: 4 }, (_, i) => toGateStep({ probe: recorded, side: 'base', round: i + 1, stepId: randomUUID(), result: { ...result, vmHealth: 'ok' } }));
        for (let round = 1; round <= 4; round++) {
            const stepId = randomUUID();
            const pending = t.hub.probe(ref(claim.claimId), recorded, stepId);
            await tick(); await tick();
            // Capture refusal returns no ProbeResult. The workload remains healthy;
            // rendering this as a failed browser step would manufacture a finding.
            await c.onMessage(frame('cell-a', 'step.result', { stepId, executor: 'observer', imageId: 'img-1', vmHealth: 'ok' }, { claimId: claim.claimId }));
            const refusal = await pending;
            expect(refusal).toEqual({ code: 'transport_lost', stepId });
            steps.push(toGateStep({ probe: recorded, side: 'pr', round, stepId, result: refusal }));
            const decision = decideProbe(steps, { pinnedImageId: 'img-1' });
            if (decision.kind === 'verdict') expect(decision.verdict).toBe('inconclusive');
        }
        expect(decideProbe(steps, { pinnedImageId: 'img-1' })).toMatchObject({ kind: 'verdict', verdict: 'inconclusive' });
        await c.onClose();
    });
});

// #2488: source continuity loss is infrastructure unavailability. Even when
// it occurs only on the PR's cell, it supplies no unhealthy-VM fact.
describe('alert-source admission refusal through hub and gate', () => {
    it('keeps repeated not_accepting responses inconclusive rather than manufacturing a regression', async () => {
        const t = setup();
        const c = await t.connect('cell-a');
        const claim = await t.acquireOn(c, 'cell-a');
        if ('status' in claim) throw new Error('claim blocked');
        t.store.claims.get(claim.claimId)!.side = 'pr';
        const healthy = { stepId: randomUUID(), executor: 'observer' as const, imageId: 'img-1', vmHealth: 'ok' as const, transport: 'ok' as const, http: { status: 200, headers: {}, body: '{}' }, requests: [], durationMs: 1 };
        const steps = [1, 2].map((round) => toGateStep({ probe, side: 'base', round, stepId: randomUUID(), result: healthy }));
        for (let round = 1; round <= 4; round++) {
            const stepId = randomUUID();
            const pending = t.hub.probe(ref(claim.claimId), probe, stepId);
            await tick(); await tick(); await tick();
            const request = c.sock.last('probe.run');
            await c.onMessage(frame('cell-a', 'nack', { code: 'not_accepting', message: 'cell cannot accept work' }, { re: request.id }));
            const refusal = await pending;
            expect(refusal).toMatchObject({ code: 'cell_unavailable' });
            const recorded = toGateStep({ probe, side: 'pr', round, stepId, result: refusal });
            expect(recorded).toMatchObject({ transport: 'lost', vmHealth: 'ok' });
            steps.push(recorded);
        }
        expect(decideProbe(steps, { pinnedImageId: 'img-1' })).toMatchObject({ kind: 'verdict', verdict: 'inconclusive' });
        expect(decideProbe(steps, { pinnedImageId: 'img-1' })).not.toHaveProperty('findingKind');
        await c.onClose();
    });
});
