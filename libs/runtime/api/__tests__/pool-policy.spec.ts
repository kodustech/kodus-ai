import {
    countPoolUsage,
    desiredPoolSize,
    insideSchedule,
    InvalidPoolPolicyError,
    parsePoolPolicy,
    poolMonthlyEstimate,
    poolSpentUsd,
    scheduleHoursPerWeek,
    type PoolPolicy,
} from '../domain/pool';

// São Paulo is UTC-3 all year (no daylight saving since 2019).
const sp = (iso: string) => new Date(`${iso}-03:00`);
const weekdays: PoolPolicy = { schedule: { timezone: 'America/Sao_Paulo', days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '08:00', end: '19:00' } };

describe('pool policy', () => {
    it('keeps the size all the time without a policy, and nothing at size 0', () => {
        expect(desiredPoolSize({ size: 2, now: sp('2026-11-08T03:00') })).toEqual({ size: 2, reason: 'always' });
        expect(desiredPoolSize({ size: 0, policy: weekdays, now: sp('2026-11-04T10:00') })).toEqual({ size: 0, reason: 'off' });
    });

    it('reads the schedule in its own time zone, the end excluded', () => {
        // 2026-11-04 is a Wednesday.
        expect(insideSchedule(weekdays.schedule!, sp('2026-11-04T08:00'))).toBe(true);
        expect(insideSchedule(weekdays.schedule!, sp('2026-11-04T18:59'))).toBe(true);
        expect(insideSchedule(weekdays.schedule!, sp('2026-11-04T19:00'))).toBe(false);
        expect(insideSchedule(weekdays.schedule!, sp('2026-11-04T07:59'))).toBe(false);
        expect(insideSchedule(weekdays.schedule!, sp('2026-11-08T10:00'))).toBe(false); // Sunday
        // 10:00 UTC is 07:00 in São Paulo: outside, though it is inside in UTC.
        expect(insideSchedule(weekdays.schedule!, new Date('2026-11-04T10:00:00Z'))).toBe(false);
    });

    it('a window past midnight belongs to the day it starts on', () => {
        const night = { timezone: 'America/Sao_Paulo', days: ['fri' as const], start: '22:00', end: '02:00' };
        expect(insideSchedule(night, sp('2026-11-06T23:00'))).toBe(true); // Friday night
        expect(insideSchedule(night, sp('2026-11-07T01:30'))).toBe(true); // early Saturday
        expect(insideSchedule(night, sp('2026-11-07T23:00'))).toBe(false); // Saturday night
        expect(scheduleHoursPerWeek(night)).toBe(4);
        expect(scheduleHoursPerWeek(weekdays.schedule!)).toBe(55);
    });

    it('warms for a while after a pull request, inside or outside the schedule', () => {
        const both: PoolPolicy = { ...weekdays, onPullRequest: { idleMinutes: 60 } };
        const night = sp('2026-11-04T22:00');
        expect(desiredPoolSize({ size: 2, policy: both, now: night })).toEqual({ size: 0, reason: 'outside_schedule' });
        expect(desiredPoolSize({ size: 2, policy: both, now: night, lastPullRequestAt: sp('2026-11-04T21:30').toISOString() })).toEqual({
            size: 2,
            reason: 'pull_request',
        });
        expect(desiredPoolSize({ size: 2, policy: both, now: night, lastPullRequestAt: sp('2026-11-04T20:30').toISOString() })).toEqual({
            size: 0,
            reason: 'outside_schedule',
        });
        const onlyPr: PoolPolicy = { onPullRequest: { idleMinutes: 30 } };
        expect(desiredPoolSize({ size: 1, policy: onlyPr, now: night })).toEqual({ size: 0, reason: 'idle' });
        // An activity time in the future (clock skew) does not count.
        expect(desiredPoolSize({ size: 1, policy: onlyPr, now: night, lastPullRequestAt: sp('2026-11-04T23:00').toISOString() })).toEqual({
            size: 0,
            reason: 'idle',
        });
    });

    it('a spent budget turns the pool off whatever the schedule says', () => {
        const capped: PoolPolicy = { monthlyBudgetUsd: 50 };
        expect(desiredPoolSize({ size: 2, policy: capped, now: sp('2026-11-04T10:00'), spentUsd: 49.99 })).toEqual({ size: 2, reason: 'always' });
        expect(desiredPoolSize({ size: 2, policy: { ...weekdays, ...capped }, now: sp('2026-11-04T10:00'), spentUsd: 50 })).toEqual({
            size: 0,
            reason: 'budget',
        });
    });

    it('estimates the month at list price; with only the pull request trigger it depends on activity', () => {
        expect(poolMonthlyEstimate(2, null, 0.4)).toEqual({ hours: 731, usd: 584.4 });
        expect(poolMonthlyEstimate(2, weekdays, 0.4)).toEqual({ hours: 239, usd: 191.32 });
        expect(poolMonthlyEstimate(2, { onPullRequest: { idleMinutes: 60 } }, 0.4)).toEqual({ hours: null, usd: null });
        expect(poolMonthlyEstimate(0, null, 0.4)).toEqual({ hours: 0, usd: 0 });
    });

    it('counts usage by the month, never billing a gap longer than a tick', () => {
        const start = countPoolUsage(null, 2, new Date('2026-11-04T10:00:00Z'));
        expect(start).toEqual({ month: '2026-11', machineMinutes: 0, countedAt: '2026-11-04T10:00:00.000Z' });
        const five = countPoolUsage(start, 2, new Date('2026-11-04T10:05:00Z'));
        expect(five.machineMinutes).toBe(10);
        expect(countPoolUsage(five, 2, new Date('2026-11-04T13:05:00Z')).machineMinutes).toBe(40);
        expect(countPoolUsage(five, 2, new Date('2026-12-01T00:01:00Z'))).toMatchObject({ month: '2026-12', machineMinutes: 0 });
        expect(poolSpentUsd({ month: '2026-11', machineMinutes: 600, countedAt: '' }, new Date('2026-11-20T00:00:00Z'), 0.4)).toBe(4);
        expect(poolSpentUsd({ month: '2026-10', machineMinutes: 600, countedAt: '' }, new Date('2026-11-20T00:00:00Z'), 0.4)).toBe(0);
    });

    it('parses an admin policy and refuses what it cannot run', () => {
        expect(parsePoolPolicy(null)).toBeNull();
        expect(
            parsePoolPolicy({
                schedule: { timezone: 'America/Sao_Paulo', days: ['fri', 'mon'], start: '08:00', end: '19:00' },
                onPullRequest: { idleMinutes: 60 },
                monthlyBudgetUsd: 49.999,
            }),
        ).toEqual({
            schedule: { timezone: 'America/Sao_Paulo', days: ['mon', 'fri'], start: '08:00', end: '19:00' },
            onPullRequest: { idleMinutes: 60 },
            monthlyBudgetUsd: 50,
        });
        for (const bad of [
            [],
            { extra: 1 },
            { schedule: { timezone: 'Mars/Olympus', days: ['mon'], start: '08:00', end: '19:00' } },
            { schedule: { timezone: 'UTC', days: [], start: '08:00', end: '19:00' } },
            { schedule: { timezone: 'UTC', days: ['monday'], start: '08:00', end: '19:00' } },
            { schedule: { timezone: 'UTC', days: ['mon'], start: '8:00', end: '19:00' } },
            { schedule: { timezone: 'UTC', days: ['mon'], start: '08:00', end: '08:00' } },
            { onPullRequest: { idleMinutes: 5 } },
            { onPullRequest: { idleMinutes: 60, also: 1 } },
            { monthlyBudgetUsd: 0 },
            { monthlyBudgetUsd: '50' },
        ]) {
            expect(() => parsePoolPolicy(bad)).toThrow(InvalidPoolPolicyError);
        }
    });
});
