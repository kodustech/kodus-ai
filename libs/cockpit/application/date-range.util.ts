const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function assertIsoDate(value: string, label: string): void {
    if (!DATE_RE.test(value)) {
        throw new Error(`Invalid ${label}. Expected YYYY-MM-DD, got "${value}"`);
    }
}

export interface PreviousPeriod {
    startDate: string;
    endDate: string;
}

/**
 * Same rule the legacy service used: the previous window has the same
 * duration as the current one and ends the day before the current window
 * starts. Keeping the semantics identical matters for parity diffing
 * during rollout.
 */
export function computePreviousPeriod(
    startDate: string,
    endDate: string,
): PreviousPeriod {
    assertIsoDate(startDate, 'startDate');
    assertIsoDate(endDate, 'endDate');

    const currentStart = new Date(`${startDate}T00:00:00Z`);
    const currentEnd = new Date(`${endDate}T00:00:00Z`);
    const durationMs = currentEnd.getTime() - currentStart.getTime();

    const previousEnd = new Date(currentStart.getTime() - 24 * 60 * 60 * 1000);
    const previousStart = new Date(previousEnd.getTime() - durationMs);

    return {
        startDate: previousStart.toISOString().slice(0, 10),
        endDate: previousEnd.toISOString().slice(0, 10),
    };
}

export function computeTrend(
    current: number,
    previous: number,
    directionOfImprovement: 'up' | 'down',
): { percentageChange: number; trend: 'improved' | 'worsened' | 'unchanged' } {
    let percentageChange = 0;
    let trend: 'improved' | 'worsened' | 'unchanged' = 'unchanged';

    if (previous > 0) {
        percentageChange = Number(
            (((current - previous) / previous) * 100).toFixed(2),
        );
        if (percentageChange === 0) {
            trend = 'unchanged';
        } else if (directionOfImprovement === 'up') {
            trend = percentageChange > 0 ? 'improved' : 'worsened';
        } else {
            trend = percentageChange < 0 ? 'improved' : 'worsened';
        }
    } else if (current > 0) {
        percentageChange = 100;
        trend = directionOfImprovement === 'up' ? 'improved' : 'worsened';
    }

    return { percentageChange, trend };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The `n` most-recent COMPLETE ISO weeks (Mon–Sun) at or before `endDate`.
 * A rolling 28-day window straddles 5 ISO weeks when it ends mid-week, which
 * makes a "last 4 weeks" chart render 5 bars with partial edges. Aligning to
 * full weeks gives exactly `n` complete bars — the current, partial week is
 * excluded (its count is incomplete and reads like a crash). When `endDate`
 * itself is a Sunday, that week is complete and counts.
 */
export function lastNCompleteWeeks(
    endDate: string,
    weeks: number,
): { startDate: string; endDate: string } {
    const d = new Date(`${endDate}T00:00:00Z`);
    const dow = d.getUTCDay(); // 0 = Sunday
    const lastCompleteSunday =
        dow === 0
            ? d
            : new Date(d.getTime() - (((dow + 6) % 7) + 1) * DAY_MS);
    const start = new Date(
        lastCompleteSunday.getTime() - (weeks * 7 - 1) * DAY_MS,
    );
    return {
        startDate: start.toISOString().slice(0, 10),
        endDate: lastCompleteSunday.toISOString().slice(0, 10),
    };
}

/**
 * The `n` calendar months ending with the month of `endDate`, oldest first —
 * each with its first day, last day, and short label. Used for the org
 * report's implementation-rate evolution.
 */
export function lastNMonths(
    endDate: string,
    n: number,
): { monthStart: string; monthEnd: string; label: string }[] {
    const base = new Date(`${endDate}T00:00:00Z`);
    const baseYear = base.getUTCFullYear();
    const baseMonth = base.getUTCMonth(); // 0-11

    const out: { monthStart: string; monthEnd: string; label: string }[] = [];
    for (let i = n - 1; i >= 0; i--) {
        const d = new Date(Date.UTC(baseYear, baseMonth - i, 1));
        const year = d.getUTCFullYear();
        const month = d.getUTCMonth();
        const monthStart = new Date(Date.UTC(year, month, 1));
        const monthEnd = new Date(Date.UTC(year, month + 1, 0)); // last day
        out.push({
            monthStart: monthStart.toISOString().slice(0, 10),
            monthEnd: monthEnd.toISOString().slice(0, 10),
            label: monthStart.toLocaleDateString('en-US', {
                month: 'short',
                timeZone: 'UTC',
            }),
        });
    }
    return out;
}
