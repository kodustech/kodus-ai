import { GitLabMergeRequestHandler } from './gitlabPullRequest.handler';

/**
 * A GitLab comment from a project with no active automation must be skipped,
 * not crash the handler.
 *
 * `webhookContextService.getContext` returns null for such a project. The
 * merge-request path in this same class has guarded that since it was written
 * (`if (!context?.organizationAndTeamData) { warn; return; }`); the comment
 * path read `context.botUsername` straight off it.
 *
 * One TypeError produced four error lines in production — the handler, the
 * webhook processor, the job router and the workflow consumer each logged it —
 * and the router then marked the job FAILED, so the comment was dropped.
 * Eleven of these in forty minutes.
 */

const commentPayload = {
    project: { id: 4711, web_url: 'https://gitlab.example.test/acme/api' },
    object_attributes: {
        iid: 4992,
        noteable_type: 'MergeRequest',
        action: 'create',
        note: '@kody review',
    },
};

const makeHandler = (getContext: jest.Mock) => {
    const handler = new GitLabMergeRequestHandler(
        {} as any, // savePullRequestUseCase
        { getContext } as any, // webhookContextService
        {} as any, // chatWithKodyFromGitUseCase
        {} as any, // generateIssuesFromPrClosedUseCase
        {} as any, // eventEmitter
        {} as any, // codeManagement
        {} as any, // enqueueCodeReviewJobUseCase
        {} as any, // enqueueImplementationCheckUseCase
        {} as any, // outboxRepository
    );

    const warn = jest.fn();
    (handler as any).logger = {
        log: jest.fn(),
        warn,
        error: jest.fn(),
        debug: jest.fn(),
    };

    return { handler, warn };
};

const handleComment = (handler: GitLabMergeRequestHandler) =>
    (handler as any).handleComment({ payload: commentPayload });

describe('GitLabMergeRequestHandler.handleComment — project without automation', () => {
    it('returns quietly instead of throwing when there is no context', async () => {
        const { handler } = makeHandler(jest.fn().mockResolvedValue(null));

        await expect(handleComment(handler)).resolves.toBeUndefined();
    });

    it('says why it skipped, so the drop is visible', async () => {
        const { handler, warn } = makeHandler(
            jest.fn().mockResolvedValue(null),
        );

        await handleComment(handler);

        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0].message).toMatch(/no active automation/i);
        expect(warn.mock.calls[0][0].metadata).toMatchObject({
            mrNumber: 4992,
            projectId: 4711,
        });
    });

    // A context object that exists but carries no tenant is the same
    // situation, and it reached the same dereference.
    it('treats a context without organizationAndTeamData as no context', async () => {
        const { handler, warn } = makeHandler(
            jest.fn().mockResolvedValue({ botUsername: 'kody' }),
        );

        await expect(handleComment(handler)).resolves.toBeUndefined();
        expect(warn).toHaveBeenCalledTimes(1);
    });
});
