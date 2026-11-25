import { SeverityLevel } from '@libs/common/utils/enums/severityLevel.enum';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import {
    normalizeImplementationStatus,
    resolvesSuggestionThread,
} from '@libs/platformData/domain/pullRequests/implementation-status';

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

/** A finding behind the request, as the PR stores its suggestion. */
export interface StoredFinding {
    suggestionId: string;
    commentId?: string | null;
    implementationStatus?: unknown;
}

/**
 * Whether one of the findings behind Kody's change request is still open. A
 * finding is closed once the implementation check found it implemented, or
 * once its thread is resolved on the host; so one whose comment id never came
 * back can still close. A suggestion the PR no longer stores counts as open.
 * A finding recorded by its comment alone, before its suggestion was or on a
 * request merged into this one, is judged by its thread.
 */
export function hasOpenChangeRequestFinding(
    changeRequest: { commentIds?: string[]; suggestionIds?: string[] },
    stored: StoredFinding[],
    comments: HostReviewComment[],
    platformType: PlatformType,
): boolean {
    const suggestionIds = changeRequest.suggestionIds ?? [];
    if (!suggestionIds.length) {
        return hasOpenFinding(
            changeRequest.commentIds ?? [],
            comments,
            platformType,
        );
    }

    const byId = new Map(
        stored.map((finding) => [finding.suggestionId, finding]),
    );
    const covered = new Set(
        stored
            .filter((finding) => finding.commentId)
            .map((finding) => String(finding.commentId)),
    );
    const commentOnly = (changeRequest.commentIds ?? []).filter(
        (id) => !covered.has(String(id)),
    );
    if (
        commentOnly.length &&
        hasOpenFinding(commentOnly, comments, platformType)
    ) {
        return true;
    }
    return suggestionIds.some((id) => {
        const finding = byId.get(id);
        if (!finding) return true;
        if (
            resolvesSuggestionThread(
                normalizeImplementationStatus(finding.implementationStatus),
            )
        ) {
            return false;
        }
        return (
            !finding.commentId ||
            hasOpenFinding([String(finding.commentId)], comments, platformType)
        );
    });
}
