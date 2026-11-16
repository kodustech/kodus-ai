import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';

import { createLogger } from '@libs/core/log/logger';
import { SpendLimitConfigService } from '@libs/analytics/application/spend-limit/spend-limit-config.service';
import { ModelCostCalculator } from '@libs/analytics/application/use-cases/usage/model-cost-calculator';
import { PricingResolver } from '@libs/analytics/application/use-cases/usage/pricing-resolver';
import { TOKEN_USAGE_REPOSITORY_TOKEN } from '@libs/analytics/domain/token-usage/contracts/tokenUsage.repository.contract';
import type { ManualPricingOverrides, ResolvedModelPricing } from '@libs/analytics/domain/token-usage/types/pricing.types';
import type { RuntimeUsageRowContract } from '@libs/analytics/domain/token-usage/types/tokenUsage.types';
import type { TokenUsageRepository } from '@libs/analytics/infrastructure/adapters/repositories/tokenUsage.repository';

import { runtimeLlmAgentOf, type RuntimeLlmSpendRow } from '../domain/llm-spend';
import type { RuntimeLlmSpendReader } from '../domain/ports';

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

/**
 * The US$ of one Runtime bucket, the way Token Usage prices it
 * (BuildUsageSummaryUseCase.enrich): each tier bracket at its own rate, cache
 * reads and writes at theirs. Null for a model the price list cannot price.
 */
export function priceRuntimeUsageRow(row: RuntimeUsageRowContract, pricing: ResolvedModelPricing | null): { usd: number | null; aboveBaseTierTokens: number } {
    const aboveBaseTierTokens = (row.byTier ?? []).slice(1).reduce((n, b) => n + b.total, 0);
    if (!pricing?.priced || !row.model) return { usd: row.total > 0 ? null : 0, aboveBaseTierTokens };
    const buckets = row.byTier ?? [
        { input: row.input, output: row.output, total: row.total, outputReasoning: row.outputReasoning, cacheRead: row.cacheRead ?? 0, cacheWrite: row.cacheWrite ?? 0 },
    ];
    const usd = buckets.reduce((sum, bucket, i) => sum + ModelCostCalculator.bucketCost(bucket, pricing.rates, i).total, 0);
    return { usd: round6(usd), aboveBaseTierTokens };
}

/** One priced Token Usage bucket as the Runtime reads it. */
export function toRuntimeLlmSpendRow(row: RuntimeUsageRowContract, pricing: ResolvedModelPricing | null): RuntimeLlmSpendRow {
    const { usd, aboveBaseTierTokens } = priceRuntimeUsageRow(row, pricing);
    return {
        runId: row.runId ?? null,
        agent: runtimeLlmAgentOf(row),
        repositoryId: row.repositoryId ?? null,
        environmentId: row.environmentId ?? null,
        model: row.model ?? '',
        paidBy: row.isByok ? 'customer' : 'kodus',
        inputTokens: row.input,
        outputTokens: row.output,
        cacheReadTokens: row.cacheRead ?? 0,
        cacheWriteTokens: row.cacheWrite ?? 0,
        totalTokens: row.total,
        aboveBaseTierTokens,
        usd,
    };
}

/**
 * The Runtime's LLM spend from observability_telemetry through the Token
 * Usage read (TokenUsageRepository.getRuntimeUsage) and its price list
 * (PricingResolver, with the org's manual overrides). Looked up in the app at
 * call time instead of importing AnalyticsModule: the product worker loads
 * this module too and has neither, and the LLM part is then "not measured".
 */
@Injectable()
export class TelemetryRuntimeLlmSpendReader implements RuntimeLlmSpendReader {
    private readonly logger = createLogger(TelemetryRuntimeLlmSpendReader.name);

    constructor(private readonly moduleRef: ModuleRef) {}

    private find<T>(token: unknown): T | undefined {
        try {
            return this.moduleRef.get(token as never, { strict: false }) as T;
        } catch {
            // ModuleRef throws for a provider this app does not load: the caller then answers "not measured".
            return undefined;
        }
    }

    async spendOf(query: { organizationId: string; start: Date; end: Date; runIds?: string[] }): Promise<RuntimeLlmSpendRow[] | undefined> {
        const repository = this.find<Partial<Pick<TokenUsageRepository, 'getRuntimeUsage'>>>(TOKEN_USAGE_REPOSITORY_TOKEN);
        const resolver = this.find<PricingResolver>(PricingResolver);
        if (!repository?.getRuntimeUsage || !resolver) return undefined;
        if (query.runIds && !query.runIds.length) return [];
        const [rows, overrides] = await Promise.all([repository.getRuntimeUsage(query), this.overridesOf(query.organizationId)]);
        const prices = new Map<string, Promise<ResolvedModelPricing | null>>();
        const priceOf = (model: string) => {
            if (!model) return Promise.resolve(null);
            if (!prices.has(model))
                prices.set(
                    model,
                    resolver.resolve(model, overrides).catch((error: unknown) => {
                        // An unreadable price leaves the row unpriced (usd null), never US$ 0.
                        this.logger.warn({
                            message: 'Runtime LLM spend: model price unreadable, the row stays unpriced',
                            context: TelemetryRuntimeLlmSpendReader.name,
                            error: error instanceof Error ? error : undefined,
                            metadata: { organizationId: query.organizationId, model },
                        });
                        return null;
                    }),
                );
            return prices.get(model)!;
        };
        return Promise.all(rows.map(async (row) => toRuntimeLlmSpendRow(row, await priceOf(row.model))));
    }

    /** The org's manual prices, as Token Usage applies them; none when they cannot be read. */
    private async overridesOf(organizationId: string): Promise<ManualPricingOverrides | undefined> {
        const config = this.find<SpendLimitConfigService>(SpendLimitConfigService);
        if (!config) return undefined;
        const c = await config.getConfig({ organizationId, teamId: '' } as never).catch((error: unknown) => {
            this.logger.warn({
                message: "Runtime LLM spend: the org's manual prices are unreadable, list prices apply",
                context: TelemetryRuntimeLlmSpendReader.name,
                error: error instanceof Error ? error : undefined,
                metadata: { organizationId },
            });
            return null;
        });
        return c?.modelPricing ?? undefined;
    }
}
