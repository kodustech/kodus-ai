import { MemberCleanupPendingError } from '../../shared/errors';
import { HttpException } from '@nestjs/common';

import { CellUnavailableError, ClaimScopeError } from '../hub-types';
import { InternalController } from './internal.controller';
import { PublicCellController } from './public-cell.controller';

const probe = { id: 'p1', origin: 'agent', purpose: 'x', expected: '400', compare: ['status'], spec: { kind: 'http', target: { service: 'web', port: 3000 }, method: 'GET', path: '/', timeoutMs: 1_000 } };
const STEP = '6f1d1b9a-6b1e-4f6a-9d7e-2f0a6b4c8d10';

const status = async (p: Promise<unknown>) => {
    try {
        await p;
        return 200;
    } catch (e) {
        return e instanceof HttpException ? e.getStatus() : 500;
    }
};

describe('hub HTTP', () => {
    it('the public health says nothing about connected cells; the internal one does', () => {
        const hub = { sessionsHeld: () => ['cell-a', 'cell-b'] } as any;
        expect(new PublicCellController(hub).health()).toEqual({ ok: true });
        expect(new InternalController(hub).health()).toEqual({ ok: true, cells: ['cell-a', 'cell-b'] });
    });

    it('validates physical ticket bodies and rejects cross-cell redemption before the service', async () => {
        const ticket = {
            organizationId: 'org',
            kind: 'setup',
            key: 'key',
            generation: 1,
            ticketOwnerToken: STEP,
            ticketId: STEP,
            cellId: 'cell',
            sessionEpoch: STEP,
            expiresAt: '2030-01-01T00:00:00.000Z',
            members: [
                {
                    side: 'setup',
                    idempotencyKey: 'setup:key',
                    claimId: 'claim',
                },
            ],
        };
        const tickets = {
            redeem: jest.fn(async () => true),
            cancel: jest.fn(async () => {}),
            retargetSetup: jest.fn(async () => ({ ok: true })),
            reserve: jest.fn(async () => ({ status: 'reserved', ticket })),
        };
        const c = new InternalController({ tickets } as any);
        expect(
            await status(c.admissionRedeem('cell', { ...ticket, extra: true })),
        ).toBe(400);
        expect(await c.admissionRedeem('other', ticket)).toEqual({ ok: false });
        expect(tickets.redeem).not.toHaveBeenCalled();
        expect(await c.admissionRedeem('cell', ticket)).toEqual({ ok: true });
        expect(
            await c.admissionRetargetSetup('cell', {
                ticket,
                idempotencyKey: 'setup:key:learn-1',
            }),
        ).toEqual({ ok: true });
        expect(tickets.retargetSetup).toHaveBeenCalledWith(
            ticket,
            'setup:key:learn-1',
        );
        await c.admissionCancel('other', ticket);
        expect(tickets.cancel).not.toHaveBeenCalled();
        await c.admissionCancel('cell', ticket);
        expect(tickets.cancel).toHaveBeenCalledWith(ticket);
        expect(
            await status(c.admissionReserve('cell', { organizationId: 'org' })),
        ).toBe(400);
    });

    it('keeps cleanup pending on 503 with a fixed typed code for old workers', async () => {
        const tickets = { cancel: jest.fn(async () => { throw new MemberCleanupPendingError(); }) };
        const c = new InternalController({ tickets } as any);
        const ticket = { organizationId: 'org', kind: 'run', key: 'run', generation: 0, ticketOwnerToken: STEP, ticketId: STEP, cellId: 'cell', sessionEpoch: STEP, expiresAt: '2030-01-01T00:00:00.000Z', members: [{ side: 'base', idempotencyKey: 'key', claimId: 'claim' }] };
        const error = await c.admissionCancel('cell', ticket).catch(e => e);
        expect(error.getStatus()).toBe(503);
        expect(error.getResponse()).toEqual({ code: 'member_cleanup_pending', message: 'member_cleanup_pending' });
    });

    it('every claim route requires the tenant and passes it to the hub', async () => {
        const seen: unknown[] = [];
        const hub = { probe: async (ref: unknown) => (seen.push(ref), { code: 'lease_expired' }), release: async (ref: unknown) => void seen.push(ref) } as any;
        const c = new InternalController(hub);
        expect(await status(c.probe('c1', { probe, stepId: STEP }))).toBe(400);
        expect(await status(c.release('c1', {}))).toBe(400);
        await c.probe('c1', { organizationId: 'org-a', runId: 'run-1', probe, stepId: STEP });
        await c.release('c2', { organizationId: 'org-a', runId: null });
        expect(seen).toEqual([
            { claimId: 'c1', organizationId: 'org-a', runId: 'run-1' },
            { claimId: 'c2', organizationId: 'org-a', runId: null },
        ]);
    });

    // The worker sends the tenant on every claim call, the setup's bake too
    // (runId null): a bake route that refused it failed every setup's bake.
    it('the bake takes the tenant the worker sends, and only the bake fields go to the hub', async () => {
        const seen: unknown[] = [];
        const c = new InternalController({ bake: async (req: unknown) => (seen.push(req), { status: 'accepted' }) } as any);
        const body = { organizationId: 'org-a', runId: null, environmentId: 'env-1', recipeSha: 'sha256:abc', sha: 'a'.repeat(40) };
        expect(await c.bake('c1', body)).toEqual({ status: 'accepted' });
        expect(seen).toEqual([{ organizationId: 'org-a', environmentId: 'env-1', recipeSha: 'sha256:abc', sha: 'a'.repeat(40), claimId: 'c1' }]);
        expect(await status(c.bake('c1', { ...body, extra: 1 }))).toBe(400);
    });

    // The worker sends the environment's machine size with the pool: a strict body that refused it failed every sized pool.
    it('the pool target takes the environment machine size and refuses a malformed one', async () => {
        const seen: unknown[] = [];
        const c = new InternalController({ poolTarget: async (_cell: string, req: unknown) => (seen.push(req), { status: 'accepted' }) } as any);
        const body = { organizationId: 'org-a', environmentId: 'env-1', imageId: 'latest', size: 2, machineSize: { memoryMb: 16_384, cpus: 8 } };
        expect(await c.poolTarget('cell-a', body)).toEqual({ status: 'accepted' });
        expect(seen).toEqual([body]);
        expect(await status(c.poolTarget('cell-a', { ...body, machineSize: { memoryMb: 16_384 } }))).toBe(400);
    });

    it('the acquire takes the environment machine size and refuses one out of bounds', async () => {
        const seen: any[] = [];
        const c = new InternalController({ acquire: async (_cell: string, req: unknown) => (seen.push(req), { status: 'blocked', blockers: [] }) } as any);
        const body = {
            organizationId: 'org-a',
            environmentId: 'env-1',
            ref: { side: 'setup', sha: 'a'.repeat(40) },
            consumer: 'setup',
            idempotencyKey: 'setup:1',
            expose: [],
            repo: { provider: 'github', fullName: 'acme/shop', apiBase: 'https://api.github.com' },
            repoToken: 'tok',
        };
        await c.acquire('cell-a', { ...body, size: { memoryMb: 16_384, cpus: 8 } });
        await c.acquire('cell-a', body);
        expect(seen[0].size).toEqual({ memoryMb: 16_384, cpus: 8 });
        expect(seen[1].size).toBeUndefined();
        for (const size of [{ memoryMb: 0, cpus: 2 }, { memoryMb: 4_096, cpus: 1.5 }, { memoryMb: 4_096 }, { memoryMb: 4_096, cpus: 2, diskGb: 40 }]) {
            expect(await status(c.acquire('cell-a', { ...body, size }))).toBe(400);
        }
        expect(seen).toHaveLength(2);
    });

    it('a claim of another tenant is 404 and a cell out of reach is 503', async () => {
        const c = new InternalController({
            probe: async () => Promise.reject(new ClaimScopeError('x')),
            release: async () => Promise.reject(new CellUnavailableError('cell-a')),
        } as any);
        expect(await status(c.probe('c1', { organizationId: 'org-b', probe, stepId: STEP }))).toBe(404);
        expect(await status(c.release('c1', { organizationId: 'org-a' }))).toBe(503);
    });

    it('the renew route takes the tenant and the consumer, and maps scope and reach like every claim route', async () => {
        const seen: unknown[] = [];
        const c = new InternalController({ renewLease: async (ref: unknown, consumer: string) => (seen.push([ref, consumer]), { status: 'gone' }) } as any);
        expect(await c.renew('c1', { organizationId: 'org-a', runId: 'run-1', consumer: 'runtime' })).toEqual({ status: 'gone' });
        expect(seen).toEqual([[{ claimId: 'c1', organizationId: 'org-a', runId: 'run-1' }, 'runtime']]);
        expect(await status(c.renew('c1', { organizationId: 'org-a' }))).toBe(400);
        expect(await status(c.renew('c1', { organizationId: 'org-a', consumer: 'forever' }))).toBe(400);
        expect(await status(c.renew('c1', { organizationId: 'org-a', consumer: 'runtime', leaseExpiresAt: '2099-01-01T00:00:00Z' }))).toBe(400);
        const refused = new InternalController({ renewLease: async () => Promise.reject(new ClaimScopeError('x')) } as any);
        expect(await status(refused.renew('c1', { organizationId: 'org-b', consumer: 'runtime' }))).toBe(404);
        const lost = new InternalController({ renewLease: async () => Promise.reject(new CellUnavailableError('cell-a')) } as any);
        expect(await status(lost.renew('c1', { organizationId: 'org-a', consumer: 'runtime' }))).toBe(503);
    });
});
