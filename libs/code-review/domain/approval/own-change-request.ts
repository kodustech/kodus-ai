import { SeverityLevel } from '@libs/common/utils/enums/severityLevel.enum';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';

/** A review comment or thread as the code host returns it. */
export interface HostReviewComment {
    id?: number | string | null;
    fullDatabaseId?: number | string | null;
    threadId?: number | string | null;
    isResolved?: boolean | null;
}

/** The id a posted finding's comment has among the host's review comments. */
export function hostCommentKey(
    comment: HostReviewComment,
    platformType: PlatformType,
): string | undefined {
    const id =
        platformType === PlatformType.GITHUB
            ? (comment.fullDatabaseId ?? comment.id)
            : platformType === PlatformType.AZURE_REPOS
              ? comment.threadId
              : comment.id;
    return id === undefined || id === null || id === ''
        ? undefined
        : String(id);
}

/** Kody requests changes over critical findings and nothing else. */
export const isCriticalFinding = (finding: { severity?: string }) =>
    finding.severity?.toLowerCase() === SeverityLevel.CRITICAL;

/**
 * Whether one of the findings behind Kody's change request is still open on
 * the host. It fails closed: with no finding on record there is nothing to
 * check the request against, and a comment the host does not list counts as
 * open, so a short page of comments never reads as "everything is resolved".
 */
export function hasOpenFinding(
    commentIds: string[],
    comments: HostReviewComment[],
    platformType: PlatformType,
): boolean {
    if (!commentIds.length) return true;

    const resolvedByKey = new Map<string, boolean>();
    for (const comment of comments) {
        const key = hostCommentKey(comment, platformType);
        if (key && !resolvedByKey.has(key)) {
            resolvedByKey.set(key, comment.isResolved === true);
        }
    }
    return commentIds.some((id) => resolvedByKey.get(String(id)) !== true);
}
