// @ts-nocheck
import { GetEnrichedPullRequestsUseCase } from './get-enriched-pull-requests.use-case';

/**
 * A page must start where the previous page STOPPED READING, not where it
 * stopped emitting.
 *
 * `execute` fills a page by looping: it asks the repository for `take: limit`
 * executions, drops the ones that fail a post-query filter (author policy, a
 * PR whose Mongo doc was pruned, needsAttention, author, severity, category,
 * hasSentSuggestions) and asks again until it has `limit` rows to return. One
 * page of 30 rows can therefore consume 60, 90, 300 executions.
 *
 * The offset for the next page did not know that. `initialSkip = (page - 1) *
 * limit` assumes each page consumes exactly `limit` executions, so page 2
 * restarted at execution 30 — inside the window page 1 had already served.
 * Every execution between `limit` and "what page 1 actually read" came back a
 * second time.
 *
 * It hid because the client de-duplicates: `useInfinitePullRequestExecutions`
 * collapses pages into a Map keyed by execution id, so the repeats overwrite
 * instead of stacking. What the user sees is an infinite scroll that fetches a
 * full page and grows by a handful of rows — and `getNextPageParam` keeps
 * paging because it measures the raw page length, not how many rows were new.
 *
 * The fix is a cursor: the response carries the position of the last execution
 * actually read, and the next page resumes from it.
 */

const BASE = Date.UTC(2026, 0, 15, 12, 0, 0);
// Not a multiple of the page size, so the final batch comes back short. That
// is how a keyset scan learns it is finished; with an exact multiple the last
// full batch is indistinguishable from a middle one and the client pays one
// extra empty request to find out.
const TOTAL = 250;

// Distinct createdAt per row (strictly descending) so a keyset cursor is
// unambiguous, and one PR per execution so nothing here depends on how
// repeated reviews of the same PR are grouped.
const ALL_EXECUTIONS = Array.from({ length: TOTAL }, (_, i) => ({
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

// Only every other execution survives enrichment: the odd ones have no Mongo
// document, which is the `continue` at the top of the try block. Filling 30
// rows therefore reads 60 executions — exactly the drift the offset ignored.
const hasMongoDoc = (prNumber: number) => prNumber % 2 === 0;

const makePrDoc = (prNumber: number) => ({
    uuid: `pr-${prNumber}`,
    number: prNumber,
    title: `PR ${prNumber}`,
    status: 'open',
    merged: false,
    heavy: false,
    url: `https://example.test/pr/${prNumber}`,
    baseBranchRef: 'main',
    headBranchRef: `feat/${prNumber}`,
    repository: { id: 'repo-1', name: 'api' },
    openedAt: new Date(BASE),
    closedAt: null,
    createdAt: new Date(BASE),
    updatedAt: new Date(BASE),
    provider: 'github',
    user: { id: 'u1', username: 'dev', name: 'Dev' },
    isDraft: false,
    files: [],
});

const buildUseCase = () => {
    const findExecutions = jest.fn(async (params) => {
        let rows = ALL_EXECUTIONS;

        if (params.cursor) {
            const at = ALL_EXECUTIONS.findIndex(
                (e) => e.uuid === params.cursor.uuid,
            );
            rows = ALL_EXECUTIONS.slice(at + 1);
        } else {
            rows = ALL_EXECUTIONS.slice(params.skip ?? 0);
        }

        return {
            data: rows.slice(0, params.take ?? 30),
            total: TOTAL,
            distinctPrTotal: TOTAL,
        };
    });

    const useCase = Object.create(
        GetEnrichedPullRequestsUseCase.prototype,
    ) as GetEnrichedPullRequestsUseCase;

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
            getRepositoryScope: jest.fn().mockResolvedValue(null),
        },
        automationExecutionService: {
            findPullRequestExecutionsByOrganizationAndTeam: findExecutions,
        },
        pullRequestsService: {
            findManyByNumbersAndRepositoryIds: jest.fn(async (criteria) =>
                criteria
                    .filter((c) => hasMongoDoc(c.number))
                    .map((c) => makePrDoc(c.number)),
            ),
            findSuggestionCountsByNumbersAndRepositoryIds: jest.fn(
                async () => new Map(),
            ),
            findPRNumbersByTitleAndOrganization: jest.fn(async () => []),
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

    return { useCase, findExecutions };
};

const idsOf = (response) =>
    response.data.map((row) => row.executionId ?? row.automationExecution?.uuid);

describe('GetEnrichedPullRequestsUseCase — paging across post-query filters', () => {
    it('does not serve the same execution on two consecutive pages', async () => {
        const { useCase } = buildUseCase();

        const first = await useCase.execute({ teamId: 't1', limit: 30, page: 1 });
        const firstIds = idsOf(first);
        expect(firstIds).toHaveLength(30);

        const second = await useCase.execute({
            teamId: 't1',
            limit: 30,
            // Resume from where page 1 stopped reading. Falls back to the page
            // offset when the caller has no cursor (page 1, or an old client).
            cursor: first.pagination.nextCursor,
        });

        const overlap = idsOf(second).filter((id) => firstIds.includes(id));
        expect(overlap).toEqual([]);
    });

    it('advances by a full page of new rows, not by what the offset guessed', async () => {
        const { useCase } = buildUseCase();

        const seen = new Set<string>();
        let cursor: string | undefined;

        for (let i = 0; i < 3; i++) {
            const page = await useCase.execute({
                teamId: 't1',
                limit: 30,
                cursor,
            });
            idsOf(page).forEach((id) => seen.add(id));
            cursor = page.pagination.nextCursor;
        }

        // Three pages of 30 must be 90 distinct rows. Under the offset bug the
        // second and third pages largely repeated the first.
        expect(seen.size).toBe(90);
    });

    it('reports the cursor of the last execution READ, not the last emitted', async () => {
        const { useCase } = buildUseCase();

        const page = await useCase.execute({ teamId: 't1', limit: 30, page: 1 });

        // The 30th surviving row is exec-058 (every other execution is
        // dropped), and the page stops there — exec-059 was never read. So the
        // resume point is exec-058: past the 30 executions a page offset would
        // have assumed, and not one row further than what was actually served.
        expect(page.pagination.nextCursor).toBeDefined();
        const resumeUuid = JSON.parse(
            Buffer.from(page.pagination.nextCursor, 'base64url').toString(),
        ).uuid;
        expect(resumeUuid).toBe('exec-058');
    });

    it('advances past a batch the author policy rejected whole', async () => {
        // A batch where NO PR passes the policy short-circuits before the
        // per-execution loop, so nothing there records what was read. Left
        // alone it re-requests the same window forever: the page never fills,
        // the cursor never moves, and the request hangs on the database rather
        // than on anything visible.
        const { useCase, findExecutions } = buildUseCase();

        const page = await useCase.execute({
            teamId: 't1',
            limit: 30,
            // 'excluded' with no exclusions configured admits nobody, so every
            // batch is rejected in full.
            authorPolicy: 'excluded',
        });

        expect(page.data).toHaveLength(0);
        expect(page.pagination.hasNextPage).toBe(false);

        // 250 executions in batches of 30 → 9 reads, then the short batch ends
        // it. A cursor that did not advance would still be on read 1.
        expect(findExecutions).toHaveBeenCalledTimes(9);

        const uuids = findExecutions.mock.calls.map((c) => c[0].cursor?.uuid);
        expect(new Set(uuids).size).toBe(uuids.length);
    });

    it('stops paging when the source is exhausted', async () => {
        const { useCase } = buildUseCase();

        let cursor: string | undefined;
        let pages = 0;
        let rows = 0;

        for (;;) {
            const page = await useCase.execute({
                teamId: 't1',
                limit: 30,
                cursor,
            });
            pages++;
            cursor = page.pagination.nextCursor;
            rows += page.data.length;
            if (!page.pagination.hasNextPage || pages > 10) break;
        }

        // 250 executions, every other one enrichable → 125 rows → four full
        // pages and a short fifth that ends the scroll. Before the cursor this
        // loop hit the safety cap: every request restarted at page 1.
        expect(pages).toBe(5);
        expect(rows).toBe(125);
    });
});
