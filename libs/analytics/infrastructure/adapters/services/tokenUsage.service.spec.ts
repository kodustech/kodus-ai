import { TokenUsageService } from './tokenUsage.service';
import { TokenUsageQueryContract } from '@libs/analytics/domain/token-usage/types/tokenUsage.types';

/**
 * The service is the single choke point where a `repositoryId` filter is
 * resolved to the repo's PR numbers (spans carry no repo id) and threaded to
 * the Mongo read as `prNumbers`. Every read path must go through it.
 */
describe('TokenUsageService — repository scope', () => {
    const baseQuery = (over: Partial<TokenUsageQueryContract> = {}) =>
        ({
            organizationId: 'org-1',
            start: new Date('2026-06-01'),
            end: new Date('2026-06-30'),
            byok: true,
            ...over,
        }) as TokenUsageQueryContract;

    const setup = (opts: { cacheHit?: number[] } = {}) => {
        const repository = {
            getSummary: jest.fn().mockResolvedValue({}),
            getUsageByReview: jest.fn().mockResolvedValue([]),
            getUsageOverview: jest.fn().mockResolvedValue({}),
        };
        const pullRequestsService = {
            findNumbersByRepositoryId: jest
                .fn()
                .mockResolvedValue([101, 202, 303]),
        };
        // Default: cache miss (pass-through), so per-call assertions hold.
        const cacheService = {
            getFromCache: jest.fn().mockResolvedValue(opts.cacheHit ?? null),
            addToCache: jest.fn(),
        };
        const service = new TokenUsageService(
            repository as any,
            pullRequestsService as any,
            cacheService as any,
        );
        return { service, repository, pullRequestsService, cacheService };
    };

    it('resolves repositoryId → PR numbers and scopes the read with them', async () => {
        const { service, repository, pullRequestsService } = setup();

        await service.getSummary(baseQuery({ repositoryId: 'repo-alpha' }));

        expect(pullRequestsService.findNumbersByRepositoryId).toHaveBeenCalledWith(
            'org-1',
            'repo-alpha',
            new Date('2026-06-30'),
        );
        expect(repository.getSummary).toHaveBeenCalledWith(
            expect.objectContaining({ prNumbers: [101, 202, 303] }),
        );
    });

    it('does not resolve PRs when no repositoryId is set', async () => {
        const { service, repository, pullRequestsService } = setup();

        await service.getSummary(baseQuery());

        expect(
            pullRequestsService.findNumbersByRepositoryId,
        ).not.toHaveBeenCalled();
        expect(repository.getSummary).toHaveBeenCalledWith(
            expect.not.objectContaining({ prNumbers: expect.anything() }),
        );
    });

    it('applies the scope on every read path (e.g. by-review, overview)', async () => {
        const { service, repository, pullRequestsService } = setup();

        await service.getUsageByReview(baseQuery({ repositoryId: 'r' }));
        await service.getUsageOverview(baseQuery({ repositoryId: 'r' }));

        expect(
            pullRequestsService.findNumbersByRepositoryId,
        ).toHaveBeenCalledTimes(2);
        expect(repository.getUsageByReview).toHaveBeenCalledWith(
            expect.objectContaining({ prNumbers: [101, 202, 303] }),
        );
        expect(repository.getUsageOverview).toHaveBeenCalledWith(
            expect.objectContaining({ prNumbers: [101, 202, 303] }),
        );
    });

    it('reuses a memoized resolution instead of re-querying (cache hit)', async () => {
        const { service, repository, pullRequestsService } = setup({
            cacheHit: [55, 66],
        });

        await service.getSummary(baseQuery({ repositoryId: 'repo-alpha' }));

        expect(
            pullRequestsService.findNumbersByRepositoryId,
        ).not.toHaveBeenCalled();
        expect(repository.getSummary).toHaveBeenCalledWith(
            expect.objectContaining({ prNumbers: [55, 66] }),
        );
    });

    it('an empty PR list (repo with no PRs) still scopes — matching nothing', async () => {
        const { service, repository, pullRequestsService } = setup();
        pullRequestsService.findNumbersByRepositoryId.mockResolvedValue([]);

        await service.getSummary(baseQuery({ repositoryId: 'empty-repo' }));

        expect(repository.getSummary).toHaveBeenCalledWith(
            expect.objectContaining({ prNumbers: [] }),
        );
    });
});
