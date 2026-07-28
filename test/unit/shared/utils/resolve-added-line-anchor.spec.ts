import {
    convertToUnifiedDiffWithLineNumbers,
    extractLinesFromUnifiedDiff,
} from '@/shared/utils/patch';
import {
    resolveAddedLineAnchor,
    AddedLineAnchor,
} from '@/shared/utils/resolve-added-line-anchor';

/**
 * Fixtures reproduce the field report: a docblock region where one line was
 * inserted, so the hunk holds a single added (`+`) line surrounded by context
 * lines. The customer's two Kody notes landed on:
 *   - new_line 1032 (the added line)   → survived rebase (control)
 *   - new_line 1035 (a context line)   → lost its Resolve control (bug)
 * Content is generic; only the diff shape mirrors the real case.
 */

// Added line = 1032. Context lines = 1030, 1031, 1033, 1034, 1035.
const DOCBLOCK_PATCH = `@@ -1030,5 +1030,6 @@ class InvoiceRenderer
      * Render the invoice header.
      *
+     * @param array $meta additional metadata
      * @param int $id
      * @return void
      */`;

// Added lines = 11 and 14 (non-contiguous), context = 10, 12, 13, 15.
const TWO_ADDS_PATCH = `@@ -10,4 +10,6 @@ function build()
   const a = ctx();
+  const b = added();
   const c = ctx();
   const d = ctx();
+  const e = added();
   const f = ctx();`;

// No added lines at all — a pure deletion hunk. Context = 5, 6, 7.
const DELETION_ONLY_PATCH = `@@ -5,4 +5,3 @@ function shrink()
   keepA();
-  removeMe();
   keepC();
   keepD();`;

// Contiguous added lines 21 and 22, context = 20, 23.
const MULTILINE_ADD_PATCH = `@@ -20,2 +20,4 @@ function grow()
   before();
+  addedP();
+  addedQ();
   after();`;

// Two separate hunks in one file. Hunk 1: added line 11 (context 10/12/13).
// Hunk 2 (far away): added line 101 (context 100/102/103).
const TWO_HUNKS_PATCH = `@@ -10,4 +10,5 @@ function alpha()
   const a = ctx();
+  const inserted1 = added();
   const b = ctx();
   const c = ctx();
@@ -100,4 +100,5 @@ function beta()
   const d = ctx();
+  const inserted2 = added();
   const e = ctx();
   const f = ctx();`;

const covers = (ranges: { start: number; end: number }[], line: number) =>
    ranges.some((r) => line >= r.start && line <= r.end);

describe('resolve-added-line-anchor', () => {
    /**
     * PRECONDITION — runs GREEN today. Proves, using only the existing patch
     * utilities, that each fixture really does place the "suspect" target on a
     * context line and the "control" target on an added line. This documents the
     * bug independently of the not-yet-written resolver.
     */
    describe('fixtures reproduce context-vs-added anchors (precondition)', () => {
        it('docblock hunk: 1032 is added, 1035 is context', () => {
            const ranges = extractLinesFromUnifiedDiff(
                convertToUnifiedDiffWithLineNumbers(DOCBLOCK_PATCH, {
                    filename: 'InvoiceRenderer.php',
                }),
            );

            expect(ranges).toEqual([{ start: 1032, end: 1032 }]);
            expect(covers(ranges, 1032)).toBe(true); // control (added)
            expect(covers(ranges, 1035)).toBe(false); // suspect (context)
            expect(covers(ranges, 1030)).toBe(false); // suspect (context)
        });

        it('two-adds hunk: 11 and 14 added, 12/13/15 context', () => {
            const ranges = extractLinesFromUnifiedDiff(
                convertToUnifiedDiffWithLineNumbers(TWO_ADDS_PATCH, {
                    filename: 'build.ts',
                }),
            );

            expect(ranges).toEqual([
                { start: 11, end: 11 },
                { start: 14, end: 14 },
            ]);
            expect(covers(ranges, 12)).toBe(false);
            expect(covers(ranges, 13)).toBe(false);
        });

        it('deletion-only hunk: no added lines exist', () => {
            const ranges = extractLinesFromUnifiedDiff(
                convertToUnifiedDiffWithLineNumbers(DELETION_ONLY_PATCH, {
                    filename: 'shrink.ts',
                }),
            );

            expect(ranges).toEqual([]);
        });

        it('multiline-add hunk: 21 and 22 form a contiguous added range', () => {
            const ranges = extractLinesFromUnifiedDiff(
                convertToUnifiedDiffWithLineNumbers(MULTILINE_ADD_PATCH, {
                    filename: 'grow.ts',
                }),
            );

            expect(ranges).toEqual([{ start: 21, end: 22 }]);
        });

        it('two-hunks patch: added lines 11 and 101 sit in separate hunks', () => {
            const ranges = extractLinesFromUnifiedDiff(
                convertToUnifiedDiffWithLineNumbers(TWO_HUNKS_PATCH, {
                    filename: 'twohunks.ts',
                }),
            );

            expect(ranges).toEqual([
                { start: 11, end: 11 },
                { start: 101, end: 101 },
            ]);
        });
    });

    /**
     * BEHAVIOR — the spec of the fix (in-range only, no distance cap).
     * The anchor GitLab uses is `startLine ?? line`; the covered span is
     * `[startLine ?? line, line]`. Snap only ever lands inside that span;
     * otherwise the comment is discarded.
     * RED until resolveAddedLineAnchor is implemented; GREEN when the fix lands.
     */
    describe('resolveAddedLineAnchor', () => {
        it('leaves a single-line added target untouched (control note stays healthy)', () => {
            const result = resolveAddedLineAnchor(
                DOCBLOCK_PATCH,
                'InvoiceRenderer.php',
                { line: 1032 },
            );

            expect(result).toEqual<AddedLineAnchor>({
                line: 1032,
                startLine: undefined,
                snapped: false,
            });
        });

        it('preserves a multi-line anchor whose start is already an added line', () => {
            // anchor = startLine = 1032 (added) → kept, range preserved,
            // even though the end line 1035 is a context line.
            const result = resolveAddedLineAnchor(
                DOCBLOCK_PATCH,
                'InvoiceRenderer.php',
                { startLine: 1032, line: 1035 },
            );

            expect(result).toEqual<AddedLineAnchor>({
                line: 1035,
                startLine: 1032,
                snapped: false,
            });
        });

        it('preserves a multi-line anchor whose endpoints are both added', () => {
            const result = resolveAddedLineAnchor(
                MULTILINE_ADD_PATCH,
                'grow.ts',
                { startLine: 21, line: 22 },
            );

            expect(result).toEqual<AddedLineAnchor>({
                line: 22,
                startLine: 21,
                snapped: false,
            });
        });

        it('snaps a context-anchored multi-line comment onto the added line inside its span', () => {
            // span [1030,1034] covers the added line 1032; anchor 1030 is context.
            const result = resolveAddedLineAnchor(
                DOCBLOCK_PATCH,
                'InvoiceRenderer.php',
                { startLine: 1030, line: 1034 },
            );

            expect(result).toEqual<AddedLineAnchor>({
                line: 1032,
                startLine: undefined,
                snapped: true,
            });
        });

        it('snaps to the added line nearest the anchor when several sit in the span', () => {
            // span [10,15] covers added lines 11 and 14; anchor 10 → nearest is 11.
            expect(
                resolveAddedLineAnchor(TWO_ADDS_PATCH, 'build.ts', {
                    startLine: 10,
                    line: 15,
                })?.line,
            ).toBe(11);

            // anchor 13 (context), span [13,15] covers only 14 → snaps to 14.
            expect(
                resolveAddedLineAnchor(TWO_ADDS_PATCH, 'build.ts', {
                    startLine: 13,
                    line: 15,
                })?.line,
            ).toBe(14);
        });

        it('discards a single-line context comment whose added line is OUTSIDE its span (the customer note)', () => {
            // 1035 context, span [1035,1035]; the added line 1032 is outside it.
            // GitHub already drops this kind of comment — GitLab now matches.
            const result = resolveAddedLineAnchor(
                DOCBLOCK_PATCH,
                'InvoiceRenderer.php',
                { line: 1035 },
            );

            expect(result).toBeNull();
        });

        it('discards a comment whose span contains no added line at all', () => {
            const result = resolveAddedLineAnchor(
                DELETION_ONLY_PATCH,
                'shrink.ts',
                { startLine: 5, line: 7 },
            );

            expect(result).toBeNull();
        });

        it('snaps within the comment span and never borrows an added line from another hunk', () => {
            // span [10,13] lives in hunk 1 and covers its added line 11.
            // Hunk 2's added line 101 must be ignored entirely.
            const result = resolveAddedLineAnchor(
                TWO_HUNKS_PATCH,
                'twohunks.ts',
                { startLine: 10, line: 13 },
            );

            expect(result).toEqual<AddedLineAnchor>({
                line: 11,
                startLine: undefined,
                snapped: true,
            });
        });

        it('discards rather than jumping to another hunk when the span has no added line', () => {
            // 13 is context; its span [13,13] has no added line. The nearest
            // added lines (11 in this hunk, 101 in the other) are both out of
            // span, so the comment is discarded — never relocated across hunks.
            const result = resolveAddedLineAnchor(
                TWO_HUNKS_PATCH,
                'twohunks.ts',
                { line: 13 },
            );

            expect(result).toBeNull();
        });
    });
});
