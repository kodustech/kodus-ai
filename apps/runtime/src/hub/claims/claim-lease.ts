import type { Consumer, LeaseRenewal } from '@libs/runtime/environment';
import { LEASE_TTL_MINUTES } from '@libs/runtime/environment';
import type { MessageBody } from '@libs/runtime/protocol';

import type { CellConnectionRegistry } from '../gateway/cell-connections';
import type { ClaimRow, ClaimState, HubStore } from '../hub-store';
import { CellUnavailableError, ClaimRef, HubLog, HubMetrics } from '../hub-types';

// claim.renew on the hub (§1b): the owner of a live claim (a Run still
// working) asks for more lease; the hub computes the new end, never past the
// claim's hard ceiling, sends claim.renew to the cell and records what the
// cell acked. The cell clamps to the same ceiling (lease.Manager.Renew), so
// neither side can keep machines past hardExpiresAt.

/**
 * The states whose lease a Run may extend: only a bound claim, whose Run is
 * still working. `held` keeps its machines to hardExpiresAt by design. A
 * compromised claim takes no step, so nothing legitimate needs it longer: a
 * renew would only let whatever tripped the violation keep running until the
 * ceiling. Its machines stay as evidence for the lease it already had.
 */
export const RENEWABLE_CLAIM_STATES: readonly ClaimState[] = ['bound'];

/** Cell nack codes that mean the machines are gone: renewing again cannot help. */
const GONE_CODES = new Set(['unknown_claim', 'claim_expired']);

export class ClaimLeaseService {
    constructor(
        private readonly claims: { scoped(ref: ClaimRef): Promise<ClaimRow | null> },
        private readonly store: Pick<HubStore, 'renewClaimLease'>,
        private readonly connections: Pick<CellConnectionRegistry, 'request'>,
        private readonly hubMetrics: Pick<HubMetrics, 'claimRenew'>,
        private readonly log: HubLog,
        private readonly now: () => Date,
    ) {}

    /**
     * Extends the claim's lease to min(now + its consumer's TTL, hardExpiresAt).
     * The TTL is the one of the consumer the claim was acquired for, never the
     * one the caller names: a caller that said `mcp` on a Run's claim would
     * otherwise get it 120 minutes instead of 45. `requested` only stands in
     * for a row from before the consumer was recorded (migration 7), whose
     * ceiling was still set by the right consumer.
     * A claim of another tenant is a ClaimScopeError; a cell out of reach is a
     * CellUnavailableError (the caller retries); a finished, unknown or expired
     * claim is `gone` (the caller stops renewing it).
     */
    async renew(ref: ClaimRef, requested: Consumer): Promise<LeaseRenewal> {
        const claim = await this.claims.scoped(ref);
        const ids = { claimId: ref.claimId, cellId: claim?.cellId, runId: claim?.runId ?? undefined };
        const consumer = claim?.consumer ?? requested;
        if (claim?.consumer && claim.consumer !== requested) this.log('warn', 'claim.renew.consumer_mismatch', { ...ids, consumer, requested });
        const gone = (why: string): LeaseRenewal => {
            this.hubMetrics.claimRenew({ outcome: 'gone', consumer });
            this.log('info', 'claim.renew.gone', { ...ids, why, state: claim?.state });
            return { status: 'gone' };
        };
        if (!claim) return gone('unknown');
        if (!RENEWABLE_CLAIM_STATES.includes(claim.state)) return gone('state');
        const at = this.now().getTime();
        const hard = Date.parse(claim.hardExpiresAt);
        if (!(hard > at)) return gone('past_hard_expiry');
        const until = Math.min(at + LEASE_TTL_MINUTES[consumer] * 60_000, hard);
        const leaseExpiresAt = new Date(until).toISOString();
        const body: MessageBody<'claim.renew'> = { leaseExpiresAt };
        // A connection lost here or no ack in time: CellUnavailableError, retried by the caller.
        const reply = await this.connections.request(claim.cellId, 'claim.renew', body, claim.claimId);
        if (reply.type !== 'ack') {
            const code = reply.type === 'nack' ? (reply.body as MessageBody<'nack'>).code : reply.type;
            if (GONE_CODES.has(code)) return gone(`cell:${code}`);
            this.hubMetrics.claimRenew({ outcome: 'failed', consumer });
            this.log('warn', 'claim.renew.failed', { ...ids, code });
            throw new CellUnavailableError(`${claim.cellId}: claim.renew not acked (${code})`);
        }
        // Monotonic and guarded by state: a release that raced the renew is never undone.
        await this.store.renewClaimLease(claim.claimId, leaseExpiresAt, RENEWABLE_CLAIM_STATES);
        const atCeiling = until >= hard;
        this.hubMetrics.claimRenew({ outcome: atCeiling ? 'ceiling' : 'renewed', consumer });
        this.log('info', 'claim.renew', { ...ids, leaseExpiresAt, hardExpiresAt: claim.hardExpiresAt, atCeiling });
        return { status: 'renewed', leaseExpiresAt, hardExpiresAt: claim.hardExpiresAt, atCeiling };
    }
}
