import { CommentManagerService } from './commentManager.service';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { DeliveryStatus } from '@libs/platformData/domain/pullRequests/enums/deliveryStatus.enum';

/**
 * Bitbucket escapes HTML, so the collapsed "Prompt for LLM" block other hosts
 * use cannot exist there. Kody posts the prompt as a reply in the same thread
 * instead, after the finding comment is created, only when the team keeps the
 * copyable prompt on. A failed reply never fails the finding.
 */
const org = { organizationId: 'org-1', teamId: 'team-1' };
const repository = { id: 'repo-1', name: 'repo', language: 'typescript' };

const lineComment = {
    path: 'src/user.ts',
    start_line: 10,
    line: 12,
    body: {
        improvedCode: 'const name = user?.name;',
        suggestionContent: 'Reading name throws a 500. Guard it.',
    },
    suggestion: {
        id: 's-1',
        severity: 'high',
        label: 'bug',
        oneSentenceSummary: 'User can be null when the account was deleted',
        llmPrompt:
            'User can be null when the account was deleted\n\nThe whole explanation.',
    },
} as any;

const makeService = (over: Record<string, any> = {}) => {
    const codeManagementService = {
        getCommitsForPullRequestForCodeReview: jest
            .fn()
            .mockResolvedValue([{ sha: 'abc' }]),
        createReviewComment: jest.fn().mockResolvedValue({ id: 101 }),
        createResponseToComment: jest.fn().mockResolvedValue({ id: 102 }),
        formatReviewCommentBody: jest.fn().mockResolvedValue('PR-level body'),
        createIssueComment: jest.fn().mockResolvedValue({ id: 201 }),
        ...over,
    };
    const service = new CommentManagerService(
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        codeManagementService as any,
    );
    return { service, codeManagementService };
};

const createInline = (
    service: CommentManagerService,
    platformType: PlatformType,
    copyPrompt = true,
) =>
    service.createLineComments(
        org,
        7,
        repository,
        [lineComment],
        'en-US',
        copyPrompt,
        undefined,
        platformType,
    );

describe('CommentManagerService — Bitbucket prompt reply', () => {
    it('replies under a Bitbucket finding with the Kody chip and the full agent prompt', async () => {
        const { service, codeManagementService } = makeService();

        const { commentResults } = await createInline(service, PlatformType.BITBUCKET);

        expect(commentResults[0].deliveryStatus).toBe(DeliveryStatus.SENT);
        expect(codeManagementService.createResponseToComment).toHaveBeenCalledTimes(1);
        const [params] = codeManagementService.createResponseToComment.mock.calls[0];
        expect(params).toEqual(
            expect.objectContaining({
                organizationAndTeamData: org,
                prNumber: 7,
                inReplyToId: 101,
                repository: expect.objectContaining({ id: 'repo-1', name: 'repo' }),
            }),
        );
        expect(params.body.startsWith('`kody|code-review` **Prompt for LLM**')).toBe(true);
        expect(params.body).toContain('File src/user.ts, lines 10-12:');
        expect(params.body).toContain('The whole explanation.');
        expect(params.body).toContain('Suggested code:\n\nconst name = user?.name;');
    });

    it('does not reply on other hosts', async () => {
        const { service, codeManagementService } = makeService();

        await createInline(service, PlatformType.GITHUB);

        expect(codeManagementService.createResponseToComment).not.toHaveBeenCalled();
    });

    it('does not reply when the team turned the copyable prompt off', async () => {
        const { service, codeManagementService } = makeService();

        await createInline(service, PlatformType.BITBUCKET, false);

        expect(codeManagementService.createResponseToComment).not.toHaveBeenCalled();
    });

    it('keeps the finding SENT when the reply fails', async () => {
        const { service } = makeService({
            createResponseToComment: jest.fn().mockRejectedValue(new Error('boom')),
        });

        const { commentResults } = await createInline(service, PlatformType.BITBUCKET);

        expect(commentResults[0].deliveryStatus).toBe(DeliveryStatus.SENT);
        expect(commentResults[0].codeReviewFeedbackData.commentId).toBe(101);
    });

    it('replies under a Bitbucket PR-level finding with the prompt built from its full explanation', async () => {
        const { service, codeManagementService } = makeService();

        await service.createPrLevelReviewComments(
            org,
            7,
            repository,
            [
                {
                    id: 'p-1',
                    severity: 'high',
                    label: 'kody_rules',
                    oneSentenceSummary: 'PR description has no ticket reference',
                    suggestionContent: 'Add the ticket ID.',
                    fullExplanation: 'The rule requires a ticket ID like ABC-123.',
                } as any,
            ],
            'en-US',
            true,
            PlatformType.BITBUCKET,
        );

        const [params] = codeManagementService.createResponseToComment.mock.calls[0];
        expect(params.inReplyToId).toBe(201);
        expect(params.body).toContain(
            'PR description has no ticket reference\n\nThe rule requires a ticket ID like ABC-123.',
        );
    });
});
