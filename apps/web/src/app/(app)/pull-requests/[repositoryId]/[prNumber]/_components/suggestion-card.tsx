"use client";

import { lazy, Suspense, useState } from "react";
import { IssueSeverityLevelBadge } from "@components/system/issue-severity-level-badge";
import { SuggestionCategoryBadge } from "@components/system/suggestion-category-badge";
import { Markdown } from "@components/ui/markdown";
import type { PullRequestSuggestion } from "@services/pull-requests";
import {
    ChevronDownIcon,
    ChevronRightIcon,
    ColumnsIcon,
    FileIcon,
    RowsIcon,
} from "lucide-react";
import { cn } from "src/core/utils/components";

const PierreDiff = lazy(() => import("./pierre-diff"));

interface SuggestionCardProps {
    suggestion: PullRequestSuggestion;
    compact?: boolean;
    defaultExpanded?: boolean;
}

export function SuggestionCard({
    suggestion,
    compact = false,
    defaultExpanded = false,
}: SuggestionCardProps) {
    const [expanded, setExpanded] = useState(defaultExpanded);
    const [diffStyle, setDiffStyle] = useState<"split" | "unified">("split");

    return (
        <div className="border-card-lv2 bg-card-lv1 overflow-hidden rounded-lg border transition-colors">
            {/* Header */}
            <button
                onClick={() => setExpanded(!expanded)}
                className="hover:bg-card-lv2/30 flex w-full items-start gap-3 p-3 px-4 text-left transition-colors">
                <div className="mt-0.5">
                    {expanded ? (
                        <ChevronDownIcon className="text-text-tertiary size-4" />
                    ) : (
                        <ChevronRightIcon className="text-text-tertiary size-4" />
                    )}
                </div>

                <div className="flex min-w-0 flex-1 flex-col gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                        {suggestion.label && (
                            <SuggestionCategoryBadge
                                category={suggestion.label}
                            />
                        )}
                        {suggestion.severity && (
                            <IssueSeverityLevelBadge
                                severity={suggestion.severity as any}
                            />
                        )}
                    </div>
                    <p className="text-text-primary text-sm leading-relaxed">
                        {suggestion.oneSentenceSummary}
                    </p>

                    {!compact && suggestion.filePath && (
                        <div className="text-text-tertiary flex items-center gap-1.5 text-xs">
                            <FileIcon className="size-3" />
                            <span className="font-mono">
                                {suggestion.filePath}
                            </span>
                            {suggestion.relevantLinesStart != null && (
                                <span className="text-text-tertiary/60">
                                    L{suggestion.relevantLinesStart}
                                    {suggestion.relevantLinesEnd != null &&
                                        suggestion.relevantLinesEnd !==
                                            suggestion.relevantLinesStart &&
                                        `–${suggestion.relevantLinesEnd}`}
                                </span>
                            )}
                        </div>
                    )}
                </div>
            </button>

            {/* Expanded content */}
            {expanded && (
                <div className="border-card-lv2 border-t">
                    {suggestion.suggestionContent && (
                        <div className="border-card-lv2 border-b p-4">
                            <Markdown>{suggestion.suggestionContent}</Markdown>
                        </div>
                    )}

                    {(suggestion.existingCode || suggestion.improvedCode) && (
                        <div className="bg-card-lv2/30">
                            {/* Diff controls */}
                            <div className="flex items-center justify-end gap-1 px-3 pt-2">
                                <button
                                    onClick={() => setDiffStyle("split")}
                                    className={cn(
                                        "rounded p-1 transition-colors",
                                        diffStyle === "split"
                                            ? "bg-card-lv3 text-text-primary"
                                            : "text-text-tertiary hover:text-text-secondary",
                                    )}
                                    title="Split view">
                                    <ColumnsIcon className="size-3.5" />
                                </button>
                                <button
                                    onClick={() => setDiffStyle("unified")}
                                    className={cn(
                                        "rounded p-1 transition-colors",
                                        diffStyle === "unified"
                                            ? "bg-card-lv3 text-text-primary"
                                            : "text-text-tertiary hover:text-text-secondary",
                                    )}
                                    title="Unified view">
                                    <RowsIcon className="size-3.5" />
                                </button>
                            </div>

                            <Suspense
                                fallback={
                                    <div className="flex items-center justify-center py-8">
                                        <div className="border-text-tertiary/30 border-t-text-tertiary size-4 animate-spin rounded-full border-2" />
                                    </div>
                                }>
                                <PierreDiff
                                    oldCode={suggestion.existingCode ?? ""}
                                    newCode={suggestion.improvedCode ?? ""}
                                    fileName={suggestion.filePath ?? "file"}
                                    diffStyle={diffStyle}
                                />
                            </Suspense>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
