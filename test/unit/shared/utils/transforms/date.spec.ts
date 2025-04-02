import * as moment from 'moment';
import { getDayForFilter } from '../../../../../src/shared/utils/transforms/date';

describe('getDayForFilter Function', () => {
    test('should correctly subtract days from the current date', () => {
        const days = 7;
        const { dateAfterDaysInformed } = getDayForFilter(days);

        const expectedDateAfterDaysInformed = moment().subtract(days, 'days').format('YYYY-MM-DD HH:mm:ss');
        expect(dateAfterDaysInformed).toBe(expectedDateAfterDaysInformed);
    });

    test('should correctly handle custom start date', () => {
        const days = 7;
        const startDate = new Date('2024-01-01T00:00:00Z');
        const { today, dateAfterDaysInformed } = getDayForFilter(days, startDate);

        const expectedToday = moment(startDate).format('YYYY-MM-DD HH:mm:ss');
        const expectedDateAfterDaysInformed = moment(startDate).subtract(days, 'days').format('YYYY-MM-DD HH:mm:ss');

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
