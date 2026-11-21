import { CellUnavailableError, HubRefused, MemberCleanupPendingError } from '../../shared/errors';
import type { AdmissionCleanupResult, AdmissionFinishResult, AdmissionIdentity, AdmissionLease, AdmissionLimits, AdmissionReason, AdmissionRecord, AdmissionRef, AdmissionStore, AdmissionTransition, PhysicalAdmissionClient, PhysicalAdmissionRequest, PhysicalAdmissionResult, PhysicalAdmissionTicket } from '../../shared/admission/admission-contract';
import type { StepRunner } from '../run/ports';
import { isCancellation } from '../workflow-cancellation';

export const ADMISSION_COORDINATOR = Symbol('ADMISSION_COORDINATOR');
export interface AdmissionScheduling {
    step: StepRunner;
    schedule(ref: AdmissionRef, generation: number, nextAt: string): Promise<void>;
    wake(executionId: string): Promise<void>;
}
export type AdmissionExecution =
    | { status: 'ready'; identity: AdmissionIdentity; ticket: PhysicalAdmissionTicket }
    | { status: 'refused'; reason: AdmissionReason; identity?: AdmissionIdentity };

export const admissionRefOf = (record: AdmissionRef): AdmissionRef => ({ organizationId: record.organizationId, kind: record.kind, key: record.key });
export const admissionIdentityOf = (record: AdmissionIdentity): AdmissionIdentity => ({ ...admissionRefOf(record), generation: record.generation, ticketOwnerToken: record.ticketOwnerToken });

/** Transition checkpoints carry control data, not another copy of a potentially large sealed request. */
function controlOf(transition: AdmissionTransition) {
    const record = transition.record;
    return {
        changed: transition.changed,
        ...(record ? { ref: admissionRefOf(record), generation: record.generation, executionId: record.executionId, nextAt: record.nextAt, state: record.state } : {}),
        ...(transition.releasedTicket ? { releasedTicket: transition.releasedTicket } : {}),
    };
}

function physicalRequest(record: AdmissionRecord, lease: AdmissionLease): PhysicalAdmissionRequest | undefined {
    if (!record.payload || !record.executionId || !record.deadlineAt) return undefined;
    const payload = record.payload;
    // A product-authored blocked setup has no work to reserve, including default-size work.
    if (payload.kind === 'setup' && payload.request.blocker) return undefined;
    const members: PhysicalAdmissionRequest['members'] = payload.kind === 'run'
        ? (['base', 'pr'] as const).map((side) => ({ side, idempotencyKey: `${payload.request.runId}:${side}:${payload.request.attempt}` }))
        : [{ side: 'setup', idempotencyKey: `setup:${payload.request.key}` }];
    const size = payload.kind === 'run' ? payload.request.environment.size : payload.request.machineSize;
    return { ...admissionIdentityOf(lease), executionId: record.executionId, deadlineAt: record.deadlineAt, members, ...(size ? { size } : {}) };
}

export class AdmissionCoordinator {
    constructor(
        readonly store: AdmissionStore,
        private readonly physical: PhysicalAdmissionClient,
        readonly limits: AdmissionLimits & { leaseMs: number; retryMs: number },
        private readonly now: () => Date = () => new Date(),
    ) {}

    async begin(ref: AdmissionRef, executionId: string): Promise<AdmissionExecution> {
        const record = await this.store.get(ref);
        if (!record || record.executionId !== executionId) return { status: 'refused', reason: 'unavailable' };
        const identity = admissionIdentityOf(record);
        const refused = (reason: AdmissionReason): AdmissionExecution => ({ status: 'refused', reason, identity });
        if (record.state === 'cancelled') return refused(record.lastReason ?? 'cancelled');
        if (record.state === 'rejected' || record.state === 'expired') return refused(record.lastReason ?? 'deadline');
        if (!record.deadlineAt || Date.parse(record.deadlineAt) <= this.now().getTime()) return refused('deadline');
        if (!(record.state === 'dispatched' || record.state === 'running') || !record.permitHeld || !record.ticket) return refused('unavailable');
        if (Date.parse(record.ticket.expiresAt) <= this.now().getTime()) return refused('ticket_expired');
        let redeemed: boolean;
        try {
            redeemed = await this.physical.redeem(record.ticket);
        } catch (error) {
            if (isCancellation(error)) throw error;
            return refused('unavailable');
        }
        if (!redeemed) return refused('owner_changed');
        const started = await this.store.startExecution(identity, executionId);
        if (!started.record || started.record.state !== 'running') return refused(started.record?.lastReason ?? 'cancelled');
        return { status: 'ready', identity, ticket: record.ticket };
    }

    /** A terminal workflow alone is insufficient: the store also refuses while claims remain live. */
    async finish(ref: AdmissionRef, executionId: string): Promise<AdmissionFinishResult> {
        const record = await this.store.get(ref);
        if (!record || record.executionId !== executionId) return { finished: false, cleanupFailed: false };
        // PG release intent can precede the cell ACK. Never free the common permit on that intent alone.
        if (record.ticket) {
            const cleanup = await this.cleanupTicket(record.ticket);
            if (cleanup.status === 'pending') return { finished: false, cleanupFailed: false, cleanupPending: true };
            if (cleanup.status === 'failed') return { finished: false, cleanupFailed: true, reason: cleanup.reason };
        }
        const transition = await this.store.finishExecution(admissionIdentityOf(record), executionId);
        const after = transition.record ?? record;
        if (after.permitHeld) return { finished: false, cleanupFailed: false };
        const ticket = transition.releasedTicket ?? after.ticket;
        if (ticket) {
            try {
                await this.store.acknowledgeTicketCleanup(admissionIdentityOf(record), ticket.ticketId);
            } catch (error) {
                if (isCancellation(error)) throw error;
                return { finished: true, cleanupFailed: true, reason: 'store_unavailable' };
            }
        }
        return { finished: true, cleanupFailed: false };
    }

    async cleanupTicket(ticket: PhysicalAdmissionTicket): Promise<AdmissionCleanupResult> {
        try {
            await this.physical.cancel(ticket);
            return { status: 'done' };
        } catch (error) {
            if (isCancellation(error)) throw error;
            if (error instanceof MemberCleanupPendingError) return { status: 'pending', reason: 'member_cleanup_pending' };
            return { status: 'failed', reason: error instanceof CellUnavailableError ? 'cell_unavailable' : error instanceof HubRefused ? 'hub_refused' : 'unexpected' };
        }
    }

    async attempt(ref: AdmissionRef, generation: number, ports: AdmissionScheduling): Promise<void> {
        const taken = await ports.step('admission:take', async () => {
            const result = await this.store.take(ref, generation, this.limits.leaseMs);
            if (result.status !== 'taken') return { status: result.status };
            return { status: 'taken' as const, lease: result.lease, request: physicalRequest(result.record, result.lease), ticket: result.record.ticket };
        });
        if (taken.status !== 'taken' || !('lease' in taken)) return;
        const { lease, request } = taken;
        if (!request) {
            await this.reject(lease, 'unavailable', ports);
            return;
        }
        const permit = await ports.step('admission:permit', async () => (await this.store.reserveExecution(lease, this.limits)).status);
        if (permit !== 'reserved') {
            if (permit === 'global_limit' || permit === 'org_limit' || permit === 'setup_limit') await this.defer(lease, permit, request.deadlineAt, ports);
            return;
        }
        const reserved = taken.ticket ? { status: 'reserved' as const, ticket: taken.ticket } : await ports.step('admission:physical', async (): Promise<PhysicalAdmissionResult> => {
            try {
                return await this.physical.reserve(request);
            } catch (error) {
                if (isCancellation(error)) throw error;
                return { status: 'refused', reason: 'unavailable', retryable: true };
            }
        });
        if (reserved.status === 'refused') {
            if (reserved.retryable) await this.defer(lease, reserved.reason, request.deadlineAt, ports);
            else await this.reject(lease, reserved.reason, ports);
            return;
        }
        const attached = taken.ticket ? true : await ports.step('admission:attach', async () => {
            const result = await this.store.attachTicket(lease, reserved.ticket);
            return result.changed || result.record?.ticket?.ticketId === reserved.ticket.ticketId;
        });
        // A stale owner must not cancel a physical identity that its replacement reuses.
        if (!attached) return;
        const dispatched = await ports.step('admission:dispatch', async () => controlOf(await this.store.markDispatched(lease)));
        if (dispatched.changed && dispatched.executionId) await ports.wake(dispatched.executionId);
    }

    private async defer(lease: AdmissionLease, reason: AdmissionReason, deadlineAt: string, ports: AdmissionScheduling): Promise<void> {
        const transition = await ports.step('admission:defer', async () => {
            const nextAt = new Date(Math.min(this.now().getTime() + this.limits.retryMs, Date.parse(deadlineAt))).toISOString();
            return controlOf(await this.store.defer(lease, reason, nextAt));
        });
        if (!transition.changed) return;
        if (transition.releasedTicket) await ports.step('admission:cancel-deferred-ticket', () => this.physical.cancel(transition.releasedTicket!));
        if (transition.state === 'waiting' && transition.ref && transition.nextAt && transition.generation !== undefined) {
            await ports.schedule(transition.ref, transition.generation, transition.nextAt);
        } else if (transition.executionId) {
            await ports.wake(transition.executionId);
        }
    }

    private async reject(lease: AdmissionLease, reason: AdmissionReason, ports: AdmissionScheduling): Promise<void> {
        const transition = await ports.step('admission:reject', async () => controlOf(await this.store.reject(lease, reason)));
        if (!transition.changed) return;
        if (transition.releasedTicket) await ports.step('admission:cancel-rejected-ticket', () => this.physical.cancel(transition.releasedTicket!));
        if (transition.executionId) await ports.wake(transition.executionId);
    }
}
