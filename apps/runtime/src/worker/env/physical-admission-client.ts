import { z } from 'zod';
import type {
    PhysicalAdmissionClient,
    PhysicalAdmissionRequest,
    PhysicalAdmissionResult,
    PhysicalAdmissionTicket,
} from '../../shared/admission/admission-contract';
import type { PhysicalAdmissionDirectory } from '../../shared/admission/physical-admission-directory';
import { claimIdFor } from '../../shared/claim-id';
import { CellUnavailableError } from '../../shared/errors';
import type { HubClient } from './hub-environment-runtime';

const CancelledResponse = z.strictObject({ ok: z.literal(true) });

type RetargetResult =
    | { ok: true }
    | {
          ok: false;
          reason: 'member_cleanup_pending' | 'owner_changed' | 'ticket_expired';
      };

/** Bounded placement only: durable admission owns retries and their deadlines. */
export class HubPhysicalAdmissionClient implements PhysicalAdmissionClient {
    constructor(
        private readonly hub: Pick<HubClient, 'post' | 'replicaForCell'>,
        private readonly directory: PhysicalAdmissionDirectory,
        private readonly now: () => number = () => Date.now(),
    ) {}

    async reserve(
        request: PhysicalAdmissionRequest,
    ): Promise<PhysicalAdmissionResult> {
        const excluded: string[] = [];
        const deadline = this.now() + 10_000;
        let last: PhysicalAdmissionResult = {
            status: 'refused',
            reason: 'no_capacity',
            retryable: true,
        };
        for (let i = 0; i < 2 && this.now() < deadline; i++) {
            const placed = await this.directory.reserve(request, excluded);
            if (placed.status === 'refused')
                return placed.allCellsTried && placed.reason === 'no_capacity'
                    ? last
                    : placed;
            const { cell } = placed;
            const remaining = deadline - this.now();
            if (remaining <= 0) return { status: 'refused', reason: 'unavailable', retryable: true };
            try {
                const result = await this.hub.post<PhysicalAdmissionResult>(
                    cell.replicaUrl,
                    this.path(cell.cellId, 'reserve'),
                    request,
                    undefined,
                    Math.min(5_000, remaining),
                );
                if (result.status === 'reserved') return result;
                await this.directory.release({
                    ...request,
                    ticketId: '',
                    cellId: cell.cellId,
                    sessionEpoch: cell.sessionEpoch,
                    expiresAt: request.deadlineAt,
                    members: request.members.map((m) => ({
                        ...m,
                        claimId: claimIdFor(
                            request.organizationId,
                            m.idempotencyKey,
                        ),
                    })),
                });
                last = result;
                if (
                    ![
                        'pair_too_large',
                        'no_capacity',
                        'size_unavailable',
                        'unavailable',
                    ].includes(result.reason)
                )
                    return result;
                excluded.push(cell.cellId);
            } catch (e) {
                // A lost answer may have created a ticket: preserve its PG debit until TTL/retry.
                if (e instanceof CellUnavailableError)
                    return {
                        status: 'refused',
                        reason: 'unavailable',
                        retryable: true,
                    };
                throw e;
            }
        }
        return { status: 'refused', reason: 'no_capacity', retryable: true };
    }

    async redeem(ticket: PhysicalAdmissionTicket): Promise<boolean> {
        const url = await this.hub.replicaForCell(ticket.cellId);
        if (!url) return false;
        try {
            return (
                (
                    await this.hub.post<{ ok: boolean }>(
                        url,
                        this.path(ticket.cellId, 'redeem'),
                        ticket, undefined, 5_000,
                    )
                ).ok === true
            );
        } catch (e) {
            if (e instanceof CellUnavailableError) return false;
            throw e;
        }
    }

    async cancel(ticket: PhysicalAdmissionTicket): Promise<void> {
        const url = await this.hub.replicaForCell(ticket.cellId);
        if (url) {
            const response = await this.hub.post<unknown>(
                url,
                this.path(ticket.cellId, 'cancel'),
                ticket, undefined, 5_000,
            );
            if (!CancelledResponse.safeParse(response).success)
                throw new Error('invalid admission cancellation response');
        }
        // A lost session cannot start unused members; existing claims remain cell-ledger owned.
        else await this.directory.release(ticket);
    }

    async retargetSetup(
        ticket: PhysicalAdmissionTicket,
        idempotencyKey: string,
    ): Promise<RetargetResult> {
        const url = await this.hub.replicaForCell(ticket.cellId);
        return url
            ? this.hub.post<RetargetResult>(
                  url,
                  this.path(ticket.cellId, 'retarget-setup'),
                  { ticket, idempotencyKey }, undefined, 5_000,
              )
            : { ok: false, reason: 'ticket_expired' };
    }

    private path(cellId: string, action: string): string {
        return `/internal/cells/${encodeURIComponent(cellId)}/admission/${action}`;
    }
}
