import { ConfigService } from '@nestjs/config';
import { Gitlab } from '@gitbeaker/rest';
import axios from 'axios';

import { AuthMode } from '@libs/platform/domain/platformIntegrations/enums/codeManagement/authMode.enum';
import { GitlabService } from './gitlab.service';

jest.mock('axios');
jest.mock('@gitbeaker/rest', () => ({
    Gitlab: jest.fn(),
}));
jest.mock('@libs/mcp-server/services/mcp-manager.service', () => ({
    MCPManagerService: jest.fn(),
}));

describe('GitlabService', () => {
    const organizationAndTeamData = {
        organizationId: 'org-1',
        teamId: 'team-1',
    };

    let service: GitlabService;
    let integrationService: { findOne: jest.Mock };
    let integrationConfigService: Record<string, never>;
    let authIntegrationService: Record<string, never>;
    let configService: ConfigService;
    let cacheService: { getFromCache: jest.Mock; addToCache: jest.Mock };

    const mockedAxios = axios as jest.Mocked<typeof axios>;
    const mockedGitlab = Gitlab as unknown as jest.Mock;

    beforeEach(() => {
        integrationService = {
            findOne: jest.fn().mockResolvedValue({ uuid: 'integration-1' }),
        };
        integrationConfigService = {};
        authIntegrationService = {};
        configService = {
            get: jest.fn(),
        } as unknown as ConfigService;
        cacheService = {
            getFromCache: jest.fn().mockResolvedValue(undefined),
            addToCache: jest.fn().mockResolvedValue(undefined),
        };

        service = new GitlabService(
            integrationService as any,
            integrationConfigService as any,
            authIntegrationService as any,
            configService,
            cacheService as any,
        );

        jest.clearAllMocks();
    });

    it('normalizes bare stored hosts before creating the GitLab API client', () => {
        (service as any).instanceGitlabApi({
            accessToken: 'oauth-token',
            authMode: AuthMode.OAUTH,
            host: 'gitlab.example.com/',
        });

        expect(mockedGitlab).toHaveBeenCalledWith({
            oauthToken: 'oauth-token',
            host: 'https://gitlab.example.com',
            queryTimeout: 600000,
            camelize: false,
        });
    });

    it('normalizes bare self-hosted GitLab hosts when authenticating with a token', async () => {
        mockedAxios.get.mockResolvedValue({ data: { id: 1 } });
        const checkRepositoryPermissions = jest
            .spyOn(service as any, 'checkRepositoryPermissions')
            .mockResolvedValue({ success: true });
        jest.spyOn(service as any, 'handleIntegration').mockResolvedValue(
            undefined,
        );

        await service.authenticateWithToken({
            token: 'pat-token',
            host: 'gitlab.example.com/',
            authMode: AuthMode.TOKEN,
            organizationAndTeamData,
        });

        expect(mockedAxios.get).toHaveBeenCalledWith(
            'https://gitlab.example.com/api/v4/user',
            expect.objectContaining({
                headers: { Authorization: 'Bearer pat-token' },
                timeout: 30000,
            }),
        );
        expect(checkRepositoryPermissions).toHaveBeenCalledWith({
            authDetails: expect.objectContaining({
                authMode: AuthMode.TOKEN,
                host: 'https://gitlab.example.com',
            }),
        });
    });

    describe('getCloneParams', () => {
        const mockAuthDetails = () =>
            jest.spyOn(service as any, 'getAuthDetails').mockResolvedValue({
                accessToken: 'oauth-token',
                authMode: AuthMode.OAUTH,
                host: 'https://gitlab.example.com/',
            });

        const mockProjectsShow = (show: jest.Mock) =>
            mockedGitlab.mockReturnValue({ Projects: { show } });

        it('does not duplicate the protocol when building clone params for self-hosted GitLab', async () => {
            mockAuthDetails();
            mockProjectsShow(
                jest.fn().mockResolvedValue({
                    path_with_namespace: 'group/repo',
                }),
            );

            const cloneParams = await service.getCloneParams({
                organizationAndTeamData,
                repository: {
                    id: 'repo-1',
                    name: 'repo',
                    fullName: 'group/repo',
                    defaultBranch: 'main',
                },
            });

            expect(cloneParams.url).toBe(
                'https://gitlab.example.com/group/repo',
            );
            expect(cloneParams.auth).toMatchObject({
                type: AuthMode.OAUTH,
                token: 'oauth-token',
            });
        });

        // A stored fullName can hold the display form. Encoding it verbatim
        // produces `My Group/My%20Project`, which GitLab answers with a 302
        // to /users/sign_in and git reports as
        // `unable to update url base from redirection`.
        it('builds the URL from path_with_namespace when fullName holds the display form', async () => {
            mockAuthDetails();
            const show = jest.fn().mockResolvedValue({
                path_with_namespace: 'my-group/my-project',
            });
            mockProjectsShow(show);

            const cloneParams = await service.getCloneParams({
                organizationAndTeamData,
                repository: {
                    id: '326',
                    name: 'My Project',
                    fullName: 'My Group/My Project',
                    defaultBranch: 'main',
                },
            });

            expect(show).toHaveBeenCalledWith('326');
            expect(cloneParams.url).toBe(
                'https://gitlab.example.com/my-group/my-project',
            );
            expect(cloneParams.url).not.toContain('%20');
        });

        // The numeric id survives a move between groups; the stored path does
        // not, and silently loses the new parent subgroup.
        it('picks up a subgroup the stored fullName predates', async () => {
            mockAuthDetails();
            mockProjectsShow(
                jest.fn().mockResolvedValue({
                    path_with_namespace: 'parent/group/repo',
                }),
            );

            const cloneParams = await service.getCloneParams({
                organizationAndTeamData,
                repository: {
                    id: 'repo-2',
                    name: 'repo',
                    fullName: 'group/repo',
                    defaultBranch: 'main',
                },
            });

            expect(cloneParams.url).toBe(
                'https://gitlab.example.com/parent/group/repo',
            );
        });

        // CLI mode passes the placeholder id '0' with a fullName parsed from the
        // local remote. '0' is a truthy string, so this needs an explicit check
        // or every CLI clone burns a guaranteed-failing round-trip.
        it.each(['0', '', undefined])(
            'skips the project lookup when the id is the placeholder %p',
            async (id) => {
                mockAuthDetails();
                const show = jest.fn();
                mockProjectsShow(show);

                const cloneParams = await service.getCloneParams({
                    organizationAndTeamData,
                    repository: {
                        id: id as string,
                        name: 'repo',
                        fullName: 'group/repo',
                        defaultBranch: 'main',
                    },
                });

                expect(show).not.toHaveBeenCalled();
                expect(cloneParams.url).toBe(
                    'https://gitlab.example.com/group/repo',
                );
            },
        );

        it('falls back to the stored fullName when the project lookup fails', async () => {
            mockAuthDetails();
            mockProjectsShow(
                jest.fn().mockRejectedValue(new Error('404 Not Found')),
            );

            const cloneParams = await service.getCloneParams({
                organizationAndTeamData,
                repository: {
                    id: 'repo-3',
                    name: 'repo',
                    fullName: 'group/repo',
                    defaultBranch: 'main',
                },
            });

            expect(cloneParams.url).toBe(
                'https://gitlab.example.com/group/repo',
            );
        });

        it('still encodes path segments that need it', async () => {
            mockAuthDetails();
            mockProjectsShow(
                jest.fn().mockResolvedValue({
                    path_with_namespace: 'group/repo name',
                }),
            );

            const cloneParams = await service.getCloneParams({
                organizationAndTeamData,
                repository: {
                    id: 'repo-4',
                    name: 'repo name',
                    fullName: 'group/repo name',
                    defaultBranch: 'main',
                },
            });

            expect(cloneParams.url).toBe(
                'https://gitlab.example.com/group/repo%20name',
            );
        });

        // Every clone otherwise pays the Projects.show round-trip on its
        // critical path, including repeated clones of the same repository
        // across reviews.
        it('reuses a cached path_with_namespace instead of calling Projects.show again', async () => {
            mockAuthDetails();
            const show = jest.fn().mockResolvedValue({
                path_with_namespace: 'should-not-be-used',
            });
            mockProjectsShow(show);
            cacheService.getFromCache.mockResolvedValue('group/cached-repo');

            const cloneParams = await service.getCloneParams({
                organizationAndTeamData,
                repository: {
                    id: 'repo-5',
                    name: 'repo',
                    fullName: 'group/repo',
                    defaultBranch: 'main',
                },
            });

            expect(cacheService.getFromCache).toHaveBeenCalledWith(
                'gitlab-project-path-org-1-team-1-https://gitlab.example.com-repo-5',
            );
            expect(show).not.toHaveBeenCalled();
            expect(cloneParams.url).toBe(
                'https://gitlab.example.com/group/cached-repo',
            );
        });

        it('caches a resolved path_with_namespace on a cache miss', async () => {
            mockAuthDetails();
            mockProjectsShow(
                jest.fn().mockResolvedValue({
                    path_with_namespace: 'group/repo',
                }),
            );

            await service.getCloneParams({
                organizationAndTeamData,
                repository: {
                    id: 'repo-6',
                    name: 'repo',
                    fullName: 'group/repo',
                    defaultBranch: 'main',
                },
            });

            expect(cacheService.addToCache).toHaveBeenCalledWith(
                'gitlab-project-path-org-1-team-1-https://gitlab.example.com-repo-6',
                'group/repo',
                1800000,
            );
        });

        // The GitLab integration is resolved per team, and two teams in the
        // same org can point to different GitLab hosts and still share a
        // numeric project id — the key must be scoped past organizationId
        // alone or one team's clone can serve another team's cached slug.
        it('scopes the cache key by team and GitLab host, not just organization', async () => {
            mockAuthDetails();
            mockProjectsShow(
                jest.fn().mockResolvedValue({
                    path_with_namespace: 'group/repo',
                }),
            );

            await service.getCloneParams({
                organizationAndTeamData: {
                    organizationId: 'org-1',
                    teamId: 'team-2',
                },
                repository: {
                    id: 'repo-6',
                    name: 'repo',
                    fullName: 'group/repo',
                    defaultBranch: 'main',
                },
            });

            expect(cacheService.getFromCache).toHaveBeenCalledWith(
                'gitlab-project-path-org-1-team-2-https://gitlab.example.com-repo-6',
            );
        });

        // The clone URL and API client both normalize the host through
        // getGitlabWebBaseUrl; the cache key must go through the same
        // normalization or `gitlab.example.com`, `https://gitlab.example.com`
        // and a trailing-slash variant each produce their own entry for the
        // same instance, missing the cache on every raw-string mismatch.
        it('shares one cache entry across raw host variants of the same instance', async () => {
            mockProjectsShow(
                jest.fn().mockResolvedValue({
                    path_with_namespace: 'group/repo',
                }),
            );

            for (const host of [
                'gitlab.example.com',
                'https://gitlab.example.com',
                'https://gitlab.example.com/',
            ]) {
                jest.spyOn(service as any, 'getAuthDetails').mockResolvedValue(
                    {
                        accessToken: 'oauth-token',
                        authMode: AuthMode.OAUTH,
                        host,
                    },
                );

                await service.getCloneParams({
                    organizationAndTeamData,
                    repository: {
                        id: 'repo-8',
                        name: 'repo',
                        fullName: 'group/repo',
                        defaultBranch: 'main',
                    },
                });
            }

            const keysUsed = new Set(
                cacheService.getFromCache.mock.calls.map((call) => call[0]),
            );
            expect(keysUsed).toEqual(
                new Set([
                    'gitlab-project-path-org-1-team-1-https://gitlab.example.com-repo-8',
                ]),
            );
        });

        // A failed lookup must not be cached — caching the fullName fallback
        // would keep retrying the stored (possibly wrong) path for the full
        // TTL instead of the API on the very next clone.
        it('does not cache the fallback when the project lookup fails', async () => {
            mockAuthDetails();
            mockProjectsShow(
                jest.fn().mockRejectedValue(new Error('404 Not Found')),
            );

            await service.getCloneParams({
                organizationAndTeamData,
                repository: {
                    id: 'repo-7',
                    name: 'repo',
                    fullName: 'group/repo',
                    defaultBranch: 'main',
                },
            });

            expect(cacheService.addToCache).not.toHaveBeenCalled();
        });
    });

    describe('getPullRequest draft detection', () => {
        const repository = {
            id: 'repo-1',
            name: 'repo',
            default_branch: 'main',
        };

        const getPullRequest = async (mergeRequest: object) => {
            Object.defineProperty(service, 'getAuthDetails', {
                value: jest.fn().mockResolvedValue({
                    accessToken: 'oauth-token',
                    authMode: AuthMode.OAUTH,
                }),
            });

            mockedAxios.get.mockResolvedValue({ data: mergeRequest });

            return service.getPullRequest({
                organizationAndTeamData,
                repository,
                prNumber: 1,
            });
        };

        it('maps draft null and work_in_progress true to draft', async () => {
            const result = await getPullRequest({
                id: 1,
                iid: 1,
                draft: null,
                work_in_progress: true,
            });

            expect(result?.isDraft).toBe(true);
        });

        it('maps omitted draft and work_in_progress true to draft', async () => {
            const result = await getPullRequest({
                id: 1,
                iid: 1,
                work_in_progress: true,
            });

            expect(result?.isDraft).toBe(true);
        });

        it('prefers explicit draft false over work_in_progress true', async () => {
            const result = await getPullRequest({
                id: 1,
                iid: 1,
                draft: false,
                work_in_progress: true,
            });

            expect(result?.isDraft).toBe(false);
        });

        it('passes the reconciliation abort signal to the GitLab request', async () => {
            const controller = new AbortController();
            Object.defineProperty(service, 'getAuthDetails', {
                value: jest.fn().mockResolvedValue({
                    accessToken: 'oauth-token',
                    authMode: AuthMode.OAUTH,
                }),
            });
            mockedAxios.get.mockResolvedValue({
                data: { id: 1, iid: 1, draft: false },
            });

            await service.getPullRequest({
                organizationAndTeamData,
                repository,
                prNumber: 1,
                signal: controller.signal,
            });

            expect(mockedAxios.get).toHaveBeenCalledWith(
                expect.stringContaining('/merge_requests/1'),
                expect.objectContaining({ signal: controller.signal }),
            );
        });
    });
});
