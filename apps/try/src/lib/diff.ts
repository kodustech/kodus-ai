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

const C_ESCAPES: Record<string, number> = {
    a: 7,
    b: 8,
    t: 9,
    n: 10,
    v: 11,
    f: 12,
    r: 13,
    '"': 34,
    "\\": 92,
};

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8");

/** Decode a Git C-quoted path (`"a/caf\303\251.txt"` -> `a/café.txt`). */
function unquoteGitPath(raw: string): string {
    if (!(raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"'))) {
        return raw;
    }

    const body = raw.slice(1, -1);
    const bytes: number[] = [];
    let literalStart = 0;

    for (let i = 0; i < body.length; i++) {
        if (body[i] !== "\\") continue;
        if (i > literalStart) {
            bytes.push(...utf8Encoder.encode(body.slice(literalStart, i)));
        }
        const octal = body.slice(i + 1, i + 4);
        const next = body[i + 1];
        if (/^[0-7]{3}$/.test(octal)) {
            bytes.push(parseInt(octal, 8));
            i += 3;
        } else if (next !== undefined && next in C_ESCAPES) {
            bytes.push(C_ESCAPES[next]);
            i += 1;
        } else {
            bytes.push(92);
        }
        literalStart = i + 1;
    }
    if (body.length > literalStart) {
        bytes.push(...utf8Encoder.encode(body.slice(literalStart)));
    }

    return utf8Decoder.decode(new Uint8Array(bytes));
}

function stripGitPrefix(path: string, prefix: "a/" | "b/"): string {
    return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

function parseDiffGitHeader(
    line: string,
): { oldPath: string | null; newPath: string | null } | null {
    if (!line.startsWith("diff --git ")) return null;
    const rest = line.slice("diff --git ".length);
    if (!rest) return null;

    if (rest.startsWith('"')) {
        const quotedOld = rest.match(/^("(?:[^"\\]|\\.)*") (.+)$/);
        if (quotedOld) {
            return {
                oldPath: stripGitPrefix(unquoteGitPath(quotedOld[1]), "a/"),
                newPath: stripGitPrefix(unquoteGitPath(quotedOld[2]), "b/"),
            };
        }
    }

    const quotedNew = rest.match(/^(.+?) ("b\/(?:[^"\\]|\\.)*")$/);
    if (quotedNew) {
        return {
            oldPath: stripGitPrefix(unquoteGitPath(quotedNew[1]), "a/"),
            newPath: stripGitPrefix(unquoteGitPath(quotedNew[2]), "b/"),
        };
    }

    // Same unquoted path on both sides: "a/P b/P" — split at midpoint so
    // paths containing " b/" are not cut at the wrong boundary.
    const half = (rest.length - 5) / 2;
    if (
        Number.isInteger(half) &&
        half > 0 &&
        rest.startsWith("a/") &&
        rest.slice(2 + half, 5 + half) === " b/" &&
        rest.slice(2, 2 + half) === rest.slice(5 + half)
    ) {
        const path = rest.slice(5 + half);
        return { oldPath: path, newPath: path };
    }

    const unquoted = rest.match(/^a\/(.+?) b\/(.+)$/);
    return unquoted ? { oldPath: unquoted[1], newPath: unquoted[2] } : null;
}

/**
 * Derive the canonical decoded path key for a single `diff --git ...` chunk,
 * matching the `DiffFile.path` identity emitted by `parseUnifiedDiff`.
 */
export function extractDiffPatchPath(chunk: string): string | null {
    const headerEnd = chunk.search(/\r?\n@@/m);
    const head = headerEnd === -1 ? chunk : chunk.slice(0, headerEnd);
    const renameTo = head.match(/^rename to (.+)$/m)?.[1];
    if (renameTo) {
        return unquoteGitPath(renameTo.replace(/\r$/, ""));
    }
    const firstLine = head.split(/\r?\n/, 1)[0] ?? "";
    const parsed = parseDiffGitHeader(firstLine);
    return parsed?.newPath ?? parsed?.oldPath ?? null;
}

const LEGACY_SERVER_HEADER_RE =
    /^diff --git (?:"a\/|a\/).+?"? (?:"b\/|b\/)(.+?)"?$/;

function splitDiffChunks(diffText: string): string[] {
    if (!diffText) return [];
    return diffText
        .split(/(?=^diff --git )/m)
        .filter((chunk) => chunk.startsWith("diff --git "));
}

/**
 * Resolve `groupings[].files` entries to `DiffFile` using the raw `diff --git`
 * headers in `rawDiff` when available, so Git-quoted paths (e.g. `café.txt`)
 * and literal-backslash filenames (e.g. `caf\303\251.txt`) stay distinct.
 */
export function createGroupedFileResolver(
    files: readonly DiffFile[],
    rawDiff?: string,
    groupings?: readonly { files: readonly string[] }[],
): (rawPath: string) => DiffFile | undefined {
    const byCanonical = new Map<string, DiffFile>();
    for (const file of files) {
        byCanonical.set(file.path, file);
    }
    if (!rawDiff) {
        return (rawPath) => byCanonical.get(rawPath);
    }

    const byLegacyHeader = new Map<string, DiffFile>();
    for (const chunk of splitDiffChunks(rawDiff)) {
        const canonicalPath = extractDiffPatchPath(chunk);
        const file = canonicalPath ? byCanonical.get(canonicalPath) : undefined;
        if (!file) continue;
        const firstLine = chunk.split(/\r?\n/, 1)[0] ?? "";
        const legacyKey = firstLine.match(LEGACY_SERVER_HEADER_RE)?.[1];
        if (legacyKey) {
            byLegacyHeader.set(legacyKey, file);
        }
    }

    const preferCanonical =
        groupings?.some((g) =>
            g.files.some((p) => byCanonical.has(p) && !byLegacyHeader.has(p)),
        ) ?? false;

    return (rawPath) =>
        preferCanonical
            ? (byCanonical.get(rawPath) ?? byLegacyHeader.get(rawPath))
            : (byLegacyHeader.get(rawPath) ?? byCanonical.get(rawPath));
}

/**
 * Parse a unified diff (the format GitHub returns with
 * `Accept: application/vnd.github.v3.diff`) into a list of files and hunks
 * with per-line metadata. Just enough to render — not a full git plumbing
 * parser, so binary diffs, copy metadata and submodule entries are
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
            const parsed = parseDiffGitHeader(line);
            const oldPath = parsed?.oldPath ?? null;
            const newPath = parsed?.newPath ?? oldPath ?? "(unknown)";
            current = {
                path: newPath,
                oldPath:
                    oldPath !== null && oldPath !== newPath ? oldPath : null,
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
            if (!currentHunk) {
                if (line.startsWith("rename from ")) {
                    const from = unquoteGitPath(
                        line.slice("rename from ".length),
                    );
                    current.oldPath = from !== current.path ? from : null;
                } else if (line.startsWith("rename to ")) {
                    const to = unquoteGitPath(line.slice("rename to ".length));
                    if (current.oldPath === null && to !== current.path) {
                        current.oldPath = current.path;
                    } else if (current.oldPath === to) {
                        current.oldPath = null;
                    }
                    current.path = to;
                }
            }
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
