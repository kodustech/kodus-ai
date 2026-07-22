import { KodyRulesSyncService } from '@libs/kodyRules/infrastructure/adapters/services/kodyRulesSync.service';
import {
    KodyRulesOrigin,
    KodyRulesStatus,
} from '@libs/kodyRules/domain/interfaces/kodyRules.interface';

jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
    }),
}));

const organizationAndTeamData = {
    organizationId: 'org-1',
    teamId: 'team-1',
};

/**
 * Builds a KodyRulesSyncService with just the collaborators the global-sync
 * paths touch. `rules` is the org's current rule pool as returned by
 * `findByOrganizationId`; `allFiles` is the source repo's tree at HEAD.
 */
function createService(opts: {
    rules?: any[];
    allFiles?: Array<{ path: string; sha?: string }>;
    fileContent?: string;
}) {
    const rules = opts.rules ?? [];
    const allFiles = opts.allFiles ?? [];
    const fileContent = opts.fileContent ?? 'A global architecture rule.';

    const kodyRulesService = {
        findByOrganizationId: jest
            .fn()
            .mockResolvedValue({ rules }),
        createOrUpdate: jest.fn().mockResolvedValue({ uuid: 'new-rule' }),
    };
    const codeManagementService = {
        getDefaultBranch: jest.fn().mockResolvedValue('main'),
        getRepositoryAllFiles: jest.fn().mockResolvedValue(allFiles),
        getRepositoryContentFile: jest.fn().mockResolvedValue({
            data: {
                content: Buffer.from(fileContent, 'utf-8').toString('base64'),
                encoding: 'base64',
            },
        }),
    };
    const deleteRuleInOrganizationByIdKodyRulesUseCase = {
        execute: jest.fn().mockResolvedValue(undefined),
    };

    const service = new KodyRulesSyncService(
        kodyRulesService as any,
        {} as any, // parametersService
        {} as any, // contextResolutionService
        codeManagementService as any,
        {} as any, // updateOrCreateCodeReviewParameterUseCase
        {} as any, // createOrUpdateKodyRulesUseCase
        deleteRuleInOrganizationByIdKodyRulesUseCase as any,
        {} as any, // promptRunnerService
        {} as any, // permissionValidationService
        {} as any, // observabilityService
        {} as any, // contextReferenceDetectionService
    );

    jest.spyOn(service as any, 'convertFileToKodyRules').mockResolvedValue([
        {
            title: 'Global Rule',
            rule: fileContent,
            path: '**/*',
            severity: 'medium',
            scope: 'file',
            examples: [],
        },
    ]);

    return {
        service,
        kodyRulesService,
        codeManagementService,
        deleteRuleInOrganizationByIdKodyRulesUseCase,
    };
}

const globalSyncedRule = (over: Partial<any>) => ({
    uuid: 'u-global-a',
    repositoryId: 'global',
    origin: KodyRulesOrigin.GLOBAL_REPO_FILE_SYNC,
    sourceRepositoryId: 'repo-A',
    sourcePath: 'CLAUDE.md',
    status: KodyRulesStatus.ACTIVE,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
});

describe('KodyRulesSyncService.purgeGlobalRulesForSourceRepository', () => {
    it('soft-deletes only this source repo\'s global-synced rules, never user or other-source rules', async () => {
        const rules = [
            globalSyncedRule({ uuid: 'a1', sourceRepositoryId: 'repo-A' }),
            globalSyncedRule({ uuid: 'a2', sourceRepositoryId: 'repo-A', sourcePath: 'docs/AGENTS.md' }),
            // other source repo — must be left alone
            globalSyncedRule({ uuid: 'b1', sourceRepositoryId: 'repo-B' }),
            // user-authored global rule — must be left alone
            {
                uuid: 'g-user',
                repositoryId: 'global',
                origin: KodyRulesOrigin.MANUAL,
                status: KodyRulesStatus.ACTIVE,
            },
            // already deleted from repo-A — must be skipped
            globalSyncedRule({ uuid: 'a-del', sourceRepositoryId: 'repo-A', status: KodyRulesStatus.DELETED }),
            // repo-scoped rule — must be left alone
            {
                uuid: 'r-scoped',
                repositoryId: 'repo-A',
                origin: KodyRulesOrigin.REPO_FILE_SYNC,
                status: KodyRulesStatus.ACTIVE,
            },
        ];
        const { service, deleteRuleInOrganizationByIdKodyRulesUseCase } =
            createService({ rules });

        const removed = await service.purgeGlobalRulesForSourceRepository({
            organizationAndTeamData,
            sourceRepositoryId: 'repo-A',
        });

        expect(removed).toBe(2);
        const deletedUuids =
            deleteRuleInOrganizationByIdKodyRulesUseCase.execute.mock.calls.map(
                (c: any[]) => c[0],
            );
        expect(deletedUuids.sort()).toEqual(['a1', 'a2']);
    });

    it('returns 0 and deletes nothing when the source repo has no global rules', async () => {
        const { service, deleteRuleInOrganizationByIdKodyRulesUseCase } =
            createService({
                rules: [globalSyncedRule({ sourceRepositoryId: 'repo-B' })],
            });

        const removed = await service.purgeGlobalRulesForSourceRepository({
            organizationAndTeamData,
            sourceRepositoryId: 'repo-A',
        });

        expect(removed).toBe(0);
        expect(
            deleteRuleInOrganizationByIdKodyRulesUseCase.execute,
        ).not.toHaveBeenCalled();
    });
});

describe('KodyRulesSyncService.syncRepositoryGlobal', () => {
    const repository = { id: 'repo-A', name: 'standards', fullName: 'org/standards' };

    it('short-circuits an unchanged file (same SHA) — no re-convert, no delete', async () => {
        const rules = [
            globalSyncedRule({
                uuid: 'a1',
                sourcePath: 'CLAUDE.md',
                lastContentHash: 'sha1',
            }),
        ];
        const { service, kodyRulesService, deleteRuleInOrganizationByIdKodyRulesUseCase } =
            createService({
                rules,
                allFiles: [{ path: 'CLAUDE.md', sha: 'sha1' }],
            });

        await service.syncRepositoryGlobal({
            organizationAndTeamData,
            repository,
        });

        expect(kodyRulesService.createOrUpdate).not.toHaveBeenCalled();
        expect(
            deleteRuleInOrganizationByIdKodyRulesUseCase.execute,
        ).not.toHaveBeenCalled();
    });

    it('re-imports a changed file (different SHA) tagged with source repo + new hash', async () => {
        const rules = [
            globalSyncedRule({
                uuid: 'a1',
                sourcePath: 'CLAUDE.md',
                lastContentHash: 'sha1',
            }),
        ];
        const { service, kodyRulesService } = createService({
            rules,
            allFiles: [{ path: 'CLAUDE.md', sha: 'sha2' }],
        });

        await service.syncRepositoryGlobal({
            organizationAndTeamData,
            repository,
        });

        expect(kodyRulesService.createOrUpdate).toHaveBeenCalledTimes(1);
        const dto = kodyRulesService.createOrUpdate.mock.calls[0][1];
        expect(dto).toMatchObject({
            uuid: 'a1',
            repositoryId: 'global',
            sourceRepositoryId: 'repo-A',
            lastContentHash: 'sha2',
            origin: KodyRulesOrigin.GLOBAL_REPO_FILE_SYNC,
            sourcePath: 'CLAUDE.md',
        });
    });

    it('reconciles deletions: soft-deletes a global rule whose source file is gone at HEAD', async () => {
        const rules = [
            globalSyncedRule({ uuid: 'gone', sourcePath: 'REMOVED.md' }),
        ];
        const { service, deleteRuleInOrganizationByIdKodyRulesUseCase } =
            createService({
                rules,
                allFiles: [], // file no longer exists
            });

        await service.syncRepositoryGlobal({
            organizationAndTeamData,
            repository,
        });

        expect(
            deleteRuleInOrganizationByIdKodyRulesUseCase.execute,
        ).toHaveBeenCalledWith('gone', expect.any(Object));
    });

    it('does not touch another source repo\'s rules during reconciliation', async () => {
        const rules = [
            // belongs to repo-B; syncing repo-A must never delete it even though
            // its file isn't in repo-A's tree.
            globalSyncedRule({
                uuid: 'b1',
                sourceRepositoryId: 'repo-B',
                sourcePath: 'OTHER.md',
            }),
        ];
        const { service, deleteRuleInOrganizationByIdKodyRulesUseCase } =
            createService({ rules, allFiles: [] });

        await service.syncRepositoryGlobal({
            organizationAndTeamData,
            repository,
        });

        expect(
            deleteRuleInOrganizationByIdKodyRulesUseCase.execute,
        ).not.toHaveBeenCalled();
    });

    it('reactivates a previously REJECTED rule when the changed content is re-imported', async () => {
        const rules = [
            globalSyncedRule({
                uuid: 'a1',
                sourcePath: 'CLAUDE.md',
                lastContentHash: 'sha1',
                status: KodyRulesStatus.REJECTED,
            }),
        ];
        const { service, kodyRulesService } = createService({
            rules,
            allFiles: [{ path: 'CLAUDE.md', sha: 'sha2' }],
        });

        await service.syncRepositoryGlobal({
            organizationAndTeamData,
            repository,
        });

        const dto = kodyRulesService.createOrUpdate.mock.calls[0][1];
        expect(dto.status).toBe(KodyRulesStatus.ACTIVE);
    });
});
