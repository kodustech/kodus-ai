import { KodyRulesStatus } from '@libs/kodyRules/domain/interfaces/kodyRules.interface';

import { GetKodyRulesIndexUseCase } from './get-kody-rules-index.use-case';

jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({ log: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

describe('GetKodyRulesIndexUseCase — a member granted some Git connections', () => {
    it("lists another connection's own global rules only to members granted it, without its source", async () => {
        const kodyRulesService = {
            findRulesIndex: jest.fn().mockResolvedValue([
                {
                    uuid: 'r-other',
                    title: 'Other',
                    repositoryId: 'global',
                    status: KodyRulesStatus.ACTIVE,
                    centralizedConfig: {
                        sourceConnectionId: 'gl-b',
                        connectionScoped: true,
                    },
                },
                {
                    uuid: 'r-own',
                    title: 'Own',
                    repositoryId: 'global',
                    status: KodyRulesStatus.ACTIVE,
                    centralizedConfig: {
                        sourceConnectionId: 'gh-a',
                        connectionScoped: true,
                    },
                },
            ]),
        };
        const useCase = new GetKodyRulesIndexUseCase(
            kodyRulesService as any,
            { user: { organization: { uuid: 'org-1' } } } as any,
            { getRepositoryScope: jest.fn().mockResolvedValue(null) } as any,
        );

        await expect(
            useCase.execute('org-1', { connectionIds: new Set(['gh-a']) }),
        ).resolves.toEqual([
            {
                uuid: 'r-own',
                title: 'Own',
                repositoryId: 'global',
                status: KodyRulesStatus.ACTIVE,
            },
        ]);
    });
});
