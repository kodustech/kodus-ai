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
