import { ManageImportedKodyRulesUseCase } from './manage-imported-kody-rules.use-case';

describe('ManageImportedKodyRulesUseCase.count', () => {
    const ORG = { organizationId: 'org-1', teamId: 'team-1' };
    const counts = { active: 2, paused: 0, deleted: 0, pinned: 0 };

    const build = () => {
        const syncService = {
            countIdeSyncRulesForRepository: jest.fn().mockResolvedValue(counts),
            countIdeSyncRulesInheritingGlobal: jest
                .fn()
                .mockResolvedValue(counts),
        };
        const useCase = new ManageImportedKodyRulesUseCase(
            syncService as any,
            {} as any,
            undefined as any,
        );
        return { useCase, syncService };
    };

    it('counts across the repos inheriting from global for repositoryId "global"', async () => {
        const { useCase, syncService } = build();

        await expect(
            useCase.count({
                organizationAndTeamData: ORG,
                repositoryId: 'global',
            }),
        ).resolves.toEqual(counts);
        expect(
            syncService.countIdeSyncRulesInheritingGlobal,
        ).toHaveBeenCalledWith(ORG);
        expect(
            syncService.countIdeSyncRulesForRepository,
        ).not.toHaveBeenCalled();
    });

    it('rejects a global count without a team, since the config is team-scoped', async () => {
        const { useCase, syncService } = build();

        await expect(
            useCase.count({
                organizationAndTeamData: { organizationId: 'org-1' },
                repositoryId: 'global',
            }),
        ).rejects.toThrow('teamId is required');
        expect(
            syncService.countIdeSyncRulesInheritingGlobal,
        ).not.toHaveBeenCalled();
    });

    it('counts a single repository otherwise', async () => {
        const { useCase, syncService } = build();

        await useCase.count({
            organizationAndTeamData: ORG,
            repositoryId: 'repo-1',
        });

        expect(syncService.countIdeSyncRulesForRepository).toHaveBeenCalledWith(
            {
                organizationAndTeamData: ORG,
                repositoryId: 'repo-1',
            },
        );
    });
});
