import { describe, expect, it, vi } from 'vitest';
import {
    getBranchSafe,
    getGitContext,
    getHeadSafe,
    getRemoteSafe,
} from '../lifecycle-git-context.js';

describe('lifecycle git context helpers', () => {
    it('returns branch, head, and remote from the git service', async () => {
        const git = {
            getCurrentBranch: vi.fn().mockResolvedValue('feature/test\n'),
            getHeadSha: vi.fn().mockResolvedValue('abc123'),
            getRemoteUrl: vi.fn().mockResolvedValue('git@github.com:org/repo.git'),
        };

        await expect(getBranchSafe(git)).resolves.toBe('feature/test');
        await expect(getHeadSafe(git)).resolves.toBe('abc123');
        await expect(getRemoteSafe(git)).resolves.toBe(
            'git@github.com:org/repo.git',
        );
        await expect(getGitContext(git)).resolves.toEqual({
            branch: 'feature/test',
            head: 'abc123',
            remote: 'git@github.com:org/repo.git',
        });
    });

    it('falls back to empty strings when git lookups fail or return null', async () => {
        const git = {
            getCurrentBranch: vi.fn().mockRejectedValue(new Error('no git')),
            getHeadSha: vi.fn().mockResolvedValue(null),
            getRemoteUrl: vi.fn().mockResolvedValue(null),
        };

        await expect(getBranchSafe(git)).resolves.toBe('');
        await expect(getHeadSafe(git)).resolves.toBe('');
        await expect(getRemoteSafe(git)).resolves.toBe('');
        await expect(getGitContext(git)).resolves.toEqual({
            branch: '',
            head: '',
            remote: '',
        });
    });
});
