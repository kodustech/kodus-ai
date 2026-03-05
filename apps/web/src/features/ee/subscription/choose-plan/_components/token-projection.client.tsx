"use client";

import { useMemo, useState } from "react";
import { Card, CardContent } from "@components/ui/card";
import { Link } from "@components/ui/link";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@components/ui/select";
import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
} from "@components/ui/tooltip";
import {
    CalculatorIcon,
    ChevronDownIcon,
    GitPullRequestIcon,
    InfoIcon,
    SparklesIcon,
    TrendingUpIcon,
    UsersIcon,
} from "lucide-react";
import { cn } from "src/core/utils/components";
import { CurrencyHelpers } from "src/core/utils/currency";

import type { SimulatorModel } from "../_services/models";

export type TokenProjection = {
    minCost: number;
    maxCost: number;
    minModel: string;
    maxModel: string;
    currency: string;
    uniquePRs: number;
    uniqueDevelopers: number;
    monthlyPRs: number;
    actualDaysUsed: number;
    monthlyInputTokens: number;
    monthlyOutputTokens: number;
};

export type UsageProgress = {
    current: number;
    required: number;
} | null;

const TRIAL_MODEL_ID = "gemini-2.5-pro";

export function TokenProjectionBanner({
    projection,
    simulatorModels,
}: {
    projection: TokenProjection;
    simulatorModels: SimulatorModel[];
}) {
    const [selectedModelId, setSelectedModelId] =
        useState<string>(TRIAL_MODEL_ID);
    const [isExpanded, setIsExpanded] = useState(false);

    const hasPerDev = projection.uniqueDevelopers > 0;
    const hasPerPR = projection.uniquePRs > 0;

    // Group models by provider
    const modelsByProvider = useMemo(() => {
        const grouped: Record<string, SimulatorModel[]> = {};
        for (const model of simulatorModels) {
            if (!grouped[model.provider]) {
                grouped[model.provider] = [];
            }
            grouped[model.provider].push(model);
        }
        return grouped;
    }, [simulatorModels]);

    // Calculate costs based on selected model
    const costs = useMemo(() => {
        const model = simulatorModels.find((m) => m.id === selectedModelId);
        if (!model) return null;

        const inputCostPerToken = model.costPerMillionInput / 1_000_000;
        const outputCostPerToken = model.costPerMillionOutput / 1_000_000;

        const monthlyCost =
            projection.monthlyInputTokens * inputCostPerToken +
            projection.monthlyOutputTokens * outputCostPerToken;

        const format = (amount: number) =>
            CurrencyHelpers.format({
                currency: "USD",
                amount,
                maximumFractionDigits: amount < 10 ? 2 : 0,
            });

        return {
            isTrialModel: selectedModelId === TRIAL_MODEL_ID,
            modelName: model.name,
            monthly: format(monthlyCost),
            perDev: hasPerDev
                ? format(monthlyCost / projection.uniqueDevelopers)
                : null,
            perPR:
                hasPerPR && projection.monthlyPRs > 0
                    ? format(monthlyCost / projection.monthlyPRs)
                    : null,
        };
    }, [selectedModelId, simulatorModels, projection, hasPerDev, hasPerPR]);

    if (!costs) return null;

    return (
        <Card className="overflow-hidden">
            <CardContent className="p-0">
                {/* Collapsed header - clickable */}
                <button
                    type="button"
                    onClick={() => setIsExpanded(!isExpanded)}
                    className="flex w-full items-center gap-4 px-5 py-4 text-left">
                    <div className="bg-primary-dark flex size-9 shrink-0 items-center justify-center rounded-full">
                        <TrendingUpIcon className="text-primary-light size-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                        <p className="text-text-secondary text-xs">
                            Estimated AI token cost
                            <span className="text-text-tertiary">
                                {" "}
                                · based on {projection.uniquePRs} PRs over{" "}
                                {projection.actualDaysUsed} day
                                {projection.actualDaysUsed !== 1 ? "s" : ""}
                            </span>
                        </p>
                        <div className="text-text-primary flex items-center gap-1 text-sm font-medium">
                            <span className="text-primary-light font-semibold tabular-nums">
                                {costs.monthly}
                            </span>
                            <span className="text-text-tertiary">/month</span>
                            <TooltipProvider delayDuration={100}>
                                <Tooltip>
                                    <TooltipTrigger asChild>
                                        <span
                                            onClick={(e) => e.stopPropagation()}
                                            className="inline-flex size-5 cursor-help items-center justify-center rounded-full hover:bg-[var(--color-card-lv1)]">
                                            <InfoIcon className="text-text-tertiary size-3.5" />
                                        </span>
                                    </TooltipTrigger>
                                    <TooltipContent
                                        side="top"
                                        className="max-w-72 p-3">
                                        <p className="text-text-secondary text-sm leading-relaxed text-pretty">
                                            Calculated from your average daily
                                            token usage (
                                            <span className="text-text-primary font-medium">
                                                {projection.actualDaysUsed} day
                                                {projection.actualDaysUsed !== 1
                                                    ? "s"
                                                    : ""}
                                            </span>{" "}
                                            with activity) projected to 30 days,
                                            using{" "}
                                            <span className="text-text-primary font-medium">
                                                {costs.modelName}
                                            </span>{" "}
                                            pricing.
                                        </p>
                                    </TooltipContent>
                                </Tooltip>
                            </TooltipProvider>
                            <span className="text-text-tertiary"> · </span>
                            <span className="text-text-secondary">
                                {costs.modelName}
                            </span>
                        </div>
                    </div>
                    <ChevronDownIcon
                        className={cn(
                            "text-text-tertiary size-5 shrink-0 transition-transform",
                            isExpanded && "rotate-180",
                        )}
                    />
                </button>

                {/* Expanded content */}
                {isExpanded && (
                    <>
                        <div className="space-y-4 border-t border-[var(--color-card-lv1)] px-5 py-4">
                            {/* Model Selector */}
                            {simulatorModels.length > 0 && (
                                <div className="flex items-center gap-3">
                                    <CalculatorIcon className="text-text-tertiary size-4 shrink-0" />
                                    <Select
                                        value={selectedModelId}
                                        onValueChange={setSelectedModelId}>
                                        <SelectTrigger className="flex-1">
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent className="max-h-64 overflow-y-auto">
                                            {Object.entries(
                                                modelsByProvider,
                                            ).map(([provider, models]) => (
                                                <div key={provider}>
                                                    <div className="text-text-tertiary px-2 py-1.5 text-xs font-medium">
                                                        {provider}
                                                    </div>
                                                    {models.map((model) => (
                                                        <SelectItem
                                                            key={model.id}
                                                            value={model.id}>
                                                            {model.name}
                                                            {model.id ===
                                                                TRIAL_MODEL_ID && (
                                                                <span className="text-text-tertiary ml-2">
                                                                    (used in
                                                                    trial)
                                                                </span>
                                                            )}
                                                        </SelectItem>
                                                    ))}
                                                </div>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                </div>
                            )}

                            {/* Metrics cards */}
                            {(() => {
                                const showPerDev =
                                    costs.perDev &&
                                    projection.uniqueDevelopers > 1;
                                const showPerPR = costs.perPR;

                                if (!showPerDev && !showPerPR) return null;

                                return (
                                    <div
                                        className={cn(
                                            "grid gap-3",
                                            showPerDev && showPerPR
                                                ? "grid-cols-2"
                                                : "grid-cols-1",
                                        )}>
                                        {showPerDev && (
                                            <div className="bg-card-lv1 flex flex-col gap-1 rounded-lg p-3">
                                                <div className="flex items-center gap-2">
                                                    <div className="bg-secondary-dark flex size-6 shrink-0 items-center justify-center rounded">
                                                        <UsersIcon className="text-secondary-light size-3.5" />
                                                    </div>
                                                    <p className="text-text-tertiary text-xs">
                                                        Per developer
                                                    </p>
                                                </div>
                                                <p className="text-text-primary text-lg font-semibold tabular-nums">
                                                    {costs.perDev}
                                                </p>
                                                <p className="text-text-tertiary text-xs">
                                                    {
                                                        projection.uniqueDevelopers
                                                    }{" "}
                                                    devs · ~
                                                    {Math.round(
                                                        projection.uniquePRs /
                                                            projection.uniqueDevelopers,
                                                    )}{" "}
                                                    PRs/dev
                                                </p>
                                            </div>
                                        )}

                                        {showPerPR && (
                                            <div className="bg-card-lv1 flex flex-col gap-1 rounded-lg p-3">
                                                <div className="flex items-center gap-2">
                                                    <div className="bg-tertiary-dark flex size-6 shrink-0 items-center justify-center rounded">
                                                        <GitPullRequestIcon className="text-tertiary-light size-3.5" />
                                                    </div>
                                                    <p className="text-text-tertiary text-xs">
                                                        Per pull request
                                                    </p>
                                                </div>
                                                <p className="text-text-primary text-lg font-semibold tabular-nums">
                                                    {costs.perPR}
                                                </p>
                                                <p className="text-text-tertiary text-xs">
                                                    ~{projection.monthlyPRs}{" "}
                                                    PRs/mo estimated
                                                </p>
                                            </div>
                                        )}
                                    </div>
                                );
                            })()}
                        </div>

                        {/* Footer note */}
                        <div className="bg-card-lv1 flex items-center justify-between gap-4 px-5 py-3">
                            <div className="flex items-center gap-2">
                                <SparklesIcon className="text-text-tertiary size-4 shrink-0" />
                                <p className="text-text-tertiary text-xs text-pretty">
                                    AI costs are paid directly to providers.
                                </p>
                            </div>
                            <Link
                                href="/token-usage"
                                className="text-primary-light hover:text-primary-lighter shrink-0 text-xs font-medium">
                                View usage
                            </Link>
                        </div>
                    </>
                )}
            </CardContent>
        </Card>
    );
}

export function TokenProjectionEmptyState({
    progress,
}: {
    progress: UsageProgress;
}) {
    const current = progress?.current ?? 0;
    const required = progress?.required ?? 3;
    const percentage = Math.min((current / required) * 100, 100);
    const hasStarted = current > 0;

    return (
        <Card className="overflow-hidden">
            <CardContent className="p-0">
                <div className="flex items-center gap-4 px-5 py-4">
                    <div className="bg-primary-dark flex size-9 shrink-0 items-center justify-center rounded-full">
                        <TrendingUpIcon className="text-primary-light size-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                        <p className="text-text-secondary text-xs">
                            Estimated AI token cost
                        </p>
                        <p className="text-text-primary text-sm font-medium">
                            {hasStarted ? (
                                <>
                                    <span className="text-primary-light">
                                        {current} of {required} PRs
                                    </span>
                                    <span className="text-text-tertiary">
                                        {" "}
                                        · Keep using Kody to get your estimate
                                    </span>
                                </>
                            ) : (
                                <span className="text-text-tertiary">
                                    Let Kody review a few PRs to see your
                                    estimated cost
                                </span>
                            )}
                        </p>
                        {/* Progress bar */}
                        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-card-lv1)]">
                            <div
                                className="bg-primary-light h-full rounded-full transition-all"
                                style={{ width: `${percentage}%` }}
                            />
                        </div>
                    </div>
                </div>
            </CardContent>
        </Card>
    );
}
