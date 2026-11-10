import { claimIdFor } from '../../shared/claim-id';
import { isCapacityWait } from '@libs/runtime/environment';
import type { PhysicalAdmissionTicket } from '../../shared/admission-contract';
import { HubClient, HubEnvironmentClient } from './hub-environment-runtime';

const key = 'run-ticket:base:1';
const ticket: PhysicalAdmissionTicket = {
    organizationId: 'org-ticket', kind: 'run', key: 'run-ticket', generation: 0,
    ticketOwnerToken: '11111111-1111-4111-8111-111111111111',
    ticketId: '22222222-2222-4222-8222-222222222222', cellId: 'cell-ticket',
    sessionEpoch: '33333333-3333-4333-8333-333333333333', expiresAt: '2030-01-01T00:01:00Z',
    members: [{ side: 'base', idempotencyKey: key, claimId: claimIdFor('org-ticket', key) }],
};

function fixture() {
    const directory = { reserveCell: jest.fn(async () => ({ cellId: 'wrong', replicaUrl: 'http://wrong', owner: 'kodus' as const })), replicaForClaim: jest.fn(), replicaForCell: jest.fn(async () => 'http://ticket-owner') };
    const post = jest.fn(async (_url: string, _headers: Record<string, string>, _body: string, _timeout: number) => ({ status: 200, text: JSON.stringify({ claimId: ticket.members[0].claimId }) }));
    const open = jest.fn(() => 'synthetic-download-token');
    const hub = new HubClient({ cellDirectory: directory, hubBaseUrl: 'http://hub', postImpl: post });
    const env = new HubEnvironmentClient(hub, { open }, {
        organizationId: 'org-ticket', runId: 'run-ticket', correlationId: 'trace',
        repo: { provider: 'github', fullName: 'synthetic/shop', apiBase: 'https://api.github.com' },
        sealedRepoToken: 'sealed:v1:synthetic', tokenBinding: 'run-ticket', imageId: 'image', expose: [],
        admissionTicket: ticket,
    } as any);
    const request = { organizationId: 'org-ticket', runId: 'run-ticket', environmentId: 'environment', imageId: 'image', ref: { side: 'base' as const, sha: 'a'.repeat(40) }, consumer: 'runtime' as const, idempotencyKey: key };
    return { env, directory, post, open, request };
}

describe('reserved ticket pins the environment client', () => {
    it('records a refused ticket as capacity lost without another cell or token retry', async () => {
        const h = fixture();
        h.post.mockResolvedValueOnce({ status: 409, text: JSON.stringify({ code: 'admission_refused', message: 'ticket expired' }) });
        const outcome = await h.env.acquire(h.request);
        expect(outcome).toMatchObject({ status: 'blocked' });
        expect(h.post).toHaveBeenCalledTimes(1);
        expect(h.directory.reserveCell).not.toHaveBeenCalled();
    });

    it('cannot turn expired admission into a PR boot regression', async () => {
        const h = fixture();
        h.post.mockResolvedValueOnce({ status: 200, text: JSON.stringify({ status: 'blocked', blockers: [{ kind: 'platform', signature: 'admission_ticket_invalid', message: 'expired' }] }) });
        expect(isCapacityWait(await h.env.acquire(h.request))).toBe(true);
        expect(h.post).toHaveBeenCalledTimes(1);
    });

    it('retargets a setup child before opening credentials without reserving another slot', async () => {
        const h = fixture();
        const setupTicket: PhysicalAdmissionTicket = { ...ticket, kind: 'setup', key: 'setup-key', members: [{ side: 'setup', idempotencyKey: 'setup:setup-key', claimId: claimIdFor(ticket.organizationId, 'setup:setup-key') }] };
        const env = new HubEnvironmentClient(new HubClient({ cellDirectory: h.directory, hubBaseUrl: 'http://hub', postImpl: h.post }), { open: h.open }, {
            organizationId: ticket.organizationId, correlationId: 'trace', sealedRepoToken: 'sealed:v1:synthetic', tokenBinding: 'setup-key', expose: [], admissionTicket: setupTicket,
        } as any);
        h.post.mockImplementationOnce(async (_url, _headers, _body, timeout) => {
            expect(h.open).not.toHaveBeenCalled();
            expect(timeout).toBeLessThanOrEqual(5000);
            return { status: 200, text: '{"ok":true}' };
        });
        await env.acquire({ ...h.request, runId: undefined, consumer: 'setup', ref: { side: 'setup', sha: 'a'.repeat(40) }, idempotencyKey: 'setup:setup-key:learn-1' });
        expect(h.post.mock.calls[0][0]).toMatch(/retarget-setup$/);
        expect(h.post.mock.calls[1][0]).toMatch(/acquire$/);
        expect(h.open).toHaveBeenCalledTimes(1);
        expect(h.directory.reserveCell).not.toHaveBeenCalled();
    });

    it('does not acquire or open credentials when setup retarget ownership is lost', async () => {
        const h = fixture();
        const env = new HubEnvironmentClient(new HubClient({ cellDirectory: h.directory, hubBaseUrl: 'http://hub', postImpl: h.post }), { open: h.open }, {
            organizationId: ticket.organizationId, sealedRepoToken: 'sealed:v1:synthetic', admissionTicket: { ...ticket, kind: 'setup', key: 'setup-key' },
        } as any);
        h.post.mockResolvedValueOnce({ status: 200, text: '{"ok":false,"reason":"owner_changed"}' });
        expect(isCapacityWait(await env.acquire({ ...h.request, runId: undefined, consumer: 'setup', ref: { side: 'setup', sha: 'a'.repeat(40) }, idempotencyKey: 'setup:setup-key:learn-1' }))).toBe(true);
        expect(h.post).toHaveBeenCalledTimes(1);
        expect(h.open).not.toHaveBeenCalled();
        expect(h.directory.reserveCell).not.toHaveBeenCalled();
    });

    it('uses the ticket cell without taking a second directory slot and passes the ticket only to the hub', async () => {
        const h = fixture();
        await h.env.acquire(h.request);
        expect(h.directory.reserveCell).not.toHaveBeenCalled();
        expect(h.post.mock.calls[0][0]).toBe('http://ticket-owner/internal/cells/cell-ticket/acquire');
        expect(JSON.parse(h.post.mock.calls[0][2])).toMatchObject({ admission: ticket, idempotencyKey: key });
    });

    it('refuses a different tenant or member before opening a download token', async () => {
        const h = fixture();
        await expect(h.env.acquire({ ...h.request, organizationId: 'foreign' })).rejects.toThrow(/admission/i);
        await expect(h.env.acquire({ ...h.request, idempotencyKey: 'run-ticket:base:2' })).rejects.toThrow(/admission/i);
        expect(h.open).not.toHaveBeenCalled();
        expect(h.post).not.toHaveBeenCalled();
        expect(h.directory.reserveCell).not.toHaveBeenCalled();
    });
});
