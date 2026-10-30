/**
 * Issue #1579 — centralized-config Sync must not treat "absent" as "removed".
 *
 * ROOT CAUSE
 * `removeStaleConfigs` derives the set of repositories the centralized config
 * is supposed to manage from the CURRENT discovery only. Any connected repo
 * without a `{repo}/kodus-config.yml` therefore looks stale, so Sync deselects
 * it, wipes `configs`, marks its Kody Rules DELETED and drops its PR messages.
 * In centralized-config semantics a missing per-repo file means "inherit the
 * global config", not "the user deleted this repository's configuration".
 *
 * The #1518 empty-discovery guard does not help: it only fires for a totally
 * empty discovery, so a global-only or sparse config repo sails past it.
 *
 * FIX
 * Track which repositories the centralized config actually manages, in
 * `CENTRALIZED_CONFIG.managedRepositoryIds`, written by each successful sync.
 * A repo is stale only when it was managed before AND is absent now. When the
 * managed set is unknown (first sync after this change, or a fresh install)
 * nothing is reconciled away — absence proves nothing yet.
 *
 * Tests A/B/D/F fail before the fix (they assert the safe behavior);
 * G/H prove the genuine-removal path still works and the set is persisted;
 * E is the #1540 regression lock (Git Settings must never be touched by Sync).
 */
import { createLogger } from '@libs/core/log/logger';
import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { CODE_BASE_CONFIG_SERVICE_TOKEN } from '@libs/code-review/domain/contracts/CodeBaseConfigService.contract';
import { IConfigFileMeta } from '@libs/centralized-config/domain/contracts/CentralizedConfigService.contract';
import { ParametersKey } from '@libs/core/domain/enums';
import { IntegrationConfigKey } from '@libs/core/domain/enums/Integration-config-key.enum';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { INTEGRATION_CONFIG_SERVICE_TOKEN } from '@libs/integrations/domain/integrationConfigs/contracts/integration-config.service.contracts';
import { CreateOrUpdateParametersUseCase } from '@libs/organization/application/use-cases/parameters/create-or-update-use-case';
import { PARAMETERS_SERVICE_TOKEN } from '@libs/organization/domain/parameters/contracts/parameters.service.contract';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import { DeleteRepositoryCodeReviewParameterUseCase } from '@libs/code-review/application/use-cases/configuration/delete-repository-code-review-parameter.use-case';
import { UpdateOrCreateCodeReviewParameterUseCase } from '@libs/code-review/application/use-cases/configuration/update-or-create-code-review-parameter-use-case';
import { CreateOrUpdatePullRequestMessagesUseCase } from '@libs/code-review/application/use-cases/pullRequestMessages/create-or-update-pull-request-messages.use-case';
import { PULL_REQUEST_MESSAGES_SERVICE_TOKEN } from '@libs/code-review/domain/pullRequestMessages/contracts/pullRequestMessages.service.contract';
import { CreateOrUpdateKodyRulesUseCase } from '@libs/kodyRules/application/use-cases/create-or-update.use-case';
import { DeleteRuleInOrganizationByIdKodyRulesUseCase } from '@libs/kodyRules/application/use-cases/delete-rule-in-organization-by-id.use-case';
import { KODY_RULES_SERVICE_TOKEN } from '@libs/kodyRules/domain/contracts/kodyRules.service.contract';
import { ConfigLevel } from '@libs/core/infrastructure/config/types/general/pullRequestMessages.type';
import { CentralizedConfigService } from '../centralized-config.service';

const organizationAndTeamData: OrganizationAndTeamData = {
    organizationId: 'org-1',
    teamId: 'team-1',
};

const actor = {
    organizationId: 'org-1',
    source: 'sync' as const,
    userEmail: 'kody@kodus.io',
    userId: 'kody',
};

const GLOBAL_ONLY: IConfigFileMeta[] = [{ path: 'kodus-config.yml' } as any];

const SPARSE: IConfigFileMeta[] = [
    { path: 'kodus-config.yml' } as any,
    { repositoryId: 'repo-1', path: 'repo-1/kodus-config.yml' } as any,
];

const COMPLETE: IConfigFileMeta[] = [
    { path: 'kodus-config.yml' } as any,
    { repositoryId: 'repo-1', path: 'repo-1/kodus-config.yml' } as any,
    { repositoryId: 'repo-2', path: 'repo-2/kodus-config.yml' } as any,
    { repositoryId: 'repo-3', path: 'repo-3/kodus-config.yml' } as any,
];

/** Per-repo files only — the config repo has no global `kodus-config.yml`. */
const REPO_ONLY: IConfigFileMeta[] = [
    { repositoryId: 'repo-1', path: 'repo-1/kodus-config.yml' } as any,
];

/**
 * repo-1's ONLY centralized file is a directory scope — it has no
 * `repo-1/kodus-config.yml` of its own.
 *
 * Discovery emits `directoryPaths` (plural) for these; `directoryPath`
 * (singular) has not been set on a config-file meta since commit 7ca98c8d9
 * ("Fixing sync multi directories", 2026-06-12) replaced it.
 */
const DIRECTORY_ONLY: IConfigFileMeta[] = [
    { path: 'kodus-config.yml' } as any,
    {
        repositoryId: 'repo-1',
        path: 'repo-1/src/kodus-config.yml',
        centralizedDirectoryPath: 'repo-1/src',
        directoryPaths: ['/src'],
    } as any,
];

/**
 * One selected repo carrying a per-directory scope. Used to exercise the
 * directory reconciliation loop, which `threeSelectedRepos` cannot reach —
 * every repo there has `directories: []`.
 */
function repoWithDirectoryScope() {
    return {
        configs: { languageResultPrompt: 'en-US' },
        repositories: [
            {
                id: 'repo-1',
                name: 'repo-1',
                isSelected: true,
                configs: { automatedReviewActive: true },
                directories: [
                    {
                        id: 'dir-1',
                        name: 'src',
                        path: 'src',
                        folders: [{ id: 'f-1', name: 'src', path: 'src' }],
                        configs: { automatedReviewActive: true },
                    },
                ],
            },
        ],
    };
}

/** Three connected + selected repos, no per-directory scopes. */
function threeSelectedRepos() {
    return {
        configs: { languageResultPrompt: 'en-US' },
        repositories: ['repo-1', 'repo-2', 'repo-3'].map((id) => ({
            id,
            name: id,
            isSelected: true,
            configs: { automatedReviewActive: true },
            directories: [],
        })),
    };
}

type Harness = {
    service: CentralizedConfigService;
    deleteCalls: () => string[];
    reconciledSelection: () => string[];
    kodyRulesWipedFor: () => string[];
    messagesDeletedFor: () => string[];
    integrationWrites: () => any[][];
    savedManagedIds: () => string[] | undefined;
    /** Scopes the reconcile deleted, as `repositoryId:directoryId` pairs. */
    directoryDeleteCalls: () => string[];
    /** The org-level `configs` the reconcile wrote, if it wrote at all. */
    reconciledGlobalConfigs: () => unknown;
    /** The whole CENTRALIZED_CONFIG payload the sync wrote back. */
    savedCentralizedConfig: () => any;
    /** UUIDs of the custom PR messages the sweep deleted outright. */
    customMessagesDeleted: () => string[];
    /** UUIDs of the Kody rules the sweep marked deleted. */
    kodyRulesDeleted: () => string[];
};

/**
 * @param managedRepositoryIds what a previous sync recorded as managed;
 *        `undefined` means "never recorded" (the safe/unknown case).
 * @param useRealDeleteUseCase wire the real use case so its side effects
 *        (Kody Rules, PR messages, integration configs) are observable.
 */
async function buildHarness(opts: {
    managedRepositoryIds?: string[];
    /** Directory scopes a previous sync owned, as repoId -> group folder names. */
    managedDirectoryScopes?: Record<string, string[]>;
    managedGlobalConfig?: boolean;
    repositories?: ReturnType<typeof threeSelectedRepos>;
    useRealDeleteUseCase?: boolean;
    /** What the second CENTRALIZED_CONFIG read returns; `null` = parameter gone. */
    midSweepValue?: any;
    /** Seeds the FIRST read, so a stale spread has something to resurrect. */
    activePullRequest?: any;
    /** Custom PR messages already stored for the organization. */
    existingMessages?: any[];
    /** Kody rules already stored for the organization. */
    existingRules?: any[];
    /** Folder path -> directory (group) id, as the code review config resolves it. */
    directoryIdByPath?: Record<string, string>;
    /**
     * What `IntegrationConfigKey.REPOSITORIES` returns. Defaults to `[]`,
     * which makes every directory scope UNRESOLVABLE — pass the repositories
     * to exercise the path where resolution actually succeeds.
     */
    integrationRepositories?: any[];
}): Promise<Harness> {
    const codeReviewConfig = {
        configValue: opts.repositories ?? threeSelectedRepos(),
    };

    const centralizedConfigValue: any = {
        enabled: true,
        repository: { id: 'config-repo', name: 'config-repo' },
    };
    if (opts.managedRepositoryIds !== undefined) {
        centralizedConfigValue.managedRepositoryIds = opts.managedRepositoryIds;
    }
    if (opts.managedDirectoryScopes !== undefined) {
        centralizedConfigValue.managedDirectoryScopes =
            opts.managedDirectoryScopes;
    }
    if (opts.managedGlobalConfig !== undefined) {
        centralizedConfigValue.managedGlobalConfig = opts.managedGlobalConfig;
    }
    if (opts.activePullRequest !== undefined) {
        centralizedConfigValue.activePullRequest = opts.activePullRequest;
    }

    // The service reads CENTRALIZED_CONFIG twice: once up front to load the
    // baseline, once again right before writing it back. `midSweepValue` is
    // what the second read sees, standing in for another writer — a webhook
    // clearing `activePullRequest`, or an admin disabling the feature — that
    // landed while the sweep was still deleting scopes.
    let centralizedReads = 0;
    const parametersService = {
        findByKey: jest.fn().mockImplementation((key: string) => {
            if (key === ParametersKey.CODE_REVIEW_CONFIG) {
                return Promise.resolve(codeReviewConfig);
            }
            if (key === ParametersKey.CENTRALIZED_CONFIG) {
                centralizedReads += 1;
                if (centralizedReads > 1 && opts.midSweepValue !== undefined) {
                    return Promise.resolve(
                        opts.midSweepValue === null
                            ? null
                            : { configValue: opts.midSweepValue },
                    );
                }
                return Promise.resolve({ configValue: centralizedConfigValue });
            }
            return Promise.resolve({ configValue: {} });
        }),
        findOne: jest.fn(),
    };

    const integrationConfigService = {
        findIntegrationConfigFormatted: jest
            .fn()
            .mockResolvedValue(opts.integrationRepositories ?? []),
        findOneIntegrationConfigWithIntegrations: jest.fn().mockResolvedValue({
            configValue: [
                { id: 'repo-1', name: 'repo-1' },
                { id: 'repo-2', name: 'repo-2' },
                { id: 'repo-3', name: 'repo-3' },
            ],
            integration: { uuid: 'integration-1' },
        }),
        createOrUpdateConfig: jest.fn(),
    };

    const kodyRulesService = {
        find: jest.fn().mockResolvedValue([]),
        findByOrganizationId: jest.fn().mockResolvedValue(
            opts.existingRules
                ? { toJson: () => ({ rules: opts.existingRules }) }
                : undefined,
        ),
        updateRulesStatusByFilter: jest.fn(),
    };

    const deleteRuleUseCase = { execute: jest.fn() };

    const pullRequestMessagesService = {
        find: jest.fn().mockResolvedValue(opts.existingMessages ?? []),
        findOne: jest.fn(),
        delete: jest.fn(),
    };

    const codeBaseConfigService = {
        getKodusConfigFile: jest.fn(),
        getDirectoryIdForPath: jest
            .fn()
            .mockImplementation((_org: any, _repo: any, path: string) => {
                const normalized = path.startsWith('/') ? path.slice(1) : path;
                return Promise.resolve(
                    opts.directoryIdByPath?.[normalized] ??
                        opts.directoryIdByPath?.[path],
                );
            }),
    };

    const deletePullRequestMessagesUseCase = { execute: jest.fn() };
    const createOrUpdateParametersUseCase = { execute: jest.fn() };
    const mockDeleteUseCase = { execute: jest.fn() };

    const realDeleteUseCase = new DeleteRepositoryCodeReviewParameterUseCase(
        parametersService as any,
        { execute: jest.fn().mockResolvedValue(true) } as any,
        new EventEmitter2() as any,
        deletePullRequestMessagesUseCase as any,
        kodyRulesService as any,
        {
            user: {
                organization: { uuid: 'org-1' },
                uuid: 'user-1',
                email: 'dev@kodus.io',
            },
        } as any,
        { createMutationPullRequestIfEnabled: jest.fn() } as any,
    );

    const deleteUseCase = opts.useRealDeleteUseCase
        ? realDeleteUseCase
        : mockDeleteUseCase;

    const module: TestingModule = await Test.createTestingModule({
        providers: [
            CentralizedConfigService,
            { provide: PARAMETERS_SERVICE_TOKEN, useValue: parametersService },
            {
                provide: INTEGRATION_CONFIG_SERVICE_TOKEN,
                useValue: integrationConfigService,
            },
            {
                provide: CodeManagementService,
                useValue: { getRepositoryTree: jest.fn() },
            },
            {
                provide: UpdateOrCreateCodeReviewParameterUseCase,
                useValue: { execute: jest.fn() },
            },
            {
                provide: DeleteRepositoryCodeReviewParameterUseCase,
                useValue: deleteUseCase,
            },
            {
                provide: CreateOrUpdateParametersUseCase,
                useValue: createOrUpdateParametersUseCase,
            },
            {
                provide: CreateOrUpdatePullRequestMessagesUseCase,
                useValue: { execute: jest.fn() },
            },
            {
                provide: PULL_REQUEST_MESSAGES_SERVICE_TOKEN,
                useValue: pullRequestMessagesService,
            },
            {
                provide: CODE_BASE_CONFIG_SERVICE_TOKEN,
                useValue: codeBaseConfigService,
            },
            {
                provide: CreateOrUpdateKodyRulesUseCase,
                useValue: { execute: jest.fn() },
            },
            {
                provide: DeleteRuleInOrganizationByIdKodyRulesUseCase,
                useValue: deleteRuleUseCase,
            },
            { provide: KODY_RULES_SERVICE_TOKEN, useValue: kodyRulesService },
        ],
    }).compile();

    jest.spyOn(createLogger(''), 'log').mockImplementation(() => {});
    jest.spyOn(createLogger(''), 'error').mockImplementation(() => {});
    jest.spyOn(createLogger(''), 'warn').mockImplementation(() => {});

    return {
        service: module.get<CentralizedConfigService>(CentralizedConfigService),
        deleteCalls: () =>
            (opts.useRealDeleteUseCase
                ? deletePullRequestMessagesUseCase.execute.mock.calls
                : mockDeleteUseCase.execute.mock.calls
            )
                .map((c: any[]) => c[0]?.repositoryId)
                .filter(Boolean),
        reconciledSelection: () => {
            const call = createOrUpdateParametersUseCase.execute.mock.calls
                .filter((c: any[]) => c[0] === ParametersKey.CODE_REVIEW_CONFIG)
                .pop();
            if (!call) return ['<no reconcile call>'];
            return call[1].repositories
                .filter((r: any) => r.isSelected)
                .map((r: any) => r.id);
        },
        kodyRulesWipedFor: () =>
            kodyRulesService.updateRulesStatusByFilter.mock.calls.map(
                (c: any[]) => c[1],
            ),
        messagesDeletedFor: () =>
            deletePullRequestMessagesUseCase.execute.mock.calls.map(
                (c: any[]) => c[0]?.repositoryId,
            ),
        integrationWrites: () =>
            integrationConfigService.createOrUpdateConfig.mock.calls,
        savedManagedIds: () => {
            const call = createOrUpdateParametersUseCase.execute.mock.calls
                .filter((c: any[]) => c[0] === ParametersKey.CENTRALIZED_CONFIG)
                .pop();
            return call?.[1]?.managedRepositoryIds;
        },
        directoryDeleteCalls: () =>
            (opts.useRealDeleteUseCase
                ? deletePullRequestMessagesUseCase.execute.mock.calls
                : mockDeleteUseCase.execute.mock.calls
            )
                .filter((c: any[]) => c[0]?.directoryId)
                .map((c: any[]) => `${c[0].repositoryId}:${c[0].directoryId}`),
        savedCentralizedConfig: () =>
            createOrUpdateParametersUseCase.execute.mock.calls
                .filter((c: any[]) => c[0] === ParametersKey.CENTRALIZED_CONFIG)
                .pop()?.[1],
        customMessagesDeleted: () =>
            pullRequestMessagesService.delete.mock.calls.map(
                (c: any[]) => c[0],
            ),
        kodyRulesDeleted: () =>
            deleteRuleUseCase.execute.mock.calls.map((c: any[]) => c[0]),
        reconciledGlobalConfigs: () => {
            const call = createOrUpdateParametersUseCase.execute.mock.calls
                .filter((c: any[]) => c[0] === ParametersKey.CODE_REVIEW_CONFIG)
                .pop();
            return call ? call[1].configs : '<no reconcile call>';
        },
    };
}

describe('#1579 Sync must not read "absent" as "removed"', () => {
    it('A: global-only config repo leaves every repository selected', async () => {
        const h = await buildHarness({});

        const result = await h.service.removeStaleConfigs({
            organizationAndTeamData,
            configFiles: GLOBAL_ONLY,
            actor,
        });

        expect(result.success).toBe(true);
        expect(h.deleteCalls()).toEqual([]);
        expect(h.reconciledSelection()).toEqual(['<no reconcile call>']);
    });

    it('B: one folder out of three does NOT deselect the other two', async () => {
        const h = await buildHarness({});

        await h.service.removeStaleConfigs({
            organizationAndTeamData,
            configFiles: SPARSE,
            actor,
        });

        expect(h.deleteCalls()).toEqual([]);
    });

    it('C: a folder for every repo changes nothing', async () => {
        const h = await buildHarness({});

        await h.service.removeStaleConfigs({
            organizationAndTeamData,
            configFiles: COMPLETE,
            actor,
        });

        expect(h.deleteCalls()).toEqual([]);
    });

    it('D: the #1518 empty-discovery guard still holds', async () => {
        const h = await buildHarness({});

        const guarded = await h.service.removeStaleConfigs({
            organizationAndTeamData,
            configFiles: [],
            actor,
        });

        expect(guarded.message).toContain('empty-discovery guard');
        expect(h.deleteCalls()).toEqual([]);
    });

    it('F: sparse sync preserves Kody Rules and PR messages of untouched repos', async () => {
        const h = await buildHarness({ useRealDeleteUseCase: true });

        await h.service.removeStaleConfigs({
            organizationAndTeamData,
            configFiles: SPARSE,
            actor,
        });

        expect(h.kodyRulesWipedFor()).toEqual([]);
        expect(h.messagesDeletedFor()).toEqual([]);
    });

    // -- the genuine-removal path must keep working ----------------------

    it('G: a repo previously managed and now absent IS cleaned up', async () => {
        const h = await buildHarness({
            managedRepositoryIds: ['repo-1', 'repo-2', 'repo-3'],
            useRealDeleteUseCase: true,
        });

        await h.service.removeStaleConfigs({
            organizationAndTeamData,
            configFiles: SPARSE,
            actor,
        });

        expect(h.messagesDeletedFor().sort()).toEqual(['repo-2', 'repo-3']);
        expect(h.kodyRulesWipedFor().sort()).toEqual(['repo-2', 'repo-3']);
    });

    it('H: the managed set is persisted so the next sync can detect removals', async () => {
        const h = await buildHarness({ managedRepositoryIds: [] });

        await h.service.removeStaleConfigs({
            organizationAndTeamData,
            configFiles: COMPLETE,
            actor,
        });

        expect(h.savedManagedIds()?.sort()).toEqual([
            'repo-1',
            'repo-2',
            'repo-3',
        ]);
    });

    // -- #1540 regression lock ------------------------------------------

    it('E: even a genuine removal never writes IntegrationConfigKey.REPOSITORIES', async () => {
        const h = await buildHarness({
            managedRepositoryIds: ['repo-1', 'repo-2', 'repo-3'],
            useRealDeleteUseCase: true,
        });

        await h.service.removeStaleConfigs({
            organizationAndTeamData,
            configFiles: SPARSE,
            actor,
        });

        // Non-vacuous: the removal really ran (asserted in G).
        expect(h.integrationWrites()).toEqual([]);
        expect(h.integrationWrites()).not.toContainEqual(
            expect.arrayContaining([IntegrationConfigKey.REPOSITORIES]),
        );
    });

    // -- the other two scopes the fix guards ----------------------------
    //
    // A/B/C/F only ever exercise repository-level reconciliation against a
    // discovery that always carries a global `kodus-config.yml`, so the
    // directory loop and the global-config branch were both unguarded:
    // reverting either one kept the whole suite green. These two close that.

    it('I: directories of an unmanaged repository are left alone', async () => {
        const h = await buildHarness({
            repositories: repoWithDirectoryScope(),
        });

        // Global-only discovery: repo-1 is not discovered and no previous sync
        // recorded it, so the centralized config does not own it — its
        // per-directory scope is none of Sync's business.
        await h.service.removeStaleConfigs({
            organizationAndTeamData,
            configFiles: GLOBAL_ONLY,
            actor,
        });

        expect(h.directoryDeleteCalls()).toEqual([]);
    });

    it('J: the global config survives a config repo that never had one', async () => {
        const h = await buildHarness({
            managedRepositoryIds: ['repo-1'],
            // No previous sync ever owned a global `kodus-config.yml`.
            managedGlobalConfig: false,
        });

        // Discovery carries per-repo files only — no global file to be found.
        await h.service.removeStaleConfigs({
            organizationAndTeamData,
            configFiles: REPO_ONLY,
            actor,
        });

        // Absence of a global file it never owned must not reset the org's
        // `configs` (default model / BYOK / language) to {}.
        expect(h.reconciledGlobalConfigs()).not.toEqual({});
    });

    // -- the baseline write must not clobber concurrent writers ---------
    //
    // CENTRALIZED_CONFIG carries `enabled`, `repository` and
    // `activePullRequest` alongside the baseline, and the sweep is long:
    // one delete use case per stale scope, each a round of git and database
    // calls. CentralizedConfigPrService clears `activePullRequest` from a
    // webhook and CentralizedConfigInitUseCase flips `enabled` from the UI,
    // both of which can land in that window.

    it('K: a configuration disabled during the sweep is not re-enabled', async () => {
        const h = await buildHarness({
            managedRepositoryIds: ['repo-1', 'repo-2', 'repo-3'],
            // An admin turned centralized config off while the sweep ran —
            // exactly what CentralizedConfigInitUseCase writes.
            midSweepValue: {
                enabled: false,
                repository: null,
                activePullRequest: null,
            },
        });

        await h.service.removeStaleConfigs({
            organizationAndTeamData,
            configFiles: COMPLETE,
            actor,
        });

        const written = h.savedCentralizedConfig();

        expect(written.enabled).toBe(false);
        expect(written.repository).toBeNull();
        // Non-vacuous: the baseline really was recorded on that same write.
        expect(written.managedRepositoryIds?.sort()).toEqual([
            'repo-1',
            'repo-2',
            'repo-3',
        ]);
    });

    it('L: a pull request cleared during the sweep is not resurrected', async () => {
        const h = await buildHarness({
            managedRepositoryIds: ['repo-1', 'repo-2', 'repo-3'],
            // A pull request was open when the sweep started...
            activePullRequest: {
                prUrl: 'https://github.com/acme/config/pull/7',
                prNumber: 7,
                sourceBranch: 'kodus-centralized-config',
                repository: { id: 'config-repo', name: 'config-repo' },
                createdAt: '2026-07-30T10:00:00.000Z',
                updatedAt: '2026-07-30T10:00:00.000Z',
            },
            // ...and merged mid-sweep, so the webhook nulled the metadata.
            midSweepValue: {
                enabled: true,
                repository: { id: 'config-repo', name: 'config-repo' },
                activePullRequest: null,
            },
        });

        await h.service.removeStaleConfigs({
            organizationAndTeamData,
            configFiles: COMPLETE,
            actor,
        });

        expect(h.savedCentralizedConfig().activePullRequest).toBeNull();
    });

    // -- directory-only repositories ------------------------------------
    //
    // The repository-level baseline is built from
    // `configFiles.filter((meta) => meta.repositoryId && !meta.directoryPath)`.
    // Since 7ca98c8d9 discovery never sets `directoryPath` on a config-file
    // meta — only `directoryPaths` — so that filter admits directory scopes
    // and records their repository as if it owned a `{repo}/kodus-config.yml`.
    //
    // Harmless while the set only meant "keep". As the #1579 baseline it
    // means the repository goes stale the moment the directory scope is
    // removed, taking the whole repository's selection with it. Reproduced
    // against QA: deleting `xfile-review-fixtures/src/kodus-config.yml`
    // deselected `xfile-review-fixtures`.

    it('N: a directory-only scope is not recorded as a repository baseline', async () => {
        const h = await buildHarness({ managedRepositoryIds: [] });

        await h.service.removeStaleConfigs({
            organizationAndTeamData,
            configFiles: DIRECTORY_ONLY,
            actor,
        });

        // repo-1 owns no `repo-1/kodus-config.yml`, so nothing about it is
        // the repository scope's to reconcile later.
        expect(h.savedManagedIds()).toEqual([]);
    });

    it('O: removing a directory-only scope does not deselect the repository', async () => {
        // What the previous sync recorded, once N holds: repo-1 absent.
        const h = await buildHarness({ managedRepositoryIds: [] });

        // The directory scope is gone from the config repo now.
        await h.service.removeStaleConfigs({
            organizationAndTeamData,
            configFiles: GLOBAL_ONLY,
            actor,
        });

        expect(h.deleteCalls()).toEqual([]);
        expect(h.reconciledSelection()).toEqual(['<no reconcile call>']);
    });

    it('M: a parameter deleted during the sweep is not recreated', async () => {
        const h = await buildHarness({
            managedRepositoryIds: ['repo-1', 'repo-2', 'repo-3'],
            midSweepValue: null,
        });

        await h.service.removeStaleConfigs({
            organizationAndTeamData,
            configFiles: COMPLETE,
            actor,
        });

        // Writing would leave a parameter holding a baseline and nothing else
        // — no `repository`, no `enabled`.
        expect(h.savedCentralizedConfig()).toBeUndefined();
    });

    /**
     * Orphaned directory scopes. Reproduced by hand before writing these: a
     * repository whose only centralized file was `{repo}/{dir}/kodus-config.yml`
     * kept that scope forever once the file was deleted — through a merged
     * pull request, through the merge-fired sync, and through any number of
     * manual syncs.
     *
     * The cause was the granularity of the recorded baseline, so these pin
     * the granularity: T1/T2 that repository-level ownership grants nothing
     * over directories, T3 what gets recorded, T4/T5 that the recorded scope
     * is cleanable without touching the repository around it.
     */
    it('T1: repository-level ownership does not reach into directories', async () => {
        const h = await buildHarness({
            repositories: repoWithDirectoryScope(),
            // Owning `repo-1/kodus-config.yml` says nothing about `repo-1/src`.
            managedRepositoryIds: ['repo-1'],
            managedDirectoryScopes: {},
        });

        await h.service.removeStaleConfigs({
            organizationAndTeamData,
            configFiles: GLOBAL_ONLY, // the directory file is gone
            actor,
        });

        expect(h.directoryDeleteCalls()).toEqual([]);
    });

    it('T2: with no directory baseline at all, nothing is reconciled', async () => {
        const h = await buildHarness({
            repositories: repoWithDirectoryScope(),
            // What 8b5e524ef records: only repositories carrying a
            // `{repo}/kodus-config.yml`, which a directory-only repo lacks.
            managedRepositoryIds: [],
            // ...and no directory-scope baseline either — an organization
            // that has not synced since the fix. Absence still proves nothing.
            managedDirectoryScopes: {},
        });

        await h.service.removeStaleConfigs({
            organizationAndTeamData,
            configFiles: GLOBAL_ONLY, // same deletion as T1
            actor,
        });

        expect(h.directoryDeleteCalls()).toEqual([]);
    });

    /**
     * The fix: ownership is recorded per SCOPE, not only per repository-level
     * `kodus-config.yml`. A repository whose sole centralized file is a
     * directory scope is now in `managedScopeRepositoryIds`, so deleting that
     * file is a removal it can act on — while staying out of
     * `managedRepositoryIds`, so the repository itself is never deselected.
     */
    it('T3: a directory-only repository is recorded in the scope baseline', async () => {
        const h = await buildHarness({
            managedRepositoryIds: [],
            managedDirectoryScopes: {},
        });

        await h.service.removeStaleConfigs({
            organizationAndTeamData,
            configFiles: DIRECTORY_ONLY,
            actor,
        });

        const written = h.savedCentralizedConfig();

        // The scope itself is recorded, by its encoded group folder name...
        expect(written.managedDirectoryScopes).toEqual({ 'repo-1': ['src'] });
        // ...but never as the owner of a repository-level config (test N).
        expect(written.managedRepositoryIds).toEqual([]);
    });

    it('T4: with the scope baseline, a removed directory scope IS cleaned up', async () => {
        const h = await buildHarness({
            repositories: repoWithDirectoryScope(),
            managedRepositoryIds: [],
            // What T3 recorded on the previous sync.
            managedDirectoryScopes: { 'repo-1': ['src'] },
        });

        await h.service.removeStaleConfigs({
            organizationAndTeamData,
            configFiles: GLOBAL_ONLY, // the directory file is gone
            actor,
        });

        expect(h.directoryDeleteCalls()).toEqual(['repo-1:dir-1']);
    });

    it('T5: cleaning the directory scope does not deselect the repository', async () => {
        const h = await buildHarness({
            repositories: repoWithDirectoryScope(),
            managedRepositoryIds: [],
            managedDirectoryScopes: { 'repo-1': ['src'] },
        });

        await h.service.removeStaleConfigs({
            organizationAndTeamData,
            configFiles: GLOBAL_ONLY,
            actor,
        });

        // repo-1 was never the owner of a repository-level config, so the
        // repository scope has nothing to reconcile — only the directory did.
        // This is the #1579 half of the trade: cleaning up must not cascade.
        // Nothing rewrote the repository row at all: no deselection, no
        // `configs: {}`.
        expect(h.reconciledSelection()).toEqual(['<no reconcile call>']);

        // Non-vacuous: the only delete that ran was the directory one (T4).
        expect(h.directoryDeleteCalls()).toEqual(['repo-1:dir-1']);
    });

    /**
     * A repository can lose its `{repo}/kodus-config.yml` and keep a directory
     * scope. It is stale at the repository level but still centrally managed,
     * so the removal side effects (Kody Rules wipe, PR messages) must not run
     * — they are repository-wide and would take the surviving scope's data
     * with them. Locking this because the guard that implements it reads as a
     * stray early-`continue`.
     */
    it('U: a repository that keeps a directory scope survives losing its own file', async () => {
        const h = await buildHarness({
            repositories: repoWithDirectoryScope(),
            managedRepositoryIds: ['repo-1'],
            managedDirectoryScopes: { 'repo-1': ['src'] },
            useRealDeleteUseCase: true,
        });

        await h.service.removeStaleConfigs({
            organizationAndTeamData,
            // `repo-1/kodus-config.yml` is gone; the directory scope remains.
            configFiles: DIRECTORY_ONLY,
            actor,
        });

        expect(h.kodyRulesWipedFor()).toEqual([]);
        expect(h.messagesDeletedFor()).toEqual([]);
        expect(h.directoryDeleteCalls()).toEqual([]);
        // Still selected: it carries centralized configuration.
        expect(h.reconciledSelection()).toContain('repo-1');
    });
});

/**
 * "I deleted the last one" and "I could not read the repository" both arrive
 * as an empty discovery. The #1518 guards resolve that tie by refusing to
 * delete, which makes the last element of every centralized collection
 * undeletable — reproduced against QA on 2026-08-12: removing one of two
 * rules propagated, removing the survivor did not.
 *
 * The tie is breakable. `discoverConfigFiles` and `discoverKodyRulesFiles`
 * read the SAME repository tree, and a configured centralized repository
 * always holds at least the root `kodus-config.yml`. So config files found
 * are proof the read worked, and zero rule files alongside them is a genuine
 * "the user deleted them all".
 */
describe('#1518 guards must not make the last element undeletable', () => {
    const rule = (uuid: string, path?: string) => ({
        uuid,
        title: uuid,
        centralizedConfig: path ? { path } : undefined,
    });

    it('P1: the last centralized rule is removable when the tree read is proven', async () => {
        const h = await buildHarness({
            existingRules: [rule('rule-1', '.kody-rules/review/last.yml')],
        });

        const result = await h.service.removeStaleKodyRules({
            organizationAndTeamData,
            ruleFiles: [], // the user deleted the file
            // ...and the same tree read still returned the root config, so
            // the repository was reachable.
            configFiles: GLOBAL_ONLY,
            actor,
        });

        expect(h.kodyRulesDeleted()).toEqual(['rule-1']);
        expect(result.removedRuleCount).toBe(1);
    });

    it('P2: with nothing found at all, the guard still refuses to wipe', async () => {
        const h = await buildHarness({
            existingRules: [rule('rule-1', '.kody-rules/review/last.yml')],
        });

        const result = await h.service.removeStaleKodyRules({
            organizationAndTeamData,
            ruleFiles: [],
            // No config files either: indistinguishable from a failed read.
            configFiles: [],
            actor,
        });

        expect(h.kodyRulesDeleted()).toEqual([]);
        expect(result.message).toContain('empty-discovery guard');
    });

    it('P3: a rule that was never exported is still never touched', async () => {
        const h = await buildHarness({
            existingRules: [
                rule('manual-1'), // created in the UI, no centralized path
                rule('synced-1', '.kody-rules/review/gone.yml'),
            ],
        });

        await h.service.removeStaleKodyRules({
            organizationAndTeamData,
            ruleFiles: [],
            configFiles: GLOBAL_ONLY,
            actor,
        });

        expect(h.kodyRulesDeleted()).toEqual(['synced-1']);
    });
});

/**
 * `removeStaleCustomMessages` is the third ownership mechanism in this file,
 * and it had none: it read EVERY custom PR message in the organization and
 * deleted any whose scope the current discovery did not mention. That is the
 * #1579 bug verbatim — a repository inheriting the global config looks like a
 * repository the user unconfigured — plus a sharper edge: the desired-key set
 * was built from `meta.directoryPath`, which discovery stopped setting in
 * 7ca98c8d9, so no `DIR:` key was ever produced and every directory-level
 * message was stale on every sync.
 */
describe('#1579 custom PR messages need the same ownership rule', () => {
    const globalMessage = { uuid: 'msg-global', configLevel: ConfigLevel.GLOBAL };

    const repoMessage = (uuid: string, repositoryId: string) => ({
        uuid,
        configLevel: ConfigLevel.REPOSITORY,
        repositoryId,
    });

    const directoryMessage = (uuid: string, directoryId: string) => ({
        uuid,
        configLevel: ConfigLevel.DIRECTORY,
        directoryId,
    });

    it('Q1: a message of a repository the centralized config never owned survives', async () => {
        const h = await buildHarness({
            managedRepositoryIds: ['repo-1'],
            existingMessages: [repoMessage('msg-2', 'repo-2')],
        });

        // repo-2 has no `repo-2/kodus-config.yml` and never had one: it
        // inherits the global config.
        await h.service.removeStaleConfigs({
            organizationAndTeamData,
            configFiles: SPARSE,
            actor,
        });

        expect(h.customMessagesDeleted()).toEqual([]);
    });

    it('Q2: a directory-level message whose scope still exists survives', async () => {
        const h = await buildHarness({
            repositories: repoWithDirectoryScope(),
            managedRepositoryIds: [],
            managedDirectoryScopes: { 'repo-1': ['src'] },
            existingMessages: [directoryMessage('msg-dir', 'dir-1')],
            // Resolution SUCCEEDS here, so the message is spared because its
            // `DIR:` key is genuinely desired — not because the fail-closed
            // branch swallowed an unresolvable scope (that is Q6).
            integrationRepositories: [{ id: 'repo-1', name: 'repo-1' }],
            directoryIdByPath: { src: 'dir-1' },
        });

        // The directory scope is right there in the discovery.
        await h.service.removeStaleConfigs({
            organizationAndTeamData,
            configFiles: DIRECTORY_ONLY,
            actor,
        });

        expect(h.customMessagesDeleted()).toEqual([]);
    });

    it('Q5: a directory message of an unowned repository survives', async () => {
        const h = await buildHarness({
            repositories: {
                configs: { languageResultPrompt: 'en-US' },
                repositories: [
                    {
                        id: 'repo-1',
                        name: 'repo-1',
                        isSelected: true,
                        configs: {},
                        directories: [],
                    },
                    // Never mentioned by the centralized config, and carrying
                    // a directory scope somebody created in the UI.
                    {
                        id: 'repo-2',
                        name: 'repo-2',
                        isSelected: true,
                        configs: {},
                        directories: [
                            {
                                id: 'dir-2',
                                name: 'api',
                                path: 'api',
                                folders: [
                                    { id: 'f-2', name: 'api', path: 'api' },
                                ],
                                configs: {},
                            },
                        ],
                    },
                ],
            } as any,
            managedRepositoryIds: ['repo-1'],
            // repo-2's `api` scope was never owned by the centralized config.
            managedDirectoryScopes: {},
            existingMessages: [directoryMessage('msg-dir-2', 'dir-2')],
            integrationRepositories: [
                { id: 'repo-1', name: 'repo-1' },
                { id: 'repo-2', name: 'repo-2' },
            ],
        });

        await h.service.removeStaleConfigs({
            organizationAndTeamData,
            configFiles: SPARSE, // mentions repo-1 only
            actor,
        });

        // No `DIR:dir-2` key is desired — but repo-2 is not the centralized
        // config's to reconcile, so its directory message is not its to delete.
        expect(h.customMessagesDeleted()).toEqual([]);
    });

    /**
     * `CentralizedConfigSyncUseCase.mergeConfigScopes` folds Kody-rule files
     * into the config scopes, so a repository whose only centralized presence
     * is `{repo}/.kody-rules/review/*.yml` shows up in discovery — while
     * saying nothing whatsoever about that repository's directories.
     *
     * Reconciling directories by repository therefore deleted every scope the
     * user had built in the UI. Tracking ownership per scope is what makes
     * "the config repo does not mention this directory" and "the config repo
     * never owned this directory" different answers.
     */
    it('V: a repository present only via Kody rules keeps its UI directory scopes', async () => {
        const h = await buildHarness({
            repositories: repoWithDirectoryScope(),
            managedRepositoryIds: [],
            // The rules file says nothing about directories, so no previous
            // sync ever recorded owning `src`.
            managedDirectoryScopes: {},
        });

        const result = await h.service.removeStaleConfigs({
            organizationAndTeamData,
            configFiles: [
                { path: 'kodus-config.yml' } as any,
                // What mergeConfigScopes emits for `repo-1/.kody-rules/...`:
                // a repository scope with no directory information at all.
                { repositoryId: 'repo-1' } as any,
            ],
            actor,
        });

        // Asserted explicitly: the sweep swallows its own errors and returns
        // a failure, so "deleted nothing" is only meaningful alongside
        // "ran to completion".
        expect(result.success).toBe(true);
        expect(h.directoryDeleteCalls()).toEqual([]);
    });

    it('W: a UI-created scope inside a managed repository is left alone', async () => {
        const h = await buildHarness({
            repositories: {
                ...repoWithDirectoryScope(),
                repositories: [
                    {
                        ...repoWithDirectoryScope().repositories[0],
                        directories: [
                            {
                                id: 'dir-1',
                                name: 'src',
                                path: 'src',
                                folders: [
                                    { id: 'f-1', name: 'src', path: 'src' },
                                ],
                                configs: {},
                            },
                            // Built in the UI, never exported to the config
                            // repo, so absent from both discovery and baseline.
                            {
                                id: 'dir-2',
                                name: 'api',
                                path: 'api',
                                folders: [
                                    { id: 'f-2', name: 'api', path: 'api' },
                                ],
                                configs: {},
                            },
                        ],
                    },
                ],
            } as any,
            managedRepositoryIds: [],
            managedDirectoryScopes: { 'repo-1': ['src'] },
        });

        await h.service.removeStaleConfigs({
            organizationAndTeamData,
            configFiles: GLOBAL_ONLY, // `src` was deleted from the config repo
            actor,
        });

        // `src` was ours and is gone; `api` never was.
        expect(h.directoryDeleteCalls()).toEqual(['repo-1:dir-1']);
    });

    it('Q7: a UI-created scope keeps its message even inside an owned repository', async () => {
        const h = await buildHarness({
            repositories: {
                configs: { languageResultPrompt: 'en-US' },
                repositories: [
                    {
                        id: 'repo-1',
                        name: 'repo-1',
                        isSelected: true,
                        configs: {},
                        directories: [
                            {
                                id: 'dir-2',
                                name: 'api',
                                path: 'api',
                                folders: [
                                    { id: 'f-2', name: 'api', path: 'api' },
                                ],
                                configs: {},
                            },
                        ],
                    },
                ],
            } as any,
            managedRepositoryIds: [],
            // repo-1 does own a centralized scope — but `src`, not `api`.
            managedDirectoryScopes: { 'repo-1': ['src'] },
            existingMessages: [directoryMessage('msg-api', 'dir-2')],
            integrationRepositories: [{ id: 'repo-1', name: 'repo-1' }],
            directoryIdByPath: { src: 'dir-1' },
        });

        await h.service.removeStaleConfigs({
            organizationAndTeamData,
            configFiles: DIRECTORY_ONLY, // declares `src` only
            actor,
        });

        expect(h.customMessagesDeleted()).toEqual([]);
    });

    it('Q6: an unresolvable directory scope blocks directory deletions', async () => {
        const h = await buildHarness({
            repositories: repoWithDirectoryScope(),
            managedRepositoryIds: [],
            managedDirectoryScopes: { 'repo-1': ['src'] },
            existingMessages: [directoryMessage('msg-dir', 'dir-1')],
            integrationRepositories: [{ id: 'repo-1', name: 'repo-1' }],
            // The path resolves to nothing: the desired `DIR:` set is now
            // incomplete, which must not be read as "the scope is gone".
            directoryIdByPath: {},
        });

        await h.service.removeStaleConfigs({
            organizationAndTeamData,
            configFiles: DIRECTORY_ONLY,
            actor,
        });

        expect(h.customMessagesDeleted()).toEqual([]);
    });

    it('Q3: a genuinely removed repository still loses its message', async () => {
        const h = await buildHarness({
            managedRepositoryIds: ['repo-1', 'repo-2'],
            existingMessages: [repoMessage('msg-2', 'repo-2')],
        });

        // repo-2 WAS owned by a previous sync and its file is gone now.
        await h.service.removeStaleConfigs({
            organizationAndTeamData,
            configFiles: SPARSE,
            actor,
        });

        expect(h.customMessagesDeleted()).toEqual(['msg-2']);
    });

    it('Q4: the global message survives a config repo that never had a global file', async () => {
        const h = await buildHarness({
            managedRepositoryIds: ['repo-1'],
            managedGlobalConfig: false,
            existingMessages: [globalMessage],
        });

        await h.service.removeStaleConfigs({
            organizationAndTeamData,
            configFiles: REPO_ONLY, // no global `kodus-config.yml`
            actor,
        });

        expect(h.customMessagesDeleted()).toEqual([]);
    });
});
