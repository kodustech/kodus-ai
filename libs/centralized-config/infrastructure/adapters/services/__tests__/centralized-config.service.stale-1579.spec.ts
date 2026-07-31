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
};

/**
 * @param managedRepositoryIds what a previous sync recorded as managed;
 *        `undefined` means "never recorded" (the safe/unknown case).
 * @param useRealDeleteUseCase wire the real use case so its side effects
 *        (Kody Rules, PR messages, integration configs) are observable.
 */
async function buildHarness(opts: {
    managedRepositoryIds?: string[];
    useRealDeleteUseCase?: boolean;
}): Promise<Harness> {
    const codeReviewConfig = { configValue: threeSelectedRepos() };

    const centralizedConfigValue: any = {
        enabled: true,
        repository: { id: 'config-repo', name: 'config-repo' },
    };
    if (opts.managedRepositoryIds !== undefined) {
        centralizedConfigValue.managedRepositoryIds = opts.managedRepositoryIds;
    }

    const parametersService = {
        findByKey: jest.fn().mockImplementation((key: string) => {
            if (key === ParametersKey.CODE_REVIEW_CONFIG) {
                return Promise.resolve(codeReviewConfig);
            }
            if (key === ParametersKey.CENTRALIZED_CONFIG) {
                return Promise.resolve({ configValue: centralizedConfigValue });
            }
            return Promise.resolve({ configValue: {} });
        }),
        findOne: jest.fn(),
    };

    const integrationConfigService = {
        findIntegrationConfigFormatted: jest.fn().mockResolvedValue([]),
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
        findByOrganizationId: jest.fn(),
        updateRulesStatusByFilter: jest.fn(),
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
                useValue: {
                    find: jest.fn().mockResolvedValue([]),
                    findOne: jest.fn(),
                    delete: jest.fn(),
                },
            },
            {
                provide: CODE_BASE_CONFIG_SERVICE_TOKEN,
                useValue: { getKodusConfigFile: jest.fn() },
            },
            {
                provide: CreateOrUpdateKodyRulesUseCase,
                useValue: { execute: jest.fn() },
            },
            {
                provide: DeleteRuleInOrganizationByIdKodyRulesUseCase,
                useValue: { execute: jest.fn() },
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
});
