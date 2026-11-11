import { GetPullRequestsDailyDigestUseCase } from './get-pull-requests-daily-digest.use-case';

/**
 * The digest is four counts and three queries. The Reviews screen renders one
 * of the counts; it must be able to ask for that one without the other two
 * queries running.
 */

const buildUseCase = () => {
    const getDistinctReviewedPullRequestKeys = jest.fn(async (_params: any) => [
        { repositoryId: 'r1', pullRequestNumber: 1, hasError: false },
        { repositoryId: 'r1', pullRequestNumber: 2, hasError: true },
    ]);
    const getAwaitingReviewPullRequestKeys = jest.fn(async () => [
        { repositoryId: 'r1', pullRequestNumber: 9 },
    ]);
    const findSuggestionCountsByNumbersAndRepositoryIds = jest.fn(
        async () =>
            new Map([
                ['r1_1', { bySeverity: { critical: 1, high: 0 } }],
                ['r1_2', { bySeverity: { critical: 0, high: 0 } }],
            ]),
    );

    // `any`: the test reaches the injected collaborators, which are private.
    const useCase: any = Object.create(
        GetPullRequestsDailyDigestUseCase.prototype,
    );

    Object.assign(useCase, {
        logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
        request: { user: { organization: { uuid: 'org-1' } } },
        authorizationService: {
            getRepositoryScope: jest.fn().mockResolvedValue(null),
        },
        integrationConfigService: {
            findIntegrationConfigFormatted: jest.fn(async () => [
                { id: 'r1', name: 'api' },
            ]),
        },
        automationExecutionService: {
            getDistinctReviewedPullRequestKeys,
            getAwaitingReviewPullRequestKeys,
        },
        pullRequestsService: {
            findSuggestionCountsByNumbersAndRepositoryIds,
        },
    });

    return {
        useCase,
        getDistinctReviewedPullRequestKeys,
        getAwaitingReviewPullRequestKeys,
        findSuggestionCountsByNumbersAndRepositoryIds,
    };
};

describe('GetPullRequestsDailyDigestUseCase', () => {
    it('computes every count by default', async () => {
        const harness = buildUseCase();

        const digest = await harness.useCase.execute({ teamId: 't1' });

        expect(digest).toEqual({
            date: expect.any(String),
            reviewedToday: 2,
            erroredToday: 1,
            needsAttention: 1,
            awaitingReview: 1,
        });
        // Scoped to today (UTC).
        const { createdAtFrom } =
            harness.getDistinctReviewedPullRequestKeys.mock.calls[0][0];
        expect(createdAtFrom).toBe(digest.date);
        expect(new Date(digest.date).getUTCHours()).toBe(0);
    });

    it('asks both counts to fail rather than answer an empty list', async () => {
        const harness = buildUseCase();

        await harness.useCase.execute({ teamId: 't1' });

        expect(harness.getDistinctReviewedPullRequestKeys).toHaveBeenCalledWith(
            expect.objectContaining({ failOnError: true }),
        );
        expect(harness.getAwaitingReviewPullRequestKeys).toHaveBeenCalledWith(
            expect.objectContaining({ failOnError: true }),
        );
    });

    it.each([
        ['reviewed', 'getDistinctReviewedPullRequestKeys'],
        ['awaiting', 'getAwaitingReviewPullRequestKeys'],
    ] as const)(
        'fails the request when the %s count cannot be read, instead of reporting 0',
        async (_name, method) => {
            const harness = buildUseCase();
            harness[method].mockRejectedValueOnce(
                new Error('canceling statement due to statement timeout'),
            );

            await expect(
                harness.useCase.execute({ teamId: 't1' }),
            ).rejects.toThrow('statement timeout');
        },
    );

    it('runs one query when only "reviewed today" is asked for', async () => {
        const harness = buildUseCase();

        const digest = await harness.useCase.execute({
            teamId: 't1',
            fields: ['reviewedToday'],
        });

        expect(digest).toEqual({
            date: expect.any(String),
            reviewedToday: 2,
            erroredToday: null,
            needsAttention: null,
            awaitingReview: null,
        });
        expect(
            harness.getDistinctReviewedPullRequestKeys,
        ).toHaveBeenCalledTimes(1);
        expect(
            harness.findSuggestionCountsByNumbersAndRepositoryIds,
        ).not.toHaveBeenCalled();
        expect(harness.getAwaitingReviewPullRequestKeys).not.toHaveBeenCalled();
    });

    it('skips the reviewed-PR query when only the backlog is asked for', async () => {
        const harness = buildUseCase();

        const digest = await harness.useCase.execute({
            teamId: 't1',
            fields: ['awaitingReview'],
        });

        expect(digest).toMatchObject({
            reviewedToday: null,
            awaitingReview: 1,
        });
        expect(
            harness.getDistinctReviewedPullRequestKeys,
        ).not.toHaveBeenCalled();
    });

    it('still reads the reviewed PRs when "needs attention" depends on them', async () => {
        const harness = buildUseCase();

        const digest = await harness.useCase.execute({
            teamId: 't1',
            fields: ['needsAttention'],
        });

        expect(digest).toMatchObject({
            needsAttention: 1,
            reviewedToday: null,
            erroredToday: null,
        });
        expect(
            harness.findSuggestionCountsByNumbersAndRepositoryIds,
        ).toHaveBeenCalledWith(
            [
                { number: 1, repositoryId: 'r1' },
                { number: 2, repositoryId: 'r1' },
            ],
            'org-1',
        );
    });
});
