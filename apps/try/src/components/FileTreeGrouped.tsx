"use client";

import { useMemo, useState } from "react";
import {
    File as FileIconLucide,
    FolderTree,
    PanelLeftClose,
} from "lucide-react";
import type { DiffFile } from "@/lib/diff";
import type { PrGrouping, ReviewIssue } from "@/lib/api";

/**
 * Devin-Review-style sidebar: groups changed files by LLM-derived
 * intent (e.g. "ToolReference: Struct → Enum") instead of by folder.
 * Each group has a short title and a one-line explanation, with the
 * concrete files listed under it. Click any file → scroll to its diff
 * block in the main column; click "Read explanation" → expand the
 * group's rationale.
 */
export function FileTreeGrouped({
    groupings,
    files,
    issues,
    activePath,
    viewed,
    onPick,
    onHide,
    onToggleMode,
    prRef,
}: {
    groupings: PrGrouping[];
    files: DiffFile[];
    issues: ReviewIssue[];
    activePath: string | null;
    viewed: Record<string, boolean>;
    onPick: (path: string) => void;
    onHide?: () => void;
    onToggleMode?: () => void;
    prRef?: string;
}) {
    const fileByPath = useMemo(() => {
        const m = new Map<string, DiffFile>();
        for (const f of files) m.set(f.path, f);
        return m;
    }, [files]);

    const issueCount = useMemo(() => {
        const m = new Map<string, number>();
        for (const i of issues) {
            if (!i.file) continue;
            m.set(i.file, (m.get(i.file) ?? 0) + 1);
        }
        return m;
    }, [issues]);

    const [expandedExplanations, setExpandedExplanations] = useState<
        Record<number, boolean>
    >(() => ({ 0: true })); // Default-expand the first group

    return (
        <nav
            aria-label="Changed files (grouped)"
            className="rounded-lg border border-[var(--border)] bg-[var(--bg-2)]/70 overflow-hidden"
        >
            <header className="px-3 py-2 border-b border-[var(--border)] bg-[var(--bg)] flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                    {prRef && (
                        <p className="text-xs font-mono text-[var(--text-muted)] truncate">
                            {prRef}
                        </p>
                    )}
                    <p className="text-[10px] uppercase tracking-wider text-[var(--text-dim)] shrink-0">
                        {files.length} file{files.length === 1 ? "" : "s"} ·{" "}
                        {groupings.length} group
                        {groupings.length === 1 ? "" : "s"}
                    </p>
                </div>
                <div className="flex items-center gap-0.5 shrink-0">
                    {onToggleMode && (
                        <HeaderAction
                            label="Switch to tree view"
                            onClick={onToggleMode}
                        >
                            <FolderTree size={13} />
                        </HeaderAction>
                    )}
                    {onHide && (
                        <HeaderAction
                            label="Hide file tree"
                            onClick={onHide}
                        >
                            <PanelLeftClose size={13} />
                        </HeaderAction>
                    )}
                </div>
            </header>

            <ol className="py-1.5">
                {groupings.map((group, idx) => {
                    const open = !!expandedExplanations[idx];
                    return (
                        <li key={idx} className="py-1">
                            <div className="px-3 pt-1.5 pb-1 flex items-start gap-2.5">
                                <span className="shrink-0 mt-px w-5 h-5 rounded bg-[var(--bg-3)] text-[var(--text-muted)] flex items-center justify-center text-[11px] font-mono">
                                    {idx + 1}
                                </span>
                                <div className="min-w-0 flex-1">
                                    <p className="text-[13px] text-[var(--text)] leading-snug font-medium">
                                        {group.title}
                                    </p>
                                    <p className="text-[11px] text-[var(--text-dim)] mt-0.5">
                                        {group.files.length} file
                                        {group.files.length === 1
                                            ? ""
                                            : "s"}
                                    </p>
                                    {open && (
                                        <p className="mt-1.5 text-[12px] text-[var(--text-muted)] leading-relaxed">
                                            {group.explanation}
                                        </p>
                                    )}
                                    <button
                                        type="button"
                                        onClick={() =>
                                            setExpandedExplanations(
                                                (prev) => ({
                                                    ...prev,
                                                    [idx]: !prev[idx],
                                                }),
                                            )
                                        }
                                        className="mt-1.5 text-[11px] text-[var(--accent)] hover:text-[var(--accent-hover)] transition-colors"
                                    >
                                        {open
                                            ? "Hide explanation"
                                            : "Read explanation →"}
                                    </button>
                                </div>
                            </div>
                            <ul className="mt-1">
                                {group.files.map((path) => {
                                    const file = fileByPath.get(path);
                                    if (!file) return null;
                                    const isActive = path === activePath;
                                    const isViewed = !!viewed[path];
                                    const count = issueCount.get(path) ?? 0;
                                    return (
                                        <li key={path}>
                                            <button
                                                onClick={() => onPick(path)}
                                                className={`w-full flex items-center gap-2 pl-10 pr-3 py-1 text-left text-sm transition-colors ${
                                                    isActive
                                                        ? "bg-[var(--bg-input)] text-[var(--text)]"
                                                        : "text-[var(--text-muted)] hover:bg-[var(--bg-input)]/60 hover:text-[var(--text)]"
                                                }`}
                                            >
                                                <FileIconLucide
                                                    size={12}
                                                    className={`shrink-0 ${
                                                        isViewed
                                                            ? "text-[var(--green)]"
                                                            : "text-[var(--text-dim)]"
                                                    }`}
                                                />
                                                <span
                                                    className={`truncate flex-1 font-mono text-[12px] ${
                                                        isViewed
                                                            ? "opacity-60 line-through decoration-[var(--text-dim)]"
                                                            : ""
                                                    }`}
                                                >
                                                    {prettyPath(path)}
                                                </span>
                                                {count > 0 && (
                                                    <span className="shrink-0 text-[10px] font-semibold px-1.5 py-px rounded bg-[var(--yellow)]/15 text-[var(--yellow)]">
                                                        {count}
                                                    </span>
                                                )}
                                                <span className="shrink-0 text-[10.5px] font-mono">
                                                    <span className="text-[var(--green)]">
                                                        +{file.additions}
                                                    </span>{" "}
                                                    <span className="text-[var(--red)]">
                                                        −{file.deletions}
                                                    </span>
                                                </span>
                                            </button>
                                        </li>
                                    );
                                })}
                            </ul>
                        </li>
                    );
                })}
            </ol>
        </nav>
    );
}

function HeaderAction({
    label,
    onClick,
    children,
}: {
    label: string;
    onClick: () => void;
    children: React.ReactNode;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            aria-label={label}
            title={label}
            className="w-6 h-6 rounded text-[var(--text-dim)] hover:text-[var(--text)] hover:bg-[var(--bg-input)] flex items-center justify-center transition-colors"
        >
            {children}
        </button>
    );
}

function prettyPath(path: string): string {
    const parts = path.split("/");
    if (parts.length <= 2) return path;
    return ".../" + parts.slice(-2).join("/");
}
