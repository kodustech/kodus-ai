import type { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { hasOpenFinding, type HostReviewComment } from './own-change-request';

export const REVIEW_FINDINGS_UNVERIFIED =
    'Review findings could not be verified.';

export async function deliveredReviewFindingsHoldReason(
    commentIds: string[],
    recordedLineFindings: number,
    platformType: PlatformType,
    loadComments: () => Promise<HostReviewComment[] | null | undefined>,
): Promise<string | undefined> {
    if (!Number.isInteger(recordedLineFindings) || recordedLineFindings < 0) {
        return REVIEW_FINDINGS_UNVERIFIED;
    }
    if (!commentIds.length) {
        return recordedLineFindings === 0
            ? undefined
            : REVIEW_FINDINGS_UNVERIFIED;
    }
    const comments = await loadComments();
    if (!Array.isArray(comments)) return REVIEW_FINDINGS_UNVERIFIED;
    if (hasOpenFinding(commentIds, comments, platformType)) {
        return 'Review findings remain unresolved.';
    }
    return undefined;
}
