import { REQUEST } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';

import { CentralizedConfigPrService } from '@libs/centralized-config/infrastructure/adapters/services/centralized-config-pr.service';
import { AuthorizationService } from '@libs/identity/infrastructure/adapters/services/permissions/authorization.service';
import { ChangeStatusKodyRulesUseCase } from '@libs/kodyRules/application/use-cases/change-status-kody-rules.use-case';
import { CreateOrUpdateKodyRulesUseCase } from '@libs/kodyRules/application/use-cases/create-or-update.use-case';
import { DeleteRuleInOrganizationByIdKodyRulesUseCase } from '@libs/kodyRules/application/use-cases/delete-rule-in-organization-by-id.use-case';
import { FindRulesInOrganizationByRuleFilterKodyRulesUseCase } from '@libs/kodyRules/application/use-cases/find-rules-in-organization-by-filter.use-case';
import {
    IKodyRulesService,
    KODY_RULES_SERVICE_TOKEN,
} from '@libs/kodyRules/domain/contracts/kodyRules.service.contract';
import { KodyRulesStatus } from '@libs/kodyRules/domain/interfaces/kodyRules.interface';

jest.mock('@kodus/flow', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
    }),
}));

describe('ChangeStatusKodyRulesUseCase', () => {
    let useCase: ChangeStatusKodyRulesUseCase;

    const kodyRulesServiceMock = {
        createOrUpdate: jest.fn(),
    } as unknown as jest.Mocked<IKodyRulesService>;

    const createOrUpdateUseCaseMock = {
        execute: jest.fn(),
    };

    const deleteRuleUseCaseMock = {
        execute: jest.fn(),
    };

    const centralizedConfigPrServiceMock = {
        getCentralizedRepositoryIfEnabled: jest.fn(),
    };

    const findRulesUseCaseMock = {
        execute: jest.fn(),
    };

    const authorizationServiceMock = {
        ensure: jest.fn().mockResolvedValue(undefined),
    };

    const requestMock = {
        user: {
            uuid: 'user-1',
            email: 'dev@kodus.io',
            organization: { uuid: 'org-1' },
        },
    };

    beforeEach(async () => {
        jest.clearAllMocks();

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                ChangeStatusKodyRulesUseCase,
                {
                    provide: KODY_RULES_SERVICE_TOKEN,
                    useValue: kodyRulesServiceMock,
                },
                {
                    provide: CreateOrUpdateKodyRulesUseCase,
                    useValue: createOrUpdateUseCaseMock,
                },
                {
                    provide: DeleteRuleInOrganizationByIdKodyRulesUseCase,
                    useValue: deleteRuleUseCaseMock,
                },
                {
                    provide: CentralizedConfigPrService,
                    useValue: centralizedConfigPrServiceMock,
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

        useCase = module.get(ChangeStatusKodyRulesUseCase);
    });

    it('throws when organization id is missing', async () => {
        requestMock.user.organization.uuid = undefined as any;

        await expect(
            useCase.execute({
                ruleIds: ['rule-1'],
                status: KodyRulesStatus.ACTIVE,
            }),
        ).rejects.toThrow('Organization ID not found');

        requestMock.user.organization.uuid = 'org-1';
    });

    it('routes ACTIVE status through centralized-aware createOrUpdate use case', async () => {
        findRulesUseCaseMock.execute.mockResolvedValue([
            {
                uuid: 'rule-1',
                repositoryId: 'repo-1',
                title: 'Rule 1',
                rule: 'Do X',
                status: KodyRulesStatus.PENDING,
            },
        ]);

        createOrUpdateUseCaseMock.execute.mockResolvedValue({
            mode: 'centralized-pr',
            prUrl: 'https://example.com/pr/1',
        });

        const result = await useCase.execute({
            ruleIds: ['rule-1'],
            status: KodyRulesStatus.ACTIVE,
        });

        expect(createOrUpdateUseCaseMock.execute).toHaveBeenCalledWith(
            expect.objectContaining({
                uuid: 'rule-1',
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
            prUrl: 'https://example.com/pr/1',
        });
    });

    it('keeps workflow statuses as DB-only updates', async () => {
        findRulesUseCaseMock.execute.mockResolvedValue([
            {
                uuid: 'rule-1',
                repositoryId: 'repo-1',
                title: 'Rule 1',
                rule: 'Do X',
                status: KodyRulesStatus.PENDING,
            },
        ]);

        kodyRulesServiceMock.createOrUpdate.mockResolvedValue({
            uuid: 'rule-1',
            status: KodyRulesStatus.REJECTED,
        } as any);

        const result = await useCase.execute({
            ruleIds: ['rule-1'],
            status: KodyRulesStatus.REJECTED,
        });

        expect(kodyRulesServiceMock.createOrUpdate).toHaveBeenCalledWith(
            { organizationId: 'org-1', teamId: undefined },
            expect.objectContaining({
                uuid: 'rule-1',
                status: KodyRulesStatus.REJECTED,
            }),
            { userId: 'user-1', userEmail: 'dev@kodus.io' },
        );
        expect(createOrUpdateUseCaseMock.execute).not.toHaveBeenCalled();
        expect(result).toEqual([
            {
                uuid: 'rule-1',
                status: KodyRulesStatus.REJECTED,
            },
        ]);
    });

    it('routes DELETED status through centralized delete flow when centralized config is enabled', async () => {
        findRulesUseCaseMock.execute.mockResolvedValue([
            {
                uuid: 'rule-1',
                repositoryId: 'repo-1',
                title: 'Rule 1',
                rule: 'Do X',
                status: KodyRulesStatus.ACTIVE,
            },
        ]);

        centralizedConfigPrServiceMock.getCentralizedRepositoryIfEnabled.mockResolvedValue(
            {
                id: 'central-repo-id',
                name: 'central-repo',
            },
        );
        deleteRuleUseCaseMock.execute.mockResolvedValue({
            mode: 'centralized-pr',
            prUrl: 'https://example.com/pr/2',
        });

        const result = await useCase.execute({
            ruleIds: ['rule-1'],
            status: KodyRulesStatus.DELETED,
        });

        expect(deleteRuleUseCaseMock.execute).toHaveBeenCalledWith('rule-1', {
            source: 'web',
            organizationId: 'org-1',
            teamId: undefined,
            userId: 'user-1',
            userEmail: 'dev@kodus.io',
        });
        expect(kodyRulesServiceMock.createOrUpdate).not.toHaveBeenCalled();
        expect(result).toEqual({
            mode: 'centralized-pr',
            prUrl: 'https://example.com/pr/2',
        });
    });

    it('keeps DELETED as logical DB update when centralized config is disabled', async () => {
        findRulesUseCaseMock.execute.mockResolvedValue([
            {
                uuid: 'rule-1',
                repositoryId: 'repo-1',
                title: 'Rule 1',
                rule: 'Do X',
                status: KodyRulesStatus.ACTIVE,
            },
        ]);

        centralizedConfigPrServiceMock.getCentralizedRepositoryIfEnabled.mockResolvedValue(
            null,
        );
        kodyRulesServiceMock.createOrUpdate.mockResolvedValue({
            uuid: 'rule-1',
            status: KodyRulesStatus.DELETED,
        } as any);

        const result = await useCase.execute({
            ruleIds: ['rule-1'],
            status: KodyRulesStatus.DELETED,
        });

        expect(kodyRulesServiceMock.createOrUpdate).toHaveBeenCalledWith(
            { organizationId: 'org-1', teamId: undefined },
            expect.objectContaining({
                uuid: 'rule-1',
                status: KodyRulesStatus.DELETED,
            }),
            { userId: 'user-1', userEmail: 'dev@kodus.io' },
        );
        expect(deleteRuleUseCaseMock.execute).not.toHaveBeenCalled();
        expect(result).toEqual([
            {
                uuid: 'rule-1',
                status: KodyRulesStatus.DELETED,
            },
        ]);
    });
});
