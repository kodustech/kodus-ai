import { ForbiddenException } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';

import {
    CentralizedConfigPrService,
    CentralizedPrMetadata,
} from '@libs/centralized-config/infrastructure/adapters/services/centralized-config-pr.service';
import { STATUS } from '@libs/core/infrastructure/config/types/database/status.type';
import { PERMISSIONS_SERVICE_TOKEN } from '@libs/identity/domain/permissions/contracts/permissions.service.contract';
import { Role } from '@libs/identity/domain/permissions/enums/permissions.enum';
import { AuthorizationService } from '@libs/identity/infrastructure/adapters/services/permissions/authorization.service';
import { PermissionsAbilityFactory } from '@libs/identity/infrastructure/adapters/services/permissions/permissionsAbility.factory';
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
            resolveDirectoryGroupFolderName: jest.fn().mockResolvedValue(null),
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
                    provide: AuthorizationService,
                    useValue: { ensure: jest.fn().mockResolvedValue(undefined) },
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

/**
 * Repo-scope enforcement. The controller guard (`checkPermissions`) is
 * type-level only — it cannot know which repository the rule belongs to —
 * so the use case must enforce it, the same contract
 * `ChangeStatusKodyRulesUseCase` already honors via
 * `authorizationService.ensure`. These tests wire the REAL
 * AuthorizationService + PermissionsAbilityFactory (only the permissions
 * repository is mocked) so they prove the actual policy outcome.
 */
describe('DeleteRuleInOrganizationByIdKodyRulesUseCase — repo scope', () => {
    const kodyRulesServiceMock = {
        findById: jest.fn(),
        createOrUpdate: jest.fn(),
        deleteRuleWithLogging: jest.fn(),
    } as unknown as jest.Mocked<IKodyRulesService>;

    const centralizedConfigPrServiceMock = {
        createMutationPullRequestIfEnabled: jest.fn(),
        resolveDirectoryGroupFolderName: jest.fn().mockResolvedValue(null),
    };

    // repo_admin assigned ONLY to repo-a.
    const permissionsServiceMock = {
        findOne: jest.fn(),
    };

    const repoAdminUser = {
        uuid: 'user-1',
        email: 'dev@kodus.io',
        role: Role.REPO_ADMIN,
        status: STATUS.ACTIVE,
        organization: { uuid: 'org-1' },
    };

    const ownerUser = {
        ...repoAdminUser,
        role: Role.OWNER,
    };

    const buildUseCase = async (user: Record<string, unknown> | null) => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                DeleteRuleInOrganizationByIdKodyRulesUseCase,
                AuthorizationService,
                PermissionsAbilityFactory,
                {
                    provide: PERMISSIONS_SERVICE_TOKEN,
                    useValue: permissionsServiceMock,
                },
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
                    useValue: user ? { user } : undefined,
                },
            ],
        }).compile();

        return module.get(DeleteRuleInOrganizationByIdKodyRulesUseCase);
    };

    const ruleIn = (repositoryId: string) => ({
        uuid: 'rule-1',
        title: 'Some rule',
        rule: 'Do X',
        type: KodyRulesType.STANDARD,
        repositoryId,
        status: KodyRulesStatus.ACTIVE,
    });

    beforeEach(() => {
        jest.clearAllMocks();
        permissionsServiceMock.findOne.mockResolvedValue({
            permissions: { assignedRepositoryIds: ['repo-a'] },
        });
        centralizedConfigPrServiceMock.createMutationPullRequestIfEnabled.mockResolvedValue(
            { mode: 'direct' },
        );
        kodyRulesServiceMock.deleteRuleWithLogging.mockResolvedValue(true);
    });

    it('denies a repo admin deleting a rule from a repository they are not assigned to', async () => {
        const useCase = await buildUseCase(repoAdminUser);
        kodyRulesServiceMock.findById.mockResolvedValue(
            ruleIn('repo-b') as any,
        );

        await expect(
            useCase.execute('rule-1', { source: 'web' }),
        ).rejects.toThrow(ForbiddenException);

        expect(
            kodyRulesServiceMock.deleteRuleWithLogging,
        ).not.toHaveBeenCalled();
        expect(
            centralizedConfigPrServiceMock.createMutationPullRequestIfEnabled,
        ).not.toHaveBeenCalled();
    });

    it('denies a repo admin deleting a global rule', async () => {
        const useCase = await buildUseCase(repoAdminUser);
        kodyRulesServiceMock.findById.mockResolvedValue(
            ruleIn('global') as any,
        );

        await expect(
            useCase.execute('rule-1', { source: 'web' }),
        ).rejects.toThrow(ForbiddenException);

        expect(
            kodyRulesServiceMock.deleteRuleWithLogging,
        ).not.toHaveBeenCalled();
    });

    it('allows a repo admin to delete a rule in an assigned repository', async () => {
        const useCase = await buildUseCase(repoAdminUser);
        kodyRulesServiceMock.findById.mockResolvedValue(
            ruleIn('repo-a') as any,
        );

        await expect(
            useCase.execute('rule-1', { source: 'web' }),
        ).resolves.toBe(true);

        expect(kodyRulesServiceMock.deleteRuleWithLogging).toHaveBeenCalledWith(
            { organizationId: 'org-1' },
            'rule-1',
            { userId: 'user-1', userEmail: 'dev@kodus.io' },
        );
    });

    it('allows the owner to delete a rule in any repository', async () => {
        const useCase = await buildUseCase(ownerUser);
        kodyRulesServiceMock.findById.mockResolvedValue(
            ruleIn('repo-b') as any,
        );

        await expect(
            useCase.execute('rule-1', { source: 'web' }),
        ).resolves.toBe(true);

        expect(kodyRulesServiceMock.deleteRuleWithLogging).toHaveBeenCalled();
    });

    it('keeps machine sync deletions working without a request context', async () => {
        const useCase = await buildUseCase(null);
        kodyRulesServiceMock.findById.mockResolvedValue(
            ruleIn('repo-b') as any,
        );

        await expect(
            useCase.execute('rule-1', {
                source: 'sync',
                organizationId: 'org-1',
                teamId: 'team-1',
                userId: 'kody-system',
                userEmail: 'kody@kodus.io',
            }),
        ).resolves.toBe(true);

        expect(kodyRulesServiceMock.deleteRuleWithLogging).toHaveBeenCalled();
    });
});
