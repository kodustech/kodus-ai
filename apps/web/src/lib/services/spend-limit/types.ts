export type PricingSource = "manual" | "catalog" | "none";

export interface TokenRate {
    default: number;
    tier?: { threshold: number; rate: number };
}

export interface ModelTokenRates {
    input: TokenRate;
    output: TokenRate;
    cacheRead: TokenRate;
    cacheWrite: TokenRate;
}

export interface ResolvedModelPricing {
    model: string;
    source: PricingSource;
    priced: boolean;
    rates: ModelTokenRates;
    /** Catalog rates, present only when the catalog can price the model.
     *  Used to revert a manual override back to catalog pricing. */
    catalogRates?: ModelTokenRates;
}

/** Per-token US$ rates entered manually for a model. */
export interface ManualModelPricing {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
}

export type ManualPricingOverrides = Record<string, ManualModelPricing>;

export interface SpendLimitConfigView {
    enabled: boolean;
    monthlyLimitUsd: number;
    modelPricing: ManualPricingOverrides;
    models: ResolvedModelPricing[];
    priceable: boolean;
}

/** Month-to-date BYOK spend evaluated against the configured limit. */
export interface SpendLimitStatus {
    organizationId: string;
    periodKey: string;
    spentUsd: number;
    limitUsd: number;
    pct: number;
    isOverLimit: boolean;
    crossedThresholds: number[];
}

export interface UpdateSpendLimitPayload {
    enabled: boolean;
    monthlyLimitUsd: number;
    modelPricing?: ManualPricingOverrides;
    teamId?: string;
}
