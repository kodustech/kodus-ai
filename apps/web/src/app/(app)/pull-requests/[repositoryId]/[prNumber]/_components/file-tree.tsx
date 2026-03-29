"use client";

import { useMemo, useState } from "react";
import {
    ChevronDownIcon,
    ChevronRightIcon,
    FileIcon,
    FolderIcon,
    FolderOpenIcon,
} from "lucide-react";
import { cn } from "src/core/utils/components";

import { useReviewStore } from "./review-store";

interface TreeNode {
    name: string;
    path: string;
    isFile: boolean;
    children: TreeNode[];
    suggestionCount: number;
}

function buildTree(fileGroups: Map<string, number>): TreeNode[] {
    const root: TreeNode[] = [];

    for (const [filePath, count] of fileGroups) {
        const parts = filePath.split("/");
        let currentLevel = root;

        for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            const isFile = i === parts.length - 1;
            const path = parts.slice(0, i + 1).join("/");

            let existing = currentLevel.find((n) => n.name === part);
            if (!existing) {
                existing = {
                    name: part,
                    path,
                    isFile,
                    children: [],
                    suggestionCount: isFile ? count : 0,
                };
                currentLevel.push(existing);
            } else if (!isFile && existing.isFile) {
                // Node was created as file but is now a directory prefix
                existing.isFile = false;
            }
            if (!isFile) {
                existing.suggestionCount += count;
            }
            currentLevel = existing.children;
        }
    }

    return sortTree(root);
}

function sortTree(nodes: TreeNode[]): TreeNode[] {
    return nodes
        .map((n) => ({ ...n, children: sortTree(n.children) }))
        .sort((a, b) => {
            if (a.isFile !== b.isFile) return a.isFile ? 1 : -1;
            return a.name.localeCompare(b.name);
        });
}

function flattenWithCollapse(nodes: TreeNode[]): TreeNode[] {
    const result: TreeNode[] = [];

    function collapse(node: TreeNode): TreeNode {
        if (
            !node.isFile &&
            node.children.length === 1 &&
            !node.children[0].isFile
        ) {
            const child = node.children[0];
            return collapse({
                ...child,
                name: `${node.name}/${child.name}`,
                path: child.path,
            });
        }
        return node;
    }

    for (const node of nodes) {
        result.push(collapse(node));
    }

    return result;
}

function TreeNodeItem({ node, depth }: { node: TreeNode; depth: number }) {
    const { state, dispatch } = useReviewStore();
    const [expanded, setExpanded] = useState(true);
    const isSelected = state.selectedFilePath === node.path;

    const collapsedChildren = useMemo(
        () => flattenWithCollapse(node.children),
        [node.children],
    );

    if (node.isFile) {
        return (
            <button
                onClick={() =>
                    dispatch({ type: "SELECT_FILE", path: node.path })
                }
                className={cn(
                    "group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                    isSelected
                        ? "bg-brand-purple/15 text-text-primary"
                        : "text-text-secondary hover:bg-card-lv3/50 hover:text-text-primary",
                )}
                style={{ paddingLeft: `${depth * 12 + 8}px` }}>
                <FileIcon className="text-text-tertiary size-4 shrink-0" />
                <span className="truncate font-mono text-xs">{node.name}</span>
                {node.suggestionCount > 0 && (
                    <span
                        className={cn(
                            "ml-auto shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium tabular-nums",
                            isSelected
                                ? "bg-brand-purple/20 text-brand-purple"
                                : "bg-card-lv3 text-text-tertiary",
                        )}>
                        {node.suggestionCount}
                    </span>
                )}
            </button>
        );
    }

    return (
        <div>
            <button
                onClick={() => setExpanded(!expanded)}
                className="group text-text-secondary hover:text-text-primary flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors"
                style={{ paddingLeft: `${depth * 12 + 8}px` }}>
                {expanded ? (
                    <ChevronDownIcon className="size-3 shrink-0" />
                ) : (
                    <ChevronRightIcon className="size-3 shrink-0" />
                )}
                {expanded ? (
                    <FolderOpenIcon className="text-text-tertiary size-4 shrink-0" />
                ) : (
                    <FolderIcon className="text-text-tertiary size-4 shrink-0" />
                )}
                <span className="truncate font-mono text-xs">{node.name}</span>
                <span className="text-text-tertiary ml-auto shrink-0 text-[10px] tabular-nums">
                    {node.suggestionCount}
                </span>
            </button>
            {expanded && (
                <div>
                    {collapsedChildren.map((child) => (
                        <TreeNodeItem
                            key={child.path}
                            node={child}
                            depth={depth + 1}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}

export function FileTree() {
    const { fileGroups, filePaths } = useReviewStore();

    const fileCountMap = useMemo(() => {
        const map = new Map<string, number>();
        // All files from filePaths (includes patch files)
        for (const path of filePaths) {
            const suggestions = fileGroups.get(path);
            map.set(path, suggestions?.length ?? 0);
        }
        return map;
    }, [fileGroups, filePaths]);

    const tree = useMemo(() => buildTree(fileCountMap), [fileCountMap]);
    const collapsed = useMemo(() => flattenWithCollapse(tree), [tree]);

    return (
        <div className="flex h-full flex-col">
            <div className="border-card-lv2 flex items-center justify-between border-b px-4 py-3">
                <h3 className="text-text-tertiary text-xs font-semibold tracking-wider uppercase">
                    Files
                </h3>
                <span className="text-text-tertiary text-xs tabular-nums">
                    {filePaths.length}
                </span>
            </div>
            <div className="flex-1 overflow-y-auto p-2">
                {collapsed.map((node) => (
                    <TreeNodeItem key={node.path} node={node} depth={0} />
                ))}
            </div>
        </div>
    );
}
