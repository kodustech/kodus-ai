import {
    BaseUsageContract,
    TokenUsageQueryContract,
    DailyUsageResultContract,
    UsageSummaryContract,
    DailyUsageByPrResultContract,
    UsageByPrResultContract,
    UsageByAreaResultContract,
    UsageByTaskAreaResultContract,
    UsageByTaskModelSpanContract,
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

    /** Distinct (model, credentialId) pairs the org's BYOK usage recorded in the
     *  window (only non-empty credentialId). The usage-derived model→credential
     *  map spend attribution uses — keying on the SAME model-name the usage
     *  recorded, so it no longer drifts against the config name on versioned
     *  response models (the `unattributed` leak). */
    getModelCredentialPairs(
        query: TokenUsageQueryContract,
    ): Promise<Array<{ model: string; credentialId: string }>>;

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
        byTaskArea: UsageByTaskAreaResultContract[];
        byTaskModelSpan: UsageByTaskModelSpanContract[];
    }>;
}
