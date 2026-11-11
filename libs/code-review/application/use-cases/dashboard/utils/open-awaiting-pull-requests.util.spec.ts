import { findOpenAwaitingPullRequests } from './open-awaiting-pull-requests.util';

/**
 * "Kody skipped": PRs whose every run was skipped and that are still open.
 * The helper has two routes to the same answer — load the skipped-only PRs,
 * or read the open PRs and intersect — and picks by how many skipped-only PRs
 * there are. Both must answer the same PRs.
 */

const ORG = { organizationId: 'org-1', teamId: 'team-1' };

const pr = (number: number, overrides: Record<string, unknown> = {}): any => ({
    uuid: `pr-${number}`,
    number,
    repository: { id: 'r1', name: 'api' },
    status: 'open',
    merged: false,
    ...overrides,
});

const keysFor = (numbers: number[], repositoryId = 'r1') =>
    numbers.map((pullRequestNumber) => ({ repositoryId, pullRequestNumber }));

const build = (options: {
    awaiting: Array<{ repositoryId: string; pullRequestNumber: number }>;
    documents: any[];
    openLimitExceeded?: boolean;
}) => {
    const getAwaitingReviewPullRequestKeys = jest.fn(
        async (_params: any) => options.awaiting,
    );
    // What MongoDB holds, answered the way each query would answer it.
    const findManyByNumbersAndRepositoryIds = jest.fn(
        async (criteria: any[], _organizationId: string) =>
            options.documents.filter((doc) =>
                criteria.some(
                    (c) =>
                        c.number === doc.number &&
                        c.repositoryId === doc.repository?.id,
                ),
            ),
    );
    const findOpenPullRequests = jest.fn(
        async (
            _organizationId: string,
            repositoryIds: string[] | undefined,
            _limit: number,
        ) =>
            options.openLimitExceeded
                ? null
                : options.documents.filter(
                      (doc) =>
                          doc.merged !== true &&
                          doc.status !== 'closed' &&
                          (!repositoryIds ||
                              repositoryIds.includes(doc.repository?.id)),
                  ),
    );

    const run = (
        extra: { repositoryIds?: string[]; failOnError?: boolean } = {},
    ) =>
        findOpenAwaitingPullRequests({
            automationExecutionService: { getAwaitingReviewPullRequestKeys },
            pullRequestsService: {
                findManyByNumbersAndRepositoryIds,
                findOpenPullRequests,
            } as any,
            organizationAndTeamData: ORG,
            repositoryIds: extra.repositoryIds ?? ['r1', 'r2'],
            failOnError: extra.failOnError,
        });

    return {
        run,
        getAwaitingReviewPullRequestKeys,
        findManyByNumbersAndRepositoryIds,
        findOpenPullRequests,
    };
};

const numbersOf = (prs: Array<{ number: number }>) =>
    prs.map((item) => item.number).sort((a, b) => a - b);

describe('findOpenAwaitingPullRequests', () => {
    it('answers nothing, and queries nothing else, when no PR was skipped', async () => {
        const harness = build({ awaiting: [], documents: [pr(1)] });

        await expect(harness.run()).resolves.toEqual([]);
        expect(
            harness.findManyByNumbersAndRepositoryIds,
        ).not.toHaveBeenCalled();
        expect(harness.findOpenPullRequests).not.toHaveBeenCalled();
    });

    it('loads a short list of skipped PRs directly and keeps the open ones', async () => {
        const harness = build({
            awaiting: keysFor([1, 2, 3, 4, 5]),
            documents: [
                pr(1),
                pr(2, { status: 'closed' }),
                pr(3, { merged: true }),
                pr(4, { status: 'CLOSED' }),
                // 5 has no document: Kody never stored the PR.
                pr(9), // open, but not skipped
            ],
        });

        const result = await harness.run();

        expect(numbersOf(result)).toEqual([1]);
        expect(harness.findOpenPullRequests).not.toHaveBeenCalled();
        expect(harness.findManyByNumbersAndRepositoryIds).toHaveBeenCalledWith(
            [1, 2, 3, 4, 5].map((number) => ({ number, repositoryId: 'r1' })),
            'org-1',
        );
    });

    it('reads the open PRs instead when the skipped-only set is long', async () => {
        const skipped = Array.from({ length: 201 }, (_, i) => i + 1);
        const harness = build({
            awaiting: keysFor(skipped),
            documents: [
                pr(1),
                pr(2, { status: 'closed' }),
                pr(150),
                pr(201, { status: 'Closed' }),
                pr(900), // open, never skipped
                pr(7, { repository: { id: 'r2', name: 'web' } }), // same number, other repository
            ],
        });

        const result = await harness.run();

        expect(numbersOf(result)).toEqual([1, 150]);
        expect(
            harness.findManyByNumbersAndRepositoryIds,
        ).not.toHaveBeenCalled();
        expect(harness.findOpenPullRequests).toHaveBeenCalledWith(
            'org-1',
            ['r1', 'r2'],
            5000,
        );
    });

    it('switches routes exactly past 200 skipped PRs', async () => {
        const atLimit = build({
            awaiting: keysFor(Array.from({ length: 200 }, (_, i) => i + 1)),
            documents: [pr(1)],
        });
        await atLimit.run();
        expect(atLimit.findOpenPullRequests).not.toHaveBeenCalled();

        const past = build({
            awaiting: keysFor(Array.from({ length: 201 }, (_, i) => i + 1)),
            documents: [pr(1)],
        });
        await past.run();
        expect(past.findOpenPullRequests).toHaveBeenCalledTimes(1);
    });

    it('answers the same PRs by either route', async () => {
        const documents = [
            pr(1),
            pr(2, { status: 'closed' }),
            pr(3, { merged: true }),
            pr(4),
            pr(250),
            pr(999),
            pr(4, { uuid: 'pr-web-4', repository: { id: 'r2', name: 'web' } }),
        ];
        const skipped = keysFor(Array.from({ length: 300 }, (_, i) => i + 1));

        const byOpenSet = await build({ awaiting: skipped, documents }).run();
        // Too many open PRs to read → the helper loads the keys instead.
        const fallback = build({
            awaiting: skipped,
            documents,
            openLimitExceeded: true,
        });
        const byKeys = await fallback.run();

        expect(numbersOf(byOpenSet)).toEqual([1, 4, 250]);
        expect(byKeys.map((item) => item.uuid).sort()).toEqual(
            byOpenSet.map((item) => item.uuid).sort(),
        );
        expect(
            fallback.findManyByNumbersAndRepositoryIds,
        ).toHaveBeenCalledTimes(1);
    });

    it('passes the scope and the failure mode to the execution query', async () => {
        const harness = build({ awaiting: [], documents: [] });

        await harness.run({ repositoryIds: ['r7'], failOnError: true });

        expect(harness.getAwaitingReviewPullRequestKeys).toHaveBeenCalledWith({
            organizationAndTeamData: ORG,
            repositoryIds: ['r7'],
            failOnError: true,
        });
    });

    it('propagates a failed execution query', async () => {
        const harness = build({ awaiting: [], documents: [] });
        harness.getAwaitingReviewPullRequestKeys.mockRejectedValue(
            new Error('statement timeout'),
        );

        await expect(harness.run({ failOnError: true })).rejects.toThrow(
            'statement timeout',
        );
    });
});
