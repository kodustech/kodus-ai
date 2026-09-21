import { revertPatch } from './revert-patch';

describe('revertPatch', () => {
    it('undoes a modified line', () => {
        const head = ['name: demo', 'version: 2.0.0', 'main: index.js'];
        const patch = [
            '@@ -1,3 +1,3 @@',
            ' name: demo',
            '-version: 1.0.0',
            '+version: 2.0.0',
            ' main: index.js',
        ].join('\n');

        expect(revertPatch(head.join('\n'), patch)).toBe(
            ['name: demo', 'version: 1.0.0', 'main: index.js'].join('\n'),
        );
    });

    it('removes lines the patch added', () => {
        const patch = ['@@ -1,2 +1,3 @@', ' a', '+b', ' c'].join('\n');
        expect(revertPatch(['a', 'b', 'c'].join('\n'), patch)).toBe('a\nc');
    });

    it('restores lines the patch deleted', () => {
        const patch = ['@@ -1,3 +1,2 @@', ' a', '-b', ' c'].join('\n');
        expect(revertPatch(['a', 'c'].join('\n'), patch)).toBe('a\nb\nc');
    });

    it('restores a file the patch emptied', () => {
        expect(revertPatch('', ['@@ -1,2 +0,0 @@', '-a', '-b'].join('\n'))).toBe(
            'a\nb\n',
        );
    });

    it('leaves content outside the hunks untouched', () => {
        const head = ['keep 1', 'keep 2', 'changed', 'keep 3'].join('\n');
        const patch = ['@@ -3,1 +3,1 @@', '-original', '+changed'].join('\n');

        expect(revertPatch(head, patch)).toBe(
            ['keep 1', 'keep 2', 'original', 'keep 3'].join('\n'),
        );
    });

    it('applies every hunk in a multi-hunk patch', () => {
        const patch = [
            '@@ -2,1 +2,1 @@', '-b', '+B',
            '@@ -6,1 +6,1 @@', '-f', '+F',
        ].join('\n');

        expect(revertPatch(['a', 'B', 'c', 'd', 'e', 'F'].join('\n'), patch)).toBe(
            ['a', 'b', 'c', 'd', 'e', 'f'].join('\n'),
        );
    });

    it('reads a hunk header with the counts omitted', () => {
        expect(revertPatch('new', ['@@ -1 +1 @@', '-old', '+new'].join('\n'))).toBe(
            'old',
        );
    });

    it('ignores the no-newline marker', () => {
        const patch = [
            '@@ -1,1 +1,1 @@',
            '-old',
            '\\ No newline at end of file',
            '+new',
        ].join('\n');

        expect(revertPatch('new', patch)).toBe('old');
    });

    it('keeps an unchanged blank line', () => {
        const patch = ['@@ -1,3 +1,3 @@', ' a', ' ', '-c', '+C'].join('\n');
        expect(revertPatch(['a', '', 'C'].join('\n'), patch)).toBe('a\n\nc');
    });

    /**
     * The guard that matters: a patch the provider truncated would otherwise
     * reconstruct a plausible but wrong "before" file, and every difference
     * against it would be reported as introduced by this change.
     */
    describe('refusing to guess', () => {
        it('returns null when a context line does not match the file', () => {
            const patch = ['@@ -1,2 +1,2 @@', ' something else', '-x', '+y'].join('\n');
            expect(revertPatch('a\ny', patch)).toBeNull();
        });

        it('returns null when an added line is not in the file', () => {
            expect(
                revertPatch('different', ['@@ -1,1 +1,1 @@', '-old', '+new'].join('\n')),
            ).toBeNull();
        });

        it('returns null when a hunk reaches past the end of the file', () => {
            expect(
                revertPatch('short', ['@@ -10,1 +10,1 @@', '-old', '+new'].join('\n')),
            ).toBeNull();
        });

        it('returns null when hunks run backwards', () => {
            const patch = ['@@ -5,1 +5,1 @@', ' e', '@@ -2,1 +2,1 @@', ' b'].join('\n');
            expect(revertPatch('a\nb\nc\nd\ne', patch)).toBeNull();
        });

        it('returns null for an empty patch', () => {
            expect(revertPatch('a\nb', '')).toBeNull();
            expect(revertPatch('a\nb', undefined)).toBeNull();
        });
    });
});
