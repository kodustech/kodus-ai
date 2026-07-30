import { DeliveryStatus } from '@libs/platformData/domain/pullRequests/enums/deliveryStatus.enum';
import { ImplementationStatus } from '@libs/platformData/domain/pullRequests/enums/implementationStatus.enum';

/**
 * Single source of truth for the Pull Requests dashboard business rules.
 *
 * The same rule is expressed in three query languages across the codebase —
 * Postgres (automation_execution), MongoDB (aggregations/filters) and in-memory
 * JS (post-query list filtering). Those can't literally share one function, but
 * every IN-MEMORY consumer MUST use the predicates here so the list and the
 * counts can't drift apart (the class of "badge says N, list shows M" bugs).
 * When you change a rule, change it here and mirror it in the corresponding
 * Mongo/SQL query — the tests document the intended behaviour.
 */

// A PR is still open (actionable) when it isn't merged and isn't closed. Status
// is compared case-insensitively because it's stored lowercase but callers
// shouldn't depend on that. Mirrors the Mongo `{ merged: { $ne: true }, status:
// { $nin: ['closed'] } }` filter used by countDeliveredPullRequests /
// findOpenPullRequestKeysOpenedSince.
export const CLOSED_STATUS = 'closed';

export function isOpenPullRequest(pr: {
    merged?: boolean | null;
    status?: string | null;
}): boolean {
    return (
        pr?.merged !== true &&
        String(pr?.status ?? '').toLowerCase() !== CLOSED_STATUS
    );
}

// A delivered (sent) suggestion the author still hasn't applied — the "Needs
// attention" signal. A missing implementationStatus (legacy docs) counts as
// unresolved, matching the Mongo `$ne: 'implemented'` semantics.
export function isUnresolvedDeliveredSuggestion(suggestion: {
    deliveryStatus?: string | null;
    implementationStatus?: string | null;
}): boolean {
    return (
        suggestion?.deliveryStatus === DeliveryStatus.SENT &&
        suggestion?.implementationStatus !== ImplementationStatus.IMPLEMENTED
    );
}

// Exact author-identity match for the Author autocomplete filter: the selected
// value must equal the PR author's display name, username, or email
// (case-insensitive). NOT a substring/token match — "Wellington Santana" must
// not match "Wellington Cristi Vilela Santana". The `me` shortcut (match the
// logged-in user's email) is handled by the caller, which has the request user.
export function authorMatchesExact(
    prUser:
        | { email?: string | null; username?: string | null; name?: string | null }
        | null
        | undefined,
    target: string,
): boolean {
    const wanted = target.trim().toLowerCase();
    if (!wanted) return true;
    const candidates = [prUser?.email, prUser?.username, prUser?.name]
        .filter((value): value is string => Boolean(value))
        .map((value) => value.toLowerCase());
    return candidates.includes(wanted);
}
