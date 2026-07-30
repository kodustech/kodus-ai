"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { PullRequestFile } from "@services/pull-requests";
import { ColumnsIcon, FileIcon, RowsIcon } from "lucide-react";
import { cn } from "src/core/utils/components";

import { useReviewStore } from "./review-store";
import { adaptForTryDiffViewer, buildPrInfo } from "./try-port/adapt";
import { DiffViewer as TryDiffViewer } from "./try-port/DiffViewer";

interface DiffViewerProps {
    patchFiles?: PullRequestFile[];
    patchesLoading?: boolean;
    patchesError?: Error | null;
    prNumber?: number;
    prUrl?: string;
    repositoryName?: string;
    highlightIssueId?: string;
}

export function DiffViewer({
    patchFiles,
    patchesLoading,
    patchesError,
    prNumber,
    prUrl,
    repositoryName,
    highlightIssueId,
}: DiffViewerProps) {
    const { state, dispatch, fileGroups, filePaths } = useReviewStore();
    const [diffStyle, setDiffStyle] = useState<"split" | "unified">("unified");

    // "Viewed" is shared with the file tree via the store; "collapsed" is
    // purely a diff-pane affordance, so it stays local.
    const viewed = state.viewedFiles;
    const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

    // Stable identities so the memoized FileBlocks below don't all re-render
    // (and re-tokenize their diffs) every time this wrapper re-renders — e.g.
    // on each jump-to-issue. dispatch/setCollapsed are stable across renders.
    const handleToggleViewed = useCallback(
        (path: string, v: boolean) =>
            dispatch({ type: "SET_VIEWED", path, viewed: v }),
        [dispatch],
    );
    const handleToggleCollapsed = useCallback(
        (path: string) =>
            setCollapsed((prev) => ({ ...prev, [path]: !prev[path] })),
        [],
    );

    // Flatten every file's suggestions into one list, honoring the existing
    // severity/category filters from the store so the summary-panel filters
    // still drive what the center pane shows.
    const allSuggestions = useMemo(() => {
        const out: ReturnType<typeof fileGroups.get> = [];
        for (const list of fileGroups.values()) {
            for (const s of list ?? []) {
                if (
                    state.severityFilter &&
                    s.severity?.toLowerCase() !==
                        state.severityFilter.toLowerCase()
                )
                    continue;
                if (
                    state.categoryFilter &&
                    s.label?.toLowerCase() !==
                        state.categoryFilter.toLowerCase()
                )
                    continue;
                out!.push(s);
            }
        }
        return out ?? [];
    }, [fileGroups, state.severityFilter, state.categoryFilter]);

    const { files, rawDiff, issues } = useMemo(
        () =>
            adaptForTryDiffViewer({
                patchFiles: patchFiles ?? [],
                suggestions: allSuggestions,
            }),
        [patchFiles, allSuggestions],
    );

    const pr = useMemo(
        () =>
            prNumber != null
                ? buildPrInfo({ prNumber, prUrl, repositoryName })
                : undefined,
        [prNumber, prUrl, repositoryName],
    );

    // When the store's selected file changes (file-tree click / j-k nav),
    // scroll that file's block into view. The whole page scrolls (try
    // model), so target the file anchor by id rather than a local ref.
    useEffect(() => {
        if (!state.selectedFilePath) return;
        const el = document.getElementById(
            `file-${state.selectedFilePath}`,
        );
        el?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, [state.selectedFilePath]);

    if (filePaths.length === 0 && (!patchFiles || patchFiles.length === 0)) {
        return (
            <div className="flex h-full items-center justify-center">
                <div className="text-center">
                    <FileIcon className="text-text-tertiary/40 mx-auto mb-3 size-10" />
                    <p className="text-text-tertiary text-sm">
                        No changed files found for this pull request.
                    </p>
                </div>
            </div>
        );
    }

    return (
        <div>
            {/* Slim toolbar — split / unified toggle */}
            <div className="mb-3 flex items-center justify-end gap-1">
                <button
                    onClick={() => setDiffStyle("split")}
                    className={cn(
                        "rounded p-1.5 transition-colors",
                        diffStyle === "split"
                            ? "bg-[var(--bg-input)] text-[var(--text)]"
                            : "text-[var(--text-dim)] hover:text-[var(--text)]",
                    )}
                    title="Split view">
                    <ColumnsIcon className="size-3.5" />
                </button>
                <button
                    onClick={() => setDiffStyle("unified")}
                    className={cn(
                        "rounded p-1.5 transition-colors",
                        diffStyle === "unified"
                            ? "bg-[var(--bg-input)] text-[var(--text)]"
                            : "text-[var(--text-dim)] hover:text-[var(--text)]",
                    )}
                    title="Unified view">
                    <RowsIcon className="size-3.5" />
                </button>
            </div>

            <div>
                {files.length > 0 ? (
                    <TryDiffViewer
                        files={files}
                        issues={issues}
                        rawDiff={rawDiff}
                        pr={pr}
                        diffStyle={diffStyle}
                        viewed={viewed}
                        onToggleViewed={handleToggleViewed}
                        collapsed={collapsed}
                        onToggleCollapsed={handleToggleCollapsed}
                        isReviewing={patchesLoading}
                        highlightIssueId={highlightIssueId}
                    />
                ) : patchesLoading ? (
                    <div className="flex items-center justify-center py-12">
                        <div className="flex flex-col items-center gap-2">
                            <div className="border-text-tertiary/30 border-t-text-tertiary size-5 animate-spin rounded-full border-2" />
                            <span className="text-text-tertiary text-xs">
                                Loading diff...
                            </span>
                        </div>
                    </div>
                ) : patchesError ? (
                    <div className="flex items-center justify-center py-8">
                        <div className="text-center">
                            <p className="text-xs text-red-400">
                                Failed to load file diff
                            </p>
                            <p className="text-text-tertiary mt-1 text-[10px]">
                                {patchesError.message}
                            </p>
                        </div>
                    </div>
                ) : (
                    <div className="text-text-tertiary py-12 text-center text-sm">
                        No diff available for this pull request.
                    </div>
                )}
            </div>
        </div>
    );
}
