import { changedPaths } from './build-repo-instructions';

// Instructions are selected for the files the review sees: the platform's
// file list (`prFiles`), else the PR's whole diff (`changedFilesFull`), else
// the corpus's first six files (`changedFiles`).
describe('changedPaths', () => {
    it("selects against the platform's file list when the case has it", () => {
        expect(
            changedPaths({
                changedFiles: [{ filename: 'a.ts' }],
                changedFilesFull: [{ filename: 'a.ts' }],
                prFiles: [{ filename: 'a.ts' }, { filename: 'web/b.tsx' }],
            }),
        ).toEqual(['a.ts', 'web/b.tsx']);
    });


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
