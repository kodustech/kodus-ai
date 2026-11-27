import { HARD_EXPIRY_MINUTES, LEASE_TTL_MINUTES, READY_TIMEOUT_MINUTES } from './environment-runtime';
import { setupBootMsOf } from '../run/environment-setup';

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

    // docs/runtime/e2e-suites.md 12.1: the PR build keeps its 45 min boot budget and the suite's timers start after it:
    // 60 min for the whole suite run, so the machines live 45 + 60 min, inside a boat host's 120 min.
    it('a suite claim waits for the PR build as long as a setup does, and lives for that build plus the suite run total', () => {
        expect(READY_TIMEOUT_MINUTES.suite).toBe(45);
        expect(HARD_EXPIRY_MINUTES.suite).toBe(45 + 60);
        expect(HARD_EXPIRY_MINUTES.suite).toBeLessThan(120);
        // Renewed like a Run's: the first lease is a Run's, never past the ceiling.
        expect(LEASE_TTL_MINUTES.suite).toBe(LEASE_TTL_MINUTES.runtime);
    });
});

describe('setupBootMsOf', () => {
    it('is the latest done boot step, and nothing without one', () => {
        expect(setupBootMsOf([{ name: 'boot', state: 'failed', durationMs: 5 }, { name: 'boot', state: 'done', durationMs: 878_000 }, { name: 'ready', state: 'done', durationMs: 9 }])).toBe(878_000);
        expect(setupBootMsOf([{ name: 'boot', state: 'failed', durationMs: 5 }])).toBeUndefined();
        expect(setupBootMsOf(undefined)).toBeUndefined();
    });
});
