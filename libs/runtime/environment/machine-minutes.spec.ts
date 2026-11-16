import { claimCeilingSeconds, decideMachineMinutes, machineMinutesExhausted, remainingMachineMinutes } from './machine-minutes';

describe('org machine-minute budget', () => {
    it('admits a claim whose ceiling fits in what is left of the org day', () => {
        expect(decideMachineMinutes({ spentSeconds: 40 * 60, needSeconds: 60 * 60, limitMinutes: 100 })).toEqual({ allowed: true });
    });

    it('refuses a claim whose ceiling does not fit in what is left, naming the minutes spent and the limit', () => {
        expect(decideMachineMinutes({ spentSeconds: 41 * 60, needSeconds: 60 * 60, limitMinutes: 100 })).toEqual({ allowed: false, spentMinutes: 41, limitMinutes: 100, needMinutes: 60 });
    });

    it('admits every claim when the limit is 0 (unlimited)', () => {
        expect(decideMachineMinutes({ spentSeconds: 10_000_000, needSeconds: 240 * 60, limitMinutes: 0 })).toEqual({ allowed: true });
    });

    it('counts a started minute as spent when it names the minutes of a refusal', () => {
        expect(decideMachineMinutes({ spentSeconds: 59 * 60 + 1, needSeconds: 45 * 60, limitMinutes: 100 })).toMatchObject({ allowed: false, spentMinutes: 60 });
    });

    it('leaves the limit minus what the day committed, never below zero, and nothing to count when unlimited', () => {
        expect(remainingMachineMinutes(30 * 60 + 1, 100)).toBe(69);
        expect(remainingMachineMinutes(200 * 60, 100)).toBe(0);
        expect(remainingMachineMinutes(200 * 60, 0)).toBeNull();
    });

    it("reserves a claim's whole ceiling by its consumer", () => {
        expect(claimCeilingSeconds('runtime')).toBe(60 * 60);
        expect(claimCeilingSeconds('setup')).toBe(45 * 60);
        expect(claimCeilingSeconds('mcp')).toBe(240 * 60);
    });

    it('answers a refusal as a resources blocker the worker does not wait on', () => {
        expect(machineMinutesExhausted({ allowed: false, spentMinutes: 990, limitMinutes: 1_000, needMinutes: 60 })).toEqual({
            status: 'blocked',
            blockers: [
                {
                    kind: 'resources',
                    signature: 'machine_minutes_exhausted',
                    message: expect.stringContaining('990 of its 1000 machine minutes'),
                },
            ],
        });
    });
});
