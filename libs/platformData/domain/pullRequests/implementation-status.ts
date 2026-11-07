import { ImplementationStatus } from './enums/implementationStatus.enum';

// One definition of what a suggestion's implementation status means, read by
// the implementation check, thread resolution, the dashboard and the Cockpit.

const RANK: Record<ImplementationStatus, number> = {
    [ImplementationStatus.NOT_IMPLEMENTED]: 0,
    [ImplementationStatus.PARTIALLY_IMPLEMENTED]: 1,
    [ImplementationStatus.IMPLEMENTED]: 2,
};

const ORDERED = Object.values(ImplementationStatus).sort(
    (a, b) => RANK[a] - RANK[b],
);

/** What the implementation rate counts as applied. */
export const APPLIED_IMPLEMENTATION_STATUSES: readonly ImplementationStatus[] =
    [
        ImplementationStatus.IMPLEMENTED,
        ImplementationStatus.PARTIALLY_IMPLEMENTED,
    ];

export const isImplementationStatus = (
    value: unknown,
): value is ImplementationStatus =>
    typeof value === 'string' && Object.hasOwn(RANK, value);

/** A model's answer read as one of the three statuses, or null when it is not one. */
export function normalizeImplementationStatus(
    value: unknown,
): ImplementationStatus | null {
    if (typeof value !== 'string') return null;
    const key = value
        .trim()
        .toLowerCase()
        .replace(/[\s-]+/g, '_');
    return isImplementationStatus(key) ? key : null;
}

export function isImplementationApplied(status: unknown): boolean {
    return (APPLIED_IMPLEMENTATION_STATUSES as readonly unknown[]).includes(
        status,
    );
}

/** A partial still leaves the developer something to do, so its thread stays open. */
export function resolvesSuggestionThread(status: unknown): boolean {
    return status === ImplementationStatus.IMPLEMENTED;
}

/** A legacy spelling ranks as the status it spells; a missing or unreadable value below every verdict. */
export function raisesImplementationStatus(
    stored: unknown,
    verdict: ImplementationStatus,
): boolean {
    const current = normalizeImplementationStatus(stored);
    return RANK[verdict] > (current ? RANK[current] : -1);
}

/** The stored statuses a verdict must leave alone: its own and every higher one. */
export function statusesAtOrAbove(
    verdict: ImplementationStatus,
): ImplementationStatus[] {
    return ORDERED.filter((s) => RANK[s] >= RANK[verdict]);
}

export type ImplementationUnmeasuredReason =
    /** The model call failed after its own re-issue. */
    | 'llm_error'
    /** The model answered something other than one of the three statuses. */
    | 'invalid_output'
    /** The model answered for other suggestions but not this one. */
    | 'omitted'
    /** The file's patch alone does not fit the model's context window. */
    | 'diff_too_large'
    /** Only the whole PR's diff (or no patch) was available, not the changes since the last review. */
    | 'diff_unavailable';

/** The last implementation check that looked at a suggestion. */
export interface ImplementationCheckRecord {
    checkedAt: string;
    outcome: 'decided' | 'unmeasured';
    /**
     * The last status a check decided, also when it did not overwrite a higher
     * stored one. An unmeasured check keeps the verdict of the last check that
     * decided, so "could not decide" never erases what an earlier check saw.
     */
    verdict?: ImplementationStatus;
    reason?: ImplementationUnmeasuredReason;
}

/** How many suggestions a check left unmeasured, per reason. */
export function countByReason(
    unmeasured: { reason: ImplementationUnmeasuredReason }[],
): Partial<Record<ImplementationUnmeasuredReason, number>> {
    return unmeasured.reduce<
        Partial<Record<ImplementationUnmeasuredReason, number>>
    >((acc, u) => ({ ...acc, [u.reason]: (acc[u.reason] ?? 0) + 1 }), {});
}
