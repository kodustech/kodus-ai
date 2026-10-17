import { changedPaths } from './build-repo-instructions';

// Instructions are selected for the files the review sees. The finder eval
// reviews the PR's whole diff (`changedFilesFull`); `changedFiles` is the
// corpus's first six files, kept as the fallback.
describe('changedPaths', () => {
    it('selects against the whole diff when the case has it', () => {
        expect(
            changedPaths({
                changedFiles: [{ filename: 'a.ts' }],
                changedFilesFull: JSON.stringify([
                    { filename: 'a.ts' },
                    { filename: 'web/b.tsx' },
                ]),
            }),
        ).toEqual(['a.ts', 'web/b.tsx']);
    });

    it('falls back to the corpus files, stored as a string or an array', () => {
        expect(
            changedPaths({
                changedFiles: JSON.stringify([{ filename: 'a.ts' }]),
            }),
        ).toEqual(['a.ts']);
        expect(changedPaths({ changedFiles: [{ filename: 'a.ts' }] })).toEqual([
            'a.ts',
        ]);
        expect(changedPaths({})).toEqual([]);
    });
});
