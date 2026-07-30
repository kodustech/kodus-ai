import { ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';

import { ContextReferenceDetectionService } from '@libs/ai-engine/infrastructure/adapters/services/context/context-reference-detection.service';
import { CentralizedConfigPrService } from '@libs/centralized-config/infrastructure/adapters/services/centralized-config-pr.service';
import {
    CONTEXT_RESOLUTION_SERVICE_TOKEN,
    IContextResolutionService,
} from '@libs/core/context-resolution/domain/contracts/context-resolution.service.contract';
import { STATUS } from '@libs/core/infrastructure/config/types/database/status.type';
import { PermissionValidationService } from '@libs/ee/shared/services/permissionValidation.service';
import { KODY_RULE_DETECTOR_COMPILER_TOKEN } from '@libs/kodyRules/domain/contracts/kody-rule-detector-compiler.contract';
import { PERMISSIONS_SERVICE_TOKEN } from '@libs/identity/domain/permissions/contracts/permissions.service.contract';
import { Role } from '@libs/identity/domain/permissions/enums/permissions.enum';
import { AuthorizationService } from '@libs/identity/infrastructure/adapters/services/permissions/authorization.service';
import { PermissionsAbilityFactory } from '@libs/identity/infrastructure/adapters/services/permissions/permissionsAbility.factory';
import { CreateOrUpdateKodyRulesUseCase } from '@libs/kodyRules/application/use-cases/create-or-update.use-case';
import {
    IKodyRulesService,
    KODY_RULES_SERVICE_TOKEN,
} from '@libs/kodyRules/domain/contracts/kodyRules.service.contract';
import {
    KodyRulesOrigin,
    KodyRulesStatus,
    KodyRulesType,
} from '@libs/kodyRules/domain/interfaces/kodyRules.interface';

jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
    }),
}));

/**
 * Inheritance-toggle authorization (issue: "Error disabling inheritance").
 *
 * Excluding/including a child scope from an inherited rule mutates the
 * PARENT (e.g. global) rule document, but its effect is scoped to the
 * toggled child. Authorizing it against the parent's repositoryId means a
 * repo admin cannot opt their own repo out of an inherited global rule —
 * the toggle 403s. When the ONLY change is inheritance.exclude/include,
 * the use case must authorize against the toggled ids instead. Any other
 * change to a global rule must keep requiring write on the parent scope.
 *
 * Real AuthorizationService + ability factory (only the permissions
 * repository is mocked) so the tests prove the actual policy outcome.
 */
describe('CreateOrUpdateKodyRulesUseCase — inheritance toggle authz', () => {
    const kodyRulesServiceMock = {
        createOrUpdate: jest.fn(),
        findById: jest.fn(),
        updateRuleReferences: jest.fn(),
    } as unknown as jest.Mocked<IKodyRulesService>;

    const centralizedConfigPrServiceMock = {
        createMutationPullRequestIfEnabled: jest.fn(),
        getCentralizedRepositoryIfEnabled: jest.fn().mockResolvedValue(null),
        resolveRepositoryFolderName: jest.fn(),
        resolveDirectoryGroupFolderName: jest.fn().mockResolvedValue(null),
        buildCentralizedPath: jest.fn(),
        sanitizeFileName: jest.fn(),
        buildRuleFileName: jest.fn(
            (title?: string, uuid?: string) =>
                `${(title || '')
                    .toLowerCase()
                    .replace(/[^a-z0-9]+/g, '-')
                    .replace(/^-+|-+$/g, '') || 'rule'}${
                    uuid ? `-${String(uuid).slice(0, 8)}` : ''
                }.yml`,
        ),
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
        team: { uuid: 'team-1' },
    };

    const ownerUser = {
        ...repoAdminUser,
        role: Role.OWNER,
    };

    // The global rule as stored; the toggle sends this back verbatim with
    // only inheritance.exclude changed (mirrors handleDisableInherited in
    // apps/web modal.tsx).
    const existingGlobalRule = {
        uuid: 'rule-1',
        title: 'Avoid mixed concerns in one PR',
        rule: 'Do not combine mechanical changes with behavioral changes.',
        path: '',
        severity: 'high',
        scope: 'file',
        status: KodyRulesStatus.ACTIVE,
        type: KodyRulesType.STANDARD,
        origin: KodyRulesOrigin.MANUAL,
        repositoryId: 'global',
        examples: [],
        inheritance: {
            inheritable: true,
            exclude: [],
            include: [],
        },
    };

    const toggleDto = (overrides: Record<string, unknown>) =>
        ({
            ...existingGlobalRule,
            ...overrides,
        }) as any;

    const buildUseCase = async (user: Record<string, unknown>) => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                CreateOrUpdateKodyRulesUseCase,
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
                    provide: CONTEXT_RESOLUTION_SERVICE_TOKEN,
                    useValue: {
                        getTeamIdByOrganizationAndRepository: jest.fn(),
                        getRepositoryNameByOrganizationAndRepository:
                            jest.fn(),
                    } as Partial<IContextResolutionService>,
                },
                {
                    provide: ContextReferenceDetectionService,
                    useValue: { detectAndSaveReferences: jest.fn() },
                },
                {
                    provide: CentralizedConfigPrService,
                    useValue: centralizedConfigPrServiceMock,
                },
                {
                    provide: PermissionValidationService,
                    useValue: {
                        getBYOKConfig: jest.fn().mockResolvedValue(null),
                        getSubscriptionStatus: jest
                            .fn()
                            .mockResolvedValue(undefined),
                    },
                },
                {
                    provide: KODY_RULE_DETECTOR_COMPILER_TOKEN,
                    useValue: {
                        compileAndSave: jest
                            .fn()
                            .mockResolvedValue(undefined),
                    },
                },
            ],
        }).compile();

        const useCase = module.get(CreateOrUpdateKodyRulesUseCase);

        // Use-cases no longer inject REQUEST — the controller forwards the
        // authenticated user. Wrap execute() to pass the test user through.
        return {
            execute: (
                dto: any,
                organizationId: string,
                userInfo?: { userId: string; userEmail: string },
                skipAuthorization?: boolean,
                teamIdOverride?: string,
            ) =>
                useCase.execute(
                    dto,
                    organizationId,
                    userInfo,
                    skipAuthorization,
                    teamIdOverride,
                    user as any,
                ),
        };
    };

    beforeEach(() => {
        jest.clearAllMocks();
        permissionsServiceMock.findOne.mockResolvedValue({
            permissions: { assignedRepositoryIds: ['repo-a'] },
        });
        centralizedConfigPrServiceMock.getCentralizedRepositoryIfEnabled.mockResolvedValue(
            null,
        );
        centralizedConfigPrServiceMock.createMutationPullRequestIfEnabled.mockResolvedValue(
            { mode: 'direct' },
        );
        kodyRulesServiceMock.findById.mockResolvedValue(
            existingGlobalRule as any,
        );
        kodyRulesServiceMock.createOrUpdate.mockResolvedValue({
            ...existingGlobalRule,
        } as any);
    });

    it('allows a repo admin to exclude their assigned repo from an inherited global rule', async () => {
        const useCase = await buildUseCase(repoAdminUser);

        const dto = toggleDto({
            inheritance: { inheritable: true, exclude: ['repo-a'], include: [] },
        });

        await expect(useCase.execute(dto, 'org-1')).resolves.toBeDefined();

        expect(kodyRulesServiceMock.createOrUpdate).toHaveBeenCalled();
    });

    it('allows a repo admin to re-enable inheritance for their assigned repo', async () => {
        const useCase = await buildUseCase(repoAdminUser);
        kodyRulesServiceMock.findById.mockResolvedValue({
            ...existingGlobalRule,
            inheritance: {
                inheritable: true,
                exclude: ['repo-a'],
                include: [],
            },
        } as any);

        const dto = toggleDto({
            inheritance: { inheritable: true, exclude: [], include: [] },
        });

        await expect(useCase.execute(dto, 'org-1')).resolves.toBeDefined();

        expect(kodyRulesServiceMock.createOrUpdate).toHaveBeenCalled();
    });

    it('denies a repo admin toggling a repository they are not assigned to', async () => {
        const useCase = await buildUseCase(repoAdminUser);

        const dto = toggleDto({
            inheritance: { inheritable: true, exclude: ['repo-b'], include: [] },
        });

        await expect(useCase.execute(dto, 'org-1')).rejects.toThrow(
            ForbiddenException,
        );

        expect(kodyRulesServiceMock.createOrUpdate).not.toHaveBeenCalled();
    });

    it('denies a repo admin smuggling content changes alongside the toggle', async () => {
        const useCase = await buildUseCase(repoAdminUser);

        const dto = toggleDto({
            title: 'Changed title',
            inheritance: { inheritable: true, exclude: ['repo-a'], include: [] },
        });

        await expect(useCase.execute(dto, 'org-1')).rejects.toThrow(
            ForbiddenException,
        );

        expect(kodyRulesServiceMock.createOrUpdate).not.toHaveBeenCalled();
    });

    it('denies a repo admin flipping rule-wide inheritable via the toggle path', async () => {
        const useCase = await buildUseCase(repoAdminUser);

        const dto = toggleDto({
            inheritance: { inheritable: false, exclude: ['repo-a'], include: [] },
        });

        await expect(useCase.execute(dto, 'org-1')).rejects.toThrow(
            ForbiddenException,
        );

        expect(kodyRulesServiceMock.createOrUpdate).not.toHaveBeenCalled();
    });

    it('still denies a repo admin editing a global rule outright', async () => {
        const useCase = await buildUseCase(repoAdminUser);

        const dto = toggleDto({ title: 'New global title' });

        await expect(useCase.execute(dto, 'org-1')).rejects.toThrow(
            ForbiddenException,
        );

        expect(kodyRulesServiceMock.createOrUpdate).not.toHaveBeenCalled();
    });

    it('keeps the owner able to edit global rules and toggles alike', async () => {
        const useCase = await buildUseCase(ownerUser);

        const dto = toggleDto({
            title: 'Owner edit',
            inheritance: { inheritable: true, exclude: ['repo-b'], include: [] },
        });

        await expect(useCase.execute(dto, 'org-1')).resolves.toBeDefined();

        expect(kodyRulesServiceMock.createOrUpdate).toHaveBeenCalled();
    });
});
