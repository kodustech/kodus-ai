"use client";

import { Badge } from "@components/ui/badge";
import { Button } from "@components/ui/button";
import { X } from "lucide-react";
import {
    EMPTY_LIST_FILTERS,
    hasActiveListFilters,
    type ListFilters,
} from "src/core/utils/kody-rules/apply-filters";
import type { InferredRuleOrigin } from "src/core/utils/kody-rules/infer-origin";

const SEVERITY_LABELS: Record<string, string> = {
    critical: "Critical",
    high: "High",
    medium: "Medium",
    low: "Low",
};

type ActiveFiltersChipsProps = {
    filters: ListFilters;
    onChange: (next: ListFilters) => void;
    entityLabel?: "rules" | "memories";
};

export const ActiveFiltersChips = ({
    filters,
    onChange,
    entityLabel = "rules",
}: ActiveFiltersChipsProps) => {
    const ruleOnly = entityLabel === "rules";

    if (!ruleOnly || !hasActiveListFilters(filters)) { return null; }

    const removeOrigin = (origin: InferredRuleOrigin) => {
        const next = new Set(filters.origins);
        next.delete(origin);
        onChange({ ...filters, origins: next });
    };

    const removeSeverity = (severity: string) => {
        const next = new Set(filters.severities);
        next.delete(severity);
        onChange({ ...filters, severities: next });
    };

    const removeKodySync = () => {
        onChange({ ...filters, kodySync: false });
    };

    const removeSyncErrors = () => {
        onChange({ ...filters, withSyncErrors: false });
    };

    const removePausedOnly = () => {
        onChange({ ...filters, pausedOnly: false });
    };

    const clearAll = () => onChange(EMPTY_LIST_FILTERS);

    return (
        <div className="flex flex-wrap items-center gap-2">
            <span className="text-text-secondary text-xs">Active filters:</span>

            {ruleOnly &&
                Array.from(filters.origins).map((origin) => {
                    const display = origin === "manual" ? "Manual" : origin;
                    return (
                        <Badge
                            key={"origin-" + origin}
                            active
                            size="xs"
                            className="flex items-center gap-1 px-2 py-1">
                            Origin: {display}
                            <button
                                type="button"
                                aria-label={"Remove origin filter " + display}
                                onClick={() => removeOrigin(origin)}
                                className="hover:text-text-primary focus-visible:ring-primary -mr-0.5 ml-1 inline-flex rounded focus:outline-none focus-visible:ring-2">
                                <X className="size-3" aria-hidden />
                            </button>
                        </Badge>
                    );
                })}

            {ruleOnly &&
                Array.from(filters.severities).map((severity) => {
                    const display = SEVERITY_LABELS[severity] ?? severity;
                    return (
                        <Badge
                            key={"severity-" + severity}
                            active
                            size="xs"
                            className="flex items-center gap-1 px-2 py-1">
                            Severity: {display}
                            <button
                                type="button"
                                aria-label={"Remove severity filter " + display}
                                onClick={() => removeSeverity(severity)}
                                className="hover:text-text-primary focus-visible:ring-primary -mr-0.5 ml-1 inline-flex rounded focus:outline-none focus-visible:ring-2">
                                <X className="size-3" aria-hidden />
                            </button>
                        </Badge>
                    );
                })}

            {ruleOnly && filters.kodySync && (
                <Badge
                    active
                    size="xs"
                    className="flex items-center gap-1 px-2 py-1">
                    @kody-sync
                    <button
                        type="button"
                        aria-label="Remove @kody-sync filter"
                        onClick={removeKodySync}
                        className="hover:text-text-primary focus-visible:ring-primary -mr-0.5 ml-1 inline-flex rounded focus:outline-none focus-visible:ring-2">
                        <X className="size-3" aria-hidden />
                    </button>
                </Badge>
            )}

            {ruleOnly && filters.withSyncErrors && (
                <Badge
                    active
                    size="xs"
                    className="flex items-center gap-1 px-2 py-1">
                    Has sync errors
                    <button
                        type="button"
                        aria-label="Remove sync errors filter"
                        onClick={removeSyncErrors}
                        className="hover:text-text-primary focus-visible:ring-primary -mr-0.5 ml-1 inline-flex rounded focus:outline-none focus-visible:ring-2">
                        <X className="size-3" aria-hidden />
                    </button>
                </Badge>
            )}

            {filters.pausedOnly && (
                <Badge
                    active
                    size="xs"
                    className="flex items-center gap-1 px-2 py-1">
                    Paused only
                    <button
                        type="button"
                        aria-label="Remove paused only filter"
                        onClick={removePausedOnly}
                        className="hover:text-text-primary focus-visible:ring-primary -mr-0.5 ml-1 inline-flex rounded focus:outline-none focus-visible:ring-2">
                        <X className="size-3" aria-hidden />
                    </button>
                </Badge>
            )}

            <Button size="xs" variant="cancel" onClick={clearAll}>
                Clear all
            </Button>
        </div>
    );
};
