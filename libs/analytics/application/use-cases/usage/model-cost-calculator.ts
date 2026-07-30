import { Injectable } from '@nestjs/common';

import { ModelSpend } from '@libs/analytics/domain/spend-limit/spend-limit.types';
import {
    ManualPricingOverrides,
    ModelTokenRates,
    TokenRate,
} from '@libs/analytics/domain/token-usage/types/pricing.types';
import {
    CostBreakdown,
    TierUsage,
} from '@libs/analytics/domain/token-usage/types/tokenUsage.types';

import { PricingResolver } from './pricing-resolver';

const UNKNOWN_MODEL = '(unknown)';

/**
 * A usage row carrying token counts and (optionally) the model that produced
 * them. When `byTier` is set, the row's totals are already split by bracket:
 * `byTier[0]` = calls at or below the first threshold (billed at `default`),
 * `byTier[k]` = calls above the k-th threshold (billed at the k-th tier rate).
 * The calculator prices each bracket at its own rate. Rows without `byTier`
 * are flat (everything billed at `default`), correct for non-tiered models.
 */
export interface CostUsageRow {
    input: number;
    output: number;
    outputReasoning: number;
    /** Input tokens served from cache. Subset of `input`. */
    cacheRead?: number;
    /** Input tokens that created cache entries on this call (Anthropic). */
    cacheWrite?: number;
    model?: string;
    byTier?: TierUsage[];
}

/** Per-model usage aggregated per bracket (index = bracket). */
type ModelUsageAgg = TierUsage[];

/**
 * Single source of truth for turning token usage into US$. Buckets usage by
 * model and prices each independently (rates vary by ~10x across providers).
 * Pricing comes from the PricingResolver, so manual overrides and catalog
 * rates are applied consistently here, in cost-estimate, and on the config
 * surface — they can never disagree on what a workload costs.
 *
 * Tier handling: each bracket is priced at its own rate — bracket 0 at
 * `default`, bracket k at the model's k-th tier rate. Selection is per-call
 * (the read bucketed each call by its input size), not per aggregate, because
 * the provider applies the tier per request. Supports any number of tiers
 * (Gemini's one 200K breakpoint, Doubao's 32K + 128K).
 */
@Injectable()
export class ModelCostCalculator {
    constructor(private readonly pricingResolver: PricingResolver) {}

    /** Per-model billed cost for the given usage rows. */
    async spendByModel(
        rows: CostUsageRow[],
        overrides?: ManualPricingOverrides,
    ): Promise<ModelSpend[]> {
        const perModel = this.bucketByModel(rows);

        const out: ModelSpend[] = [];
        for (const [model, agg] of perModel) {
            out.push({
                model,
                spentUsd: await this.costForModel(model, agg, overrides),
            });
        }
        return out;
    }

    /** Total billed cost across every model in the given usage rows. */
    async totalCost(
        rows: CostUsageRow[],
        overrides?: ManualPricingOverrides,
    ): Promise<number> {
        const byModel = await this.spendByModel(rows, overrides);
        return byModel.reduce((sum, m) => sum + m.spentUsd, 0);
    }

    private bucketByModel(rows: CostUsageRow[]): Map<string, ModelUsageAgg> {
        const perModel = new Map<string, ModelUsageAgg>();
        for (const row of rows) {
            const key = (row.model && row.model.trim()) || UNKNOWN_MODEL;
            const agg = perModel.get(key) ?? [];
            const buckets = row.byTier ?? [
                // Flat row (model without tier). All of it is bracket 0, which
                // gets the `default` rate — equivalent to the old behavior.
                {
                    input: row.input,
                    output: row.output,
                    total: row.input + row.output,
                    outputReasoning: row.outputReasoning,
                    cacheRead: row.cacheRead ?? 0,
                    cacheWrite: row.cacheWrite ?? 0,
                },
            ];
            buckets.forEach((bucket, i) => {
                agg[i] = agg[i] ?? emptyTier();
                addTier(agg[i], bucket);
            });
            perModel.set(key, agg);
        }
        return perModel;
    }

    private async costForModel(
        model: string,
        agg: ModelUsageAgg,
        overrides?: ManualPricingOverrides,
    ): Promise<number> {
        if (model === UNKNOWN_MODEL) return 0;

        const { rates } = await this.pricingResolver.resolve(model, overrides);

        return agg.reduce(
            (sum, bucket, i) =>
                sum + ModelCostCalculator.bucketCost(bucket, rates, i).total,
            0,
        );
    }

    /**
     * Per-token rate for a given bracket: bracket 0 → `default`, bracket k →
     * the k-th tier rate (falling back to default if the model has fewer
     * tiers than the bracket index, which can't happen for well-formed data).
     */
    private static rateFor(rate: TokenRate, bracket: number): number {
        if (bracket <= 0) return rate.default;
        return rate.tiers?.[bracket - 1]?.rate ?? rate.default;
    }

    /**
     * Cost of a single bracket bucket, broken down per token type. Static so
     * downstream layers that need the per-component costs (e.g. the API
     * summary use-case) can share the exact formula with no risk of drift.
     */
    static bucketCost(
        bucket: TierUsage,
        rates: ModelTokenRates,
        bracket: number,
    ): CostBreakdown {
        const pick = (rate: TokenRate) =>
            ModelCostCalculator.rateFor(rate, bracket);

        const inputRate = pick(rates.input);
        const outputRate = pick(rates.output);
        const cacheReadRate = pick(rates.cacheRead);
        const cacheWriteRate = pick(rates.cacheWrite);

        // Cache reads are a subset of input tokens — subtract them from the
        // billable-at-full-price pool so we don't charge input AND cache for
        // the same tokens.
        const uncachedInput = Math.max(0, bucket.input - bucket.cacheRead);

        const input = uncachedInput * inputRate;
        const output = bucket.output * outputRate;
        const cacheRead = bucket.cacheRead * cacheReadRate;
        const cacheWrite = bucket.cacheWrite * cacheWriteRate;

        return {
            input,
            output,
            cacheRead,
            cacheWrite,
            total: input + output + cacheRead + cacheWrite,
        };
    }
}

function emptyTier(): TierUsage {
    return {
        input: 0,
        output: 0,
        total: 0,
        outputReasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
    };
}

function addTier(target: TierUsage, src: TierUsage): void {
    target.input += src.input;
    target.output += src.output;
    target.total += src.total;
    target.outputReasoning += src.outputReasoning;
    target.cacheRead += src.cacheRead;
    target.cacheWrite += src.cacheWrite;
}
