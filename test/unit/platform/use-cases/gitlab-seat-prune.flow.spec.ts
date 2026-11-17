jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    }),
}));

import { OrganizationMemberListService } from '@libs/platform/application/services/organization-member-list.service';
import { GetCodeManagementMemberListUseCase } from '@libs/platform/application/use-cases/codeManagement/get-code-management-members-list.use-case';
import { PruneRemovedLicenseSeatsUseCase } from '@libs/platform/application/use-cases/codeManagement/prune-removed-license-seats.use-case';
import { GitlabService } from '@libs/platform/infrastructure/adapters/services/gitlab.service';

const httpError = (status: number) =>
    Object.assign(new Error(`HTTP ${status}`), {
        cause: { response: { status } },
    });

/**
 * The real chain from the GitLab adapter through the member list to the
 * Licenses page and the seat prune. Only what leaves the process is faked:
 * the GitLab API, the stored pull requests, the seat store and the cache.
 *
 * Seats: Alice (1) and Carol (3) are members; A (66) is a deleted account
 * that still authors a recent stored PR, so its lookup returns 404; B (77)
 * genuinely left and appears nowhere.
 */
describe('GitLab seat prune, adapter to revocation', () => {
    const organizationAndTeamData = {
        organizationId: 'org-1',
        teamId: 'team-1',
    };

    let gitlabAPI: {
        Projects: { allUsers: jest.Mock };
        Users: { show: jest.Mock };
    };
    let cache: Map<string, unknown>;
    let licenseService: {
        getAllUsersWithLicense: jest.Mock;
        unassignLicenses: jest.Mock;
    };
    let page: GetCodeManagementMemberListUseCase;
    let prune: PruneRemovedLicenseSeatsUseCase;

    const membersByRepository = {
        10: [{ id: 1, name: 'Alice' }],
        20: [{ id: 3, name: 'Carol' }],
    };

    const rateLimitRepository = (repositoryId: number | null) =>
        gitlabAPI.Projects.allUsers.mockImplementation(async (id: number) => {
            if (id === repositoryId) throw httpError(429);
            return membersByRepository[id];
        });

    beforeEach(() => {
        gitlabAPI = {
            Projects: { allUsers: jest.fn() },
            Users: {
                show: jest.fn(async (id: number) => {
                    if (id === 66) throw httpError(404);
                    return { bot: false };
                }),
            },
        };
        rateLimitRepository(null);

        const pullRequestsService = {
            findPullRequestAuthorsOpenedSince: jest.fn().mockResolvedValue([
                { id: '1', name: 'Alice', username: 'alice' },
                { id: '66', name: 'Gone', username: 'gone' },
            ]),
            hasStoredPullRequests: jest.fn().mockResolvedValue(true),
        };

        const gitlab = new GitlabService(
            {
                findOne: jest.fn().mockResolvedValue({ uuid: 'integration-1' }),
            } as any,
            {
                findOne: jest.fn().mockResolvedValue({
                    configValue: [{ id: 10 }, { id: 20 }],
                }),
            } as any,
            {} as any,
            {} as any,
            {} as any,
            undefined,
            { get: jest.fn(() => pullRequestsService) } as any,
        );
        jest.spyOn(gitlab as any, 'getAuthDetails').mockResolvedValue({
            accessToken: 'token',
        });
        jest.spyOn(gitlab as any, 'instanceGitlabApi').mockReturnValue(
            gitlabAPI,
        );
        jest.spyOn(
            gitlab as any,
            'findOneByOrganizationAndTeamDataAndConfigKey',
        ).mockResolvedValue([{ id: 10 }, { id: 20 }]);

        const codeManagementService = {
            getListMembers: (params) => gitlab.getListMembers(params),
            getPullRequestAuthors: (params) =>
                gitlab.getPullRequestAuthors(params),
            getTypeIntegration: jest.fn().mockResolvedValue('gitlab'),
        };

        cache = new Map();
        const cacheService = {
            getFromCache: jest.fn(async (key: string) => cache.get(key)),
            addToCache: jest.fn(async (key: string, value: unknown) => {
                cache.set(key, value);
            }),
            removeFromCache: jest.fn(async (key: string) => {
                cache.delete(key);
            }),
        };

        licenseService = {
            getAllUsersWithLicense: jest
                .fn()
                .mockResolvedValue([
                    { git_id: '1' },
                    { git_id: '3' },
                    { git_id: '66' },
                    { git_id: '77' },
                ]),
            unassignLicenses: jest.fn(async (_org, gitIds: string[]) => ({
                revoked: [...gitIds],
                failed: [],
            })),
        };

        const memberList = new OrganizationMemberListService(
            codeManagementService as any,
            cacheService as any,
        );
        page = new GetCodeManagementMemberListUseCase(
            memberList,
            cacheService as any,
            { user: { organization: { uuid: 'org-1' } } } as any,
        );
        prune = new PruneRemovedLicenseSeatsUseCase(
            memberList,
            codeManagementService as any,
            licenseService as any,
            { findByKey: jest.fn().mockResolvedValue(undefined) } as any,
        );
    });

    const memberCacheKeys = () =>
        [...cache.keys()].filter((key) => key.startsWith('org_members_'));

    it('revokes B and keeps A when the member read is complete and A’s lookup returns 404', async () => {
        const result = await prune.execute({ organizationAndTeamData });

        expect(result).toEqual({
            status: 'ok',
            candidates: ['77'],
            revoked: ['77'],
            failed: [],
        });
    });

    it('revokes nothing and caches no member list while one repository is rate limited', async () => {
        rateLimitRepository(20);

        const listed = await page.execute('team-1');
        const pruned = await prune.execute({ organizationAndTeamData });

        expect(listed).toEqual(
            expect.objectContaining({ status: 'ok', complete: false }),
        );
        expect(memberCacheKeys()).toEqual([]);
        expect(pruned.status).toBe('members_unavailable');
        expect(licenseService.unassignLicenses).not.toHaveBeenCalled();
    });

    it('identifies the real removal again once GitLab recovers, without waiting for A’s PR to age out', async () => {
        rateLimitRepository(20);
        await page.execute('team-1');
        await prune.execute({ organizationAndTeamData });

        rateLimitRepository(null);
        const listed = await page.execute('team-1');
        const pruned = await prune.execute({ organizationAndTeamData });

        expect(listed).toEqual(
            expect.objectContaining({ status: 'ok', complete: true }),
        );
        expect(memberCacheKeys()).toHaveLength(1);
        expect(pruned.revoked).toEqual(['77']);
    });
});
