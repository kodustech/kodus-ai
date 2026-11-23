import {
    buildCommentFromSuggestion,
    calculateCommentEndLine,
    calculateCommentStartLine,
} from './comment-builder.utils';

/**
 * #2671 — a reversed range lost the finding.
 *
 * Agents emit the pair in either order (`relevantLinesStart: 30` with
 * `relevantLinesEnd: 19` showed up in production). Every provider requires
 * `start_line <= line`, so the inline comment was rejected with a 422 that does
 * not name the offending end, the retry ladder collapsed both ends to a single
 * line, and the finding either landed on the wrong line or fell through to the
 * fallback suggestion. Both numbers are real: only their order is not.
 */

describe('a suggestion whose line range is sent reversed', () => {
    const reversed = {
        relevantLinesStart: 30,
        relevantLinesEnd: 19,
    };

    it('anchors the comment on the low end and keeps the high one as end', () => {
        expect(calculateCommentStartLine(reversed)).toBe(19);
        expect(calculateCommentEndLine(reversed)).toBe(30);
    });

    it('builds a comment a provider accepts (start_line <= line)', () => {
        const comment = buildCommentFromSuggestion(
            { ...reversed, relevantFile: 'src/app.ts' },
            'typescript',
        );

        expect(comment.start_line).toBe(19);
        expect(comment.line).toBe(30);
        expect(comment.start_line!).toBeLessThanOrEqual(comment.line!);
    });

    // The >15-line policy collapses the range onto its first line. Applied to
    // a reversed pair, the old arithmetic compared the high end against the
    // low one, so the span looked "narrow" and both ends were sent as-is:
    // still reversed, so still rejected.
    it('collapses a span wider than 15 lines onto its first line', () => {
        const wide = { relevantLinesStart: 180, relevantLinesEnd: 120 };

        expect(calculateCommentStartLine(wide)).toBeUndefined();
        expect(calculateCommentEndLine(wide)).toBe(120);
    });
});

describe('the ranges that already worked', () => {
    it('keeps a normal multi-line span', () => {
        const span = { relevantLinesStart: 12, relevantLinesEnd: 14 };

        expect(calculateCommentStartLine(span)).toBe(12);
        expect(calculateCommentEndLine(span)).toBe(14);
    });

    it('sends no start_line for a single line', () => {
        const single = { relevantLinesStart: 12, relevantLinesEnd: 12 };

        expect(calculateCommentStartLine(single)).toBeUndefined();
        expect(calculateCommentEndLine(single)).toBe(12);
    });

    it('sends no start_line when only the end is cited', () => {
        const onlyEnd = { relevantLinesEnd: 12 };

        expect(calculateCommentStartLine(onlyEnd)).toBeUndefined();
        expect(calculateCommentEndLine(onlyEnd)).toBe(12);
    });

    it('collapses a span wider than 15 lines onto its first line', () => {
        const wide = { relevantLinesStart: 120, relevantLinesEnd: 180 };

        expect(calculateCommentStartLine(wide)).toBeUndefined();
        expect(calculateCommentEndLine(wide)).toBe(120);
    });
});
