import { ManageImportedKodyRulesUseCase } from './manage-imported-kody-rules.use-case';

describe('ManageImportedKodyRulesUseCase.count', () => {
    const ORG = { organizationId: 'org-1', teamId: 'team-1' };
    const counts = { active: 2, paused: 0, deleted: 0 };

    const build = () => {
        const syncService = {
            countIdeSyncRulesForRepository: jest.fn().mockResolvedValue(counts),
        };
        const useCase = new ManageImportedKodyRulesUseCase(
            syncService as any,
            {} as any,
            undefined as any,
        );
        return { useCase, syncService };
    };

    it('counts the coding-agent rules stored at the global scope for repositoryId "global"', async () => {
        const { useCase, syncService } = build();

        await expect(
            useCase.count({
                organizationAndTeamData: ORG,
                repositoryId: 'global',
            }),
        ).resolves.toEqual(counts);
        expect(syncService.countIdeSyncRulesForRepository).toHaveBeenCalledWith(
            { organizationAndTeamData: ORG, repositoryId: 'global' },
        );
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
