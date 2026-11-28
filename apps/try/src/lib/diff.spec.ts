import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    createGroupedFileResolver,
    extractDiffPatchPath,
    parseUnifiedDiff,
} from "./diff";

function createGitDiffFixtures(): {
    quotedDiff: string;
    unquotedDiff: string;
} {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kodus-try-diff-"));
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

        write("café.txt", "line1\n");
        write("src/deléted.txt", "gone\n");
        write("plain.txt", "rename me\n");
        write("dir b/plain.txt", "space-b\n");
        write("dir b/café.txt", "space-b-utf8\n");
        git(["add", "."]);
        git(["-c", "commit.gpgsign=false", "commit", "-q", "-m", "initial"]);

        write("café.txt", "line1\nline2\n");
        write("added-café.txt", "new\n");
        fs.unlinkSync(path.join(dir, "src/deléted.txt"));
        fs.renameSync(
            path.join(dir, "plain.txt"),
            path.join(dir, "renamé.txt"),
        );
        write("dir b/plain.txt", "space-b\nmore\n");
        write("dir b/café.txt", "space-b-utf8\nmore\n");
        git(["add", "-A"]);

        const quotedDiff = git([
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
        ]);
        const unquotedDiff = git([
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
        ]);

        return { quotedDiff, unquotedDiff };
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

describe("parseUnifiedDiff with real Git quoted and unquoted diffs", () => {
    const { quotedDiff, unquotedDiff } = createGitDiffFixtures();

    it("produces the same decoded DiffFile metadata for quoted and unquoted diffs", () => {
        expect(quotedDiff).toContain('"a/caf\\303\\251.txt"');
        expect(unquotedDiff).toContain("a/café.txt");

        const quotedFiles = parseUnifiedDiff(quotedDiff);
        const unquotedFiles = parseUnifiedDiff(unquotedDiff);

        expect(quotedFiles).toEqual(unquotedFiles);

        const byPath = new Map(quotedFiles.map((f) => [f.path, f]));

        expect(byPath.get("café.txt")).toMatchObject({
            path: "café.txt",
            oldPath: null,
            status: "modified",
            additions: 1,
            deletions: 0,
        });
        expect(byPath.get("added-café.txt")).toMatchObject({
            path: "added-café.txt",
            oldPath: null,
            status: "added",
            additions: 1,
            deletions: 0,
        });
        expect(byPath.get("src/deléted.txt")).toMatchObject({
            path: "src/deléted.txt",
            oldPath: null,
            status: "deleted",
            additions: 0,
            deletions: 1,
        });
        expect(byPath.get("renamé.txt")).toMatchObject({
            path: "renamé.txt",
            oldPath: "plain.txt",
            status: "renamed",
        });
        expect(byPath.get("dir b/plain.txt")).toMatchObject({
            path: "dir b/plain.txt",
            oldPath: null,
            status: "modified",
        });
        expect(byPath.get("dir b/café.txt")).toMatchObject({
            path: "dir b/café.txt",
            oldPath: null,
            status: "modified",
        });

        const splitChunks = (raw: string) =>
            raw
                .split(/(?=^diff --git )/m)
                .filter((chunk) => chunk.startsWith("diff --git "));

        expect(splitChunks(quotedDiff).map(extractDiffPatchPath)).toEqual(
            quotedFiles.map((f) => f.path),
        );
        expect(splitChunks(unquotedDiff).map(extractDiffPatchPath)).toEqual(
            unquotedFiles.map((f) => f.path),
        );
    });

    it("decodes a quoted-to-unquoted rename and preserves ambiguous unquoted ' b/' renames", () => {
        const diff = [
            'diff --git "a/old caf\\303\\251.txt" b/plain-new.txt',
            "similarity index 100%",
            'rename from "old caf\\303\\251.txt"',
            "rename to plain-new.txt",
            "diff --git a/dir b/old.txt b/dir b/new.txt",
            "similarity index 100%",
            "rename from dir b/old.txt",
            "rename to dir b/new.txt",
        ].join("\n");

        const files = parseUnifiedDiff(diff);
        expect(files).toEqual([
            {
                path: "plain-new.txt",
                oldPath: "old café.txt",
                status: "renamed",
                additions: 0,
                deletions: 0,
                hunks: [],
            },
            {
                path: "dir b/new.txt",
                oldPath: "dir b/old.txt",
                status: "renamed",
                additions: 0,
                deletions: 0,
                hunks: [],
            },
        ]);
    });

    it("handles quoted binary changes without ---/+++ lines and ignores leading preamble", () => {
        const diff = [
            "commit abc123",
            "Author: Test <test@example.com>",
            "",
            'diff --git "a/assets/ic\\303\\264ne.png" "b/assets/ic\\303\\264ne.png"',
            'Binary files "a/assets/ic\\303\\264ne.png" and "b/assets/ic\\303\\264ne.png" differ',
        ].join("\r\n");

        const files = parseUnifiedDiff(diff);
        expect(files).toEqual([
            {
                path: "assets/icône.png",
                oldPath: null,
                status: "modified",
                additions: 0,
                deletions: 0,
                hunks: [],
            },
        ]);

        const chunk = diff
            .split(/(?=^diff --git )/m)
            .find((c) => c.startsWith("diff --git "));
        expect(chunk).toBeDefined();
        expect(extractDiffPatchPath(chunk!)).toBe("assets/icône.png");
    });

    it("decodes Git-quoted double quotes and backslashes without OS-invalid temp files", () => {
        const diff = [
            'diff --git "a/quote\\"name.txt" "b/quote\\"name.txt"',
            "@@ -1 +1,2 @@",
            " q1",
            "+q2",
            'diff --git "a/back\\\\slash.txt" "b/back\\\\slash.txt"',
            "@@ -1 +1,2 @@",
            " b1",
            "+b2",
        ].join("\n");

        const files = parseUnifiedDiff(diff);
        expect(files.map((f) => f.path)).toEqual([
            'quote"name.txt',
            "back\\slash.txt",
        ]);
        const chunks = diff
            .split(/(?=^diff --git )/m)
            .filter((c) => c.startsWith("diff --git "));
        expect(chunks.map(extractDiffPatchPath)).toEqual([
            'quote"name.txt',
            "back\\slash.txt",
        ]);
    });

    it("resolves quoted paths and literal backslash paths independently without positional zip", () => {
        const diff = [
            'diff --git "a/caf\\303\\251.txt" "b/caf\\303\\251.txt"',
            "@@ -1 +1 @@",
            "-a",
            "+b",
            "diff --git ",
            'diff --git "a/caf\\\\303\\\\251.txt" "b/caf\\\\303\\\\251.txt"',
            "@@ -1 +1 @@",
            "-c",
            "+d",
        ].join("\n");
        const files = parseUnifiedDiff(diff);
        const groupings = [
            {
                files: [
                    "missing.txt",
                    "caf\\303\\251.txt",
                    "caf\\\\303\\\\251.txt",
                ],
            },
        ];
        const resolve = createGroupedFileResolver(files, diff, groupings);

        expect(resolve("missing.txt")).toBeUndefined();
        expect(resolve("caf\\303\\251.txt")?.path).toBe("café.txt");
        expect(resolve("caf\\\\303\\\\251.txt")?.path).toBe("caf\\303\\251.txt");

        // Canonical-only subset containing just the ambiguous literal path must
        // resolve to the literal file instead of falling back to byLegacyHeader.
        const resolveCanonicalSubset = createGroupedFileResolver(files, diff, [
            { files: ["caf\\303\\251.txt"] },
        ]);
        expect(resolveCanonicalSubset("caf\\303\\251.txt")?.path).toBe(
            "caf\\303\\251.txt",
        );
    });
});
