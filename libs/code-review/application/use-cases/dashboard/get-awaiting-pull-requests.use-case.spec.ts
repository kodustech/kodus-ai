import { GetAwaitingPullRequestsUseCase } from './get-awaiting-pull-requests.use-case';

/**
 * The "Kody skipped" list is capped at 100 rows. The cap used to be applied to
 * the skipped PR keys in whatever order the database returned them, before
 * checking which were still open — so a team with more than 100 skipped PRs
 * saw an arbitrary handful. It is applied last now: open PRs only, newest
 * first, then the cap.
 */

const day = (n: number) =>
    new Date(Date.UTC(2026, 0, 1) + n * 86_400_000).toISOString();

const buildUseCase = (
    documents: any[],
    awaitingNumbers = documents.map((d) => d.number),
) => {
    // `any`: the test reaches the injected collaborators, which are private.
    const useCase: any = Object.create(
        GetAwaitingPullRequestsUseCase.prototype,
    );
    const findManyByNumbersAndRepositoryIds = jest.fn(async (criteria: any[]) =>
        documents.filter((doc) =>
            criteria.some((c) => c.number === doc.number),
        ),
    );
    const findOpenPullRequests = jest.fn(async () =>
        documents.filter((doc) => doc.status !== 'closed' && !doc.merged),
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
            getAwaitingReviewPullRequestKeys: jest.fn(async () =>
                awaitingNumbers.map((pullRequestNumber) => ({
                    repositoryId: 'r1',
                    pullRequestNumber,
                })),
            ),
        },
        pullRequestsService: {
            findManyByNumbersAndRepositoryIds,
            findOpenPullRequests,
        },
    });

    return { useCase, findManyByNumbersAndRepositoryIds, findOpenPullRequests };
};

const doc = (number: number, overrides: Record<string, unknown> = {}) => ({
    uuid: `pr-${number}`,
    number,
    title: `PR ${number}`,
    url: `https://example.test/pr/${number}`,
    repository: { id: 'r1', name: 'api' },
    user: { username: 'dev', name: 'Dev' },
    openedAt: day(number),
    status: 'open',
    merged: false,
    ...overrides,
});

describe('GetAwaitingPullRequestsUseCase', () => {
    it('lists open skipped PRs, newest first', async () => {
        const { useCase } = buildUseCase([
            doc(1),
            doc(3),
            doc(2, { status: 'closed' }),
            doc(4, { merged: true }),
            doc(5),
        ]);

        const list = await useCase.execute({ teamId: 't1' });

        expect(list.map((pr: any) => pr.prNumber)).toEqual([5, 3, 1]);
        expect(list[0]).toEqual({
            prId: 'pr-5',
            prNumber: 5,
            title: 'PR 5',
            url: 'https://example.test/pr/5',
            repositoryName: 'api',
            repositoryId: 'r1',
            author: { username: 'dev', name: 'Dev' },
            openedAt: day(5),
        });
    });

    it('caps at the 100 most recently opened, counting only open PRs', async () => {
        // 150 skipped PRs; the 50 oldest are closed.
        const documents = Array.from({ length: 150 }, (_, i) =>
            doc(i + 1, i < 50 ? { status: 'closed' } : {}),
        );
        const { useCase } = buildUseCase(documents);

        const list = await useCase.execute({ teamId: 't1' });

        expect(list).toHaveLength(100);
        expect(list[0].prNumber).toBe(150);
        expect(list[99].prNumber).toBe(51);
    });

    it('keeps the newest 100 when more than 100 are open', async () => {
        const documents = Array.from({ length: 260 }, (_, i) => doc(i + 1));
        const { useCase, findOpenPullRequests } = buildUseCase(documents);

        const list = await useCase.execute({ teamId: 't1' });

        expect(list.map((pr: any) => pr.prNumber)).toEqual(
            Array.from({ length: 100 }, (_, i) => 260 - i),
        );
        // 260 skipped PRs: resolved through the open PRs, not key by key.
        expect(findOpenPullRequests).toHaveBeenCalledTimes(1);
    });

    it('answers an empty list when nothing was skipped', async () => {
        const { useCase, findManyByNumbersAndRepositoryIds } = buildUseCase(
            [],
            [],
        );

        await expect(useCase.execute({ teamId: 't1' })).resolves.toEqual([]);
        expect(findManyByNumbersAndRepositoryIds).not.toHaveBeenCalled();
    });
});
