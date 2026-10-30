/**
 * Per-token rate with optional context tiers. `tiers` is sorted ascending by
 * `threshold`: a call whose input exceeds `tiers[k].threshold` (and no higher
 * one) is billed entirely at `tiers[k].rate`; a call at or below the first
 * threshold uses `default`. This is per-request-total tiering (how Gemini,
 * Doubao, … bill), NOT graduated. Most models have one tier (Gemini Pro's
 * 200K); a few have several (Doubao's 32K + 128K). Prices are per-token (NOT
 * per million) to match the cost math, which multiplies raw counts by these.
 */
export interface TokenRate {
    default: number;
    tiers?: Array<{ threshold: number; rate: number }>;
}

export interface ModelTokenRates {
    input: TokenRate;
    output: TokenRate;
    cacheRead: TokenRate;
    cacheWrite: TokenRate;
}

/**
 * Org-entered pricing for a model the catalog can't price (or that the org
 * wants to correct). Flat per-token US$, one rate per token type — no tiers.
 * The config UI collects "$ / 1M tokens" and divides by 1e6 before storing.
 */
export interface ManualModelPricing {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
}

/** Map of model name → org-entered pricing. Keys match the configured model id. */
export type ManualPricingOverrides = Record<string, ManualModelPricing>;

export type PricingSource = 'manual' | 'catalog' | 'none';

/**
 * Resolved pricing for one model. `source: 'none'` (priced=false) means we
 * could neither find a catalog price nor an override — the model is
 * unpriceable, which surfaces as a warning and blocks enabling a limit.
 */
export interface ResolvedModelPricing {
    model: string;
    source: PricingSource;
    priced: boolean;
    rates: ModelTokenRates;
    /**
     * The catalog's rates for this model, independent of any active manual
     * override — present only when the catalog can price it. Lets the config
     * UI offer "revert to catalog" and show the catalog values. Populated by
     * GetSpendLimitConfigUseCase, not the resolver.
     */
    catalogRates?: ModelTokenRates;
}
