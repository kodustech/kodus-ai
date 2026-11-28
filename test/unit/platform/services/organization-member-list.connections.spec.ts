import { OrganizationMemberListService } from '@libs/platform/application/services/organization-member-list.service';

jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    }),
}));

const ORG_TEAM = { organizationId: 'org-1', teamId: 'team-1' };

const build = (
    membersByConnection: Record<
        string,
        Array<{ id: string; name: string }> | 'fail'
    >,
) => {
    const codeManagementService = {
        getListMembers: jest.fn(async (params: any) => {
            const members =
                membersByConnection[
                    params.organizationAndTeamData.integrationId
                ];
            if (members === 'fail') throw new Error('provider down');
            return members ?? [];
        }),
        getPullRequestAuthors: jest.fn().mockResolvedValue([]),
        canFindRecentPullRequestAuthors: jest.fn().mockResolvedValue(false),
        findRecentPullRequestAuthors: jest.fn().mockResolvedValue([]),
    };
    const integrationService = {
        find: jest.fn(async () =>
            Object.keys(membersByConnection).map((uuid) => ({ uuid })),
        ),
    };
    const service = new OrganizationMemberListService(
        codeManagementService as any,
        {
            getFromCache: jest.fn().mockResolvedValue(null),
            addToCache: jest.fn(),
            removeFromCache: jest.fn().mockResolvedValue(undefined),
        } as any,
        { getAllUsersWithLicense: jest.fn().mockResolvedValue([]) } as any,
        integrationService as any,
    );
    return { service, codeManagementService };
};

describe('OrganizationMemberListService — several Git connections', () => {
    it('lists the members of every connection of the workspace', async () => {
        const { service, codeManagementService } = build({
            'gh-a': [{ id: '1', name: 'ana' }],
            'gl-b': [{ id: '2', name: 'bo' }],
        });

        const result = await service.fetch(ORG_TEAM);

        expect(codeManagementService.getListMembers).toHaveBeenCalledTimes(2);
        expect(result.status).toBe('ok');
        expect(result.members.map((m) => String(m.id)).sort()).toEqual([
            '1',
            '2',
        ]);
    });

    it('is unavailable when any connection cannot be read, so no seat is pruned on a partial list', async () => {
        const { service } = build({
            'gh-a': [{ id: '1', name: 'ana' }],
            'gl-b': 'fail',
        });

        const result = await service.fetch(ORG_TEAM, { requireAuthors: true });

        expect(result.status).toBe('unavailable');
    });

    it('reads only the named connection', async () => {
        const { service, codeManagementService } = build({
            'gh-a': [{ id: '1', name: 'ana' }],
            'gl-b': [{ id: '2', name: 'bo' }],
        });

        const result = await service.fetch({
            ...ORG_TEAM,
            integrationId: 'gl-b',
        });

        expect(codeManagementService.getListMembers).toHaveBeenCalledTimes(1);
        expect(result.members.map((m) => String(m.id))).toEqual(['2']);
    });
});
