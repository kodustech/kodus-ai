"use client";

import {
    memo,
    useEffect,
    useMemo,
    useRef,
    useState,
    type CSSProperties,
} from "react";
import { PatchDiff } from "@pierre/diffs/react";
import { ErrorBoundary } from "react-error-boundary";
import type { DiffFile, PrInfo, PromptContext, ReviewIssue } from "./types";
import { CopyButton } from "./CopyButton";
import { SuggestionCard } from "./SuggestionCard";
import { buildLlmPromptForFile } from "./llm-prompt";

/**
 * Renders a unified-diff patch as colored plain text. Used as the fallback
 * when Pierre's PatchDiff parser rejects a patch — e.g. when the changed
 * code itself contains diff tokens (`@@`, `diff --git`) and the parser
 * miscounts it as multiple patches. Better a readable raw diff than a
 * crashed panel. (Ported from web's pierre-diff.tsx RawPatch.)
 */
function RawPatch({ patch }: { patch: string }) {
    return (
        <pre className="overflow-x-auto p-4 font-mono text-xs leading-relaxed kodus-scroll">
            {patch.split("\n").map((line, i) => {
                const color = line.startsWith("+")
                    ? "text-[#33b8a0]"
                    : line.startsWith("-")
                      ? "text-[var(--red)]"
                      : line.startsWith("@@")
                        ? "text-[var(--info)]"
                        : "text-[var(--text-muted)]";
                return (
                    <div key={i} className={color}>
                        {line || " "}
                    </div>
                );
            })}
        </pre>
    );
}

/**
 * Defers the (expensive) Pierre tokenization of a file's diff until the block
 * nears the viewport. Renders a height-estimated placeholder first so the
 * scrollbar stays stable, then swaps in the real PatchDiff once in view and
 * keeps it mounted. This is what makes large PRs (many files / huge patches)
 * feel light — only the diffs you're looking at get highlighted.
 */
function LazyDiff({
    patch,
    diffStyle,
}: {
    patch: string;
    diffStyle: "split" | "unified";
}) {
    const ref = useRef<HTMLDivElement>(null);
    const [show, setShow] = useState(false);

    const lineCount = useMemo(() => patch.split("\n").length, [patch]);
    // Past this, tokenizing the whole file in one shot janks even on its own,
    // so we don't auto-mount it — the user opts in with a click.
    const isLarge = lineCount > 1500;

    // Stable options identity so PatchDiff doesn't re-tokenize whenever an
    // ancestor re-renders (only diffStyle actually changes the render).
    const patchOptions = useMemo(
        () => ({
            theme: "pierre-dark" as const,
            diffStyle,
            overflow: "scroll" as const,
        }),
        [diffStyle],
    );

    // Rough height guess (~18px/line) so the placeholder reserves space and
    // the page doesn't jump as blocks mount. Capped so giant files don't
    // reserve absurd amounts of empty scroll.
    const estimated = Math.min(1400, Math.max(120, lineCount * 18));

    // Pierre renders in a shadow root; only inherited custom properties reach
    // it. Raise the gutter line-number foreground one step (its default is a
    // dim 65% fg/bg mix that falls under ~3:1) for legibility. The +/- glyph
    // Pierre draws on each changed line stays as the non-color cue.
    const gutterVars = {
        "--diffs-fg-number-override":
            "color-mix(in lab, var(--diffs-fg) 82%, var(--diffs-bg))",
    } as CSSProperties;

    useEffect(() => {
        if (show || isLarge) return;
        const el = ref.current;
        if (!el) return;
        if (typeof IntersectionObserver === "undefined") {
            setShow(true);
            return;
        }
        const io = new IntersectionObserver(
            (entries) => {
                if (entries.some((e) => e.isIntersecting)) {
                    setShow(true);
                    io.disconnect();
                }
            },
            // Pre-mount ~one viewport early so the diff is ready by the time
            // it scrolls into view (no flash of placeholder).
            { rootMargin: "800px 0px" },
        );
        io.observe(el);
        return () => io.disconnect();
    }, [show, isLarge]);

    return (
        <div
            ref={ref}
            className="pierre-diff-container overflow-x-auto"
            style={
                show
                    ? gutterVars
                    : {
                          ...gutterVars,
                          minHeight: isLarge ? undefined : estimated,
                      }
            }>
            {show ? (
                <ErrorBoundary
                    fallback={<RawPatch patch={patch} />}
                    resetKeys={[patch]}>
                    <PatchDiff patch={patch} options={patchOptions} />
                </ErrorBoundary>
            ) : isLarge ? (
                <div className="flex flex-col items-center justify-center gap-2 p-6 text-center">
                    <p className="text-xs text-[var(--text-dim)]">
                        Large diff — {lineCount.toLocaleString()} lines
                    </p>
                    <button
                        type="button"
                        onClick={() => setShow(true)}
                        className="rounded-md border border-[var(--border-strong)] bg-[var(--bg-3)] px-3 py-1.5 text-xs font-medium text-[var(--text)] transition-colors hover:bg-[var(--bg-4)]">
                        Show diff
                    </button>
                </div>
            ) : (
                <div className="space-y-2 p-4" aria-hidden>
                    <span className="kodus-skeleton block h-3 w-2/3 rounded" />
                    <span className="kodus-skeleton block h-3 w-1/2 rounded" />
                    <span className="kodus-skeleton block h-3 w-3/4 rounded" />
                </div>
            )}
        </div>
    );
}

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
    highlightIssueId,
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
    /** Deep-link target — the matching suggestion card pulses + holds an
     *  accent ring. */
    highlightIssueId?: string;
}) {
    const promptCtx: PromptContext = useMemo(
        () =>
            pr
                ? {
                      prRef: `${pr.owner}/${pr.repo}#${pr.prNumber}`,
                      htmlUrl: pr.htmlUrl,
                  }
                : {},
        [pr],
    );

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
        <div className="space-y-5 p-4">
            {files.map((file, idx) => {
                const patch = patchByPath.get(file.path);
                if (!patch) return null;
                const fileIssues = issuesByFile.get(file.path) ?? [];
                // Only the block that actually owns the highlighted finding
                // receives the id — so changing the target re-renders just the
                // old and new owners, not every FileBlock on the page.
                const ownsHighlight =
                    highlightIssueId != null &&
                    fileIssues.some((i) => i.id === highlightIssueId);
                return (
                    <FileBlock
                        key={file.path}
                        index={idx + 1}
                        file={file}
                        patch={patch}
                        issues={fileIssues}
                        pr={pr}
                        promptCtx={promptCtx}
                        viewed={!!viewed[file.path]}
                        onToggleViewed={onToggleViewed}
                        diffStyle={diffStyle}
                        hideHighlights={hideHighlights}
                        collapsed={!!collapsed?.[file.path]}
                        onToggleCollapsed={onToggleCollapsed}
                        isReviewing={isReviewing}
                        highlightIssueId={
                            ownsHighlight ? highlightIssueId : undefined
                        }
                    />
                );
            })}
        </div>
    );
}

const FileBlock = memo(function FileBlock({
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
    highlightIssueId,
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
    onToggleViewed: (path: string, viewed: boolean) => void;
    diffStyle: "split" | "unified";
    hideHighlights: boolean;
    collapsed: boolean;
    onToggleCollapsed?: (path: string) => void;
    isReviewing: boolean;
    highlightIssueId?: string;
}) {
    return (
        <article
            id={`file-${file.path}`}
            className={`rounded-lg border transition-opacity ${
                viewed
                    ? "border-[var(--border)] opacity-70"
                    : "border-[var(--border)]"
            }`}>
            {/* Sticky so the file's identity (path + stats + Viewed) stays
                pinned while you scroll a long diff — the "where am I" the raw
                file list never gives. The article dropped overflow-hidden
                (which would trap the sticky inside its own box). */}
            <header
                className={`sticky top-0 z-20 flex items-center justify-between gap-4 rounded-t-lg px-4 py-3 ${
                    collapsed ? "rounded-b-lg" : "border-b"
                } border-[var(--border)] bg-[var(--bg)]`}>
                <div className="flex items-center gap-3 min-w-0">
                    {onToggleCollapsed && (
                        <button
                            onClick={() => onToggleCollapsed(file.path)}
                            aria-label={
                                collapsed ? "Expand file" : "Collapse file"
                            }
                            className="shrink-0 w-6 h-6 rounded text-[var(--text-dim)] hover:text-[var(--text)] hover:bg-[var(--bg-input)] flex items-center justify-center transition-colors">
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
                    <span className="text-xs font-mono text-[#33b8a0]">
                        +{file.additions}
                    </span>
                    <span className="text-xs font-mono text-[var(--red)]">
                        −{file.deletions}
                    </span>
                    <ViewedToggle
                        viewed={viewed}
                        onToggleViewed={(v) => onToggleViewed(file.path, v)}
                    />
                </div>
            </header>

            {!collapsed && <LazyDiff patch={patch} diffStyle={diffStyle} />}

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
                            highlighted={
                                !!highlightIssueId &&
                                issue.id === highlightIssueId
                            }
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
});

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
            }`}>
            <span
                className={`w-3 h-3 rounded-sm border flex items-center justify-center ${
                    viewed
                        ? "bg-[var(--green)] border-[var(--green)] text-[var(--bg)]"
                        : "border-[var(--border-strong)]"
                }`}
                aria-hidden>
                {viewed && (
                    <svg
                        width="8"
                        height="8"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="4"
                        strokeLinecap="round"
                        strokeLinejoin="round">
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
            aria-hidden>
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
            aria-hidden>
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
