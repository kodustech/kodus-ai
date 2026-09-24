import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';

/**
 * True when the webhook carries a newly created reply inside an existing
 * review thread. Handlers forward these to the conversation use case even
 * without @kody; the use case then checks that Kody started the thread and
 * that the reply is directed at it (#1946). Edits never qualify, so changing
 * a reply cannot trigger a second answer.
 */
export function isNewThreadReply(
    platformType: PlatformType,
    event: string,
    payload: any,
): boolean {
    switch (platformType) {
        case PlatformType.GITHUB:
            // Issue comments (the PR conversation tab) have no threads.
            return (
                event === 'pull_request_review_comment' &&
                payload?.action === 'created' &&
                !!payload?.comment?.in_reply_to_id
            );
        case PlatformType.GITLAB: {
            const note = payload?.object_attributes;
            // Individual notes have no type; only discussion notes can be
            // replies. The first note of a discussion also passes here and is
            // dropped by the use case, which knows the discussion's root.
            return (
                (!note?.action || note.action === 'create') &&
                (note?.type === 'DiffNote' || note?.type === 'DiscussionNote')
            );
        }
        case PlatformType.BITBUCKET:
            return !!(payload?.comment?.parent?.id ?? payload?.commentParentId);
        case PlatformType.AZURE_REPOS: {
            const comment = payload?.resource?.comment;
            const edited =
                !!comment?.lastContentUpdatedDate &&
                !!comment?.publishedDate &&
                comment.lastContentUpdatedDate !== comment.publishedDate;
            return comment?.parentCommentId > 0 && !edited;
        }
        default:
            return false;
    }
}
