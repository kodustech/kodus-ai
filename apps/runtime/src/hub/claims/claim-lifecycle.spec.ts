import { randomUUID } from 'crypto';

import { decodeFrame, PROTOCOL_VERSION } from '@libs/runtime/protocol';
import { InMemoryRunStreamStore } from '@libs/runtime/run/testing';
import { RuntimeMetrics } from '@libs/runtime/telemetry';

import { createCa } from '../ca/x509';
import { CellHub, ClaimScopeError, HubLogLine } from '../cell-hub';
import { InMemoryHubStore } from '../hub-store';
import { claimIdFor } from './claim.service';

// The claim lifecycle under the races the review found: a release during a
// boot, a duplicate acquire after a worker crash, a claim named by another
// tenant, and a cell that still holds a claim the hub finished.

class Sock {
    sent: any[] = [];
    send(d: string) {
        const r = decodeFrame(d);
        if ('code' in r) throw new Error(`hub sent an invalid frame: ${r.code}`);
        this.sent.push(r.message);
    }
    close() {}
    last(type?: string) {
        return [...this.sent].reverse().find((m) => !type || m.type === type);
    }
    all(type: string) {
        return this.sent.filter((m) => m.type === type);
    }
}

const SHA = 'a'.repeat(40);
const CA = createCa('lifecycle CA');
const tick = () => new Promise((r) => setImmediate(r));
const frame = (cellId: string, type: string, body: unknown, extra: Record<string, unknown> = {}) => JSON.stringify({ v: PROTOCOL_VERSION, id: randomUUID(), cellId, type, body, ...extra });
const manifest = { services: [{ name: 'web', health: 'ok' }], expose: [{ service: 'web', port: 3000, kind: 'http' }], imageId: 'img-1', seedSha: 'seed-1' };
const probe = {
    id: 'p1',
    origin: 'agent' as const,
    purpose: 'x',
    expected: '400',
    compare: ['status' as const],
    spec: { kind: 'http' as const, target: { service: 'web', port: 3000 }, method: 'POST' as const, path: '/orders', timeoutMs: 1_000 },
};

async function harness() {
    const store = new InMemoryHubStore();
    const logs: HubLogLine[] = [];
    const violations: string[] = [];
    const metrics = new RuntimeMetrics();
    jest.spyOn(metrics, 'recordProtocolViolation').mockImplementation((a) => void violations.push(a.code));
    const streams = new InMemoryRunStreamStore();
    const hub = new CellHub(store, streams, metrics, { replicaId: 'r1', replicaUrl: 'http://hub', ca: CA, log: (l) => void logs.push(l) });
    const sock = new Sock();
    const h = hub.attach(sock, { cellId: 'cell-a', owner: 'kodus' });
    await h.onMessage(frame('cell-a', 'hello', { versions: [1], driver: 'fake', isolation: 'vm', regions: [], owner: 'kodus' }));
    const acquire = (org = 'org-a', key = 'run-1:base:1') =>
        hub.acquire('cell-a', {
            organizationId: org,
            environmentId: 'shop',
            runId: 'run-1',
            imageId: 'img-1',
            ref: { side: 'base', sha: SHA },
            consumer: 'runtime',
            idempotencyKey: key,
            expose: [],
            repo: { provider: 'github', fullName: 'acme/shop', apiBase: 'https://api.github.com' },
            repoToken: 'tok',
        });
    const ackAcquire = async () => {
        await tick();
        await tick();
        const req = sock.last('claim.acquire');
        await h.onMessage(frame('cell-a', 'ack', {}, { re: req.id }));
        return req;
    };
    const ready = (claimId: string) => h.onMessage(frame('cell-a', 'claim.ready', { manifest, observer: { id: 'o', state: 'ready' } }, { claimId }));
    return { hub, store, streams, sock, h, logs, violations, metrics, acquire, ackAcquire, ready };
}

describe('claim lifecycle', () => {
    it('a release during the boot returns the boot at once and never lets a late claim.ready bind the claim', async () => {
        const t = await harness();
        const pending = t.acquire();
        const req = await t.ackAcquire();
        const releasing = t.hub.release({ claimId: req.claimId, organizationId: 'org-a', runId: 'run-1' });
        // The boot returns without waiting for its 15 min ready timeout.
        expect(await pending).toMatchObject({ status: 'blocked', blockers: [{ signature: 'claim_released' }] });
        await tick();
        await t.h.onMessage(frame('cell-a', 'ack', {}, { re: t.sock.last('claim.release').id }));
        await releasing;
        await t.ready(req.claimId);
        expect((await t.store.claim(req.claimId))!.state).toBe('released');
        expect(t.sock.last()).toMatchObject({ type: 'nack', body: { code: 'unknown_claim' } });
    });

    it('a duplicate acquire of the same claim joins the round in flight; the claim stays bound', async () => {
        const t = await harness();
        const first = t.acquire();
        const second = t.acquire();
        const req = await t.ackAcquire();
        expect(t.sock.all('claim.acquire')).toHaveLength(1);
        await t.ready(req.claimId);
        const [a, b] = await Promise.all([first, second]);
        expect(a).toEqual(b);
        expect((await t.store.claim(req.claimId))!.state).toBe('bound');
    });

    it('a late outcome cannot overwrite a final claim (compare-and-set in the store)', async () => {
        const t = await harness();
        await t.store.insertClaim({ claimId: 'c1', cellId: 'cell-a', orgId: 'o', side: 'base', state: 'pending', leaseExpiresAt: '', hardExpiresAt: new Date(Date.now() + 60_000).toISOString() });
        expect(await t.store.transitionClaim('c1', ['pending', 'bound'], 'released', { reason: 'released' })).toBe(true);
        expect(await t.store.transitionClaim('c1', ['pending'], 'bound', { reason: 'ready' })).toBe(false);
        expect(await t.store.transitionClaim('c1', ['pending'], 'failed', { reason: 'not_ready' })).toBe(false);
        expect(await t.store.rebindClaim('c1', { cellId: 'cell-b', leaseExpiresAt: '', hardExpiresAt: '' })).toBe(false);
        // The refused moves left the cause of the one that happened.
        expect((await t.store.claim('c1'))!).toMatchObject({ state: 'released', cellId: 'cell-a', reason: 'released', reasonDetail: null });
    });

    it('a claim named with another org or another Run is refused and never touched', async () => {
        const t = await harness();
        const pending = t.acquire();
        const req = await t.ackAcquire();
        await t.ready(req.claimId);
        await pending;
        await expect(t.hub.probe({ claimId: req.claimId, organizationId: 'org-b' }, probe)).rejects.toBeInstanceOf(ClaimScopeError);
        await expect(t.hub.exec({ claimId: req.claimId, organizationId: 'org-a', runId: 'run-2' }, { stepId: randomUUID(), command: 'id', timeoutMs: 10 })).rejects.toBeInstanceOf(ClaimScopeError);
        await expect(t.hub.release({ claimId: req.claimId, organizationId: 'org-b' })).rejects.toBeInstanceOf(ClaimScopeError);
        expect(t.sock.all('probe.run')).toHaveLength(0);
        expect(t.sock.all('exec')).toHaveLength(0);
        expect((await t.store.claim(req.claimId))!.state).toBe('bound');
        expect(t.violations).toContain('claim_scope');
    });

    it('a claim past its hard expiry takes no step', async () => {
        const t = await harness();
        await t.store.insertClaim({ claimId: 'old', cellId: 'cell-a', orgId: 'org-a', side: 'base', state: 'bound', leaseExpiresAt: '', hardExpiresAt: new Date(Date.now() - 1_000).toISOString() });
        expect(await t.hub.probe({ claimId: 'old', organizationId: 'org-a' }, probe)).toEqual({ code: 'lease_expired' });
        expect(t.sock.all('probe.run')).toHaveLength(0);
    });

    it('the same idempotency key in two orgs is two claims', () => {
        expect(claimIdFor('org-a', 'k')).not.toBe(claimIdFor('org-b', 'k'));
    });

    it('a second hello on a live connection is refused and does not count the cell twice', async () => {
        const t = await harness();
        await t.h.onMessage(frame('cell-a', 'hello', { versions: [1], driver: 'fake', isolation: 'vm', regions: [], owner: 'kodus' }));
        expect(t.sock.last()).toMatchObject({ type: 'nack', body: { code: 'hello_repeated' } });
    });

    it('a heartbeat naming a claim the hub released sends claim.release to the cell', async () => {
        const t = await harness();
        await t.store.insertClaim({ claimId: 'gone', cellId: 'cell-a', orgId: 'org-a', side: 'base', state: 'released', leaseExpiresAt: '', hardExpiresAt: '' });
        await t.h.onMessage(frame('cell-a', 'heartbeat', { claims: [{ claimId: 'gone', machines: 1 }], freeSlots: 3 }));
        await tick();
        expect(t.sock.last('claim.release')).toMatchObject({ claimId: 'gone' });
        expect(t.logs.find((l) => l.msg === 'claim.reconciled_release')).toMatchObject({ claimId: 'gone', state: 'released' });
    });

    it('step.stream frames are checked in memory, without a store read per frame', async () => {
        const t = await harness();
        const pending = t.acquire();
        const req = await t.ackAcquire();
        await t.ready(req.claimId);
        await pending;
        const stepRead = jest.spyOn(t.store, 'step');
        const probing = t.hub.probe({ claimId: req.claimId, organizationId: 'org-a' }, probe);
        for (let i = 0; i < 4; i++) await tick();
        const stepId = t.sock.last('probe.run').body.stepId;
        for (let i = 0; i < 5; i++) await t.h.onMessage(frame('cell-a', 'step.stream', { stepId, chunk: `line ${i}` }, { claimId: req.claimId }));
        await t.h.onMessage(frame('cell-a', 'step.result', { stepId, executor: 'observer', imageId: 'img-1', vmHealth: 'ok' }, { claimId: req.claimId }));
        await probing;
        expect(stepRead).not.toHaveBeenCalled();
    });
});

describe('cell slots', () => {
    it('concurrent reservations spread over cells by their free slots', async () => {
        const store = new InMemoryHubStore();
        for (const id of ['c1', 'c2']) {
            await store.upsertSession({ cellId: id, replicaId: 'r', replicaUrl: 'u', owner: 'kodus', driver: 'fake' });
            await store.heartbeat(id, 'r', 1);
        }
        const picked = await Promise.all([store.reserveCell('o'), store.reserveCell('o')]);
        expect(new Set(picked.map((p) => p!.cellId))).toEqual(new Set(['c1', 'c2']));
    });

    it("spreads an org over the cells where it holds fewer live claims, as the Pg store does", async () => {
        const store = new InMemoryHubStore();
        await store.upsertSession({ cellId: 'big', replicaId: 'r', replicaUrl: 'u', owner: 'kodus', driver: 'fake' });
        await store.heartbeat('big', 'r', 9);
        await store.upsertSession({ cellId: 'small', replicaId: 'r', replicaUrl: 'u', owner: 'kodus', driver: 'fake' });
        await store.heartbeat('small', 'r', 2);
        const hard = new Date(Date.now() + 60_000).toISOString();
        await store.insertClaim({ claimId: 'k1', cellId: 'big', orgId: 'o', side: 'pr', state: 'bound', hardExpiresAt: hard, leaseExpiresAt: hard });
        await store.insertClaim({ claimId: 'k2', cellId: 'small', orgId: 'other', side: 'pr', state: 'bound', hardExpiresAt: hard, leaseExpiresAt: hard });
        expect((await store.reserveCell('o'))?.cellId).toBe('small');
        expect((await store.reserveCell('other'))?.cellId).toBe('big');
    });
});

describe('a claim says why it is in its state', () => {
    const settle = async (t: Awaited<ReturnType<typeof harness>>, answer: (claimId: string, acquireId: string) => Promise<void>) => {
        const pending = t.acquire();
        await tick();
        await tick();
        const req = t.sock.last('claim.acquire');
        await answer(req.claimId, req.id);
        await pending;
        return (await t.store.claim(req.claimId))!;
    };

    it.each([
        {
            name: 'ready',
            answer: async (t: Awaited<ReturnType<typeof harness>>, claimId: string, id: string) => {
                await t.h.onMessage(frame('cell-a', 'ack', {}, { re: id }));
                await t.ready(claimId);
            },
            want: { state: 'bound', reason: 'ready', reasonDetail: null },
        },
        {
            name: 'the boot failed',
            answer: async (t: Awaited<ReturnType<typeof harness>>, claimId: string, id: string) => {
                await t.h.onMessage(frame('cell-a', 'ack', {}, { re: id }));
                await t.h.onMessage(frame('cell-a', 'claim.failed', { kind: 'seed_data', signature: 'migrate_failed', reason: 'exit 1' }, { claimId }));
            },
            want: { state: 'failed', reason: 'boot_failed', reasonDetail: 'seed_data/migrate_failed' },
        },
        {
            name: 'the cell refused the acquire',
            answer: async (t: Awaited<ReturnType<typeof harness>>, _claimId: string, id: string) => {
                await t.h.onMessage(frame('cell-a', 'nack', { code: 'no_capacity', message: 'no slot' }, { re: id }));
            },
            want: { state: 'blocked', reason: 'cell_refused', reasonDetail: 'no_capacity' },
        },
    ])('$name', async ({ answer, want }) => {
        const t = await harness();
        const row = await settle(t, (claimId, id) => answer(t, claimId, id));
        expect(row).toMatchObject(want);
        expect(Date.parse(row.stateChangedAt!)).not.toBeNaN();
        // Every move is a log line with the same reason, so a claim's history is in the logs.
        expect(t.logs.filter((l) => l.msg === 'claim.transition' && l.claimId === row.claimId).at(-1)).toMatchObject({ to: want.state, reason: want.reason });
    });

    it('a release records released, and a new round of the same claim records reacquired', async () => {
        const t = await harness();
        const row = await settle(t, async (_claimId, id) => {
            await t.h.onMessage(frame('cell-a', 'nack', { code: 'no_capacity', message: 'no slot' }, { re: id }));
        });
        // The worker retries the same claim: the blocked round is open, so it is rebound. The cell never
        // acks this round, so it ends in a timeout after the test; caught so it cannot crash the runner.
        void t.acquire().catch(() => undefined);
        await tick();
        await tick();
        expect((await t.store.claim(row.claimId))!).toMatchObject({ state: 'pending', reason: 'reacquired', reasonDetail: null });
        const releasing = t.hub.release({ claimId: row.claimId, organizationId: 'org-a', runId: 'run-1' });
        await tick();
        await t.h.onMessage(frame('cell-a', 'ack', {}, { re: t.sock.last('claim.release').id }));
        await releasing;
        expect((await t.store.claim(row.claimId))!).toMatchObject({ state: 'released', reason: 'released' });
    });
});

describe('a security violation the cell reports unsolicited', () => {
    const violation = (claimId: string, kind = 'security_violation', signature = 'credential_exfiltration') =>
        frame('cell-a', 'blocked', { kind, signature, message: 'the claim sent its test credential to collector.example.test' }, { claimId });
    const bound = async (t: Awaited<ReturnType<typeof harness>>) => {
        const pending = t.acquire();
        const req = await t.ackAcquire();
        await t.ready(req.claimId);
        await pending;
        return req.claimId as string;
    };

    it('marks the bound claim compromised, records the blocker, fails the step in flight and every later step, and tells the Run', async () => {
        const t = await harness();
        const security = jest.spyOn(t.metrics, 'recordSecurityEvent');
        const claimId = await bound(t);
        const ref = { claimId, organizationId: 'org-a', runId: 'run-1' };
        const inFlight = t.hub.probe(ref, probe);
        for (let i = 0; i < 4; i++) await tick();
        await t.h.onMessage(violation(claimId));
        expect(t.sock.last()).toMatchObject({ type: 'ack' });
        expect(await inFlight).toEqual({ code: 'security_violation', claimId, signature: 'credential_exfiltration' });
        expect(await t.hub.probe(ref, probe)).toEqual({ code: 'security_violation', claimId, signature: 'credential_exfiltration' });
        expect((await t.store.claim(claimId))!).toMatchObject({ state: 'compromised', reason: 'security_violation', reasonDetail: 'credential_exfiltration' });
        expect(await t.store.claimBlockers([claimId])).toMatchObject([{ claimId, kind: 'security_violation', signature: 'credential_exfiltration', side: 'base', runId: 'run-1' }]);
        expect(security).toHaveBeenCalledWith({ orgId: 'org-a', kind: 'exfiltration', where: 'base' });
        const events = (await t.streams.read('org-a', 'run-1'))!.events;
        expect(events.find((e) => e.type === 'security')!.data).toEqual({ kind: 'exfiltration', side: 'base', signature: 'credential_exfiltration' });
        // A resend (the cell lost the ack) is acked and records nothing twice.
        await t.h.onMessage(violation(claimId));
        expect(t.sock.last()).toMatchObject({ type: 'ack' });
        expect(await t.store.claimBlockers([claimId])).toHaveLength(1);
        // The machines are evidence: a heartbeat that still lists the claim does not release it.
        await t.h.onMessage(frame('cell-a', 'heartbeat', { claims: [{ claimId, machines: 2 }], freeSlots: 0 }));
        await tick();
        expect(t.sock.all('claim.release')).toHaveLength(0);
        // The Run's end still releases it.
        const releasing = t.hub.release(ref);
        await tick();
        await t.h.onMessage(frame('cell-a', 'ack', {}, { re: t.sock.last('claim.release').id }));
        await releasing;
        expect((await t.store.claim(claimId))!.state).toBe('released');
    });

    it('during the boot: the acquire ends blocked with the violation', async () => {
        const t = await harness();
        const pending = t.acquire();
        const req = await t.ackAcquire();
        await t.h.onMessage(violation(req.claimId, 'security_violation', 'bait_exfiltration'));
        expect(await pending).toMatchObject({ status: 'blocked', blockers: [{ kind: 'security_violation', signature: 'bait_exfiltration' }] });
        expect((await t.store.claim(req.claimId))!.state).toBe('compromised');
    });

    it('is refused for a claim of another cell, a finished claim, or another blocker kind', async () => {
        const t = await harness();
        await t.store.insertClaim({ claimId: 'theirs', cellId: 'cell-b', orgId: 'org-a', side: 'base', state: 'bound', leaseExpiresAt: '', hardExpiresAt: new Date(Date.now() + 60_000).toISOString() });
        await t.h.onMessage(violation('theirs'));
        expect(t.sock.last()).toMatchObject({ type: 'nack', body: { code: 'unknown_claim' } });
        expect((await t.store.claim('theirs'))!.state).toBe('bound');

        await t.store.insertClaim({ claimId: 'done', cellId: 'cell-a', orgId: 'org-a', side: 'base', state: 'released', leaseExpiresAt: '', hardExpiresAt: '' });
        await t.h.onMessage(violation('done'));
        expect(t.sock.last()).toMatchObject({ type: 'nack', body: { code: 'unknown_claim' } });

        const claimId = await bound(t);
        await t.h.onMessage(violation(claimId, 'resources', 'oom'));
        expect(t.sock.last()).toMatchObject({ type: 'nack', body: { code: 'unsolicited_blocked' } });
        expect((await t.store.claim(claimId))!.state).toBe('bound');
        expect(await t.store.claimBlockers(['theirs', 'done', claimId])).toEqual([]);
    });

    describe('memory admission (ADR-070)', () => {
        const memory = (committedMb: number) => ({ allocatableMb: 14_745, committedMb, bootMb: 12_288, readyMb: 2_048 });
        const heartbeat = (t: Awaited<ReturnType<typeof harness>>, committedMb: number, claims: string[] = []) =>
            t.h.onMessage(frame('cell-a', 'heartbeat', { claims: claims.map((claimId) => ({ claimId, machines: 2 })), freeSlots: 4, memory: memory(committedMb) }));
        const prAcquire = (t: Awaited<ReturnType<typeof harness>>, runId: string) =>
            t.hub.acquire('cell-a', {
                organizationId: 'org-a',
                environmentId: 'shop',
                runId,
                imageId: 'img-1',
                ref: { side: 'pr', sha: SHA },
                consumer: 'runtime',
                idempotencyKey: `${runId}:pr:1`,
                expose: [],
                repo: { provider: 'github', fullName: 'acme/shop', apiBase: 'https://api.github.com' },
                repoToken: 'tok',
            });

        it('a build that does not fit is refused as no_capacity before anything is recorded or sent', async () => {
            const t = await harness();
            await heartbeat(t, 12_288, ['someone-else']);
            const out = await prAcquire(t, 'run-2');
            expect(out).toMatchObject({
                status: 'blocked',
                blockers: [{ kind: 'resources', signature: 'no_capacity' }],
                capacity: { cellId: 'cell-a', needMb: 14_336, freeMb: 2_457, allocatableMb: 14_745, ahead: 0 },
            });
            expect(t.sock.all('claim.acquire')).toHaveLength(0);
            expect(await t.store.claim(claimIdFor('org-a', 'run-2:pr:1'))).toBeNull();
            expect(t.logs.find((l) => l.msg === 'claim.no_capacity')).toMatchObject({ needMb: 14_336, freeMb: 2_457 });
        });

        it('fits once the cell reports the memory back, and a cell that sends none is admitted as before', async () => {
            const t = await harness();
            await heartbeat(t, 12_288, ['someone-else']);
            expect(await prAcquire(t, 'run-2')).toMatchObject({ blockers: [{ signature: 'no_capacity' }] });
            await heartbeat(t, 0);
            const pending = prAcquire(t, 'run-2');
            const req = await t.ackAcquire();
            await t.ready(req.claimId);
            expect(await pending).toMatchObject({ claimId: req.claimId, cellId: 'cell-a' });

            const old = await harness();
            await old.h.onMessage(frame('cell-a', 'heartbeat', { claims: [], freeSlots: 4 }));
            const p = old.acquire();
            const r = await old.ackAcquire();
            await old.ready(r.claimId);
            expect(await p).toMatchObject({ claimId: r.claimId });
        });

        it('records what each round held, once per transition: driver, build and ready MB, allocatable, admitted, ready, released', async () => {
            const t = await harness();
            await heartbeat(t, 0);
            const pending = prAcquire(t, 'run-3');
            const req = await t.ackAcquire();
            const admitted = (await t.store.claim(req.claimId))!;
            expect(admitted.metering).toEqual({ driver: 'fake', bootMb: 12_288, readyMb: 2_048, allocatableMb: 14_745 });
            expect(admitted.admittedAt).toBeTruthy();
            expect(admitted.readyAt).toBeNull();
            await t.ready(req.claimId);
            await pending;
            const ready = (await t.store.claim(req.claimId))!;
            expect(ready.readyAt).toBeTruthy();
            const releasing = t.hub.release({ claimId: req.claimId, organizationId: 'org-a', runId: 'run-3' });
            await tick();
            await t.h.onMessage(frame('cell-a', 'ack', {}, { re: t.sock.last('claim.release').id }));
            await releasing;
            const released = (await t.store.claim(req.claimId))!;
            expect(released).toMatchObject({ state: 'released', readyAt: ready.readyAt, admittedAt: admitted.admittedAt });
            expect(released.releasedAt).toBeTruthy();

            // The base of a Run boots from the bake: counted at the ready size throughout.
            const base = t.acquire('org-a', 'run-1:base:1');
            const b = await t.ackAcquire();
            expect((await t.store.claim(b.claimId))!.metering).toEqual({ driver: 'fake', bootMb: 2_048, readyMb: 2_048, allocatableMb: 14_745 });
            await t.ready(b.claimId);
            await base;

            // A cell that reports no memory: the driver only.
            const old = await harness();
            const p = old.acquire();
            const r = await old.ackAcquire();
            await old.ready(r.claimId);
            await p;
            expect((await old.store.claim(r.claimId))!.metering).toEqual({ driver: 'fake', bootMb: null, readyMb: null, allocatableMb: null });
        });

        it('a cell that refuses for room (its own ledger) is a wait, and the next round gets a fresh lifetime', async () => {
            const t = await harness();
            const first = t.acquire();
            await tick();
            await tick();
            const req = t.sock.last('claim.acquire');
            await t.h.onMessage(frame('cell-a', 'nack', { code: 'no_capacity', message: 'the claim needs 12288 MB of memory and 409 of the cell\'s 14745 MB are free' }, { re: req.id }));
            expect(await first).toMatchObject({ status: 'blocked', blockers: [{ kind: 'resources', signature: 'no_capacity' }], capacity: { cellId: 'cell-a' } });
            const refused = (await t.store.claim(req.claimId))!;
            expect(refused).toMatchObject({ state: 'blocked', reasonDetail: 'no_capacity' });
            await new Promise((r) => setTimeout(r, 5));
            const second = t.acquire();
            const again = await t.ackAcquire();
            await t.ready(again.claimId);
            await second;
            // Not the refused round's ceiling: that round never ran on the cell.
            const row = (await t.store.claim(req.claimId))!;
            expect(Date.parse(row.hardExpiresAt)).toBeGreaterThan(Date.parse(refused.hardExpiresAt));
            expect(again.body.hardExpiresAt).toBe(row.hardExpiresAt);
        });
    });
});

