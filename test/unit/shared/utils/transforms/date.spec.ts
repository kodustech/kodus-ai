import moment from 'moment';

import { getDayForFilter } from '@/shared/utils/transforms/date';

describe('getDayForFilter Function', () => {
    // `getDayForFilter` reads `new Date()` and the expectation below reads
    // the clock again, so a second ticking between the two made this fail
    // with a one-second difference — it did, on CI. Freezing the clock keeps
    // what the test is actually about (the subtraction) and removes the race.
    afterEach(() => {
        jest.useRealTimers();
    });

    test('should correctly subtract days from the current date', () => {
        jest.useFakeTimers().setSystemTime(
            new Date('2026-01-15T10:30:45.500Z'),
        );

        const days = 7;
        const { dateAfterDaysInformed } = getDayForFilter(days);

        const expectedDateAfterDaysInformed = moment()
            .subtract(days, 'days')
            .format('YYYY-MM-DD HH:mm:ss');
        expect(dateAfterDaysInformed).toBe(expectedDateAfterDaysInformed);
    });

    test('is stable across a second boundary — the flake this had', () => {
        // The exact shape that broke: the clock advances between the call and
        // the expectation. The formatted result must not depend on it.
        const frozen = new Date('2026-01-15T10:30:59.900Z');
        jest.useFakeTimers().setSystemTime(frozen);

        const { dateAfterDaysInformed } = getDayForFilter(7);
        jest.advanceTimersByTime(200); // the second turns over here

        // Derived from the frozen instant, so the assertion does not depend
        // on the runner's timezone — only on the clock not moving the result.
        expect(dateAfterDaysInformed).toBe(
            moment(frozen).subtract(7, 'days').format('YYYY-MM-DD HH:mm:ss'),
        );
    });

    test('should correctly handle custom start date', () => {
        const days = 7;
        const startDate = new Date('2024-01-01T00:00:00Z');
        const { today, dateAfterDaysInformed } = getDayForFilter(
            days,
            startDate,
        );

        const expectedToday = moment(startDate).format('YYYY-MM-DD HH:mm:ss');
        const expectedDateAfterDaysInformed = moment(startDate)
            .subtract(days, 'days')
            .format('YYYY-MM-DD HH:mm:ss');

        expect(today).toBe(expectedToday);
        expect(dateAfterDaysInformed).toBe(expectedDateAfterDaysInformed);
    });

    test('should return the current date and date after days informed when no start date is provided', () => {
        const { today, dateAfterDaysInformed } = getDayForFilter(0);

        const expectedToday = moment().format('YYYY-MM-DD HH:mm:ss');
        expect(today).toBe(expectedToday);
        expect(dateAfterDaysInformed).toBe(expectedToday); // When 0 days are subtracted, today and dateAfterDaysInformed should be the same
    });
});
