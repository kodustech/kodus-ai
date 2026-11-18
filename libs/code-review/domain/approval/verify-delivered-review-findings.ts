import type { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { hasOpenFinding, type HostReviewComment } from './own-change-request';

export const REVIEW_FINDINGS_UNVERIFIED =
    'Review findings could not be verified.';

type StoredFinding = { comment?: { id?: string | number | null } | null };

export function normalizeReviewFindingId(id: unknown): string | undefined {
    if (typeof id === 'string') return id.trim() || undefined;
    if (typeof id === 'number' && Number.isFinite(id)) return String(id);
    return undefined;
}

export async function deliveredReviewFindingsHoldReason(
    suggestions: readonly StoredFinding[],
    recorded: {
        lineFindings: number;
        lineCommentIds?: readonly (string | null)[];
    },
    platformType: PlatformType,
    loadComments: () => Promise<HostReviewComment[] | null | undefined>,
): Promise<string | undefined> {
    const { lineFindings, lineCommentIds } = recorded;
    if (
        !Number.isInteger(lineFindings) ||
        lineFindings < 0 ||
        !Array.isArray(suggestions)
    ) {
        return REVIEW_FINDINGS_UNVERIFIED;
    }
    const distinctCommentIds = new Set<string>();
    for (const suggestion of suggestions) {
        const id = normalizeReviewFindingId(suggestion?.comment?.id);
        if (!id) return REVIEW_FINDINGS_UNVERIFIED;
        distinctCommentIds.add(id);
    }
    if (lineCommentIds !== undefined) {
        if (
            !Array.isArray(lineCommentIds) ||
            lineCommentIds.length !== lineFindings
        ) {
            return REVIEW_FINDINGS_UNVERIFIED;
        }
        for (const rawId of lineCommentIds) {
            const id = normalizeReviewFindingId(rawId);
            if (!id) {
                return 'Some review findings have no verifiable publication. Run a complete PR review before automatic approval.';
            }
            if (!distinctCommentIds.has(id)) return REVIEW_FINDINGS_UNVERIFIED;
        }
    } else if (distinctCommentIds.size < lineFindings) {
        // Older summaries record the total without the comment identities.
        return REVIEW_FINDINGS_UNVERIFIED;
    }
    if (!distinctCommentIds.size) return undefined;
    const comments = await loadComments();
    if (!Array.isArray(comments)) return REVIEW_FINDINGS_UNVERIFIED;
    if (hasOpenFinding([...distinctCommentIds], comments, platformType)) {
        return 'Review findings remain unresolved.';
    }
    return undefined;
}
