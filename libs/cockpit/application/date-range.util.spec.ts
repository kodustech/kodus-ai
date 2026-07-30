import {
    computePreviousPeriod,
    lastNCompleteWeeks,
    lastNMonths,
} from './date-range.util';

describe('date-range.util', () => {
    describe('computePreviousPeriod', () => {
        it('returns an equal-length window ending the day before', () => {
            // 15-day window → previous 15-day window immediately before it.
            expect(
                computePreviousPeriod('2026-06-01', '2026-06-15'),
            ).toEqual({
                startDate: '2026-05-17',
                endDate: '2026-05-31',
            });
        });
    });

    describe('lastNCompleteWeeks', () => {
        it('aligns to 4 full Mon–Sun weeks, excluding the partial current week', () => {
            // 2026-06-24 is a Wednesday → current (partial) week is Jun 22–28.
            // Last 4 complete weeks: Mon 2026-05-25 .. Sun 2026-06-21.
            expect(lastNCompleteWeeks('2026-06-24', 4)).toEqual({
                startDate: '2026-05-25',
                endDate: '2026-06-21',
            });
        });

        it('includes the endDate week when endDate is a Sunday', () => {
            // 2026-06-21 is a Sunday → that week is complete and counts.
            expect(lastNCompleteWeeks('2026-06-21', 4)).toEqual({
                startDate: '2026-05-25',
                endDate: '2026-06-21',
            });
        });

        it('a Monday endDate falls back to the prior complete week', () => {
            // 2026-06-22 is a Monday (start of a partial week) → last complete
            // week ends the day before, Sun 2026-06-21.
            expect(lastNCompleteWeeks('2026-06-22', 1)).toEqual({
                startDate: '2026-06-15',
                endDate: '2026-06-21',
            });
        });
    });

    describe('lastNMonths', () => {
        it('returns the 3 months ending with endDate, oldest first', () => {
            expect(lastNMonths('2026-06-15', 3)).toEqual([
                { monthStart: '2026-04-01', monthEnd: '2026-04-30', label: 'Apr' },
                { monthStart: '2026-05-01', monthEnd: '2026-05-31', label: 'May' },
                { monthStart: '2026-06-01', monthEnd: '2026-06-30', label: 'Jun' },
            ]);
        });

        it('rolls the year back when the window crosses January', () => {
            expect(lastNMonths('2026-01-15', 3)).toEqual([
                { monthStart: '2025-11-01', monthEnd: '2025-11-30', label: 'Nov' },
                { monthStart: '2025-12-01', monthEnd: '2025-12-31', label: 'Dec' },
                { monthStart: '2026-01-01', monthEnd: '2026-01-31', label: 'Jan' },
            ]);
        });
    });
});
