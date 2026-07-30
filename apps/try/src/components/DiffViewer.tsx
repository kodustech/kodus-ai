"use client";

import { useMemo } from "react";
import { PatchDiff } from "@pierre/diffs/react";
import type { DiffFile } from "@/lib/diff";
import type { ReviewIssue, PrInfo } from "@/lib/api";
import { CopyButton } from "./CopyButton";
import { SuggestionCard } from "./SuggestionCard";
import {
    buildLlmPromptForFile,
    type PromptContext,
} from "@/lib/llm-prompt";

export function DiffViewer({
    files,
    issues,
    rawDiff,
    pr,
    viewed,
    onToggleViewed,
    diffStyle = "unified",
    hideHighlights = false,
    collapsed,
    onToggleCollapsed,
    isReviewing = false,
}: {
    files: DiffFile[];
    issues: ReviewIssue[];
    rawDiff: string;
    pr?: PrInfo;
    viewed: Record<string, boolean>;
    onToggleViewed: (path: string, viewed: boolean) => void;
    diffStyle?: "split" | "unified";
    hideHighlights?: boolean;
    collapsed?: Record<string, boolean>;
    onToggleCollapsed?: (path: string) => void;
    /** When the review is still in progress, show shimmer skeletons
     *  in each file's suggestion slot so the user feels Kody working
     *  the file rather than staring at a flat diff. */
    isReviewing?: boolean;
}) {
    const promptCtx: PromptContext = pr
        ? {
              prRef: `${pr.owner}/${pr.repo}#${pr.prNumber}`,
              htmlUrl: pr.htmlUrl,
          }
        : {};

    const patchByPath = useMemo(() => {
        const map = new Map<string, string>();
        const chunks = rawDiff.split(/^diff --git /m).filter(Boolean);
        for (const chunk of chunks) {
            const fullChunk = "diff --git " + chunk;
            const match = fullChunk.match(/diff --git a\/(.+) b\/(.+)/);
            const newPath = match?.[2] ?? null;
            if (newPath) {
                map.set(newPath, fullChunk);
            }
        }
        return map;
    }, [rawDiff]);

    const issuesByFile = useMemo(() => {
        const map = new Map<string, ReviewIssue[]>();
        for (const issue of issues) {
            if (!issue.file) continue;
            const arr = map.get(issue.file) ?? [];
            arr.push(issue);
            map.set(issue.file, arr);
        }
        return map;
    }, [issues]);

    return (
        <div className="space-y-5">
            {files.map((file, idx) => {
                const patch = patchByPath.get(file.path);
                if (!patch) return null;
                return (
                    <FileBlock
                        key={file.path}
                        index={idx + 1}
                        file={file}
                        patch={patch}
                        issues={issuesByFile.get(file.path) ?? []}
                        pr={pr}
                        promptCtx={promptCtx}
                        viewed={!!viewed[file.path]}
                        onToggleViewed={(v) =>
                            onToggleViewed(file.path, v)
                        }
                        diffStyle={diffStyle}
                        hideHighlights={hideHighlights}
                        collapsed={!!collapsed?.[file.path]}
                        onToggleCollapsed={
                            onToggleCollapsed
                                ? () => onToggleCollapsed(file.path)
                                : undefined
                        }
                        isReviewing={isReviewing}
                    />
                );
            })}
        </div>
    );
}

function FileBlock({
    index,
    file,
    patch,
    issues,
    pr,
    promptCtx,
    viewed,
    onToggleViewed,
    diffStyle,
    hideHighlights,
    collapsed,
    onToggleCollapsed,
    isReviewing,
}: {
    index: number;
    file: DiffFile;
    patch: string;
    issues: ReviewIssue[];
    pr?: PrInfo;
    promptCtx: PromptContext;
    viewed: boolean;
    onToggleViewed: (viewed: boolean) => void;
    diffStyle: "split" | "unified";
    hideHighlights: boolean;
    collapsed: boolean;
    onToggleCollapsed?: () => void;
    isReviewing: boolean;
}) {
    return (
        <article
            id={`file-${file.path}`}
            className={`rounded-lg border bg-[var(--bg-elevated)] overflow-hidden transition-opacity ${
                viewed
                    ? "border-[var(--border)] opacity-70"
                    : "border-[var(--border)]"
            }`}
        >
            <header
                className={`flex items-center justify-between gap-4 px-4 py-3 ${
                    collapsed ? "" : "border-b"
                } border-[var(--border)] bg-[var(--bg)]`}
            >
                <div className="flex items-center gap-3 min-w-0">
                    {onToggleCollapsed && (
                        <button
                            onClick={onToggleCollapsed}
                            aria-label={collapsed ? "Expand file" : "Collapse file"}
                            className="shrink-0 w-6 h-6 rounded text-[var(--text-dim)] hover:text-[var(--text)] hover:bg-[var(--bg-input)] flex items-center justify-center transition-colors"
                        >
                            <ChevronToggle open={!collapsed} />
                        </button>
                    )}
                    <span className="shrink-0 w-6 h-6 rounded-full bg-[var(--bg-input)] text-[var(--text-muted)] flex items-center justify-center text-xs font-mono">
                        {index}
                    </span>
                    <div className="min-w-0">
                        <p className="font-mono text-sm text-[var(--text)] truncate">
                            <span className="text-[var(--text-dim)]">
                                {dirOf(file.path)}
                                {dirOf(file.path) ? "/" : ""}
                            </span>
                            <span className="text-[var(--text)]">
                                {baseOf(file.path)}
                            </span>
                        </p>
                        <p className="text-[11px] text-[var(--text-dim)] mt-0.5">
                            <FileStatusBadge status={file.status} />
                        </p>
                    </div>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                    {issues.length > 0 && (
                        <CopyButton
                            size="xs"
                            label={`Copy all (${issues.length})`}
                            getText={() =>
                                buildLlmPromptForFile(
                                    file.path,
                                    issues,
                                    promptCtx,
                                )
                            }
                        />
                    )}
                    <span className="text-xs font-mono text-[var(--green)]">
                        +{file.additions}
                    </span>
                    <span className="text-xs font-mono text-[var(--red)]">
                        −{file.deletions}
                    </span>
                    <ViewedToggle
                        viewed={viewed}
                        onToggleViewed={onToggleViewed}
                    />
                </div>
            </header>

            {!collapsed && (
                <div className="pierre-diff-container overflow-x-auto">
                    <PatchDiff
                        patch={patch}
                        options={{
                            theme: "pierre-dark",
                            diffStyle,
                            overflow: "scroll",
                        }}
                    />
                </div>
            )}

            {/* Suggestion cards live OUTSIDE the Pierre scroll container.
                The annotation slot inside Pierre inherits the diff grid's
                content width (the longest source line, not the visible
                viewport), which made long identifiers bleed off-screen
                and killed our custom highlighting. Rendering them here
                gives every card a normal-flow box that wraps cleanly. */}
            {!collapsed && issues.length > 0 && !hideHighlights && (
                <div className="border-t border-[var(--border)] bg-[var(--bg-2)]/40 p-4 space-y-3">
                    {issues.map((issue, idx) => (
                        <SuggestionCard
                            key={idx}
                            issue={issue}
                            filePath={file.path}
                            pr={pr}
                            promptCtx={promptCtx}
                        />
                    ))}
                </div>
            )}

            {/* While the review is still running, drop a shimmer card
                in the suggestion slot so the file doesn't read "clean"
                prematurely. Goes away the moment real suggestions land
                (or stays empty if Kody decided there's nothing). */}
            {!collapsed && isReviewing && issues.length === 0 && (
                <div className="border-t border-[var(--border)] bg-[var(--bg-2)]/40 p-4">
                    <SuggestionSkeleton />
                </div>
            )}
        </article>
    );
}

function FileStatusBadge({ status }: { status: DiffFile["status"] }) {
    const label =
        status === "added"
            ? "added"
            : status === "deleted"
              ? "deleted"
              : status === "renamed"
                ? "renamed"
                : "modified";
    return (
        <span className="text-[10px] uppercase tracking-wider font-semibold text-[var(--text-dim)]">
            {label}
        </span>
    );
}

function ViewedToggle({
    viewed,
    onToggleViewed,
}: {
    viewed: boolean;
    onToggleViewed: (v: boolean) => void;
}) {
    return (
        <button
            type="button"
            onClick={() => onToggleViewed(!viewed)}
            className={`inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded border transition-colors ${
                viewed
                    ? "text-[var(--green)] border-[var(--green)]/30 bg-[var(--green)]/10"
                    : "text-[var(--text-muted)] border-[var(--border)] hover:text-[var(--text)] hover:border-[var(--border-strong)] hover:bg-[var(--bg-3)]"
            }`}
        >
            <span
                className={`w-3 h-3 rounded-sm border flex items-center justify-center ${
                    viewed
                        ? "bg-[var(--green)] border-[var(--green)] text-[var(--bg)]"
                        : "border-[var(--border-strong)]"
                }`}
                aria-hidden
            >
                {viewed && (
                    <svg
                        width="8"
                        height="8"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="4"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                    >
                        <polyline points="20 6 9 17 4 12" />
                    </svg>
                )}
            </span>
            Viewed
        </button>
    );
}

function SuggestionSkeleton() {
    return (
        <div
            className="rounded-lg border border-[var(--border)] bg-[var(--bg-2)] overflow-hidden"
            aria-hidden
        >
            <div className="flex items-center gap-3 px-4 py-2.5 border-b border-[var(--border)]/60">
                <span className="kodus-skeleton w-3 h-3 rounded-full" />
                <span className="kodus-skeleton h-3 w-28 rounded" />
                <span className="kodus-skeleton h-3 w-14 rounded ml-auto" />
            </div>
            <div className="px-4 py-3 space-y-2">
                <div className="flex items-center gap-2">
                    <span className="kodus-skeleton w-4 h-4 rounded-full" />
                    <span className="kodus-skeleton h-3 w-20 rounded" />
                </div>
                <span className="kodus-skeleton block h-3 w-full rounded" />
                <span className="kodus-skeleton block h-3 w-5/6 rounded" />
                <span className="kodus-skeleton block h-3 w-2/3 rounded" />
            </div>
        </div>
    );
}

function ChevronToggle({ open }: { open: boolean }) {
    return (
        <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={`transition-transform ${open ? "" : "-rotate-90"}`}
            aria-hidden
        >
            <polyline points="6 9 12 15 18 9" />
        </svg>
    );
}

function dirOf(path: string): string {
    const idx = path.lastIndexOf("/");
    return idx === -1 ? "" : path.slice(0, idx);
}

function baseOf(path: string): string {
    const idx = path.lastIndexOf("/");
    return idx === -1 ? path : path.slice(idx + 1);
}
