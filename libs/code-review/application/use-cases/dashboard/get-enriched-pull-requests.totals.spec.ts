import { GetEnrichedPullRequestsUseCase } from './get-enriched-pull-requests.use-case';

/**
 * The list does not count unless asked.
 *
 * Counting the executions (and the distinct PRs) behind a set of filters walks
 * every execution that matches them. It used to ride on the first batch of
 * every list request — cursor pages included — so the 30 rows of a page waited
 * on a scan of the team's whole history. The count is now opt-in on the list
 * and has a call of its own (`countTotals`), which must resolve exactly the
 * filters the list resolves.
 */

const BASE = Date.UTC(2026, 0, 15, 12, 0, 0);

const makeExecutions = (count: number) =>
    Array.from({ length: count }, (_, i) => ({
        uuid: `exec-${String(i).padStart(3, '0')}`,
        createdAt: new Date(BASE - i * 60_000),
        updatedAt: new Date(BASE - i * 60_000),
        status: 'success',
        errorMessage: null,
        origin: 'webhook',
        pullRequestNumber: 1000 + i,
        repositoryId: 'repo-1',
        dataExecution: {},
    }));

const makePrDoc = (prNumber: number) => ({
    uuid: `pr-${prNumber}`,
    number: prNumber,
    title: `PR ${prNumber}`,
    status: 'open',
    merged: false,
    url: `https://example.test/pr/${prNumber}`,
    baseBranchRef: 'main',
    headBranchRef: `feat/${prNumber}`,
    repository: { id: 'repo-1', name: 'api' },
    openedAt: new Date(BASE),
    createdAt: new Date(BASE),
    updatedAt: new Date(BASE),
    provider: 'github',
    user: { id: 'u1', username: 'dev', name: 'Dev' },
    files: [],
});

const buildUseCase = (
    options: {
        executions?: ReturnType<typeof makeExecutions>;
        assignedRepositoryIds?: string[] | null;
        teamRepositories?: Array<{ id: string; name: string }>;
        titleMatches?: Array<{ number: number; repositoryId: string }>;
    } = {},
) => {
    const executions = options.executions ?? makeExecutions(70);

    const findExecutions = jest.fn(async (params: any) => {
        if (params.countOnly) {
            return { data: [], total: 4321, distinctPrTotal: 987 };
        }

        const rows = params.cursor
            ? executions.slice(
                  executions.findIndex((e) => e.uuid === params.cursor.uuid) +
                      1,
              )
            : executions.slice(params.skip ?? 0);

        return {
            data: rows.slice(0, params.take ?? 30),
            total: 0,
            distinctPrTotal: 0,
            teamAutomationIds: ['ta-1'],
        };
    });

    // `any`: the test reaches the injected collaborators, which are private.
    const useCase: any = Object.create(
        GetEnrichedPullRequestsUseCase.prototype,
    );

    const findPRNumbersByTitleAndOrganization = jest.fn(
        async () => options.titleMatches ?? [],
    );

    Object.assign(useCase, {
        logger: {
            log: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
            debug: jest.fn(),
        },
        request: { user: { organization: { uuid: 'org-1' } } },
        authorizationService: {
            ensure: jest.fn(),
            getRepositoryScope: jest
                .fn()
                .mockResolvedValue(options.assignedRepositoryIds ?? null),
        },
        automationExecutionService: {
            findPullRequestExecutionsByOrganizationAndTeam: findExecutions,
        },
        pullRequestsService: {
            findManyByNumbersAndRepositoryIds: jest.fn(
                async (criteria: any[]) =>
                    criteria.map((c) => makePrDoc(c.number)),
            ),
            findSuggestionCountsByNumbersAndRepositoryIds: jest.fn(
                async () => new Map(),
            ),
            findPRNumbersByTitleAndOrganization,
        },
        codeReviewExecutionService: {
            findManyByAutomationExecutionIds: jest.fn(async () => []),
        },
        integrationConfigService: {
            findIntegrationConfigFormatted: jest.fn(
                async () => options.teamRepositories ?? [],
            ),
        },
        organizationParametersService: {
            findByKey: jest.fn(async () => null),
        },
    });

    return { useCase, findExecutions, findPRNumbersByTitleAndOrganization };
};

describe('GetEnrichedPullRequestsUseCase — the list does not count by default', () => {
    it('never asks the repository for a total and still pages', async () => {
        const { useCase, findExecutions } = buildUseCase();

        const first = await useCase.execute({ teamId: 't1', limit: 30 });

        expect(first.data).toHaveLength(30);
        expect(first.pagination.hasNextPage).toBe(true);
        expect(first.pagination.nextCursor).toEqual(expect.any(String));
        expect(first.pagination).not.toHaveProperty('totalItems');
        expect(first.pagination).not.toHaveProperty('totalPages');
        expect(first.pagination).not.toHaveProperty('distinctPrTotal');

        const second = await useCase.execute({
            teamId: 't1',
            limit: 30,
            cursor: first.pagination.nextCursor,
        });
        expect(second.data).toHaveLength(30);

        const third = await useCase.execute({
            teamId: 't1',
            limit: 30,
            cursor: second.pagination.nextCursor,
        });
        expect(third.data).toHaveLength(10);
        expect(third.pagination.hasNextPage).toBe(false);

        for (const [params] of findExecutions.mock.calls) {
            expect(params.countOnly).toBeUndefined();
        }
    });

    it('carries no total on a page that has rows', async () => {
        const { useCase } = buildUseCase({ executions: makeExecutions(70) });

        const page = await useCase.execute({ teamId: 't1', limit: 30 });

        expect(page.pagination).not.toHaveProperty('totalItems');
        expect(page.pagination).not.toHaveProperty('totalPages');
        expect(page.pagination).not.toHaveProperty('distinctPrTotal');
        expect(page.pagination.hasNextPage).toBe(true);
    });

    it('answers a zero total when the very first page has nothing', async () => {
        const { useCase } = buildUseCase({ executions: [] });

        const page = await useCase.execute({ teamId: 't1', limit: 30 });

        // Known without counting: the scan started at the top and read no row.
        // The "no reviews yet" screens read exactly this shape.
        expect(page).toEqual({
            data: [],
            pagination: {
                currentPage: 1,
                totalPages: 0,
                totalItems: 0,
                itemsPerPage: 30,
                hasNextPage: false,
                hasPreviousPage: false,
            },
        });
    });

    it('does not claim a zero total for an empty page that is not the first', async () => {
        const executions = makeExecutions(30);
        const { useCase } = buildUseCase({ executions });

        const first = await useCase.execute({ teamId: 't1', limit: 30 });
        // A full last page cannot know it is the last: one more request, empty.
        expect(first.pagination.hasNextPage).toBe(true);

        const beyond = await useCase.execute({
            teamId: 't1',
            limit: 30,
            cursor: first.pagination.nextCursor,
        });

        expect(beyond.data).toEqual([]);
        expect(beyond.pagination.hasNextPage).toBe(false);
        expect(beyond.pagination).not.toHaveProperty('totalItems');
    });
});

describe('GetEnrichedPullRequestsUseCase.countTotals', () => {
    it('counts over the filters and nothing else', async () => {
        const { useCase, findExecutions } = buildUseCase();

        const totals = await useCase.countTotals({
            teamId: 't1',
            status: 'error',
            createdAtFrom: '2026-01-01',
            createdAtTo: '2026-01-31T23:59:59.999',
            pullRequestNumber: 42,
            // paging and post-query filters mean nothing to a count
            limit: 30,
            page: 3,
            authorPolicy: 'reviewable',
            severity: 'high',
        });

        expect(totals).toEqual({ totalItems: 4321, distinctPrTotal: 987 });
        expect(findExecutions).toHaveBeenCalledTimes(1);
        expect(findExecutions).toHaveBeenCalledWith({
            organizationAndTeamData: { organizationId: 'org-1', teamId: 't1' },
            repositoryIds: undefined,
            repositoryName: undefined,
            pullRequestNumber: 42,
            prFilters: undefined,
            status: 'error',
            createdAtFrom: '2026-01-01',
            createdAtTo: '2026-01-31T23:59:59.999',
            countOnly: true,
        });
    });

    it('resolves repository scope, repository name and title exactly as the list does', async () => {
        const options = {
            assignedRepositoryIds: ['repo-1', 'repo-2'],
            teamRepositories: [
                { id: 'repo-1', name: 'api' },
                { id: 'repo-9', name: 'api' },
                { id: 'repo-2', name: 'web' },
            ],
            titleMatches: [{ number: 1001, repositoryId: 'repo-1' }],
        };
        const query = {
            teamId: 't1',
            repositoryName: 'api',
            pullRequestTitle: 'fix login',
        };

        const forList = buildUseCase(options);
        await forList.useCase.execute({ ...query, limit: 30 });
        const forCount = buildUseCase(options);
        await forCount.useCase.countTotals(query);

        const pick = ({ repositoryIds, repositoryName, prFilters }: any) => ({
            repositoryIds,
            repositoryName,
            prFilters,
        });
        const listFilters = pick(forList.findExecutions.mock.calls[0][0]);
        const countFilters = pick(forCount.findExecutions.mock.calls[0][0]);

        expect(countFilters).toEqual(listFilters);
        // repo-9 matches the name but is outside the caller's scope.
        expect(countFilters).toEqual({
            repositoryIds: ['repo-1'],
            repositoryName: undefined,
            prFilters: [{ number: 1001, repositoryId: 'repo-1' }],
        });
        expect(
            forCount.findPRNumbersByTitleAndOrganization,
        ).toHaveBeenCalledWith('fix login', 'org-1', ['repo-1']);
    });

    it('answers zero without querying when the caller has no repository in scope', async () => {
        const { useCase, findExecutions } = buildUseCase({
            assignedRepositoryIds: [],
        });

        await expect(useCase.countTotals({ teamId: 't1' })).resolves.toEqual({
            totalItems: 0,
            distinctPrTotal: 0,
        });
        expect(findExecutions).not.toHaveBeenCalled();
    });

    it('answers zero without querying when no pull request matches the title', async () => {
        const { useCase, findExecutions } = buildUseCase({ titleMatches: [] });

        await expect(
            useCase.countTotals({ teamId: 't1', pullRequestTitle: 'nope' }),
        ).resolves.toEqual({ totalItems: 0, distinctPrTotal: 0 });
        expect(findExecutions).not.toHaveBeenCalled();
    });

    it('checks access to an explicitly requested repository', async () => {
        const { useCase } = buildUseCase();
        useCase.authorizationService.ensure.mockRejectedValue(
            new Error('forbidden'),
        );

        await expect(
            useCase.countTotals({ teamId: 't1', repositoryId: 'repo-7' }),
        ).rejects.toThrow('forbidden');
    });

    it('fails rather than report a count it could not make', async () => {
        const { useCase, findExecutions } = buildUseCase();
        findExecutions.mockRejectedValue(new Error('statement timeout'));

        await expect(useCase.countTotals({ teamId: 't1' })).rejects.toThrow(
            'statement timeout',
        );
    });
});
