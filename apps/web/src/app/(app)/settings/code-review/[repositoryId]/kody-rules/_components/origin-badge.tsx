"use client";

import { Badge } from "@components/ui/badge";
import { AlertTriangle } from "lucide-react";
import {
    inferRuleOrigin,
    type InferredRuleOrigin,
} from "src/core/utils/kody-rules/infer-origin";

const ORIGIN_TOOLTIPS: Record<Exclude<InferredRuleOrigin, "manual">, string> = {
    "Auto-sync": "Imported from an IDE rule file in the repo",
    Onboard: "Suggested by onboarding analysis",
    "Kody-generated":
        "Suggested by the Kody rule generator from past reviews",
    Library: "Added from the Kody rule library",
};

// Distinct colour per origin so users can tell where a rule came from
// at a glance. Intentionally avoids the severity palette (danger /
// warning / alert / info) so the origin badge doesn't read as a
// severity. Tokens used here come from globals.css.
//
//   Auto-sync       → secondary (purple) — IDE / dev tooling
//   Onboard         → success   (green)  — "welcome", first-run
//   Kody-generated  → tertiary  (pink)   — Kody / LLM brand
//   Library         → info      (blue)   — curated catalog
//
// (Library is the one exception that does borrow from the severity
// palette — info/blue is otherwise used by Low severity. The risk of
// confusion is small because Low is rare and the Library badge text
// removes ambiguity.)
const ORIGIN_CLASSES: Record<
    Exclude<InferredRuleOrigin, "manual">,
    string
> = {
    "Auto-sync":
        "bg-secondary-light/10 text-secondary-light ring-secondary-light/40 [--button-foreground:var(--color-secondary-light)]",
    Onboard:
        "bg-success/10 text-success ring-success/40 [--button-foreground:var(--color-success)]",
    "Kody-generated":
        "bg-tertiary-light/10 text-tertiary-light ring-tertiary-light/40 [--button-foreground:var(--color-tertiary-light)]",
    Library:
        "bg-info/10 text-info ring-info/40 [--button-foreground:var(--color-info)]",
};

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
};

// Static visual badge that names the rule's origin (Auto-sync / Onboard /
// Kody-generated). Intentionally avoids Radix Tooltip because nesting a
// Radix Slot trigger inside arbitrary parents (TooltipTrigger > Badge >
// asChild) created a setRef loop in our setup. The hover tooltip is
// rendered as a native `title` attribute instead — no Radix slot, no
// composed refs, zero risk of infinite update.
//
// Two separate axes, two separate badges (they used to be conflated):
//
//   1. ORIGIN — where the rule came from. Always shown: Auto-sync /
//      Onboard / Kody-generated / Library (manual hides). Purely identity.
//
//   2. MAINTENANCE — only for Auto-sync rules, and only once the repo's
//      auto-sync toggle is OFF (`syncEnabledForRepo === false`), because
//      that's the only time the distinction matters:
//        • file still tagged `@kody-sync` (`pinnedSync`) → kept in sync →
//          discreet neutral `@kody-sync` chip (healthy, low emphasis).
//        • no marker → nobody maintains it → amber `Orphan` chip (the
//          actionable state; mirrors the orphan chip at the top of the
//          list). With the toggle ON every IDE rule syncs, so neither chip
//          renders.
export const OriginBadge = ({ rule, syncEnabledForRepo }: OriginBadgeProps) => {
    const origin = inferRuleOrigin(rule);
    if (origin === "manual") return null;

    const isAutoSync = origin === "Auto-sync";
    // Maintenance only matters for IDE-synced rules once auto-sync is off.
    const showMaintenance = isAutoSync && syncEnabledForRepo === false;
    const isPinned = rule.pinnedSync === true;

    const originTooltip =
        isAutoSync && rule.sourcePath
            ? "Imported from " + rule.sourcePath
            : ORIGIN_TOOLTIPS[origin];

    const sourceSuffix = rule.sourcePath ? " (" + rule.sourcePath + ")" : "";

    return (
        // Single inline-flex group so origin + maintenance behave as ONE
        // item inside the card header's `flex-wrap` container: when space
        // runs out they wrap together (maintenance stays glued under its
        // origin) instead of the maintenance chip breaking onto its own
        // line, orphaned from the Auto-sync badge it qualifies. The inner
        // gap is tighter than the header's `gap-2` to read as a unit.
        <span className="inline-flex flex-wrap items-center gap-1.5">
            <Badge
                active
                size="xs"
                title={originTooltip}
                className={
                    "min-h-auto px-2.5 py-1 ring-1 " + ORIGIN_CLASSES[origin]
                }>
                {origin}
            </Badge>

            {showMaintenance && isPinned && (
                <Badge
                    active
                    size="xs"
                    title={
                        "Kept in sync via @kody-sync even with auto-sync off" +
                        sourceSuffix
                    }
                    className="bg-card-lv2 text-text-secondary ring-card-lv3 min-h-auto px-2.5 py-1 ring-1 [--button-foreground:var(--color-text-secondary)]">
                    @kody-sync
                </Badge>
            )}

            {showMaintenance && !isPinned && (
                <Badge
                    active
                    size="xs"
                    title={
                        "Auto-sync is off and this file has no @kody-sync marker — no longer maintained" +
                        sourceSuffix
                    }
                    className="bg-warning/10 text-warning ring-warning/40 min-h-auto px-2.5 py-1 ring-1 [--button-foreground:var(--color-warning)]">
                    <AlertTriangle
                        className="-ml-0.5 mr-1 size-3"
                        aria-hidden
                    />
                    Orphan
                </Badge>
            )}
        </span>
    );
};
