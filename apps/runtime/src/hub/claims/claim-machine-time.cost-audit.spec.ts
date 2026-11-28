import { randomUUID } from 'crypto';

import { claimHeldMinutes, type RunClaimUsage } from '@libs/runtime/api/domain/run-cost';
import { decodeFrame, PROTOCOL_VERSION } from '@libs/runtime/protocol';
import { InMemoryRunStreamStore } from '@libs/runtime/run/testing';
import { RuntimeMetrics } from '@libs/runtime/telemetry';

import { createCa } from '../ca/x509';
import { CellHub, type HubLogLine } from '../cell-hub';
import { type ClaimRow } from '../hub-store';
import { InMemoryHubStore } from '../testing';

// Cost audit (machine side): the claim row the hub writes is the only source
// the Run cost and the usage report price machine time from
// (libs/runtime/api/domain/run-cost.ts). These drive a real CellHub and its
// ClaimService against a fake cell socket and read back what a Run would be
// charged for the claim. Each `it.failing` is a defect the audit proved.

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
}

const SHA = 'a'.repeat(40);
const CA = createCa('cost audit CA');
const T0 = new Date('2026-11-20T12:00:00.000Z');
const tick = () => new Promise((r) => setImmediate(r));
const frame = (cellId: string, type: string, body: unknown, extra: Record<string, unknown> = {}) => JSON.stringify({ v: PROTOCOL_VERSION, id: randomUUID(), cellId, type, body, ...extra });
const manifest = { services: [{ name: 'web', health: 'ok' }], expose: [{ service: 'web', port: 3000, kind: 'http' }], imageId: 'img-1', seedSha: 'seed-1' };
const minutesAfter = (min: number) => jest.setSystemTime(new Date(T0.getTime() + min * 60_000));

/** The claim row as the API's claim reader maps it (pg-runtime-claim-usage.reader.ts). */
const usageOf = (row: ClaimRow): RunClaimUsage => ({
    claimId: row.claimId,
    cellId: row.cellId,
    side: row.side,
    state: row.state,
    driver: row.metering?.driver ?? null,
    bootMb: row.metering?.bootMb ?? null,
    readyMb: row.metering?.readyMb ?? null,
    allocatableMb: row.metering?.allocatableMb ?? null,
    admittedAt: row.admittedAt ?? null,
    readyAt: row.readyAt ?? null,
    releasedAt: row.releasedAt ?? null,
    stateChangedAt: row.stateChangedAt ?? null,
    hardExpiresAt: row.hardExpiresAt,
});

async function harness() {
    const store = new InMemoryHubStore();
    const logs: HubLogLine[] = [];
    const hub = new CellHub(store, new InMemoryRunStreamStore(), new RuntimeMetrics(), { replicaId: 'r1', replicaUrl: 'http://hub', ca: CA, log: (l) => void logs.push(l) });
    const connect = async () => {
        const sock = new Sock();
        const h = hub.attach(sock, { cellId: 'cell-a', owner: 'kodus' });
        await h.onMessage(frame('cell-a', 'hello', { versions: [1], driver: 'fake', isolation: 'vm', regions: [], owner: 'kodus' }));
        return { sock, h };
    };
    let cell = await connect();
    const acquire = () =>
        hub.acquire('cell-a', {
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
    const ackAcquire = async () => {
        await tick();
        await tick();
        const req = cell.sock.last('claim.acquire');
        await cell.h.onMessage(frame('cell-a', 'ack', {}, { re: req.id }));
        return req as { claimId: string };
    };
    const ready = (claimId: string) => cell.h.onMessage(frame('cell-a', 'claim.ready', { manifest, observer: { id: 'o', state: 'ready' } }, { claimId }));
    const release = async (claimId: string) => {
        const releasing = hub.release({ claimId, organizationId: 'org-a', runId: 'run-1' });
        await tick();
        await cell.h.onMessage(frame('cell-a', 'ack', {}, { re: cell.sock.last('claim.release').id }));
        await releasing;
    };
    const heartbeat = (claims: string[]) => cell.h.onMessage(frame('cell-a', 'heartbeat', { claims: claims.map((claimId) => ({ claimId, machines: 2 })), freeSlots: 3 }));
    const drop = async () => {
        await cell.h.onClose();
    };
    const reconnect = async () => {
        cell = await connect();
    };
    const heldMinutes = async (claimId: string) => claimHeldMinutes(usageOf((await store.claim(claimId))!), new Date());
    return { hub, store, logs, acquire, ackAcquire, ready, release, heartbeat, drop, reconnect, heldMinutes, cell: () => cell };
}

describe('claim machine time the hub records (cost audit)', () => {
    beforeEach(() => {
        jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
        jest.setSystemTime(T0);
    });
    afterEach(() => jest.useRealTimers());

    it('a claim admitted, ready and released counts from its admission to its release', async () => {
        const t = await harness();
        const pending = t.acquire();
        const req = await t.ackAcquire();
        minutesAfter(2);
        await t.ready(req.claimId);
        await pending;
        minutesAfter(12);
        await t.release(req.claimId);
        expect(await t.heldMinutes(req.claimId)).toBe(12);
    });

    // KNOWN DEFECT (cost-audit): a failed claim is counted until its release (released_at wins), though its cell let go of the machines when the boot failed.
    it.failing('a claim whose boot failed holds no machine time after the failure, even when the worker releases it later', async () => {
        const t = await harness();
        const pending = t.acquire();
        const req = await t.ackAcquire();
        minutesAfter(5);
        await t.cell().h.onMessage(frame('cell-a', 'claim.failed', { kind: 'seed_data', signature: 'migrate_failed', reason: 'exit 1' }, { claimId: req.claimId }));
        await pending;
        // The Run carries on with its other side and releases both at its end.
        minutesAfter(25);
        await t.release(req.claimId);
        expect(await t.heldMinutes(req.claimId)).toBe(5);
    });

    // KNOWN DEFECT (cost-audit): a rebind (same idempotency key after cell_lost) overwrites admitted_at, so the first round's machine time is lost from the cost.
    it.failing('a claim whose cell dropped during the boot and rejoined it counts the machine time from its first admission', async () => {
        const t = await harness();
        const first = t.acquire();
        const req = await t.ackAcquire();
        // The cell drops 10 minutes into the build; it keeps preparing the claim (capacity-wait.ts CELL_LOST_WAIT_MS).
        minutesAfter(10);
        await t.drop();
        expect(await first).toMatchObject({ status: 'blocked', blockers: [{ signature: 'cell_lost' }] });
        // It reconnects a minute later and the worker asks again with the same key: the hub rebinds the round.
        minutesAfter(11);
        await t.reconnect();
        const second = t.acquire();
        const again = await t.ackAcquire();
        expect(again.claimId).toBe(req.claimId);
        minutesAfter(12);
        await t.ready(req.claimId);
        await second;
        minutesAfter(20);
        await t.release(req.claimId);
        expect(await t.heldMinutes(req.claimId)).toBe(20);
    });

    // KNOWN DEFECT (cost-audit): a bound claim its cell no longer lists is only logged (claim.missing_on_cell); its row stays open and counts until the hard ceiling.
    it.failing('a bound claim its cell stopped listing is not counted as holding machines after the cell let it go', async () => {
        const t = await harness();
        const pending = t.acquire();
        const req = await t.ackAcquire();
        minutesAfter(1);
        await t.ready(req.claimId);
        await pending;
        await t.heartbeat([req.claimId]);
        // The cell swept the claim (its lease ran out after a worker crash, or the cell restarted): heartbeats stop listing it.
        minutesAfter(5);
        await t.heartbeat([]);
        minutesAfter(6);
        await t.heartbeat([]);
        expect(t.logs.some((l) => l.msg === 'claim.missing_on_cell')).toBe(true);
        minutesAfter(50);
        expect(await t.heldMinutes(req.claimId)).toBeLessThanOrEqual(6);
    });
});

describe('claim memory the hub meters against what the cell commits (cost audit)', () => {
    // Heartbeat memory as a docker-gvisor cell reports it (agent/memory.go memoryReport): the default size's build and ready MB.
    const heartbeatWith = (t: Awaited<ReturnType<typeof harness>>, memory: { allocatableMb: number; committedMb: number; bootMb: number; readyMb: number }) =>
        t.cell().h.onMessage(frame('cell-a', 'heartbeat', { claims: [], freeSlots: 4, memory }));
    const baseAcquire = (t: Awaited<ReturnType<typeof harness>>) =>
        t.hub.acquire('cell-a', {
            organizationId: 'org-a',
            environmentId: 'shop',
            runId: 'run-9',
            imageId: 'latest',
            ref: { side: 'base', sha: SHA },
            consumer: 'runtime',
            idempotencyKey: 'run-9:base:1',
            expose: [],
            repo: { provider: 'github', fullName: 'acme/shop', apiBase: 'https://api.github.com' },
            repoToken: 'tok',
        });

    // KNOWN DEFECT (cost-audit): the hub meters every Run base side at the ready size from admission; the cell commits its build size unless it takes a pool machine or a local bake (agent/memory.go claimMemoryNeed).
    it.failing("a Run's base side that booted cold is metered at its build size until it is ready, as its cell commits it", async () => {
        const t = await harness();
        await heartbeatWith(t, { allocatableMb: 14_745, committedMb: 0, bootMb: 12_288, readyMb: 2_048 });
        const pending = baseAcquire(t);
        const req = await t.ackAcquire();
        await t.cell().h.onMessage(frame('cell-a', 'claim.ready', { manifest, observer: { id: 'o', state: 'ready' }, start: 'cold' }, { claimId: req.claimId }));
        await pending;
        const row = (await t.store.claim(req.claimId))!;
        expect(row.start).toBe('cold');
        expect(row.metering?.bootMb).toBe(12_288);
    });
});
