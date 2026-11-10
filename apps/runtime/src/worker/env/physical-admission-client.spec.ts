import { CellUnavailableError } from '../../shared/errors';
import type { PhysicalAdmissionRequest } from '../../shared/admission/admission-contract';
import { HubPhysicalAdmissionClient } from './physical-admission-client';
const req: PhysicalAdmissionRequest = {
    organizationId: 'org',
    kind: 'setup',
    key: 'key',
    generation: 1,
    ticketOwnerToken: 'owner',
    executionId: 'exec',
    deadlineAt: new Date(120_000).toISOString(),
    members: [{ side: 'setup', idempotencyKey: 'setup:key' }],
};
const ticket: any = {
    ...req,
    ticketId: 'ticket',
    cellId: 'cell',
    sessionEpoch: 'epoch',
    expiresAt: req.deadlineAt,
};
function fixture() {
    const hub = {
        post: jest.fn<Promise<any>, any[]>(),
        replicaForCell: jest.fn(async () => 'http://hub'),
    };
    const directory: any = {
        reserve: jest.fn(async () => ({
            status: 'located',
            cell: {
                cellId: 'cell',
                replicaUrl: 'http://hub',
                sessionEpoch: 'epoch',
            },
        })),
        release: jest.fn(async () => {}),
    };
    return {
        hub,
        directory,
        client: new HubPhysicalAdmissionClient(hub, directory),
    };
}
describe('HubPhysicalAdmissionClient', () => {
    it('never accepts an unknown 2xx cancellation body as cleanup completion', async () => {
        const f = fixture();
        for (const body of [{ status: 'pending' }, { ok: false }, {}, { ok: true, unknown: 'secret' }]) {
            f.hub.post.mockResolvedValue(body);
            await expect(f.client.cancel(ticket)).rejects.toThrow('invalid admission cancellation response');
        }
        f.hub.post.mockResolvedValue({ ok: true });
        await expect(f.client.cancel(ticket)).resolves.toBeUndefined();
    });

    it('posts exact identity and keeps uncertain network reservations', async () => {
        const f = fixture();
        f.hub.post.mockRejectedValue(new CellUnavailableError('lost answer'));
        expect(await f.client.reserve(req)).toEqual({
            status: 'refused',
            reason: 'unavailable',
            retryable: true,
        });
        expect(f.hub.post).toHaveBeenCalledWith(
            'http://hub',
            '/internal/cells/cell/admission/reserve',
            req,
            undefined,
            5_000,
        );
        expect(f.directory.release).not.toHaveBeenCalled();
    });
    it('bounds placement attempts and releases only definite refusals', async () => {
        const f = fixture();
        f.hub.post.mockResolvedValue({
            status: 'refused',
            reason: 'pair_too_large',
            retryable: false,
        });
        expect(await f.client.reserve(req)).toEqual({
            status: 'refused',
            reason: 'no_capacity',
            retryable: true,
        });
        expect(f.hub.post).toHaveBeenCalledTimes(2);
        expect(f.directory.release).toHaveBeenCalledTimes(2);
    });
    it('uses the remaining absolute attempt budget and never opens an expired RPC', async () => {
        const f = fixture(); let now = 0;
        const client = new HubPhysicalAdmissionClient(f.hub, f.directory, () => now);
        f.directory.reserve.mockImplementation(async () => { now = 9_500; return { status: 'located', cell: { cellId: 'cell', replicaUrl: 'http://hub', sessionEpoch: 'epoch' } }; });
        f.hub.post.mockResolvedValue({ status: 'reserved', ticket });
        expect(await client.reserve(req)).toEqual({ status: 'reserved', ticket });
        expect(f.hub.post.mock.calls[0][4]).toBe(500);
        now = 0; f.hub.post.mockClear();
        f.directory.reserve.mockImplementation(async () => { now = 10_000; return { status: 'located', cell: { cellId: 'cell', replicaUrl: 'http://hub', sessionEpoch: 'epoch' } }; });
        expect(await client.reserve(req)).toEqual({ status: 'refused', reason: 'unavailable', retryable: true });
        expect(f.hub.post).not.toHaveBeenCalled(); expect(f.directory.release).not.toHaveBeenCalled();
    });
    it('returns permanent pair refusal only after all eligible cells were examined', async () => {
        const f = fixture(); f.hub.post.mockResolvedValue({ status: 'refused', reason: 'pair_too_large', retryable: false });
        f.directory.reserve.mockResolvedValueOnce({ status: 'located', cell: { cellId: 'cell', replicaUrl: 'http://hub', sessionEpoch: 'epoch' } }).mockResolvedValueOnce({ status: 'refused', reason: 'no_capacity', retryable: true, allCellsTried: true });
        expect(await f.client.reserve(req)).toEqual({ status: 'refused', reason: 'pair_too_large', retryable: false });
    });
    it('fences redemption without a live session and sends immutable refs to retarget/cancel', async () => {
        const f = fixture();
        f.hub.post.mockResolvedValue({ ok: true });
        expect(await f.client.redeem(ticket)).toBe(true);
        expect(
            await f.client.retargetSetup(ticket, 'setup:key:learn-1'),
        ).toEqual({ ok: true });
        expect(f.hub.post).toHaveBeenLastCalledWith(
            'http://hub',
            '/internal/cells/cell/admission/retarget-setup',
            { ticket, idempotencyKey: 'setup:key:learn-1' }, undefined, 5_000,
        );
        await f.client.cancel(ticket);
        f.hub.replicaForCell.mockResolvedValue(null as any);
        expect(await f.client.redeem(ticket)).toBe(false);
        await f.client.cancel(ticket);
        expect(f.directory.release).toHaveBeenCalledWith(ticket);
    });
});
