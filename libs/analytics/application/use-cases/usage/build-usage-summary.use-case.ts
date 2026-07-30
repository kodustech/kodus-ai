import { Inject, Injectable } from '@nestjs/common';

import {
    ITokenUsageService,
    TOKEN_USAGE_SERVICE_TOKEN,
} from '@libs/analytics/domain/token-usage/contracts/tokenUsage.service.contract';
import {
    ApiPricingSource,
    BaseUsageContract,
    CostBreakdown,
    EnrichedModelUsage,
    TierUsage,
    TokenUsageQueryContract,
    UsageOverviewReportContract,
    UsageSummaryReportContract,
} from '@libs/analytics/domain/token-usage/types/tokenUsage.types';
import {
    ManualPricingOverrides,
    PricingSource,
} from '@libs/analytics/domain/token-usage/types/pricing.types';

import { CacheService } from '@libs/core/cache/cache.service';

import { ModelCostCalculator } from './model-cost-calculator';
import { PricingResolver } from './pricing-resolver';

// Overview cache TTLs. A window that ends before today is immutable (historical
// spans never change) → cache long. A window that includes today still grows as
// new spans land → cache briefly so the screen stays snappy without going stale.
// Both windows cached 4h. Past windows are immutable; the current window trades
// up-to-4h staleness on today's data for far fewer (expensive) recomputes —
// which also relieves the concurrent-scan load that caused the original OOM.
const OVERVIEW_TTL_PAST_MS = 4 * 60 * 60 * 1000;
const OVERVIEW_TTL_CURRENT_MS = 4 * 60 * 60 * 1000;

const TO_API_SOURCE: Record<PricingSource, ApiPricingSource> = {
    manual: 'manual',
    catalog: 'catalog',
    none: 'missing',
};

/**
 * Builds the enriched payload the Token Usage page renders: flat totals + per
 * token-type cost + per-model rows annotated with cost-per-tier and pricing
 * source. Centralizing the assembly here keeps the controller thin and the
 * cost math in one place.
 */
@Injectable()
export class BuildUsageSummaryUseCase {
    constructor(
        @Inject(TOKEN_USAGE_SERVICE_TOKEN)
        private readonly tokenUsageService: ITokenUsageService,
        private readonly pricingResolver: PricingResolver,
        private readonly cacheService: CacheService,
    ) {}

    async execute(
        query: TokenUsageQueryContract,
        overrides?: ManualPricingOverrides,
    ): Promise<UsageSummaryReportContract> {
        const [totals, byModel] = await Promise.all([
            this.tokenUsageService.getSummary(query),
            this.tokenUsageService.getSummaryByModel(query),
        ]);

        const enrichedRows = (
            await Promise.all(byModel.map((row) => this.enrich(row, overrides)))
        ).sort((a, b) => a.model.localeCompare(b.model));

        const totalCost = enrichedRows.reduce<CostBreakdown>(
            (acc, row) => addCost(acc, row.cost),
            zeroCost(),
        );

        return { totals, totalCost, byModel: enrichedRows };
    }

    /**
     * Single-request overview for the Token Usage screen: one covered $facet
     * aggregation (summary + daily + byPr) enriched with cost. Replaces the
     * page's ~4 separate fetches (summary=2 aggs + daily + by-pr) with one,
     * removing the concurrent scan load that caused the prod OOM.
     */
    async executeOverview(
        query: TokenUsageQueryContract,
        overrides?: ManualPricingOverrides,
    ): Promise<UsageOverviewReportContract> {
        // Past windows are immutable → serve repeat loads from cache instantly
        // instead of re-scanning ~1M+ index keys every time. The overrides
        // signature is in the key so manual pricing edits don't serve stale cost.
        const cacheKey = this.overviewCacheKey(query, overrides);
        const cached =
            await this.cacheService.getFromCache<UsageOverviewReportContract>(
                cacheKey,
            );
        if (cached) return cached;

        const report = await this.buildOverview(query, overrides);

        const ttl =
            query.end.getTime() < startOfTodayUtc()
                ? OVERVIEW_TTL_PAST_MS
                : OVERVIEW_TTL_CURRENT_MS;
        await this.cacheService.addToCache(cacheKey, report, ttl);
        return report;
    }

    private overviewCacheKey(
        query: TokenUsageQueryContract,
        overrides?: ManualPricingOverrides,
    ): string {
        return [
            // v2: payload gained the byArea facet (issue #1453).
            'usage:overview:v2',
            query.organizationId,
            query.byok ? 'byok' : 'sys',
            query.start.getTime(),
            query.end.getTime(),
            query.timezone || 'UTC',
            query.models || '',
            query.prNumber ?? '',
            query.repositoryId ?? '',
            JSON.stringify(overrides ?? {}),
        ].join('|');
    }

    private async buildOverview(
        query: TokenUsageQueryContract,
        overrides?: ManualPricingOverrides,
    ): Promise<UsageOverviewReportContract> {
        const overview = await this.tokenUsageService.getUsageOverview(query);

        const enrichedRows = (
            await Promise.all(
                overview.byModel.map((row) => this.enrich(row, overrides)),
            )
        ).sort((a, b) => a.model.localeCompare(b.model));
        const totalCost = enrichedRows.reduce<CostBreakdown>(
            (acc, row) => addCost(acc, row.cost),
            zeroCost(),
        );

        return {
            summary: {
                totals: overview.summary,
                totalCost,
                byModel: enrichedRows,
            },
            daily: overview.daily,
            byPr: overview.byPr,
            byArea: overview.byArea,
        };
    }

    private async enrich(
        row: BaseUsageContract,
        overrides?: ManualPricingOverrides,
    ): Promise<EnrichedModelUsage> {
        const resolved = await this.pricingResolver.resolve(row.model, overrides);
        const pricingSource = TO_API_SOURCE[resolved.source];

        if (row.byTier) {
            // Price each bracket at its own rate (bracket i → i-th tier).
            const costByTier = row.byTier.map((bucket, i) =>
                ModelCostCalculator.bucketCost(bucket, resolved.rates, i),
            );
            return {
                ...row,
                cost: costByTier.reduce(addCost, zeroCost()),
                costByTier,
                pricingSource,
            };
        }

        // Flat row — a single bracket-0 bucket at the default rate.
        const flatBucket: TierUsage = {
            input: row.input,
            output: row.output,
            total: row.total,
            outputReasoning: row.outputReasoning,
            cacheRead: row.cacheRead ?? 0,
            cacheWrite: row.cacheWrite ?? 0,
        };
        return {
            ...row,
            cost: ModelCostCalculator.bucketCost(flatBucket, resolved.rates, 0),
            pricingSource,
        };
    }
}

/** Epoch ms for 00:00 UTC today — the cutoff for "immutable past window". */
function startOfTodayUtc(): number {
    const now = new Date();
    return Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate(),
    );
}

function zeroCost(): CostBreakdown {
    return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
}

function addCost(a: CostBreakdown, b: CostBreakdown): CostBreakdown {
    return {
        input: a.input + b.input,
        output: a.output + b.output,
        cacheRead: a.cacheRead + b.cacheRead,
        cacheWrite: a.cacheWrite + b.cacheWrite,
        total: a.total + b.total,
    };
}
