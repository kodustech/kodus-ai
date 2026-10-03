import { ForbiddenException, NotFoundException } from '@nestjs/common';
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
import { TEAM_SERVICE_TOKEN } from '@libs/organization/domain/team/contracts/team.service.contract';
import { TelemetryService } from '@libs/telemetry/application/services/telemetry.service';

const teamOrganizations: Record<string, string> = {
    'team-1': 'org-1',
    'foreign-team': 'victim-org',
};
const teamServiceProvider = {
    provide: TEAM_SERVICE_TOKEN,
    useValue: {
        findOneOrganizationIdByTeamId: jest.fn(
            async (teamId: string) => teamOrganizations[teamId],
        ),
    },
};

describe('DeleteRuleInOrganizationByIdKodyRulesUseCase', () => {
    let useCase: DeleteRuleInOrganizationByIdKodyRulesUseCase;
    let kodyRulesServiceMock: jest.Mocked<IKodyRulesService>;
    let centralizedConfigPrServiceMock: {
        createMutationPullRequestIfEnabled: jest.Mock;
        resolveRepositoryFolderName: jest.Mock;
        resolveDirectoryGroupFolderName: jest.Mock;
        buildCentralizedPath: jest.Mock;
        sanitizeFileName: jest.Mock;
        buildRuleFileName: jest.Mock;
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
            buildRuleFileName: jest.fn(
                (_t?: string, u?: string) =>
                    `no-console-logs${u ? `-${String(u).slice(0, 8)}` : ''}.yml`,
            ),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                {
                    provide: TelemetryService,
                    useValue: {
                        kodyRuleChanged: jest.fn(),
                        kodyRulesImported: jest.fn(),
                    },
                },
                DeleteRuleInOrganizationByIdKodyRulesUseCase,
                {
                    provide: KODY_RULES_SERVICE_TOKEN,
                    useValue: kodyRulesServiceMock,
                },
                teamServiceProvider,
                {
                    provide: CentralizedConfigPrService,
                    useValue: centralizedConfigPrServiceMock,
                },
                {
                    provide: AuthorizationService,
                    useValue: {
                        ensure: jest.fn().mockResolvedValue(undefined),
                    },
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

    it('rejects a foreign rule before creating a centralized delete PR', async () => {
        kodyRulesServiceMock.findById.mockImplementation(
            async (...args: unknown[]) =>
                args[1] === 'org-1'
                    ? null
                    : ({
                          uuid: 'foreign-rule',
                          title: 'Private rule',
                          repositoryId: 'global',
                          type: KodyRulesType.STANDARD,
                      } as any),
        );
        centralizedConfigPrServiceMock.createMutationPullRequestIfEnabled.mockResolvedValue(
            { mode: 'centralized-pr' },
        );

        await expect(
            useCase.execute(
                'foreign-rule',
                {
                    source: 'web',
                    organizationId: 'org-1',
                    teamId: 'team-1',
                },
                { uuid: 'owner-1', organization: { uuid: 'org-1' } } as any,
            ),
        ).rejects.toBeInstanceOf(NotFoundException);
        expect(
            centralizedConfigPrServiceMock.createMutationPullRequestIfEnabled,
        ).not.toHaveBeenCalled();
        expect(
            kodyRulesServiceMock.deleteRuleWithLogging,
        ).not.toHaveBeenCalled();
    });

    it.each([
        undefined,
        { source: 'cli' },
        { source: 'sync', organizationId: '' },
    ])(
        'rejects missing organization before any lookup or mutation (%j)',
        async (actor) => {
            await expect(
                useCase.execute('rule-1', actor as any),
            ).rejects.toBeInstanceOf(NotFoundException);
            expect(kodyRulesServiceMock.findById).not.toHaveBeenCalled();
            expect(
                kodyRulesServiceMock.deleteRuleWithLogging,
            ).not.toHaveBeenCalled();
            expect(
                centralizedConfigPrServiceMock.createMutationPullRequestIfEnabled,
            ).not.toHaveBeenCalled();
        },
    );

    it.each(['cli', 'sync', 'web'] as const)(
        'rejects a missing or foreign rule for a %s actor without a request user',
        async (source) => {
            kodyRulesServiceMock.findById.mockResolvedValue(null);
            await expect(
                useCase.execute('foreign-rule', {
                    source,
                    organizationId: 'org-1',
                }),
            ).rejects.toBeInstanceOf(NotFoundException);
            expect(kodyRulesServiceMock.findById).toHaveBeenCalledWith(
                'foreign-rule',
                'org-1',
            );
            expect(
                kodyRulesServiceMock.deleteRuleWithLogging,
            ).not.toHaveBeenCalled();
            expect(
                centralizedConfigPrServiceMock.createMutationPullRequestIfEnabled,
            ).not.toHaveBeenCalled();
        },
    );

    it('uses the authenticated organization when an actor claims another organization', async () => {
        kodyRulesServiceMock.findById.mockResolvedValue(null);
        await expect(
            useCase.execute('foreign-rule', { organizationId: 'victim-org' }, {
                organization: { uuid: 'org-1' },
            } as any),
        ).rejects.toBeInstanceOf(NotFoundException);
        expect(kodyRulesServiceMock.findById).toHaveBeenCalledWith(
            'foreign-rule',
            'org-1',
        );
        expect(
            kodyRulesServiceMock.deleteRuleWithLogging,
        ).not.toHaveBeenCalled();
    });

    it.each([
        ['a foreign team', 'foreign-team'],
        ['an unknown team', 'missing-team'],
    ])(
        'rejects %s before reading the rule or touching centralized config',
        async (_label, teamId) => {
            await expect(
                useCase.execute('rule-1', { source: 'web', teamId }, {
                    uuid: 'owner-1',
                    organization: { uuid: 'org-1' },
                } as any),
            ).rejects.toBeInstanceOf(NotFoundException);
            expect(kodyRulesServiceMock.findById).not.toHaveBeenCalled();
            expect(
                centralizedConfigPrServiceMock.resolveDirectoryGroupFolderName,
            ).not.toHaveBeenCalled();
            expect(
                kodyRulesServiceMock.deleteRuleWithLogging,
            ).not.toHaveBeenCalled();
        },
    );

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
                {
                    provide: TelemetryService,
                    useValue: {
                        kodyRuleChanged: jest.fn(),
                        kodyRulesImported: jest.fn(),
                    },
                },
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
                teamServiceProvider,
                {
                    provide: CentralizedConfigPrService,
                    useValue: centralizedConfigPrServiceMock,
                },
            ],
        }).compile();

        const useCase = module.get(
            DeleteRuleInOrganizationByIdKodyRulesUseCase,
        );

        // Use-cases no longer inject REQUEST — the controller forwards the
        // authenticated user. Wrap execute() to pass the test user through.
        return {
            execute: (ruleId: string, actor?: any) =>
                useCase.execute(ruleId, actor, (user ?? undefined) as any),
        };
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
