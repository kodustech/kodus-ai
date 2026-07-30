import type {
    PullRequestExecution,
    PullRequestFile,
    PullRequestSuggestion,
} from "@services/pull-requests";

import {
    adaptForTryDiffViewer,
    buildHeaderPrInfo,
    buildPrInfo,
} from "./adapt";

/**
 * Replica of the DiffViewer's `patchByPath` splitter. The whole diff renders
 * blank if a file's synthesized `diff --git` header can't be matched back to
 * its path, so several tests assert the splitter resolves each file — the
 * exact failure mode the `previous_filename: ""` bug produced.
 */
function splitByPath(rawDiff: string): Map<string, string> {
    const map = new Map<string, string>();
    for (const chunk of rawDiff.split(/^diff --git /m).filter(Boolean)) {
        const full = "diff --git " + chunk;
        const m = full.match(/diff --git a\/(.+) b\/(.+)/);
        if (m?.[2]) map.set(m[2], full);
    }
    return map;
}

const file = (over: Partial<PullRequestFile>): PullRequestFile => ({
    filename: "src/foo.ts",
    status: "modified",
    additions: 1,
    deletions: 0,
    changes: 1,
    patch: "@@ -1,1 +1,1 @@\n-old\n+new",
    ...over,
});

describe("adaptForTryDiffViewer", () => {
    it("synthesizes a matchable header when previous_filename is an empty string (regression: blank diff)", () => {
        const { rawDiff, files } = adaptForTryDiffViewer({
            patchFiles: [file({ filename: "src/foo.ts", previous_filename: "" })],
            suggestions: [],
        });

        expect(rawDiff).toContain("diff --git a/src/foo.ts b/src/foo.ts");
        expect(rawDiff).not.toContain("a/ b/");
        // The splitter must still resolve the file; otherwise it renders blank.
        expect(splitByPath(rawDiff).has("src/foo.ts")).toBe(true);
        expect(files[0].oldPath).toBeNull();
    });

    it("keeps a/old b/new for a real rename", () => {
        const { rawDiff, files } = adaptForTryDiffViewer({
            patchFiles: [
                file({
                    filename: "src/new.ts",
                    previous_filename: "src/old.ts",
                    status: "renamed",
                }),
            ],
            suggestions: [],
        });

        expect(rawDiff).toContain("diff --git a/src/old.ts b/src/new.ts");
        expect(splitByPath(rawDiff).has("src/new.ts")).toBe(true);
        expect(files[0].oldPath).toBe("src/old.ts");
        expect(files[0].status).toBe("renamed");
    });

    it("points the missing side at /dev/null for new and deleted files", () => {
        const added = adaptForTryDiffViewer({
            patchFiles: [
                file({ filename: "a.ts", patch: "@@ -0,0 +1,2 @@\n+a\n+b" }),
            ],
            suggestions: [],
        });
        expect(added.rawDiff).toContain("--- /dev/null");
        expect(added.rawDiff).toContain("+++ b/a.ts");

        const deleted = adaptForTryDiffViewer({
            patchFiles: [
                file({ filename: "b.ts", patch: "@@ -1,2 +0,0 @@\n-a\n-b" }),
            ],
            suggestions: [],
        });
        expect(deleted.rawDiff).toContain("+++ /dev/null");
    });

    it("drops files that carry no patch", () => {
        const { files, rawDiff } = adaptForTryDiffViewer({
            patchFiles: [
                file({ filename: "kept.ts" }),
                file({ filename: "skipped.ts", patch: undefined }),
            ],
            suggestions: [],
        });

        expect(files.map((f) => f.path)).toEqual(["kept.ts"]);
        expect(rawDiff).not.toContain("skipped.ts");
    });

    it("keeps every file independently matchable in a multi-file diff", () => {
        const { rawDiff } = adaptForTryDiffViewer({
            patchFiles: [
                file({ filename: "a/one.ts", previous_filename: "" }),
                file({ filename: "b/two.ts" }),
                file({ filename: "c/three.ts", previous_filename: "c/old.ts" }),
            ],
            suggestions: [],
        });

        const m = splitByPath(rawDiff);
        expect(m.has("a/one.ts")).toBe(true);
        expect(m.has("b/two.ts")).toBe(true);
        expect(m.has("c/three.ts")).toBe(true);
    });

    it("maps suggestions to issues and drops ones without a file", () => {
        const { issues } = adaptForTryDiffViewer({
            patchFiles: [],
            suggestions: [
                {
                    id: "s1",
                    filePath: "src/foo.ts",
                    relevantLinesStart: 10,
                    relevantLinesEnd: 12,
                    severity: "critical",
                    label: "bug",
                    suggestionContent: " do X ",
                    improvedCode: " fixed() ",
                } as PullRequestSuggestion,
                {
                    id: "s2",
                    oneSentenceSummary: "no file -> dropped",
                } as PullRequestSuggestion,
            ],
        });

        expect(issues).toHaveLength(1);
        expect(issues[0]).toMatchObject({
            id: "s1",
            file: "src/foo.ts",
            line: 10,
            endLine: 12,
            severity: "critical",
            category: "bug",
            message: "do X",
            suggestion: "fixed()",
        });
    });

    it("falls back message→summary, suggestion→existingCode, severity→info, line→0", () => {
        const { issues } = adaptForTryDiffViewer({
            patchFiles: [],
            suggestions: [
                {
                    id: "s",
                    filePath: "x.ts",
                    oneSentenceSummary: "summary",
                    existingCode: "old()",
                } as PullRequestSuggestion,
            ],
        });

        expect(issues[0]).toMatchObject({
            message: "summary",
            suggestion: "old()",
            severity: "info",
            line: 0,
        });
    });
});

describe("buildHeaderPrInfo", () => {
    it("splits owner/repo, sums +/-, counts files and maps author/branches", () => {
        const pr = buildHeaderPrInfo({
            execution: {
                repositoryName: "kodustech/kodus-ai",
                title: "Fix things",
                url: "https://github.com/kodustech/kodus-ai/pull/1",
                status: "open",
                merged: false,
                baseBranchRef: "main",
                headBranchRef: "feat/x",
                author: { username: "ana" },
            } as PullRequestExecution,
            patchFiles: [
                file({ additions: 5, deletions: 2 }),
                file({ filename: "y.ts", additions: 3, deletions: 1 }),
            ],
            prNumber: 1,
            commitsCount: 4,
        });

        expect(pr).toMatchObject({
            owner: "kodustech",
            repo: "kodus-ai",
            title: "Fix things",
            additions: 8,
            deletions: 3,
            changedFiles: 2,
            baseRef: "main",
            headRef: "feat/x",
            commitsCount: 4,
            state: "open",
        });
        expect(pr.author).toEqual({ login: "ana" });
    });

    it("flags merged, maps closed state, and falls back the title", () => {
        const merged = buildHeaderPrInfo({
            execution: { status: "merged", merged: true } as PullRequestExecution,
            patchFiles: [],
            prNumber: 7,
        });
        expect(merged.merged).toBe(true);
        expect(merged.title).toBe("Pull request #7");

        const closed = buildHeaderPrInfo({
            execution: {
                status: "closed",
                merged: false,
            } as PullRequestExecution,
            patchFiles: [],
            prNumber: 8,
        });
        expect(closed.state).toBe("closed");
    });
});

describe("buildPrInfo", () => {
    it("returns undefined without a PR url", () => {
        expect(
            buildPrInfo({ prNumber: 1, repositoryName: "a/b" }),
        ).toBeUndefined();
    });

    it("splits owner/repo from the full name", () => {
        expect(
            buildPrInfo({
                prNumber: 1,
                prUrl: "https://x",
                repositoryName: "kodustech/kodus-ai",
            }),
        ).toMatchObject({
            owner: "kodustech",
            repo: "kodus-ai",
            prNumber: 1,
            htmlUrl: "https://x",
        });
    });
});
