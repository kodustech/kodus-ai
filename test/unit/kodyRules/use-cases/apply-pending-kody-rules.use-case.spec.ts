import { REQUEST } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';

import { AuthorizationService } from '@libs/identity/infrastructure/adapters/services/permissions/authorization.service';
import { ApplyPendingKodyRulesUseCase } from '@libs/kodyRules/application/use-cases/apply-pending-kody-rules.use-case';
import { CreateOrUpdateKodyRulesUseCase } from '@libs/kodyRules/application/use-cases/create-or-update.use-case';
import { FindRulesInOrganizationByRuleFilterKodyRulesUseCase } from '@libs/kodyRules/application/use-cases/find-rules-in-organization-by-filter.use-case';
import {
    IKodyRulesService,
    KODY_RULES_SERVICE_TOKEN,
} from '@libs/kodyRules/domain/contracts/kodyRules.service.contract';
import {
    KodyRuleRequestType,
    KodyRulesStatus,
    KodyRulesType,
} from '@libs/kodyRules/domain/interfaces/kodyRules.interface';

jest.mock('@kodus/flow', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
    }),
}));

describe('ApplyPendingKodyRulesUseCase', () => {
    let useCase: ApplyPendingKodyRulesUseCase;
    let kodyRulesServiceMock: jest.Mocked<IKodyRulesService>;
    let createOrUpdateUseCaseMock: { execute: jest.Mock };
    let findRulesUseCaseMock: { execute: jest.Mock };
    let authorizationServiceMock: { ensure: jest.Mock };
    let requestMock: any;

    beforeEach(async () => {
        kodyRulesServiceMock = {
            createOrUpdate: jest.fn(),
        } as unknown as jest.Mocked<IKodyRulesService>;

        createOrUpdateUseCaseMock = {
            execute: jest.fn(),
        };

        findRulesUseCaseMock = {
            execute: jest.fn(),
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
                ApplyPendingKodyRulesUseCase,
                {
                    provide: KODY_RULES_SERVICE_TOKEN,
                    useValue: kodyRulesServiceMock,
                },
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
                    provide: AuthorizationService,
                    useValue: authorizationServiceMock,
                },
                {
                    provide: REQUEST,
                    useValue: requestMock,
                },
            ],
        }).compile();

        useCase = module.get(ApplyPendingKodyRulesUseCase);
    });

    it('throws when organization id is missing', async () => {
        requestMock.user.organization.uuid = undefined;

        await expect(useCase.execute({ ruleIds: ['r1'] })).rejects.toThrow(
            'Organization ID not found',
        );
    });

    it('throws when any requested rule does not exist', async () => {
        findRulesUseCaseMock.execute.mockResolvedValue([]);

        await expect(useCase.execute({ ruleIds: ['missing'] })).rejects.toThrow(
            'Rule not found: missing',
        );
    });

    it('authorizes with deduplicated repo ids from pending and target rules', async () => {
        findRulesUseCaseMock.execute.mockResolvedValue([
            {
                uuid: 'target-1',
                title: 'target',
                rule: 'target rule',
                repositoryId: 'repo-1',
                status: KodyRulesStatus.ACTIVE,
                type: KodyRulesType.MEMORY,
            },
            {
                uuid: 'pending-1',
                title: 'pending',
                rule: 'pending rule',
                repositoryId: 'repo-1',
                status: KodyRulesStatus.PENDING,
                type: KodyRulesType.MEMORY,
                requestType: KodyRuleRequestType.MEMORY_UPDATE,
                targetRuleUuid: 'target-1',
            },
        ]);

        createOrUpdateUseCaseMock.execute.mockResolvedValue({
            uuid: 'ok',
        } as any);
        kodyRulesServiceMock.createOrUpdate.mockResolvedValue({
            uuid: 'pending-1',
            status: KodyRulesStatus.APPLIED,
        } as any);

        await useCase.execute({ ruleIds: ['pending-1'] });

        expect(authorizationServiceMock.ensure).toHaveBeenCalledWith(
            expect.objectContaining({
                repoIds: ['repo-1'],
            }),
        );
    });

    it('applies memory update by updating target with centralized-aware routing and marking pending as applied', async () => {
        findRulesUseCaseMock.execute.mockResolvedValue([
            {
                uuid: 'target-1',
                title: 'Target old',
                rule: 'Old rule',
                repositoryId: 'repo-1',
                status: KodyRulesStatus.ACTIVE,
                type: KodyRulesType.MEMORY,
            },
            {
                uuid: 'pending-1',
                title: 'Target new',
                rule: 'New rule',
                repositoryId: 'repo-1',
                status: KodyRulesStatus.PENDING,
                type: KodyRulesType.MEMORY,
                requestType: KodyRuleRequestType.MEMORY_UPDATE,
                targetRuleUuid: 'target-1',
            },
        ]);

        createOrUpdateUseCaseMock.execute.mockResolvedValueOnce({
            uuid: 'target-1',
            title: 'Target new',
        } as any);
        kodyRulesServiceMock.createOrUpdate.mockResolvedValueOnce({
            uuid: 'pending-1',
            status: KodyRulesStatus.APPLIED,
        } as any);

        const result = await useCase.execute({ ruleIds: ['pending-1'] });

        expect(createOrUpdateUseCaseMock.execute).toHaveBeenCalledTimes(1);
        expect(createOrUpdateUseCaseMock.execute).toHaveBeenCalledWith(
            expect.objectContaining({
                uuid: 'target-1',
                title: 'Target new',
                rule: 'New rule',
                status: KodyRulesStatus.ACTIVE,
            }),
            'org-1',
            { userId: 'user-1', userEmail: 'dev@kodus.io' },
            true,
            undefined,
        );

        expect(kodyRulesServiceMock.createOrUpdate).toHaveBeenCalledTimes(1);
        expect(kodyRulesServiceMock.createOrUpdate).toHaveBeenCalledWith(
            { organizationId: 'org-1', teamId: undefined },
            expect.objectContaining({
                uuid: 'pending-1',
                status: KodyRulesStatus.APPLIED,
                targetRuleUuid: 'target-1',
            }),
            { userId: 'user-1', userEmail: 'dev@kodus.io' },
        );
        expect(result).toEqual([{ uuid: 'target-1', title: 'Target new' }]);
    });

    it('returns centralized PR metadata when activation routes through centralized config flow', async () => {
        findRulesUseCaseMock.execute.mockResolvedValue([
            {
                uuid: 'pending-standard-1',
                title: 'Standard pending',
                rule: 'Standard rule',
                repositoryId: 'repo-2',
                status: KodyRulesStatus.PENDING,
                type: KodyRulesType.STANDARD,
            },
        ]);

        createOrUpdateUseCaseMock.execute.mockResolvedValue({
            mode: 'centralized-pr',
            prUrl: 'https://example.com/pr/22',
            message: 'Queued in centralized PR',
        });

        const result = await useCase.execute({
            ruleIds: ['pending-standard-1'],
        });

        expect(createOrUpdateUseCaseMock.execute).toHaveBeenCalledWith(
            expect.objectContaining({
                uuid: 'pending-standard-1',
                status: KodyRulesStatus.ACTIVE,
            }),
            'org-1',
            { userId: 'user-1', userEmail: 'dev@kodus.io' },
            true,
            undefined,
        );
        expect(kodyRulesServiceMock.createOrUpdate).not.toHaveBeenCalled();
        expect(result).toEqual({
            mode: 'centralized-pr',
            prUrl: 'https://example.com/pr/22',
            message: 'Queued in centralized PR',
        });
    });

    it('activates pending non-memory-update rules through centralized-aware create-or-update use case', async () => {
        findRulesUseCaseMock.execute.mockResolvedValue([
            {
                uuid: 'pending-standard-1',
                title: 'Standard pending',
                rule: 'Standard rule',
                repositoryId: 'repo-2',
                status: KodyRulesStatus.PENDING,
                type: KodyRulesType.STANDARD,
            },
        ]);

        createOrUpdateUseCaseMock.execute.mockResolvedValue({
            uuid: 'pending-standard-1',
            status: KodyRulesStatus.ACTIVE,
        } as any);

        const result = await useCase.execute({
            ruleIds: ['pending-standard-1'],
        });

        expect(createOrUpdateUseCaseMock.execute).toHaveBeenCalledWith(
            expect.objectContaining({
                uuid: 'pending-standard-1',
                status: KodyRulesStatus.ACTIVE,
            }),
            'org-1',
            { userId: 'user-1', userEmail: 'dev@kodus.io' },
            true,
            undefined,
        );
        expect(kodyRulesServiceMock.createOrUpdate).not.toHaveBeenCalled();
        expect(result).toEqual([
            { uuid: 'pending-standard-1', status: KodyRulesStatus.ACTIVE },
        ]);
    });
});
