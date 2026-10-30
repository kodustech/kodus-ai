import {
    convertToUnifiedDiffWithLineNumbers,
    extractLinesFromUnifiedDiff,
} from './patch';

/**
 * Deterministically resolves a review-comment anchor onto an ADDED (`+`) diff line.
 *
 * Context (why this exists):
 * On GitLab, a discussion `position` that lands on an *added* line stores only
 * `new_line` and survives a branch rewrite (rebase/force-push). A position that
 * lands on a *context* (unchanged) line gets both `old_line` and `new_line`
 * filled by GitLab, and that anchor loses its "Resolve thread" control once its
 * diff version is superseded (the docblock/rebase repro from the field report).
 *
 * The AI-provided target line is only a hint — it may point at a context line.
 * This helper validates that hint against the real diff and either keeps it,
 * relocates it onto an added line *within the span the comment already covers*,
 * or reports that the comment cannot be anchored on added code.
 *
 * Model (in-range only — no distance cap, no cross-hunk jump):
 * - The anchor GitLab actually uses as `new_line` is `startLine ?? line`
 *   (see gitlab.service.ts createReviewComment). The covered span is
 *   `[startLine ?? line, line]`.
 * - If the anchor is already an added line → keep it (`snapped: false`),
 *   preserving the original multi-line range.
 * - Else if the covered span contains an added line → snap to the added line
 *   nearest the anchor, collapsing to a single-line anchor (`snapped: true`).
 * - Else → return `null`: the comment is about unchanged code and must not be
 *   posted (the caller discards it as `discarded-by-code-diff`). This mirrors
 *   how GitHub already rejects non-added-line comments.
 */
export interface AddedLineAnchor {
    /** New-side line the comment should be anchored to (an added line). */
    line: number;
    /** Start of a multi-line anchor, when preserved; `undefined` for single-line. */
    startLine?: number;
    /** True when the original target was moved off a context line. */
    snapped: boolean;
}

export function resolveAddedLineAnchor(
    patch: string,
    filename: string,
    target: { startLine?: number; line: number },
): AddedLineAnchor | null {
    const anchor = target.startLine ?? target.line;
    const spanStart = Math.min(anchor, target.line);
    const spanEnd = Math.max(anchor, target.line);

    const addedRanges = extractLinesFromUnifiedDiff(
        convertToUnifiedDiffWithLineNumbers(patch, { filename }),
    );

    const isAdded = (n: number): boolean =>
        addedRanges.some((r) => n >= r.start && n <= r.end);

    // Anchor already lands on an added line — keep it as-is.
    if (isAdded(anchor)) {
        return {
            line: target.line,
            startLine: target.startLine,
            snapped: false,
        };
    }

    // Collect the added lines that fall within the span the comment covers.
    const inSpanAdded: number[] = [];
    for (const range of addedRanges) {
        const from = Math.max(range.start, spanStart);
        const to = Math.min(range.end, spanEnd);
        for (let n = from; n <= to; n++) {
            inSpanAdded.push(n);
        }
    }

    // No added line inside the covered span — the comment targets unchanged
    // code and cannot be safely anchored. Caller discards it.
    if (inSpanAdded.length === 0) {
        return null;
    }

    // Snap to the added line nearest the anchor (ties resolve to the lower line),
    // collapsing to a single-line anchor.
    inSpanAdded.sort(
        (a, b) => Math.abs(a - anchor) - Math.abs(b - anchor) || a - b,
    );

    return { line: inSpanAdded[0], startLine: undefined, snapped: true };
}
