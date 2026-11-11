import { GetEnrichedPullRequestsUseCase } from './get-enriched-pull-requests.use-case';

/**
 * "Needs attention" and "open" are properties of the PR document, so the list
 * could only apply them after reading a batch of executions and loading their
 * PRs. Open PRs are a sliver of a team's history: a request read 300
 * executions to keep a handful, and the reader scrolled through page after
 * short page.
 *
 * The list now asks MongoDB for those PRs first and hands their keys to the
 * execution query. That is a shortcut, not a new rule: the filters in the loop
 * still decide, so the rows must be exactly the ones the scan would have
 * found.
 */

const BASE = Date.UTC(2026, 0, 15, 12, 0, 0);
const TOTAL = 900;

// One execution per PR, newest first. Every 60th PR is open with a suggestion
// nobody applied; every 45th is open with nothing pending; the rest are closed.
const isOpen = (n: number) => n % 60 === 0 || n % 45 === 0;
const hasUnresolved = (n: number) => n % 60 === 0;

const EXECUTIONS = Array.from({ length: TOTAL }, (_, i) => ({
    uuid: `exec-${String(i).padStart(4, '0')}`,
    createdAt: new Date(BASE - i * 60_000),
    updatedAt: new Date(BASE - i * 60_000),
    status: 'success',
    errorMessage: null,
    origin: 'webhook',
    pullRequestNumber: i + 1,
    repositoryId: 'repo-1',
    dataExecution: {},
}));

const prDoc = (number: number) => ({
    uuid: `pr-${number}`,
    number,
    title: `PR ${number}`,
    status: isOpen(number) ? 'open' : 'closed',
    merged: !isOpen(number),
    url: `https://example.test/pr/${number}`,
    baseBranchRef: 'main',
    headBranchRef: `feat/${number}`,
    repository: { id: 'repo-1', name: 'api' },
    openedAt: new Date(BASE),
    createdAt: new Date(BASE),
    updatedAt: new Date(BASE),
    provider: 'github',
    user: { id: 'u1', username: 'dev', name: 'Dev' },
    files: [],
});

const allNumbers = Array.from({ length: TOTAL }, (_, i) => i + 1);
const keysOf = (numbers: number[]) =>
    numbers.map((number) => ({ number, repositoryId: 'repo-1' }));

type OpenKeys =
    | {
          keys: Array<{ number: number; repositoryId: string }>;
          truncated: boolean;
      }
    | Error;

const buildUseCase = (
    options: {
        openKeys?: (unresolvedOnly: boolean) => OpenKeys;
        titleMatches?: Array<{ number: number; repositoryId: string }>;
    } = {},
) => {
    const findExecutions = jest.fn(async (params: any) => {
        let rows = EXECUTIONS;
        if (params.prFilters) {
            const wanted = new Set(
                params.prFilters.map(
                    (pr: any) => `${pr.repositoryId}#${pr.number}`,
                ),
            );
            rows = rows.filter((row) =>
                wanted.has(`${row.repositoryId}#${row.pullRequestNumber}`),
            );
        }
        const start = params.cursor
            ? rows.findIndex((row) => row.uuid === params.cursor.uuid) + 1
            : (params.skip ?? 0);

        return {
            data: rows.slice(start, start + (params.take ?? 30)),
            total: 0,
            distinctPrTotal: 0,
        };
    });

    const findOpenPullRequestKeys = jest.fn(
        async (_org: string, _repos: string[] | undefined, opts: any) => {
            const answer = options.openKeys
                ? options.openKeys(Boolean(opts.unresolvedOnly))
                : {
                      keys: keysOf(
                          allNumbers.filter((n) =>
                              opts.unresolvedOnly
                                  ? isOpen(n) && hasUnresolved(n)
                                  : isOpen(n),
                          ),
                      ),
                      truncated: false,
                  };
            if (answer instanceof Error) throw answer;
            return answer;
        },
    );

    // `any`: the test reaches the injected collaborators, which are private.
    const useCase: any = Object.create(
        GetEnrichedPullRequestsUseCase.prototype,
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
            getRepositoryScope: jest.fn().mockResolvedValue(['repo-1']),
        },
        automationExecutionService: {
            findPullRequestExecutionsByOrganizationAndTeam: findExecutions,
        },
        pullRequestsService: {
            findManyByNumbersAndRepositoryIds: jest.fn(
                async (criteria: any[]) => criteria.map((c) => prDoc(c.number)),
            ),
            findSuggestionCountsByNumbersAndRepositoryIds: jest.fn(
                async (criteria: any[]) =>
                    new Map(
                        criteria.map((c) => [
                            `${c.repositoryId}_${c.number}`,
                            {
                                sent: hasUnresolved(c.number) ? 1 : 0,
                                filtered: 0,
                                unresolved: hasUnresolved(c.number) ? 1 : 0,
                            },
                        ]),
                    ),
            ),
            findPRNumbersByTitleAndOrganization: jest.fn(
                async () => options.titleMatches ?? [],
            ),
            findOpenPullRequestKeys,
        },
        codeReviewExecutionService: {
            findManyByAutomationExecutionIds: jest.fn(async () => []),
        },
        integrationConfigService: {
            findIntegrationConfigFormatted: jest.fn(async () => []),
        },
        organizationParametersService: {
            findByKey: jest.fn(async () => null),
        },
    });

    return { useCase, findExecutions, findOpenPullRequestKeys };
};

const numbersOf = (response: any): number[] =>
    response.data.map((row: any) => row.prNumber);

/** Follows the cursor to the end, as the infinite list does. */
const readAll = async (useCase: any, query: Record<string, unknown>) => {
    const numbers: number[] = [];
    let cursor: string | undefined;
    let requests = 0;
    for (;;) {
        const page = await useCase.execute({ ...query, cursor });
        requests++;
        numbers.push(...numbersOf(page));
        cursor = page.pagination.nextCursor;
        if (!page.pagination.hasNextPage || requests > 50) break;
    }
    return { numbers, requests };
};

const needsAttentionNumbers = allNumbers.filter(
    (n) => isOpen(n) && hasUnresolved(n),
);
const openNumbers = allNumbers.filter(isOpen);

describe('GetEnrichedPullRequestsUseCase — open pull requests resolved up front', () => {
    it('reads "needs attention" from the PRs that need it, in one request', async () => {
        const { useCase, findExecutions, findOpenPullRequestKeys } =
            buildUseCase();

        const page = await useCase.execute({
            teamId: 't1',
            limit: 30,
            needsAttention: true,
        });

        // 15 PRs need attention across 900 executions: one batch, all of them.
        expect(numbersOf(page)).toEqual(needsAttentionNumbers);
        expect(page.pagination.hasNextPage).toBe(false);
        expect(findExecutions).toHaveBeenCalledTimes(1);
        expect(findExecutions.mock.calls[0][0].prFilters).toEqual(
            keysOf(needsAttentionNumbers),
        );
        expect(findOpenPullRequestKeys).toHaveBeenCalledWith(
            'org-1',
            ['repo-1'],
            { unresolvedOnly: true, limit: 5000 },
        );
    });

    it('finds the same PRs the scan finds, in far fewer requests', async () => {
        const query = { teamId: 't1', limit: 30, needsAttention: true };

        const narrowed = buildUseCase();
        const withShortcut = await readAll(narrowed.useCase, query);

        // More open PRs than is worth resolving → the scan is left alone.
        const scanning = buildUseCase({
            openKeys: () => ({ keys: [], truncated: true }),
        });
        const withScan = await readAll(scanning.useCase, query);

        expect(withShortcut.numbers).toEqual(withScan.numbers);
        expect(withShortcut.numbers).toEqual(needsAttentionNumbers);
        expect(withShortcut.requests).toBe(1);
        // 900 executions at 300 per request, plus the request that finds the
        // source exhausted: 30 full batches and an empty one.
        expect(withScan.requests).toBe(4);
        expect(narrowed.findExecutions).toHaveBeenCalledTimes(1);
        expect(scanning.findExecutions).toHaveBeenCalledTimes(31);
    });

    it('does the same for the open-PR filter, without the suggestion condition', async () => {
        const query = { teamId: 't1', limit: 30, prState: 'open' };

        const narrowed = buildUseCase();
        const withShortcut = await readAll(narrowed.useCase, query);
        const scanning = buildUseCase({
            openKeys: () => ({ keys: [], truncated: true }),
        });
        const withScan = await readAll(scanning.useCase, query);

        expect(withShortcut.numbers).toEqual(openNumbers);
        expect(withShortcut.numbers).toEqual(withScan.numbers);
        expect(narrowed.findOpenPullRequestKeys).toHaveBeenCalledWith(
            'org-1',
            ['repo-1'],
            { unresolvedOnly: false, limit: 5000 },
        );
    });

    it('still lets the loop decide: a key that no longer qualifies is dropped', async () => {
        // MongoDB answered with a PR that is closed by the time it is loaded.
        const { useCase } = buildUseCase({
            openKeys: () => ({
                keys: keysOf([60, 61, 120]),
                truncated: false,
            }),
        });

        const page = await useCase.execute({
            teamId: 't1',
            limit: 30,
            needsAttention: true,
        });

        expect(numbersOf(page)).toEqual([60, 120]);
    });

    it('answers empty without reading executions when nothing is open', async () => {
        const { useCase, findExecutions } = buildUseCase({
            openKeys: () => ({ keys: [], truncated: false }),
        });

        const page = await useCase.execute({
            teamId: 't1',
            limit: 30,
            needsAttention: true,
        });

        expect(page.data).toEqual([]);
        expect(page.pagination).toMatchObject({
            totalItems: 0,
            hasNextPage: false,
        });
        expect(findExecutions).not.toHaveBeenCalled();
    });

    it('scans as before when the lookup fails', async () => {
        const { useCase, findExecutions } = buildUseCase({
            openKeys: () => new Error('operation exceeded time limit'),
        });

        const page = await useCase.execute({
            teamId: 't1',
            limit: 30,
            needsAttention: true,
        });

        // First request of the scan: 300 executions read, 5 kept.
        expect(numbersOf(page)).toEqual([60, 120, 180, 240, 300]);
        expect(page.pagination.hasNextPage).toBe(true);
        expect(findExecutions.mock.calls[0][0].prFilters).toBeUndefined();
        expect(useCase.logger.warn).toHaveBeenCalledTimes(1);
    });

    it('keeps a title search and the open PRs both in force', async () => {
        const { useCase, findExecutions } = buildUseCase({
            titleMatches: keysOf([59, 60, 120, 121]),
        });

        const page = await useCase.execute({
            teamId: 't1',
            limit: 30,
            needsAttention: true,
            pullRequestTitle: 'checkout',
        });

        expect(numbersOf(page)).toEqual([60, 120]);
        expect(findExecutions.mock.calls[0][0].prFilters).toEqual(
            keysOf([60, 120]),
        );
    });

    it('answers empty when the title matches and the open PRs do not overlap', async () => {
        const { useCase, findExecutions } = buildUseCase({
            titleMatches: keysOf([1, 2, 3]),
        });

        const page = await useCase.execute({
            teamId: 't1',
            limit: 30,
            prState: 'open',
            pullRequestTitle: 'checkout',
        });

        expect(page.data).toEqual([]);
        expect(findExecutions).not.toHaveBeenCalled();
    });

    it('does not look up open PRs for requests that do not filter on them', async () => {
        const { useCase, findOpenPullRequestKeys } = buildUseCase();

        await useCase.execute({ teamId: 't1', limit: 30 });
        await useCase.execute({ teamId: 't1', limit: 30, prState: 'closed' });
        await useCase.execute({ teamId: 't1', limit: 30, status: 'error' });

        expect(findOpenPullRequestKeys).not.toHaveBeenCalled();
    });
});
