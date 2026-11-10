import { CellUnavailableError, HubRefused, MemberCleanupPendingError } from '../../shared/errors';
import type { AdmissionLease, AdmissionRecord, AdmissionStore, PhysicalAdmissionClient, PhysicalAdmissionTicket } from '../../shared/admission-contract';
import { shopRunRequest } from '../../e2e/fixtures';
import { AdmissionCoordinator, type AdmissionScheduling } from './admission-coordinator';

const now = new Date('2026-11-07T12:00:00Z');
const req = shopRunRequest({ requestedAt: now.toISOString() });
const ref = { organizationId: req.organizationId, kind: 'run' as const, key: req.runId };
const identity = { ...ref, generation: 0, ticketOwnerToken: 'physical-owner' };
const lease: AdmissionLease = { ...identity, leaseToken: 'short-lease', ownerEpoch: 1, ownerUntil: '2026-11-07T12:00:30Z' };
const ticket: PhysicalAdmissionTicket = { ...identity, ticketId: 'ticket-1', cellId: 'cell-1', sessionEpoch: 'session-1', expiresAt: '2026-11-07T12:02:00Z', members: [] };
const record: AdmissionRecord = {
    ...identity, executionId: req.runId, payload: { kind: 'run', request: req }, payloadBytes: 100,
    state: 'owned', deadlineAt: '2026-11-07T12:30:00Z', approvalDeadlineAt: null, nextAt: null,
    maxAttempts: 360, leaseToken: lease.leaseToken, ownerEpoch: 1, ownerUntil: lease.ownerUntil,
    permitHeld: false, ticket: null, lastReason: null, createdAt: now.toISOString(), updatedAt: now.toISOString(),
};
function harness() {
    const reserved = { ...record, state: 'reserved' as const, permitHeld: true };
    const attached = { ...reserved, ticket };
    const dispatched = { ...attached, state: 'dispatched' as const };
    const deferred = { ...record, generation: 1, state: 'waiting' as const, nextAt: '2026-11-07T12:00:05.000Z' };
    const store = {
        take: jest.fn(async () => ({ status: 'taken', lease, record })),
        reserveExecution: jest.fn(async () => ({ status: 'reserved', record: reserved })),
        defer: jest.fn(async () => ({ changed: true, record: deferred })),
        reject: jest.fn(async () => ({ changed: true, record: { ...reserved, state: 'rejected', lastReason: 'pair_too_large' } })),
        attachTicket: jest.fn(async () => ({ changed: true, record: attached })),
        markDispatched: jest.fn(async () => ({ changed: true, record: dispatched })),
        get: jest.fn(async () => record),
        startExecution: jest.fn(async () => ({ changed: true, record: { ...dispatched, state: 'running' } })),
        finishExecution: jest.fn(async () => ({ changed: true, record: { ...dispatched, state: 'completed', permitHeld: false }, releasedTicket: ticket })),
        acknowledgeTicketCleanup: jest.fn(async () => ({ changed: true, record: null })),
    };
    const physical = { reserve: jest.fn(async () => ({ status: 'reserved', ticket })), redeem: jest.fn(async () => true), cancel: jest.fn(async () => undefined) };
    const checkpoints: unknown[] = [];
    const ports: AdmissionScheduling = {
        step: async (_name, fn) => { const out = await fn(); checkpoints.push(structuredClone(out)); return out; },
        schedule: jest.fn(async () => undefined), wake: jest.fn(async () => undefined),
    };
    const coordinator = new AdmissionCoordinator(store as unknown as AdmissionStore, physical as unknown as PhysicalAdmissionClient,
        { globalWaiting: 100, perOrgWaiting: 10, globalExecuting: 4, perOrgExecuting: 2, maxAttempts: 360, leaseMs: 30_000, retryMs: 5_000 }, () => now);
    return { coordinator, store, physical, ports, checkpoints };
}

describe('short durable admission attempts', () => {
    it('does not reserve a logical permit or physical ticket for an already blocked setup', async () => {
        const h = harness();
        h.store.take.mockResolvedValue({
            status: 'taken',
            lease,
            record: {
                ...record,
                payload: {
                    kind: 'setup',
                    request: {
                        key: 'setup-1',
                        blocker: {
                            kind: 'resources',
                            message: 'disk unsupported',
                        },
                    },
                },
            },
        } as any);
        await h.coordinator.attempt(ref, 0, h.ports);
        expect(h.store.reserveExecution).not.toHaveBeenCalled();
        expect(h.physical.reserve).not.toHaveBeenCalled();
        expect(h.store.reject).toHaveBeenCalledWith(lease, 'unavailable');
    });
    it('reserves the already resolved recipe CPU/RAM carried by the product command', async () => {
        const h = harness();
        const size = { cpus: 4, memoryMb: 8192 };
        h.store.take.mockResolvedValue({
            status: 'taken',
            lease,
            record: {
                ...record,
                payload: {
                    kind: 'setup',
                    request: { key: 'setup-1', machineSize: size },
                },
            },
        } as any);
        await h.coordinator.attempt(ref, 0, h.ports);
        expect(h.physical.reserve).toHaveBeenCalledWith(
            expect.objectContaining({
                size,
                members: [{ side: 'setup', idempotencyKey: 'setup:setup-1' }],
            }),
        );
    });
    it('retains the logical permit until physical cleanup succeeds and acknowledges it durably', async () => {
        const h = harness();
        h.store.get.mockResolvedValue({ ...record, state: 'running', permitHeld: true, ticket });
        h.physical.cancel.mockRejectedValueOnce(new MemberCleanupPendingError());

        expect(await h.coordinator.finish(ref, req.runId)).toEqual({ finished: false, cleanupFailed: false, cleanupPending: true });
        expect(h.store.finishExecution).not.toHaveBeenCalled();
        expect(h.store.acknowledgeTicketCleanup).not.toHaveBeenCalled();

        expect(await h.coordinator.finish(ref, req.runId)).toEqual({ finished: true, cleanupFailed: false });
        expect(h.store.finishExecution).toHaveBeenCalledTimes(1);
        expect(h.store.acknowledgeTicketCleanup).toHaveBeenCalledWith(identity, ticket.ticketId);
    });

    it.each([
        [new CellUnavailableError('secret-body'), 'cell_unavailable'],
        [new Error('member_cleanup_pending'), 'unexpected'],
        [new HubRefused({ code: 'forbidden', message: 'secret-body' }), 'hub_refused'],
    ])('keeps genuine cleanup failures distinct and sanitized: %s', async (error, reason) => {
        const h = harness();
        h.store.get.mockResolvedValue({ ...record, state: 'running', permitHeld: true, ticket });
        h.physical.cancel.mockRejectedValue(error);
        expect(await h.coordinator.cleanupTicket(ticket)).toEqual({ status: 'failed', reason });
        expect(await h.coordinator.finish(ref, req.runId)).toEqual({ finished: false, cleanupFailed: true, reason });
        expect(h.store.finishExecution).not.toHaveBeenCalled();
        expect(h.store.acknowledgeTicketCleanup).not.toHaveBeenCalled();
    });

    it('reports only a closed category when durable cleanup acknowledgement fails', async () => {
        const h = harness();
        h.store.get.mockResolvedValue({ ...record, state: 'running', permitHeld: true, ticket });
        h.store.acknowledgeTicketCleanup.mockRejectedValue(new Error('database secret-body'));
        expect(await h.coordinator.finish(ref, req.runId)).toEqual({ finished: true, cleanupFailed: true, reason: 'store_unavailable' });
    });

    it('does not turn DBOS cancellation or stale ownership into a cleanup result', async () => {
        const h = harness();
        const cancelled = Object.assign(new Error('control'), { name: 'DBOSWorkflowCancelledError' });
        h.physical.cancel.mockRejectedValue(cancelled);
        await expect(h.coordinator.cleanupTicket(ticket)).rejects.toBe(cancelled);
        h.store.get.mockResolvedValue({ ...record, executionId: 'replacement', ticket });
        expect(await h.coordinator.finish(ref, req.runId)).toEqual({ finished: false, cleanupFailed: false });
        expect(h.store.finishExecution).not.toHaveBeenCalled();
        expect(h.store.acknowledgeTicketCleanup).not.toHaveBeenCalled();
    });

    it.each(['defer', 'reject'])('does not advance %s while a transition ticket awaits cleanup', async (operation) => {
        const h = harness();
        h.physical.reserve.mockResolvedValue({ status: 'refused', reason: 'no_capacity', retryable: operation === 'defer' } as any);
        h.store[operation].mockResolvedValue({ changed: true, record: { ...record, state: operation === 'defer' ? 'waiting' : 'rejected', nextAt: now.toISOString() }, releasedTicket: ticket } as any);
        h.physical.cancel.mockRejectedValue(new MemberCleanupPendingError());
        await expect(h.coordinator.attempt(ref, 0, h.ports)).rejects.toBeInstanceOf(MemberCleanupPendingError);
        expect(h.ports.wake).not.toHaveBeenCalled();
        expect(h.ports.schedule).not.toHaveBeenCalled();
    });

    it('redeems an attached ticket before allowing the original execution to do work', async () => {
        const h = harness();
        h.store.get.mockResolvedValue({ ...record, state: 'dispatched', permitHeld: true, ticket });

        const result = await h.coordinator.begin(ref, req.runId);

        expect(result).toEqual({ status: 'ready', identity, ticket });
        expect(h.physical.redeem).toHaveBeenCalledWith(ticket);
        expect(h.store.startExecution).toHaveBeenCalledWith(identity, req.runId);
    });

    it('fails closed for a ticket that expired before native execution starts', async () => {
        const h = harness();
        h.store.get.mockResolvedValue({ ...record, state: 'dispatched', permitHeld: true, ticket: { ...ticket, expiresAt: '2026-11-07T11:59:59Z' } });

        expect(await h.coordinator.begin(ref, req.runId)).toMatchObject({ status: 'refused', reason: 'ticket_expired' });
        expect(h.physical.redeem).not.toHaveBeenCalled();
        expect(h.store.startExecution).not.toHaveBeenCalled();
    });

    it('returns after scheduling a delayed retry without waking execution or checkpointing the sealed payload', async () => {
        const h = harness();
        h.physical.reserve.mockResolvedValue({ status: 'refused', reason: 'no_capacity', retryable: true } as any);

        await h.coordinator.attempt(ref, 0, h.ports);

        expect(h.store.defer).toHaveBeenCalledWith(lease, 'no_capacity', '2026-11-07T12:00:05.000Z');
        expect(h.ports.schedule).toHaveBeenCalledWith(ref, 1, '2026-11-07T12:00:05.000Z');
        expect(h.ports.wake).not.toHaveBeenCalled();
        expect(JSON.stringify(h.checkpoints)).not.toContain('repoToken');
        expect(JSON.stringify(h.checkpoints)).not.toContain('diff');
    });

    it('does not reserve physical resources when the combined execution budget is full', async () => {
        const h = harness();
        h.store.reserveExecution.mockResolvedValue({ status: 'global_limit' } as any);

        await h.coordinator.attempt(ref, 0, h.ports);

        expect(h.physical.reserve).not.toHaveBeenCalled();
        expect(h.store.defer).toHaveBeenCalledWith(lease, 'global_limit', '2026-11-07T12:00:05.000Z');
        expect(h.ports.schedule).toHaveBeenCalledTimes(1);
    });

    it('wakes the original execution only after the ticket and dispatch intent are durable', async () => {
        const h = harness();

        await h.coordinator.attempt(ref, 0, h.ports);

        expect(h.store.attachTicket).toHaveBeenCalledWith(lease, ticket);
        expect(h.store.markDispatched).toHaveBeenCalledWith(lease);
        expect(h.ports.wake).toHaveBeenCalledWith(req.runId);
        expect(h.ports.schedule).not.toHaveBeenCalled();
        expect(h.physical.cancel).not.toHaveBeenCalled();
    });

    it('a lost lease owner never cancels the generation-stable physical ticket', async () => {
        const h = harness();
        h.store.attachTicket.mockResolvedValue({ changed: false, record: null } as any);

        await h.coordinator.attempt(ref, 0, h.ports);

        expect(h.physical.cancel).not.toHaveBeenCalled();
        expect(h.ports.wake).not.toHaveBeenCalled();
        expect(h.store.markDispatched).not.toHaveBeenCalled();
    });

    it('repairs a checkpoint gap after ticket attachment without reserving or renewing the ticket again', async () => {
        const h = harness();
        h.store.take.mockResolvedValue({ status: 'taken', lease, record: { ...record, state: 'reserved', permitHeld: true, ticket } });
        h.store.attachTicket.mockResolvedValue({ changed: false, record: { ...record, state: 'reserved', permitHeld: true, ticket } } as any);

        await h.coordinator.attempt(ref, 0, h.ports);

        expect(h.physical.reserve).not.toHaveBeenCalled();
        expect(h.store.markDispatched).toHaveBeenCalledWith(lease);
        expect(h.ports.wake).toHaveBeenCalledWith(req.runId);
    });

    it('records a permanent refusal then wakes native execution to produce its terminal result', async () => {
        const h = harness();
        h.physical.reserve.mockResolvedValue({ status: 'refused', reason: 'pair_too_large', retryable: false } as any);

        await h.coordinator.attempt(ref, 0, h.ports);

        expect(h.store.reject).toHaveBeenCalledWith(lease, 'pair_too_large');
        expect(h.ports.wake).toHaveBeenCalledWith(req.runId);
        expect(h.ports.schedule).not.toHaveBeenCalled();
    });
});
