import { randomUUID } from 'crypto';

import { type Consumer, HARD_EXPIRY_MINUTES, LEASE_TTL_MINUTES } from '@libs/runtime/environment';
import { decodeFrame, PROTOCOL_VERSION } from '@libs/runtime/protocol';
import { InMemoryRunStreamStore } from '@libs/runtime/run/testing';
import { RuntimeMetrics } from '@libs/runtime/telemetry';

import { createCa } from '../ca/x509';
import { CellHub, CellUnavailableError, ClaimScopeError, HubLogLine } from '../cell-hub';
import { InMemoryHubStore } from '../hub-store';
import { claimIdFor } from './claim.service';

// claim.renew on the hub, and the boot timing a claim.ready carries into the
// hub's metrics. Driven through the real CellHub with a socket double.

class Sock {
    sent: any[] = [];
    send(d: string) {
        const r = decodeFrame(d);
        if ('code' in r) throw new Error(`hub sent an invalid frame: ${r.code}`);
        this.sent.push(r.message);
    }
    close() {}
    last(type: string) {
        return [...this.sent].reverse().find((m) => m.type === type);
    }
    all(type: string) {
        return this.sent.filter((m) => m.type === type);
    }
}

const SHA = 'a'.repeat(40);
const CA = createCa('lease CA');
const MIN = 60_000;
const tick = () => new Promise((r) => setImmediate(r));
const frame = (cellId: string, type: string, body: unknown, extra: Record<string, unknown> = {}) => JSON.stringify({ v: PROTOCOL_VERSION, id: randomUUID(), cellId, type, body, ...extra });
const manifest = { services: [{ name: 'web', health: 'ok' }], expose: [{ service: 'web', port: 3000, kind: 'http' }], imageId: 'img-1', seedSha: 'seed-1' };

async function harness(driver = 'docker-gvisor') {
    let clock = Date.parse('2026-11-06T10:00:00.000Z');
    const store = new InMemoryHubStore();
    const logs: HubLogLine[] = [];
    const hub = new CellHub(store, new InMemoryRunStreamStore(), new RuntimeMetrics(), {
        replicaId: 'r1',
        replicaUrl: 'http://hub',
        ca: CA,
        log: (l) => void logs.push(l),
        now: () => new Date(clock),
    });
    const sock = new Sock();
    const h = hub.attach(sock, { cellId: 'cell-a', owner: 'kodus' });
    await h.onMessage(frame('cell-a', 'hello', { versions: [1], driver, isolation: 'vm', regions: [], owner: 'kodus' }));
    const claimId = claimIdFor('org-a', 'run-1:base:1');
    /** A Run's base claim, bound with this claim.ready timing. */
    const bind = async (timing?: Record<string, number>) => {
        const acquired = hub.acquire('cell-a', {
            organizationId: 'org-a',
            environmentId: 'shop',
            runId: 'run-1',
            imageId: 'img-1',
            ref: { side: 'base', sha: SHA },
            consumer: 'runtime',
            idempotencyKey: 'run-1:base:1',
            expose: [],
            repo: { provider: 'github', fullName: 'acme/shop', apiBase: 'https://api.github.com' },
            repoToken: 'tok',
        });
        await tick();
        await tick();
        await h.onMessage(frame('cell-a', 'ack', {}, { re: sock.last('claim.acquire').id }));
        await h.onMessage(frame('cell-a', 'claim.ready', { manifest, observer: { id: 'o', state: 'ready' }, ...(timing ? { timing } : {}) }, { claimId }));
        return acquired;
    };
    /** Renews, answering the claim.renew frame with `reply` (ack, or a nack code). */
    const renew = async (reply: 'ack' | string = 'ack', ref = { claimId, organizationId: 'org-a', runId: 'run-1' as string | null }, consumer: Consumer = 'runtime') => {
        const before = sock.all('claim.renew').length;
        const p = hub.renewLease(ref, consumer);
        await tick();
        await tick();
        const sent = sock.all('claim.renew');
        if (sent.length > before) {
            const req = sent[sent.length - 1];
            await h.onMessage(reply === 'ack' ? frame('cell-a', 'ack', {}, { re: req.id }) : frame('cell-a', 'nack', { code: reply, message: 'x' }, { re: req.id }));
        }
        return p;
    };
    return { hub, store, sock, h, logs, claimId, bind, renew, advance: (ms: number) => void (clock += ms), now: () => clock };
}

describe('claim.renew on the hub', () => {
    it('moves the lease a TTL from now, tells the cell, and records it', async () => {
        const t = await harness();
        await t.bind();
        const hard = t.store.claims.get(t.claimId)!.hardExpiresAt;
        t.advance(5 * MIN);
        const r = await t.renew();
        const want = new Date(t.now() + LEASE_TTL_MINUTES.runtime * MIN).toISOString();
        expect(r).toEqual({ status: 'renewed', leaseExpiresAt: want, hardExpiresAt: hard, atCeiling: false });
        const sent = t.sock.last('claim.renew');
        expect(sent).toMatchObject({ claimId: t.claimId, body: { leaseExpiresAt: want } });
        expect(t.store.claims.get(t.claimId)!.leaseExpiresAt).toBe(want);
    });

    // It used to take the TTL from the consumer the caller named: a Run's
    // claim renewed as `mcp` got 120 minutes instead of the runtime's 45.
    it('takes the TTL from the consumer the claim was acquired for, not the one the caller names', async () => {
        const t = await harness();
        const renewals = jest.spyOn(t.hub.hubMetrics, 'claimRenew');
        await t.bind();
        expect(t.store.claims.get(t.claimId)!.consumer).toBe('runtime');
        const r = await t.renew('ack', undefined, 'mcp');
        const want = new Date(t.now() + LEASE_TTL_MINUTES.runtime * MIN).toISOString();
        expect(LEASE_TTL_MINUTES.mcp).toBeGreaterThan(LEASE_TTL_MINUTES.runtime);
        expect(r).toMatchObject({ status: 'renewed', leaseExpiresAt: want });
        expect(renewals).toHaveBeenCalledWith({ outcome: 'renewed', consumer: 'runtime' });
        expect(t.logs.some((l) => l.msg === 'claim.renew.consumer_mismatch')).toBe(true);
    });

    it('falls back to the caller’s consumer for a row from before the consumer was recorded', async () => {
        const t = await harness();
        await t.bind();
        t.store.claims.get(t.claimId)!.consumer = null;
        const r = await t.renew('ack', undefined, 'custom_agent');
        expect(r).toMatchObject({ status: 'renewed', leaseExpiresAt: new Date(t.now() + LEASE_TTL_MINUTES.custom_agent * MIN).toISOString() });
    });

    // It used to renew a compromised claim like a bound one, so whatever
    // tripped the violation could keep its machines up to the ceiling.
    it('is gone for a compromised claim, without a frame to the cell', async () => {
        const t = await harness();
        await t.bind();
        expect(await t.store.transitionClaim(t.claimId, ['bound'], 'compromised', { reason: 'security_violation', detail: 'bait_exfiltration' })).toBe(true);
        const lease = t.store.claims.get(t.claimId)!.leaseExpiresAt;
        t.advance(MIN);
        expect(await t.renew()).toEqual({ status: 'gone' });
        expect(t.sock.all('claim.renew')).toHaveLength(0);
        expect(t.store.claims.get(t.claimId)!.leaseExpiresAt).toBe(lease);
    });

    it('never asks for a lease past the hard ceiling', async () => {
        const t = await harness();
        await t.bind();
        const hard = t.store.claims.get(t.claimId)!.hardExpiresAt;
        expect(Date.parse(hard)).toBe(t.now() + HARD_EXPIRY_MINUTES.runtime * MIN);
        t.advance(30 * MIN); // now + 45 min would be 15 past the 60-minute ceiling
        const r = await t.renew();
        expect(r).toEqual({ status: 'renewed', leaseExpiresAt: hard, hardExpiresAt: hard, atCeiling: true });
        expect(t.sock.last('claim.renew').body.leaseExpiresAt).toBe(hard);
        expect(t.store.claims.get(t.claimId)!.leaseExpiresAt).toBe(hard);
    });

    it('is gone past the hard ceiling, without a frame to the cell', async () => {
        const t = await harness();
        await t.bind();
        t.advance(HARD_EXPIRY_MINUTES.runtime * MIN);
        expect(await t.renew()).toEqual({ status: 'gone' });
        expect(t.sock.all('claim.renew')).toHaveLength(0);
    });

    it('is gone once the claim was released, and never revives it', async () => {
        const t = await harness();
        await t.bind();
        const released = t.hub.release({ claimId: t.claimId, organizationId: 'org-a', runId: 'run-1' });
        await tick();
        await tick();
        await t.h.onMessage(frame('cell-a', 'ack', {}, { re: t.sock.last('claim.release').id }));
        await released;
        expect(await t.renew()).toEqual({ status: 'gone' });
        expect(t.sock.all('claim.renew')).toHaveLength(0);
        expect(t.store.claims.get(t.claimId)!.state).toBe('released');
    });

    it('is gone when the cell no longer knows the claim (its machines are gone)', async () => {
        const t = await harness();
        await t.bind();
        const lease = t.store.claims.get(t.claimId)!.leaseExpiresAt;
        expect(await t.renew('unknown_claim')).toEqual({ status: 'gone' });
        expect(t.store.claims.get(t.claimId)!.leaseExpiresAt).toBe(lease);
    });

    it('a cell that did not move the lease is a retryable CellUnavailableError, the lease untouched', async () => {
        const t = await harness();
        await t.bind();
        const lease = t.store.claims.get(t.claimId)!.leaseExpiresAt;
        t.advance(MIN);
        await expect(t.renew('renew_failed')).rejects.toBeInstanceOf(CellUnavailableError);
        expect(t.store.claims.get(t.claimId)!.leaseExpiresAt).toBe(lease);
    });

    it('a lost cell is a CellUnavailableError, not a crash', async () => {
        const t = await harness();
        await t.bind();
        await t.h.onClose();
        await expect(t.hub.renewLease({ claimId: t.claimId, organizationId: 'org-a', runId: 'run-1' }, 'runtime')).rejects.toBeInstanceOf(CellUnavailableError);
    });

    it('refuses a claim named by another tenant', async () => {
        const t = await harness();
        await t.bind();
        await expect(t.hub.renewLease({ claimId: t.claimId, organizationId: 'org-b', runId: 'run-1' }, 'runtime')).rejects.toBeInstanceOf(ClaimScopeError);
        await expect(t.hub.renewLease({ claimId: t.claimId, organizationId: 'org-a', runId: 'run-2' }, 'runtime')).rejects.toBeInstanceOf(ClaimScopeError);
        expect(t.sock.all('claim.renew')).toHaveLength(0);
    });
});

describe('claim.ready timing in the hub metrics', () => {
    it('records each phase the cell measured, by consumer and driver', async () => {
        const t = await harness('docker-gvisor');
        const phases = jest.spyOn(t.hub.hubMetrics, 'claimBootPhases');
        const wait = jest.spyOn(t.hub.hubMetrics, 'claimReadyWait');
        const timing = { prepareMs: 9_000, bootMs: 8_000, buildMs: 5_000, upMs: 3_000 };
        const claim = await t.bind(timing);
        expect(claim).toMatchObject({ timing });
        expect(phases).toHaveBeenCalledWith(timing, { consumer: 'runtime', driver: 'docker-gvisor' });
        expect(wait).toHaveBeenCalledWith(expect.any(Number), { outcome: 'ready', consumer: 'runtime', driver: 'docker-gvisor' });
    });
});

describe('the hub store’s renewed lease', () => {
    const row = { claimId: 'c1', cellId: 'cell-a', orgId: 'org-a', side: 'base', state: 'bound' as const, leaseExpiresAt: '2026-11-06T10:45:00.000Z', hardExpiresAt: '2026-11-06T11:00:00.000Z' };

    it('moves forward only, never past hard_expires_at', async () => {
        const store = new InMemoryHubStore();
        await store.insertClaim(row);
        expect(await store.renewClaimLease('c1', '2026-11-06T10:30:00.000Z', ['bound'])).toBe(false);
        expect(store.claims.get('c1')!.leaseExpiresAt).toBe(row.leaseExpiresAt);
        expect(await store.renewClaimLease('c1', '2026-11-06T12:00:00.000Z', ['bound'])).toBe(true);
        expect(store.claims.get('c1')!.leaseExpiresAt).toBe(row.hardExpiresAt);
        expect(await store.renewClaimLease('c1', '2026-11-06T12:30:00.000Z', ['bound'])).toBe(false);
    });

    it('only in the states it is given: a claim released meanwhile keeps its lease', async () => {
        const store = new InMemoryHubStore();
        await store.insertClaim(row);
        await store.transitionClaim('c1', ['bound'], 'released', { reason: 'released' });
        expect(await store.renewClaimLease('c1', '2026-11-06T10:55:00.000Z', ['bound', 'compromised'])).toBe(false);
        expect(store.claims.get('c1')!.leaseExpiresAt).toBe(row.leaseExpiresAt);
        expect(await store.renewClaimLease('unknown', '2026-11-06T10:55:00.000Z', ['bound'])).toBe(false);
    });
});
