import { Card } from "@components/ui/card";
import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
} from "@components/ui/tooltip";
import { ModelPricingInfo } from "@services/usage/types";
import {
    BadgeDollarSignIcon,
    CoinsIcon,
    InfoIcon,
    TrendingUpIcon,
} from "lucide-react";

import { M } from "../_lib/constants";

function formatCurrency(amount: number): string {
    if (amount >= 1000) {
        // Truncate instead of round to avoid overstating values
        const truncated = Math.floor((amount / 1000) * 100) / 100;
        return `$${truncated.toFixed(2)}K`;
    }
    return `$${amount.toFixed(2)}`;
}

function getAverageLabel(xAccessor: string): string {
    switch (xAccessor) {
        case "prNumber":
            return "Avg. per PR";
        case "developer":
            return "Avg. per Developer";
        default:
            return "Avg. per Day";
    }
}

function formatModelName(model: string): string {
    return model
        .replace(
            /^(openai\/|anthropic\/|google\/|meta-llama\/|mistralai\/)/,
            "",
        )
        .replace(/-\d{8}$/, "")
        .replace(/:free$/, "");
}

export const CostCards = ({
    totalCost,
    averageCost,
    xAccessor,
    pricing,
}: {
    totalCost: number;
    averageCost: number;
    xAccessor: string;
    pricing: Record<string, ModelPricingInfo>;
}) => {
    const models = Object.entries(pricing);
    const modelCount = models.length;

    // Calculate average pricing
    const validPricing = Object.values(pricing).filter((p) => p && p.pricing);
    const avgInput =
        modelCount > 0
            ? validPricing.reduce((acc, p) => acc + p.pricing.prompt * M, 0) /
              modelCount
            : 0;
    const avgOutput =
        modelCount > 0
            ? validPricing.reduce(
                  (acc, p) => acc + p.pricing.completion * M,
                  0,
              ) / modelCount
            : 0;

    // For single model, show its pricing directly
    const isSingleModel = modelCount === 1;
    const singleModel = isSingleModel ? models[0] : null;
    const displayInput = isSingleModel
        ? (singleModel![1].pricing.prompt * M).toFixed(2)
        : avgInput.toFixed(2);
    const displayOutput = isSingleModel
        ? (singleModel![1].pricing.completion * M).toFixed(2)
        : avgOutput.toFixed(2);

    return (
        <Card className="overflow-hidden">
            <div className="grid grid-cols-3 divide-x divide-[var(--color-card-lv1)]">
                {/* Total Cost */}
                <div className="flex items-center gap-4 p-4">
                    <div className="bg-success/10 flex size-12 shrink-0 items-center justify-center rounded-xl">
                        <BadgeDollarSignIcon className="text-success size-6" />
                    </div>
                    <div className="space-y-0.5">
                        <p className="text-text-secondary text-sm">
                            Total Cost
                        </p>
                        <p className="text-text-primary text-2xl font-semibold tabular-nums">
                            {formatCurrency(totalCost)}
                        </p>
                    </div>
                </div>

                {/* Average Cost */}
                <div className="flex items-center gap-4 p-4">
                    <div className="bg-secondary-dark flex size-12 shrink-0 items-center justify-center rounded-xl">
                        <TrendingUpIcon className="text-secondary-light size-6" />
                    </div>
                    <div className="space-y-0.5">
                        <p className="text-text-secondary text-sm">
                            {getAverageLabel(xAccessor)}
                        </p>
                        <p className="text-text-primary text-2xl font-semibold tabular-nums">
                            {formatCurrency(averageCost)}
                        </p>
                    </div>
                </div>

                {/* Pricing */}
                <div className="flex items-center gap-4 p-4">
                    <div className="bg-tertiary-dark flex size-12 shrink-0 items-center justify-center rounded-xl">
                        <CoinsIcon className="text-tertiary-light size-6" />
                    </div>
                    <div className="min-w-0 space-y-0.5">
                        <div className="flex items-center gap-1">
                            <p className="text-text-secondary truncate text-sm">
                                {modelCount === 0
                                    ? "No models"
                                    : isSingleModel
                                      ? formatModelName(singleModel![0])
                                      : `${modelCount} models`}
                            </p>
                            {modelCount > 1 && (
                                <TooltipProvider delayDuration={100}>
                                    <Tooltip>
                                        <TooltipTrigger className="inline-flex size-4 items-center justify-center">
                                            <InfoIcon className="text-text-tertiary size-3" />
                                        </TooltipTrigger>
                                        <TooltipContent
                                            side="top"
                                            className="max-w-64 p-3">
                                            <div className="space-y-1">
                                                {models.map(([model, info]) => (
                                                    <div
                                                        key={model}
                                                        className="flex items-center justify-between gap-4 text-xs">
                                                        <span className="text-text-secondary truncate">
                                                            {formatModelName(
                                                                model,
                                                            )}
                                                        </span>
                                                        <span className="text-text-primary whitespace-nowrap tabular-nums">
                                                            $
                                                            {(
                                                                info.pricing
                                                                    .prompt * M
                                                            ).toFixed(2)}
                                                            / $
                                                            {(
                                                                info.pricing
                                                                    .completion *
                                                                M
                                                            ).toFixed(2)}
                                                        </span>
                                                    </div>
                                                ))}
                                            </div>
                                        </TooltipContent>
                                    </Tooltip>
                                </TooltipProvider>
                            )}
                        </div>
                        {modelCount > 0 ? (
                            <>
                                <p className="text-text-primary text-2xl font-semibold tabular-nums">
                                    ${displayInput}
                                    <span className="text-text-tertiary text-lg font-normal">
                                        {" / "}
                                    </span>
                                    ${displayOutput}
                                </p>
                                <p className="text-text-tertiary text-xs">
                                    per 1M in / out
                                </p>
                            </>
                        ) : (
                            <p className="text-text-tertiary text-sm">
                                Select models to see pricing
                            </p>
                        )}
                    </div>
                </div>
            </div>
        </Card>
    );
};
