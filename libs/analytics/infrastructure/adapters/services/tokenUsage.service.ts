import {
    ITokenUsageRepository,
    TOKEN_USAGE_REPOSITORY_TOKEN,
} from '@libs/analytics/domain/token-usage/contracts/tokenUsage.repository.contract';
import { ITokenUsageService } from '@libs/analytics/domain/token-usage/contracts/tokenUsage.service.contract';
import {
    BaseUsageContract,
    DailyUsageByPrResultContract,
    DailyUsageResultContract,
    TokenUsageQueryContract,
    UsageByAreaResultContract,
    UsageByPrResultContract,
    UsageByReviewResultContract,
    UsageSummaryContract,
} from '@libs/analytics/domain/token-usage/types/tokenUsage.types';
import {
    IPullRequestsService,
    PULL_REQUESTS_SERVICE_TOKEN,
} from '@libs/platformData/domain/pullRequests/contracts/pullRequests.service.contracts';
import { CacheService } from '@libs/core/cache/cache.service';
import { Inject, Injectable } from '@nestjs/common';

// One Token Usage page load fans out to several reads (overview + by-review /
// by-developer). Memoize the repo→PR resolution briefly so the same filter
// doesn't re-run findNumbersByRepositoryId once per read. Keyed by
// org|repo|window-end, so a different window or repo misses.
const REPO_SCOPE_TTL_MS = 60 * 1000;

@Injectable()
export class TokenUsageService implements ITokenUsageService {
    constructor(
        @Inject(TOKEN_USAGE_REPOSITORY_TOKEN)
        private readonly repository: ITokenUsageRepository,

        @Inject(PULL_REQUESTS_SERVICE_TOKEN)
        private readonly pullRequestsService: IPullRequestsService,

        private readonly cacheService: CacheService,
    ) {}

    /**
     * Usage spans carry no repository id, so a repository filter resolves to
     * the repo's PR numbers here (single choke point for every read path)
     * and the Mongo match scopes `attributes.prNumber` with them. A repo
     * with no PRs yields an empty list, which matches nothing — correct.
     *
     * The resolution is memoized (short TTL) so the several reads of one page
     * load share a single findNumbersByRepositoryId query.
     */
    private async withRepositoryScope(
        query: TokenUsageQueryContract,
    ): Promise<TokenUsageQueryContract> {
        if (!query.repositoryId || query.prNumbers) return query;

        const cacheKey = [
            'usage:repo-scope',
            query.organizationId,
            query.repositoryId,
            query.end.getTime(),
        ].join('|');
        let prNumbers =
            await this.cacheService.getFromCache<number[]>(cacheKey);
        if (!prNumbers) {
            prNumbers = await this.pullRequestsService.findNumbersByRepositoryId(
                query.organizationId,
                query.repositoryId,
                query.end,
            );
            await this.cacheService.addToCache(
                cacheKey,
                prNumbers,
                REPO_SCOPE_TTL_MS,
            );
        }
        return { ...query, prNumbers };
    }

    async getSummary(
        query: TokenUsageQueryContract,
    ): Promise<UsageSummaryContract> {
        return this.repository.getSummary(await this.withRepositoryScope(query));
    }

    async getSummaryByModel(
        query: TokenUsageQueryContract,
    ): Promise<BaseUsageContract[]> {
        return this.repository.getSummaryByModel(await this.withRepositoryScope(query));
    }

    async getDailyUsage(
        query: TokenUsageQueryContract,
    ): Promise<DailyUsageResultContract[]> {
        return this.repository.getDailyUsage(await this.withRepositoryScope(query));
    }

    async getUsageByPr(
        query: TokenUsageQueryContract,
    ): Promise<UsageByPrResultContract[]> {
        return this.repository.getUsageByPr(await this.withRepositoryScope(query));
    }

    async getDailyUsageByPr(
        query: TokenUsageQueryContract,
    ): Promise<DailyUsageByPrResultContract[]> {
        return this.repository.getDailyUsageByPr(await this.withRepositoryScope(query));
    }

    async getUsageByReview(
        query: TokenUsageQueryContract,
    ): Promise<UsageByReviewResultContract[]> {
        return this.repository.getUsageByReview(await this.withRepositoryScope(query));
    }

    async getUsageByArea(
        query: TokenUsageQueryContract,
    ): Promise<UsageByAreaResultContract[]> {
        return this.repository.getUsageByArea(await this.withRepositoryScope(query));
    }

    async getUsageOverview(query: TokenUsageQueryContract) {
        return this.repository.getUsageOverview(
            await this.withRepositoryScope(query),
        );
    }
}
