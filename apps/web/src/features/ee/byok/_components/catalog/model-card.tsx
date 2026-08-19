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
    ActivityIcon,
    AlertTriangleIcon,
    CheckCircleIcon,
    ChevronDownIcon,
    ClockIcon,
    DollarSignIcon,
    FileTextIcon,
    GaugeIcon,
    PlugIcon,
    StarIcon,
} from "lucide-react";
import { cn } from "src/core/utils/components";

import type { CuratedModel } from "../../_data/curated-models.types";

/**
 * A recommendation label ("Best balance", "Highest quality", "Most affordable")
 * maps to a colored tier badge. The Badge/Button DS has success (green) and
 * in-progress (blue) tinted variants; there is no amber variant, so "Best
 * balance" uses an inline warning tint built from the --color-warning token.
 */
const TIER_BADGE: Record<
    string,
    {
        variant?: React.ComponentProps<typeof Button>["variant"];
        className?: string;
    }
> = {
    "Best balance": {
        className:
            "[--button-background:#2a1d10] [--button-foreground:var(--color-warning)]",
    },
    "Highest quality": { variant: "success" },
    "Most affordable": { variant: "in-progress" },
};

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
    open_router: "OpenRouter",
    novita: "Novita",
    moonshot: "Moonshot",
    zai: "Z.ai",
    openai_compatible: "OpenAI-compatible",
    // Distinct labels so registry-only providers never collide with their
    // native sibling in the picker (e.g. two "Anthropic" cards).
    anthropic_compatible: "Anthropic-compatible",
    google_vertex: "Google Vertex AI",
    amazon_bedrock: "Amazon Bedrock",
    azure: "Azure OpenAI",
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
    showConnect = false,
    showScore = true,
    onSelect,
}: {
    model: CuratedModel;
    isSelected?: boolean;
    compact?: boolean;
    /** Render a full-width "Connect" button at the card foot (recommended-card
     *  usage). The button drives the same onSelect connect flow. */
    showConnect?: boolean;
    /** The quality score is the "which model is best" signal — it belongs to the
     *  Routing tab, where the per-task model is chosen. The connect surfaces pass
     *  `false` so wiring up a provider isn't framed as picking the best model. */
    showScore?: boolean;
    onSelect?: () => void;
}) {
    const [showDetails, setShowDetails] = useState(false);
    const latency = formatLatency(model.latencyP50Ms);
    const errorRate =
        model.errorRatePct != null ? `${model.errorRatePct}%` : null;
    const tierBadge = model.recommendationLabel
        ? TIER_BADGE[model.recommendationLabel]
        : undefined;
    // With a dedicated Connect button, the whole-card click is redundant.
    const cardClickable = !!onSelect && !showConnect;
    // Strengths/weaknesses live behind ONE consistent "Details" reveal so every
    // card presents the same evidence structure at rest — a flagship with no
    // bullets no longer looks worse than a card that happens to have them.
    // Backend-sourced catalog entries may omit these arrays — guard against
    // `.length` on undefined.
    const strengths = model.strengths ?? [];
    const weaknesses = model.weaknesses ?? [];
    const hasEvidence = strengths.length > 0 || weaknesses.length > 0;

    return (
        <Card
            color="lv1"
            className={cn(
                "h-full transition-all",
                cardClickable
                    ? "focus-visible:ring-primary-light cursor-pointer focus-visible:ring-2 focus-visible:outline-none"
                    : "cursor-default",
                isSelected
                    ? "ring-primary-light ring-2"
                    : "hover:ring-border-secondary hover:ring-1",
            )}
            role={cardClickable ? "button" : undefined}
            tabIndex={cardClickable ? 0 : undefined}
            onClick={cardClickable ? onSelect : undefined}
            onKeyDown={
                cardClickable
                    ? (e) => {
                        if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            onSelect?.();
                        }
                    }
                    : undefined
            }>
            <CardContent className="flex h-full flex-col gap-3 p-4">
                {model.recommendationLabel && (
                    <div>
                        <Badge
                            size="xs"
                            variant={tierBadge?.variant}
                            className={tierBadge?.className}>
                            {model.recommendationLabel}
                        </Badge>
                    </div>
                )}

                <div className="flex items-start justify-between gap-2">
                    <div className="flex flex-col gap-1">
                        <span className="text-sm leading-tight font-semibold">
                            {model.displayName}
                        </span>
                        <span className="text-text-tertiary text-xs">
                            {model.providerDisplayName ??
                                PROVIDER_LABELS[model.provider] ??
                                model.provider}
                        </span>
                    </div>

                    {showScore && (
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <span>
                                    <Badge variant="secondary" size="xs">
                                        <StarIcon size={10} className="mr-1" />
                                        <span className="tabular-nums">
                                            {model.benchmarkScore}
                                        </span>
                                    </Badge>
                                </span>
                            </TooltipTrigger>
                            <TooltipPortal>
                                <TooltipContent side="bottom">
                                    Quality score out of 100 on our code-review
                                    benchmark
                                </TooltipContent>
                            </TooltipPortal>
                        </Tooltip>
                    )}
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
                        tooltip="Typical response speed"
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
                        tooltip="Context window — how much it can read per request"
                    />
                    <MetricTag
                        icon={<DollarSignIcon size={10} className="mr-1" />}
                        label={model.costTier}
                        tooltip="Relative cost — $ is cheapest, $$$ is priciest"
                    />
                </div>

                {!compact && hasEvidence && (
                    <div className="flex flex-col gap-2">
                        <button
                            type="button"
                            aria-expanded={showDetails}
                            onClick={(e) => {
                                e.stopPropagation();
                                setShowDetails((v) => !v);
                            }}
                            className="text-text-tertiary hover:text-text-primary flex items-center gap-1 self-start text-xs transition-colors">
                            <ChevronDownIcon
                                size={12}
                                className={cn(
                                    "transition-transform",
                                    showDetails && "rotate-180",
                                )}
                            />
                            {showDetails ? "Hide details" : "Details"}
                        </button>

                        {showDetails && (
                            <div className="flex flex-col gap-1.5">
                                {strengths.length > 0 && (
                                    <ul className="flex flex-col gap-0.5">
                                        {strengths.map((s) => (
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
                                {weaknesses.length > 0 && (
                                    <ul className="flex flex-col gap-0.5">
                                        {weaknesses.map((w) => (
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
                            </div>
                        )}
                    </div>
                )}

                {showConnect && (
                    <Button
                        type="button"
                        size="sm"
                        variant="primary"
                        leftIcon={<PlugIcon />}
                        className="mt-1 w-full justify-center"
                        onClick={onSelect}>
                        Connect
                    </Button>
                )}
            </CardContent>
        </Card>
    );
}

/**
 * A one-time key for the glyphs on the model cards below it. Tooltips repeat
 * this per-glyph, but a visible legend makes the shorthand ("★ 91", "$$$",
 * "Fast") readable without hovering.
 */
export function ModelCardLegend({ showScore = true }: { showScore?: boolean }) {
    return (
        <div className="text-text-tertiary flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
            {showScore && (
                <span className="flex items-center gap-1">
                    <StarIcon size={11} />
                    Quality score /100
                </span>
            )}
            <span className="flex items-center gap-1">
                <ClockIcon size={11} />
                Typical speed
            </span>
            <span className="flex items-center gap-1">
                <FileTextIcon size={11} />
                Context window
            </span>
            <span className="flex items-center gap-1">
                <DollarSignIcon size={11} />
                Relative cost ($–$$$)
            </span>
        </div>
    );
}

export { PROVIDER_LABELS };
