import { Inject, Injectable } from '@nestjs/common';

import {
    ITokenUsageService,
    TOKEN_USAGE_SERVICE_TOKEN,
} from '@libs/analytics/domain/token-usage/contracts/tokenUsage.service.contract';
import { TokenUsageBreakdown } from '@libs/analytics/domain/token-usage/types/tokenUsage.types';
import { ManualPricingOverrides } from '@libs/analytics/domain/token-usage/types/pricing.types';
import { buildSpendLimitStatus } from '@libs/analytics/domain/spend-limit/spend-limit-status';
import {
    MonthlySpendResult,
    SpendLimitEvaluation,
} from '@libs/analytics/domain/spend-limit/spend-limit.types';

import { CostUsageRow, ModelCostCalculator } from './model-cost-calculator';

/**
 * Month-to-date BYOK spend tracker.
 *
 * Spend is computed live on every call — current usage priced at current
 * catalog rates, never snapshotted. Switching models or a catalog price
 * change therefore re-bases the whole month's figure, which is the intended
 * "always most up to date" behavior for the spend-alert feature.
 *
 * `getStatus` is the seam shared by the alert cron and a future blocking gate
 * (see SpendLimitEvaluation). This service only *computes* — it never sends
 * notifications or blocks.
 */
@Injectable()
export class MonthlySpendUseCase {
    constructor(
        @Inject(TOKEN_USAGE_SERVICE_TOKEN)
        private readonly tokenUsageService: ITokenUsageService,
        private readonly modelCostCalculator: ModelCostCalculator,
    ) {}

    async getMonthToDateSpend(
        organizationId: string,
        now: Date = new Date(),
        overrides?: ManualPricingOverrides,
    ): Promise<MonthlySpendResult> {
        const { start, end, periodKey } = this.getMonthRange(now);

        const rows = await this.tokenUsageService.getDailyUsage({
            organizationId,
            start,
            end,
            byok: true,
        });

        const byModel = await this.modelCostCalculator.spendByModel(
            rows as CostUsageRow[],
            overrides,
        );
        const spentUsd = this.roundToCents(
            byModel.reduce((sum, m) => sum + m.spentUsd, 0),
        );

        return {
            organizationId,
            periodKey,
            spentUsd,
            tokenUsage: this.aggregateTokenUsage(rows),
            byModel,
        };
    }

    /**
     * Evaluate month-to-date spend against a monthly limit. The limit is
     * supplied by the caller (it lives in org config, wired in a later phase)
     * to keep this service free of config concerns.
     */
    async getStatus(
        organizationId: string,
        limitUsd: number,
        now: Date = new Date(),
        overrides?: ManualPricingOverrides,
    ): Promise<SpendLimitEvaluation> {
        const spend = await this.getMonthToDateSpend(
            organizationId,
            now,
            overrides,
        );
        const status = buildSpendLimitStatus(spend.spentUsd, limitUsd);

        return {
            ...status,
            organizationId,
            periodKey: spend.periodKey,
            byModel: spend.byModel,
        };
    }

    /** First instant of the current UTC month through `now` (month-to-date). */
    private getMonthRange(now: Date): {
        start: Date;
        end: Date;
        periodKey: string;
    } {
        const year = now.getUTCFullYear();
        const month = now.getUTCMonth();
        const start = new Date(Date.UTC(year, month, 1, 0, 0, 0, 0));
        const periodKey = `${year}-${String(month + 1).padStart(2, '0')}`;
        return { start, end: now, periodKey };
    }

    private aggregateTokenUsage(rows: CostUsageRow[]): TokenUsageBreakdown {
        const totals: TokenUsageBreakdown = {
            inputTokens: 0,
            outputTokens: 0,
            reasoningTokens: 0,
            totalTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
        };

        for (const row of rows) {
            totals.inputTokens += row.input;
            totals.outputTokens += row.output;
            totals.reasoningTokens += row.outputReasoning;
            totals.cacheReadTokens =
                (totals.cacheReadTokens ?? 0) + (row.cacheRead ?? 0);
            totals.cacheWriteTokens =
                (totals.cacheWriteTokens ?? 0) + (row.cacheWrite ?? 0);
        }

        // outputTokens already includes reasoningTokens for every provider we
        // ship, so total is input + output to avoid double-counting.
        totals.totalTokens = totals.inputTokens + totals.outputTokens;
        return totals;
    }

    private roundToCents(value: number): number {
        return Math.round(value * 100) / 100;
    }
}
