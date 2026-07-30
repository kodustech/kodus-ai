export type TokenUsageQueryContract = {
    startDate: string;
    endDate: string;
    prNumber?: number;
    timezone?: string; // for day bucketing
    /** Scope to one repository (resolved to its PR numbers server-side). */
    repositoryId?: string;
    byok: boolean;
};

/** Token counts for a single tier bucket of calls. */
export interface TierUsage {
    input: number;
    output: number;
    total: number;
    outputReasoning: number;
    cacheRead: number;
    cacheWrite: number;
}

export interface BaseUsageContract {
    model: string;
    /** Flat totals across every tier bucket — sum of `byTier`. */
    input: number;
    output: number;
    total: number;
    outputReasoning: number;
    /** Input tokens served from provider prompt cache (subset of `input`). */
    cacheRead?: number;
    /** Input tokens that created cache entries on this call (Anthropic). */
    cacheWrite?: number;
    /**
     * Per-tier breakdown, indexed by bracket: `byTier[0]` = calls billed at
     * the default rate, `byTier[k]` = calls above the k-th input threshold.
     * Present only for tier-aware models; the UI collapses it to ≤/>threshold.
     */
    byTier?: TierUsage[];
}

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

/**
 * One review run (correlationId). A PR reviewed more than once yields one row
 * per run.
 */
export interface UsageByReviewResultContract extends BaseUsageContract {
    review: string;
    prNumber?: number;
    startedAt?: string;
}

/** Token spend grouped by process area (review, kody_rules, cross_file, …). */
export interface UsageByAreaResultContract extends BaseUsageContract {
    area: string;
}

export interface DailyUsageByDeveloperResultContract
    extends UsageByDeveloperResultContract {
    date: string; // YYYY-MM-DD
}

/** USD-denominated cost broken down by token type. */
export interface CostBreakdown {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
}

/**
 * `'missing'` means the backend could not price this model (no manual override
 * and no catalog entry). The UI surfaces a warning and excludes the row from
 * cost totals.
 */
export type PricingSource = 'manual' | 'catalog' | 'missing';

/** Per-model row enriched server-side with cost + pricing source. */
export interface EnrichedModelUsage extends BaseUsageContract {
    cost: CostBreakdown;
    /** Cost per bracket, aligned index-for-index with `byTier`. */
    costByTier?: CostBreakdown[];
    pricingSource: PricingSource;
}

/** Rich payload returned by `/usage/tokens/summary`. */
export interface UsageOverviewReportContract {
    summary: UsageSummaryContract;
    daily: DailyUsageResultContract[];
    byPr: UsageByPrResultContract[];
    byArea?: UsageByAreaResultContract[];
}

export interface UsageSummaryContract {
    totals: BaseUsageContract;
    totalCost: CostBreakdown;
    byModel: EnrichedModelUsage[];
}

export type TokenPrice = {
    default: number;
    /** Sorted ascending by threshold; bracket k above tiers[k-1] uses its rate. */
    tiers?: Array<{ threshold: number; rate: number }>;
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
