"use client";

import { Badge } from "@components/ui/badge";
import {
    BookOpenIcon,
    BotIcon,
    PencilLineIcon,
    PlugIcon,
    RefreshCwIcon,
    SnowflakeIcon,
    SparklesIcon,
    TerminalIcon,
} from "lucide-react";
import { cn } from "src/core/utils/components";
import {
    inferRuleOrigin,
    type InferredRuleOrigin,
} from "src/core/utils/kody-rules/infer-origin";

const ORIGIN_TOOLTIPS: Record<InferredRuleOrigin, string> = {
    "Auto-sync": "Kept in sync with a Kody rule file in the repo",
    "Agent file":
        "Imported from a coding-agent file before those stopped becoming rules. Frozen: it no longer updates",
    "Onboarding": "Suggested by onboarding analysis",
    "Kody-generated": "Suggested by the Kody rule generator from past reviews",
    "Library": "Added from the Kody rule library",
    "MCP/Agent": "Created by an MCP / agent",
    "CLI": "Created via the Kody CLI",
    "manual": "Written by hand in this workspace",
};

// Provenance is told by an icon, not a colour: origin is metadata, and the
// old per-origin palette (purple / green / pink / blue) competed with the
// severity tier, which is the one signal that should carry colour.
const ORIGIN_ICONS: Record<InferredRuleOrigin, typeof BotIcon> = {
    "Auto-sync": RefreshCwIcon,
    "Agent file": SnowflakeIcon,
    "Onboarding": SparklesIcon,
    "Kody-generated": BotIcon,
    "Library": BookOpenIcon,
    "MCP/Agent": PlugIcon,
    "CLI": TerminalIcon,
    "manual": PencilLineIcon,
};

const QUIET_BADGE =
    "bg-card-lv2 text-text-secondary ring-card-lv3 min-h-auto px-2 py-1 ring-1 [--button-foreground:var(--color-text-secondary)]";

type OriginBadgeProps = {
    rule: {
        sourcePath?: string | null;
        origin?: string | null;
    };
    /**
     * `badge` (default): quiet pill, hides "manual" — for cards and headers.
     * `text`: icon + label in running text, shows "Manual" too — for table
     * columns and metadata lines where a pill would be visual noise.
     */
    variant?: "badge" | "text";
    className?: string;
};

// Native `title` tooltips on purpose: nesting a Radix Tooltip trigger inside
// arbitrary parents created a setRef loop in our setup.
export const OriginBadge = ({
    rule,
    variant = "badge",
    className,
}: OriginBadgeProps) => {
    const origin = inferRuleOrigin(rule);
    if (origin === "manual" && variant === "badge") return null;

    const Icon = ORIGIN_ICONS[origin];
    const label = origin === "manual" ? "Manual" : origin;
    const fromFile = origin === "Auto-sync" || origin === "Agent file";

    const originTooltip =
        fromFile && rule.sourcePath
            ? ORIGIN_TOOLTIPS[origin] + " (" + rule.sourcePath + ")"
            : ORIGIN_TOOLTIPS[origin];

    if (variant === "text") {
        return (
            <span
                title={originTooltip}
                className={cn(
                    "text-text-secondary inline-flex items-center gap-1 text-xs",
                    className,
                )}>
                <Icon
                    className="text-text-tertiary size-3.5 shrink-0"
                    aria-hidden
                />
                {label}
            </span>
        );
    }

    return (
        <Badge
            active
            size="xs"
            title={originTooltip}
            leftIcon={<Icon aria-hidden />}
            className={cn(
                QUIET_BADGE,
                "gap-1.5 [--icon-size:0.875rem]",
                className,
            )}>
            {label}
        </Badge>
    );
};
