import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';

import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';
import { InitialCommentStage } from './initial-comment.stage';

describe('InitialCommentStage GitLab status note reuse (#1721)', () => {
    const createInitialComment = jest.fn().mockResolvedValue({
        commentId: 11,
        noteId: 11,
    });
    const stage = new InitialCommentStage({
        createInitialComment,
    } as any);

    beforeEach(() => createInitialComment.mockClear());

    const run = (lastExecution?: CodeReviewPipelineContext['lastExecution']) =>
        (stage as any).executeStage({
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
            pullRequest: { number: 42 },
            repository: { id: 'repo-1', name: 'repo' },
            changedFiles: [],
            platformType: PlatformType.GITLAB,
            lastExecution,
        } as CodeReviewPipelineContext);

    it('reuses a numeric plain note from the preceding review', async () => {
        const result = await run({ commentId: 11, noteId: 11 });

        expect(createInitialComment).toHaveBeenCalledWith(
            expect.anything(),
            42,
            expect.anything(),
            [],
            'en-US',
            PlatformType.GITLAB,
            undefined,
            undefined,
            { commentId: 11, noteId: 11 },
        );
        expect(result.initialCommentData).toEqual({
            commentId: 11,
            noteId: 11,
        });
    });

    it('does not reuse a legacy discussion as the new plain status note', async () => {
        await run({ commentId: 'discussion-1', noteId: 11 });

        expect(createInitialComment.mock.calls[0][8]).toBeUndefined();
    });
});
