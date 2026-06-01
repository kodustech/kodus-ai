import { describe, expect, it } from 'vitest';
import {
    extractOrgRepoFromRemote,
    inferPlatformFromRemote,
} from '../git-remote.js';

describe('inferPlatformFromRemote', () => {
    it('detects GitHub from HTTPS URL', () => {
        expect(
            inferPlatformFromRemote('https://github.com/org/repo.git'),
        ).toBe('GITHUB');
    });

    it('detects GitHub from SSH URL', () => {
        expect(
            inferPlatformFromRemote('git@github.com:org/repo.git'),
        ).toBe('GITHUB');
    });

    it('detects GitLab from HTTPS URL', () => {
        expect(
            inferPlatformFromRemote('https://gitlab.com/org/repo.git'),
        ).toBe('GITLAB');
    });

    it('detects Bitbucket from SSH URL', () => {
        expect(
            inferPlatformFromRemote('git@bitbucket.org:org/repo.git'),
        ).toBe('BITBUCKET');
    });

    it('detects Azure DevOps from dev.azure.com URL', () => {
        expect(
            inferPlatformFromRemote('https://dev.azure.com/org/project/_git/repo'),
        ).toBe('AZURE_REPOS');
    });

    it('detects Azure DevOps from visualstudio.com URL', () => {
        expect(
            inferPlatformFromRemote(
                'https://org.visualstudio.com/project/_git/repo',
            ),
        ).toBe('AZURE_REPOS');
    });

    it('detects Azure DevOps from SSH URL', () => {
        expect(
            inferPlatformFromRemote('git@ssh.dev.azure.com:v3/org/project/repo'),
        ).toBe('AZURE_REPOS');
    });

    it('returns undefined for self-hosted instances', () => {
        expect(
            inferPlatformFromRemote('https://gitlab.company.com/org/repo.git'),
        ).toBeUndefined();
    });

    it('returns undefined for deceptive subdomain hosts', () => {
        expect(
            inferPlatformFromRemote(
                'https://github.com.evil.example.com/org/repo.git',
            ),
        ).toBeUndefined();
    });
});

describe('extractOrgRepoFromRemote', () => {
    // ── GitHub ──────────────────────────────────────────────────────────
    it('extracts from GitHub SSH URL', () => {
        expect(extractOrgRepoFromRemote('git@github.com:org/repo.git')).toEqual(
            { org: 'org', repo: 'repo' },
        );
    });

    it('extracts from GitHub HTTPS URL', () => {
        expect(
            extractOrgRepoFromRemote('https://github.com/org/repo.git'),
        ).toEqual({ org: 'org', repo: 'repo' });
    });

    // ── GitLab ──────────────────────────────────────────────────────────
    it('extracts from GitLab SSH URL', () => {
        expect(
            extractOrgRepoFromRemote('git@gitlab.com:group/project.git'),
        ).toEqual({ org: 'group', repo: 'project' });
    });

    it('extracts from GitLab HTTPS URL', () => {
        expect(
            extractOrgRepoFromRemote('https://gitlab.com/group/project.git'),
        ).toEqual({ org: 'group', repo: 'project' });
    });

    it('extracts from GitLab SSH with subgroups', () => {
        expect(
            extractOrgRepoFromRemote(
                'git@gitlab.com:group/subgroup/repo.git',
            ),
        ).toEqual({ org: 'group', repo: 'repo' });
    });

    it('extracts from self-hosted GitLab SSH', () => {
        expect(
            extractOrgRepoFromRemote('git@gitlab.company.com:org/repo.git'),
        ).toEqual({ org: 'org', repo: 'repo' });
    });

    it('extracts from self-hosted GitLab HTTPS', () => {
        expect(
            extractOrgRepoFromRemote(
                'https://gitlab.company.com/org/repo.git',
            ),
        ).toEqual({ org: 'org', repo: 'repo' });
    });

    // ── Bitbucket ───────────────────────────────────────────────────────
    it('extracts from Bitbucket SSH URL', () => {
        expect(
            extractOrgRepoFromRemote('git@bitbucket.org:org/repo.git'),
        ).toEqual({ org: 'org', repo: 'repo' });
    });

    it('extracts from Bitbucket HTTPS URL', () => {
        expect(
            extractOrgRepoFromRemote('https://bitbucket.org/org/repo.git'),
        ).toEqual({ org: 'org', repo: 'repo' });
    });

    it('extracts from Bitbucket Server (self-hosted) HTTPS', () => {
        expect(
            extractOrgRepoFromRemote(
                'https://bitbucket.company.com/scm/proj/repo.git',
            ),
        ).toEqual({ org: 'proj', repo: 'repo' });
    });

    it('extracts from Bitbucket Server SSH with port', () => {
        expect(
            extractOrgRepoFromRemote(
                'ssh://git@bitbucket.company.com:7999/proj/repo.git',
            ),
        ).toEqual({ org: 'proj', repo: 'repo' });
    });

    // ── Azure DevOps ────────────────────────────────────────────────────
    it('extracts from Azure DevOps HTTPS (new)', () => {
        expect(
            extractOrgRepoFromRemote(
                'https://dev.azure.com/myorg/myproject/_git/myrepo',
            ),
        ).toEqual({ org: 'myorg', repo: 'myrepo' });
    });

    it('extracts from Azure DevOps HTTPS (old visualstudio.com)', () => {
        expect(
            extractOrgRepoFromRemote(
                'https://myorg.visualstudio.com/myproject/_git/myrepo',
            ),
        ).toEqual({ org: 'myorg', repo: 'myrepo' });
    });

    it('extracts from Azure DevOps SSH (new)', () => {
        expect(
            extractOrgRepoFromRemote(
                'git@ssh.dev.azure.com:v3/myorg/myproject/myrepo',
            ),
        ).toEqual({ org: 'myorg', repo: 'myrepo' });
    });

    it('extracts from Azure DevOps SSH (old vs-ssh)', () => {
        expect(
            extractOrgRepoFromRemote(
                'git@vs-ssh.visualstudio.com:v3/myorg/myproject/myrepo',
            ),
        ).toEqual({ org: 'myorg', repo: 'myrepo' });
    });

    // ── Edge cases ──────────────────────────────────────────────────────
    it('returns null for null input', () => {
        expect(extractOrgRepoFromRemote(null)).toBeNull();
    });

    it('returns null for empty string', () => {
        expect(extractOrgRepoFromRemote('')).toBeNull();
    });

    it('returns null for URL with no path segments', () => {
        expect(extractOrgRepoFromRemote('https://github.com')).toBeNull();
    });
});
