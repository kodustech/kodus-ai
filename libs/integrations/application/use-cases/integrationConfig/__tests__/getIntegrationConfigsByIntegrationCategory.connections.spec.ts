import { NotFoundException } from '@nestjs/common';
import { IntegrationCategory } from '@libs/core/domain/enums/integration-category.enum';

import { GetIntegrationConfigsByIntegrationCategoryUseCase } from '../getIntegrationConfigsByIntegrationCategory.use-case';

jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({ log: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

const build = (reposByConnection: Record<string, Array<{ id: string }>>) => {
    const connections = Object.keys(reposByConnection).map((uuid) => ({
        uuid,
    }));
    const integrationService = {
        find: jest.fn().mockResolvedValue(connections),
        findOne: jest.fn(async (filter: any) =>
            connections.find((c) => c.uuid === filter.uuid),
        ),
    };
    const integrationConfigService = {
        find: jest.fn(async (filter: any) => [
            {
                configKey: 'repositories',
                configValue: reposByConnection[filter.integration.uuid],
            },
        ]),
    };
    const useCase = new GetIntegrationConfigsByIntegrationCategoryUseCase(
        integrationService as any,
        integrationConfigService as any,
        { user: { organization: { uuid: 'org-1' } } } as any,
    );
    return { useCase };
};

describe('GetIntegrationConfigsByIntegrationCategoryUseCase — Git connections', () => {
    it('lists every connection’s repositories, each tagged with its connection', async () => {
        const { useCase } = build({
            'gh-a': [{ id: '1' }],
            'gl-b': [{ id: '2' }],
        });

        const result = await useCase.execute({
            teamId: 'team-1',
            integrationCategory: IntegrationCategory.CODE_MANAGEMENT,
        });

        expect(result).toEqual([
            {
                configKey: 'repositories',
                configValue: [
                    { id: '1', connectionId: 'gh-a' },
                    { id: '2', connectionId: 'gl-b' },
                ],
            },
        ]);
    });

    it('reads the connections together and answers a shared key from the oldest one', async () => {
        const integrationService = {
            find: jest
                .fn()
                .mockResolvedValue([{ uuid: 'gh-old' }, { uuid: 'gl-new' }]),
        };
        let inFlight = 0;
        let peak = 0;
        const integrationConfigService = {
            find: jest.fn(async (filter: any) => {
                inFlight += 1;
                peak = Math.max(peak, inFlight);
                // The oldest connection answers last.
                await new Promise((resolve) =>
                    setTimeout(
                        resolve,
                        filter.integration.uuid === 'gh-old' ? 20 : 0,
                    ),
                );
                inFlight -= 1;
                return [
                    {
                        configKey: 'installationId',
                        configValue: filter.integration.uuid,
                    },
                ];
            }),
        };
        const useCase = new GetIntegrationConfigsByIntegrationCategoryUseCase(
            integrationService as any,
            integrationConfigService as any,
            { user: { organization: { uuid: 'org-1' } } } as any,
        );

        const result = await useCase.execute({
            teamId: 'team-1',
            integrationCategory: IntegrationCategory.CODE_MANAGEMENT,
        });

        expect(peak).toBe(2);
        expect(result).toEqual([
            { configKey: 'installationId', configValue: 'gh-old' },
        ]);
    });

    it('lists only the named connection’s configs', async () => {
        const { useCase } = build({
            'gh-a': [{ id: '1' }],
            'gl-b': [{ id: '2' }],
        });

        const result = await useCase.execute({
            teamId: 'team-1',
            integrationCategory: IntegrationCategory.CODE_MANAGEMENT,
            connectionId: 'gl-b',
        });

        expect(result).toEqual([
            {
                configKey: 'repositories',
                configValue: [{ id: '2', connectionId: 'gl-b' }],
            },
        ]);
    });

    it('refuses a named connection that is not in the workspace instead of answering it has nothing', async () => {
        const { useCase } = build({ 'gh-a': [{ id: '1' }] });

        await expect(
            useCase.execute({
                teamId: 'team-1',
                integrationCategory: IntegrationCategory.CODE_MANAGEMENT,
                connectionId: 'removed',
            }),
        ).rejects.toBeInstanceOf(NotFoundException);
    });
});
