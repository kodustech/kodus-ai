import { Injectable } from '@nestjs/common';

import {
    ManualPricingOverrides,
    ModelTokenRates,
    ResolvedModelPricing,
} from '@libs/analytics/domain/token-usage/types/pricing.types';

import { ModelPricingInfo, TokenPricingUseCase } from './token-pricing.use-case';

/**
 * Resolves the current price for a model with a fixed precedence:
 *
 *   1. manual override (org-entered on the BYOK config) — flat, no tiers
 *   2. LiteLLM catalog (current rates, may be tiered)
 *   3. unpriceable — `source: 'none'`, `priced: false`
 *
 * Pricing is always resolved live (never snapshotted), so an override edit or
 * a catalog change re-bases spend immediately. This is the single place
 * override-vs-catalog precedence is decided, shared by the cost calculator
 * (live spend) and the config surface (display + priceability).
 */
@Injectable()
export class PricingResolver {
    constructor(private readonly tokenPricingUseCase: TokenPricingUseCase) {}

    async resolve(
        model: string,
        overrides?: ManualPricingOverrides,
    ): Promise<ResolvedModelPricing> {
        const key = model?.trim() ?? '';
        const manual = overrides?.[key];
        if (manual) {
            return {
                model: key,
                source: 'manual',
                priced: true,
                rates: {
                    input: { default: manual.input },
                    output: { default: manual.output },
                    cacheRead: { default: manual.cacheRead },
                    cacheWrite: { default: manual.cacheWrite },
                },
            };
        }

        const info = await this.tokenPricingUseCase.execute(key);
        const rates = this.toRates(info);
        // The catalog returns an all-zero entry for an unknown model. A real
        // model always charges for input or output, so all-zero ⇒ not found.
        const priced = rates.input.default > 0 || rates.output.default > 0;

        return {
            model: key,
            source: priced ? 'catalog' : 'none',
            priced,
            rates,
        };
    }

    /**
     * Canonical model name → its sorted input-tier thresholds (delegates to
     * the cached catalog). Source of truth for the Token Usage read's
     * per-request tier bucketing — no DB scan, no baked tier.
     */
    tieredInputThresholds(): Promise<Map<string, number[]>> {
        return this.tokenPricingUseCase.tieredInputThresholds();
    }

    /** Resolve a set of models (de-duplicated, blanks dropped). */
    async resolveMany(
        models: string[],
        overrides?: ManualPricingOverrides,
    ): Promise<ResolvedModelPricing[]> {
        const unique = [
            ...new Set(models.map((m) => m?.trim()).filter(Boolean)),
        ];
        return Promise.all(unique.map((m) => this.resolve(m, overrides)));
    }

    private toRates(info: ModelPricingInfo): ModelTokenRates {
        const { input, output, cacheRead, cacheWrite } = info.pricing;
        return { input, output, cacheRead, cacheWrite };
    }
}
