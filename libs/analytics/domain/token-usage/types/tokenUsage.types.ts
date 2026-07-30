export type TokenUsageQueryContract = {
    organizationId: string;
    start: Date;
    end: Date;
    models?: string;
    prNumber?: number;
    timezone?: string; // for day bucketing
    developer?: string;
    /**
     * Scope to one repository. Usage spans don't carry a repository id, so
     * the service resolves this to the repo's PR numbers (`prNumbers`) and
     * the read matches `attributes.prNumber ∈ prNumbers` — same join the
     * by-developer view already relies on (PR numbers are assumed unique
     * enough within an org; a cross-repo number collision over-includes,
     * matching the existing by-developer behavior).
     */
    repositoryId?: string;
    /** Internal: PR numbers resolved from `repositoryId`. */
    prNumbers?: number[];
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
    /** Input tokens served from provider prompt cache. Subset of `input`. */
    cacheRead?: number;
    /** Input tokens that created cache entries on this call (Anthropic). */
    cacheWrite?: number;
    /**
     * Per-tier breakdown, indexed by bracket: `byTier[0]` = calls at or below
     * the model's first threshold (billed at `default`), `byTier[k]` = calls
     * above the k-th threshold (billed at the k-th tier rate). Length is
     * `thresholds + 1`. Present only for tier-aware models; flat models omit
     * it (all usage on `default`). The UI collapses this to ≤/>threshold.
     */
    byTier?: TierUsage[];
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

/**
 * One review run = one `correlationId` (the ambient observability context id
 * every usage span of a run inherits). A PR reviewed twice yields two rows.
 */
export interface UsageByReviewResultContract extends BaseUsageContract {
    /** The review run's correlation id. */
    review: string;
    prNumber?: number;
    /** Earliest span timestamp of the run — for chronological ordering. */
    startedAt?: string;
}

/**
 * Token spend grouped by process area (`attributes.tu.area` — see
 * TokenUsageArea in libs/core/log/token-usage-tu.ts). Rows written before the
 * area backfill ran surface as 'other'.
 */
export interface UsageByAreaResultContract extends BaseUsageContract {
    area: string;
}

export interface DailyUsageByDeveloperResultContract
    extends UsageByDeveloperResultContract {
    date: string; // YYYY-MM-DD
}

/**
 * USD-denominated cost broken down by token type. `total = input + output +
 * cacheRead + cacheWrite`. Provided alongside token counts so the UI never has
 * to know rates or formulas — it just renders.
 */
export interface CostBreakdown {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
}

/**
 * `'missing'` is the API-facing label for `PricingSource = 'none'` returned by
 * the resolver. Keeping a single enum at the wire boundary makes the
 * frontend's missing-price warning trivial.
 */
export type ApiPricingSource = 'manual' | 'catalog' | 'missing';

/**
 * A per-model usage row enriched with the cost we computed for it, the cost
 * broken down per tier (when the model is tier-aware), and where the price
 * came from. This is the shape the detail table on the Token Usage page
 * consumes for each model row.
 */
export interface EnrichedModelUsage extends BaseUsageContract {
    cost: CostBreakdown;
    /** Cost per bracket, aligned index-for-index with `byTier`. */
    costByTier?: CostBreakdown[];
    pricingSource: ApiPricingSource;
}

/**
 * Rich payload for the `/usage/tokens/summary` endpoint: flat totals across
 * everything (powers the top cards), the total cost split by token type
 * (powers the cost cards), and a per-model breakdown (powers the detail
 * table). One round-trip serves both surfaces.
 */
export interface UsageSummaryReportContract {
    totals: BaseUsageContract;
    totalCost: CostBreakdown;
    byModel: EnrichedModelUsage[];
}

/**
 * Single-request payload for the Token Usage screen: the enriched summary plus
 * the daily and by-PR series — all from one covered $facet aggregation.
 */
export interface UsageOverviewReportContract {
    summary: UsageSummaryReportContract;
    daily: DailyUsageResultContract[];
    byPr: UsageByPrResultContract[];
    /** Token spend per process area — powers the "where tokens go" breakdown. */
    byArea: UsageByAreaResultContract[];
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
