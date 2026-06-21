import { REQUEST } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';

import { ContextReferenceDetectionService } from '@libs/ai-engine/infrastructure/adapters/services/context/context-reference-detection.service';
import {
    CONTEXT_RESOLUTION_SERVICE_TOKEN,
    IContextResolutionService,
} from '@libs/core/context-resolution/domain/contracts/context-resolution.service.contract';
import {
    CentralizedConfigPrService,
    CentralizedPrMetadata,
} from '@libs/centralized-config/infrastructure/adapters/services/centralized-config-pr.service';
import { CreateOrUpdateKodyRulesUseCase } from '@libs/kodyRules/application/use-cases/create-or-update.use-case';
import { AuthorizationService } from '@libs/identity/infrastructure/adapters/services/permissions/authorization.service';
import {
    IKodyRulesService,
    KODY_RULES_SERVICE_TOKEN,
} from '@libs/kodyRules/domain/contracts/kodyRules.service.contract';
import {
    KodyRuleCentralizedStatus,
    KodyRulesOrigin,
    KodyRulesScope,
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

describe('CreateOrUpdateKodyRulesUseCase (centralized pending states)', () => {
    let useCase: CreateOrUpdateKodyRulesUseCase;
    let kodyRulesServiceMock: jest.Mocked<IKodyRulesService>;
    let centralizedConfigPrServiceMock: {
        createMutationPullRequestIfEnabled: jest.Mock;
        getCentralizedRepositoryIfEnabled: jest.Mock;
        resolveRepositoryFolderName: jest.Mock;
        resolveDirectoryGroupFolderName: jest.Mock;
        buildCentralizedPath: jest.Mock;
        sanitizeFileName: jest.Mock;
    };

    beforeEach(async () => {
        kodyRulesServiceMock = {
            createOrUpdate: jest.fn(),
            findById: jest.fn(),
            updateRuleReferences: jest.fn(),
        } as unknown as jest.Mocked<IKodyRulesService>;

        centralizedConfigPrServiceMock = {
            createMutationPullRequestIfEnabled: jest.fn(),
            getCentralizedRepositoryIfEnabled: jest.fn(),
            resolveRepositoryFolderName: jest.fn(),
            resolveDirectoryGroupFolderName: jest
                .fn()
                .mockResolvedValue(null),
            buildCentralizedPath: jest.fn(),
            sanitizeFileName: jest.fn(),
        };

        centralizedConfigPrServiceMock.getCentralizedRepositoryIfEnabled.mockResolvedValue(
            null,
        );

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                CreateOrUpdateKodyRulesUseCase,
                {
                    provide: KODY_RULES_SERVICE_TOKEN,
                    useValue: kodyRulesServiceMock,
                },
                {
                    provide: CONTEXT_RESOLUTION_SERVICE_TOKEN,
                    useValue: {
                        getTeamIdByOrganizationAndRepository: jest.fn(),
                        getRepositoryNameByOrganizationAndRepository: jest.fn(),
                    } as Partial<IContextResolutionService>,
                },
                {
                    provide: AuthorizationService,
                    useValue: {
                        ensure: jest.fn().mockResolvedValue(undefined),
                    },
                },
                {
                    provide: ContextReferenceDetectionService,
                    useValue: {
                        detectAndSaveReferences: jest.fn(),
                    },
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
                            team: { uuid: 'team-1' },
                            uuid: 'user-1',
                            email: 'dev@kodus.io',
                        },
                    },
                },
            ],
        }).compile();

        useCase = module.get(CreateOrUpdateKodyRulesUseCase);
    });

    it('persists create flow as pending_add when centralized PR mode is active', async () => {
        centralizedConfigPrServiceMock.createMutationPullRequestIfEnabled.mockResolvedValue(
            {
                mode: 'centralized-pr',
                prUrl: 'https://example.com/pr/10',
            } as CentralizedPrMetadata,
        );
        centralizedConfigPrServiceMock.resolveRepositoryFolderName.mockResolvedValue(
            'repo-one',
        );
        centralizedConfigPrServiceMock.sanitizeFileName.mockReturnValue(
            'avoid-debug',
        );
        centralizedConfigPrServiceMock.buildCentralizedPath.mockImplementation(
            ({ repositoryFolder, relativePath }) =>
                `${repositoryFolder}/${relativePath}`,
        );

        kodyRulesServiceMock.findById.mockResolvedValue(null);
        const result = await useCase.execute(
            {
                type: KodyRulesType.STANDARD,
                title: 'Avoid debug logs',
                rule: 'Do not commit debug logs',
                severity: 'medium' as any,
                scope: KodyRulesScope.FILE,
                path: '**/*',
                origin: KodyRulesOrigin.USER,
                repositoryId: 'repo-1',
                examples: [],
            },
            'org-1',
        );

        expect(result).toEqual(
            expect.objectContaining({ mode: 'centralized-pr' }),
        );
        expect(kodyRulesServiceMock.createOrUpdate).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                title: 'Avoid debug logs',
                repositoryId: 'repo-1',
                status: KodyRulesStatus.ACTIVE,
                centralizedConfig: {
                    path: 'repo-one/.kody-rules/review/avoid-debug.yml',
                    status: KodyRuleCentralizedStatus.PENDING_ADD,
                },
            }),
            expect.anything(),
        );
    });

    it('keeps existing centralized source path when updating a centralized-pending rule', async () => {
        centralizedConfigPrServiceMock.createMutationPullRequestIfEnabled.mockResolvedValue(
            {
                mode: 'centralized-pr',
                prUrl: 'https://example.com/pr/10',
            } as CentralizedPrMetadata,
        );
        centralizedConfigPrServiceMock.resolveRepositoryFolderName.mockResolvedValue(
            'repo-one',
        );

        kodyRulesServiceMock.findById.mockResolvedValue({
            uuid: 'rule-1',
            type: KodyRulesType.STANDARD,
            title: 'Avoid debug logs',
            rule: 'Do not commit debug logs',
            severity: 'medium',
            scope: KodyRulesScope.FILE,
            path: '**/*',
            origin: KodyRulesOrigin.USER,
            repositoryId: 'repo-1',
            status: KodyRulesStatus.ACTIVE,
            centralizedConfig: {
                path: 'repo-one/.kody-rules/review/existing.yml',
                status: KodyRuleCentralizedStatus.PENDING_EDIT,
            },
        } as any);
        kodyRulesServiceMock.createOrUpdate.mockResolvedValue({
            uuid: 'rule-1',
        } as any);

        await useCase.execute(
            {
                uuid: 'rule-1',
                type: KodyRulesType.STANDARD,
                title: 'Avoid debug logs v2',
                rule: 'Do not commit verbose debug logs',
                severity: 'medium' as any,
                scope: KodyRulesScope.FILE,
                path: '**/*',
                origin: KodyRulesOrigin.USER,
                repositoryId: 'repo-1',
                examples: [],
            },
            'org-1',
        );

        expect(kodyRulesServiceMock.createOrUpdate).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                uuid: 'rule-1',
                status: KodyRulesStatus.ACTIVE,
                centralizedConfig: {
                    path: 'repo-one/.kody-rules/review/existing.yml',
                    status: KodyRuleCentralizedStatus.PENDING_EDIT,
                },
            }),
            expect.anything(),
        );
    });

    it('uses explicit teamId for global rule centralized mutation and writes pending_add snapshot', async () => {
        centralizedConfigPrServiceMock.createMutationPullRequestIfEnabled.mockResolvedValue(
            {
                mode: 'centralized-pr',
                prUrl: 'https://example.com/pr/11',
            } as CentralizedPrMetadata,
        );
        centralizedConfigPrServiceMock.resolveRepositoryFolderName.mockResolvedValue(
            'global',
        );
        centralizedConfigPrServiceMock.sanitizeFileName.mockReturnValue(
            'no-hardcoded-secrets',
        );
        centralizedConfigPrServiceMock.buildCentralizedPath.mockImplementation(
            ({ repositoryFolder, relativePath }) =>
                `${repositoryFolder}/${relativePath}`,
        );

        (useCase as any).request = {
            user: {
                organization: { uuid: 'org-1' },
                uuid: 'user-1',
                email: 'dev@kodus.io',
            },
        };

        kodyRulesServiceMock.findById.mockResolvedValue(null);

        await useCase.execute(
            {
                type: KodyRulesType.STANDARD,
                title: 'No hardcoded secrets',
                rule: 'Avoid hardcoded credentials in source code',
                severity: 'high' as any,
                scope: KodyRulesScope.FILE,
                path: '**/*',
                origin: KodyRulesOrigin.USER,
                repositoryId: 'global',
                examples: [],
            },
            'org-1',
            undefined,
            undefined,
            'team-explicit',
        );

        expect(
            centralizedConfigPrServiceMock.createMutationPullRequestIfEnabled,
        ).toHaveBeenCalledWith(
            expect.objectContaining({
                organizationAndTeamData: {
                    organizationId: 'org-1',
                    teamId: 'team-explicit',
                },
                repositoryId: 'global',
            }),
        );

        expect(kodyRulesServiceMock.createOrUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                organizationId: 'org-1',
                teamId: 'team-explicit',
            }),
            expect.objectContaining({
                repositoryId: 'global',
                status: KodyRulesStatus.ACTIVE,
                centralizedConfig: {
                    path: 'global/.kody-rules/review/no-hardcoded-secrets.yml',
                    status: KodyRuleCentralizedStatus.PENDING_ADD,
                },
            }),
            expect.anything(),
        );
    });

    it('updates existing file path when legacy rule has no centralizedConfig path', async () => {
        centralizedConfigPrServiceMock.createMutationPullRequestIfEnabled.mockResolvedValue(
            {
                mode: 'centralized-pr',
                prUrl: 'https://example.com/pr/12',
            } as CentralizedPrMetadata,
        );
        centralizedConfigPrServiceMock.resolveRepositoryFolderName.mockResolvedValue(
            'repo-one',
        );
        centralizedConfigPrServiceMock.sanitizeFileName
            .mockReturnValueOnce('legacy-title')
            .mockReturnValueOnce('legacy-title');
        centralizedConfigPrServiceMock.buildCentralizedPath.mockImplementation(
            ({ repositoryFolder, relativePath }) =>
                `${repositoryFolder}/${relativePath}`,
        );

        kodyRulesServiceMock.findById.mockResolvedValue({
            uuid: 'rule-legacy-1',
            type: KodyRulesType.STANDARD,
            title: 'Legacy Title',
            rule: 'Original rule content',
            severity: 'medium',
            scope: KodyRulesScope.FILE,
            path: '**/*',
            origin: KodyRulesOrigin.USER,
            repositoryId: 'repo-1',
            status: KodyRulesStatus.ACTIVE,
            centralizedConfig: undefined,
        } as any);
        kodyRulesServiceMock.createOrUpdate.mockResolvedValue({
            uuid: 'rule-legacy-1',
        } as any);

        await useCase.execute(
            {
                uuid: 'rule-legacy-1',
                type: KodyRulesType.STANDARD,
                title: 'New Title',
                rule: 'Updated rule content',
                severity: 'medium' as any,
                scope: KodyRulesScope.FILE,
                path: '**/*',
                origin: KodyRulesOrigin.USER,
                repositoryId: 'repo-1',
                examples: [],
            },
            'org-1',
        );

        expect(
            centralizedConfigPrServiceMock.createMutationPullRequestIfEnabled,
        ).toHaveBeenCalledWith(
            expect.objectContaining({
                repositoryId: 'repo-1',
                files: expect.any(Function),
            }),
        );

        expect(kodyRulesServiceMock.createOrUpdate).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                uuid: 'rule-legacy-1',
                status: KodyRulesStatus.ACTIVE,
                centralizedConfig: {
                    path: 'repo-one/.kody-rules/review/legacy-title.yml',
                    status: KodyRuleCentralizedStatus.PENDING_EDIT,
                },
            }),
            expect.anything(),
        );
    });

    it('bypasses centralized PR routing for internal sync actor', async () => {
        kodyRulesServiceMock.createOrUpdate.mockResolvedValue({
            uuid: 'synced-rule-1',
        } as any);

        const result = await useCase.execute(
            {
                type: KodyRulesType.STANDARD,
                title: 'Synced from centralized',
                rule: 'Always prefer safe defaults',
                severity: 'medium' as any,
                scope: KodyRulesScope.FILE,
                path: '**/*',
                origin: KodyRulesOrigin.USER,
                repositoryId: 'repo-1',
                examples: [],
            },
            'org-1',
            {
                userId: 'kody',
                userEmail: 'kody@kodus.io',
            },
            true,
        );

        expect(
            centralizedConfigPrServiceMock.createMutationPullRequestIfEnabled,
        ).not.toHaveBeenCalled();
        expect(kodyRulesServiceMock.createOrUpdate).toHaveBeenCalled();
        expect(result).toEqual(
            expect.objectContaining({ uuid: 'synced-rule-1' }),
        );
    });

    it('throws and avoids direct DB write when centralized is enabled but PR routing returns direct', async () => {
        centralizedConfigPrServiceMock.createMutationPullRequestIfEnabled.mockResolvedValue(
            {
                mode: 'direct',
            },
        );
        centralizedConfigPrServiceMock.getCentralizedRepositoryIfEnabled.mockResolvedValue(
            {
                id: 'central-repo-id',
                name: 'central-repo',
            },
        );

        kodyRulesServiceMock.findById.mockResolvedValue(null);

        await expect(
            useCase.execute(
                {
                    type: KodyRulesType.STANDARD,
                    title: 'Avoid debug logs',
                    rule: 'Do not commit debug logs',
                    severity: 'medium' as any,
                    scope: KodyRulesScope.FILE,
                    path: '**/*',
                    origin: KodyRulesOrigin.USER,
                    repositoryId: 'repo-1',
                    examples: [],
                },
                'org-1',
            ),
        ).rejects.toThrow(
            'Centralized config is enabled, but rule mutation was not routed through centralized PR flow',
        );

        expect(kodyRulesServiceMock.createOrUpdate).not.toHaveBeenCalled();
    });
});
