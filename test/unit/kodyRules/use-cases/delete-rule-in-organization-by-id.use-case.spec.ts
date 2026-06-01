import { REQUEST } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';

import {
    CentralizedConfigPrService,
    CentralizedPrMetadata,
} from '@libs/centralized-config/infrastructure/adapters/services/centralized-config-pr.service';
import { DeleteRuleInOrganizationByIdKodyRulesUseCase } from '@libs/kodyRules/application/use-cases/delete-rule-in-organization-by-id.use-case';
import {
    IKodyRulesService,
    KODY_RULES_SERVICE_TOKEN,
} from '@libs/kodyRules/domain/contracts/kodyRules.service.contract';
import {
    KodyRulesStatus,
    KodyRulesType,
} from '@libs/kodyRules/domain/interfaces/kodyRules.interface';

describe('DeleteRuleInOrganizationByIdKodyRulesUseCase', () => {
    let useCase: DeleteRuleInOrganizationByIdKodyRulesUseCase;
    let kodyRulesServiceMock: jest.Mocked<IKodyRulesService>;
    let centralizedConfigPrServiceMock: {
        createMutationPullRequestIfEnabled: jest.Mock;
        resolveRepositoryFolderName: jest.Mock;
        buildCentralizedPath: jest.Mock;
        sanitizeFileName: jest.Mock;
    };

    beforeEach(async () => {
        kodyRulesServiceMock = {
            findById: jest.fn(),
            createOrUpdate: jest.fn(),
            deleteRuleWithLogging: jest.fn(),
        } as unknown as jest.Mocked<IKodyRulesService>;

        centralizedConfigPrServiceMock = {
            createMutationPullRequestIfEnabled: jest.fn(),
            resolveRepositoryFolderName: jest.fn().mockResolvedValue('global'),
            buildCentralizedPath: jest
                .fn()
                .mockImplementation(({ repositoryFolder, relativePath }) =>
                    repositoryFolder === 'global'
                        ? relativePath
                        : `${repositoryFolder}/${relativePath}`,
                ),
            sanitizeFileName: jest.fn().mockReturnValue('no-console-logs'),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                DeleteRuleInOrganizationByIdKodyRulesUseCase,
                {
                    provide: KODY_RULES_SERVICE_TOKEN,
                    useValue: kodyRulesServiceMock,
                },
                {
                    provide: CentralizedConfigPrService,
                    useValue: centralizedConfigPrServiceMock,
                },
                {
                    provide: REQUEST,
                    useValue: {
                        user: {
                            organization: { uuid: 'org-1' },
                            uuid: 'user-1',
                            email: 'dev@kodus.io',
                        },
                    },
                },
            ],
        }).compile();

        useCase = module.get(DeleteRuleInOrganizationByIdKodyRulesUseCase);
    });

    it('routes delete through centralized PR when actor provides teamId', async () => {
        kodyRulesServiceMock.findById.mockResolvedValue({
            uuid: 'rule-1',
            title: 'No console logs',
            type: KodyRulesType.STANDARD,
            repositoryId: 'global',
            status: KodyRulesStatus.ACTIVE,
        } as any);

        centralizedConfigPrServiceMock.createMutationPullRequestIfEnabled.mockResolvedValue(
            {
                mode: 'centralized-pr',
                prUrl: 'https://example.com/pr/99',
            } as CentralizedPrMetadata,
        );

        const result = await useCase.execute('rule-1', {
            source: 'web',
            organizationId: 'org-1',
            teamId: 'team-1',
            userId: 'user-1',
            userEmail: 'dev@kodus.io',
        });

        expect(result).toEqual(
            expect.objectContaining({
                mode: 'centralized-pr',
                prUrl: 'https://example.com/pr/99',
            }),
        );

        expect(
            centralizedConfigPrServiceMock.createMutationPullRequestIfEnabled,
        ).toHaveBeenCalledWith(
            expect.objectContaining({
                organizationAndTeamData: {
                    organizationId: 'org-1',
                    teamId: 'team-1',
                },
                repositoryId: 'global',
            }),
        );

        expect(
            kodyRulesServiceMock.deleteRuleWithLogging,
        ).not.toHaveBeenCalled();
        expect(kodyRulesServiceMock.createOrUpdate).toHaveBeenCalled();
    });

    it('falls back to direct delete for sync actor', async () => {
        kodyRulesServiceMock.findById.mockResolvedValue({
            uuid: 'rule-1',
            type: KodyRulesType.STANDARD,
            repositoryId: 'repo-1',
        } as any);
        kodyRulesServiceMock.deleteRuleWithLogging.mockResolvedValue(true);

        const result = await useCase.execute('rule-1', {
            source: 'sync',
            organizationId: 'org-1',
            userId: 'kody',
            userEmail: 'kody@kodus.io',
        });

        expect(
            centralizedConfigPrServiceMock.createMutationPullRequestIfEnabled,
        ).not.toHaveBeenCalled();
        expect(kodyRulesServiceMock.deleteRuleWithLogging).toHaveBeenCalledWith(
            {
                organizationId: 'org-1',
            },
            'rule-1',
            {
                userId: 'kody',
                userEmail: 'kody@kodus.io',
            },
        );
        expect(result).toBe(true);
    });
});
