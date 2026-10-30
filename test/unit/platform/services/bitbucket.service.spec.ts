// Mock logger so BitbucketService can be instantiated
jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    }),
}));

import { BitbucketCloudService } from '@libs/platform/infrastructure/adapters/services/bitbucket/bitbucket-cloud.service';

/**
 * ── Onboarding pagination early-stop ────────────────────────────────
 * Onboarding (GET /code-management/get-prs) requests PRs sorted
 * `-created_on` (newest first) and only keeps the last 30 days. The old
 * code fetched EVERY page (~2k PRs on large repos) before filtering,
 * which hung the "Doing some magic…" screen.
 *
 * getPaginatedResults now accepts `stopAfterPage` (stop once a page
 * satisfies a predicate) and `limit` (cap the total). getPullRequestsByRepo
 * passes a stopAfterPage that stops as soon as a page's oldest PR predates
 * startDate — every later page is older still.
 */
describe('BitbucketCloudService.getPaginatedResults — early stop options', () => {
    // Build a fake Bitbucket API that serves scripted pages.
    function makeFakeApi(pages: Array<Array<{ created_on?: string }>>) {
        const getNextPage = jest.fn(async (data: any) => {
            const nextIndex = data.__pageIndex + 1;
            return {
                data: { values: pages[nextIndex], __pageIndex: nextIndex },
            };
        });

        const api = {
            hasNextPage: (data: any) => data.__pageIndex < pages.length - 1,
            getNextPage,
        };

        const response = { data: { values: pages[0], __pageIndex: 0 } };

        return { api, response, getNextPage };
    }

    // Only the pagination param is exercised, so dummy deps are fine.
    const service = new (BitbucketCloudService as any)({}, {}, {}, {});
    const call = (api: any, response: any, options?: any) =>
        (service as any).getPaginatedResults(api, response, options);

    const dates = (prs: Array<{ created_on?: string }>) =>
        prs.map((pr) => pr.created_on);

    // Mirrors the predicate getPullRequestsByRepo passes: stop once a page's
    // oldest PR (last, given the -created_on sort) predates startDate.
    const stopBefore = (startDate: Date) => (page: Array<{ created_on?: string }>) => {
        if (!startDate || !page.length) return false;
        const oldest = page[page.length - 1];
        return oldest?.created_on
            ? new Date(oldest.created_on) < startDate
            : false;
    };

    it('stops paging once a page ends before startDate', async () => {
        const startDate = new Date('2024-06-01T00:00:00Z');
        const { api, response, getNextPage } = makeFakeApi([
            [{ created_on: '2024-06-20T00:00:00Z' }, { created_on: '2024-06-15T00:00:00Z' }],
            [{ created_on: '2024-06-10T00:00:00Z' }, { created_on: '2024-05-25T00:00:00Z' }], // oldest predates startDate
            [{ created_on: '2024-05-01T00:00:00Z' }], // must never be fetched
        ]);

        const result = await call(api, response, {
            stopAfterPage: stopBefore(startDate),
        });

        // page 2 (index 2) is never requested
        expect(getNextPage).toHaveBeenCalledTimes(1);
        // the boundary page is returned intact — the caller's .filter()
        // trims 2024-05-25; the never-fetched page is simply absent
        expect(dates(result)).toEqual([
            '2024-06-20T00:00:00Z',
            '2024-06-15T00:00:00Z',
            '2024-06-10T00:00:00Z',
            '2024-05-25T00:00:00Z',
        ]);
    });

    it('never paginates when the first page already satisfies stopAfterPage', async () => {
        const startDate = new Date('2024-06-01T00:00:00Z');
        const { api, response, getNextPage } = makeFakeApi([
            [{ created_on: '2024-06-05T00:00:00Z' }, { created_on: '2024-05-10T00:00:00Z' }],
            [{ created_on: '2024-04-01T00:00:00Z' }],
        ]);

        const result = await call(api, response, {
            stopAfterPage: stopBefore(startDate),
        });

        expect(getNextPage).not.toHaveBeenCalled();
        expect(dates(result)).toEqual([
            '2024-06-05T00:00:00Z',
            '2024-05-10T00:00:00Z',
        ]);
    });

    it('fetches every page when no options are provided (unchanged default behavior)', async () => {
        const { api, response, getNextPage } = makeFakeApi([
            [{ created_on: '2024-06-20T00:00:00Z' }],
            [{ created_on: '2024-05-20T00:00:00Z' }],
            [{ created_on: '2024-04-20T00:00:00Z' }],
        ]);

        const result = await call(api, response);

        expect(getNextPage).toHaveBeenCalledTimes(2);
        expect(result).toHaveLength(3);
    });

    it('does not crash or falsely early-stop on items missing created_on', async () => {
        const startDate = new Date('2024-06-01T00:00:00Z');
        const { api, response, getNextPage } = makeFakeApi([
            [{ created_on: '2024-06-20T00:00:00Z' }, {}],
        ]);

        const result = await call(api, response, {
            stopAfterPage: stopBefore(startDate),
        });

        // missing created_on doesn't stop paging; single page so none left
        expect(getNextPage).not.toHaveBeenCalled();
        expect(result).toHaveLength(2);
    });

    it('caps and slices the result when limit is set (author-discovery path)', async () => {
        const { api, response, getNextPage } = makeFakeApi([
            [{ created_on: 'a' }, { created_on: 'b' }],
            [{ created_on: 'c' }, { created_on: 'd' }],
            [{ created_on: 'e' }],
        ]);

        const result = await call(api, response, { limit: 3 });

        // page 0 (2) < 3 → fetch page 1 (now 4 ≥ 3) → stop; page 2 untouched
        expect(getNextPage).toHaveBeenCalledTimes(1);
        expect(dates(result)).toEqual(['a', 'b', 'c']);
    });

    it('returns the initial page sliced when it already exceeds limit', async () => {
        const { api, response, getNextPage } = makeFakeApi([
            [{ created_on: 'a' }, { created_on: 'b' }, { created_on: 'c' }],
            [{ created_on: 'd' }],
        ]);

        const result = await call(api, response, { limit: 2 });

        expect(getNextPage).not.toHaveBeenCalled();
        expect(dates(result)).toEqual(['a', 'b']);
    });

    it('returns [] when the response has no values array', async () => {
        const result = await call({} as any, { data: {} });
        expect(result).toEqual([]);
    });
});
