import {
    handlePatchDeletions,
    convertToHunksWithLinesNumbers,
    convertToUnifiedDiffWithLineNumbers,
    extractLinesFromDiffHunk,
    extractLinesFromUnifiedDiff,
} from './patch';

describe('patch utils (mutation-killing)', () => {
    describe('handlePatchDeletions', () => {
        it('returns null when patch is empty AND editType is neither modified nor added', () => {
            // guard: !patch && editType !== 'modified' && editType !== 'added'
            expect(handlePatchDeletions('', 'file.ts', 'deleted')).toBeNull();
            expect(
                handlePatchDeletions(undefined, 'file.ts', 'deleted'),
            ).toBeNull();
        });

        it('does NOT return null when patch is empty but editType is modified (pins the || guard)', () => {
            // editType === 'modified' flips the guard to the else branch;
            // empty patch -> omitDeletionHunks([''])' -> '' -> equal -> returns original ''
            expect(handlePatchDeletions('', 'file.ts', 'modified')).toBe('');
        });

        it('does NOT return null when patch is empty but editType is added', () => {
            expect(handlePatchDeletions('', 'file.ts', 'added')).toBe('');
        });

        it('strips a hunk that contains only deletions', () => {
            const patch = ['@@ -1,3 +1,2 @@', ' context', '-removed line'].join(
                '\n',
            );
            // no additions -> nothing kept -> empty string
            expect(handlePatchDeletions(patch, 'file.ts', 'deleted')).toBe('');
        });

        it('keeps a hunk with additions unchanged (returns the original patch)', () => {
            const patch = ['@@ -1,1 +1,2 @@', ' a', '+b'].join('\n');
            expect(handlePatchDeletions(patch, 'file.ts', 'modified')).toBe(
                patch,
            );
        });

        it('drops a trailing deletion-only hunk while keeping a preceding addition hunk (exercises the flush/clear branch)', () => {
            const patch = [
                '@@ -1,1 +1,2 @@',
                ' ctx1',
                '+add1',
                '@@ -10,2 +10,1 @@',
                ' ctx2',
                '-del1',
            ].join('\n');
            const expected = ['@@ -1,1 +1,2 @@', ' ctx1', '+add1'].join('\n');
            expect(handlePatchDeletions(patch, 'file.ts', 'modified')).toBe(
                expected,
            );
        });
    });

    describe('convertToHunksWithLinesNumbers', () => {
        it('emits __new hunk__ with new-file line numbers derived from start2 (context + added)', () => {
            const patch = ['@@ -1,2 +1,3 @@', ' ctx', '+added'].join('\n');
            const out = convertToHunksWithLinesNumbers(patch, {
                filename: 'test.ts',
            });
            const expected = [
                "## file: 'test.ts'",
                '',
                '@@ -1,2 +1,3 @@',
                '__new hunk__',
                '1  ctx',
                '2 +added',
            ].join('\n');
            expect(out).toBe(expected);
        });

        it('emits __old hunk__ (without line numbers) and no __new hunk__ when the hunk has only deletions', () => {
            const patch = ['@@ -1,2 +1,1 @@', ' a', '-b'].join('\n');
            const out = convertToHunksWithLinesNumbers(patch, {
                filename: 'd.ts',
            });
            const expected = [
                "## file: 'd.ts'",
                '',
                '@@ -1,2 +1,1 @@',
                '__old hunk__',
                ' a',
                '-b',
            ].join('\n');
            expect(out).toBe(expected);
        });

        it('splits two hunks, emitting both __new hunk__ and __old hunk__ with correct offsets', () => {
            const patch = [
                '@@ -1,2 +1,2 @@',
                ' a',
                '-old1',
                '+new1',
                '@@ -10,1 +10,2 @@',
                ' b',
                '+new2',
            ].join('\n');
            const out = convertToHunksWithLinesNumbers(patch, {
                filename: 'f.ts',
            });
            const expected = [
                "## file: 'f.ts'",
                '',
                '@@ -1,2 +1,2 @@',
                '__new hunk__',
                '1  a',
                '2 +new1',
                '__old hunk__',
                ' a',
                '-old1',
                '',
                '@@ -10,1 +10,2 @@',
                '__new hunk__',
                '10  b',
                '11 +new2',
            ].join('\n');
            expect(out).toBe(expected);
        });

        it('trims the filename and skips "no newline at end of file" markers', () => {
            const patch = [
                '@@ -1,1 +1,2 @@',
                ' a',
                '+b',
                '\\ No newline at end of file',
            ].join('\n');
            const out = convertToHunksWithLinesNumbers(patch, {
                filename: '  spaced.ts  ',
            });
            const expected = [
                "## file: 'spaced.ts'",
                '',
                '@@ -1,1 +1,2 @@',
                '__new hunk__',
                '1  a',
                '2 +b',
            ].join('\n');
            expect(out).toBe(expected);
        });
    });

    describe('convertToUnifiedDiffWithLineNumbers', () => {
        it('returns empty string for falsy patch', () => {
            expect(
                convertToUnifiedDiffWithLineNumbers('', { filename: 'x.ts' }),
            ).toBe('');
        });

        it('numbers context and added lines from the new-file start (match[3]), pads to 6, and leaves removed lines unnumbered', () => {
            const patch = [
                '@@ -5,3 +10,4 @@',
                ' ctx',
                '+add',
                '-del',
                ' ctx2',
            ].join('\n');
            const out = convertToUnifiedDiffWithLineNumbers(patch, {
                filename: 'u.ts',
            });
            const expected = [
                "## file: 'u.ts'",
                '@@ -5,3 +10,4 @@',
                '    10  ctx',
                '    11 +add',
                '       -del',
                '    12  ctx2',
            ].join('\n');
            expect(out).toBe(expected);
        });

        it('skips "no newline at end of file" lines without consuming a line number', () => {
            const patch = [
                '@@ -1,1 +1,2 @@',
                '+a',
                '\\ No newline at end of file',
                '+b',
            ].join('\n');
            const out = convertToUnifiedDiffWithLineNumbers(patch, {
                filename: 'n.ts',
            });
            const expected = [
                "## file: 'n.ts'",
                '@@ -1,1 +1,2 @@',
                '     1 +a',
                '     2 +b',
            ].join('\n');
            expect(out).toBe(expected);
        });
    });

    describe('extractLinesFromDiffHunk', () => {
        it('returns an empty array for empty input', () => {
            expect(extractLinesFromDiffHunk('')).toEqual([]);
        });

        it('groups consecutive added lines and splits on a gap; context closes the range', () => {
            const diff = [
                '@@ -1,5 +10,5 @@',
                '__new hunk__',
                '10  context',
                '11 +added1',
                '12 +added2',
                '14 +added4',
                '__old hunk__',
                ' something',
            ].join('\n');
            expect(extractLinesFromDiffHunk(diff)).toEqual([
                { start: 11, end: 12 },
                { start: 14, end: 14 },
            ]);
        });

        it('closes an open range when a new hunk header is encountered', () => {
            const diff = [
                '@@ -1,1 +5,1 @@',
                '__new hunk__',
                '5 +a',
                '@@ -1,1 +20,1 @@',
                '__new hunk__',
                '20 +b',
            ].join('\n');
            expect(extractLinesFromDiffHunk(diff)).toEqual([
                { start: 5, end: 5 },
                { start: 20, end: 20 },
            ]);
        });

        it('ignores numbered deletion lines (only + counts) and produces no range for a deletion-only hunk', () => {
            const diff = [
                '@@ -1,3 +1,1 @@',
                '__old hunk__',
                '1 -gone1',
                '2 -gone2',
            ].join('\n');
            expect(extractLinesFromDiffHunk(diff)).toEqual([]);
        });
    });

    describe('extractLinesFromUnifiedDiff', () => {
        it('returns an empty array for empty input', () => {
            expect(extractLinesFromUnifiedDiff('')).toEqual([]);
        });

        it('extracts padded added-line ranges, splits on gaps, and ignores context/removed lines', () => {
            const diff = [
                "## file: 'x.ts'",
                '@@ -5,3 +10,4 @@',
                '    10  ctx',
                '    11 +add1',
                '    12 +add2',
                '    14 +add4',
                '       -del',
            ].join('\n');
            expect(extractLinesFromUnifiedDiff(diff)).toEqual([
                { start: 11, end: 12 },
                { start: 14, end: 14 },
            ]);
        });

        it('closes the current range on an empty line', () => {
            const diff = ['    5 +a', '    6 +b', '', '    8 +c'].join('\n');
            expect(extractLinesFromUnifiedDiff(diff)).toEqual([
                { start: 5, end: 6 },
                { start: 8, end: 8 },
            ]);
        });

        it('closes the current range on a header (@@) and on the ## file: banner', () => {
            const diff = [
                "## file: 'x.ts'",
                '    3 +a',
                '@@ -1,1 +9,1 @@',
                '    9 +b',
            ].join('\n');
            expect(extractLinesFromUnifiedDiff(diff)).toEqual([
                { start: 3, end: 3 },
                { start: 9, end: 9 },
            ]);
        });
    });

    describe('round-trip: convertToUnifiedDiffWithLineNumbers -> extractLinesFromUnifiedDiff', () => {
        it('recovers the added-line ranges produced by the converter', () => {
            const patch = [
                '@@ -5,3 +10,4 @@',
                ' ctx',
                '+add1',
                '+add2',
                ' ctx2',
                '+add4',
            ].join('\n');
            const unified = convertToUnifiedDiffWithLineNumbers(patch, {
                filename: 'rt.ts',
            });
            // new-file numbering: ctx=10, add1=11, add2=12, ctx2=13, add4=14
            expect(extractLinesFromUnifiedDiff(unified)).toEqual([
                { start: 11, end: 12 },
                { start: 14, end: 14 },
            ]);
        });
    });
});
