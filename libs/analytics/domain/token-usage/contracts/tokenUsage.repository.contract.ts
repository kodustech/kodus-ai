import {
    BaseUsageContract,
    TokenUsageQueryContract,
    DailyUsageResultContract,
    UsageSummaryContract,
    DailyUsageByPrResultContract,
    UsageByPrResultContract,
    UsageByAreaResultContract,
    UsageByReviewResultContract,
} from '../types/tokenUsage.types';

export const TOKEN_USAGE_REPOSITORY_TOKEN = Symbol.for('TokenUsageRepository');

export interface ITokenUsageRepository {
    getSummary(query: TokenUsageQueryContract): Promise<UsageSummaryContract>;

    getSummaryByModel(
        query: TokenUsageQueryContract,
    ): Promise<BaseUsageContract[]>;

    getDailyUsage(
        query: TokenUsageQueryContract,
    ): Promise<DailyUsageResultContract[]>;

    getUsageByPr(
        query: TokenUsageQueryContract,
    ): Promise<UsageByPrResultContract[]>;

    getDailyUsageByPr(
        query: TokenUsageQueryContract,
    ): Promise<DailyUsageByPrResultContract[]>;

    /** Per review run (grouped by the run's correlationId). */
    getUsageByReview(
        query: TokenUsageQueryContract,
    ): Promise<UsageByReviewResultContract[]>;

    /** Per process area (attributes.tu.area). */
    getUsageByArea(
        query: TokenUsageQueryContract,
    ): Promise<UsageByAreaResultContract[]>;

    /**
     * Single covered aggregation that returns summary + byModel + daily + byPr
     * + dailyByPr in one pass (collapses ~4 separate scans the screen fires).
     */
    getUsageOverview(query: TokenUsageQueryContract): Promise<{
        summary: UsageSummaryContract;
        byModel: BaseUsageContract[];
        daily: DailyUsageResultContract[];
        byPr: UsageByPrResultContract[];
        byArea: UsageByAreaResultContract[];
    }>;
}
