import { KodyRulesSyncService } from '@libs/kodyRules/infrastructure/adapters/services/kodyRulesSync.service';
import { KodyRulesStatus } from '@libs/kodyRules/domain/interfaces/kodyRules.interface';

jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
    }),
}));

describe('KodyRulesSyncService.syncRepositoryMain', () => {
    const organizationAndTeamData = {
        organizationId: 'org-1',
        teamId: 'team-1',
    };

    const repository = {
        id: 'repo-1',
        name: 'backend-services',
        fullName: 'acme/backend-services',
        defaultBranch: 'main',
    };

    function createService(
        opts: {
            repoInstructionsEnabled?: boolean;
            fileContent?: string;
        } = {},
    ) {
        const repoInstructionsEnabled = opts.repoInstructionsEnabled ?? false;
        const fileContent =
            opts.fileContent ??
            ['---', 'title: Logging Rule', '---', 'Use log'].join('\n');

        const kodyRulesService = {
            createOrUpdate: jest.fn().mockResolvedValue({ uuid: 'rule-1' }),
        };
        const parametersService = {
            findByKey: jest.fn().mockResolvedValue({
                configValue: {
                    repositories: [
                        {
                            id: 'repo-1',
                            configs: { repoInstructionsEnabled },
                            directories: [
                                {
                                    id: 'dir-1',
                                    path: 'qantilever',
                                },
                            ],
                        },
                    ],
                },
            }),
        };
        const contextResolutionService = {
            getRepositoryNameByOrganizationAndRepository: jest
                .fn()
                .mockResolvedValue('backend-services'),
            getTeamIdByOrganizationAndRepository: jest
                .fn()
                .mockResolvedValue('team-1'),
        };
        const codeManagementService = {
            getDefaultBranch: jest.fn().mockResolvedValue('main'),
            getRepositoryAllFiles: jest.fn(),
            getRepositoryContentFile: jest.fn().mockResolvedValue({
                data: {
                    content: Buffer.from(fileContent, 'utf-8').toString(
                        'base64',
                    ),
                    encoding: 'base64',
                },
            }),
        };
        const updateOrCreateCodeReviewParameterUseCase = {
            execute: jest.fn().mockResolvedValue(undefined),
        };
        const permissionValidationService = {
            validateBasicLicense: jest
                .fn()
                .mockResolvedValue({ allowed: true }),
            getBYOKConfig: jest.fn().mockResolvedValue(undefined),
        };
        const observabilityService = {};
        const contextReferenceDetectionService = {};

        const service = new KodyRulesSyncService(
            kodyRulesService as any,
            parametersService as any,
            contextResolutionService as any,
            codeManagementService as any,
            updateOrCreateCodeReviewParameterUseCase as any,
            {} as any, // createOrUpdateKodyRulesUseCase
            {} as any, // deleteRuleInOrganizationByIdKodyRulesUseCase
            permissionValidationService as any,
            observabilityService as any,
            contextReferenceDetectionService as any,
        );

        jest.spyOn(service as any, 'templateFileToRule').mockResolvedValue({
            kind: 'rule',
            rule: {
                title: 'Logging Rule',
                rule: 'Use log instead of logger',
                path: '**/*',
                severity: 'medium',
                scope: 'file',
                examples: [],
            },
        });
        jest.spyOn(
            service as any,
            'processContextReferences',
        ).mockResolvedValue(undefined);

        return {
            service,
            kodyRulesService,
            codeManagementService,
        };
    }

    it('syncs only the requested path during manual resync', async () => {
        const { service, kodyRulesService, codeManagementService } =
            createService();

        await service.syncRepositoryMain({
            organizationAndTeamData,
            repository,
            path: 'qantilever/.kody/rules/logging.md',
        });

        expect(
            codeManagementService.getRepositoryAllFiles,
        ).not.toHaveBeenCalled();
        expect(
            codeManagementService.getRepositoryContentFile,
        ).toHaveBeenCalledWith(
            expect.objectContaining({
                file: { filename: 'qantilever/.kody/rules/logging.md' },
            }),
        );
        expect(kodyRulesService.createOrUpdate).toHaveBeenCalledWith(
            organizationAndTeamData,
            expect.objectContaining({
                sourcePath: 'qantilever/.kody/rules/logging.md',
            }),
            expect.any(Object),
        );
    });

    it('soft-deletes the rule when the requested file is gone from the default branch', async () => {
        const { service, kodyRulesService, codeManagementService } =
            createService();
        (kodyRulesService as any).findByOrganizationId = jest
            .fn()
            .mockResolvedValue({
                rules: [
                    {
                        uuid: 'r1',
                        repositoryId: 'repo-1',
                        sourcePath: '.kody/rules/logging.md',
                        status: KodyRulesStatus.ACTIVE,
                    },
                ],
            });
        codeManagementService.getRepositoryContentFile.mockResolvedValue(
            null,
        );

        await service.syncRepositoryMain({
            organizationAndTeamData,
            repository,
            path: '.kody/rules/logging.md',
        });

        expect(kodyRulesService.createOrUpdate).toHaveBeenCalledWith(
            organizationAndTeamData,
            expect.objectContaining({
                uuid: 'r1',
                status: KodyRulesStatus.DELETED,
            }),
            expect.any(Object),
        );
    });
});

// ─── Bug regression tests ──────────────────────────────────────────────────────

describe('KodyRulesSyncService — bulk actions on frozen coding-agent rules', () => {
    const organizationAndTeamData = {
        organizationId: 'org-1',
        teamId: 'team-1',
    };

    function buildServiceForCleanup(existingRules: any[]) {
        const kodyRulesService = {
            findByOrganizationId: jest
                .fn()
                .mockResolvedValue({ rules: existingRules }),
            createOrUpdate: jest
                .fn()
                .mockResolvedValue({ uuid: 'rule-updated' }),
        };

        // Bulk pause/resume route through the centralized-aware upsert use case;
        // delete routes through the centralized-aware delete use case. Both fall
        // back to a direct DB write internally when centralized config is off.
        const createOrUpdateKodyRulesUseCase = {
            execute: jest.fn().mockResolvedValue({ uuid: 'rule-updated' }),
        };
        const deleteRuleInOrganizationByIdKodyRulesUseCase = {
            execute: jest.fn().mockResolvedValue(true),
        };

        const service = new KodyRulesSyncService(
            kodyRulesService as any,
            {} as any, // parametersService
            {} as any, // contextResolutionService
            {} as any, // codeManagementService
            {} as any, // updateOrCreateCodeReviewParameterUseCase
            createOrUpdateKodyRulesUseCase as any,
            deleteRuleInOrganizationByIdKodyRulesUseCase as any,
            {} as any, // permissionValidationService
            {} as any, // observabilityService
            {} as any, // contextReferenceDetectionService
        );

        return {
            service,
            kodyRulesService,
            createOrUpdateKodyRulesUseCase,
            deleteRuleInOrganizationByIdKodyRulesUseCase,
        };
    }

    it('soft-deletes (status=DELETED) every coding-agent rule of a repository on purge', async () => {
        // Purge flips their status to DELETED, which keeps the record for
        // audit/undo while removing it from the active rule set
        // (filterKodyRules drops any rule whose status !== ACTIVE).
        const { service, deleteRuleInOrganizationByIdKodyRulesUseCase } =
            buildServiceForCleanup([
                {
                    uuid: 'rule-from-bff',
                    repositoryId: 'repo-1',
                    sourcePath: 'applications/backoffice-bff/.cursorrules',
                    status: 'active',
                },
                {
                    uuid: 'rule-from-sales',
                    repositoryId: 'repo-1',
                    sourcePath:
                        'applications/sales-flow/.cursor/rules/arch.mdc',
                    status: 'active',
                },
                {
                    uuid: 'rule-user-created',
                    repositoryId: 'repo-1',
                    sourcePath: null,
                    status: 'active',
                },
                {
                    uuid: 'rule-other-repo',
                    repositoryId: 'repo-2',
                    sourcePath: 'some/.cursorrules',
                    status: 'active',
                },
            ]);

        await (service as any).purgeAllIdeSyncRulesForRepository({
            organizationAndTeamData,
            repositoryId: 'repo-1',
        });

        const del = deleteRuleInOrganizationByIdKodyRulesUseCase.execute;
        expect(del).toHaveBeenCalledTimes(2);
        const deletedIds = (del as jest.Mock).mock.calls.map(([id]) => id);
        expect(deletedIds.sort()).toEqual(['rule-from-bff', 'rule-from-sales']);
    });

    it('does not touch user-created rules (sourcePath is null) during purge', async () => {
        const { service, deleteRuleInOrganizationByIdKodyRulesUseCase } =
            buildServiceForCleanup([
                {
                    uuid: 'rule-hand-authored',
                    repositoryId: 'repo-1',
                    sourcePath: null,
                    status: 'active',
                },
                {
                    uuid: 'rule-no-source',
                    repositoryId: 'repo-1',
                    sourcePath: undefined,
                    status: 'active',
                },
            ]);

        await (service as any).purgeAllIdeSyncRulesForRepository({
            organizationAndTeamData,
            repositoryId: 'repo-1',
        });

        expect(
            deleteRuleInOrganizationByIdKodyRulesUseCase.execute,
        ).not.toHaveBeenCalled();
    });

    it('does not touch rules from other repositories during purge', async () => {
        const { service, deleteRuleInOrganizationByIdKodyRulesUseCase } =
            buildServiceForCleanup([
                {
                    uuid: 'rule-repo-2',
                    repositoryId: 'repo-2',
                    sourcePath: 'some/.cursorrules',
                    status: 'active',
                },
            ]);

        await (service as any).purgeAllIdeSyncRulesForRepository({
            organizationAndTeamData,
            repositoryId: 'repo-1',
        });

        expect(
            deleteRuleInOrganizationByIdKodyRulesUseCase.execute,
        ).not.toHaveBeenCalled();
    });

    it('pauseAllIdeSyncRulesForRepository flips ACTIVE rules to PAUSED, leaves PAUSED/DELETED alone', async () => {
        const { service, createOrUpdateKodyRulesUseCase } =
            buildServiceForCleanup([
                {
                    uuid: 'rule-active',
                    repositoryId: 'repo-1',
                    sourcePath: '.cursorrules',
                    status: 'active',
                },
                {
                    uuid: 'rule-already-paused',
                    repositoryId: 'repo-1',
                    sourcePath: '.cursorrules',
                    status: 'paused',
                },
                {
                    uuid: 'rule-deleted',
                    repositoryId: 'repo-1',
                    sourcePath: '.cursorrules',
                    status: 'deleted',
                },
                {
                    uuid: 'rule-onboard',
                    repositoryId: 'repo-1',
                    sourcePath: 'package.json',
                    status: 'active',
                },
            ]);

        await (service as any).pauseAllIdeSyncRulesForRepository({
            organizationAndTeamData,
            repositoryId: 'repo-1',
        });

        // Only the ACTIVE auto-sync rule is touched
        expect(createOrUpdateKodyRulesUseCase.execute).toHaveBeenCalledTimes(1);
        expect(createOrUpdateKodyRulesUseCase.execute).toHaveBeenCalledWith(
            expect.objectContaining({ uuid: 'rule-active', status: 'paused' }),
            organizationAndTeamData.organizationId,
            expect.any(Object),
            true,
            organizationAndTeamData.teamId,
        );
    });

    it('resumeAllIdeSyncRulesForRepository flips PAUSED rules back to ACTIVE, leaves DELETED alone', async () => {
        const { service, createOrUpdateKodyRulesUseCase } =
            buildServiceForCleanup([
                {
                    uuid: 'rule-paused-1',
                    repositoryId: 'repo-1',
                    sourcePath: '.cursorrules',
                    status: 'paused',
                },
                {
                    uuid: 'rule-paused-2',
                    repositoryId: 'repo-1',
                    sourcePath: 'apps/foo/.cursor/rules/x.mdc',
                    status: 'paused',
                },
                {
                    uuid: 'rule-active',
                    repositoryId: 'repo-1',
                    sourcePath: '.cursorrules',
                    status: 'active',
                },
                {
                    uuid: 'rule-deleted',
                    repositoryId: 'repo-1',
                    sourcePath: '.cursorrules',
                    status: 'deleted',
                },
            ]);

        await (service as any).resumeAllIdeSyncRulesForRepository({
            organizationAndTeamData,
            repositoryId: 'repo-1',
        });

        // Only PAUSED auto-sync rules are flipped — DELETED is not resurrected here
        const upsert = createOrUpdateKodyRulesUseCase.execute as jest.Mock;
        expect(upsert).toHaveBeenCalledTimes(2);
        const flipped = upsert.mock.calls.map(([rule]) => rule.uuid);
        expect(flipped.sort()).toEqual(['rule-paused-1', 'rule-paused-2']);
        for (const call of upsert.mock.calls) {
            expect(call[0].status).toBe('active');
        }
    });

    it('countIdeSyncRulesForRepository tallies active/paused/deleted rules from coding-agent files', async () => {
        const { service } = buildServiceForCleanup([
            {
                uuid: 'a1',
                repositoryId: 'repo-1',
                sourcePath: '.cursorrules',
                status: 'active',
            },
            {
                uuid: 'a2',
                repositoryId: 'repo-1',
                sourcePath: 'CLAUDE.md',
                status: 'active',
            },
            {
                uuid: 'p1',
                repositoryId: 'repo-1',
                sourcePath: '.cursorrules',
                status: 'paused',
            },
            {
                uuid: 'd1',
                repositoryId: 'repo-1',
                sourcePath: '.cursorrules',
                status: 'deleted',
            },
            {
                uuid: 'pin1',
                repositoryId: 'repo-1',
                sourcePath: '.cursorrules',
                status: 'active',
                pinnedSync: true,
            },
            {
                uuid: 'pin2',
                repositoryId: 'repo-1',
                sourcePath: 'CLAUDE.md',
                status: 'paused',
                pinnedSync: true,
            },
            {
                uuid: 'pinDel',
                repositoryId: 'repo-1',
                sourcePath: '.cursorrules',
                status: 'deleted',
                pinnedSync: true,
            },
            // NOT counted: rule whose sourcePath is not a coding-agent file
            {
                uuid: 'o1',
                repositoryId: 'repo-1',
                sourcePath: 'package.json',
                status: 'active',
            },
            // NOT counted: rule from another repo
            {
                uuid: 'r2',
                repositoryId: 'repo-2',
                sourcePath: '.cursorrules',
                status: 'active',
            },
        ]);

        const counts = await (service as any).countIdeSyncRulesForRepository({
            organizationAndTeamData,
            repositoryId: 'repo-1',
        });

        expect(counts).toEqual({ active: 3, paused: 2, deleted: 2 });
    });

    it('does not touch rules whose sourcePath is not a coding-agent file during purge', async () => {
        // REGRESSION: previously the filter was `sourcePath != null`, which
        // erroneously matched rules from the Onboard flow (which also persist
        // sourcePath, but pointing at files like package.json / esbuild.config.js
        // that are not in the IDE-rule pattern set). Toggling IDE auto-sync off
        // would silently delete those Onboard rules. The filter now requires
        // the sourcePath to be a coding-agent file (isAgentInstructionSource).
        const { service, deleteRuleInOrganizationByIdKodyRulesUseCase } =
            buildServiceForCleanup([
                // Auto-sync rules — should be purged
                {
                    uuid: 'rule-cursor-root',
                    repositoryId: 'repo-1',
                    sourcePath: '.cursorrules',
                    status: 'active',
                },
                {
                    uuid: 'rule-cursor-subdir',
                    repositoryId: 'repo-1',
                    sourcePath: 'applications/foo/.cursor/rules/api.mdc',
                    status: 'active',
                },
                // Rules whose sourcePath is not a coding-agent file — left alone
                {
                    uuid: 'rule-onboard-pkg',
                    repositoryId: 'repo-1',
                    sourcePath: 'package.json',
                    status: 'active',
                },
                {
                    uuid: 'rule-onboard-esbuild',
                    repositoryId: 'repo-1',
                    sourcePath: 'esbuild.config.js',
                    status: 'active',
                },
                {
                    uuid: 'rule-onboard-tsconfig',
                    repositoryId: 'repo-1',
                    sourcePath: 'apps/web/tsconfig.json',
                    status: 'active',
                },
            ]);

        await (service as any).purgeAllIdeSyncRulesForRepository({
            organizationAndTeamData,
            repositoryId: 'repo-1',
        });

        const del =
            deleteRuleInOrganizationByIdKodyRulesUseCase.execute as jest.Mock;
        expect(del).toHaveBeenCalledTimes(2);
        const purgedUuids = del.mock.calls.map(([id]) => id);
        expect(purgedUuids.sort()).toEqual([
            'rule-cursor-root',
            'rule-cursor-subdir',
        ]);
    });
});

describe.skip('KodyRulesSyncService.scopePathToSourceDirectory (REMOVED — see validateAndScopeIdeRulePath)', () => {
    function buildBareService() {
        return new KodyRulesSyncService(
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
        );
    }

    const cases: Array<{
        name: string;
        llmPath: string;
        sourceFilePath: string;
        expected: string;
    }> = [
        // BUG REGRESSION: rule at .cursor/rules/foo.mdc must NOT scope to
        // ".cursor/rules/**/*" (would lint the rule files themselves).
        {
            name: 'root .cursor/rules/foo.mdc → repo-wide **/*',
            llmPath: '**/*',
            sourceFilePath: '.cursor/rules/foo.mdc',
            expected: '**/*',
        },
        {
            name: 'subdir .cursor/rules/x.mdc strips the IDE marker',
            llmPath: '**/*',
            sourceFilePath: 'applications/foo/.cursor/rules/x.mdc',
            expected: 'applications/foo/**/*',
        },
        {
            name: 'root .cursorrules → repo-wide **/*',
            llmPath: '**/*',
            sourceFilePath: '.cursorrules',
            expected: '**/*',
        },
        {
            name: 'subdir .cursorrules scopes to that subdir',
            llmPath: '**/*',
            sourceFilePath: 'applications/bar/.cursorrules',
            expected: 'applications/bar/**/*',
        },
        {
            name: 'root CLAUDE.md → repo-wide **/*',
            llmPath: '**/*',
            sourceFilePath: 'CLAUDE.md',
            expected: '**/*',
        },
        {
            name: 'subdir CLAUDE.md scopes to that subdir',
            llmPath: '**/*',
            sourceFilePath: 'applications/baz/CLAUDE.md',
            expected: 'applications/baz/**/*',
        },
        {
            name: 'subdir .kody/rules/* strips the IDE marker',
            llmPath: '**/*',
            sourceFilePath: 'apps/api/.kody/rules/security.md',
            expected: 'apps/api/**/*',
        },
        {
            name: 'root .kody/rules/* → repo-wide **/*',
            llmPath: '**/*',
            sourceFilePath: '.kody/rules/security.md',
            expected: '**/*',
        },
        {
            name: 'explicit non-** glob is preserved',
            llmPath: 'src/**/*.ts',
            sourceFilePath: '.cursor/rules/foo.mdc',
            expected: 'src/**/*.ts',
        },
        {
            name: 'explicit comma-separated globs are preserved',
            llmPath: 'src/**/*.ts,src/**/*.tsx',
            sourceFilePath: '.kody/rules/x.md',
            expected: 'src/**/*.ts,src/**/*.tsx',
        },
        {
            name: '.github/instructions root → repo-wide',
            llmPath: '**/*',
            sourceFilePath: '.github/instructions/api.instructions.md',
            expected: '**/*',
        },
    ];

    for (const c of cases) {
        it(c.name, () => {
            const service = buildBareService();
            const result = (service as any).scopePathToSourceDirectory(
                c.llmPath,
                c.sourceFilePath,
            );
            expect(result).toBe(c.expected);
        });
    }
});

describe('KodyRulesSyncService.resolveSyncDefaultStatus (IDE-sync knowledge-approval gate)', () => {
    const organizationAndTeamData = {
        organizationId: 'org-1',
        teamId: 'team-1',
    };

    // codeBaseConfigService is the 12th (last) constructor arg. Everything
    // before it is a stub — this helper only touches getSimpleConfig.
    function buildService(getSimpleConfig: jest.Mock) {
        const codeBaseConfigService = { getSimpleConfig };
        const service = new KodyRulesSyncService(
            {} as any, // kodyRulesService
            {} as any, // parametersService
            {} as any, // contextResolutionService
            {} as any, // codeManagementService
            {} as any, // updateOrCreateCodeReviewParameterUseCase
            {} as any, // createOrUpdateKodyRulesUseCase
            {} as any, // deleteRuleInOrganizationByIdKodyRulesUseCase
            {} as any, // permissionValidationService
            {} as any, // observabilityService
            {} as any, // contextReferenceDetectionService
            codeBaseConfigService as any,
        );
        return { service, codeBaseConfigService };
    }

    it('returns PENDING when kodyKnowledgeApproval is enabled (gate on → IDE rules await review)', async () => {
        const getSimpleConfig = jest.fn().mockResolvedValue({
            kodyKnowledgeApproval: { enabled: true },
        });
        const { service } = buildService(getSimpleConfig);

        const status = await (service as any).resolveSyncDefaultStatus(
            organizationAndTeamData,
            'repo-1',
        );

        expect(status).toBe(KodyRulesStatus.PENDING);
        // Resolves at the repository level (no directoryId).
        expect(getSimpleConfig).toHaveBeenCalledWith(organizationAndTeamData, {
            repositoryId: 'repo-1',
        });
    });

    it("returns ACTIVE when kodyKnowledgeApproval is disabled (gate off → today's behavior)", async () => {
        const getSimpleConfig = jest.fn().mockResolvedValue({
            kodyKnowledgeApproval: { enabled: false },
        });
        const { service } = buildService(getSimpleConfig);

        const status = await (service as any).resolveSyncDefaultStatus(
            organizationAndTeamData,
            'repo-1',
        );

        expect(status).toBe(KodyRulesStatus.ACTIVE);
    });

    it('returns ACTIVE when kodyKnowledgeApproval config is absent', async () => {
        const getSimpleConfig = jest.fn().mockResolvedValue({});
        const { service } = buildService(getSimpleConfig);

        const status = await (service as any).resolveSyncDefaultStatus(
            organizationAndTeamData,
            'repo-1',
        );

        expect(status).toBe(KodyRulesStatus.ACTIVE);
    });

    it('fails safe to ACTIVE when config resolution throws (never blocks the sync)', async () => {
        const getSimpleConfig = jest
            .fn()
            .mockRejectedValue(new Error('config service down'));
        const { service } = buildService(getSimpleConfig);

        const status = await (service as any).resolveSyncDefaultStatus(
            organizationAndTeamData,
            'repo-1',
        );

        expect(status).toBe(KodyRulesStatus.ACTIVE);
    });
});

describe('KodyRulesSyncService.findRuleBySourcePath — stale-record precedence', () => {
    const organizationAndTeamData = {
        organizationId: 'org-1',
        teamId: 'team-1',
    };

    function createService(rules: any[]) {
        const kodyRulesService = {
            findByOrganizationId: jest.fn().mockResolvedValue({ rules }),
        };
        const service = new KodyRulesSyncService(
            kodyRulesService as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
        );
        return service;
    }

    const lookup = (service: KodyRulesSyncService) =>
        (service as any).findRuleBySourcePath({
            organizationAndTeamData,
            repositoryId: 'repo-1',
            sourcePath: '.kody/rules/naming.md',
        });

    it('prefers the newest non-deleted record over an older soft-deleted one', async () => {
        // Customer-reported: "old rule persisted; toggle off removed it,
        // toggle on re-added it". Array.find picked the OLDEST record for
        // the sourcePath regardless of status, resurrecting the stale one.
        const service = createService([
            {
                uuid: 'stale-deleted',
                repositoryId: 'repo-1',
                sourcePath: '.kody/rules/naming.md',
                status: KodyRulesStatus.DELETED,
                createdAt: '2026-01-01T00:00:00.000Z',
            },
            {
                uuid: 'live-newer',
                repositoryId: 'repo-1',
                sourcePath: '.kody/rules/naming.md',
                status: KodyRulesStatus.ACTIVE,
                createdAt: '2026-06-01T00:00:00.000Z',
            },
        ]);

        await expect(lookup(service)).resolves.toEqual({
            uuid: 'live-newer',
            status: 'active',
        });
    });

    it('prefers a non-deleted record even when it is older', async () => {
        const service = createService([
            {
                uuid: 'deleted-newer',
                repositoryId: 'repo-1',
                sourcePath: '.kody/rules/naming.md',
                status: KodyRulesStatus.DELETED,
                createdAt: '2026-06-01T00:00:00.000Z',
            },
            {
                uuid: 'live-older',
                repositoryId: 'repo-1',
                sourcePath: '.kody/rules/naming.md',
                status: KodyRulesStatus.ACTIVE,
                createdAt: '2026-01-01T00:00:00.000Z',
            },
        ]);

        await expect(lookup(service)).resolves.toEqual({
            uuid: 'live-older',
            status: 'active',
        });
    });

    it('falls back to the deleted record when it is the only match (intentional revive)', async () => {
        const service = createService([
            {
                uuid: 'only-deleted',
                repositoryId: 'repo-1',
                sourcePath: '.kody/rules/naming.md',
                status: KodyRulesStatus.DELETED,
                createdAt: '2026-01-01T00:00:00.000Z',
            },
        ]);

        await expect(lookup(service)).resolves.toEqual({
            uuid: 'only-deleted',
            status: KodyRulesStatus.DELETED,
        });
    });

    it('returns null when nothing matches repo + sourcePath', async () => {
        const service = createService([
            {
                uuid: 'other-repo',
                repositoryId: 'repo-2',
                sourcePath: '.kody/rules/naming.md',
                status: KodyRulesStatus.ACTIVE,
            },
        ]);

        await expect(lookup(service)).resolves.toBeNull();
    });
});

describe('KodyRulesSyncService.inlineAtFileReferences — @file inlining (#1486)', () => {
    const organizationAndTeamData = {
        organizationId: 'org-1',
        teamId: 'team-1',
    };
    const repository = { id: 'repo-1', name: 'backend' };

    function createService(files: Record<string, string>) {
        const service = new KodyRulesSyncService(
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
        );
        const getFileContent = jest
            .spyOn(service as any, 'getFileContent')
            .mockImplementation(
                async (params: any) => files[params.filename] ?? null,
            );
        return { service, getFileContent };
    }

    const inline = (
        service: KodyRulesSyncService,
        content: string,
        filePath = 'CLAUDE.md',
    ) =>
        (service as any).inlineAtFileReferences({
            content,
            filePath,
            organizationAndTeamData,
            repository,
            branch: 'main',
        });

    it('inlines @AGENTS.md content referenced from CLAUDE.md', async () => {
        const { service } = createService({
            'AGENTS.md': '# Agents guidance\nNo exceptions as control flow.',
        });

        const result = await inline(
            service,
            'See @AGENTS.md for the full conventions.',
        );

        expect(result).toContain('See @AGENTS.md for the full conventions.');
        expect(result).toContain(
            '<referenced-file path="AGENTS.md" via="@AGENTS.md">',
        );
        expect(result).toContain('No exceptions as control flow.');
    });

    it('resolves relative to the referencing file dir before repo root', async () => {
        const { service, getFileContent } = createService({
            'apps/api/AGENTS.md': 'api guidance',
        });

        const result = await inline(
            service,
            'Read @AGENTS.md first.',
            'apps/api/CLAUDE.md',
        );

        expect(result).toContain(
            '<referenced-file path="apps/api/AGENTS.md" via="@AGENTS.md">',
        );
        expect(getFileContent).toHaveBeenCalledWith(
            expect.objectContaining({ filename: 'apps/api/AGENTS.md' }),
        );
    });

    it('leaves content unchanged when the reference cannot be fetched', async () => {
        const { service } = createService({});
        const content = 'See @MISSING.md for details.';

        await expect(inline(service, content)).resolves.toBe(content);
    });

    it('ignores non-file @ tokens like @kody-sync and emails', async () => {
        const { service, getFileContent } = createService({});
        const content = '@kody-sync\nContact bot@kodus.io for help.';

        await expect(inline(service, content)).resolves.toBe(content);
        expect(getFileContent).not.toHaveBeenCalled();
    });

    it('caps inlining at 5 references', async () => {
        const files: Record<string, string> = {};
        const refs: string[] = [];
        for (let i = 0; i < 8; i++) {
            files[`ref${i}.md`] = `content ${i}`;
            refs.push(`@ref${i}.md`);
        }
        const { service } = createService(files);

        const result = await inline(service, refs.join(' '));

        const inlined = (result.match(/<referenced-file /g) || []).length;
        expect(inlined).toBe(5);
    });
});
