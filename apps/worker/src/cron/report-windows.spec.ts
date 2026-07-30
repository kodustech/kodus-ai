import {
    precedingWindowUtc,
    previousCalendarMonthUtc,
} from './report-windows';

const at = (iso: string) => new Date(`${iso}T09:00:00Z`);

describe('report cron windows', () => {
    describe('previousCalendarMonthUtc (org report — fires on the 1st)', () => {
        it('covers the full previous calendar month', () => {
            expect(previousCalendarMonthUtc(at('2026-07-01'))).toEqual({
                startDate: '2026-06-01',
                endDate: '2026-06-30',
            });
        });

        it('handles a 28-day February (non-leap)', () => {
            expect(previousCalendarMonthUtc(at('2026-03-01'))).toEqual({
                startDate: '2026-02-01',
                endDate: '2026-02-28',
            });
        });

        it('handles a 29-day February (leap year)', () => {
            expect(previousCalendarMonthUtc(at('2024-03-01'))).toEqual({
                startDate: '2024-02-01',
                endDate: '2024-02-29',
            });
        });

        it('rolls the year back in January', () => {
            expect(previousCalendarMonthUtc(at('2026-01-01'))).toEqual({
                startDate: '2025-12-01',
                endDate: '2025-12-31',
            });
        });
    });

    describe('precedingWindowUtc (repo report — 15-day window)', () => {
        it('ends yesterday and spans 15 inclusive days', () => {
            expect(precedingWindowUtc(15, at('2026-06-16'))).toEqual({
                startDate: '2026-06-01',
                endDate: '2026-06-15',
            });
        });

        it('works for the 1st-of-month firing (crosses month)', () => {
            expect(precedingWindowUtc(15, at('2026-06-01'))).toEqual({
                startDate: '2026-05-17',
                endDate: '2026-05-31',
            });
        });

        it('rolls the year back across Jan 1', () => {
            expect(precedingWindowUtc(15, at('2026-01-01'))).toEqual({
                startDate: '2025-12-17',
                endDate: '2025-12-31',
            });
        });
    });
});
