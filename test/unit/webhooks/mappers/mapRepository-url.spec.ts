import { GithubMappedPlatform } from '../../../../libs/common/utils/webhooks/github';
import { GitlabMappedPlatform } from '../../../../libs/common/utils/webhooks/gitlab';
import { AzureReposMappedPlatform } from '../../../../libs/common/utils/webhooks/azureRepos';
import { BitbucketMappedPlatform } from '../../../../libs/common/utils/webhooks/bitbucket';

describe('mapRepository - repository URL must be the web URL', () => {
    describe('GitHub', () => {
        const mapper = new GithubMappedPlatform();

        it('should use html_url (web) instead of url (API)', () => {
            const payload = {
                pull_request: {
                    title: 'Test PR',
                    number: 1,
                    user: { id: 1, login: 'user' },
                    head: { ref: 'feature', repo: { full_name: 'owner/repo' } },
                    base: { ref: 'main', repo: { full_name: 'owner/repo' } },
                },
                repository: {
                    id: 123,
                    name: 'repo',
                    full_name: 'owner/repo',
                    language: 'TypeScript',
                    url: 'https://api.github.com/repos/owner/repo',
                    html_url: 'https://github.com/owner/repo',
                },
            };

            const result = mapper.mapRepository({ payload: payload as any });

            expect(result.url).toBe('https://github.com/owner/repo');
            expect(result.url).not.toContain('api.github.com');
        });

        it('should fall back to url if html_url is missing', () => {
            const payload = {
                pull_request: {
                    title: 'Test PR',
                    number: 1,
                    user: { id: 1, login: 'user' },
                    head: { ref: 'feature', repo: { full_name: 'owner/repo' } },
                    base: { ref: 'main', repo: { full_name: 'owner/repo' } },
                },
                repository: {
                    id: 123,
                    name: 'repo',
                    full_name: 'owner/repo',
                    language: 'TypeScript',
                    url: 'https://api.github.com/repos/owner/repo',
                },
            };

            const result = mapper.mapRepository({ payload: payload as any });

            expect(result.url).toBe('https://api.github.com/repos/owner/repo');
        });
    });

    describe('GitLab', () => {
        const mapper = new GitlabMappedPlatform();

        it('should use web_url instead of url (SSH)', () => {
            const payload = {
                object_attributes: {
                    iid: 1,
                    title: 'Test MR',
                    source_branch: 'feature',
                    target_branch: 'main',
                    url: 'https://gitlab.com/owner/repo/-/merge_requests/1',
                },
                repository: {
                    name: 'repo',
                    url: 'git@gitlab.com:owner/repo.git',
                },
                project: {
                    id: 456,
                    name: 'repo',
                    web_url: 'https://gitlab.com/owner/repo',
                    url: 'git@gitlab.com:owner/repo.git',
                    git_ssh_url: 'git@gitlab.com:owner/repo.git',
                    git_http_url: 'https://gitlab.com/owner/repo.git',
                    path_with_namespace: 'owner/repo',
                },
                user: { id: 1, username: 'user' },
            };

            const result = mapper.mapRepository({ payload: payload as any });

            expect(result.url).toBe('https://gitlab.com/owner/repo');
            expect(result.url).not.toContain('git@');
        });

        it('should fall back to url if web_url is missing', () => {
            const payload = {
                object_attributes: {
                    iid: 1,
                    title: 'Test MR',
                    source_branch: 'feature',
                    target_branch: 'main',
                },
                repository: {
                    name: 'repo',
                    url: 'git@gitlab.com:owner/repo.git',
                },
                project: {
                    id: 456,
                    name: 'repo',
                    url: 'git@gitlab.com:owner/repo.git',
                    git_ssh_url: 'git@gitlab.com:owner/repo.git',
                    path_with_namespace: 'owner/repo',
                },
                user: { id: 1, username: 'user' },
            };

            const result = mapper.mapRepository({ payload: payload as any });

            expect(result.url).toBe('git@gitlab.com:owner/repo.git');
        });
    });

    describe('Azure DevOps', () => {
        const mapper = new AzureReposMappedPlatform();

        it('should use remoteUrl (web) instead of url (API)', () => {
            const payload = {
                eventType: 'git.pullrequest.created',
                resource: {
                    pullRequestId: 1,
                    title: 'Test PR',
                    createdBy: {
                        id: '1',
                        uniqueName: 'user',
                        displayName: 'User',
                    },
                    sourceRefName: 'refs/heads/feature',
                    targetRefName: 'refs/heads/main',
                    repository: {
                        id: 'repo-guid',
                        name: 'my-repo',
                        url: 'https://dev.azure.com/org/project/_apis/git/repositories/repo-guid',
                        remoteUrl:
                            'https://dev.azure.com/org/project/_git/my-repo',
                        project: {
                            id: 'proj-guid',
                            name: 'project',
                            url: 'https://dev.azure.com/org/project/_apis',
                        },
                        defaultBranch: 'refs/heads/main',
                    },
                },
            };

            const result = mapper.mapRepository({ payload: payload as any });

            expect(result.url).toBe(
                'https://dev.azure.com/org/project/_git/my-repo',
            );
            expect(result.url).not.toContain('_apis');
        });

        it('should fall back to url if remoteUrl is missing', () => {
            const payload = {
                eventType: 'git.pullrequest.created',
                resource: {
                    pullRequestId: 1,
                    title: 'Test PR',
                    createdBy: {
                        id: '1',
                        uniqueName: 'user',
                        displayName: 'User',
                    },
                    sourceRefName: 'refs/heads/feature',
                    targetRefName: 'refs/heads/main',
                    repository: {
                        id: 'repo-guid',
                        name: 'my-repo',
                        url: 'https://dev.azure.com/org/project/_apis/git/repositories/repo-guid',
                        project: {
                            id: 'proj-guid',
                            name: 'project',
                            url: 'https://dev.azure.com/org/project/_apis',
                        },
                        defaultBranch: 'refs/heads/main',
                    },
                },
            };

            const result = mapper.mapRepository({ payload: payload as any });

            expect(result.url).toBe(
                'https://dev.azure.com/org/project/_apis/git/repositories/repo-guid',
            );
        });
    });

    describe('Bitbucket', () => {
        const mapper = new BitbucketMappedPlatform();

        it('should use links.html.href as the web URL', () => {
            const payload = {
                actor: {
                    display_name: 'User',
                    uuid: 'user-uuid',
                    type: 'user' as const,
                },
                pullrequest: {
                    id: 1,
                    title: 'Test PR',
                    description: '',
                    source: {
                        branch: { name: 'feature' },
                        commit: { hash: 'abc123' },
                        repository: {
                            name: 'repo',
                            full_name: 'workspace/repo',
                            uuid: 'repo-uuid',
                            links: {
                                self: {
                                    href: 'https://api.bitbucket.org/2.0/repositories/workspace/repo',
                                },
                                html: {
                                    href: 'https://bitbucket.org/workspace/repo',
                                },
                                avatar: {
                                    href: 'https://bitbucket.org/workspace/repo/avatar',
                                },
                            },
                        },
                    },
                    destination: {
                        branch: { name: 'main' },
                        commit: { hash: 'def456' },
                        repository: {
                            name: 'repo',
                            full_name: 'workspace/repo',
                            uuid: 'dest-repo-uuid',
                            links: {
                                self: {
                                    href: 'https://api.bitbucket.org/2.0/repositories/workspace/repo',
                                },
                                html: {
                                    href: 'https://bitbucket.org/workspace/repo',
                                },
                                avatar: {
                                    href: 'https://bitbucket.org/workspace/repo/avatar',
                                },
                            },
                        },
                    },
                    author: {
                        display_name: 'User',
                        uuid: 'user-uuid',
                        type: 'user' as const,
                    },
                },
                repository: {
                    name: 'repo',
                    full_name: 'workspace/repo',
                    uuid: 'repo-uuid',
                    links: {
                        self: {
                            href: 'https://api.bitbucket.org/2.0/repositories/workspace/repo',
                        },
                        html: { href: 'https://bitbucket.org/workspace/repo' },
                        avatar: {
                            href: 'https://bitbucket.org/workspace/repo/avatar',
                        },
                    },
                },
                isDataCenterEvent: false,
            };

            const result = mapper.mapRepository({ payload: payload as any });

            expect(result.url).toBe('https://bitbucket.org/workspace/repo');
            expect(result.url).not.toContain('api.bitbucket.org');
        });

        it('should return empty string if links.html.href is missing', () => {
            const payload = {
                actor: {
                    display_name: 'User',
                    uuid: 'user-uuid',
                    type: 'user' as const,
                },
                pullrequest: {
                    id: 1,
                    title: 'Test PR',
                    description: '',
                    source: {
                        branch: { name: 'feature' },
                        commit: { hash: 'abc123' },
                        repository: {
                            name: 'repo',
                            full_name: 'workspace/repo',
                            uuid: 'repo-uuid',
                            links: {
                                self: {
                                    href: 'https://api.bitbucket.org/2.0/repositories/workspace/repo',
                                },
                                html: {
                                    href: 'https://bitbucket.org/workspace/repo',
                                },
                                avatar: {
                                    href: 'https://bitbucket.org/workspace/repo/avatar',
                                },
                            },
                        },
                    },
                    destination: {
                        branch: { name: 'main' },
                        commit: { hash: 'def456' },
                        repository: {
                            name: 'repo',
                            full_name: 'workspace/repo',
                            uuid: 'dest-repo-uuid',
                        },
                    },
                    author: {
                        display_name: 'User',
                        uuid: 'user-uuid',
                        type: 'user' as const,
                    },
                },
                repository: {
                    name: 'repo',
                    full_name: 'workspace/repo',
                    uuid: 'repo-uuid',
                },
                isDataCenterEvent: false,
            };

            const result = mapper.mapRepository({ payload: payload as any });

            expect(result.url).toBe('');
        });
    });
});
