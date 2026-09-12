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
import { Inject, Injectable } from '@nestjs/common';

/**
 * Thin pass-through to the repository. Repository scoping used to be resolved
 * here (a `repositoryId` → the repo's PR numbers, since usage spans carried
 * no repository id at all), but every usage span now carries its own
 * `attributes.repositoryId` (#1882 fix) — the repository's `_tuMatch` matches
 * it directly, so `query.repositoryId` rides through unchanged and this class
 * has nothing left to resolve.
 */
@Injectable()
export class TokenUsageService implements ITokenUsageService {
    constructor(
        @Inject(TOKEN_USAGE_REPOSITORY_TOKEN)
        private readonly repository: ITokenUsageRepository,
    ) {}

    getSummary(query: TokenUsageQueryContract): Promise<UsageSummaryContract> {
        return this.repository.getSummary(query);
    }

    getSummaryByModel(
        query: TokenUsageQueryContract,
    ): Promise<BaseUsageContract[]> {
        return this.repository.getSummaryByModel(query);
    }

    getDailyUsage(
        query: TokenUsageQueryContract,
    ): Promise<DailyUsageResultContract[]> {
        return this.repository.getDailyUsage(query);
    }

    getUsageByPr(
        query: TokenUsageQueryContract,
    ): Promise<UsageByPrResultContract[]> {
        return this.repository.getUsageByPr(query);
    }

    getDailyUsageByPr(
        query: TokenUsageQueryContract,
    ): Promise<DailyUsageByPrResultContract[]> {
        return this.repository.getDailyUsageByPr(query);
    }

    getUsageByReview(
        query: TokenUsageQueryContract,
    ): Promise<UsageByReviewResultContract[]> {
        return this.repository.getUsageByReview(query);
    }

    getUsageByArea(
        query: TokenUsageQueryContract,
    ): Promise<UsageByAreaResultContract[]> {
        return this.repository.getUsageByArea(query);
    }

    getModelCredentialPairs(
        query: TokenUsageQueryContract,
    ): Promise<Array<{ model: string; credentialId: string }>> {
        return this.repository.getModelCredentialPairs(query);
    }

    getUsageOverview(query: TokenUsageQueryContract) {
        return this.repository.getUsageOverview(query);
    }
}
