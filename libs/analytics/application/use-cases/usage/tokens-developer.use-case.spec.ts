import { TokensByDeveloperUseCase } from './tokens-developer.use-case';
import { TokenUsageQueryContract } from '@libs/analytics/domain/token-usage/types/tokenUsage.types';

/**
 * Regression coverage for issue #1882: the by-developer view used to map
 * usage rows to a developer via `findManyByNumbers(numbers, organizationId)`
 * — org + number only, no repository — then keyed a `Map<number, PR>` by
 * `pr.number`. When two PRs on different repositories shared a number,
 * whichever document the batch fetch returned last silently overwrote the
 * other in the map, so every usage row for that number attributed to one
 * PR's author only.
 *
 * Fixed by keying on `${repositoryId}|${number}` and using
 * `findManyByNumbersAndRepositoryIds` for usage rows that carry a
 * `repositoryId` (every row from #1882 onward). Rows without one (written
 * before the fix) still fall back to the old org+number lookup.
 */
describe('TokensByDeveloperUseCase — repository scope (#1882)', () => {
    const baseQuery = (
        over: Partial<TokenUsageQueryContract> = {},
    ): TokenUsageQueryContract =>
        ({
            organizationId: 'org-1',
            start: new Date('2026-06-01'),
            end: new Date('2026-06-30'),
            byok: true,
            ...over,
        }) as TokenUsageQueryContract;

    const setup = () => {
        const tokenUsageService = {
            getUsageByPr: jest.fn(),
            getDailyUsageByPr: jest.fn(),
        };
        const pullRequestsService = {
            findManyByNumbers: jest.fn().mockResolvedValue([]),
            findManyByNumbersAndRepositoryIds: jest.fn().mockResolvedValue([]),
        };
        const cacheService = {
            getFromCache: jest.fn().mockResolvedValue(null),
            addToCache: jest.fn(),
        };
        const useCase = new TokensByDeveloperUseCase(
            tokenUsageService as any,
            pullRequestsService as any,
            cacheService as any,
        );
        return { useCase, tokenUsageService, pullRequestsService, cacheService };
    };

    it('two PRs sharing a number across repos attribute to their own, distinct developer', async () => {
        const { useCase, tokenUsageService, pullRequestsService } = setup();

        // repo A's PR #1 (alice) and repo B's PR #1 (bob) both have usage in
        // the window — the by-PR read now carries repositoryId alongside
        // the bare number.
        tokenUsageService.getUsageByPr.mockResolvedValue([
            {
                prNumber: 1,
                repositoryId: 'repo-a',
                model: 'gpt-4o',
                input: 10,
                output: 5,
                total: 15,
                outputReasoning: 0,
            },
            {
                prNumber: 1,
                repositoryId: 'repo-b',
                model: 'gpt-4o',
                input: 2,
                output: 1,
                total: 3,
                outputReasoning: 0,
            },
        ]);
        pullRequestsService.findManyByNumbersAndRepositoryIds.mockResolvedValue(
            [
                {
                    number: 1,
                    repository: { id: 'repo-a' },
                    user: { username: 'alice' },
                },
                {
                    number: 1,
                    repository: { id: 'repo-b' },
                    user: { username: 'bob' },
                },
            ],
        );

        const result = await useCase.execute(baseQuery(), false);

        expect(result).toHaveLength(2);
        expect(result.find((r) => r.total === 15)?.developer).toBe('alice');
        expect(result.find((r) => r.total === 3)?.developer).toBe('bob');
    });

    it('looks up PRs by (number, repositoryId), not by number alone', async () => {
        const { useCase, tokenUsageService, pullRequestsService } = setup();

        tokenUsageService.getUsageByPr.mockResolvedValue([
            {
                prNumber: 1,
                repositoryId: 'repo-a',
                model: 'gpt-4o',
                input: 1,
                output: 1,
                total: 2,
                outputReasoning: 0,
            },
        ]);

        await useCase.execute(baseQuery({ repositoryId: 'repo-a' }), false);

        expect(
            pullRequestsService.findManyByNumbersAndRepositoryIds,
        ).toHaveBeenCalledWith(
            [{ number: 1, repositoryId: 'repo-a' }],
            'org-1',
        );
        expect(pullRequestsService.findManyByNumbers).not.toHaveBeenCalled();
    });

    it('falls back to the org+number lookup for legacy rows with no repositoryId', async () => {
        const { useCase, tokenUsageService, pullRequestsService } = setup();

        tokenUsageService.getUsageByPr.mockResolvedValue([
            {
                prNumber: 7,
                model: 'gpt-4o',
                input: 1,
                output: 1,
                total: 2,
                outputReasoning: 0,
            },
        ]);
        pullRequestsService.findManyByNumbers.mockResolvedValue([
            { number: 7, user: { username: 'carol' }, organizationId: 'org-1' },
        ]);

        const result = await useCase.execute(baseQuery(), false);

        expect(pullRequestsService.findManyByNumbers).toHaveBeenCalledWith(
            [7],
            'org-1',
        );
        expect(result[0].developer).toBe('carol');
    });
});
