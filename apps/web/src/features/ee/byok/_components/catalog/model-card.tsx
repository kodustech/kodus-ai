"use client";

import { useState } from "react";
import { Badge } from "@components/ui/badge";
import { Button } from "@components/ui/button";
import { Card, CardContent } from "@components/ui/card";
import {
    AlertTriangleIcon,
    CheckCircleIcon,
    ChevronDownIcon,
    PlugIcon,
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

export function CuratedModelCard({
    model,
    isSelected,
    compact = false,
    showConnect = false,
    fillHeight = true,
    onSelect,
}: {
    model: CuratedModel;
    isSelected?: boolean;
    compact?: boolean;
    /** Render a full-width "Connect" button at the card foot (recommended-card
     *  usage). The button drives the same onSelect connect flow. */
    showConnect?: boolean;
    /** Grid usage stretches every card to the tallest in its row (`h-full`).
     *  Standalone (e.g. as an editor header) pass `false` so the card is its own
     *  natural height instead of a giant stretched box. */
    fillHeight?: boolean;
    onSelect?: () => void;
}) {
    const [showDetails, setShowDetails] = useState(false);
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
                "transition-all",
                fillHeight && "h-full",
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
            <CardContent
                className={cn(
                    "flex flex-col gap-3 p-4",
                    fillHeight && "h-full",
                )}>
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
                </div>

                {!compact && (
                    <p className="text-text-secondary line-clamp-2 text-xs leading-snug text-pretty">
                        {model.description}
                    </p>
                )}

                {!compact && hasEvidence && (
                    <div className="mt-auto flex flex-col gap-2">
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

export { PROVIDER_LABELS };
