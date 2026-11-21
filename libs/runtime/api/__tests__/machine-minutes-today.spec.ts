import { machineMinutesToday } from '../domain/machine-minutes-today';

const NOW = new Date('2026-11-12T15:20:00.000Z');

describe('the org machine minutes of today', () => {
    it('counts the ceilings still reserved by running machines against the limit, apart from what they already held', () => {
        const today = machineMinutesToday({ seconds: 70 * 60, heldSeconds: 25 * 60, openRounds: 1 }, 100, NOW);
        expect(today).toMatchObject({ limitMinutes: 100, committedMinutes: 70, usedMinutes: 25, openRounds: 1, remainingMinutes: 30 });
    });

    it('resets at the next 00:00 UTC', () => {
        expect(machineMinutesToday({ seconds: 0, heldSeconds: 0, openRounds: 0 }, 100, NOW).resetsAt).toBe('2026-11-13T00:00:00.000Z');
    });

    it('has no limit and nothing remaining to count down when the deployment sets 0', () => {
        expect(machineMinutesToday({ seconds: 5_000 * 60, heldSeconds: 60, openRounds: 0 }, 0, NOW)).toMatchObject({ limitMinutes: null, remainingMinutes: null, committedMinutes: 5_000 });
    });

    it('never shows more minutes used than committed, nor less than zero remaining', () => {
        const today = machineMinutesToday({ seconds: 130 * 60, heldSeconds: 140 * 60, openRounds: 0 }, 100, NOW);
        expect(today.usedMinutes).toBeLessThanOrEqual(today.committedMinutes);
        expect(today.remainingMinutes).toBe(0);
    });
});
