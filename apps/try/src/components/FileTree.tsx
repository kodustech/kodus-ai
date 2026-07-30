"use client";

import { useMemo, useState } from "react";
import {
    ChevronDown,
    ChevronsDownUp,
    ChevronsUpDown,
    File as FileIconLucide,
    Folder,
    FolderOpen,
    LayoutList,
    PanelLeftClose,
} from "lucide-react";
import type { DiffFile } from "@/lib/diff";
import type { ReviewIssue } from "@/lib/api";

type DirNode = {
    kind: "dir";
    /** Visible label — may be a slash-joined chain when single-child
        directories are collapsed (e.g. "routers/grpc/common"). */
    name: string;
    /** Full path key from the root, used for expand-state. */
    path: string;
    children: TreeNode[];
};

type FileNode = {
    kind: "file";
    file: DiffFile;
    name: string;
};

type TreeNode = DirNode | FileNode;

export function FileTree({
    files,
    issues,
    activePath,
    viewed,
    onPick,
    prRef,
    onHide,
    onToggleMode,
}: {
    files: DiffFile[];
    issues: ReviewIssue[];
    activePath: string | null;
    viewed: Record<string, boolean>;
    onPick: (path: string) => void;
    prRef?: string;
    /** When provided, renders a "hide panel" button in the header. */
    onHide?: () => void;
    /** When provided, renders a Tree↔Grouped toggle in the header. */
    onToggleMode?: () => void;
}) {
    const tree = useMemo(() => buildTree(files), [files]);
    const issueCount = useMemo(() => {
        const m = new Map<string, number>();
        for (const i of issues) {
            if (!i.file) continue;
            m.set(i.file, (m.get(i.file) ?? 0) + 1);
        }
        return m;
    }, [issues]);

    const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
    const toggle = (path: string) =>
        setCollapsed((p) => ({ ...p, [path]: !p[path] }));

    const allDirPaths = useMemo(() => collectDirPaths(tree), [tree]);
    const allCollapsed = useMemo(
        () =>
            allDirPaths.length > 0 &&
            allDirPaths.every((path) => collapsed[path]),
        [allDirPaths, collapsed],
    );
    const collapseAll = () =>
        setCollapsed(Object.fromEntries(allDirPaths.map((p) => [p, true])));
    const expandAll = () => setCollapsed({});

    return (
        <nav
            aria-label="Changed files"
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
                        {files.length} file{files.length === 1 ? "" : "s"}
                    </p>
                </div>
                <div className="flex items-center gap-0.5 shrink-0">
                    {onToggleMode && (
                        <TreeAction
                            label="Switch to grouped view"
                            onClick={onToggleMode}
                        >
                            <LayoutList size={13} />
                        </TreeAction>
                    )}
                    {allDirPaths.length > 0 && (
                        <TreeAction
                            label={
                                allCollapsed ? "Expand all" : "Collapse all"
                            }
                            onClick={
                                allCollapsed ? expandAll : collapseAll
                            }
                        >
                            {allCollapsed ? (
                                <ChevronsUpDown size={13} />
                            ) : (
                                <ChevronsDownUp size={13} />
                            )}
                        </TreeAction>
                    )}
                    {onHide && (
                        <TreeAction
                            label="Hide file tree"
                            onClick={onHide}
                        >
                            <PanelLeftClose size={13} />
                        </TreeAction>
                    )}
                </div>
            </header>
            <div className="py-1.5 text-[13px] select-none">
                {tree.map((node) => (
                    <TreeRow
                        key={nodeKey(node)}
                        node={node}
                        depth={0}
                        activePath={activePath}
                        viewed={viewed}
                        collapsed={collapsed}
                        onToggle={toggle}
                        onPick={onPick}
                        issueCount={issueCount}
                    />
                ))}
            </div>
        </nav>
    );
}

function TreeRow({
    node,
    depth,
    activePath,
    viewed,
    collapsed,
    onToggle,
    onPick,
    issueCount,
}: {
    node: TreeNode;
    depth: number;
    activePath: string | null;
    viewed: Record<string, boolean>;
    collapsed: Record<string, boolean>;
    onToggle: (path: string) => void;
    onPick: (path: string) => void;
    issueCount: Map<string, number>;
}) {
    // 14px per level of indent — matches the chevron rail so siblings
    // line up visually with their parent's caret.
    const indent = depth * 14;

    if (node.kind === "dir") {
        const isOpen = !collapsed[node.path];
        return (
            <div>
                <button
                    onClick={() => onToggle(node.path)}
                    className="w-full flex items-center gap-1.5 px-2.5 py-1 hover:bg-[var(--bg-input)]/60 text-left transition-colors"
                    style={{ paddingLeft: 10 + indent }}
                >
                    <Chevron open={isOpen} />
                    <FolderIcon open={isOpen} />
                    <span className="text-[var(--text-muted)] truncate">
                        {node.name}
                    </span>
                </button>
                {isOpen && (
                    <div>
                        {node.children.map((child) => (
                            <TreeRow
                                key={nodeKey(child)}
                                node={child}
                                depth={depth + 1}
                                activePath={activePath}
                                viewed={viewed}
                                collapsed={collapsed}
                                onToggle={onToggle}
                                onPick={onPick}
                                issueCount={issueCount}
                            />
                        ))}
                    </div>
                )}
            </div>
        );
    }

    const file = node.file;
    const isActive = activePath === file.path;
    const isViewed = !!viewed[file.path];
    const count = issueCount.get(file.path) ?? 0;

    return (
        <button
            onClick={() => onPick(file.path)}
            className={`w-full flex items-center gap-1.5 px-2.5 py-1 text-left transition-colors group ${
                isActive
                    ? "bg-[var(--bg-input)] text-[var(--text)]"
                    : "text-[var(--text-muted)] hover:bg-[var(--bg-input)]/60 hover:text-[var(--text)]"
            }`}
            // Files line up with their parent dir's name (past the
            // chevron + folder-icon column).
            style={{ paddingLeft: 10 + indent + 14 }}
        >
            <FileIcon viewed={isViewed} />
            <span
                className={`truncate flex-1 ${
                    isViewed ? "opacity-60 line-through decoration-[var(--text-dim)]" : ""
                }`}
            >
                {node.name}
            </span>
            {count > 0 && (
                <span className="shrink-0 text-[10px] font-semibold px-1.5 py-px rounded bg-[var(--yellow)]/15 text-[var(--yellow)]">
                    {count}
                </span>
            )}
            <span className="shrink-0 text-[11px] font-mono">
                <span className="text-[var(--green)]">+{file.additions}</span>{" "}
                <span className="text-[var(--red)]">−{file.deletions}</span>
            </span>
        </button>
    );
}

/**
 * Build a directory tree from the flat list of changed files, then
 * collapse any directory that has a single directory child into a
 * "chain" label (e.g. `routers/grpc/common`). Devin Review does this
 * so deep paths don't waste vertical space on empty rungs.
 */
type Mut = {
    name: string;
    path: string;
    children: Map<string, Mut>;
    file?: DiffFile;
};

function buildTree(files: DiffFile[]): TreeNode[] {
    const root: Mut = { name: "", path: "", children: new Map() };

    for (const file of files) {
        const segments = file.path.split("/").filter(Boolean);
        let cursor = root;
        let acc = "";
        for (let i = 0; i < segments.length; i++) {
            const seg = segments[i];
            acc = acc ? `${acc}/${seg}` : seg;
            let next = cursor.children.get(seg);
            if (!next) {
                next = { name: seg, path: acc, children: new Map() };
                cursor.children.set(seg, next);
            }
            if (i === segments.length - 1) {
                next.file = file;
            }
            cursor = next;
        }
    }

    const toNode = (node: Mut): TreeNode => {
        if (node.file && node.children.size === 0) {
            return { kind: "file", file: node.file, name: node.name };
        }
        // Collapse chain: keep folding while we have exactly one child
        // dir (no leaf file at this level either).
        let collapsedName = node.name;
        let collapsedPath = node.path;
        let cur = node;
        while (
            !cur.file &&
            cur.children.size === 1 &&
            firstChild(cur).children.size > 0 &&
            firstChild(cur).file === undefined
        ) {
            cur = firstChild(cur);
            collapsedName = collapsedName
                ? `${collapsedName}/${cur.name}`
                : cur.name;
            collapsedPath = cur.path;
        }
        // After collapse, if we landed on a leaf-only node, treat its
        // single child as a file row but keep the merged label.
        if (
            !cur.file &&
            cur.children.size === 1 &&
            firstChild(cur).file &&
            firstChild(cur).children.size === 0
        ) {
            // Don't merge file name into folder label — keeps the
            // "click to open file" affordance clean.
        }
        return {
            kind: "dir",
            name: collapsedName,
            path: collapsedPath,
            children: Array.from(cur.children.values()).map(toNode),
        };
    };

    const out: TreeNode[] = [];
    for (const child of root.children.values()) {
        out.push(toNode(child));
    }
    return sortNodes(out);
}

function firstChild(node: Mut): Mut {
    return node.children.values().next().value as Mut;
}

function sortNodes(nodes: TreeNode[]): TreeNode[] {
    return [...nodes].sort((a, b) => {
        // Folders first, then alpha. Matches the Devin/VS Code default.
        if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
        return a.name.localeCompare(b.name);
    }).map((n) =>
        n.kind === "dir" ? { ...n, children: sortNodes(n.children) } : n,
    );
}

function nodeKey(n: TreeNode): string {
    return n.kind === "file" ? `f:${n.file.path}` : `d:${n.path}`;
}

function TreeAction({
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

function collectDirPaths(nodes: TreeNode[]): string[] {
    const out: string[] = [];
    const walk = (ns: TreeNode[]) => {
        for (const n of ns) {
            if (n.kind === "dir") {
                out.push(n.path);
                walk(n.children);
            }
        }
    };
    walk(nodes);
    return out;
}

function Chevron({ open }: { open: boolean }) {
    return (
        <ChevronDown
            size={12}
            className={`text-[var(--text-dim)] shrink-0 transition-transform ${
                open ? "" : "-rotate-90"
            }`}
            aria-hidden
        />
    );
}

function FolderIcon({ open }: { open: boolean }) {
    const Icon = open ? FolderOpen : Folder;
    return (
        <Icon
            size={14}
            className="text-[var(--accent)] shrink-0"
            aria-hidden
        />
    );
}

function FileIcon({ viewed }: { viewed: boolean }) {
    return (
        <FileIconLucide
            size={13}
            className={`shrink-0 ${
                viewed ? "text-[var(--green)]" : "text-[var(--text-dim)]"
            }`}
            aria-hidden
        />
    );
}
