export type TokenUsageQueryContract = {
    startDate: string;
    endDate: string;
    prNumber?: number;
    timezone?: string; // for day bucketing
    byok: boolean;
};

export interface BaseUsageContract {
    input: number;
    output: number;
    total: number;
    outputReasoning: number;
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

export type ModelPricingInfo = {
    id: string;
    pricing: {
        prompt: number;
        completion: number;
        internal_reasoning: number;
    };
};
