import type { StaleInboxHolder } from '@libs/core/workflow/domain/contracts/inbox-message.repository.contract';

/**
 * Text for work a dead worker left behind, found by the reapers long after
 * it happened (150 min for a code review lock, 180 min for a job): when
 * the work was taken, by whom, and which PRs lost their review, so it is
 * not read as a failure happening now on the host that ran the reaper.
 */

const MAX_LISTED = 5;

const hhmm = (iso?: string) => (iso ? `${iso.slice(11, 19)}Z` : '?');

function span(oldest?: string, newest?: string): string {
    if (!oldest) return '';
    return oldest === newest || !newest
        ? `at ${hhmm(oldest)}`
        : `between ${hhmm(oldest)} and ${hhmm(newest)}`;
}

/** "held by ip-a (9), ip-b (2), taken between 11:30:12Z and 11:39:55Z" */
export function describeStaleHolders(holders: StaleInboxHolder[]): string {
    if (!holders.length) return '';
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
    const when = span(oldest, newest);
    return `held by ${listed}${more}${when ? `, taken ${when}` : ''}`;
}

export interface LostJobSummary {
    startedAt?: Date | string | null;
    repository?: string;
    prNumber?: number;
}

/** " Started between 13:20:41Z and 13:29:58Z. Most affected: a/b#1 (2), c/d#7." */
export function describeLostJobs(jobs: LostJobSummary[]): string {
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
    const when = span(started[0], started[started.length - 1]);
    return (
        (when ? ` Started ${when}.` : '') +
        (top ? ` Most affected: ${top}.` : '')
    );
}
