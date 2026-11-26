import type { SecurityScanBudget } from './security-scan.types';
import type { SecurityScanMode } from './coverage-ledger';

/** How often a scheduled deep scan runs. */
export type ScanCadence = 'daily' | 'weekly';

export const SCAN_CADENCES: readonly ScanCadence[] = ['daily', 'weekly'];

/** The hour (UTC) a scheduled scan is due: outside business hours in most regions. */
export const SCHEDULED_SCAN_HOUR_UTC = 3;

export interface SecurityScanSchedule {
    uuid: string;
    organizationId: string;
    teamId: string;
    repository: { platform: string; host: string; id: string };
    cadence: ScanCadence;
    budget: SecurityScanBudget;
    mode: SecurityScanMode;
    /** The model the scheduled scans run on; the routing's when unset. */
    modelId?: string;
    enabled: boolean;
    nextRunAt: string;
    lastRunAt?: string;
    lastScanId?: string;
    /** Why the last due run did not start, said to the person who set it. */
    lastError?: string;
    createdBy?: { userId?: string; email?: string };
}

/**
 * The next time a schedule is due after `from`: the next SCHEDULED_SCAN_HOUR_UTC
 * for a daily one; for a weekly one, a week after the last run, or the next
 * such hour when it never ran.
 */
export function nextRunAt(
    cadence: ScanCadence,
    from: Date,
    lastRunAt?: Date,
): Date {
    const next = new Date(
        Date.UTC(
            from.getUTCFullYear(),
            from.getUTCMonth(),
            from.getUTCDate(),
            SCHEDULED_SCAN_HOUR_UTC,
        ),
    );
    if (next.getTime() <= from.getTime()) {
        next.setUTCDate(next.getUTCDate() + 1);
    }
    if (cadence === 'weekly' && lastRunAt) {
        const week = new Date(lastRunAt.getTime() + 7 * 24 * 60 * 60 * 1000);
        while (next.getTime() < week.getTime() - 60 * 60 * 1000) {
            next.setUTCDate(next.getUTCDate() + 1);
        }
    }
    return next;
}
