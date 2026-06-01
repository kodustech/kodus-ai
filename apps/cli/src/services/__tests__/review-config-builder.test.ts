import { describe, expect, it, vi } from 'vitest';
import { buildReviewConfig } from '../review-config-builder.js';
import type { FileContent } from '../../types/review.js';

describe('buildReviewConfig', () => {
    it('returns base config without loading files when fast mode is enabled', async () => {
        const getFullFileContents = vi.fn();
        const filterFiles = vi.fn();

        await expect(
            buildReviewConfig({
                rulesOnly: true,
                fast: true,
                options: {
                    files: ['src/a.ts'],
                    staged: true,
                    commit: 'abc123',
                    branch: 'main',
                    quiet: true,
                },
                getFullFileContents,
                filterFiles,
            }),
        ).resolves.toEqual({
            rulesOnly: true,
            fast: true,
        });

        expect(getFullFileContents).not.toHaveBeenCalled();
        expect(filterFiles).not.toHaveBeenCalled();
    });

    it('loads and filters files for working-tree reviews (no branch/commit)', async () => {
        const files: FileContent[] = [
            {
                path: 'src/a.ts',
                content: 'const a = 1;',
                status: 'modified',
                diff: '+const a = 1;',
            },
        ];
        const getFullFileContents = vi.fn().mockResolvedValue(files);
        const filterFiles = vi.fn().mockReturnValue(files);

        await expect(
            buildReviewConfig({
                rulesOnly: false,
                fast: false,
                options: {
                    files: ['src/a.ts'],
                    staged: true,
                    quiet: true,
                },
                getFullFileContents,
                filterFiles,
            }),
        ).resolves.toEqual({
            rulesOnly: false,
            fast: false,
            files,
        });

        expect(getFullFileContents).toHaveBeenCalledWith(['src/a.ts'], {
            staged: true,
            commit: undefined,
            branch: undefined,
        });
        expect(filterFiles).toHaveBeenCalledWith(files, true);
    });

    it('skips inlining when comparing against a branch', async () => {
        // Branch mode: the diff is against committed history, so the backend
        // can clone the same commit into its sandbox and read files from
        // there. Inlining them would duplicate the content for no benefit
        // and can blow past the backend's body-parser limit on large PRs.
        const getFullFileContents = vi.fn();
        const filterFiles = vi.fn();

        await expect(
            buildReviewConfig({
                rulesOnly: false,
                fast: false,
                options: {
                    branch: 'main',
                },
                getFullFileContents,
                filterFiles,
            }),
        ).resolves.toEqual({
            rulesOnly: false,
            fast: false,
        });

        expect(getFullFileContents).not.toHaveBeenCalled();
        expect(filterFiles).not.toHaveBeenCalled();
    });

    it('skips inlining when comparing a specific commit', async () => {
        const getFullFileContents = vi.fn();
        const filterFiles = vi.fn();

        await expect(
            buildReviewConfig({
                rulesOnly: false,
                fast: false,
                options: {
                    commit: 'abc123',
                },
                getFullFileContents,
                filterFiles,
            }),
        ).resolves.toEqual({
            rulesOnly: false,
            fast: false,
        });

        expect(getFullFileContents).not.toHaveBeenCalled();
        expect(filterFiles).not.toHaveBeenCalled();
    });
});
