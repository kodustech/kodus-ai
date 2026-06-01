export type TokenUsageQueryContract = {
    organizationId: string;
    start: Date;
    end: Date;
    models?: string;
    prNumber?: number;
    timezone?: string; // for day bucketing
    developer?: string;
    byok: boolean;
};

export interface BaseUsageContract {
    input: number;
    output: number;
    total: number;
    outputReasoning: number;
    /** Input tokens served from provider prompt cache. Subset of `input`. */
    cacheRead?: number;
    /** Input tokens that created cache entries on this call (Anthropic). */
    cacheWrite?: number;
    model: string;
}

export type UsageSummaryContract = BaseUsageContract;

export interface DailyUsageResultContract extends BaseUsageContract {
    date: string; // YYYY-MM-DD
}

export interface UsageByPrResultContract extends BaseUsageContract {
    prNumber: number;
}

export interface DailyUsageByPrResultContract extends UsageByPrResultContract {
    date: string; // YYYY-MM-DD
}

export interface UsageByDeveloperResultContract extends BaseUsageContract {
    developer: string;
}

export interface DailyUsageByDeveloperResultContract extends UsageByDeveloperResultContract {
    date: string; // YYYY-MM-DD
}

export interface TokenUsageBreakdown {
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    totalTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
}

export interface CostEstimateContract {
    estimatedMonthlyCost: number;
    costPerDeveloper: number;
    developerCount: number;
    tokenUsage: TokenUsageBreakdown;
    periodDays: number;
    projectionDays: number;
}
