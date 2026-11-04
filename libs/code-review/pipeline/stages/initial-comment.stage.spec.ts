import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { PullRequestMessageStatus } from '@libs/core/infrastructure/config/types/general/pullRequestMessages.type';

import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';
import { UpdateCommentsAndGenerateSummaryStage } from './finish-comments.stage';
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

    // QA MR !68: a review that ended partial_error is no lastExecution (that
    // is the last SUCCESS), and each later review posted another note.
    it('reuses the note of a preceding partial review', async () => {
        await (stage as any).executeStage({
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
            pullRequest: { number: 42 },
            repository: { id: 'repo-1', name: 'repo' },
            changedFiles: [],
            platformType: PlatformType.GITLAB,
            previousStatusNote: { commentId: 22, noteId: 22 },
        } as CodeReviewPipelineContext);

        expect(createInitialComment.mock.calls[0][8]).toEqual({
            commentId: 22,
            noteId: 22,
        });
    });

    it('prefers the latest finished run over an older success', async () => {
        await (stage as any).executeStage({
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
            pullRequest: { number: 42 },
            repository: { id: 'repo-1', name: 'repo' },
            changedFiles: [],
            platformType: PlatformType.GITLAB,
            lastExecution: { commentId: 11, noteId: 11 },
            previousStatusNote: { commentId: 22, noteId: 22 },
        } as CodeReviewPipelineContext);

        expect(createInitialComment.mock.calls[0][8]).toEqual({
            commentId: 22,
            noteId: 22,
        });
    });

    it('preserves the first summary when a later push only posts a start message', async () => {
        const notes = new Map<number, string>();
        let nextId = 11;
        const manager = {
            createInitialComment: jest.fn(async (...args: any[]) => {
                const id = args[8]?.noteId ?? nextId++;
                notes.set(id, 'Review started');
                return { commentId: id, noteId: id };
            }),
            processEndReviewMessageTemplate: jest
                .fn()
                .mockResolvedValue('Review completed'),
            updateOverallComment: jest.fn(async (...args: any[]) => {
                notes.set(args[4], args[9]);
            }),
        };
        const initial = new InitialCommentStage(manager as any);
        const finish = new UpdateCommentsAndGenerateSummaryStage(
            manager as any,
            {} as any,
            {} as any,
        );
        const context = {
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
            pullRequest: { number: 42 },
            repository: { id: 'repo-1', name: 'repo' },
            changedFiles: [],
            lineComments: [],
            errors: [],
            codeReviewConfig: { languageResultPrompt: 'en-US' },
            platformType: PlatformType.GITLAB,
            pullRequestMessagesConfig: {
                startReviewMessage: {
                    status: PullRequestMessageStatus.EVERY_PUSH,
                    content: 'Review started',
                },
                endReviewMessage: {
                    status: PullRequestMessageStatus.ONLY_WHEN_OPENED,
                    content: 'Review completed',
                },
            },
        } as CodeReviewPipelineContext;

        const first = await (initial as any).executeStage(context);
        await (finish as any).executeStage(first);
        const second = await (initial as any).executeStage({
            ...context,
            lastExecution: first.initialCommentData,
        });
        await (finish as any).executeStage(second);

        expect(notes.get(first.initialCommentData.noteId)).toBe(
            'Review completed',
        );
        expect(notes.get(second.initialCommentData.noteId)).toBe(
            'Review started',
        );
        expect(second.initialCommentData.noteId).not.toBe(
            first.initialCommentData.noteId,
        );
        expect(manager.updateOverallComment).toHaveBeenCalledTimes(1);
    });
});
