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
    /** Input tokens served from provider prompt cache (subset of `input`). */
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

export type TokenPrice = {
    default: number;
    above200k?: number;
};

/**
 * Normalized pricing for a single model, sourced from the backend pricing
 * endpoint (which wraps LiteLLM's catalog). Prices are per-token — multiply
 * by 1_000_000 to display "$X per 1M".
 *
 * `prompt`/`completion`/`internal_reasoning` are backward-compat scalars
 * mirroring the default tier of input/output; cost calculations should use
 * the rich input/output/cacheRead/cacheWrite shape.
 */
export type ModelPricingInfo = {
    id: string;
    provider?: string;
    pricing: {
        input: TokenPrice;
        output: TokenPrice;
        cacheRead: TokenPrice;
        cacheWrite: TokenPrice;
        prompt: number;
        completion: number;
        internal_reasoning: number;
    };
};
