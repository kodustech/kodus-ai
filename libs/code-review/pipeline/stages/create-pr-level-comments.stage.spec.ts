import { CreatePrLevelCommentsStage } from './create-pr-level-comments.stage';
import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';

/**
 * Input-contract spec for the PR-level comment stage: it must guard on the
 * context it needs, combine PR-level suggestions from BOTH sources, hand the
 * comment manager the exact shape it expects, and — critically — degrade
 * without throwing when comment delivery fails (a failed GitHub call must not
 * take down the pipeline or persist phantom comments).
 */
describe('CreatePrLevelCommentsStage — input contract', () => {
    let commentManagerService: { createPrLevelReviewComments: jest.Mock };
    let suggestionService: {
        transformCommentResultsToPrLevelSuggestions: jest.Mock;
    };
    let pullRequestsService: { addPrLevelSuggestions: jest.Mock };
    let stage: CreatePrLevelCommentsStage;

    const ORG = { organizationId: 'org-1', teamId: 'team-1' };

    const buildContext = (
        overrides: Partial<CodeReviewPipelineContext> = {},
    ): CodeReviewPipelineContext =>
        ({
            organizationAndTeamData: ORG,
            pullRequest: { number: 42 },
            repository: { name: 'repo', id: 'r1', language: 'TypeScript' },
            validSuggestionsByPR: [],
            businessLogicResults: [],
            codeReviewConfig: {},
            pullRequestMessagesConfig: {},
            ...overrides,
        }) as unknown as CodeReviewPipelineContext;

    const run = (ctx: CodeReviewPipelineContext) =>
        (stage as any).executeStage(ctx);

    beforeEach(() => {
        commentManagerService = {
            createPrLevelReviewComments: jest.fn().mockResolvedValue({
                commentResults: [],
            }),
        };
        suggestionService = {
            transformCommentResultsToPrLevelSuggestions: jest
                .fn()
                .mockReturnValue([]),
        };
        pullRequestsService = { addPrLevelSuggestions: jest.fn() };
        stage = new CreatePrLevelCommentsStage(
            commentManagerService as any,
            suggestionService as any,
            pullRequestsService as any,
        );
        (stage as any).logger = {
            log: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
        };
    });

    it.each([
        ['organizationAndTeamData', { organizationAndTeamData: undefined }],
        ['pullRequest.number', { pullRequest: {} }],
        ['repository id/name', { repository: { name: 'repo' } }],
    ])('returns the context untouched and posts nothing when %s is missing', async (_l, patch) => {
        const ctx = buildContext({
            validSuggestionsByPR: [{ id: 's1' }],
        } as any);
        Object.assign(ctx, patch);

        const out = await run(ctx);

        expect(out).toBe(ctx);
        expect(
            commentManagerService.createPrLevelReviewComments,
        ).not.toHaveBeenCalled();
    });

    it('does nothing when there are no PR-level suggestions from either source', async () => {
        await run(buildContext());
        expect(
            commentManagerService.createPrLevelReviewComments,
        ).not.toHaveBeenCalled();
    });

    it('combines validSuggestionsByPR AND businessLogicResults, and passes the repo shape the manager expects', async () => {
        await run(
            buildContext({
                validSuggestionsByPR: [{ id: 'a' }],
                businessLogicResults: [{ id: 'b' }],
            } as any),
        );

        expect(
            commentManagerService.createPrLevelReviewComments,
        ).toHaveBeenCalledWith(
            ORG,
            42,
            { name: 'repo', id: 'r1', language: 'TypeScript' },
            [{ id: 'a' }, { id: 'b' }], // both sources merged
            undefined, // languageResultPrompt (unset in this context)
            undefined, // suggestionCopyPrompt (unset in this context)
        );
    });

    it('transforms and persists the delivered comments', async () => {
        commentManagerService.createPrLevelReviewComments.mockResolvedValue({
            commentResults: [{ deliveryStatus: 'sent', id: 'c1' }],
        });
        suggestionService.transformCommentResultsToPrLevelSuggestions.mockReturnValue(
            [{ id: 'x' }],
        );

        await run(buildContext({ validSuggestionsByPR: [{ id: 'a' }] } as any));

        expect(
            suggestionService.transformCommentResultsToPrLevelSuggestions,
        ).toHaveBeenCalledWith([{ deliveryStatus: 'sent', id: 'c1' }]);
        expect(pullRequestsService.addPrLevelSuggestions).toHaveBeenCalledWith(
            42,
            'repo',
            [{ id: 'x' }],
            ORG,
        );
    });

    it('is fail-safe: a failed comment call does not throw and persists nothing', async () => {
        commentManagerService.createPrLevelReviewComments.mockRejectedValue(
            new Error('GitHub 503'),
        );

        await expect(
            run(buildContext({ validSuggestionsByPR: [{ id: 'a' }] } as any)),
        ).resolves.toBeDefined();

        expect(
            pullRequestsService.addPrLevelSuggestions,
        ).not.toHaveBeenCalled();
    });
});
