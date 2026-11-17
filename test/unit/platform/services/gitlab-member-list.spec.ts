jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    }),
}));

import { GitlabService } from '@libs/platform/infrastructure/adapters/services/gitlab.service';

const httpError = (status: number) =>
    Object.assign(new Error(`HTTP ${status}`), {
        cause: { response: { status } },
    });

describe('GitlabService member and author lists', () => {
    const organizationAndTeamData = {
        organizationId: 'org-1',
        teamId: 'team-1',
    };

    let service: GitlabService;
    let gitlabAPI: {
        Projects: { allUsers: jest.Mock };
        Users: { show: jest.Mock };
        MergeRequests: { all: jest.Mock };
    };
    let pullRequestsService: {
        findPullRequestAuthorsOpenedSince: jest.Mock;
        hasStoredPullRequests: jest.Mock;
    };

    beforeEach(() => {
        gitlabAPI = {
            Projects: { allUsers: jest.fn() },
            Users: { show: jest.fn().mockResolvedValue({ bot: false }) },
            MergeRequests: { all: jest.fn() },
        };
        pullRequestsService = {
            findPullRequestAuthorsOpenedSince: jest.fn().mockResolvedValue([]),
            hasStoredPullRequests: jest.fn().mockResolvedValue(true),
        };

        const integrationService = {
            findOne: jest.fn().mockResolvedValue({ uuid: 'integration-1' }),
        };
        const integrationConfigService = {
            findOne: jest.fn().mockResolvedValue({
                configValue: [{ id: 10 }, { id: 20 }],
            }),
        };
        const moduleRef = { get: jest.fn(() => pullRequestsService) };

        service = new GitlabService(
            integrationService as any,
            integrationConfigService as any,
            {} as any,
            {} as any,
            {} as any,
            undefined,
            moduleRef as any,
        );

        jest.spyOn(service as any, 'getAuthDetails').mockResolvedValue({
            accessToken: 'token',
        });
        jest.spyOn(service as any, 'instanceGitlabApi').mockReturnValue(
            gitlabAPI,
        );
        jest.spyOn(
            service as any,
            'findOneByOrganizationAndTeamDataAndConfigKey',
        ).mockResolvedValue([{ id: 10 }, { id: 20 }]);
    });

    describe('getListMembers', () => {
        it('rejects when one repository cannot be listed and the caller needs a complete list', async () => {
            gitlabAPI.Projects.allUsers
                .mockResolvedValueOnce([{ id: 1, name: 'Alice' }])
                .mockRejectedValueOnce(httpError(429));

            await expect(
                service.getListMembers({
                    organizationAndTeamData,
                    determineBots: true,
                    requireComplete: true,
                }),
            ).rejects.toThrow('HTTP 429');
        });

        it('still returns what it collected for callers that accept a partial list', async () => {
            gitlabAPI.Projects.allUsers
                .mockResolvedValueOnce([{ id: 1, name: 'Alice' }])
                .mockRejectedValueOnce(httpError(429));

            const members = await service.getListMembers({
                organizationAndTeamData,
            });

            expect(members).toEqual([{ id: 1, name: 'Alice', type: 'user' }]);
        });

        it('looks each user up once, however many repositories list them', async () => {
            gitlabAPI.Projects.allUsers
                .mockResolvedValueOnce([
                    { id: 1, name: 'Alice' },
                    { id: 2, name: 'ci' },
                ])
                .mockResolvedValueOnce([{ id: 1, name: 'Alice' }]);
            gitlabAPI.Users.show.mockImplementation(async (id: number) => ({
                bot: id === 2,
            }));

            const members = await service.getListMembers({
                organizationAndTeamData,
                determineBots: true,
                requireComplete: true,
            });

            expect(gitlabAPI.Users.show).toHaveBeenCalledTimes(2);
            expect(members).toEqual([
                { id: 1, name: 'Alice', type: 'user' },
                { id: 2, name: 'ci', type: 'bot' },
            ]);
        });

        it('keeps a member whose lookup returns 404 as an unclassified user', async () => {
            gitlabAPI.Projects.allUsers.mockResolvedValue([
                { id: 1, name: 'Alice' },
            ]);
            gitlabAPI.Users.show.mockRejectedValue(httpError(404));

            const members = await service.getListMembers({
                organizationAndTeamData,
                determineBots: true,
                requireComplete: true,
            });

            expect(members).toEqual([{ id: 1, name: 'Alice', type: 'user' }]);
        });

        it('rejects when a user lookup is rate limited', async () => {
            gitlabAPI.Projects.allUsers.mockResolvedValue([
                { id: 1, name: 'Alice' },
            ]);
            gitlabAPI.Users.show.mockRejectedValue(httpError(429));

            await expect(
                service.getListMembers({
                    organizationAndTeamData,
                    determineBots: true,
                    requireComplete: true,
                }),
            ).rejects.toThrow('HTTP 429');
        });
    });

    describe('getPullRequestAuthors', () => {
        it('reads authors from stored pull requests, not the merge request API', async () => {
            pullRequestsService.findPullRequestAuthorsOpenedSince.mockResolvedValue(
                [
                    { id: '7', name: 'Bob', username: 'bob' },
                    { id: '8', name: '', username: 'carol' },
                ],
            );

            const authors = await service.getPullRequestAuthors({
                organizationAndTeamData,
                requireLoaded: true,
            });

            expect(gitlabAPI.MergeRequests.all).not.toHaveBeenCalled();
            expect(gitlabAPI.Users.show).not.toHaveBeenCalled();
            expect(
                pullRequestsService.findPullRequestAuthorsOpenedSince,
            ).toHaveBeenCalledWith(expect.any(String), 'org-1', ['10', '20']);
            expect(authors).toEqual([
                { id: '7', name: 'Bob', type: 'user' },
                { id: '8', name: 'carol', type: 'user' },
            ]);
        });

        it('identifies bots with one lookup per author', async () => {
            pullRequestsService.findPullRequestAuthorsOpenedSince.mockResolvedValue(
                [
                    { id: '7', name: 'Bob', username: 'bob' },
                    { id: '9', name: 'renovate', username: 'renovate' },
                ],
            );
            gitlabAPI.Users.show.mockImplementation(async (id: number) => ({
                bot: id === 9,
            }));

            const authors = await service.getPullRequestAuthors({
                organizationAndTeamData,
                determineBots: true,
                requireLoaded: true,
            });

            expect(gitlabAPI.Users.show).toHaveBeenCalledTimes(2);
            expect(authors).toEqual([
                { id: '7', name: 'Bob', type: 'user' },
                { id: '9', name: 'renovate', type: 'bot' },
            ]);
        });

        // A deleted account keeps authoring its stored PRs; one such id must
        // not block cleanup for everyone else.
        it('keeps an author whose lookup returns 404 and still answers', async () => {
            pullRequestsService.findPullRequestAuthorsOpenedSince.mockResolvedValue(
                [
                    { id: '7', name: 'Bob', username: 'bob' },
                    { id: '66', name: 'Gone', username: 'gone' },
                ],
            );
            gitlabAPI.Users.show.mockImplementation(async (id: number) => {
                if (id === 66) throw httpError(404);
                return { bot: false };
            });

            const authors = await service.getPullRequestAuthors({
                organizationAndTeamData,
                determineBots: true,
                requireLoaded: true,
            });

            expect(authors).toEqual([
                { id: '7', name: 'Bob', type: 'user' },
                { id: '66', name: 'Gone', type: 'user' },
            ]);
        });

        it.each([429, 500])(
            'rejects on a %i user lookup when the caller revokes on absence, answers [] otherwise',
            async (status) => {
                pullRequestsService.findPullRequestAuthorsOpenedSince.mockResolvedValue(
                    [{ id: '7', name: 'Bob', username: 'bob' }],
                );
                gitlabAPI.Users.show.mockRejectedValue(httpError(status));

                await expect(
                    service.getPullRequestAuthors({
                        organizationAndTeamData,
                        determineBots: true,
                        requireLoaded: true,
                    }),
                ).rejects.toThrow(`HTTP ${status}`);

                await expect(
                    service.getPullRequestAuthors({
                        organizationAndTeamData,
                        determineBots: true,
                    }),
                ).resolves.toEqual([]);
            },
        );

        it('rejects when nothing was stored yet for the configured repositories', async () => {
            pullRequestsService.hasStoredPullRequests.mockResolvedValue(false);

            await expect(
                service.getPullRequestAuthors({
                    organizationAndTeamData,
                    requireLoaded: true,
                }),
            ).rejects.toThrow('No pull requests stored yet');
        });

        it('answers [] when PRs are stored but none is recent', async () => {
            await expect(
                service.getPullRequestAuthors({
                    organizationAndTeamData,
                    requireLoaded: true,
                }),
            ).resolves.toEqual([]);
        });

        // Accepted in the design: stored authors count as loaded once any
        // selected repository has stored PRs, even if another has none yet.
        it('trusts stored authors when only some repositories have stored PRs', async () => {
            pullRequestsService.findPullRequestAuthorsOpenedSince.mockResolvedValue(
                [{ id: '7', name: 'Bob', username: 'bob' }],
            );

            const authors = await service.getPullRequestAuthors({
                organizationAndTeamData,
                requireLoaded: true,
            });

            expect(authors).toEqual([{ id: '7', name: 'Bob', type: 'user' }]);
            expect(
                pullRequestsService.hasStoredPullRequests,
            ).not.toHaveBeenCalled();
        });
    });

    describe('getPullRequestsByRepository', () => {
        // The PR backfill reads the GitHub-shaped fields; without them every
        // GitLab merge request was stored with no author, title or dates.
        it('emits author, title and dates in the shape shared code reads', async () => {
            gitlabAPI.MergeRequests.all.mockResolvedValue([
                {
                    id: 500,
                    iid: 3,
                    project_id: 10,
                    title: 'Fix login',
                    state: 'merged',
                    author: { id: 7, username: 'bob', name: 'Bob' },
                    created_at: '2026-10-01T10:00:00Z',
                    updated_at: '2026-10-02T10:00:00Z',
                    merged_at: '2026-10-02T09:00:00Z',
                    closed_at: null,
                    web_url: 'https://gitlab.example/g/r/-/merge_requests/3',
                },
            ]);

            const [pr] = await service.getPullRequestsByRepository({
                organizationAndTeamData,
                repository: { id: '10', name: 'r' },
            });

            expect(pr).toEqual(
                expect.objectContaining({
                    number: 3,
                    title: 'Fix login',
                    user: { id: '7', login: 'bob', name: 'Bob' },
                    created_at: '2026-10-01T10:00:00Z',
                    merged_at: '2026-10-02T09:00:00Z',
                    closed_at: '2026-10-02T09:00:00Z',
                }),
            );
        });
    });

    describe('findRecentPullRequestAuthors', () => {
        it('answers the ids that opened a merge request on a configured project', async () => {
            gitlabAPI.MergeRequests.all.mockImplementation(
                async ({ authorId }: { authorId: number }) =>
                    ({
                        7: [
                            { project_id: 99 },
                            { project_id: 20, author: { name: 'Bob' } },
                        ],
                        8: [{ project_id: 99 }],
                    })[authorId] ?? [],
            );

            const authors = await service.findRecentPullRequestAuthors({
                organizationAndTeamData,
                authorIds: ['7', '8', '9', '7', 'abc'],
            });

            expect(gitlabAPI.MergeRequests.all).toHaveBeenCalledTimes(3);
            expect(gitlabAPI.MergeRequests.all).toHaveBeenCalledWith(
                expect.objectContaining({
                    authorId: 7,
                    scope: 'all',
                    createdAfter: expect.any(String),
                }),
            );
            expect(authors).toEqual([{ id: '7', name: 'Bob', type: 'user' }]);
        });

        it('rejects when a search is rate limited', async () => {
            gitlabAPI.MergeRequests.all.mockRejectedValue(httpError(429));

            await expect(
                service.findRecentPullRequestAuthors({
                    organizationAndTeamData,
                    authorIds: ['7'],
                }),
            ).rejects.toThrow('HTTP 429');
        });
    });
});
