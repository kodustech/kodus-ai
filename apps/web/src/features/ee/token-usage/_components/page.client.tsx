"use client";

import { useEffect, useMemo, useState } from "react";
import { Card } from "@components/ui/card";
import {
    BaseUsageContract,
    ModelPricingInfo,
    TokenPrice,
} from "@services/usage/types";
import { DateRangePicker } from "src/features/ee/cockpit/_components/date-range-picker";

import { useTokenUsageFilters } from "../_hooks/filter.hook";
import { Chart } from "./chart";
import { CostCards } from "./cost-cards";
import { Filters } from "./filters";
import { NoData } from "./no-data";
import { SummaryCards } from "./summary-cards";

type UsageForCost = {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
};

/**
 * Cost math MUST stay in sync with the backend `CostEstimateUseCase`:
 *  - Reasoning tokens are already inside outputTokens (do NOT add them again).
 *  - Cache reads are a subset of input — subtract before billing.
 *  - Use the >200K tier rate when the aggregate input suggests calls
 *    routinely exceed that threshold (matches backend heuristic).
 */
const pickRate = (price: TokenPrice | undefined, useAbove200k: boolean) => {
    if (!price) return 0;
    if (useAbove200k && typeof price.above200k === "number") {
        return price.above200k;
    }
    return price.default ?? 0;
};

const calculateCost = (model: ModelPricingInfo, usage: UsageForCost) => {
    if (!model || !model.pricing) {
        return { inputCost: 0, outputCost: 0, cacheCost: 0, totalCost: 0 };
    }

    const useAbove200k = usage.input > 200_000;
    const inputRate = pickRate(model.pricing.input, useAbove200k);
    const outputRate = pickRate(model.pricing.output, useAbove200k);
    const cacheReadRate = pickRate(model.pricing.cacheRead, useAbove200k);
    const cacheWriteRate = pickRate(model.pricing.cacheWrite, useAbove200k);

    const uncachedInput = Math.max(0, usage.input - usage.cacheRead);
    const inputCost = uncachedInput * inputRate;
    const outputCost = usage.output * outputRate;
    const cacheCost =
        usage.cacheRead * cacheReadRate + usage.cacheWrite * cacheWriteRate;

    return {
        inputCost,
        outputCost,
        cacheCost,
        totalCost: inputCost + outputCost + cacheCost,
    };
};

export const TokenUsagePageClient = ({
    data,
    cookieValue,
    models,
    pricing,
}: {
    data: BaseUsageContract[];
    cookieValue: string | undefined;
    models: string[];
    pricing: Record<string, ModelPricingInfo>;
}) => {
    const [isMounted, setIsMounted] = useState(false);

    const filters = useTokenUsageFilters(models);
    const { selectedModels, currentFilter } = filters;

    useEffect(() => {
        setIsMounted(true);
    }, []);

    const filteredData = useMemo(() => {
        if (!data) return [];
        return data.filter((d) => selectedModels.includes(d.model));
    }, [data, selectedModels]);

    const totalUsage = useMemo(() => {
        if (!filteredData) {
            return {
                input: 0,
                output: 0,
                total: 0,
                outputReasoning: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalCost: 0,
            };
        }

        const usageByModel: Record<
            string,
            {
                input: number;
                output: number;
                total: number;
                outputReasoning: number;
                cacheRead: number;
                cacheWrite: number;
            }
        > = {};

        selectedModels.forEach((model) => {
            usageByModel[model] = {
                input: 0,
                output: 0,
                total: 0,
                outputReasoning: 0,
                cacheRead: 0,
                cacheWrite: 0,
            };
        });

        filteredData.forEach((day) => {
            if (usageByModel[day.model]) {
                usageByModel[day.model].input += day?.input ?? 0;
                usageByModel[day.model].output += day?.output ?? 0;
                usageByModel[day.model].total += day?.total ?? 0;
                usageByModel[day.model].outputReasoning +=
                    day?.outputReasoning ?? 0;
                usageByModel[day.model].cacheRead += day?.cacheRead ?? 0;
                usageByModel[day.model].cacheWrite += day?.cacheWrite ?? 0;
            }
        });

        let totalInput = 0;
        let totalOutput = 0;
        let totalTokens = 0;
        let totalOutputReasoning = 0;
        let totalCacheRead = 0;
        let totalCacheWrite = 0;
        let totalCostAllModels = 0;

        for (const model of selectedModels) {
            const modelUsage = usageByModel[model];
            const modelPricing = pricing[model];
            if (modelUsage && modelPricing) {
                const cost = calculateCost(modelPricing, {
                    input: modelUsage.input,
                    output: modelUsage.output,
                    cacheRead: modelUsage.cacheRead,
                    cacheWrite: modelUsage.cacheWrite,
                });

                totalInput += modelUsage.input;
                totalOutput += modelUsage.output;
                totalTokens += modelUsage.total;
                totalOutputReasoning += modelUsage.outputReasoning;
                totalCacheRead += modelUsage.cacheRead;
                totalCacheWrite += modelUsage.cacheWrite;
                totalCostAllModels += cost.totalCost;
            }
        }

        return {
            input: totalInput,
            output: totalOutput,
            total: totalTokens,
            outputReasoning: totalOutputReasoning,
            cacheRead: totalCacheRead,
            cacheWrite: totalCacheWrite,
            totalCost: totalCostAllModels,
        };
    }, [filteredData, selectedModels, pricing]);

    const getXAccessor = () => {
        switch (currentFilter) {
            case "daily":
                return "date";
            case "by-pr":
                return "prNumber";
            case "by-developer":
                return "developer";
            default:
                return "date";
        }
    };

    const xAccessor = getXAccessor();

    const averageCost = useMemo(() => {
        if (!filteredData || filteredData.length === 0) return 0;

        const uniqueItems = new Set(
            filteredData.map((d) => d[xAccessor as keyof BaseUsageContract]),
        );
        const numberOfUniqueItems = uniqueItems.size;

        if (numberOfUniqueItems === 0) return 0;

        return totalUsage.totalCost / numberOfUniqueItems;
    }, [filteredData, totalUsage.totalCost, xAccessor]);

    // Filter pricing to only include selected models
    const filteredPricing = useMemo(() => {
        const result: Record<string, ModelPricingInfo> = {};
        for (const model of selectedModels) {
            if (pricing[model]) {
                result[model] = pricing[model];
            }
        }
        return result;
    }, [pricing, selectedModels]);

    if (!isMounted) {
        return null;
    }

    return (
        <div className="flex flex-col gap-5">
            {/* Filters Row */}
            <div className="flex items-center justify-between gap-4">
                <Filters models={models} filters={filters} />
                <DateRangePicker cookieValue={cookieValue} />
            </div>

            {/* Token Summary */}
            <SummaryCards totalUsage={totalUsage} />

            {/* Cost & Pricing Row */}
            <CostCards
                totalCost={totalUsage.totalCost}
                averageCost={averageCost}
                xAccessor={xAccessor}
                pricing={filteredPricing}
            />

            {/* Chart */}
            <Card className="h-[420px] p-5">
                {filteredData && filteredData.length > 0 ? (
                    <Chart data={filteredData} filterType={currentFilter} />
                ) : (
                    <NoData />
                )}
            </Card>
        </div>
    );
};
