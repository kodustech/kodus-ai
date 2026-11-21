import { HARD_EXPIRY_MINUTES, LEASE_TTL_MINUTES, READY_TIMEOUT_MINUTES } from './environment-runtime';

// Every wait on a claim comes from its ceiling: a boot the hub still waits
// for is never one the cell already destroyed, and the lease never outlives it.
describe('claim ceilings', () => {
    const consumers = Object.keys(HARD_EXPIRY_MINUTES) as Array<keyof typeof HARD_EXPIRY_MINUTES>;

    it.each(consumers)('%s: the hub stops waiting for claim.ready before the ceiling', (c) => {
        expect(READY_TIMEOUT_MINUTES[c]).toBeGreaterThan(0);
        expect(READY_TIMEOUT_MINUTES[c]).toBeLessThan(HARD_EXPIRY_MINUTES[c]);
    });

    it.each(consumers)('%s: the lease never outlives the ceiling', (c) => {
        expect(LEASE_TTL_MINUTES[c]).toBeLessThanOrEqual(HARD_EXPIRY_MINUTES[c]);
    });

    it('a setup waits for its build until a minute before its ceiling', () => {
        expect(READY_TIMEOUT_MINUTES.setup).toBe(HARD_EXPIRY_MINUTES.setup - 1);
    });
});
