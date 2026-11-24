import { nextRunAt } from './scan-schedule';

describe('nextRunAt', () => {
    it('is the next 03:00 UTC for a daily schedule', () => {
        expect(nextRunAt('daily', new Date('2026-11-24T15:00:00Z')).toISOString()).toBe(
            '2026-11-25T03:00:00.000Z',
        );
        expect(nextRunAt('daily', new Date('2026-11-24T01:00:00Z')).toISOString()).toBe(
            '2026-11-24T03:00:00.000Z',
        );
    });

    it('is a week after the last run for a weekly schedule', () => {
        expect(
            nextRunAt(
                'weekly',
                new Date('2026-11-24T03:05:00Z'),
                new Date('2026-11-24T03:00:00Z'),
            ).toISOString(),
        ).toBe('2026-12-01T03:00:00.000Z');
    });

    it('is the next 03:00 UTC for a weekly schedule that never ran', () => {
        expect(nextRunAt('weekly', new Date('2026-11-24T15:00:00Z')).toISOString()).toBe(
            '2026-11-25T03:00:00.000Z',
        );
    });
});
