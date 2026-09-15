import { TokenUsageService } from './tokenUsage.service';
import { TokenUsageQueryContract } from '@libs/analytics/domain/token-usage/types/tokenUsage.types';

/**
 * The service is a thin pass-through to the repository (#1882 fix): usage
 * spans now carry their own `attributes.repositoryId`, so a `repositoryId`
 * filter no longer needs resolving to the repo's PR numbers here — it rides
 * the query unchanged and the repository's `_tuMatch` matches it directly.
 */
describe('TokenUsageService', () => {
    const baseQuery = (over: Partial<TokenUsageQueryContract> = {}) =>
        ({
            organizationId: 'org-1',
            start: new Date('2026-06-01'),
            end: new Date('2026-06-30'),
            byok: true,
            ...over,
        }) as TokenUsageQueryContract;

    const setup = () => {
        const repository = {
            getSummary: jest.fn().mockResolvedValue({}),
            getUsageByReview: jest.fn().mockResolvedValue([]),
            getUsageOverview: jest.fn().mockResolvedValue({}),
        };
        const service = new TokenUsageService(repository as any);
        return { service, repository };
    };

    it('forwards a repository-scoped query to the repository unchanged', async () => {
        const { service, repository } = setup();

        const query = baseQuery({ repositoryId: 'repo-alpha' });
        await service.getSummary(query);

        expect(repository.getSummary).toHaveBeenCalledWith(query);
    });

    it('forwards an unscoped query unchanged on every read path', async () => {
        const { service, repository } = setup();

        const query = baseQuery();
        await service.getUsageByReview(query);
        await service.getUsageOverview(query);

        expect(repository.getUsageByReview).toHaveBeenCalledWith(query);
        expect(repository.getUsageOverview).toHaveBeenCalledWith(query);
    });
});
