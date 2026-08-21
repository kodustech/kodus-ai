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

/**
 * Which spend breakdown the "Budget & alerts" readout highlights. READOUT
 * selector ONLY — no scope introduces blocking behavior (budget stays
 * alert-only whatever the scope). Mirrors the backend `SpendLimitScope`.
 */
export type SpendLimitScope = "total" | "per-model" | "per-credential";

/**
 * Bucket for spend whose model-name resolves to no configured v2 model (a
 * model removed/renamed after it produced usage). Mirrors the backend const.
 */
export const UNATTRIBUTED_CREDENTIAL = "unattributed";

/** Spend attributed to a single BYOK model over a period, in US$. */
export interface ModelSpend {
    model: string;
    spentUsd: number;
}

/**
 * Spend attributed to a single BYOK credential over a period, in US$.
 * `credentialId` is a v2 credentialId, or `UNATTRIBUTED_CREDENTIAL` for
 * spend the backend couldn't match to a specific credential.
 */
export interface CredentialSpend {
    credentialId: string;
    spentUsd: number;
}

/**
 * "At this pace" extrapolation of month-to-date spend to a full month. A
 * readout only — it never gates anything (budget stays alert-only).
 */
export interface RunRateProjection {
    projectedMonthlyUsd: number;
    elapsedFraction: number;
}

export interface SpendLimitConfigView {
    enabled: boolean;
    monthlyLimitUsd: number;
    modelPricing: ManualPricingOverrides;
    models: ResolvedModelPricing[];
    priceable: boolean;
    /** Persisted budget readout scope. Defaults to `total` when absent. */
    scope?: SpendLimitScope;
}

/**
 * Month-to-date BYOK spend evaluated against the configured limit — the
 * `GET /spend-limit/status` shape (backend `SpendLimitEvaluation`), carrying
 * the per-model / per-credential scope readouts and the run-rate projection.
 */
export interface SpendLimitStatus {
    organizationId: string;
    periodKey: string;
    spentUsd: number;
    limitUsd: number;
    pct: number;
    isOverLimit: boolean;
    crossedThresholds: number[];
    /** Per-model scope readout. */
    byModel: ModelSpend[];
    /** Per-credential scope readout (in-app derived; approximate on collision). */
    byCredential: CredentialSpend[];
    /** Run-rate projection of the total to a full month. */
    runRate: RunRateProjection;
}

export interface UpdateSpendLimitPayload {
    enabled: boolean;
    monthlyLimitUsd: number;
    modelPricing?: ManualPricingOverrides;
    /** Readout scope — persisted, never a block. */
    scope?: SpendLimitScope;
    teamId?: string;
}
