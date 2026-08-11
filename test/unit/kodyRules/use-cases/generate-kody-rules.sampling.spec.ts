import {
    GenerateKodyRulesUseCase,
    MAX_PULL_REQUESTS_SCANNED,
    PR_FETCH_CONCURRENCY,
    TARGET_SAMPLED_COMMENTS,
    countSubstantiveComments,
    orderPullRequestsNewestFirst,
} from '@libs/kodyRules/application/use-cases/generate-kody-rules.use-case';

const longBody = 'x'.repeat(150);
const shortBody = 'LGTM';

describe('orderPullRequestsNewestFirst', () => {
    it('puts the most recent pull requests first', () => {
        const ordered = orderPullRequestsNewestFirst([
            { pull_number: 1, created_at: '2026-01-01T00:00:00Z' },
            { pull_number: 3, created_at: '2026-03-01T00:00:00Z' },
            { pull_number: 2, created_at: '2026-02-01T00:00:00Z' },
        ]);

        expect(ordered.map((pr: any) => pr.pull_number)).toEqual([3, 2, 1]);
    });

    it('accepts either date field name', () => {
        const ordered = orderPullRequestsNewestFirst([
            { pull_number: 1, createdAt: '2026-01-01T00:00:00Z' },
            { pull_number: 2, createdAt: '2026-05-01T00:00:00Z' },
        ]);

        expect(ordered.map((pr: any) => pr.pull_number)).toEqual([2, 1]);
    });

    // Bitbucket and Forgejo do not populate a creation date on this shape.
    // Their APIs already return newest-first, so the original order is better
    // information than anything we could invent — sorting undated entries to
    // the back would actively make the sample worse.
    it('preserves provider order when no date is available', () => {
        const ordered = orderPullRequestsNewestFirst<{
            pull_number: number;
            created_at?: string;
        }>([{ pull_number: 9 }, { pull_number: 8 }, { pull_number: 7 }]);

        expect(ordered.map((pr: any) => pr.pull_number)).toEqual([9, 8, 7]);
    });

    it('does not reorder around an unparseable date', () => {
        const ordered = orderPullRequestsNewestFirst([
            { pull_number: 1, created_at: 'not a date' },
            { pull_number: 2, created_at: '2026-05-01T00:00:00Z' },
        ]);

        expect(ordered.map((pr: any) => pr.pull_number)).toEqual([1, 2]);
    });

    it('leaves the caller\'s array alone', () => {
        const input = [
            { pull_number: 1, created_at: '2026-01-01T00:00:00Z' },
            { pull_number: 2, created_at: '2026-02-01T00:00:00Z' },
        ];
        orderPullRequestsNewestFirst(input);

        expect(input.map((pr) => pr.pull_number)).toEqual([1, 2]);
    });

    it('tolerates empty and missing input', () => {
        expect(orderPullRequestsNewestFirst([])).toEqual([]);
        expect(orderPullRequestsNewestFirst(undefined as any)).toEqual([]);
    });
});

describe('countSubstantiveComments', () => {
    // Mirrors commentAnalysis.service's own `body.length > 100`. Counting
    // "LGTM" toward the budget would stop the walk before it collected
    // anything a rule could be written from.
    it('counts only comments long enough to carry a convention', () => {
        expect(
            countSubstantiveComments({
                generalComments: [{ body: longBody }, { body: shortBody }],
                reviewComments: [{ body: longBody }],
            }),
        ).toBe(2);
    });

    it('treats missing sides and bodies as zero', () => {
        expect(countSubstantiveComments({})).toBe(0);
        expect(
            countSubstantiveComments({ reviewComments: [{}, { body: null }] }),
        ).toBe(0);
    });
});

describe('sampling budget', () => {
    // The two limits cover different repos: TARGET stops a repo whose PRs
    // carry long review threads, MAX_SCANNED stops one whose PRs are empty
    // and would otherwise be walked forever chasing a target it never hits.
    it('bounds the walk by both a comment target and a scan ceiling', () => {
        expect(TARGET_SAMPLED_COMMENTS).toBeGreaterThan(100);
        expect(MAX_PULL_REQUESTS_SCANNED).toBeGreaterThan(0);
    });

    // The whole point is a bounded worst case. 3 provider calls per PR times
    // the ceiling has to stay well inside GitHub's 5000/hour, or a customer
    // still loses their budget to onboarding.
    it('keeps the worst case far below an hourly GitHub budget', () => {
        const worstCaseRequests = MAX_PULL_REQUESTS_SCANNED * 3;

        expect(worstCaseRequests).toBeLessThanOrEqual(500);
    });

    it('walks in chunks so it can stop before committing to every PR', () => {
        expect(PR_FETCH_CONCURRENCY).toBeLessThan(MAX_PULL_REQUESTS_SCANNED);
    });
});

describe('fetchPullRequestComments (the walk itself)', () => {
    const makeUseCase = (perPrComments: number) => {
        const useCase: any = Object.create(GenerateKodyRulesUseCase.prototype);
        useCase.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
        useCase.fetchSinglePullRequestComments = jest.fn(
            async (_repo: any, pr: any) => ({
                pr,
                generalComments: Array.from({ length: perPrComments }, () => ({
                    body: longBody,
                })),
                reviewComments: [],
                files: [],
            }),
        );
        return useCase;
    };

    // Oldest first, the way an API that ignores our sort would hand them over:
    // PR 1 is the oldest, PR n the newest.
    const prs = (n: number) =>
        Array.from({ length: n }, (_, i) => ({
            pull_number: i + 1,
            created_at: new Date(
                Date.UTC(2026, 0, 1) + i * 60_000,
            ).toISOString(),
        }));

    // The bug: 816 PRs in the window meant 816 fetches (2448 API calls) to
    // build a list truncated to 100 comments.
    it('stops once the comment target is met instead of walking every PR', async () => {
        const useCase = makeUseCase(10);

        await useCase.fetchPullRequestComments({}, prs(816), {});

        const fetched = useCase.fetchSinglePullRequestComments.mock.calls
            .length;
        expect(fetched).toBeLessThanOrEqual(
            TARGET_SAMPLED_COMMENTS / 10 + PR_FETCH_CONCURRENCY,
        );
        expect(fetched).toBeLessThan(816);
    });

    // A repo full of "LGTM" never reaches the target, so the ceiling is the
    // only thing standing between it and the whole window.
    it('stops at the scan ceiling when the target is never reached', async () => {
        const useCase = makeUseCase(0);

        await useCase.fetchPullRequestComments({}, prs(816), {});

        expect(
            useCase.fetchSinglePullRequestComments.mock.calls.length,
        ).toBe(MAX_PULL_REQUESTS_SCANNED);
    });

    it('walks a small repo completely and says nothing about stopping', async () => {
        const useCase = makeUseCase(1);

        const out = await useCase.fetchPullRequestComments({}, prs(12), {});

        expect(useCase.fetchSinglePullRequestComments.mock.calls.length).toBe(
            12,
        );
        expect(out).toHaveLength(12);
        expect(useCase.logger.log).not.toHaveBeenCalled();
    });

    // A cap that trims coverage silently reads as "this repo has no
    // conventions" when someone later wonders why the rule set is thin.
    it('reports what it left unscanned', async () => {
        const useCase = makeUseCase(0);

        await useCase.fetchPullRequestComments({}, prs(816), {});

        expect(useCase.logger.log).toHaveBeenCalledWith(
            expect.objectContaining({
                metadata: expect.objectContaining({
                    pullRequestsInWindow: 816,
                    pullRequestsScanned: MAX_PULL_REQUESTS_SCANNED,
                }),
            }),
        );
    });

    // The quality half of the bug: the old walk filled its quota in the order
    // the provider returned, so rules were learned from the OLDEST reviews in
    // the window -- the least current conventions in the repo.
    // Multi-tenant: "we stopped early on repo X" is unusable without knowing
    // whose repo X is, and this log is the only trace that coverage was
    // trimmed at all.
    it('names the organization when it reports an early stop', async () => {
        const useCase = makeUseCase(0);

        await useCase.fetchPullRequestComments({}, prs(816), {
            organizationId: 'org-1',
        });

        expect(useCase.logger.log).toHaveBeenCalledWith(
            expect.objectContaining({
                metadata: expect.objectContaining({ organizationId: 'org-1' }),
            }),
        );
    });

    it('takes the NEWEST pull requests, not the first ones the API returned', async () => {
        const useCase = makeUseCase(0);

        await useCase.fetchPullRequestComments({}, prs(300), {});

        const scanned = useCase.fetchSinglePullRequestComments.mock.calls.map(
            (call: any[]) => call[1].pull_number,
        );
        expect(scanned).toHaveLength(MAX_PULL_REQUESTS_SCANNED);
        expect(Math.max(...scanned)).toBe(300);
        expect(Math.min(...scanned)).toBe(300 - MAX_PULL_REQUESTS_SCANNED + 1);
    });
});
