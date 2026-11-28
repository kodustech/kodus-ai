import { generateKeyPairSync } from 'crypto';

import type { RedeemResult } from '@libs/runtime/contracts/cell-token';
import { FleetTokenLedger, generateFleetToken } from '@libs/runtime/contracts/fleet-token';
import { InMemoryFleetTokenStore } from '@libs/runtime/contracts/testing';

import { createCa, createCsr } from '../ca/x509';
import type { CellRegistryRepository, RegisteredCell } from '../hub-store';
import { HubMetrics } from '../hub-types';
import { RegistrationRateLimit } from '../http/registration-rate-limit';
import { PublicCellController } from '../http/public-cell.controller';
import { InMemoryHubStore } from '../testing';
import { CellIdentityService, INVALID_CSR } from './cell-identity.service';

const CA = createCa('spec CA');

/** A registry whose redemption is one transaction, as the Postgres one is: a throwing callback keeps the token. */
function transactionalRegistry(tokens: Record<string, RedeemResult>) {
    const spent = new Set<string>();
    const cells: RegisteredCell[] = [];
    const callbacks: string[] = [];
    const registry = {
        async redeemAndRegister(token: string, _topology: string, cell: (r: { organizationId: string; topology: string }) => RegisteredCell): Promise<RedeemResult> {
            const r: RedeemResult = spent.has(token) ? { ok: false, reason: 'unknown_or_used' } : (tokens[token] ?? { ok: false, reason: 'unknown_or_used' });
            if (!r.ok) return r;
            callbacks.push(token);
            const row = cell(r); // a throw here rolls back: the token stays unspent
            spent.add(token);
            cells.push(row);
            return r;
        },
    } as unknown as CellRegistryRepository;
    return { registry, spent, cells, callbacks };
}

const service = (registry: CellRegistryRepository) => new CellIdentityService(registry, CA, new HubMetrics(), () => undefined, () => new Date());

describe('cell registration', () => {
    const good: RedeemResult = { ok: true, organizationId: 'org-a', topology: 'hybrid' };

    it('checks the token before it reads the CSR: a refused token never reaches the parser or the CA key', async () => {
        const t = transactionalRegistry({});
        expect(await service(t.registry).register('kcr_unknown', 'hybrid', 'not a csr')).toEqual({ ok: false, reason: 'unknown_or_used' });
        expect(t.callbacks).toEqual([]);
    });

    it("answers a bad CSR with one generic reason, never the parser's words, and keeps the token", async () => {
        const t = transactionalRegistry({ kcr_good: good });
        const id = service(t.registry);
        const bad = await id.register('kcr_good', 'hybrid', '-----BEGIN CERTIFICATE REQUEST-----\nAAAA\n-----END CERTIFICATE REQUEST-----');
        expect(bad).toEqual({ ok: false, reason: INVALID_CSR });
        expect(t.spent.has('kcr_good')).toBe(false);

        const key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey;
        expect(await id.register('kcr_good', 'hybrid', createCsr(key))).toMatchObject({ ok: true });
        expect(t.cells).toHaveLength(1);
    });

    it('a renewal refuses a bad CSR with the same generic reason', async () => {
        const id = service(transactionalRegistry({}).registry);
        expect(await id.renew({ cellId: 'cell-a', owner: 'customer' }, 'not a csr')).toEqual({ ok: false, reason: INVALID_CSR });
    });
});

describe('registration rate limit', () => {
    it('lets each address try a few times per window, then again once the window passes', () => {
        const limit = new RegistrationRateLimit(2, 1_000);
        expect([limit.allow('a', 0), limit.allow('a', 10), limit.allow('a', 20)]).toEqual([true, true, false]);
        expect(limit.allow('b', 20)).toBe(true);
        expect(limit.allow('a', 1_000)).toBe(true);
    });

    it('the public route answers 429 past the limit, before the hub is asked', async () => {
        const hub = { register: jest.fn(async () => ({ ok: false, reason: 'unknown_or_used' })) };
        const c = new PublicCellController(hub as any);
        const body = { token: 'kcr_x', topology: 'hybrid', csr: 'x'.repeat(64) };
        const req = { socket: { remoteAddress: '203.0.113.7' } };
        const statuses: number[] = [];
        for (let i = 0; i < 12; i++) {
            statuses.push(await c.register(req, body).then(() => 200, (e) => e.getStatus()));
        }
        expect(statuses.slice(0, 10).every((s) => s === 403)).toBe(true);
        expect(statuses.slice(10)).toEqual([429, 429]);
        expect(hub.register).toHaveBeenCalledTimes(10);
    });
});

// docs/runtime/host-providers.md §8.1, F-02 and F-03.
describe('fleet host registration', () => {
    const csr = () => createCsr(generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey);

    it("a fleet token registers a Kodus cell of the token's pool and host, bound to its Run, never to an org", async () => {
        const store = new InMemoryHubStore({ fleetLedger: new FleetTokenLedger(new InMemoryFleetTokenStore()) });
        const { token, tokenHash } = generateFleetToken();
        await store.fleetLedger.issue({ tokenHash, poolId: 'boat-eu-perrun', hostId: 'host-1', boundKey: 'run:org-a/r-1', ttlMs: 600_000, issuedBy: 'runtime-fleet' });
        const r = await service(store).register(token, undefined, csr());
        expect(r).toMatchObject({ ok: true, boundKey: 'run:org-a/r-1' });
        const cell = await store.registeredCell((r as { cellId: string }).cellId);
        expect(cell).toMatchObject({ owner: 'kodus', organizationId: null, topology: 'fleet', poolId: 'boat-eu-perrun', hostId: 'host-1', boundKey: 'run:org-a/r-1' });
        expect(await service(store).register(token, undefined, csr())).toEqual({ ok: false, reason: 'unknown_or_used' });
    });

    it('a fleet token that names an org topology is refused, and so is a kcr_ token naming the fleet one', async () => {
        const store = new InMemoryHubStore({ fleetLedger: new FleetTokenLedger(new InMemoryFleetTokenStore()) });
        const { token, tokenHash } = generateFleetToken();
        await store.fleetLedger.issue({ tokenHash, poolId: 'boat-eu-perrun', hostId: 'host-2', boundKey: null, ttlMs: 600_000, issuedBy: 'runtime-fleet' });
        expect(await service(store).register(token, 'hybrid', csr())).toEqual({ ok: false, reason: 'topology_mismatch' });
        expect(await service(store).register('kcr_whatever', 'fleet', csr())).toEqual({ ok: false, reason: 'topology_mismatch' });
    });
});

describe('certificate pins', () => {
    const peer = (serial: string) => ({ presented: true, authorized: true, role: 'cell' as const, cn: 'cell-a', serial });
    const registryOf = (rows: Array<{ cellId: string; serial: string | null; status: string }>) => ({ cellPins: async () => rows }) as unknown as CellRegistryRepository;

    it('refuses a revoked serial while the store lists its cell, and keeps only what the store lists now', async () => {
        const rows = [{ cellId: 'cell-a', serial: 'AA', status: 'revoked' }];
        const id = service(registryOf(rows));
        await id.reloadCertificatePins();
        expect(id.handshakeAllowed(peer('AA'))).toBe(false);
        // Its certificate expired: the store stops listing it, and the TLS handshake itself refuses an expired
        // certificate (authorized false), so the replica no longer holds an entry for it.
        rows.length = 0;
        await id.reloadCertificatePins();
        expect(id.handshakeAllowed(peer('AA'))).toBe(true);
        expect(id.handshakeAllowed({ ...peer('AA'), authorized: false })).toBe(false);
    });

    it('re-pins a cell from the newest listing, and a cell the store no longer lists has no pin', async () => {
        const rows = [{ cellId: 'cell-a', serial: 'BB', status: 'connected' }];
        const id = service(registryOf(rows));
        await id.reloadCertificatePins();
        expect(id.handshakeAllowed(peer('CC'))).toBe(false);
        rows[0] = { cellId: 'cell-a', serial: 'CC', status: 'connected' };
        await id.reloadCertificatePins();
        expect([id.handshakeAllowed(peer('BB')), id.handshakeAllowed(peer('CC'))]).toEqual([false, true]);
    });
});
