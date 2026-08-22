import { Badge } from "@components/ui/badge";
import { SeverityLevel } from "src/core/types";
import { cn } from "src/core/utils/components";

export const severityLevelClassnames: Record<SeverityLevel, string> = {
    // Single source of truth for severity → tint, with a real hue step so the
    // tiers stay distinguishable (and colourblind-safe): critical=red,
    // high=orange, medium=yellow, low=muted grey. The text label below is kept
    // as a redundant, never-colour-only cue.
    critical:
        "bg-danger/10 text-danger ring-danger/64 [--button-foreground:var(--color-danger)]",
    high: "bg-warning/10 text-warning ring-warning/64 [--button-foreground:var(--color-warning)]",
    medium: "bg-alert/10 text-alert ring-alert/64 [--button-foreground:var(--color-alert)]",
    low: "bg-text-secondary/10 text-text-secondary ring-text-secondary/40 [--button-foreground:var(--color-text-secondary)]",
} as const;

/**
 * The ONE place that maps a severity tier to its colour CSS variable. Both the
 * DS badge below and the raw dots / accent borders on the PR-review surfaces
 * (rail + inline card) read from here, so a tier is always the same hue
 * wherever it shows up.
 */
export const severityColorVar: Record<SeverityLevel, string> = {
    critical: "var(--color-danger)",
    high: "var(--color-warning)",
    medium: "var(--color-alert)",
    low: "var(--color-text-secondary)",
} as const;

const knownSeverities = Object.keys(severityLevelClassnames) as SeverityLevel[];

/** Coerce any raw severity string (incl. legacy "info") to a known tier. */
export function normalizeSeverity(
    severity: SeverityLevel | string | null | undefined,
): SeverityLevel {
    const s = (severity ?? "").toLowerCase();
    return knownSeverities.includes(s as SeverityLevel)
        ? (s as SeverityLevel)
        : SeverityLevel.LOW;
}

/** Resolve any raw severity string to its canonical colour CSS variable. */
export function getSeverityColorVar(
    severity: SeverityLevel | string | null | undefined,
): string {
    return severityColorVar[normalizeSeverity(severity)];
}

export const IssueSeverityLevelBadge = ({
    severity,
    className,
}: {
    className?: string;
    severity: SeverityLevel | string;
}) => {
    const normalizedSeverity = normalizeSeverity(severity);

    return (
        <Badge
            className={cn(
                "pointer-events-none h-6 min-h-auto rounded-lg px-2 text-[10px] leading-px uppercase ring-1",
                className,
                severityLevelClassnames[normalizedSeverity],
            )}>
            {normalizedSeverity}
        </Badge>
    );
};
