import { changedPaths, collectForCase } from './build-repo-instructions';

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

// What the eval serves as the target branch: its instruction files and every
// file one points to, so production's stage selects and resolves them itself.
describe('collectForCase', () => {
    const tree: Record<string, string> = {
        'CLAUDE.md': 'AI-AGENTS.md',
        'AI-AGENTS.md': 'Use the structured logger.',
        'docs/AGENTS.md': 'Docs only.',
        'src/a.ts': 'export const a = 1;',
    };

    it("records the branch's instruction files and the files they point to", async () => {
        const { repoInstructions, targetBranchFiles } = await collectForCase({
            index: Object.keys(tree),
            readFile: async (p: string) => tree[p] ?? null,
            changedFiles: ['src/a.ts'],
        });

        expect(repoInstructions.files.map((f) => f.path)).toEqual([
            'AI-AGENTS.md',
        ]);
        expect(targetBranchFiles).toEqual({
            'CLAUDE.md': 'AI-AGENTS.md',
            'AI-AGENTS.md': 'Use the structured logger.',
            'docs/AGENTS.md': 'Docs only.',
        });
    });
});
