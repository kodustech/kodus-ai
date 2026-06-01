import { REQUEST } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';

import { CentralizedConfigPrService } from '@libs/centralized-config/infrastructure/adapters/services/centralized-config-pr.service';
import { AuthorizationService } from '@libs/identity/infrastructure/adapters/services/permissions/authorization.service';
import { ChangeStatusKodyRulesUseCase } from '@libs/kodyRules/application/use-cases/change-status-kody-rules.use-case';
import { ConvertPendingUpdatesToMemoriesUseCase } from '@libs/kodyRules/application/use-cases/convert-pending-updates-to-memories.use-case';
import { CreateOrUpdateKodyRulesUseCase } from '@libs/kodyRules/application/use-cases/create-or-update.use-case';
import { FindRulesInOrganizationByRuleFilterKodyRulesUseCase } from '@libs/kodyRules/application/use-cases/find-rules-in-organization-by-filter.use-case';
import { KodyRulesStatus } from '@libs/kodyRules/domain/interfaces/kodyRules.interface';

jest.mock('@kodus/flow', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
    }),
}));

describe('ConvertPendingUpdatesToMemoriesUseCase', () => {
    let useCase: ConvertPendingUpdatesToMemoriesUseCase;
    let createOrUpdateUseCaseMock: { execute: jest.Mock };
    let findRulesUseCaseMock: { execute: jest.Mock };
    let changeStatusUseCaseMock: { execute: jest.Mock };
    let centralizedConfigPrServiceMock: {
        getCentralizedRepositoryIfEnabled: jest.Mock;
    };
    let authorizationServiceMock: { ensure: jest.Mock };
    let requestMock: any;

    beforeEach(async () => {
        createOrUpdateUseCaseMock = {
            execute: jest.fn(),
        };

        findRulesUseCaseMock = {
            execute: jest.fn(),
        };

        changeStatusUseCaseMock = {
            execute: jest.fn().mockResolvedValue(undefined),
        };

        centralizedConfigPrServiceMock = {
            getCentralizedRepositoryIfEnabled: jest
                .fn()
                .mockResolvedValue(null),
        };

        authorizationServiceMock = {
            ensure: jest.fn().mockResolvedValue(undefined),
        };

        requestMock = {
            user: {
                uuid: 'user-1',
                email: 'dev@kodus.io',
                organization: { uuid: 'org-1' },
            },
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                ConvertPendingUpdatesToMemoriesUseCase,
                {
                    provide: CreateOrUpdateKodyRulesUseCase,
                    useValue: createOrUpdateUseCaseMock,
                },
                {
                    provide:
                        FindRulesInOrganizationByRuleFilterKodyRulesUseCase,
                    useValue: findRulesUseCaseMock,
                },
                {
                    provide: ChangeStatusKodyRulesUseCase,
                    useValue: changeStatusUseCaseMock,
                },
                {
                    provide: CentralizedConfigPrService,
                    useValue: centralizedConfigPrServiceMock,
                },
                {
                    provide: AuthorizationService,
                    useValue: authorizationServiceMock,
                },
                {
                    provide: REQUEST,
                    useValue: requestMock,
                },
            ],
        }).compile();

        useCase = module.get(ConvertPendingUpdatesToMemoriesUseCase);
    });

    it('throws when organization id is missing', async () => {
        requestMock.user.organization.uuid = undefined;

        await expect(useCase.execute({ ruleIds: ['r1'] })).rejects.toThrow(
            'Organization ID not found',
        );
    });

    it('throws when any requested rule is not found', async () => {
        findRulesUseCaseMock.execute.mockResolvedValue([]);

        await expect(useCase.execute({ ruleIds: ['missing'] })).rejects.toThrow(
            'Rule not found: missing',
        );
    });

    it('authorizes by deduplicated repository ids and converts rules to active memories', async () => {
        findRulesUseCaseMock.execute.mockResolvedValue([
            {
                uuid: 'pending-1',
                title: 'Pending 1',
                rule: 'Rule 1',
                repositoryId: 'repo-1',
                status: KodyRulesStatus.PENDING,
                type: 'memory',
                origin: 'generated',
                requestType: 'memory_update',
                targetRuleUuid: 'target-1',
                resolvedAt: new Date('2026-01-01T00:00:00.000Z'),
                resolvedBy: 'user-2',
            },
            {
                uuid: 'pending-2',
                title: 'Pending 2',
                rule: 'Rule 2',
                repositoryId: 'repo-1',
                status: KodyRulesStatus.PENDING,
                type: 'memory',
                origin: 'generated',
            },
        ]);

        createOrUpdateUseCaseMock.execute
            .mockResolvedValueOnce({ uuid: 'created-1' })
            .mockResolvedValueOnce(null);

        const result = await useCase.execute({
            ruleIds: ['pending-1', 'pending-2'],
        });

        expect(authorizationServiceMock.ensure).toHaveBeenCalledWith(
            expect.objectContaining({ repoIds: ['repo-1'] }),
        );

        expect(createOrUpdateUseCaseMock.execute).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({
                uuid: undefined,
                status: KodyRulesStatus.ACTIVE,
                requestType: undefined,
                targetRuleUuid: undefined,
                resolvedAt: undefined,
                resolvedBy: undefined,
            }),
            'org-1',
            { userId: 'user-1', userEmail: 'dev@kodus.io' },
            true,
            undefined,
        );

        expect(changeStatusUseCaseMock.execute).toHaveBeenCalledWith({
            ruleIds: ['pending-1'],
            status: KodyRulesStatus.REJECTED,
        });

        expect(result).toEqual([{ uuid: 'created-1' }]);
    });

    it('uses active status and returns centralized PR metadata when centralized config is enabled', async () => {
        findRulesUseCaseMock.execute.mockResolvedValue([
            {
                uuid: 'pending-1',
                title: 'Pending 1',
                rule: 'Rule 1',
                repositoryId: 'repo-1',
                status: KodyRulesStatus.ACTIVE,
                type: 'memory',
                origin: 'generated',
            },
        ]);

        centralizedConfigPrServiceMock.getCentralizedRepositoryIfEnabled.mockResolvedValue(
            {
                id: 'central-repo-id',
                name: 'central-repo',
            },
        );

        createOrUpdateUseCaseMock.execute.mockResolvedValue({
            mode: 'centralized-pr',
            prUrl: 'https://example.com/pr/91',
            message: 'Queued in centralized PR',
        });

        const result = await useCase.execute({ ruleIds: ['pending-1'] });

        expect(createOrUpdateUseCaseMock.execute).toHaveBeenCalledWith(
            expect.objectContaining({
                uuid: undefined,
                status: KodyRulesStatus.ACTIVE,
            }),
            'org-1',
            { userId: 'user-1', userEmail: 'dev@kodus.io' },
            true,
            undefined,
        );

        expect(changeStatusUseCaseMock.execute).toHaveBeenCalledWith({
            ruleIds: ['pending-1'],
            status: KodyRulesStatus.REJECTED,
        });

        expect(result).toEqual({
            mode: 'centralized-pr',
            prUrl: 'https://example.com/pr/91',
            message: 'Queued in centralized PR',
        });
    });
});
