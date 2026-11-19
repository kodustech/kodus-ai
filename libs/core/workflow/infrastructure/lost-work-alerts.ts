import type { StaleInboxHolder } from '@libs/core/workflow/domain/contracts/inbox-message.repository.contract';

/**
 * Alert text for work a dead worker left behind, found by the reapers long
 * after it happened (150 min for a code review message, 180 min for a
 * job). The host that sends these is only the one that ran the reaper; the
 * text says when the work was taken and by whom, so an alert is not read
 * as a failure happening now on the sender.
 */

const MAX_LISTED = 5;

const hhmm = (iso?: string) => (iso ? `${iso.slice(11, 19)}Z` : '?');

function span(oldest?: string, newest?: string): string {
    if (!oldest) return '';
    return oldest === newest || !newest
        ? ` at ${hhmm(oldest)}`
        : ` between ${hhmm(oldest)} and ${hhmm(newest)}`;
}

export function describeInboxReclaim(
    consumerId: string,
    reclaimed: number,
    timeoutMs: number,
    holders: StaleInboxHolder[],
): string {
    const minutes = Math.round(timeoutMs / 60_000);
    const oldest = holders
        .map((h) => h.oldestLockedAt)
        .filter(Boolean)
        .sort()[0];
    const newest = holders
        .map((h) => h.newestLockedAt)
        .filter(Boolean)
        .sort()
        .pop();
    const listed = holders
        .slice(0, MAX_LISTED)
        .map((h) => `${h.lockedBy} (${h.count})`)
        .join(', ');
    const more =
        holders.length > MAX_LISTED
            ? ` and ${holders.length - MAX_LISTED} more`
            : '';
    const owners = listed
        ? ` They were held by ${listed}${more}, which stopped without releasing them (crash, health-check kill, OOM or deploy).`
        : ' Their workers stopped without releasing them (crash, health-check kill, OOM or deploy).';
    return (
        `High inbox reclaim rate for ${consumerId}: ${reclaimed} messages stuck in PROCESSING for over ${minutes} min were reclaimed (taken${span(oldest, newest)}).` +
        owners +
        ' This reports work lost back then; the sending host only ran the reaper.'
    );
}

export interface ReapedJobSummary {
    startedAt?: Date | string | null;
    repository?: string;
    prNumber?: number;
}

export function describeStaleJobReap(
    reapedCount: number,
    staleTimeoutMinutes: number,
    jobs: ReapedJobSummary[],
): string {
    const started = jobs
        .map((j) => (j.startedAt ? new Date(j.startedAt).toISOString() : ''))
        .filter(Boolean)
        .sort();
    const prs = new Map<string, number>();
    for (const j of jobs) {
        if (!j.repository) continue;
        const key = j.prNumber ? `${j.repository}#${j.prNumber}` : j.repository;
        prs.set(key, (prs.get(key) ?? 0) + 1);
    }
    const top = [...prs.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, MAX_LISTED)
        .map(([k, n]) => (n > 1 ? `${k} (${n})` : k))
        .join(', ');
    return (
        `High stale-job reap rate: ${reapedCount} workflow jobs orphaned in PROCESSING for over ${staleTimeoutMinutes} min were marked FAILED (started${span(started[0], started[started.length - 1])}); those reviews never finished.` +
        (top ? ` Most affected: ${top}.` : '') +
        ' Their workers died or were killed back then (crash, health-check kill, OOM or deploy); the sending host only ran the reaper.'
    );
}
