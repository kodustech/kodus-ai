"use client";

import { Badge } from "@components/ui/badge";
import {
    AlertTriangle,
    BookOpenIcon,
    BotIcon,
    PencilLineIcon,
    PlugIcon,
    RefreshCwIcon,
    SparklesIcon,
    TerminalIcon,
} from "lucide-react";
import { cn } from "src/core/utils/components";
import {
    inferRuleOrigin,
    type InferredRuleOrigin,
} from "src/core/utils/kody-rules/infer-origin";

const ORIGIN_TOOLTIPS: Record<InferredRuleOrigin, string> = {
    "Auto-sync": "Imported from an IDE rule file in the repo",
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
        pinnedSync?: boolean | null;
    };
    /**
     * The repo's `ideRulesSyncEnabled` toggle. The maintenance badge
     * (`@kody-sync` vs `Orphan`) is only meaningful — and only rendered —
     * for Auto-sync rules when this is explicitly `false`. With the toggle
     * on (or in global view, where it's left `undefined`) every IDE rule
     * syncs, so the distinction would be noise and nothing extra is shown.
     */
    syncEnabledForRepo?: boolean;
    /**
     * `badge` (default): quiet pill, hides "manual" — for cards and headers.
     * `text`: icon + label in running text, shows "Manual" too — for table
     * columns and metadata lines where a pill would be visual noise.
     */
    variant?: "badge" | "text";
    className?: string;
};

// Two separate axes, two separate chips (they used to be conflated):
//
//   1. ORIGIN — where the rule came from. Identity only.
//
//   2. MAINTENANCE — only for Auto-sync rules, and only once the repo's
//      auto-sync toggle is OFF (`syncEnabledForRepo === false`), because
//      that's the only time the distinction matters:
//        • file still tagged `@kody-sync` (`pinnedSync`) → kept in sync →
//          quiet `@kody-sync` chip (healthy, low emphasis).
//        • no marker → nobody maintains it → amber `Orphan` chip (the
//          actionable state; mirrors the orphan chip at the top of the
//          list). With the toggle ON every IDE rule syncs, so neither chip
//          renders.
//
// Native `title` tooltips on purpose: nesting a Radix Tooltip trigger inside
// arbitrary parents created a setRef loop in our setup.
export const OriginBadge = ({
    rule,
    syncEnabledForRepo,
    variant = "badge",
    className,
}: OriginBadgeProps) => {
    const origin = inferRuleOrigin(rule);
    if (origin === "manual" && variant === "badge") return null;

    const Icon = ORIGIN_ICONS[origin];
    const label = origin === "manual" ? "Manual" : origin;
    const isAutoSync = origin === "Auto-sync";
    // Maintenance only matters for IDE-synced rules once auto-sync is off.
    const showMaintenance = isAutoSync && syncEnabledForRepo === false;
    const isPinned = rule.pinnedSync === true;

    const originTooltip =
        isAutoSync && rule.sourcePath
            ? "Imported from " + rule.sourcePath
            : ORIGIN_TOOLTIPS[origin];
    const sourceSuffix = rule.sourcePath ? " (" + rule.sourcePath + ")" : "";

    const maintenance = showMaintenance ? (
        isPinned ? (
            <Badge
                active
                size="xs"
                title={
                    "Kept in sync via @kody-sync even with auto-sync off" +
                    sourceSuffix
                }
                className={QUIET_BADGE}>
                @kody-sync
            </Badge>
        ) : (
            <Badge
                active
                size="xs"
                title={
                    "Auto-sync is off and this file has no @kody-sync marker — no longer maintained" +
                    sourceSuffix
                }
                className="bg-warning/10 text-warning ring-warning/40 min-h-auto px-2 py-1 ring-1 [--button-foreground:var(--color-warning)]">
                <AlertTriangle className="mr-1 -ml-0.5 size-3" aria-hidden />
                Orphan
            </Badge>
        )
    ) : null;

    if (variant === "text") {
        return (
            <span
                className={cn(
                    "inline-flex flex-wrap items-center gap-1.5",
                    className,
                )}>
                <span
                    title={originTooltip}
                    className="text-text-secondary inline-flex items-center gap-1 text-xs">
                    <Icon
                        className="text-text-tertiary size-3.5 shrink-0"
                        aria-hidden
                    />
                    {label}
                </span>
                {maintenance}
            </span>
        );
    }

    return (
        // Single inline-flex group so origin + maintenance wrap together
        // inside a `flex-wrap` header instead of the maintenance chip
        // breaking onto its own line, orphaned from the origin it qualifies.
        <span
            className={cn(
                "inline-flex flex-wrap items-center gap-1.5",
                className,
            )}>
            <Badge
                active
                size="xs"
                title={originTooltip}
                leftIcon={<Icon aria-hidden />}
                className={cn(QUIET_BADGE, "gap-1.5 [--icon-size:0.875rem]")}>
                {label}
            </Badge>
            {maintenance}
        </span>
    );
};
