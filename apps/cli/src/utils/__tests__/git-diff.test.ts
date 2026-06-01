import { describe, expect, it } from 'vitest';
import { countDiffChanges } from '../git-diff.js';

describe('countDiffChanges', () => {
    it('counts additions and deletions but ignores headers', () => {
        const diff = [
            'diff --git a/file.ts b/file.ts',
            '--- a/file.ts',
            '+++ b/file.ts',
            '@@ -1,2 +1,3 @@',
            '-const oldValue = 1;',
            '+const newValue = 2;',
            '+const nextValue = 3;',
            ' unchanged',
        ].join('\n');

        expect(countDiffChanges(diff)).toEqual({
            additions: 2,
            deletions: 1,
        });
    });

    it('returns zeroes for an empty diff', () => {
        expect(countDiffChanges('')).toEqual({
            additions: 0,
            deletions: 0,
        });
    });
});
