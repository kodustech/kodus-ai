import type { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { hasOpenFinding, type HostReviewComment } from './own-change-request';

export const REVIEW_FINDINGS_UNVERIFIED =
    'Review findings could not be verified.';

export async function deliveredReviewFindingsHoldReason(
    commentIds: readonly (string | number | null | undefined)[],
    recordedLineFindings: number,
    platformType: PlatformType,
    loadComments: () => Promise<HostReviewComment[] | null | undefined>,
): Promise<string | undefined> {
    if (!Number.isInteger(recordedLineFindings) || recordedLineFindings < 0) {
        return REVIEW_FINDINGS_UNVERIFIED;
    }
    const distinctCommentIds = new Set<string>();
    for (const id of commentIds) {
        if (!(
            (typeof id === 'string' && id.trim().length > 0) ||
            (typeof id === 'number' && Number.isFinite(id))
        )) {
            return REVIEW_FINDINGS_UNVERIFIED;
        }
        distinctCommentIds.add(String(id));
    }
    if (distinctCommentIds.size < recordedLineFindings) {
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
