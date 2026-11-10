import { IntegrationConfigKey } from '@libs/core/domain/enums/Integration-config-key.enum';

import {
    GetRepositorySelectionUseCase,
    SetRepositorySelectionUseCase,
} from '../repository-selection.use-cases';

const orgTeam = { organizationId: 'org-1', teamId: 'team-1' };

describe('SetRepositorySelectionUseCase', () => {
    const build = (integration: unknown = { uuid: 'int-1' }) => {
        const integrationConfigService = {
            createOrUpdateConfig: jest.fn().mockResolvedValue({}),
        };
        const integrationService = {
            findOne: jest.fn().mockResolvedValue(integration),
        };
        const sync = { syncTeam: jest.fn().mockResolvedValue(undefined) };
        const useCase = new SetRepositorySelectionUseCase(
            integrationConfigService as any,
            integrationService as any,
            sync as any,
        );
        return { useCase, integrationConfigService, sync };
    };

    it('stores the choice on the team integration and starts the first sync when enabling', async () => {
        const { useCase, integrationConfigService, sync } = build();

        await useCase.execute({
            organizationAndTeamData: orgTeam,
            mode: 'all',
            includeForksAndMirrors: true,
            actorUserId: 'user-1',
        });

        expect(integrationConfigService.createOrUpdateConfig).toHaveBeenCalledWith(
            IntegrationConfigKey.REPOSITORY_SELECTION,
            expect.objectContaining({
                mode: 'all',
                includeForksAndMirrors: true,
                updatedBy: 'user-1',
            }),
            'int-1',
            orgTeam,
        );
        expect(sync.syncTeam).toHaveBeenCalledWith(orgTeam, 'enable');
    });

    it('does not sync when going back to manual selection', async () => {
        const { useCase, sync } = build();

        await useCase.execute({ organizationAndTeamData: orgTeam, mode: 'manual' });

        expect(sync.syncTeam).not.toHaveBeenCalled();
    });

    it('rejects a team without a connected git integration', async () => {
        const { useCase, integrationConfigService } = build(null);

        await expect(
            useCase.execute({ organizationAndTeamData: orgTeam, mode: 'all' }),
        ).rejects.toBeDefined();
        expect(integrationConfigService.createOrUpdateConfig).not.toHaveBeenCalled();
    });

    it('rejects an unknown mode', async () => {
        const { useCase } = build();

        await expect(
            useCase.execute({
                organizationAndTeamData: orgTeam,
                mode: 'everything' as any,
            }),
        ).rejects.toBeDefined();
    });
});

describe('GetRepositorySelectionUseCase', () => {
    it('reports manual mode and no sync for a team that never chose', async () => {
        const useCase = new GetRepositorySelectionUseCase({
            findIntegrationConfigFormatted: jest.fn().mockResolvedValue(null),
        } as any);

        await expect(
            useCase.execute({ organizationAndTeamData: orgTeam }),
        ).resolves.toEqual({
            mode: 'manual',
            includeForksAndMirrors: false,
            sync: null,
        });
    });

    it('reports the stored choice and the sync progress', async () => {
        const values: Record<string, unknown> = {
            [IntegrationConfigKey.REPOSITORY_SELECTION]: {
                mode: 'all',
                includeForksAndMirrors: false,
            },
            [IntegrationConfigKey.REPOSITORY_SYNC_STATE]: {
                status: 'running',
                startedAt: '2026-11-06T00:00:00.000Z',
                total: 487,
                done: 320,
                pendingAstRepositoryIds: ['1', '2'],
            },
        };
        const useCase = new GetRepositorySelectionUseCase({
            findIntegrationConfigFormatted: jest.fn(
                async (key: string) => values[key] ?? null,
            ),
        } as any);

        const result = await useCase.execute({ organizationAndTeamData: orgTeam });

        expect(result).toMatchObject({
            mode: 'all',
            sync: { status: 'running', total: 487, done: 320, pendingAstBuilds: 2 },
        });
        expect(result.sync).not.toHaveProperty('pendingAstRepositoryIds');
    });
});
