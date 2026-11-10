import { randomUUID } from 'crypto';

import type {
    AdmissionStore,
    PhysicalAdmissionRequest,
    PhysicalAdmissionResult,
    PhysicalAdmissionTicket,
} from '../../shared/admission-contract';
import type { PhysicalAdmissionDirectory } from '../../shared/physical-admission-directory';
import { claimIdFor } from '../../shared/claim-id';
import type { CellConnectionRegistry } from '../gateway/cell-connections';
import type { HubStore } from '../hub-store';
import type { ClaimRef } from '../hub-types';
import { MemberCleanupPendingError } from '../../shared/errors';
import { CellMemoryBook } from './cell-memory';

export interface TicketServiceOptions {
    replicaId: string;
    ownership: Pick<AdmissionStore, 'get' | 'owns'>;
    directory: PhysicalAdmissionDirectory;
    now?: () => number;
    ttlMs?: number;
    releaseClaim: (ref: ClaimRef) => Promise<void>;
}
export type SetupRetargetResult =
    | { ok: true }
    | {
          ok: false;
          reason: 'member_cleanup_pending' | 'owner_changed' | 'ticket_expired';
      };

// JSONB and the HTTP decoder can order the same fields differently.
function sameSize(a: PhysicalAdmissionRequest['size'], b: PhysicalAdmissionRequest['size']): boolean {
    if (a === undefined || b === undefined) return a === b;
    return a.memoryMb === b.memoryMb && a.cpus === b.cpus;
}

/** Session-owned physical leases; all consumers still share one cell memory book. */
export class TicketService {
    private readonly retargeting = new Set<string>();
    constructor(
        private readonly book: CellMemoryBook,
        private readonly connections: CellConnectionRegistry,
        private readonly store: HubStore,
        private readonly opts: TicketServiceOptions,
    ) {}
    private now() {
        return this.opts.now?.() ?? Date.now();
    }
    private current(ticket: PhysicalAdmissionTicket): boolean {
        return (
            this.connections.get(ticket.cellId)?.sessionEpoch ===
            ticket.sessionEpoch
        );
    }

    private async authoritative(ticket: PhysicalAdmissionTicket): Promise<boolean> {
        const session = await this.store.session(ticket.cellId);
        return this.current(ticket) && session?.sessionEpoch === ticket.sessionEpoch && session.replicaId === this.opts.replicaId;
    }

    async reserve(
        cellId: string,
        request: PhysicalAdmissionRequest,
    ): Promise<PhysicalAdmissionResult> {
        const refused = (
            reason:
                | 'owner_changed'
                | 'unavailable'
                | 'ticket_expired' = 'owner_changed',
        ): PhysicalAdmissionResult => ({
            status: 'refused',
            reason,
            retryable: reason === 'unavailable',
        });
        if (!(await this.opts.ownership.owns(request))) return refused();
        const row = await this.opts.ownership.get(request);
        const conn = this.connections.get(cellId);
        const session = await this.store.session(cellId);
        if (
            !row ||
            !conn ||
            this.connections.get(cellId) !== conn ||
            session?.sessionEpoch !== conn.sessionEpoch ||
            session.replicaId !== this.opts.replicaId ||
            (session.owner === 'customer' &&
                session.orgId !== request.organizationId)
        )
            return refused('unavailable');
        const payload = row.payload;
        if (
            !payload ||
            payload.kind !== request.kind ||
            row.executionId !== request.executionId ||
            row.deadlineAt !== request.deadlineAt
        )
            return refused();
        const expected =
            payload.kind === 'run'
                ? ['base', 'pr'].map((side) => ({
                      side,
                      idempotencyKey: `${payload.request.runId}:${side}:${payload.request.attempt}`,
                  }))
                : [
                      {
                          side: 'setup',
                          idempotencyKey: `setup:${payload.request.key}`,
                      },
                  ];
        const size =
            payload.kind === 'run'
                ? payload.request.environment.size
                : payload.request.machineSize;
        if (
            JSON.stringify(expected) !== JSON.stringify(request.members) ||
            !sameSize(size, request.size)
        )
            return refused();
        if (
            size &&
            (!session.maxClaimSize ||
                size.memoryMb > session.maxClaimSize.memoryMb ||
                size.cpus > session.maxClaimSize.cpus)
        )
            return {
                status: 'refused',
                reason: 'size_unavailable',
                retryable: false,
            };
        if (
            !(await this.opts.directory.matches(cellId, request)) ||
            !(await this.opts.ownership.owns(request)) ||
            this.connections.get(cellId) !== conn
        )
            return refused();
        const existing = this.book.findTicket(cellId, request);
        if (
            row.ticket &&
            (!existing || row.ticket.ticketId !== existing.ticketId)
        )
            return refused('ticket_expired');
        const ticket: PhysicalAdmissionTicket = existing ?? {
            organizationId: request.organizationId,
            kind: request.kind,
            key: request.key,
            generation: request.generation,
            ticketOwnerToken: request.ticketOwnerToken,
            ticketId: randomUUID(),
            cellId,
            sessionEpoch: conn.sessionEpoch,
            expiresAt: new Date(
                Math.min(
                    Date.parse(request.deadlineAt),
                    this.now() + (this.opts.ttlMs ?? 120_000),
                ),
            ).toISOString(),
            members: request.members.map((m) => ({
                ...m,
                claimId: claimIdFor(request.organizationId, m.idempotencyKey),
            })),
        };
        return this.book.reserveTicket(
            ticket,
            size?.memoryMb,
            this.now(),
            session.driver === 'aws-ec2' && session.isolation === 'vm',
        );
    }

    async redeem(ticket: PhysicalAdmissionTicket): Promise<boolean> {
        if (!(await this.opts.ownership.owns(ticket)) || !(await this.authoritative(ticket)))
            return false;
        const held = this.book.ticketOf(ticket);
        if (
            !held ||
            held.cancelled ||
            this.now() >= (held.pinnedUntil ?? Date.parse(ticket.expiresAt))
        )
            return false;
        const until = held.pinnedUntil ?? this.now() + 60 * 60_000;
        if (
            !(await this.opts.directory.pin(
                ticket,
                new Date(until).toISOString(),
            ))
        )
            return false;
        if (!(await this.opts.ownership.owns(ticket)) || !(await this.authoritative(ticket)))
            return false;
        return this.book.redeemTicket(ticket, this.now());
    }

    async authorizeAcquire(
        ticket: PhysicalAdmissionTicket,
        input: {
            organizationId: string;
            environmentId: string;
            consumer: string;
            imageId?: string;
            runId?: string;
            ref: { side: string; sha: string };
            idempotencyKey: string;
            size?: { memoryMb: number; cpus: number };
        },
    ): Promise<boolean> {
        const id = claimIdFor(input.organizationId, input.idempotencyKey);
        if (
            ticket.organizationId !== input.organizationId ||
            (ticket.kind === 'run' && ticket.key !== input.runId) ||
            !(await this.opts.ownership.owns(ticket)) ||
            !this.current(ticket)
        )
            return false;
        const member = ticket.members.find(
            (m) =>
                m.claimId === id &&
                m.side === input.ref.side &&
                m.idempotencyKey === input.idempotencyKey,
        );
        if (ticket.kind === 'run' && !member) return false;
        if (ticket.kind === 'setup' && input.ref.side !== 'setup') return false;
        const held = this.book.ticketOf(ticket);
        const row = await this.opts.ownership.get(ticket);
        const payload = row?.payload;
        if (!payload || payload.kind !== ticket.kind) return false;
        if (payload.kind === 'run') {
            const expected = payload.request;
            const sha = input.ref.side === 'base' ? expected.pullRequest.baseSha : expected.pullRequest.headSha;
            if (input.consumer !== 'runtime' || input.environmentId !== expected.environment.environmentId || input.imageId !== expected.environment.imageId || input.ref.sha !== sha) return false;
        } else if (input.consumer !== 'setup' || input.environmentId !== payload.request.environmentId || input.runId !== undefined) return false;
        const expectedSize =
            row?.payload?.kind === 'run'
                ? row.payload.request.environment.size
                : row?.payload?.request.machineSize;
        if (
            !held ||
            !sameSize(input.size, expectedSize) ||
            (input.size &&
                held.bootMb > 0 &&
                input.size.memoryMb !== held.bootMb)
        )
            return false;
        return (await this.authoritative(ticket)) && this.book.validTicketMember(ticket, id, this.now());
    }

    prepare(ticket: PhysicalAdmissionTicket, claimId: string): boolean {
        return (
            this.current(ticket) &&
            this.book.prepareTicketMember(ticket, claimId, this.now())
        );
    }

    /** Called synchronously immediately before writing the cell frame. */
    consume(ticket: PhysicalAdmissionTicket, claimId: string): boolean {
        return (
            this.current(ticket) &&
            this.book.consumeTicket(ticket, claimId, this.now())
        );
    }

    noteReleased(cellId: string, claimId: string): void {
        this.book.noteReleased(cellId, claimId, this.now());
    }

    async retargetSetup(
        ticket: PhysicalAdmissionTicket,
        idempotencyKey: string,
    ): Promise<SetupRetargetResult> {
        if (!(await this.opts.ownership.owns(ticket)) || !this.current(ticket))
            return { ok: false, reason: 'owner_changed' };
        const check = this.book.canRetargetSetup(
            ticket,
            idempotencyKey,
            this.now(),
        );
        if (check !== 'ok') return { ok: false, reason: check };
        if (this.retargeting.has(ticket.ticketId))
            return { ok: false, reason: 'member_cleanup_pending' };
        this.retargeting.add(ticket.ticketId);
        try {
            if (
                !(await this.opts.directory.retarget(
                    ticket,
                    idempotencyKey,
                    new Date(
                        this.book.ticketOf(ticket)!.pinnedUntil!,
                    ).toISOString(),
                ))
            )
                return { ok: false, reason: 'ticket_expired' };
            if (
                !(await this.opts.ownership.owns(ticket)) ||
                !this.current(ticket)
            )
                return { ok: false, reason: 'owner_changed' };
            return this.book.retargetSetup(ticket, idempotencyKey, this.now())
                ? { ok: true }
                : { ok: false, reason: 'member_cleanup_pending' };
        } finally {
            this.retargeting.delete(ticket.ticketId);
        }
    }

    async cancel(ticket: PhysicalAdmissionTicket): Promise<void> {
        const row = await this.opts.ownership.get(ticket);
        if (!row || row.generation < ticket.generation || (row.generation === ticket.generation && row.ticketOwnerToken !== ticket.ticketOwnerToken))
            return;
        const started = this.book.startedMembers(ticket);
        this.book.cancelTicket(ticket, this.now());
        let failure: unknown;
        for (let i = 0; i < started.length; i += 4) {
            const results = await Promise.allSettled(
                started
                    .slice(i, i + 4)
                    .map((claimId) =>
                        this.opts.releaseClaim({
                            claimId,
                            organizationId: ticket.organizationId,
                            ...(ticket.kind === 'run'
                                ? { runId: ticket.key }
                                : { runId: null }),
                        }),
                    ),
            );
            for (const r of results)
                if (r.status === 'rejected') failure ??= r.reason;
        }
        if (failure) throw failure;
        if (this.current(ticket) && this.book.cleanupPending(ticket)) throw new MemberCleanupPendingError();
        await this.opts.directory.release(ticket);
    }
}
