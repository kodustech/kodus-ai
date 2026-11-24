import { GetCodeManagementMemberListUseCase } from '@libs/platform/application/use-cases/codeManagement/get-code-management-members-list.use-case';

jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({ log: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

const build = () => {
    const memberList = {
        fetch: jest.fn().mockResolvedValue({
            status: 'ok',
            complete: true,
            members: [{ id: 1 }],
        }),
    };
    const cache = {
        getFromCache: jest.fn().mockResolvedValue(null),
        addToCache: jest.fn().mockResolvedValue(undefined),
        removeFromCache: jest.fn().mockResolvedValue(undefined),
    };
    const useCase = new GetCodeManagementMemberListUseCase(
        memberList as any,
        cache as any,
        { user: { organization: { uuid: 'org-1' } } } as any,
    );
    return { useCase, memberList, cache };
};

describe('GetCodeManagementMemberListUseCase per Git connection', () => {
    it("lists the named connection's members and caches them apart", async () => {
        const { useCase, memberList, cache } = build();

        await useCase.execute('team-1', {}, 'gl-b');

        expect(memberList.fetch).toHaveBeenCalledWith(
            { organizationId: 'org-1', teamId: 'team-1', integrationId: 'gl-b' },
            {},
        );
        expect(cache.addToCache).toHaveBeenCalledWith(
            'org_members_v3_org-1_team-1_gl-b',
            expect.anything(),
            expect.any(Number),
        );
    });

    it('refreshes the named connection only', async () => {
        const { useCase, cache } = build();

        await useCase.refreshMembers('team-1', 'gl-b');

        expect(cache.removeFromCache).toHaveBeenCalledWith(
            'org_members_v3_org-1_team-1_gl-b',
        );
    });
});
