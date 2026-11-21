import type { EnvironmentRuntime } from '@libs/runtime/environment';

import { checkClaimLease, throwClaimLeaseFailure } from './claim-liveness';

describe('fresh claim authority inside work callbacks', () => {
    it('preserves known security evidence when the renewal transport is unavailable', async () => {
        const env = { renew: async () => { throw new Error('cell unavailable'); } } as unknown as EnvironmentRuntime;
        expect(await checkClaimLease(env, 'claim', 'runtime', { side: 'pr', securityOf: async () => 'exfiltration' }))
            .toEqual({ claimId: 'claim', side: 'pr', reason: 'security', signature: 'exfiltration' });
    });

    it('preserves cancellation identity from the renewal call', async () => {
        const cancellation = Object.assign(new Error('cancelled'), { name: 'DBOSWorkflowCancelledError' });
        const env = { renew: async () => { throw cancellation; } } as unknown as EnvironmentRuntime;
        await expect(checkClaimLease(env, 'claim', 'runtime')).rejects.toBe(cancellation);
    });

    it('records only closed renewal failure data', async () => {
        const env = { renew: async () => { throw new Error('SECRET token and upstream body'); } } as unknown as EnvironmentRuntime;
        expect(await checkClaimLease(env, 'claim', 'runtime', { side: 'base' })).toEqual({ claimId: 'claim', side: 'base', reason: 'renew_failed' });
    });

    it('checks security records before classifying a gone Run claim', async () => {
        const env = { renew: async () => ({ status: 'gone' }) } as unknown as EnvironmentRuntime;
        const failure = await checkClaimLease(env, 'claim', 'runtime', { side: 'pr', securityOf: async () => 'exfiltration' });
        expect(failure).toEqual({ claimId: 'claim', side: 'pr', reason: 'security', signature: 'exfiltration' });
        expect(() => throwClaimLeaseFailure(failure!)).toThrow(expect.objectContaining({ name: 'SecurityViolationError', side: 'pr', signature: 'exfiltration' }));
    });

    it('uses the requested consumer and accepts a fresh authoritative renewal', async () => {
        const renew = jest.fn(async () => ({ status: 'renewed', leaseExpiresAt: '2030-01-01T00:45:00Z', hardExpiresAt: '2030-01-01T00:45:00Z', atCeiling: true }));
        expect(await checkClaimLease({ renew } as unknown as EnvironmentRuntime, 'setup-claim', 'setup')).toBeUndefined();
        expect(renew).toHaveBeenCalledWith('setup-claim', 'setup');
    });
});
