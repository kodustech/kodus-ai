"use client";

import { Badge } from "@components/ui/badge";
import { Card, CardContent } from "@components/ui/card";
import {
    Tooltip,
    TooltipContent,
    TooltipPortal,
    TooltipTrigger,
} from "@components/ui/tooltip";
import {
    ActivityIcon,
    AlertTriangleIcon,
    CheckCircleIcon,
    ClockIcon,
    CoinsIcon,
    FileTextIcon,
    GaugeIcon,
    TrophyIcon,
} from "lucide-react";
import { cn } from "src/core/utils/components";

import type { CuratedModel } from "../../_data/curated-models.types";

const SPEED_LABELS: Record<string, string> = {
    fast: "Fast",
    medium: "Medium",
    slow: "Slow",
};

const PROVIDER_LABELS: Record<string, string> = {
    anthropic: "Anthropic",
    openai: "OpenAI",
    google_gemini: "Google",
    openrouter: "OpenRouter",
    novita: "Novita",
    openai_compatible: "OpenAI-compatible",
};

function MetricTag({
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

function formatLatency(ms?: number): string | null {
    if (ms == null) return null;
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
}

export function CuratedModelCard({
    model,
    isSelected,
    compact = false,
    onSelect,
}: {
    model: CuratedModel;
    isSelected?: boolean;
    compact?: boolean;
    onSelect?: () => void;
}) {
    const latency = formatLatency(model.latencyP50Ms);
    const errorRate =
        model.errorRatePct != null ? `${model.errorRatePct}%` : null;

    return (
        <Card
            color="lv1"
            className={cn(
                "h-full cursor-pointer transition-all",
                isSelected
                    ? "ring-primary-light ring-2"
                    : "hover:ring-border-secondary hover:ring-1",
                !onSelect && "cursor-default",
            )}
            onClick={onSelect}>
            <CardContent className="flex h-full flex-col gap-3 p-4">
                <div className="flex items-start justify-between gap-2">
                    <div className="flex flex-col gap-1">
                        <span className="text-sm font-semibold leading-tight">
                            {model.displayName}
                        </span>
                        <span className="text-text-tertiary text-xs">
                            {model.providerDisplayName ??
                                PROVIDER_LABELS[model.provider] ??
                                model.provider}
                        </span>
                    </div>

                    <Tooltip>
                        <TooltipTrigger asChild>
                            <span>
                                <Badge variant="secondary" size="xs">
                                    <TrophyIcon size={10} className="mr-1" />
                                    <span className="tabular-nums">
                                        {model.benchmarkScore}
                                    </span>
                                </Badge>
                            </span>
                        </TooltipTrigger>
                        <TooltipPortal>
                            <TooltipContent side="bottom">
                                Benchmark score (0–100) on our code-review test
                                suite
                            </TooltipContent>
                        </TooltipPortal>
                    </Tooltip>
                </div>

                {!compact && (
                    <p className="text-text-secondary line-clamp-2 text-xs leading-snug text-pretty">
                        {model.description}
                    </p>
                )}

                <div className="mt-auto flex flex-wrap items-center gap-1.5">
                    <MetricTag
                        icon={<ClockIcon size={10} className="mr-1" />}
                        label={SPEED_LABELS[model.speed] ?? model.speed}
                        tooltip="Response time based on p90 latency across benchmark tests"
                    />
                    {latency && (
                        <MetricTag
                            icon={<GaugeIcon size={10} className="mr-1" />}
                            label={`p50 ${latency}`}
                            tooltip="Median response time (p50) observed across production runs"
                        />
                    )}
                    {errorRate && (
                        <MetricTag
                            icon={<ActivityIcon size={10} className="mr-1" />}
                            label={`err ${errorRate}`}
                            tooltip="Error rate observed across production runs"
                        />
                    )}
                    <MetricTag
                        icon={<FileTextIcon size={10} className="mr-1" />}
                        label={model.contextWindow}
                        tooltip="Maximum input size per request (context window)"
                    />
                    <MetricTag
                        icon={<CoinsIcon size={10} className="mr-1" />}
                        label={model.costTier}
                        tooltip="Relative cost per 1M tokens (input/output)"
                    />
                </div>

                {!compact && model.strengths.length > 0 && (
                    <ul className="flex flex-col gap-0.5">
                        {model.strengths.slice(0, 2).map((s) => (
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

                {!compact && model.weaknesses.length > 0 && (
                    <ul className="flex flex-col gap-0.5">
                        {model.weaknesses.slice(0, 1).map((w) => (
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

export { PROVIDER_LABELS };
