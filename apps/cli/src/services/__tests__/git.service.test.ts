import { describe, it, expect } from 'vitest';
import { gitService } from '../git.service.js';

describe('inferPlatform', () => {
    it('detects GitHub from HTTPS URL', () => {
        expect(
            gitService.inferPlatform('https://github.com/org/repo.git'),
        ).toBe('GITHUB');
    });

    it('detects GitHub from SSH URL', () => {
        expect(gitService.inferPlatform('git@github.com:org/repo.git')).toBe(
            'GITHUB',
        );
    });

    it('detects GitLab from HTTPS URL', () => {
        expect(
            gitService.inferPlatform('https://gitlab.com/org/repo.git'),
        ).toBe('GITLAB');
    });

    it('detects GitLab from SSH URL', () => {
        expect(gitService.inferPlatform('git@gitlab.com:org/repo.git')).toBe(
            'GITLAB',
        );
    });

    it('detects Bitbucket from HTTPS URL', () => {
        expect(
            gitService.inferPlatform('https://bitbucket.org/org/repo.git'),
        ).toBe('BITBUCKET');
    });

    it('detects Bitbucket from SSH URL', () => {
        expect(gitService.inferPlatform('git@bitbucket.org:org/repo.git')).toBe(
            'BITBUCKET',
        );
    });

    it('detects Azure DevOps from dev.azure.com URL', () => {
        expect(
            gitService.inferPlatform(
                'https://dev.azure.com/org/project/_git/repo',
            ),
        ).toBe('AZURE_REPOS');
    });

    it('detects Azure DevOps from visualstudio.com URL', () => {
        expect(
            gitService.inferPlatform(
                'https://org.visualstudio.com/project/_git/repo',
            ),
        ).toBe('AZURE_REPOS');
    });

    it('returns undefined for null', () => {
        expect(gitService.inferPlatform(null)).toBeUndefined();
    });

    it('returns undefined for undefined', () => {
        expect(gitService.inferPlatform(undefined)).toBeUndefined();
    });

    it('returns undefined for unknown host', () => {
        expect(
            gitService.inferPlatform(
                'https://selfhosted.example.com/org/repo.git',
            ),
        ).toBeUndefined();
    });

    it('returns undefined when allowed host appears in URL path only', () => {
        expect(
            gitService.inferPlatform(
                'https://evil.example.com/github.com/org/repo.git',
            ),
        ).toBeUndefined();
        expect(
            gitService.inferPlatform(
                'https://evil.example.com/dev.azure.com/org/project/_git/repo',
            ),
        ).toBeUndefined();
    });

    it('returns undefined for deceptive subdomain hosts', () => {
        expect(
            gitService.inferPlatform(
                'https://github.com.evil.example.com/org/repo.git',
            ),
        ).toBeUndefined();
        expect(
            gitService.inferPlatform(
                'https://dev.azure.com.evil.example.com/org/project/_git/repo',
            ),
        ).toBeUndefined();
    });
});

describe('parseGitStatus', () => {
    it('maps A to added', () => {
        expect(gitService.parseGitStatus('A')).toBe('added');
    });

    it('maps D to deleted', () => {
        expect(gitService.parseGitStatus('D')).toBe('deleted');
    });

    it('maps R to renamed', () => {
        expect(gitService.parseGitStatus('R')).toBe('renamed');
    });

    it('maps M to modified', () => {
        expect(gitService.parseGitStatus('M')).toBe('modified');
    });

    it('maps unknown char to modified', () => {
        expect(gitService.parseGitStatus('X')).toBe('modified');
    });

    it('handles lowercase input', () => {
        expect(gitService.parseGitStatus('a')).toBe('added');
    });

    it('handles status with trailing info (e.g. R100)', () => {
        expect(gitService.parseGitStatus('R100')).toBe('renamed');
    });
});
