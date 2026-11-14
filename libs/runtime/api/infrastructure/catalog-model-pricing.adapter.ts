import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';

import { PricingResolver } from '@libs/analytics/application/use-cases/usage/pricing-resolver';

import type { RuntimeModelPricing } from '../domain/ports';

/**
 * The product's price list (PricingResolver: the LiteLLM and models.dev
 * catalog, the same rates Token Usage uses) behind the Runtime's port. It is
 * looked up in the app at call time instead of importing AnalyticsModule: the
 * product worker loads this module too and has no pricing there, and a Run's
 * cost is then simply unpriced. The base tier only: a prompt above a tier
 * threshold (Gemini, Claude over 200K) is priced low.
 */
@Injectable()
export class CatalogRuntimeModelPricing implements RuntimeModelPricing {
    constructor(private readonly moduleRef: ModuleRef) {}

    async usdPerToken(model: string) {
        let resolver: PricingResolver | undefined;
        try {
            resolver = this.moduleRef.get(PricingResolver, { strict: false });
        } catch {
            return null;
        }
        const resolved = await resolver.resolve(model);
        if (!resolved.priced) return null;
        const r = resolved.rates;
        return { input: r.input.default, output: r.output.default, cacheRead: r.cacheRead.default, cacheWrite: r.cacheWrite.default };
    }
}
