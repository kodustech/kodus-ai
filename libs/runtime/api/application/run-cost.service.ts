import { Inject, Injectable, Optional } from '@nestjs/common';

import { createLogger } from '@libs/core/log/logger';
import type { RuntimeRunProjection } from '@libs/runtime/run';

import {
    type Clock,
    RUNTIME_API_CONFIG,
    RUNTIME_CLAIM_USAGE_READER,
    RUNTIME_CLOCK,
    RUNTIME_LLM_USAGE_STORE,
    RUNTIME_MODEL_PRICING,
    type RuntimeApiConfig,
    type RuntimeClaimUsageReader,
    type RuntimeLlmUsageStore,
    type RuntimeModelPricing,
} from '../domain/ports';
import { estimateRunCost, type ModelTokenPrice, type RunClaimUsage, type RuntimeRunCost } from '../domain/run-cost';

/**
 * The cost of Runs (§13 PR 5) for the Run page and the Run list: one read of
 * the gateway's counters and one of the Runs' claims (per org) for the whole
 * page, one price lookup per model. A price or claim that cannot be read
 * leaves that part null; the Run still loads.
 */
@Injectable()
export class RuntimeRunCostService {
    private readonly logger = createLogger(RuntimeRunCostService.name);

    constructor(
        @Inject(RUNTIME_LLM_USAGE_STORE)
        private readonly usage: RuntimeLlmUsageStore,
        @Inject(RUNTIME_CLOCK)
        private readonly now: Clock,
        @Optional()
        @Inject(RUNTIME_MODEL_PRICING)
        private readonly pricing?: RuntimeModelPricing,
        @Optional()
        @Inject(RUNTIME_CLAIM_USAGE_READER)
        private readonly claims?: RuntimeClaimUsageReader,
        @Optional()
        @Inject(RUNTIME_API_CONFIG)
        private readonly config?: Pick<RuntimeApiConfig, 'cellPrices'>,
    ) {}

    async forRuns(
        runs: Array<Pick<RuntimeRunProjection, 'runId' | 'organizationId' | 'bootingAt' | 'startedAt' | 'finishedAt' | 'cellOwner'>>,
    ): Promise<Map<string, RuntimeRunCost>> {
        const [usage, claims] = await Promise.all([this.usage.usageForRuns(runs.map((r) => r.runId)), this.claimsOf(runs)]);
        const models = new Set<string>();
        for (const u of usage.values()) for (const m of u.byModel) if (m.model) models.add(m.model);
        const prices = new Map<string, ModelTokenPrice>(await Promise.all([...models].map(async (m) => [m, await this.priceOf(m)] as const)));
        const now = this.now();
        const cellPrices = this.config?.cellPrices ?? {};
        const cellPriceOf = (cellId: string) => cellPrices[cellId] ?? null;
        return new Map(
            runs.map((run) => [run.runId, estimateRunCost({ run, usage: usage.get(run.runId), prices, claims: claims.get(run.runId), cellPriceOf, now })]),
        );
    }

    /** The Runs' claim rounds, one read per org on the page; unreadable: none (the machine part says "not priced"). */
    private async claimsOf(runs: Array<Pick<RuntimeRunProjection, 'runId' | 'organizationId'>>): Promise<Map<string, RunClaimUsage[]>> {
        const out = new Map<string, RunClaimUsage[]>();
        if (!this.claims || !runs.length) return out;
        const byOrg = new Map<string, string[]>();
        for (const r of runs) byOrg.set(r.organizationId, [...(byOrg.get(r.organizationId) ?? []), r.runId]);
        try {
            for (const [org, ids] of byOrg) for (const [runId, list] of await this.claims.claimsOfRuns(org, ids)) out.set(runId, list);
        } catch (e) {
            this.logger.warn({
                message: 'Runtime Run cost: the claims could not be read; the machine cost stays unpriced',
                context: RuntimeRunCostService.name,
                error: e instanceof Error ? e : undefined,
            });
            return new Map();
        }
        return out;
    }

    private async priceOf(model: string): Promise<ModelTokenPrice> {
        if (!this.pricing) return null;
        try {
            return await this.pricing.usdPerToken(model);
        } catch (e) {
            this.logger.warn({
                message: 'Runtime Run cost: the model price could not be read; the LLM cost stays unpriced',
                context: RuntimeRunCostService.name,
                error: e instanceof Error ? e : undefined,
                metadata: { model },
            });
            return null;
        }
    }
}
