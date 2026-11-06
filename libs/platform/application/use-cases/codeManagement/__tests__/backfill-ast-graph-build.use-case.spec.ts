import { BackfillAstGraphBuildUseCase } from '../backfill-ast-graph-build.use-case';

describe('BackfillAstGraphBuildUseCase', () => {
    it('links the repository row to the repositories integration config, not the team', async () => {
        const repositoryService = {
            findOrCreate: jest.fn().mockResolvedValue({
                uuid: 'r',
                astGraphStatus: 'pending',
                defaultBranch: 'main',
                fullName: 'kodus/alpha',
                platform: 'gitlab',
            }),
        };

        const useCase = new BackfillAstGraphBuildUseCase(
            { enqueue: jest.fn().mockResolvedValue('job-1') } as any,
            {
                findIntegrationConfigFormatted: jest
                    .fn()
                    .mockResolvedValue([{ id: 'repo-1', name: 'alpha' }]),
                findOneIntegrationConfigWithIntegrations: jest
                    .fn()
                    .mockResolvedValue({
                        uuid: 'config-1',
                        integration: { platform: 'gitlab' },
                    }),
            } as any,
            repositoryService as any,
        );

        await useCase.execute({ organizationId: 'org-1', teamId: 'team-1' });

        expect(repositoryService.findOrCreate).toHaveBeenCalledWith(
            expect.objectContaining({ integrationConfigId: 'config-1' }),
        );
    });
});
