import { Badge } from "@components/ui/badge";
import type { SeverityLevel } from "src/core/types";
import { cn } from "src/core/utils/components";

export const severityLevelClassnames: Record<SeverityLevel, string> = {
    high: "bg-warning/10 text-warning ring-warning/64 [--button-foreground:var(--color-warning)]",
    medium: "bg-alert/10 text-alert ring-alert/64 [--button-foreground:var(--color-alert)]",
    low: "bg-info/10 text-info ring-info/64 [--button-foreground:var(--color-info)]",
    critical:
        "bg-danger/10 text-danger ring-danger/64 [--button-foreground:var(--color-danger)]",
} as const;

export const IssueSeverityLevelBadge = ({
    severity,
    className,
}: {
    className?: string;
    severity: SeverityLevel | string;
}) => {
    const knownSeverities = Object.keys(
        severityLevelClassnames,
    ) as SeverityLevel[];
    const normalizedSeverity = knownSeverities.includes(
        severity as SeverityLevel,
    )
        ? (severity as SeverityLevel)
        : SeverityLevel.LOW;

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
