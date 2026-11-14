import type { Consumer, EnvironmentRuntime } from '@libs/runtime/environment';

import { SecurityViolationError } from '../run/security-violation';
import { isCancellation } from '../workflow-cancellation';

/** Recorded inside the existing work step; interpreted outside it on replay (#2464). */
export interface ClaimLeaseFailure {
    claimId: string;
    reason: 'gone' | 'renew_failed' | 'security';
    side?: 'base' | 'pr';
    signature?: string;
}

export interface ClaimLeaseFailed {
    claimFailure: ClaimLeaseFailure;
}

/** A restored Claim is identity, not current lease authority (ADR-046, #2464). */
export async function checkClaimLease(
    env: EnvironmentRuntime,
    claimId: string,
    consumer: Consumer,
    opts: { side?: 'base' | 'pr'; securityOf?: (claimId: string) => Promise<string | undefined> } = {},
): Promise<ClaimLeaseFailure | undefined> {
    // Standalone fake/test adapters predate renewal. The production factory requires it.
    if (!env.renew) return undefined;
    const failed = (reason: ClaimLeaseFailure['reason'], signature?: string): ClaimLeaseFailure => ({ claimId, reason, ...(opts.side ? { side: opts.side } : {}), ...(signature ? { signature } : {}) });
    const failedWithSecurity = async (reason: 'gone' | 'renew_failed'): Promise<ClaimLeaseFailure> => {
        try {
            const signature = await opts.securityOf?.(claimId);
            return signature ? failed('security', signature) : failed(reason);
        } catch (error) {
            if (isCancellation(error)) throw error;
            return failed('renew_failed');
        }
    };
    try {
        const renewed = await env.renew(claimId, consumer);
        if ('code' in renewed) {
            if (renewed.code === 'security_violation') return failed('security', renewed.signature);
            return failedWithSecurity(renewed.code === 'lease_expired' ? 'gone' : 'renew_failed');
        }
        if (renewed.status === 'renewed') return undefined;
        if (renewed.status !== 'gone') return failedWithSecurity('renew_failed');
        // A lost renewal link or a compromised claim called "gone" cannot replace known security evidence.
        return failedWithSecurity('gone');
    } catch (error) {
        if (isCancellation(error)) throw error;
        // No exception text, tokens or remote response bodies enter a checkpoint.
        return failedWithSecurity('renew_failed');
    }
}

export class ClaimLeaseUnavailableError extends Error {
    readonly code: 'claim_lease_unavailable' | 'security_violation';

    constructor(readonly failure: ClaimLeaseFailure) {
        super(`claim_lease_unavailable (${failure.reason}); Run again`);
        this.name = 'ClaimLeaseUnavailableError';
        this.code = failure.reason === 'security' ? 'security_violation' : 'claim_lease_unavailable';
    }
}

export function throwClaimLeaseFailure(failure: ClaimLeaseFailure): never {
    if (failure.reason === 'security' && failure.side && failure.signature) throw new SecurityViolationError(failure.side, failure.signature);
    throw new ClaimLeaseUnavailableError(failure);
}
