"use client";

import { useMemo } from "react";
import { IssueSeverityLevelBadge } from "@components/system/issue-severity-level-badge";
import { SuggestionCategoryBadge } from "@components/system/suggestion-category-badge";
import type { PullRequestSuggestion } from "@services/pull-requests";
import { cn } from "src/core/utils/components";

import { useReviewStore } from "./review-store";
import { SuggestionCard } from "./suggestion-card";

interface SummaryPanelProps {
    fileSuggestions: PullRequestSuggestion[];
    prLevelSuggestions: PullRequestSuggestion[];
    prTitle?: string;
    prNumber?: number;
    repositoryName?: string;
}

export function SummaryPanel({
    fileSuggestions,
    prLevelSuggestions,
    prTitle,
    prNumber,
    repositoryName,
}: SummaryPanelProps) {
    const { state, dispatch } = useReviewStore();

    const severityCounts = useMemo(() => {
        const counts: Record<string, number> = {};
        for (const s of fileSuggestions) {
            const sev = s.severity?.toLowerCase() ?? "unknown";
            counts[sev] = (counts[sev] ?? 0) + 1;
        }
        return counts;
    }, [fileSuggestions]);

    const categoryCounts = useMemo(() => {
        const counts: Record<string, number> = {};
        for (const s of fileSuggestions) {
            const cat = s.label?.toLowerCase() ?? "other";
            counts[cat] = (counts[cat] ?? 0) + 1;
        }
        return counts;
    }, [fileSuggestions]);

    const totalSuggestions = fileSuggestions.length + prLevelSuggestions.length;

    return (
        <div className="flex h-full flex-col">
            <div className="border-card-lv2 border-b px-4 py-3">
                <h3 className="text-text-tertiary text-xs font-semibold tracking-wider uppercase">
                    Summary
                </h3>
            </div>

            <div className="flex-1 overflow-y-auto">
                {/* Stats */}
                <div className="border-card-lv2 space-y-4 border-b p-4">
                    {prTitle && (
                        <div>
                            <p className="text-text-primary text-sm leading-snug font-medium">
                                {prTitle}
                            </p>
                            {repositoryName && (
                                <p className="text-text-tertiary mt-1 text-xs">
                                    {repositoryName}
                                    {prNumber && ` #${prNumber}`}
                                </p>
                            )}
                        </div>
                    )}

                    <div className="flex items-baseline gap-2">
                        <span className="text-text-primary text-2xl font-bold tabular-nums">
                            {totalSuggestions}
                        </span>
                        <span className="text-text-tertiary text-sm">
                            suggestion{totalSuggestions !== 1 ? "s" : ""}
                        </span>
                    </div>

                    {/* Severity breakdown */}
                    {Object.keys(severityCounts).length > 0 && (
                        <div className="space-y-2">
                            <p className="text-text-tertiary text-xs font-medium tracking-wider uppercase">
                                By Severity
                            </p>
                            <div className="flex flex-wrap gap-2">
                                {Object.entries(severityCounts)
                                    .sort(
                                        ([a], [b]) =>
                                            severityOrder(a) - severityOrder(b),
                                    )
                                    .map(([severity, count]) => (
                                        <button
                                            key={severity}
                                            onClick={() =>
                                                dispatch({
                                                    type: "SET_SEVERITY_FILTER",
                                                    severity:
                                                        state.severityFilter ===
                                                        severity
                                                            ? null
                                                            : severity,
                                                })
                                            }
                                            className={cn(
                                                "flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs transition-all",
                                                state.severityFilter ===
                                                    severity
                                                    ? "ring-brand-purple/50 ring-2"
                                                    : "opacity-80 hover:opacity-100",
                                            )}>
                                            <IssueSeverityLevelBadge
                                                severity={severity as any}
                                            />
                                            <span className="text-text-secondary font-medium tabular-nums">
                                                {count}
                                            </span>
                                        </button>
                                    ))}
                            </div>
                        </div>
                    )}

                    {/* Category breakdown */}
                    {Object.keys(categoryCounts).length > 0 && (
                        <div className="space-y-2">
                            <p className="text-text-tertiary text-xs font-medium tracking-wider uppercase">
                                By Category
                            </p>
                            <div className="flex flex-wrap gap-2">
                                {Object.entries(categoryCounts).map(
                                    ([category, count]) => (
                                        <button
                                            key={category}
                                            onClick={() =>
                                                dispatch({
                                                    type: "SET_CATEGORY_FILTER",
                                                    category:
                                                        state.categoryFilter ===
                                                        category
                                                            ? null
                                                            : category,
                                                })
                                            }
                                            className={cn(
                                                "flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs transition-all",
                                                state.categoryFilter ===
                                                    category
                                                    ? "ring-brand-purple/50 ring-2"
                                                    : "opacity-80 hover:opacity-100",
                                            )}>
                                            <SuggestionCategoryBadge
                                                category={category}
                                            />
                                            <span className="text-text-secondary font-medium tabular-nums">
                                                {count}
                                            </span>
                                        </button>
                                    ),
                                )}
                            </div>
                        </div>
                    )}

                    {(state.severityFilter || state.categoryFilter) && (
                        <button
                            onClick={() => {
                                dispatch({
                                    type: "SET_SEVERITY_FILTER",
                                    severity: null,
                                });
                                dispatch({
                                    type: "SET_CATEGORY_FILTER",
                                    category: null,
                                });
                            }}
                            className="text-brand-purple text-xs hover:underline">
                            Clear filters
                        </button>
                    )}
                </div>

                {/* PR-level suggestions */}
                {prLevelSuggestions.length > 0 && (
                    <div className="p-4">
                        <p className="text-text-tertiary mb-3 text-xs font-semibold tracking-wider uppercase">
                            PR-Level Suggestions
                        </p>
                        <div className="space-y-3">
                            {prLevelSuggestions.map((s, idx) => (
                                <SuggestionCard
                                    key={s.id ?? idx}
                                    suggestion={s}
                                />
                            ))}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}

function severityOrder(severity: string): number {
    const order: Record<string, number> = {
        critical: 0,
        high: 1,
        medium: 2,
        low: 3,
    };
    return order[severity] ?? 4;
}
