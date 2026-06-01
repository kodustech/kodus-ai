import { Card, CardContent } from "@components/ui/card";
import {
    getDailyTokenUsage,
    getTokenUsageByDeveloper,
    getTokenUsageByPR,
} from "@services/usage/fetch";
import type { ModelPricingInfo } from "@services/usage/types";
import { differenceInDays, format, subDays } from "date-fns";
import { TrendingUpIcon } from "lucide-react";
import { isBYOKSubscriptionPlan } from "src/features/ee/byok/_utils";

import {
    fetchModelPricingFromModelsDev,
    type SimulatorModel,
} from "../_services/models";
import { validateOrganizationLicense } from "../../_services/billing/fetch";
import {
    TokenProjectionBanner,
    TokenProjectionEmptyState,
} from "./token-projection.client";

const TRIAL_DURATION_DAYS = 14;
const USAGE_LOOKBACK_DAYS = 30;
const MIN_PRS_FOR_PROJECTION = 5;

function getUsageDateRange(
    license: Awaited<ReturnType<typeof validateOrganizationLicense>> | null,
) {
    const now = new Date();

    if (license?.valid && license.subscriptionStatus === "trial") {
        const trialEndDate = new Date(license.trialEnd);
        const trialStartDate = subDays(trialEndDate, TRIAL_DURATION_DAYS);
        const daysUsed = Math.max(1, differenceInDays(now, trialStartDate));

        return {
            startDate: format(trialStartDate, "yyyy-MM-dd"),
            endDate: format(now, "yyyy-MM-dd"),
            daysUsed,
        };
    }

    const startDate = subDays(now, USAGE_LOOKBACK_DAYS);
    return {
        startDate: format(startDate, "yyyy-MM-dd"),
        endDate: format(now, "yyyy-MM-dd"),
        daysUsed: USAGE_LOOKBACK_DAYS,
    };
}

async function computeTokenProjection(
    license: Awaited<ReturnType<typeof validateOrganizationLicense>> | null,
) {
    const { startDate, endDate, daysUsed } = getUsageDateRange(license);
    const isBYOK = license ? isBYOKSubscriptionPlan(license) : false;

    const usageFilters = { startDate, endDate, byok: isBYOK };

    try {
        const [dailyUsage, usageByPR, usageByDev] = await Promise.all([
            getDailyTokenUsage(usageFilters),
            getTokenUsageByPR(usageFilters).catch(() => null),
            getTokenUsageByDeveloper(usageFilters).catch(() => null),
        ]);

        if (!dailyUsage || dailyUsage.length === 0) {
            return {
                projection: null,
                daysUsed,
                progress: { current: 0, required: MIN_PRS_FOR_PROJECTION },
            };
        }

        // Aggregate totals across all days
        let totalInput = 0;
        let totalOutput = 0;
        let totalReasoning = 0;

        const uniqueModels = new Set<string>();
        const uniqueDays = new Set<string>();

        for (const day of dailyUsage) {
            totalInput += day.input ?? 0;
            totalOutput += day.output ?? 0;
            totalReasoning += day.outputReasoning ?? 0;
            if (day.model) uniqueModels.add(day.model);
            if (day.date) uniqueDays.add(day.date);
        }

        if (totalInput + totalOutput + totalReasoning === 0) {
            return {
                projection: null,
                daysUsed,
                progress: { current: 0, required: MIN_PRS_FOR_PROJECTION },
            };
        }

        // Use actual days with usage instead of calendar days
        const actualDaysUsed = Math.max(1, uniqueDays.size);

        // Count unique PRs and developers
        const uniquePRs = usageByPR
            ? new Set(usageByPR.map((r) => r.prNumber)).size
            : 0;
        const uniqueDevelopers = usageByDev
            ? new Set(usageByDev.map((r) => r.developer)).size
            : 0;

        // Fetch pricing for all models using cached models.dev data (single fetch, not N calls)
        const pricingMap: Record<string, ModelPricingInfo> = {};

        // This uses cached data from models.dev - only 1 network request total
        for (const model of uniqueModels) {
            const pricing = await fetchModelPricingFromModelsDev(model);
            if (pricing) {
                pricingMap[model] = {
                    id: model,
                    pricing: {
                        input: { default: pricing.prompt },
                        output: { default: pricing.completion },
                        cacheRead: { default: 0 },
                        cacheWrite: { default: 0 },
                        prompt: pricing.prompt,
                        completion: pricing.completion,
                        // Reasoning is already inside outputTokens for our
                        // providers; same rate as completion keeps the split
                        // below neutral.
                        internal_reasoning: pricing.completion,
                    },
                };
            }
        }

        const pricingEntries = Object.values(pricingMap);

        if (pricingEntries.length === 0) {
            return {
                projection: null,
                daysUsed,
                progress: {
                    current: uniquePRs,
                    required: MIN_PRS_FOR_PROJECTION,
                },
            };
        }

        // Project monthly usage based on actual days with usage
        const monthlyInput = (totalInput / actualDaysUsed) * 30;
        const monthlyOutput = (totalOutput / actualDaysUsed) * 30;
        const monthlyReasoning = (totalReasoning / actualDaysUsed) * 30;

        function computeCost(p: ModelPricingInfo) {
            const prompt = p.pricing.prompt ?? 0;
            const completion = p.pricing.completion ?? 0;
            const reasoning = p.pricing.internal_reasoning ?? 0;

            const nonReasoningOutput = monthlyOutput - monthlyReasoning;

            return (
                monthlyInput * prompt +
                nonReasoningOutput * completion +
                monthlyReasoning * reasoning
            );
        }

        // Compute cost for each model's pricing → range from cheapest to most expensive
        const modelCosts = Object.entries(pricingMap).map(
            ([model, pricing]) => ({
                model,
                cost: computeCost(pricing),
            }),
        );

        modelCosts.sort((a, b) => a.cost - b.cost);

        const cheapest = modelCosts[0];
        const mostExpensive = modelCosts[modelCosts.length - 1];

        if (mostExpensive.cost === 0) {
            return {
                projection: null,
                daysUsed,
                progress: {
                    current: uniquePRs,
                    required: MIN_PRS_FOR_PROJECTION,
                },
            };
        }

        // Check if we have enough PRs for a meaningful projection
        if (uniquePRs < MIN_PRS_FOR_PROJECTION) {
            return {
                projection: null,
                daysUsed,
                progress: {
                    current: uniquePRs,
                    required: MIN_PRS_FOR_PROJECTION,
                },
            };
        }

        // Project PRs to monthly (same logic as tokens)
        const monthlyPRs = Math.round((uniquePRs / actualDaysUsed) * 30);

        return {
            projection: {
                minCost: cheapest.cost,
                maxCost: mostExpensive.cost,
                minModel: cheapest.model,
                maxModel: mostExpensive.model,
                currency: "USD",
                uniquePRs,
                uniqueDevelopers,
                monthlyPRs,
                actualDaysUsed,
                monthlyInputTokens: monthlyInput,
                monthlyOutputTokens: monthlyOutput,
            },
            daysUsed,
            progress: null,
        };
    } catch (error) {
        console.error("Failed to compute token projection:", error);
        return {
            projection: null,
            daysUsed,
            progress: { current: 0, required: MIN_PRS_FOR_PROJECTION },
        };
    }
}

/**
 * Server component that fetches token usage data (slow)
 * and renders the appropriate projection UI
 */
export async function TokenProjectionSection({
    license,
    simulatorModels,
}: {
    license: Awaited<ReturnType<typeof validateOrganizationLicense>> | null;
    simulatorModels: SimulatorModel[];
}) {
    const { projection, progress } = await computeTokenProjection(license);

    if (projection && projection.maxCost >= 1) {
        return (
            <TokenProjectionBanner
                projection={projection}
                simulatorModels={simulatorModels}
            />
        );
    }

    return <TokenProjectionEmptyState progress={progress} />;
}

/**
 * Skeleton shown while token projection is loading
 */
export function TokenProjectionSkeleton() {
    return (
        <Card className="overflow-hidden">
            <CardContent className="p-0">
                <div className="flex items-center gap-4 px-5 py-4">
                    <div className="bg-primary-dark flex size-9 shrink-0 animate-pulse items-center justify-center rounded-full">
                        <TrendingUpIcon className="text-primary-light size-4" />
                    </div>
                    <div className="min-w-0 flex-1 space-y-2">
                        <div className="bg-card-lv1 h-3 w-32 animate-pulse rounded" />
                        <div className="bg-card-lv1 h-5 w-48 animate-pulse rounded" />
                    </div>
                </div>
            </CardContent>
        </Card>
    );
}
