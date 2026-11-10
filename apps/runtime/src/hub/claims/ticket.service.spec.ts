import { claimIdFor } from '../../shared/claim-id';
import type {
    PhysicalAdmissionRequest,
    PhysicalAdmissionTicket,
} from '../../shared/admission/admission-contract';
import { CellMemoryBook } from './cell-memory';
import { TicketService } from './ticket.service';
import { PhysicalAdmissionRequestSchema } from '../http/admission.schema';

const identity = {
    organizationId: 'org',
    kind: 'run' as const,
    key: 'run',
    generation: 1,
    ticketOwnerToken: 'owner',
};
const request: PhysicalAdmissionRequest = {
    ...identity,
    executionId: 'execute',
    deadlineAt: new Date(60_000).toISOString(),
    members: [
        { side: 'base', idempotencyKey: 'run:base:1' },
        { side: 'pr', idempotencyKey: 'run:pr:1' },
    ],
};
function fixture() {
    let now = 1_000;
    let conn: any = { sessionEpoch: 'epoch' };
    const row: any = {
        ...identity,
        executionId: 'execute',
        deadlineAt: request.deadlineAt,
        state: 'reserved',
        payload: {
            kind: 'run',
            request: { runId: 'run', attempt: 1, environment: { environmentId: 'env', imageId: 'image' }, pullRequest: { baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40) } },
        },
        ticket: null,
    };
    const ownership = {
        owns: jest.fn(async (_: unknown) => true),
        get: jest.fn(async (_: unknown) => row),
    };
    const directory = {
        matches: jest.fn(async () => true),
        pin: jest.fn(async () => true),
        release: jest.fn(async () => {}),
        retarget: jest.fn(async () => true),
        reserve: jest.fn(),
    };
    const releaseClaim = jest.fn(async (_: unknown) => {});
    const book = new CellMemoryBook();
    book.reset('cell', 'epoch');
    book.report(
        'cell',
        {
            allocatableMb: 32_768,
            committedMb: 0,
            bootMb: 12_288,
            readyMb: 2_048,
        },
        [],
        now,
        4,
        'epoch',
    );
    const session: any = {
        sessionEpoch: 'epoch',
        replicaId: 'replica',
        owner: 'kodus',
        driver: 'docker-gvisor',
        isolation: 'gvisor',
    };
    const service = new TicketService(
        book,
        { get: () => conn } as any,
        { session: async () => session } as any,
        { replicaId: 'replica', ownership, directory, releaseClaim, now: () => now },
    );
    const reserve = async () => {
        const r = await service.reserve('cell', request);
        if (r.status !== 'reserved') throw new Error(JSON.stringify(r));
        return r.ticket;
    };
    return {
        service,
        book,
        row,
        session,
        ownership,
        directory,
        releaseClaim,
        reserve,
        setConn: (c: any) => {
            conn = c;
        },
        setNow: (n: number) => {
            now = n;
        },
    };
}
const input = (t: PhysicalAdmissionTicket, side: 'base' | 'pr' = 'base') => ({
    organizationId: t.organizationId,
    runId: t.key,
    ref: { side, sha: (side === 'base' ? 'a' : 'b').repeat(40) }, environmentId: 'env', consumer: 'runtime', imageId: 'image',
    idempotencyKey: `run:${side}:1`,
});

describe('TicketService', () => {
    // JSONB returns keys in a different order from Zod's wire object. Equal
    // budgets used to be rejected as owner_changed before either claim booted.
    it('reserves equivalent JSONB and wire sizes without comparing property order', async () => {
        const f = fixture();
        f.row.payload.request.environment.size = { cpus: 1, memoryMb: 1024 };
        f.row.ticketOwnerToken = 'a4fcf307-047e-4634-a607-604523f5c99c';
        f.session.maxClaimSize = { memoryMb: 2048, cpus: 2 };
        const wire = PhysicalAdmissionRequestSchema.parse({
            ...request,
            ticketOwnerToken: 'a4fcf307-047e-4634-a607-604523f5c99c',
            size: f.row.payload.request.environment.size,
        });
        expect(Object.keys(wire.size!)).not.toEqual(Object.keys(f.row.payload.request.environment.size));
        expect(await f.service.reserve('cell', wire)).toMatchObject({ status: 'reserved' });
        expect(await f.service.reserve('cell', { ...wire, size: { memoryMb: 1024, cpus: 2 } })).toMatchObject({ status: 'refused', reason: 'owner_changed' });
    });

    it('authorizes the same sized claim after JSONB reorders its stored fields', async () => {
        const f = fixture();
        const ticket = await f.reserve();
        await f.service.redeem(ticket);
        f.row.payload.request.environment.size = { cpus: 1, memoryMb: 12_288 };
        expect(await f.service.authorizeAcquire(ticket, { ...input(ticket), size: { memoryMb: 12_288, cpus: 1 } })).toBe(true);
        expect(await f.service.authorizeAcquire(ticket, { ...input(ticket), size: { memoryMb: 12_288, cpus: 2 } })).toBe(false);
        expect(await f.service.authorizeAcquire(ticket, { ...input(ticket), size: { memoryMb: 1024, cpus: 1 } })).toBe(false);
        expect(await f.service.authorizeAcquire(ticket, input(ticket))).toBe(false);
    });

    it('permits slot-only tickets only for an explicit aws VM session and fences legacy slots', async () => {
        const f = fixture();
        f.book.report('cell', undefined, [], 1_000, 2, 'epoch');
        expect(await f.service.reserve('cell', request)).toMatchObject({
            status: 'refused',
            reason: 'unavailable',
        });
        f.session.driver = 'aws-ec2';
        expect(await f.service.reserve('cell', request)).toMatchObject({
            status: 'refused',
            reason: 'unavailable',
        });
        f.session.isolation = 'vm';
        const ticket = await f.reserve();
        expect(f.book.ticketOf(ticket)?.bootMb).toBe(0);
        expect(
            f.book.admit(
                'cell',
                { claimId: 'legacy', side: 'setup', consumer: 'setup' },
                1_001,
            ),
        ).toMatchObject({ kind: 'wait' });
        expect(await f.service.redeem(ticket)).toBe(true);
        expect(await f.service.authorizeAcquire(ticket, input(ticket))).toBe(
            true,
        );
        expect(f.service.consume(ticket, ticket.members[0].claimId)).toBe(true);
    });
    it('binds requests to durable ownership, exact members and payload', async () => {
        const f = fixture();
        expect(
            await f.service.reserve('cell', {
                ...request,
                members: [request.members[0]],
            }),
        ).toMatchObject({ status: 'refused', reason: 'owner_changed' });
        expect(
            await f.service.reserve('cell', {
                ...request,
                executionId: 'other',
            }),
        ).toMatchObject({ status: 'refused', reason: 'owner_changed' });
        f.ownership.owns.mockResolvedValue(false);
        expect(await f.service.reserve('cell', request)).toMatchObject({
            status: 'refused',
            reason: 'owner_changed',
        });
        expect(f.book.view('cell')?.pendingMb).toBe(0);
    });
    it('reserves idempotently, redeems whole pair and keeps the cold base charge', async () => {
        const f = fixture();
        const ticket = await f.reserve();
        expect(await f.reserve()).toEqual(ticket);
        expect(await f.service.authorizeAcquire(ticket, input(ticket))).toBe(
            false,
        );
        expect(await f.service.redeem(ticket)).toBe(true);
        expect(await f.service.authorizeAcquire(ticket, input(ticket))).toBe(
            true,
        );
        expect(f.service.prepare(ticket, ticket.members[0].claimId)).toBe(true);
        expect(f.book.view('cell')?.pendingMb).toBe(24_576);
        expect(
            f.book.admit(
                'cell',
                {
                    claimId: ticket.members[0].claimId,
                    side: 'base',
                    consumer: 'runtime',
                },
                1_001,
            ),
        ).toMatchObject({ needMb: 12_288 });
        expect(
            await f.service.authorizeAcquire(ticket, {
                ...input(ticket),
                size: { memoryMb: 12_288, cpus: 99 },
            }),
        ).toBe(false);
    });
    it('binds expensive work to the accepted consumer, environment, image and side commit', async () => {
        const f = fixture(); const ticket = await f.reserve(); await f.service.redeem(ticket);
        for (const patch of [{ consumer: 'setup' }, { environmentId: 'other' }, { imageId: 'other' }, { ref: { side: 'base', sha: 'c'.repeat(40) } }]) {
            expect(await f.service.authorizeAcquire(ticket, { ...input(ticket), ...patch })).toBe(false);
        }
    });
    it('refuses an old local connection after another replica replaces the persisted session', async () => {
        const f = fixture(); const ticket = await f.reserve(); await f.service.redeem(ticket);
        f.session.sessionEpoch = 'new-replica-epoch'; f.session.replicaId = 'new-replica';
        expect(await f.service.redeem(ticket)).toBe(false);
        expect(await f.service.authorizeAcquire(ticket, input(ticket))).toBe(false);
        f.session.sessionEpoch = ticket.sessionEpoch;
        expect(await f.service.redeem(ticket)).toBe(false);
        expect(await f.service.authorizeAcquire(ticket, input(ticket))).toBe(false);
    });

    it('fails closed after restart, epoch replacement or ownership changing during an await', async () => {
        const f = fixture();
        const ticket = await f.reserve();
        f.row.ticket = ticket;
        f.book.reset('cell', 'epoch');
        expect(await f.service.reserve('cell', request)).toMatchObject({
            status: 'refused',
            reason: 'ticket_expired',
        });
        const g = fixture();
        const t = await g.reserve();
        g.directory.pin.mockImplementationOnce(async () => {
            g.setConn({ sessionEpoch: 'replaced' });
            return true;
        });
        expect(await g.service.redeem(t)).toBe(false);
        expect(g.service.consume(t, t.members[0].claimId)).toBe(false);
    });
    it('requires current durable ownership before every write and retains started shadows after cancellation', async () => {
        const f = fixture();
        const ticket = await f.reserve();
        await f.service.redeem(ticket);
        f.service.consume(ticket, ticket.members[0].claimId);
        f.row.ticketOwnerToken = 'replacement';
        await f.service.cancel(ticket); // a different physical owner cannot cancel this ticket
        f.row.ticketOwnerToken = ticket.ticketOwnerToken;
        expect(f.releaseClaim).not.toHaveBeenCalled();
        f.row.state = 'cancelled';
        await expect(f.service.cancel(ticket)).rejects.toThrow('member_cleanup_pending');
        expect(f.releaseClaim).toHaveBeenCalledWith({
            claimId: ticket.members[0].claimId,
            organizationId: 'org',
            runId: 'run',
        });
        f.book.forget('cell', ticket.members[0].claimId);
        expect(f.book.view('cell')?.pendingMb).toBe(12_288);
        expect(f.service.consume(ticket, ticket.members[1].claimId)).toBe(
            false,
        );
        expect(f.directory.release).not.toHaveBeenCalled();
        f.service.noteReleased('cell', ticket.members[0].claimId);
        f.book.report('cell', { allocatableMb: 32_768, committedMb: 0, bootMb: 12_288, readyMb: 2_048 }, [], 2_000, 4, 'epoch');
        await f.service.cancel(ticket);
        expect(f.directory.release).toHaveBeenCalledTimes(1);
        f.row.ticketOwnerToken = 'new-owner';
        await f.service.cancel(ticket);
        expect(f.directory.release).toHaveBeenCalledTimes(1);
    });
    it('cancels every started setup history member and retargets only exact released children', async () => {
        const f = fixture();
        const setup: PhysicalAdmissionRequest = {
            ...request,
            kind: 'setup',
            key: 'setupkey',
            members: [{ side: 'setup', idempotencyKey: 'setup:setupkey' }],
        };
        f.row.payload = { kind: 'setup', request: { key: 'setupkey' } };
        const result = await f.service.reserve('cell', setup);
        expect(result.status).toBe('reserved');
        const ticket = (result as { ticket: PhysicalAdmissionTicket }).ticket;
        await f.service.redeem(ticket);
        f.service.consume(ticket, ticket.members[0].claimId);
        expect(
            await f.service.retargetSetup(ticket, 'setup:setupkey:learn-1'),
        ).toEqual({ ok: false, reason: 'member_cleanup_pending' });
        f.service.noteReleased('cell', ticket.members[0].claimId);
        f.setNow(2_000);
        f.book.forget('cell', ticket.members[0].claimId);
        f.book.report(
            'cell',
            {
                allocatableMb: 32_768,
                committedMb: 0,
                bootMb: 12_288,
                readyMb: 2_048,
            },
            [],
            2_000,
            4,
            'epoch',
        );
        expect(
            await f.service.retargetSetup(ticket, 'setup:setupkey:learn-1'),
        ).toEqual({ ok: true });
        const child = claimIdFor('org', 'setup:setupkey:learn-1');
        f.service.consume(ticket, child);
        f.row.state = 'completed';
        await expect(f.service.cancel(ticket)).rejects.toThrow('member_cleanup_pending');
        expect(
            f.releaseClaim.mock.calls.map(([r]: any[]) => r.claimId),
        ).toEqual([ticket.members[0].claimId, child]);
    });
});
