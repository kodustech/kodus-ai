import React from "react";
import { Badge } from "@components/ui/badge";
import {
    AlertTriangle,
    Bug,
    LucideIcon,
    Network,
    Shield,
    Tag,
    Target,
    Zap,
} from "lucide-react";
import { cn } from "src/core/utils/components";

export const categoryClassnames = {
    security:
        "bg-danger/10 text-danger ring-danger/64 [--button-foreground:var(--color-danger)]",
    breaking_changes:
        "bg-danger/10 text-danger ring-danger/64 [--button-foreground:var(--color-danger)]",
    bug: "bg-warning/10 text-warning ring-warning/64 [--button-foreground:var(--color-warning)]",
    performance:
        "bg-alert/10 text-alert ring-alert/64 [--button-foreground:var(--color-alert)]",
    kody_rules:
        "bg-info/10 text-info ring-info/64 [--button-foreground:var(--color-info)]",
    cross_file:
        "bg-info/10 text-info ring-info/64 [--button-foreground:var(--color-info)]",
    duplicate_logic:
        "bg-info/10 text-info ring-info/64 [--button-foreground:var(--color-info)]",
    default:
        "bg-gray-100 text-gray-600 ring-gray-200 dark:bg-gray-800 dark:text-gray-400 dark:ring-gray-700",
};
export type IssueCategory = keyof typeof categoryClassnames;

const categoryIcons: Record<IssueCategory, LucideIcon> = {
    security: Shield,
    bug: Bug,
    performance: Zap,
    kody_rules: Target,
    breaking_changes: AlertTriangle,
    cross_file: Network,
    duplicate_logic: Network,
    default: Tag,
};

const categoryDisplayNames: Record<IssueCategory, string> = {
    security: "Security",
    bug: "Bug",
    performance: "Performance",
    kody_rules: "Kody Rule",
    breaking_changes: "Breaking Change",
    cross_file: "Cross-File",
    duplicate_logic: "Duplicate Logic",
    default: "Suggestion",
};

export const SuggestionCategoryBadge = ({
    category,
    showIcon = true,
    className,
}: {
    category: string;
    showIcon?: boolean;
    className?: string;
}) => {
    const categoryKey =
        category in categoryClassnames
            ? (category as IssueCategory)
            : "default";

    const Icon = categoryIcons[categoryKey];

    const displayName =
        categoryKey !== "default"
            ? categoryDisplayNames[categoryKey]
            : category
                  .replace(/_/g, " ")
                  .replace(/\b\w/g, (l) => l.toUpperCase());

    const baseStyle =
        "pointer-events-none h-6 min-h-auto rounded-lg text-[10px] leading-px uppercase ring-1 flex items-center gap-1";

    return (
        <Badge
            className={cn(
                baseStyle,
                showIcon ? "pr-2 pl-1.5" : "px-2",
                className,
                categoryClassnames[categoryKey],
            )}>
            {showIcon && <Icon className="h-3 w-3" />}
            <span>{displayName}</span>
        </Badge>
    );
};
