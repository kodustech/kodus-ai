import { describe, expect, it, vi } from 'vitest';
import { resolveReviewDiff } from '../diff.js';

describe('resolveReviewDiff', () => {
    it('uses file diff when specific files are provided', async () => {
        const git = {
            setVerbose: vi.fn(),
            getDiffForFiles: vi.fn().mockResolvedValue('file diff'),
            getDiffForBranch: vi.fn(),
            getDiffForCommit: vi.fn(),
            getStagedDiff: vi.fn(),
            getWorkingTreeDiff: vi.fn(),
        };

        const result = await resolveReviewDiff({
            files: ['src/a.ts', 'src/b.ts'],
            options: {},
            verbose: true,
            git,
        });

        expect(git.setVerbose).toHaveBeenCalledWith(true);
        expect(git.getDiffForFiles).toHaveBeenCalledWith([
            'src/a.ts',
            'src/b.ts',
        ]);
        expect(result.diff).toBe('file diff');
        expect(result.verboseMessages).toEqual([
            '[verbose] Getting diff for specific files: src/a.ts, src/b.ts',
            '[verbose] Diff result: 9 characters',
            '[verbose] Diff preview:\nfile diff',
        ]);
    });

    it('uses working tree diff by default and reports empty results', async () => {
        const git = {
            setVerbose: vi.fn(),
            getDiffForFiles: vi.fn(),
            getDiffForBranch: vi.fn(),
            getDiffForCommit: vi.fn(),
            getStagedDiff: vi.fn(),
            getWorkingTreeDiff: vi.fn().mockResolvedValue(''),
        };

        const result = await resolveReviewDiff({
            files: [],
            options: {},
            verbose: true,
            git,
        });

        expect(git.getWorkingTreeDiff).toHaveBeenCalled();
        expect(result.diff).toBe('');
        expect(result.verboseMessages).toEqual([
            '[verbose] Getting working tree diff (staged + unstaged)',
            '[verbose] Diff result: empty',
            '[verbose] No changes detected in the requested scope',
        ]);
    });

    it('uses branch diff when branch option is provided', async () => {
        const git = {
            setVerbose: vi.fn(),
            getDiffForFiles: vi.fn(),
            getDiffForBranch: vi.fn().mockResolvedValue('branch diff'),
            getDiffForCommit: vi.fn(),
            getStagedDiff: vi.fn(),
            getWorkingTreeDiff: vi.fn(),
        };

        const result = await resolveReviewDiff({
            files: [],
            options: { branch: 'main' },
            verbose: false,
            git,
        });

        expect(git.getDiffForBranch).toHaveBeenCalledWith('main');
        expect(result).toEqual({
            diff: 'branch diff',
            verboseMessages: [],
        });
    });
});
