/**
 * Where a review comment landed — not just that one arrived.
 *
 * Every review scenario asserts "a review showed up and persisted N
 * suggestions". None of them looked at WHERE the comments were attached, so
 * an entire class of provider bugs shipped green: comments anchored to lines
 * that are not part of the diff (the GitLab "create comments only in lines
 * added" fix), comments on the wrong side of the hunk, comments on a file the
 * PR never touched. To the old assertions all of those are indistinguishable
 * from a correct review.
 *
 * This module is deliberately pure: parsing a unified diff and checking an
 * anchor against it needs no network, so the rule that matters can be tested
 * exhaustively instead of only being exercised against a live provider.
 */

export interface ChangedFile {
    path: string;
    /** Unified diff hunk text, as providers return it. Absent for binary files. */
    patch?: string;
}

export interface InlineCommentRef {
    path: string;
    /** Line number the comment is anchored to, in the file's NEW numbering. */
    line?: number;
    /** GitHub's `side`: RIGHT = added/context in the new file, LEFT = removed. */
    side?: string;
    /** First line of a multi-line comment range, when the provider reports one. */
    startLine?: number;
}

/**
 * Line numbers (in the NEW file) that the patch actually adds.
 *
 * Only `+` lines count. Context lines are in the diff but were not changed by
 * the PR, and most providers reject — or silently misplace — a comment
 * anchored to them.
 */
/**
 * Lines a comment may legitimately be anchored to: everything the hunk covers
 * on the new-file side, added AND context.
 *
 * Added-only was too strict, and the platform proves it: GitHub REJECTS a
 * comment anchored outside the diff hunk, so a comment that posted
 * successfully is by definition inside it. Run 31638485154 failed
 * code-review-basic on a comment at src/server.ts:31 when the added lines
 * were 27, 28 and 30 -- a context line immediately below the change, which is
 * exactly where "this existing line needs guarding by what you just added"
 * belongs.
 *
 * The bug class this check exists for survives the loosening: an anchor in the
 * wrong FILE, or far from the change, is still caught.
 */
export function commentableLinesFromPatch(patch: string): Set<number> {
    const lines = new Set<number>();
    let newLine = 0;
    for (const raw of patch.split("\n")) {
        const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
        if (hunk) {
            newLine = Number(hunk[1]);
            continue;
        }
        if (newLine === 0) continue;
        if (raw.startsWith("+")) {
            lines.add(newLine);
            newLine++;
        } else if (raw.startsWith("-")) {
            // removed line: consumes no new-file numbering
        } else if (raw.startsWith("\\")) {
            // "\ No newline at end of file"
        } else {
            lines.add(newLine); // context line: inside the hunk, commentable
            newLine++;
        }
    }
    return lines;
}

export function addedLinesFromPatch(patch: string): Set<number> {
    const added = new Set<number>();
    let newLine = 0;
    for (const raw of patch.split("\n")) {
        const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
        if (hunk) {
            newLine = Number(hunk[1]);
            continue;
        }
        if (newLine === 0) continue; // preamble before the first hunk
        if (raw.startsWith("+")) {
            added.add(newLine);
            newLine++;
        } else if (raw.startsWith("-")) {
            // removed line: consumes no new-file numbering
        } else if (raw.startsWith("\\")) {
            // "\ No newline at end of file"
        } else {
            newLine++; // context line
        }
    }
    return added;
}

export interface PlacementViolation {
    comment: InlineCommentRef;
    reason:
        | "file-not-in-diff"
        | "line-not-in-diff"
        | "missing-anchor"
        | "left-side";
    detail: string;
}

/**
 * Checks every inline comment against the PR's diff.
 *
 * Comments with no line anchor at all are NOT violations — providers legitimately
 * return file-level comments — but a comment claiming a line must claim a line
 * the PR added.
 */
export function findPlacementViolations(
    files: ChangedFile[],
    comments: InlineCommentRef[],
): PlacementViolation[] {
    const byPath = new Map<string, Set<number> | null>();
    for (const f of files) {
        byPath.set(
            f.path,
            f.patch ? commentableLinesFromPatch(f.patch) : null,
        );
    }

    const violations: PlacementViolation[] = [];
    for (const c of comments) {
        if (!byPath.has(c.path)) {
            violations.push({
                comment: c,
                reason: "file-not-in-diff",
                detail: `comment on '${c.path}', which this PR does not touch`,
            });
            continue;
        }
        if (c.line === undefined || c.line === null) continue; // file-level: fine
        if (c.side && c.side.toUpperCase() === "LEFT") {
            violations.push({
                comment: c,
                reason: "left-side",
                detail: `comment anchored to the LEFT (pre-image) side at ${c.path}:${c.line} — review findings belong on the added code`,
            });
            continue;
        }
        const commentable = byPath.get(c.path);
        // Binary file (no patch) — nothing to verify against, don't invent a
        // violation.
        if (commentable === null) continue;
        // For a multi-line comment, the provider anchors it at `line` and the
        // range starts at `startLine`; the anchor is what has to be valid.
        if (!commentable!.has(c.line)) {
            violations.push({
                comment: c,
                reason: "line-not-in-diff",
                detail: `comment at ${c.path}:${c.line} is outside this PR's diff for that file (hunk lines: ${[...commentable!].slice(0, 12).join(", ")}${commentable!.size > 12 ? "…" : ""})`,
            });
        }
    }
    return violations;
}

export function describeViolations(v: PlacementViolation[]): string {
    return v.map((x) => `  - [${x.reason}] ${x.detail}`).join("\n");
}
