import type { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { hasOpenFinding, type HostReviewComment } from './own-change-request';

export const REVIEW_FINDINGS_UNVERIFIED =
    'Review findings could not be verified.';

export async function deliveredReviewFindingsHoldReason(
    commentIds: string[],
    platformType: PlatformType,
    loadComments: () => Promise<HostReviewComment[] | null | undefined>,
    hasRecordedLineFindings = false,
): Promise<string | undefined> {
    if (!commentIds.length) {
        return hasRecordedLineFindings ? REVIEW_FINDINGS_UNVERIFIED : undefined;
    }
    const comments = await loadComments();
    if (!Array.isArray(comments)) return REVIEW_FINDINGS_UNVERIFIED;
    if (hasOpenFinding(commentIds, comments, platformType)) {
        return 'Review findings remain unresolved.';
    }
    return undefined;
}
