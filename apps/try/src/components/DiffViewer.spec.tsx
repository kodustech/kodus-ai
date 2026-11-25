/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ReviewIssue } from "../lib/api";

jest.mock(
    "@pierre/diffs/react",
    () => ({
        PatchDiff: ({ patch }: { patch: string }) => (
            <pre data-testid="patch-diff">{patch}</pre>
        ),
    }),
    { virtual: true },
);
jest.mock(
    "lucide-react",
    () => {
        const Icon = ({ size: _size, ...props }: { size?: number }) => (
            <span aria-hidden {...props} />
        );
        return {
            ChevronDown: Icon,
            ChevronsDownUp: Icon,
            ChevronsUpDown: Icon,
            File: Icon,
            Folder: Icon,
            FolderOpen: Icon,
            FolderTree: Icon,
            LayoutList: Icon,
            PanelLeftClose: Icon,
        };
    },
    { virtual: true },
);

import { parseUnifiedDiff } from "../lib/diff";
import { DiffViewer } from "./DiffViewer";
import { FileTree } from "./FileTree";
import { FileTreeGrouped } from "./FileTreeGrouped";
import { RightSidebar } from "./RightSidebar";

function createRealGitDiffs(): {
    quotedDiff: string;
    unquotedDiff: string;
} {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kodus-try-viewer-"));
    try {
        const git = (args: string[]) =>
            execFileSync("git", args, { cwd: dir, encoding: "utf8" });

        git(["init", "-q"]);
        git(["config", "user.email", "test@example.com"]);
        git(["config", "user.name", "Test"]);
        git(["config", "commit.gpgsign", "false"]);

        const write = (rel: string, content: string) => {
            const full = path.join(dir, rel);
            fs.mkdirSync(path.dirname(full), { recursive: true });
            fs.writeFileSync(full, content, "utf8");
        };

        write("src/app.ts", "export const ok = 1;\n");
        write("src/café.txt", "initial\n");
        write("src/deléted.txt", "bye\n");
        write("plain.txt", "move me\n");
        write("dir b/plain.txt", "space-b\n");
        git(["add", "."]);
        git(["-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"]);

        write("src/app.ts", "export const ok = 2;\n");
        write("src/café.txt", "initial\nupdated\n");
        write("dir b/plain.txt", "space-b\nmore\n");
        fs.unlinkSync(path.join(dir, "src/deléted.txt"));
        fs.renameSync(
            path.join(dir, "plain.txt"),
            path.join(dir, "src/renamé.txt"),
        );
        git(["add", "-A"]);

        return {
            quotedDiff: git([
                "-c",
                "core.quotePath=true",
                "-c",
                "diff.renames=true",
                "-c",
                "diff.noprefix=false",
                "-c",
                "diff.mnemonicPrefix=false",
                "diff",
                "HEAD",
            ]),
            unquotedDiff: git([
                "-c",
                "core.quotePath=false",
                "-c",
                "diff.renames=true",
                "-c",
                "diff.noprefix=false",
                "-c",
                "diff.mnemonicPrefix=false",
                "diff",
                "HEAD",
            ]),
        };
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

describe("DiffViewer + FileTree + RightSidebar path identity", () => {
    const { quotedDiff, unquotedDiff } = createRealGitDiffs();

    const issues: ReviewIssue[] = [
        {
            file: "src/café.txt",
            line: 2,
            severity: "high",
            category: "bug",
            message: "Check café handling",
        },
        {
            file: "src/renamé.txt",
            line: 1,
            severity: "medium",
            category: "style",
            message: "Check renamed file",
        },
    ];

    it.each([
        ["core.quotePath=true (Git-quoted)", quotedDiff],
        ["core.quotePath=false (unquoted)", unquotedDiff],
    ])(
        "renders tree entries, diff panels, status badges, and finding anchors consistently for %s",
        (_label, rawDiff) => {
            const files = parseUnifiedDiff(rawDiff);
            const jumpedPaths: string[] = [];
            const viewedCalls: Array<[string, boolean]> = [];
            const jumpToFile = (filePath: string) => {
                jumpedPaths.push(filePath);
            };

            const { container } = render(
                <div>
                    <FileTree
                        files={files}
                        issues={issues}
                        activePath={null}
                        viewed={{}}
                        onPick={jumpToFile}
                    />
                    <DiffViewer
                        files={files}
                        issues={issues}
                        rawDiff={rawDiff}
                        viewed={{}}
                        onToggleViewed={(p, v) => viewedCalls.push([p, v])}
                    />
                    <RightSidebar
                        issues={issues}
                        isCompleted={true}
                        onJumpToIssue={jumpToFile}
                    />
                </div>,
            );

            // Tree uses decoded path identity and matches issue counts.
            const nav = screen.getByRole("navigation", {
                name: "Changed files",
            });
            const treeCafeBtn = within(nav)
                .getByText("café.txt")
                .closest("button");
            expect(treeCafeBtn).not.toBeNull();
            expect(within(treeCafeBtn!).getByText("1")).toBeInTheDocument();
            expect(within(nav).getByText("café.txt")).toBeInTheDocument();
            expect(within(nav).getByText("renamé.txt")).toBeInTheDocument();
            expect(within(nav).getByText("deléted.txt")).toBeInTheDocument();
            expect(within(nav).getByText("app.ts")).toBeInTheDocument();
            expect(nav.textContent).not.toContain("\\303\\251");

            // DiffViewer renders all panels with matching decoded anchor IDs.
            const expectedPaths = [
                "dir b/plain.txt",
                "src/app.ts",
                "src/café.txt",
                "src/deléted.txt",
                "src/renamé.txt",
            ];
            for (const p of expectedPaths) {
                const article = document.getElementById(`file-${p}`);
                expect(article).not.toBeNull();
                expect(
                    within(article as HTMLElement).getByTestId("patch-diff"),
                ).toBeInTheDocument();
            }

            // Preserve ordinary / deleted / renamed status badges.
            expect(
                within(
                    container.querySelector(
                        'article[id="file-src/café.txt"]',
                    ) as HTMLElement,
                ).getByText("modified"),
            ).toBeInTheDocument();
            expect(
                within(
                    container.querySelector(
                        'article[id="file-src/deléted.txt"]',
                    ) as HTMLElement,
                ).getByText("deleted"),
            ).toBeInTheDocument();
            expect(
                within(
                    container.querySelector(
                        'article[id="file-src/renamé.txt"]',
                    ) as HTMLElement,
                ).getByText("renamed"),
            ).toBeInTheDocument();

            // Findings render inside the matching panel and sidebar jumps resolve to the same anchor.
            const cafeArticle = container.querySelector(
                'article[id="file-src/café.txt"]',
            ) as HTMLElement;
            const renameArticle = container.querySelector(
                'article[id="file-src/renamé.txt"]',
            ) as HTMLElement;
            expect(
                within(cafeArticle).getByText("Check café handling"),
            ).toBeInTheDocument();
            expect(
                within(renameArticle).getByText("Check renamed file"),
            ).toBeInTheDocument();

            const treeRenameBtn = within(nav)
                .getByText("renamé.txt")
                .closest("button");
            expect(treeRenameBtn).not.toBeNull();
            expect(within(treeRenameBtn!).getByText("1")).toBeInTheDocument();

            const sidebar = container.querySelector("aside") as HTMLElement;
            fireEvent.click(treeCafeBtn!);
            fireEvent.click(within(sidebar).getByText("Check café handling"));
            fireEvent.click(treeRenameBtn!);
            fireEvent.click(
                within(cafeArticle).getByRole("button", { name: "Viewed" }),
            );

            expect(jumpedPaths).toEqual([
                "src/café.txt",
                "src/café.txt",
                "src/renamé.txt",
            ]);
            expect(document.getElementById(`file-${jumpedPaths[0]}`)).toBe(
                cafeArticle,
            );
            expect(document.getElementById(`file-${jumpedPaths[2]}`)).toBe(
                renameArticle,
            );
            expect(viewedCalls).toEqual([["src/café.txt", true]]);
        },
    );

    it.each([
        ["core.quotePath=true (Git-quoted)", quotedDiff],
        ["core.quotePath=false (unquoted)", unquotedDiff],
    ])(
        "resolves server grouping paths in FileTreeGrouped to the same decoded identity for %s",
        (_label, rawDiff) => {
            const files = parseUnifiedDiff(rawDiff);
            // Mirrors backend extractChangedFiles() from public-pr-review.use-case.ts
            const serverRegex =
                /^diff --git (?:"a\/|a\/).+?"? (?:"b\/|b\/)(.+?)"?$/gm;
            const serverPaths: string[] = [];
            let match: RegExpExecArray | null;
            while ((match = serverRegex.exec(rawDiff)) !== null) {
                serverPaths.push(match[1]);
            }

            const picked: string[] = [];
            const { container } = render(
                <div>
                    <FileTreeGrouped
                        groupings={[
                            {
                                title: "All changes",
                                explanation: "Server-emitted group paths",
                                files: serverPaths,
                            },
                        ]}
                        files={files}
                        rawDiff={rawDiff}
                        issues={issues}
                        activePath="src/café.txt"
                        viewed={{ "src/café.txt": true }}
                        onPick={(p) => picked.push(p)}
                    />
                    <DiffViewer
                        files={files}
                        issues={issues}
                        rawDiff={rawDiff}
                        viewed={{}}
                        onToggleViewed={() => undefined}
                    />
                </div>,
            );

            const nav = screen.getByRole("navigation", {
                name: "Changed files (grouped)",
            });
            expect(within(nav).getAllByRole("listitem")).toHaveLength(
                files.length + 1,
            );
            expect(nav.textContent).not.toContain("\\303\\251");
            expect(within(nav).getByText("src/café.txt")).toBeInTheDocument();
            expect(within(nav).getByText("src/renamé.txt")).toBeInTheDocument();
            expect(within(nav).getByText("src/deléted.txt")).toBeInTheDocument();
            expect(within(nav).getByText("dir b/plain.txt")).toBeInTheDocument();

            const cafeBtn = within(nav)
                .getByText("src/café.txt")
                .closest("button");
            expect(cafeBtn).not.toBeNull();
            expect(within(cafeBtn!).getByText("1")).toBeInTheDocument();

            fireEvent.click(cafeBtn!);
            fireEvent.click(
                within(nav).getByText("dir b/plain.txt").closest("button")!,
            );

            expect(picked).toEqual(["src/café.txt", "dir b/plain.txt"]);
            expect(document.getElementById("file-src/café.txt")).not.toBeNull();
            expect(
                document.getElementById("file-dir b/plain.txt"),
            ).not.toBeNull();
        },
    );

    it("keeps distinct rows and jump targets when a Git-quoted file and a literal-backslash file coexist", () => {
        const literalBackslashChunk = [
            'diff --git "a/src/caf\\\\303\\\\251.txt" "b/src/caf\\\\303\\\\251.txt"',
            "index 1111111..2222222 100644",
            '--- "a/src/caf\\\\303\\\\251.txt"',
            '+++ "b/src/caf\\\\303\\\\251.txt"',
            "@@ -1 +1,2 @@",
            " literal-backslash",
            "+updated",
        ].join("\n");
        const combinedDiff = `${quotedDiff.trimEnd()}\n${literalBackslashChunk}\n`;
        const files = parseUnifiedDiff(combinedDiff);

        const serverRegex =
            /^diff --git (?:"a\/|a\/).+?"? (?:"b\/|b\/)(.+?)"?$/gm;
        const serverPaths: string[] = [];
        let match: RegExpExecArray | null;
        while ((match = serverRegex.exec(combinedDiff)) !== null) {
            serverPaths.push(match[1]);
        }

        const picked: string[] = [];
        render(
            <div>
                <FileTreeGrouped
                    groupings={[
                        {
                            title: "Collision check",
                            explanation: "Quoted café vs literal backslash",
                            files: serverPaths,
                        },
                    ]}
                    files={files}
                    rawDiff={combinedDiff}
                    issues={issues}
                    activePath={null}
                    viewed={{}}
                    onPick={(p) => picked.push(p)}
                />
                <DiffViewer
                    files={files}
                    issues={issues}
                    rawDiff={combinedDiff}
                    viewed={{}}
                    onToggleViewed={() => undefined}
                />
            </div>,
        );

        const nav = screen.getByRole("navigation", {
            name: "Changed files (grouped)",
        });
        expect(within(nav).getAllByRole("listitem")).toHaveLength(
            files.length + 1,
        );

        const cafeBtn = within(nav).getByText("src/café.txt").closest("button");
        const literalBtn = within(nav)
            .getByText("src/caf\\303\\251.txt")
            .closest("button");
        expect(cafeBtn).not.toBeNull();
        expect(literalBtn).not.toBeNull();

        fireEvent.click(cafeBtn!);
        fireEvent.click(literalBtn!);

        expect(picked).toEqual(["src/café.txt", "src/caf\\303\\251.txt"]);
        const cafeArticle = document.getElementById("file-src/café.txt");
        const literalArticle = document.getElementById(
            "file-src/caf\\303\\251.txt",
        );
        expect(cafeArticle).not.toBeNull();
        expect(literalArticle).not.toBeNull();
        expect(cafeArticle).not.toBe(literalArticle);
    });

    it("keeps distinct rows and jump targets when FileTreeGrouped receives canonical decoded paths", () => {
        const literalBackslashChunk = [
            'diff --git "a/src/caf\\\\303\\\\251.txt" "b/src/caf\\\\303\\\\251.txt"',
            "@@ -1 +1,2 @@",
            " literal-backslash",
            "+updated",
        ].join("\n");
        const combinedDiff = `${quotedDiff.trimEnd()}\n${literalBackslashChunk}\n`;
        const files = parseUnifiedDiff(combinedDiff);
        const picked: string[] = [];
        render(
            <div>
                <FileTreeGrouped
                    groupings={[
                        {
                            title: "Canonical paths",
                            explanation: "Already decoded by server",
                            files: ["src/café.txt", "src/caf\\303\\251.txt"],
                        },
                    ]}
                    files={files}
                    rawDiff={combinedDiff}
                    issues={issues}
                    activePath={null}
                    viewed={{}}
                    onPick={(p) => picked.push(p)}
                />
                <DiffViewer
                    files={files}
                    issues={issues}
                    rawDiff={combinedDiff}
                    viewed={{}}
                    onToggleViewed={() => undefined}
                />
            </div>,
        );

        const nav = screen.getByRole("navigation", {
            name: "Changed files (grouped)",
        });
        fireEvent.click(within(nav).getByText("src/café.txt").closest("button")!);
        fireEvent.click(
            within(nav).getByText("src/caf\\303\\251.txt").closest("button")!,
        );

        expect(picked).toEqual(["src/café.txt", "src/caf\\303\\251.txt"]);
        expect(document.getElementById("file-src/café.txt")).not.toBeNull();
        expect(
            document.getElementById("file-src/caf\\303\\251.txt"),
        ).not.toBeNull();
    });
});
