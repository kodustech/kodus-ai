import { readFileSync } from 'node:fs';

import { extractDiffHunks } from './extract-diff-hunks';

describe('extractDiffHunks', () => {
    const diff = [
        'diff --git a/src/a.ts b/src/a.ts',
        'index 111..222 100644',
        '--- a/src/a.ts',
        '+++ b/src/a.ts',
        '@@ -1,2 +1,2 @@',
        '-old',
        '+new',
        'diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml',
        'index 333..444 100644',
        '--- a/pnpm-lock.yaml',
        '+++ b/pnpm-lock.yaml',
        '@@ -10,3 +10,3 @@',
        '-  lodash: 4.17.21',
        '+  lodash: 4.17.11',
    ].join('\n');

    it('returns only the requested paths', () => {
        expect(extractDiffHunks(diff, ['pnpm-lock.yaml'])).toEqual([
            {
                path: 'pnpm-lock.yaml',
                patch: '@@ -10,3 +10,3 @@\n-  lodash: 4.17.21\n+  lodash: 4.17.11',
            },
        ]);
    });

    it('starts at the first hunk, matching the shape the file listing gives', () => {
        const [only] = extractDiffHunks(diff, ['src/a.ts']);

        expect(only.patch.startsWith('@@')).toBe(true);
        expect(only.patch).not.toContain('diff --git');
        expect(only.patch).not.toContain('index ');
        expect(only.patch).not.toContain('--- a/');
    });

    it('ignores a file with no hunks, such as a pure rename', () => {
        const renameOnly = [
            'diff --git a/old.ts b/new.ts',
            'similarity index 100%',
            'rename from old.ts',
            'rename to new.ts',
        ].join('\n');

        expect(extractDiffHunks(renameOnly, ['new.ts'])).toEqual([]);
    });

    it('is not fooled by diff content that looks like a header', () => {
        // A lockfile can legitimately contain the string "diff --git".
        const tricky = [
            'diff --git a/notes.md b/notes.md',
            'index 1..2 100644',
            '--- a/notes.md',
            '+++ b/notes.md',
            '@@ -1,1 +1,2 @@',
            ' keep',
            '+example: diff --git a/fake b/fake',
        ].join('\n');

        const [only] = extractDiffHunks(tricky, ['notes.md']);

        expect(only.patch).toContain('example: diff --git a/fake b/fake');
    });

    it('returns nothing rather than throwing on empty input', () => {
        expect(extractDiffHunks('', ['a.ts'])).toEqual([]);
        expect(extractDiffHunks(diff, [])).toEqual([]);
    });
});
