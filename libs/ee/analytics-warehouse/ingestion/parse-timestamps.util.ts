/**
 * The Mongo `pullRequests` collection stores timestamps as strings
 * ("openedAt", "closedAt", "createdAt" on the PR and on each commit).
 * The warehouse wants real timestamps so cockpit queries can skip the
 * SAFE_CAST dance BigQuery had to do on every read.
 */
export function parseTimestamp(raw: unknown): Date | null {
    if (raw == null) return null;
    if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? null : raw;

    if (typeof raw === 'number') {
        const d = new Date(raw);
        return Number.isNaN(d.getTime()) ? null : d;
    }

    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    if (!trimmed) return null;

    const d = new Date(trimmed);
    return Number.isNaN(d.getTime()) ? null : d;
}
