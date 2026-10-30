import { ManualPricingOverrides } from '../token-usage/types/pricing.types';
import { TokenUsageBreakdown } from '../token-usage/types/tokenUsage.types';

/**
 * Alert thresholds, as a percentage of the configured monthly limit. Each one
 * fires its notification at most once per period; see the spend-limit cron.
 * Kept here (not in the cron) because it's the shared contract between the
 * alert path and a future blocking gate.
 */
export const SPEND_LIMIT_THRESHOLDS = [50, 75, 90, 100] as const;

export type SpendLimitThreshold = (typeof SPEND_LIMIT_THRESHOLDS)[number];

/** Spend attributed to a single BYOK model over a period, in US$. */
export interface ModelSpend {
    model: string;
    spentUsd: number;
}

/**
 * Spend attributed to a single BYOK credential over a period, in US$.
 *
 * Derived IN-APP by mapping each priced model-name back to its
 * `credentialId` via the config (`BYOKModelConfig`) — the usage store has
 * no credentialId dimension. Spend whose model-name matches no configured
 * model lands in the `unattributed` pseudo-credential (see
 * `UNATTRIBUTED_CREDENTIAL`) rather than being dropped.
 */
export interface CredentialSpend {
    /** A v2 `credentialId`, or `UNATTRIBUTED_CREDENTIAL` for unmatched spend. */
    credentialId: string;
    spentUsd: number;
}

/**
 * Bucket for spend whose model-name resolves to no configured v2 model
 * (e.g. a model that was removed from the config after it produced usage).
 */
export const UNATTRIBUTED_CREDENTIAL = 'unattributed';

/**
 * "At this pace" extrapolation of month-to-date spend to a full month. A
 * readout only — it never gates anything (budget stays alert-only).
 */
export interface RunRateProjection {
    /** spentUsd / elapsedFraction, i.e. the full-month spend at the current
     *  pace. 0 while no month time has elapsed. */
    projectedMonthlyUsd: number;
    /** Fraction of the calendar month elapsed at `now` (0..1); 0 at the first
     *  instant of the month. */
    elapsedFraction: number;
}

/** Month-to-date BYOK spend for an organization, priced at current rates. */
export interface MonthlySpendResult {
    organizationId: string;
    /** Calendar month the spend covers — YYYY-MM in UTC. */
    periodKey: string;
    /** Total scope: month-to-date spend across every model, in US$. */
    spentUsd: number;
    tokenUsage: TokenUsageBreakdown;
    /** Per-model scope (free — the usage store bakes `tu.model`). */
    byModel: ModelSpend[];
    /** Per-credential scope (in-app derived from the config; approximate
     *  on model-name collisions across credentials — see CredentialSpend). */
    byCredential: CredentialSpend[];
    /** Run-rate projection of the total to a full month. */
    runRate: RunRateProjection;
}

/**
 * The seam consumed by both the notification cron (which reads
 * `crossedThresholds` + `periodKey`) and, later, a blocking pipeline gate
 * (which would read `isOverLimit`). Computing this is decoupled from acting
 * on it so the future gate is a drop-in.
 */
export interface SpendLimitStatus {
    spentUsd: number;
    limitUsd: number;
    /** spentUsd / limitUsd as a percentage. 0 when no positive limit is set. */
    pct: number;
    /** True once spend reaches or exceeds the limit (pct >= 100). */
    isOverLimit: boolean;
    /** Thresholds that `pct` has reached, ascending. */
    crossedThresholds: number[];
}

export interface SpendLimitEvaluation extends SpendLimitStatus {
    organizationId: string;
    periodKey: string;
    /** Per-model scope readout. */
    byModel: ModelSpend[];
    /** Per-credential scope readout (in-app derived; approximate on collision). */
    byCredential: CredentialSpend[];
    /** Run-rate projection of the total to a full month. */
    runRate: RunRateProjection;
}

/**
 * Persisted spend-limit configuration for an organization, stored as the
 * `SPEND_LIMIT_CONFIG` org parameter. The config *page* lives on the BYOK
 * screen, but the data lives here (not in the shared BYOK config) so the whole
 * feature stays self-contained.
 */
/**
 * Which spend breakdown the "Budget & alerts" readout highlights. This is a
 * READOUT selector ONLY — NO scope introduces blocking behavior. The budget
 * stays alert-only whatever the scope; the per-model/per-credential figures are
 * always computed and surfaced regardless, this just names the org's chosen
 * focus. Absent ⇒ `total` (the historical, unchanged default).
 */
export type SpendLimitScope = 'total' | 'per-model' | 'per-credential';

export interface SpendLimitConfig {
    enabled: boolean;
    monthlyLimitUsd: number;
    /** Preferred budget readout scope (readout only — never blocks). Defaults
     *  to `total` when absent. */
    scope?: SpendLimitScope;
    /** Org-entered per-model price overrides (per-token US$). */
    modelPricing?: ManualPricingOverrides;
    /**
     * Thresholds already alerted this period, keyed by periodKey (YYYY-MM).
     * Drives the cron's once-per-threshold idempotency; a new month is a new
     * key, so state resets for free.
     */
    thresholdsSent?: Record<string, number[]>;
    /** "Over limit — won't notify again" final notice sent, keyed by periodKey. */
    finalNoticeSent?: Record<string, boolean>;
}

/** Result of checking whether every configured model can be priced. */
export interface PriceabilityResult {
    priceable: boolean;
    unpriceable: string[];
}
