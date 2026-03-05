"use client";

import { useState } from "react";
import { Badge } from "@components/ui/badge";
import { Button } from "@components/ui/button";
import { Card, CardContent } from "@components/ui/card";
import {
    Tooltip,
    TooltipContent,
    TooltipPortal,
    TooltipTrigger,
} from "@components/ui/tooltip";
import {
    AlertTriangleIcon,
    CheckCircleIcon,
    ClockIcon,
    CoinsIcon,
    ExternalLinkIcon,
    FileTextIcon,
} from "lucide-react";
import { useFormContext } from "react-hook-form";
import { cn } from "src/core/utils/components";

import type { EditKeyForm } from "../_types";
import catalog from "../../../../_data/curated-models.json";
import type {
    CuratedModel,
    ModelTier,
} from "../../../../_data/curated-models.types";

const tierConfig: Record<ModelTier, { label: string; description: string }> = {
    recommended: {
        label: "Recommended",
        description: "Highest benchmark scores for code review",
    },
    bestValue: {
        label: "Best Value",
        description: "Great results at low cost",
    },
    budget: {
        label: "Budget",
        description: "Cheapest options with acceptable quality",
    },
    other: {
        label: "Other Tested Models",
        description: "Benchmarked but not actively recommended",
    },
};

const tierOrder: ModelTier[] = ["recommended", "bestValue", "budget", "other"];

const speedLabels: Record<string, string> = {
    fast: "Fast",
    medium: "Medium",
    slow: "Slow",
};

const providerLabels: Record<string, string> = {
    anthropic: "Anthropic",
    openai: "OpenAI",
    google_gemini: "Google",
    openrouter: "OpenRouter",
};

function TagWithTooltip({
    icon,
    label,
    tooltip,
}: {
    icon: React.ReactNode;
    label: string;
    tooltip: string;
}) {
    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <span>
                    <Badge variant="helper" size="xs">
                        {icon}
                        {label}
                    </Badge>
                </span>
            </TooltipTrigger>
            <TooltipPortal>
                <TooltipContent side="bottom">{tooltip}</TooltipContent>
            </TooltipPortal>
        </Tooltip>
    );
}

function ModelCard({
    model,
    isSelected,
    onSelect,
}: {
    model: CuratedModel;
    isSelected: boolean;
    onSelect: () => void;
}) {
    return (
        <Card
            color="lv1"
            className={cn(
                "cursor-pointer transition-all",
                isSelected
                    ? "ring-primary-light ring-2"
                    : "hover:ring-border-secondary hover:ring-1",
            )}
            onClick={onSelect}>
            <CardContent className="flex flex-col gap-3 p-4">
                <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold">
                            {model.displayName}
                        </span>
                        <Badge variant="secondary" size="xs">
                            {providerLabels[model.provider] ?? model.provider}
                        </Badge>
                    </div>
                    <span className="text-text-secondary text-xs font-medium">
                        {model.benchmarkScore}%
                    </span>
                </div>

                <p className="text-text-secondary text-xs">
                    {model.description}
                </p>

                <div className="flex flex-wrap items-center gap-1.5">
                    <TagWithTooltip
                        icon={<ClockIcon size={10} className="mr-1" />}
                        label={speedLabels[model.speed]}
                        tooltip="Response time based on p90 latency across benchmark tests"
                    />
                    <TagWithTooltip
                        icon={<FileTextIcon size={10} className="mr-1" />}
                        label={model.contextWindow}
                        tooltip="Maximum input size per request (context window)"
                    />
                    <TagWithTooltip
                        icon={<CoinsIcon size={10} className="mr-1" />}
                        label={model.costTier}
                        tooltip="Relative cost per 1M tokens (input/output)"
                    />
                </div>

                {model.strengths.length > 0 && (
                    <ul className="flex flex-col gap-0.5">
                        {model.strengths.map((s) => (
                            <li
                                key={s}
                                className="text-success flex items-start gap-1.5 text-xs">
                                <CheckCircleIcon
                                    size={12}
                                    className="mt-0.5 shrink-0"
                                />
                                {s}
                            </li>
                        ))}
                    </ul>
                )}

                {model.weaknesses.length > 0 && (
                    <ul className="flex flex-col gap-0.5">
                        {model.weaknesses.map((w) => (
                            <li
                                key={w}
                                className="text-warning flex items-start gap-1.5 text-xs">
                                <AlertTriangleIcon
                                    size={12}
                                    className="mt-0.5 shrink-0"
                                />
                                {w}
                            </li>
                        ))}
                    </ul>
                )}
            </CardContent>
        </Card>
    );
}

export const GuidedModelSelection = ({
    collapseOnSelect = false,
}: {
    collapseOnSelect?: boolean;
}) => {
    const form = useFormContext<EditKeyForm>();
    const selectedModel = form.watch("model");
    const currentProvider = form.watch("provider");
    const currentApiKey = form.watch("apiKey");
    const [expanded, setExpanded] = useState(true);

    const models = catalog.models as CuratedModel[];

    const grouped = tierOrder
        .map((tier) => ({
            tier,
            ...tierConfig[tier],
            models: models.filter((m) => m.tier === tier),
        }))
        .filter((g) => g.models.length > 0);

    const selectedCuratedModel = models.find((m) => m.id === selectedModel);

    const isCollapsed = collapseOnSelect && selectedCuratedModel && !expanded;

    const handleSelectModel = (model: CuratedModel) => {
        const preserveKey =
            currentProvider === model.provider ? currentApiKey : "";

        form.reset({
            provider: model.provider,
            model: model.id,
            apiKey: preserveKey,
            baseURL: null,
            temperature: model.defaults.temperature,
            maxOutputTokens: model.defaults.maxOutputTokens,
            maxInputTokens: null,
            maxConcurrentRequests: null,
        });

        if (collapseOnSelect) {
            setExpanded(false);
        }
    };

    if (isCollapsed && selectedCuratedModel) {
        return (
            <div className="flex flex-col gap-3">
                <ModelCard
                    model={selectedCuratedModel}
                    isSelected
                    onSelect={() => setExpanded(true)}
                />
                <Button
                    type="button"
                    variant="tertiary"
                    size="sm"
                    onClick={() => setExpanded(true)}>
                    Choose another model
                </Button>

                {selectedCuratedModel && (
                    <a
                        href={selectedCuratedModel.apiKeyUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary-light flex items-center gap-1.5 text-sm hover:underline">
                        Get your{" "}
                        {providerLabels[selectedCuratedModel.provider] ??
                            selectedCuratedModel.provider}{" "}
                        API key
                        <ExternalLinkIcon size={14} />
                    </a>
                )}
            </div>
        );
    }

    return (
        <div className="flex flex-col gap-5">
            {grouped.map((group) => (
                <div key={group.tier} className="flex flex-col gap-2">
                    <div>
                        <h4 className="text-sm font-semibold">{group.label}</h4>
                        <p className="text-text-tertiary text-xs">
                            {group.description}
                        </p>
                    </div>

                    <div className="grid grid-cols-1 gap-3">
                        {group.models.map((model) => (
                            <ModelCard
                                key={model.id}
                                model={model}
                                isSelected={selectedModel === model.id}
                                onSelect={() => handleSelectModel(model)}
                            />
                        ))}
                    </div>
                </div>
            ))}

            {selectedCuratedModel && (
                <a
                    href={selectedCuratedModel.apiKeyUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary-light flex items-center gap-1.5 text-sm hover:underline">
                    Get your{" "}
                    {providerLabels[selectedCuratedModel.provider] ??
                        selectedCuratedModel.provider}{" "}
                    API key
                    <ExternalLinkIcon size={14} />
                </a>
            )}
        </div>
    );
};
