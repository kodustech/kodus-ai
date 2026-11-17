import { GithubService } from './github/github.service';
import { GitlabService } from './gitlab.service';
import { AzureReposRequestHelper } from './azureRepos/azure-repos-request-helper';
import { CodeManagementService } from './codeManagement.service';

jest.mock('@libs/mcp-server/services/mcp-manager.service', () => ({
    MCPManagerService: jest.fn(),
}));
const params = {
    organizationAndTeamData: { organizationId: 'org', teamId: 'team' },
    repository: { id: 'repo', name: 'api' },
    team: 'acme/backend',
    author: 'alice',
};

describe('native approval team membership', () => {
    const github = () => {
        const service = Object.create(GithubService.prototype) as GithubService;
        const getByName = jest.fn().mockResolvedValue({ data: { id: 1 } });
        const getMembershipForUserInOrg = jest
            .fn()
            .mockResolvedValue({ data: { state: 'active' } });
        (service as any).getGithubAuthDetails = jest
            .fn()
            .mockResolvedValue({ org: 'acme', accountType: 'organization' });
        (service as any).instanceOctokit = jest.fn().mockResolvedValue({
            rest: { teams: { getByName, getMembershipForUserInOrg } },
        });
        return { service, getByName, getMembershipForUserInOrg };
    };

    it('uses native GitHub membership, accepting active members only', async () => {
        const { service, getMembershipForUserInOrg } = github();
        expect(await service.getApprovalTeamMembership(params)).toBe('member');
        expect(getMembershipForUserInOrg).toHaveBeenCalledWith({
            org: 'acme',
            team_slug: 'backend',
            username: 'alice',
        });
        getMembershipForUserInOrg.mockResolvedValue({
            data: { state: 'pending' },
        });
        expect(await service.getApprovalTeamMembership(params)).toBe(
            'not-member',
        );
    });

    it('treats GitHub membership 404 as no match only after verifying team visibility', async () => {
        const { service, getByName, getMembershipForUserInOrg } = github();
        getMembershipForUserInOrg.mockRejectedValue({ status: 404 });
        expect(await service.getApprovalTeamMembership(params)).toBe(
            'not-member',
        );
        getByName.mockRejectedValue({ status: 404 });
        expect(await service.getApprovalTeamMembership(params)).toBe(
            'unavailable',
        );
        expect(getMembershipForUserInOrg).toHaveBeenCalledTimes(1);
    });

    it.each([401, 403, 429, 500])(
        'keeps GitHub permission or transport failure %p unknown',
        async (status) => {
            const { service, getMembershipForUserInOrg } = github();
            getMembershipForUserInOrg.mockRejectedValue({ status });
            expect(await service.getApprovalTeamMembership(params)).toBe(
                'unavailable',
            );
        },
    );

    it('never queries another GitHub organization through this integration', async () => {
        const { service, getByName } = github();
        expect(
            await service.getApprovalTeamMembership({
                ...params,
                team: 'other/backend',
            }),
        ).toBe('unavailable');
        expect(getByName).not.toHaveBeenCalled();
    });

    const gitlab = () => {
        const service = Object.create(GitlabService.prototype) as GitlabService;
        const show = jest
            .fn()
            .mockResolvedValue({ state: 'active', access_level: 30 });
        const groups = jest.fn().mockResolvedValue({ id: 42 });
        (service as any).getAuthDetails = jest
            .fn()
            .mockResolvedValue({ accessToken: 'opaque' });
        (service as any).instanceGitlabApi = jest.fn().mockReturnValue({
            Groups: { show: groups },
            Users: {
                all: jest
                    .fn()
                    .mockResolvedValue([{ id: 7, username: 'Alice' }]),
            },
            GroupMembers: { show },
        });
        return { service, show, groups };
    };

    it('asks GitLab for inherited native group membership for the exact username', async () => {
        const { service, show } = gitlab();
        expect(await service.getApprovalTeamMembership(params)).toBe('member');
        expect(show).toHaveBeenCalledWith(42, 7, { includeInherited: true });
    });

    it.each([
        { state: 'blocked', access_level: 30 },
        { state: 'active', access_level: 0 },
        { state: 'active', access_level: 30, expires_at: '2000-01-01' },
    ])(
        'does not accept blocked, expired or zero-access GitLab membership: %j',
        async (member) => {
            const { service, show } = gitlab();
            show.mockResolvedValue(member);
            expect(await service.getApprovalTeamMembership(params)).toBe(
                'not-member',
            );
        },
    );

    it('distinguishes a nonmember from an inaccessible GitLab group', async () => {
        const { service, show, groups } = gitlab();
        show.mockRejectedValue({ response: { status: 404 } });
        expect(await service.getApprovalTeamMembership(params)).toBe(
            'not-member',
        );
        groups.mockRejectedValue({ response: { status: 404 } });
        expect(await service.getApprovalTeamMembership(params)).toBe(
            'unavailable',
        );
    });

    const azure = () => {
        const helper = new AzureReposRequestHelper();
        const get = jest.fn();
        (helper as any).azureRequest = jest.fn().mockResolvedValue({ get });
        return {
            helper,
            get,
            input: {
                orgName: 'acme',
                token: 'opaque',
                projectId: 'project',
                team: 'Backend',
                author: 'alice@acme.com',
            },
        };
    };

    it('reads every Azure team page before declaring a user absent', async () => {
        const { helper, get, input } = azure();
        get.mockResolvedValueOnce({
            data: {
                value: Array.from({ length: 100 }, (_, i) => ({
                    identity: { uniqueName: `user${i}@acme.com` },
                })),
            },
        }).mockResolvedValueOnce({
            data: { value: [{ identity: { uniqueName: 'ALICE@ACME.COM' } }] },
        });
        expect(await helper.getApprovalTeamMembership(input)).toBe('member');
        expect(get).toHaveBeenNthCalledWith(
            2,
            expect.stringContaining('/teams/Backend/members'),
            expect.objectContaining({
                params: expect.objectContaining({ $skip: 100 }),
            }),
        );
    });

    it('does not treat an unexpanded Azure group as proof of nonmembership', async () => {
        const { helper, get, input } = azure();
        get.mockResolvedValue({
            data: {
                value: [
                    { identity: { uniqueName: 'Group', isContainer: true } },
                ],
            },
        });
        expect(await helper.getApprovalTeamMembership(input)).toBe(
            'unavailable',
        );
        get.mockResolvedValue({ data: { value: [] } });
        expect(await helper.getApprovalTeamMembership(input)).toBe(
            'not-member',
        );
    });

    it('keeps unsupported or unreachable provider membership unknown in the facade', async () => {
        const facade = Object.create(
            CodeManagementService.prototype,
        ) as CodeManagementService;
        (facade as any).getTypeIntegration = jest
            .fn()
            .mockResolvedValue('provider');
        (facade as any).platformIntegrationFactory = {
            getCodeManagementService: jest.fn().mockReturnValue({}),
        };
        expect(await facade.getApprovalTeamMembership(params)).toBe(
            'unavailable',
        );
        (
            facade as any
        ).platformIntegrationFactory.getCodeManagementService.mockReturnValue({
            getApprovalTeamMembership: async () => {
                throw new Error('403');
            },
        });
        expect(await facade.getApprovalTeamMembership(params)).toBe(
            'unavailable',
        );
    });
});
