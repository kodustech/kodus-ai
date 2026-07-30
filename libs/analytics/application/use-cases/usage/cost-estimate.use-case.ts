import { Inject, Injectable } from '@nestjs/common';

import {
    TOKEN_USAGE_SERVICE_TOKEN,
    ITokenUsageService,
} from '@libs/analytics/domain/token-usage/contracts/tokenUsage.service.contract';
import { CostEstimateContract } from '@libs/analytics/domain/token-usage/types/tokenUsage.types';
import {
    IPullRequestsService,
    PULL_REQUESTS_SERVICE_TOKEN,
} from '@libs/platformData/domain/pullRequests/contracts/pullRequests.service.contracts';

import { ModelCostCalculator } from './model-cost-calculator';
import { ModelPricingInfo } from './token-pricing.use-case';

const PERIOD_DAYS = 14;
const PROJECTION_DAYS = 30;

type UsageRow = {
    input: number;
    output: number;
    outputReasoning: number;
    cacheRead?: number;
    cacheWrite?: number;
    model?: string;
};

@Injectable()
export class CostEstimateUseCase {
    constructor(
        @Inject(TOKEN_USAGE_SERVICE_TOKEN)
        private readonly tokenUsageService: ITokenUsageService,

        @Inject(PULL_REQUESTS_SERVICE_TOKEN)
        private readonly pullRequestsService: IPullRequestsService,

        private readonly modelCostCalculator: ModelCostCalculator,
    ) {}

    async execute(organizationId: string): Promise<CostEstimateContract> {
        const { start, end } = this.getDateRange();

        const usageByPr = await this.tokenUsageService.getUsageByPr({
            organizationId,
            start,
            end,
            byok: false,
        });

        const totals = this.aggregateTokenUsage(usageByPr);

        const uniqueDevelopers = await this.countUniqueDevelopers(
            usageByPr.map((u) => u.prNumber),
            organizationId,
        );

        const developerCount = Math.max(uniqueDevelopers, 1);

        const totalCost14Days =
            await this.modelCostCalculator.totalCost(usageByPr);

        const estimatedMonthlyCost =
            totalCost14Days * (PROJECTION_DAYS / PERIOD_DAYS);
        const costPerDeveloper = estimatedMonthlyCost / developerCount;

        return {
            estimatedMonthlyCost: this.roundToTwoDecimals(estimatedMonthlyCost),
            costPerDeveloper: this.roundToTwoDecimals(costPerDeveloper),
            developerCount,
            tokenUsage: totals,
            periodDays: PERIOD_DAYS,
            projectionDays: PROJECTION_DAYS,
        };
    }

    private getDateRange(): { start: Date; end: Date } {
        const now = new Date();

        const end = new Date(
            Date.UTC(
                now.getUTCFullYear(),
                now.getUTCMonth(),
                now.getUTCDate(),
                23,
                59,
                59,
                999,
            ),
        );

        const start = new Date(
            Date.UTC(
                now.getUTCFullYear(),
                now.getUTCMonth(),
                now.getUTCDate() - PERIOD_DAYS,
                0,
                0,
                0,
                0,
            ),
        );

        return { start, end };
    }

    private aggregateTokenUsage(usages: UsageRow[]) {
        const totals = {
            inputTokens: 0,
            outputTokens: 0,
            reasoningTokens: 0,
            totalTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
        };

        for (const usage of usages) {
            totals.inputTokens += usage.input;
            totals.outputTokens += usage.output;
            totals.reasoningTokens += usage.outputReasoning;
            totals.cacheReadTokens += usage.cacheRead ?? 0;
            totals.cacheWriteTokens += usage.cacheWrite ?? 0;
        }

        // outputTokens already includes reasoningTokens for every provider we
        // ship (Gemini API, OpenAI o-series, Anthropic thinking). Keep total
        // as input + output so we don't double-count.
        totals.totalTokens = totals.inputTokens + totals.outputTokens;
        return totals;
    }

    private async countUniqueDevelopers(
        prNumbers: number[],
        organizationId: string,
    ): Promise<number> {
        const uniquePrNumbers = [...new Set(prNumbers)];
        const developers = new Set<string>();

        for (const prNumber of uniquePrNumbers) {
            const pr = await this.pullRequestsService.findOne({
                organizationId,
                number: prNumber,
            });

            if (pr?.user?.username) {
                developers.add(pr.user.username);
            }
        }

        return developers.size;
    }

    private roundToTwoDecimals(value: number): number {
        return Math.round(value * 100) / 100;
    }
}

export { ModelPricingInfo };
