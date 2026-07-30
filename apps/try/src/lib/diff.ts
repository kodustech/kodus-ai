export type DiffLine = {
    type: "add" | "del" | "context" | "hunk";
    text: string;
    /** Line number on the "after" side (null for deletions / hunk headers). */
    newLine: number | null;
    /** Line number on the "before" side (null for additions / hunk headers). */
    oldLine: number | null;
};

export type DiffHunk = {
    header: string;
    lines: DiffLine[];
};

export type DiffFile = {
    path: string;
    oldPath: string | null;
    status: "added" | "deleted" | "renamed" | "modified";
    additions: number;
    deletions: number;
    hunks: DiffHunk[];
};

/**
 * Parse a unified diff (the format GitHub returns with
 * `Accept: application/vnd.github.v3.diff`) into a list of files and hunks
 * with per-line metadata. Just enough to render — not a full git plumbing
 * parser, so binary diffs, copy/rename metadata and submodule entries are
 * tolerated but ignored.
 */
export function parseUnifiedDiff(diffText: string): DiffFile[] {
    if (!diffText) return [];

    const files: DiffFile[] = [];
    let current: DiffFile | null = null;
    let currentHunk: DiffHunk | null = null;
    let newLineCursor = 0;
    let oldLineCursor = 0;

    const lines = diffText.split(/\r?\n/);

    for (const line of lines) {
        if (line.startsWith("diff --git")) {
            // Git wraps paths with spaces / special chars in double
            // quotes: `diff --git "a/file with space" "b/file with space"`.
            // The optional `"a\/` branch (and trailing `"?`) catches that
            // form so those files don't fall through as "(unknown)".
            const match = line.match(
                /diff --git (?:"a\/|a\/)(.+?)"? (?:"b\/|b\/)(.+?)"?$/,
            );
            const oldPath = match?.[1] ?? null;
            const newPath = match?.[2] ?? oldPath ?? "(unknown)";
            current = {
                path: newPath,
                oldPath: oldPath !== newPath ? oldPath : null,
                status: "modified",
                additions: 0,
                deletions: 0,
                hunks: [],
            };
            currentHunk = null;
            files.push(current);
            continue;
        }
        if (!current) continue;

        if (line.startsWith("new file mode")) {
            current.status = "added";
            continue;
        }
        if (line.startsWith("deleted file mode")) {
            current.status = "deleted";
            continue;
        }
        if (line.startsWith("rename from") || line.startsWith("rename to")) {
            current.status = "renamed";
            continue;
        }

        if (line.startsWith("@@")) {
            const match = line.match(
                /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/,
            );
            oldLineCursor = match ? Number(match[1]) : 0;
            newLineCursor = match ? Number(match[2]) : 0;
            currentHunk = { header: line, lines: [] };
            current.hunks.push(currentHunk);
            continue;
        }

        if (!currentHunk) continue;

        // Skip the file header lines, which precede the first @@ inside
        // each "diff --git" block.
        if (line.startsWith("---") || line.startsWith("+++")) continue;

        if (line.startsWith("+")) {
            currentHunk.lines.push({
                type: "add",
                text: line.slice(1),
                newLine: newLineCursor,
                oldLine: null,
            });
            current.additions += 1;
            newLineCursor += 1;
        } else if (line.startsWith("-")) {
            currentHunk.lines.push({
                type: "del",
                text: line.slice(1),
                newLine: null,
                oldLine: oldLineCursor,
            });
            current.deletions += 1;
            oldLineCursor += 1;
        } else if (line.startsWith(" ")) {
            currentHunk.lines.push({
                type: "context",
                text: line.slice(1),
                newLine: newLineCursor,
                oldLine: oldLineCursor,
            });
            newLineCursor += 1;
            oldLineCursor += 1;
        } else if (line.startsWith("\\")) {
            // "\ No newline at end of file" — keep as context so it
            // renders but don't advance counters.
            currentHunk.lines.push({
                type: "context",
                text: line,
                newLine: null,
                oldLine: null,
            });
        }
    }

    return files;
}
