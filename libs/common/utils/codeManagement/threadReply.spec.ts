import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';

import { isNewThreadReply } from './threadReply';

describe('isNewThreadReply', () => {
    it('GitHub: a created review-comment reply qualifies, an edit or an issue comment does not', () => {
        const reply = { action: 'created', comment: { in_reply_to_id: 5 } };
        expect(
            isNewThreadReply(
                PlatformType.GITHUB,
                'pull_request_review_comment',
                reply,
            ),
        ).toBe(true);
        expect(
            isNewThreadReply(
                PlatformType.GITHUB,
                'pull_request_review_comment',
                {
                    ...reply,
                    action: 'edited',
                },
            ),
        ).toBe(false);
        expect(
            isNewThreadReply(
                PlatformType.GITHUB,
                'pull_request_review_comment',
                {
                    action: 'created',
                    comment: {},
                },
            ),
        ).toBe(false);
        expect(
            isNewThreadReply(PlatformType.GITHUB, 'issue_comment', reply),
        ).toBe(false);
    });

    it('GitLab: discussion notes qualify, individual notes and updates do not', () => {
        const note = (attrs: object) => ({ object_attributes: attrs });
        expect(
            isNewThreadReply(
                PlatformType.GITLAB,
                'note',
                note({ type: 'DiffNote', action: 'create' }),
            ),
        ).toBe(true);
        expect(
            isNewThreadReply(
                PlatformType.GITLAB,
                'note',
                note({ type: 'DiscussionNote' }),
            ),
        ).toBe(true);
        expect(
            isNewThreadReply(PlatformType.GITLAB, 'note', note({ type: null })),
        ).toBe(false);
        expect(
            isNewThreadReply(
                PlatformType.GITLAB,
                'note',
                note({ type: 'DiffNote', action: 'update' }),
            ),
        ).toBe(false);
    });

    it('Bitbucket: a comment with a parent qualifies, on Cloud and Data Center', () => {
        expect(
            isNewThreadReply(
                PlatformType.BITBUCKET,
                'pullrequest:comment_created',
                { comment: { parent: { id: 1 } } },
            ),
        ).toBe(true);
        expect(
            isNewThreadReply(PlatformType.BITBUCKET, 'pr:comment:added', {
                comment: {},
                commentParentId: 1,
            }),
        ).toBe(true);
        expect(
            isNewThreadReply(
                PlatformType.BITBUCKET,
                'pullrequest:comment_created',
                { comment: {} },
            ),
        ).toBe(false);
    });

    it('Azure DevOps: a reply qualifies, a thread root or an edited reply does not', () => {
        const comment = (c: object) => ({ resource: { comment: c } });
        const event = 'ms.vss-code.git-pullrequest-comment-event';
        expect(
            isNewThreadReply(
                PlatformType.AZURE_REPOS,
                event,
                comment({
                    parentCommentId: 1,
                    publishedDate: 't1',
                    lastContentUpdatedDate: 't1',
                }),
            ),
        ).toBe(true);
        expect(
            isNewThreadReply(
                PlatformType.AZURE_REPOS,
                event,
                comment({ parentCommentId: 0 }),
            ),
        ).toBe(false);
        expect(
            isNewThreadReply(
                PlatformType.AZURE_REPOS,
                event,
                comment({
                    parentCommentId: 1,
                    publishedDate: 't1',
                    lastContentUpdatedDate: 't2',
                }),
            ),
        ).toBe(false);
    });

    it('Forgejo is not supported yet', () => {
        expect(
            isNewThreadReply(
                PlatformType.FORGEJO,
                'pull_request_review_comment',
                {
                    action: 'created',
                    comment: { in_reply_to_id: 5 },
                },
            ),
        ).toBe(false);
    });
});
