import {
    GetPullRequestsFacetsUseCase,
    parsePullRequestsFacetFields,
} from './get-pull-requests-facets.use-case';

/**
 * Each facet is a query of its own, two of them over the team's whole review
 * history. The use case must run only the ones the caller asked for, and a
 * facet whose query failed must come back `null` — the screen used to print 0
 * for a count that had timed out.
 */

const REVIEWED = [
    { repositoryId: 'r1', pullRequestNumber: 1, hasError: false },
    { repositoryId: 'r1', pullRequestNumber: 2, hasError: true },
    { repositoryId: 'r2', pullRequestNumber: 3, hasError: false },
];

const buildUseCase = (
    options: { email?: string | null; assigned?: string[] | null } = {},
) => {
    const getDistinctReviewedPullRequestKeys = jest.fn(async () => REVIEWED);
    const getAwaitingReviewPullRequestKeys = jest.fn(async () => [
        { repositoryId: 'r1', pullRequestNumber: 10 },
        { repositoryId: 'r1', pullRequestNumber: 11 },
    ]);
    const countDeliveredPullRequests = jest.fn(
        async (_org: string, _repos: string[] | undefined, opts: any) =>
            opts.openOnly ? 7 : 4,
    );
    const findManyByNumbersAndRepositoryIds = jest.fn(async () => [
        { number: 10, repository: { id: 'r1' }, status: 'open', merged: false },
        {
            number: 11,
            repository: { id: 'r1' },
            status: 'closed',
            merged: true,
        },
    ]);

    // `any`: the test reaches the injected collaborators, which are private.
    const useCase: any = Object.create(GetPullRequestsFacetsUseCase.prototype);

    Object.assign(useCase, {
        logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
        request: {
            user: {
                organization: { uuid: 'org-1' },
                email:
                    options.email === undefined ? 'me@acme.dev' : options.email,
            },
        },
        authorizationService: {
            getRepositoryScope: jest
                .fn()
                .mockResolvedValue(
                    options.assigned === undefined ? null : options.assigned,
                ),
        },
        integrationConfigService: {
            findIntegrationConfigFormatted: jest.fn(async () => [
                { id: 'r1', name: 'api' },
                { id: 'r2', name: 'web' },
            ]),
        },
        automationExecutionService: {
            getDistinctReviewedPullRequestKeys,
            getAwaitingReviewPullRequestKeys,
        },
        pullRequestsService: {
            countDeliveredPullRequests,
            findManyByNumbersAndRepositoryIds,
        },
    });

    return {
        useCase,
        getDistinctReviewedPullRequestKeys,
        getAwaitingReviewPullRequestKeys,
        countDeliveredPullRequests,
        findManyByNumbersAndRepositoryIds,
    };
};

describe('GetPullRequestsFacetsUseCase', () => {
    it('counts every team facet by default and leaves `mine` out', async () => {
        const harness = buildUseCase();

        const facets = await harness.useCase.execute({
            teamId: 't1',
            scope: 'team',
        });

        expect(facets).toEqual({
            all: 3,
            errored: 1,
            needsAttention: 7,
            // PR 11 was skipped too, but it is closed now.
            awaiting: 1,
            // Only the mine view shows it; the team view never did.
            mine: null,
        });
        expect(harness.countDeliveredPullRequests).toHaveBeenCalledTimes(1);
        expect(harness.countDeliveredPullRequests).toHaveBeenCalledWith(
            'org-1',
            ['r1', 'r2'],
            { unresolvedOnly: true, openOnly: true, authorEmail: undefined },
        );
    });

    it('runs only the queries behind the requested facets', async () => {
        const harness = buildUseCase();

        const facets = await harness.useCase.execute({
            teamId: 't1',
            scope: 'team',
            fields: ['awaiting', 'needsAttention'],
        });

        expect(facets).toEqual({
            all: null,
            errored: null,
            needsAttention: 7,
            awaiting: 1,
            mine: null,
        });
        // `all`/`errored` group the team's whole history — not asked, not run.
        expect(
            harness.getDistinctReviewedPullRequestKeys,
        ).not.toHaveBeenCalled();
        expect(harness.countDeliveredPullRequests).toHaveBeenCalledTimes(1);
    });

    it('shares one grouping between `all` and `errored`', async () => {
        const harness = buildUseCase();

        const facets = await harness.useCase.execute({
            teamId: 't1',
            scope: 'team',
            fields: ['errored'],
        });

        expect(facets).toEqual({
            all: null,
            errored: 1,
            needsAttention: null,
            awaiting: null,
            mine: null,
        });
        expect(
            harness.getDistinctReviewedPullRequestKeys,
        ).toHaveBeenCalledTimes(1);
        expect(harness.getAwaitingReviewPullRequestKeys).not.toHaveBeenCalled();
        expect(harness.countDeliveredPullRequests).not.toHaveBeenCalled();
    });

    it('scopes the mine view to the caller', async () => {
        const harness = buildUseCase();

        const facets = await harness.useCase.execute({
            teamId: 't1',
            scope: 'mine',
            fields: ['needsAttention', 'mine'],
        });

        expect(facets).toMatchObject({ needsAttention: 7, mine: 4 });
        expect(harness.countDeliveredPullRequests).toHaveBeenCalledWith(
            'org-1',
            ['r1', 'r2'],
            {
                unresolvedOnly: true,
                openOnly: true,
                authorEmail: 'me@acme.dev',
            },
        );
        expect(harness.countDeliveredPullRequests).toHaveBeenCalledWith(
            'org-1',
            ['r1', 'r2'],
            { authorEmail: 'me@acme.dev' },
        );
    });

    it('answers zero, not the team total, for a mine view with no known identity', async () => {
        const harness = buildUseCase({ email: null });

        const facets = await harness.useCase.execute({
            teamId: 't1',
            scope: 'mine',
        });

        expect(facets).toMatchObject({ needsAttention: 0, mine: 0 });
        expect(harness.countDeliveredPullRequests).not.toHaveBeenCalled();
    });

    it('reports a facet whose query failed as unknown and keeps the others', async () => {
        const harness = buildUseCase();
        harness.countDeliveredPullRequests.mockRejectedValue(
            new Error(
                'error while multiplanner was selecting best plan :: caused by :: operation exceeded time limit',
            ),
        );

        const facets = await harness.useCase.execute({
            teamId: 't1',
            scope: 'team',
        });

        expect(facets).toEqual({
            all: 3,
            errored: 1,
            needsAttention: null,
            awaiting: 1,
            mine: null,
        });
        expect(harness.useCase.logger.error).toHaveBeenCalledWith(
            expect.objectContaining({
                metadata: expect.objectContaining({ facet: 'needsAttention' }),
            }),
        );
    });

    it('reports the Postgres-backed facets as unknown when their queries fail', async () => {
        const harness = buildUseCase();
        harness.getDistinctReviewedPullRequestKeys.mockRejectedValue(
            new Error('statement timeout'),
        );
        harness.getAwaitingReviewPullRequestKeys.mockRejectedValue(
            new Error('statement timeout'),
        );

        const facets = await harness.useCase.execute({
            teamId: 't1',
            scope: 'team',
        });

        expect(facets).toEqual({
            all: null,
            errored: null,
            needsAttention: 7,
            awaiting: null,
            mine: null,
        });
    });

    it('answers real zeros when no repository is in scope', async () => {
        const harness = buildUseCase({ assigned: [] });

        const facets = await harness.useCase.execute({
            teamId: 't1',
            scope: 'team',
            fields: ['awaiting', 'needsAttention'],
        });

        expect(facets).toEqual({
            all: null,
            errored: null,
            needsAttention: 0,
            awaiting: 0,
            mine: null,
        });
        expect(harness.countDeliveredPullRequests).not.toHaveBeenCalled();
    });
});

describe('parsePullRequestsFacetFields', () => {
    it('reads a comma-separated list and drops unknown names', () => {
        expect(
            parsePullRequestsFacetFields('awaiting, needsAttention,bogus'),
        ).toEqual(['awaiting', 'needsAttention']);
    });

    it('accepts a repeated query parameter and removes duplicates', () => {
        expect(parsePullRequestsFacetFields(['all,errored', 'all'])).toEqual([
            'all',
            'errored',
        ]);
    });

    it('answers undefined — the default set — when nothing valid was asked', () => {
        expect(parsePullRequestsFacetFields(undefined)).toBeUndefined();
        expect(parsePullRequestsFacetFields('')).toBeUndefined();
        expect(parsePullRequestsFacetFields('nope')).toBeUndefined();
    });
});
