import { generateKeyPairSync } from 'crypto';

import type { RedeemResult } from '@libs/runtime/contracts/cell-token';

import { createCa, createCsr } from '../ca/x509';
import type { CellRegistryRepository, RegisteredCell } from '../hub-store';
import { HubMetrics } from '../hub-types';
import { RegistrationRateLimit } from '../http/registration-rate-limit';
import { PublicCellController } from '../http/public-cell.controller';
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
