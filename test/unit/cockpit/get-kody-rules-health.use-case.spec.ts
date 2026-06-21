import {
    computeRuleState,
    GetKodyRulesHealthUseCase,
} from '@libs/cockpit/application/use-cases/get-kody-rules-health.use-case';
import { KodyRulesStatus } from '@libs/kodyRules/domain/interfaces/kodyRules.interface';

describe('computeRuleState', () => {
    const usage = (
        triggers: number,
        implemented: number,
        thumbsUp = 0,
        thumbsDown = 0,
    ) => ({
        ruleId: 'r',
        triggers,
        implemented,
        rate: triggers === 0 ? 0 : Number((implemented / triggers).toFixed(2)),
        thumbsUp,
        thumbsDown,
        lastTriggeredAt: null,
    });

    it('flags zero-trigger (or missing) usage as stale', () => {
        expect(computeRuleState(undefined).state).toBe('stale');
        expect(computeRuleState(usage(0, 0)).state).toBe('stale');
    });

    it('flags tiny samples as low_data', () => {
        expect(computeRuleState(usage(4, 0)).state).toBe('low_data');
    });

    it('flags actively-downvoted rules as noisy — outranking ignored', () => {
        expect(computeRuleState(usage(87, 16, 2, 14)).state).toBe('noisy');
        // high impl rate but heavy downvotes still reads as noisy
        expect(computeRuleState(usage(20, 12, 0, 5)).state).toBe('noisy');
        // thumbsUp >= thumbsDown neutralizes the signal
        expect(computeRuleState(usage(42, 30, 6, 3)).state).toBe('healthy');
    });

    it('flags high-trigger, low-implementation rules as ignored', () => {
        expect(computeRuleState(usage(87, 16)).state).toBe('ignored');
        expect(computeRuleState(usage(10, 2)).state).toBe('ignored');
    });

    it('everything else is healthy', () => {
        expect(computeRuleState(usage(42, 30)).state).toBe('healthy');
        expect(computeRuleState(usage(10, 3)).state).toBe('healthy');
    });
});

describe('GetKodyRulesHealthUseCase', () => {
    const baseQuery = {
        organizationId: 'org-1',
        startDate: '2026-03-01',
        endDate: '2026-06-01',
    };

    const mkUseCase = (
        usageRows: unknown[],
        rulesDoc: unknown,
        repoNames: Map<string, string> = new Map(),
        directories: Array<{
            id: string;
            name?: string;
            folders?: Array<{ path: string }>;
        }> = [],
        configRepos: Array<{
            id: string;
            name?: string;
            full_name?: string;
        }> = [],
    ) => {
        const reviewAnalytics = {
            getKodyRulesUsage: jest.fn().mockResolvedValue(usageRows),
            getRepositoryNames: jest.fn().mockResolvedValue(repoNames),
        };
        const kodyRulesService = {
            findByOrganizationId: jest.fn().mockResolvedValue(rulesDoc),
        };
        const teamService = {
            find: jest.fn().mockResolvedValue([{ uuid: 'team-1' }]),
        };
        const parametersService = {
            findByKey: jest.fn().mockResolvedValue({
                configValue: {
                    repositories: [{ directories }],
                },
            }),
        };
        const integrationConfigService = {
            findIntegrationConfigFormatted: jest
                .fn()
                .mockResolvedValue(configRepos),
        };
        return new GetKodyRulesHealthUseCase(
            reviewAnalytics as never,
            kodyRulesService as never,
            teamService as never,
            parametersService as never,
            integrationConfigService as never,
        );
    };

    it('merges usage with active rules and surfaces stale ones', async () => {
        const useCase = mkUseCase(
            [
                {
                    ruleId: 'rule-1',
                    triggers: 87,
                    implemented: 16,
                    rate: 0.18,
                    thumbsUp: 0,
                    thumbsDown: 0,
                    lastTriggeredAt: '2026-05-22T10:00:00Z',
                },
            ],
            {
                rules: [
                    {
                        uuid: 'rule-1',
                        title: 'Avoid any',
                        severity: 'medium',
                        repositoryId: 'global',
                        status: KodyRulesStatus.ACTIVE,
                    },
                    {
                        uuid: 'rule-2',
                        title: 'Use BEM naming',
                        severity: 'low',
                        repositoryId: 'global',
                        status: KodyRulesStatus.ACTIVE,
                    },
                    {
                        uuid: 'rule-3',
                        title: 'Deleted one',
                        severity: 'low',
                        repositoryId: 'global',
                        status: KodyRulesStatus.DELETED,
                    },
                ],
            },
        );

        const rows = await useCase.execute(baseQuery);

        expect(rows).toHaveLength(2);
        expect(rows[0]).toMatchObject({
            ruleId: 'rule-1',
            title: 'Avoid any',
            triggers: 87,
            rate: 0.18,
            state: 'ignored',
        });
        expect(rows[1]).toMatchObject({
            ruleId: 'rule-2',
            triggers: 0,
            state: 'stale',
        });
    });

    it('drops usage of rules that are no longer active (deleted/inactive)', async () => {
        const useCase = mkUseCase(
            [
                {
                    ruleId: 'ghost',
                    triggers: 94,
                    implemented: 12,
                    rate: 0.13,
                    thumbsUp: 0,
                    thumbsDown: 0,
                    lastTriggeredAt: null,
                },
            ],
            // ghost has warehouse usage but isn't an active rule anymore
            { rules: [] },
        );

        const rows = await useCase.execute(baseQuery);

        expect(rows).toEqual([]);
    });

    it('handles orgs without a kodyRules doc', async () => {
        const useCase = mkUseCase([], null);
        await expect(useCase.execute(baseQuery)).resolves.toEqual([]);
    });

    it('labels scope: global sentinel → null, repo → resolved name, folder → resolved directory name', async () => {
        const useCase = mkUseCase(
            [],
            {
                rules: [
                    {
                        uuid: 'g',
                        title: 'Global rule',
                        repositoryId: 'global',
                        status: KodyRulesStatus.ACTIVE,
                    },
                    {
                        uuid: 'r',
                        title: 'Repo rule',
                        repositoryId: '670345891',
                        // a file glob is NOT folder scope — must read as Repo
                        path: '**/*.ts',
                        status: KodyRulesStatus.ACTIVE,
                    },
                    {
                        uuid: 'f',
                        title: 'Folder rule',
                        repositoryId: '670345891',
                        directoryId: 'dir-1',
                        path: '**/*.ts',
                        status: KodyRulesStatus.ACTIVE,
                    },
                    {
                        uuid: 'm',
                        title: 'Multi-folder rule',
                        repositoryId: '670345891',
                        directoryId: 'dir-2',
                        status: KodyRulesStatus.ACTIVE,
                    },
                ],
            },
            new Map([['670345891', 'kodustech/kodus-ai']]),
            [
                { id: 'dir-1', folders: [{ path: '/apps/api' }] },
                {
                    id: 'dir-2',
                    folders: [{ path: '/apps/api' }, { path: '/apps/web' }],
                },
            ],
        );

        const rows = await useCase.execute(baseQuery);
        const byId = Object.fromEntries(rows.map((r) => [r.ruleId, r]));

        // global sentinel collapses to null → frontend reads it as "Global"
        expect(byId.g).toMatchObject({
            repositoryId: null,
            repositoryName: null,
            directoryId: null,
            directoryFolders: null,
        });
        // repo-scoped: id kept, name resolved; a file glob does NOT make it a folder
        expect(byId.r).toMatchObject({
            repositoryId: '670345891',
            repositoryName: 'kodustech/kodus-ai',
            directoryId: null,
            directoryFolders: null,
        });
        // folder-scoped: directoryId drives scope, folder path resolved from config
        expect(byId.f).toMatchObject({
            repositoryName: 'kodustech/kodus-ai',
            directoryId: 'dir-1',
            directoryFolders: ['/apps/api'],
        });
        // multi-folder directory: all folder paths surfaced for the UI's +N
        expect(byId.m).toMatchObject({
            directoryId: 'dir-2',
            directoryFolders: ['/apps/api', '/apps/web'],
        });
    });

    it('resolves repo name from the integration config when the warehouse has no PRs for it', async () => {
        const useCase = mkUseCase(
            [],
            {
                rules: [
                    {
                        uuid: 'noPr',
                        title: 'Repo rule on a repo with no reviewed PRs',
                        repositoryId: '670345891',
                        status: KodyRulesStatus.ACTIVE,
                    },
                ],
            },
            // warehouse knows nothing about this repo (0 triggers → no row)
            new Map(),
            [],
            // ...but the code-management integration does
            [{ id: '670345891', full_name: 'kodustech/kodus-ai' }],
        );

        const rows = await useCase.execute(baseQuery);

        expect(rows[0]).toMatchObject({
            repositoryId: '670345891',
            repositoryName: 'kodustech/kodus-ai',
        });
    });
});
