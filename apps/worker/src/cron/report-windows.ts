/**
 * Pure date-window helpers for the report crons. Kept dependency-free (no
 * NestJS / use-case imports) and `now`-injectable so the cadence math can be
 * unit-tested deterministically.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Previous calendar month in UTC as YYYY-MM-DD strings. Fired on the 1st, this
 * covers the month that just ended (1st → last day), and rolls the year over
 * correctly in January.
 */
export function previousCalendarMonthUtc(now: Date = new Date()): {
    startDate: string;
    endDate: string;
} {
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth(); // 0-11, current month
    const start = new Date(Date.UTC(year, month - 1, 1));
    const end = new Date(Date.UTC(year, month, 0)); // day 0 = last day of prev month
    return {
        startDate: start.toISOString().slice(0, 10),
        endDate: end.toISOString().slice(0, 10),
    };
}

/**
 * The `days`-day window ending yesterday (UTC), as YYYY-MM-DD strings. Ending
 * yesterday avoids counting a partial "today".
 */
export function precedingWindowUtc(
    days: number,
    now: Date = new Date(),
): { startDate: string; endDate: string } {
    const end = new Date(now.getTime() - DAY_MS);
    const start = new Date(end.getTime() - (days - 1) * DAY_MS);
    return {
        startDate: start.toISOString().slice(0, 10),
        endDate: end.toISOString().slice(0, 10),
    };
}
