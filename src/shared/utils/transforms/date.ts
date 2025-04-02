import { STRING_TIME_INTERVAL } from '@/core/domain/integrationConfigs/enums/stringTimeInterval.enum';
import { Timezone } from '@/shared/domain/enums/timezones.enum';
import * as moment from 'moment-timezone';

const generateDateFilter = (params: {
    months?: number;
    weeks?: number;
    days?: number;
    fromDate?: string;
}): { startDate: string; endDate: string } => {
    const { months = 0, weeks = 0, days = 0, fromDate } = params;
    const endDate = fromDate ? new Date(fromDate) : new Date();

    const monthsInDays = months * 30;
    const weeksInDays = weeks * 7;

    const startDate = new Date(
        endDate.getTime() -
            (monthsInDays + weeksInDays + days) * 24 * 60 * 60 * 1000,
    ).toISOString();

    return { startDate, endDate: endDate.toISOString() };
};

const getExpiryDate = (expiresIn: string): Date => {
    const timeValue = parseInt(expiresIn.slice(0, -1), 10);
    const timeUnit = expiresIn.slice(-1);

    const newDate = moment()
        .add(timeValue, timeUnit as moment.unitOfTime.DurationConstructor)
        .toDate();

    return newDate;
};

const getDayForFilter = (
    days: number,
    startDate?: Date,
): { today: string; dateAfterDaysInformed: string } => {
    if (!startDate) {
        startDate = new Date();
    }

    const baseDate = moment(startDate); // Initializes moment with the start date

    const today = baseDate.format('YYYY-MM-DD HH:mm:ss'); // 'today' represents the formatted 'start date'

    // Subtracts 'days' from the 'start date' and formats the result
    const dateAfterDaysInformed = baseDate
        .subtract(days, 'days')
        .format('YYYY-MM-DD HH:mm:ss');

    return {
        today,
        dateAfterDaysInformed,
    };
};

const getDateFormated = (date: string): string => {
    return moment(date).format('YYYY-MM-DD');
};

const getDateFormatedBR = (date: string): string => {
    return moment(date).format('DD-MM-YYYY');
};

const getCurrentDateTimeZoneBR = (): string => {
    return moment().tz(Timezone.SAO_PAULO).format('YYYY-MM-DD HH:mm');
};

const getCurrentDateTimezone = (
    timezone = Timezone.DEFAULT_TIMEZONE,
): string => {
    return moment().tz(timezone).format('YYYY-MM-DD HH:mm');
};

const adjustDateByInterval = (
    interval: STRING_TIME_INTERVAL,
    date: Date,
): Date => {
    const value = parseInt(interval.slice(1, -1));
    const unit = interval.slice(-1);

    switch (unit) {
        case 'h':
            date.setHours(date.getHours() - value);
            break;
        case 'd':
            date.setDate(date.getDate() - value);
            break;
        case 'M':
            date.setMonth(date.getMonth() - value);
            break;
        default:
            throw new Error(`Unsupported time unit: ${unit}`);
    }

    return date;
};

const getDateRangeByEnumStringTimeInterval = (
    intervalEnum: STRING_TIME_INTERVAL,
) => {
    const today = new Date();

    const startDate = adjustDateByInterval(intervalEnum, new Date(today));

    return {
        startDate: moment(startDate).format('YYYY-MM-DD HH:mm'),
        endDate: moment(today).format('YYYY-MM-DD HH:mm'),
    };
};

const getWeeksBetweenDates = (startTime: Date, endTime: Date) => {
    const startMoment = moment(startTime);
    const endMoment = moment(endTime);

    return endMoment.diff(startMoment, 'weeks');
};

const getDaysBetweenDates = (startTime: Date, endTime: Date) => {
    const startMoment = moment(startTime);
    const endMoment = moment(endTime);

    return endMoment.diff(startMoment, 'days');
};

const verifyDateInterval = (
    previousDate: string, // Adjusting the type to string
    recentDate: string, // Adjusting the type to string
): number => {
    // Converting strings to Date objects
    const previousDateObj = new Date(previousDate);
    const recentDateObj = new Date(recentDate);

    // Formatting to consider only days
    const previousDateOnly = new Date(
        previousDateObj?.getFullYear(),
        previousDateObj?.getMonth(),
        previousDateObj?.getDate(),
    );

    const recentDateOnly = new Date(
        recentDateObj?.getFullYear(),
        recentDateObj?.getMonth(),
        recentDateObj?.getDate(),
    );

    // Calculating the difference in days
    const timeDiff = Math.abs(
        recentDateOnly?.getTime() - previousDateOnly?.getTime(),
    );

    return Math.ceil(timeDiff / (1000 * 60 * 60 * 24)); // Return the number of days directly
};

const formatTime = (days, hours, minutes) => {
    return (
        [
            days > 0 ? `${days}d` : '',
            hours > 0 ? `${hours}h` : '',
            minutes > 0 ? `${minutes}m` : '',
        ]
            .filter(Boolean)
            .join(' ') || '0m'
    ); // Returns '0m' if all values are zero
};

export {
    getExpiryDate,
    getDayForFilter,
    getDateFormated,
    getDateFormatedBR,
    getCurrentDateTimeZoneBR,
    getDateRangeByEnumStringTimeInterval,
    getWeeksBetweenDates,
    getDaysBetweenDates,
    verifyDateInterval,
    formatTime,
    getCurrentDateTimezone,
    generateDateFilter,
};
