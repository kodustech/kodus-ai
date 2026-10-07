import { IDE_RULES_SYNC_DISABLED_EVENT } from '@libs/kodyRules/domain/events/ide-rules-sync.events';

import { UpdateOrCreateCodeReviewParameterUseCase } from '../update-or-create-code-review-parameter-use-case';

const ORG = { organizationId: 'org-1', teamId: 'team-1' };

type RepoSeed = {
    id: string;
    configs?: Record<string, unknown>;
    directories?: Array<{ id: string; configs?: Record<string, unknown> }>;
};

function build(globalConfigs: Record<string, unknown>, repos: RepoSeed[]) {
    const configValue = {
        id: 'global',
        name: 'Global',
        isSelected: true,
        configs: globalConfigs,
        repositories: repos.map((repo) => ({
            id: repo.id,
            name: repo.id,
            isSelected: true,
            configs: repo.configs ?? {},
            directories: (repo.directories ?? []).map((dir) => ({
                id: dir.id,
                name: dir.id,
                isSelected: true,
                configs: dir.configs ?? {},
                folders: [{ id: `${dir.id}-f`, name: dir.id, path: dir.id }],
            })),
        })),
    };

    const eventEmitter = { emit: jest.fn() };
    const generateInitialKodyRulesUseCase = {
        execute: jest.fn().mockResolvedValue(undefined),
    };

    const useCase = new UpdateOrCreateCodeReviewParameterUseCase(
        { findByKey: jest.fn().mockResolvedValue({ configValue }) } as any,
        { execute: jest.fn().mockResolvedValue(true) } as any,
        {
            findIntegrationConfigFormatted: jest.fn().mockResolvedValue(
                repos.map((repo) => ({
                    id: repo.id,
                    name: repo.id,
                    directories: [],
                })),
            ),
        } as any,
        eventEmitter as any,
        { ensure: jest.fn() } as any,
        { detectAndSaveReferences: jest.fn() } as any,
        { buildConfigKey: jest.fn().mockReturnValue('config-key') } as any,
        {
            getCentralizedRepositoryIfEnabled: jest
                .fn()
                .mockResolvedValue(null),
            getScopedKodusConfigFileContent: jest.fn().mockResolvedValue(null),
            createMutationPullRequestIfEnabled: jest
                .fn()
                .mockResolvedValue({ mode: 'direct' }),
        } as any,
        { find: jest.fn().mockResolvedValue([]) } as any,
        { getBYOKConfig: jest.fn(), getSubscriptionStatus: jest.fn() } as any,
        generateInitialKodyRulesUseCase as any,
        {
            validateOrganizationLicense: jest.fn().mockResolvedValue({
                valid: true,
                subscriptionStatus: 'active',
                planType: 'teams_byok',
            }),
        } as any,
        { codeReviewSettingsUpdated: jest.fn() } as any,
    );

    const save = (
        configValueToSave: Record<string, unknown>,
        scope: { repositoryId?: string; directoryId?: string } = {},
    ) =>
        useCase.execute({
            configValue: configValueToSave,
            organizationAndTeamData: { ...ORG },
            skipAuthorization: true,
            ...scope,
        } as any);

    const disabledEvents = () =>
        eventEmitter.emit.mock.calls
            .filter(([name]) => name === IDE_RULES_SYNC_DISABLED_EVENT)
            .map(([, event]) => event);

    return { save, disabledEvents, generateInitialKodyRulesUseCase };
}

describe('UpdateOrCreateCodeReviewParameterUseCase — Kody Rules learning inheritance', () => {
    describe('IDE rules sync turned off', () => {
        it('on a global save, sends one cleanup for all the repos that flipped, not one per repo', async () => {
            const { save, disabledEvents } = build(
                { ideRulesSyncEnabled: true },
                [
                    { id: 'a' },
                    { id: 'b' },
                    { id: 'own-on', configs: { ideRulesSyncEnabled: true } },
                ],
            );

            await save({
                ideRulesSyncEnabled: false,
                ideSyncDisableAction: 'delete',
            });

            expect(disabledEvents()).toEqual([
                expect.objectContaining({
                    repositoryIds: ['a', 'b'],
                    action: 'delete',
                }),
            ]);
        });

        it('on a global save, fires the cleanup for every repo that inherited "on", with the chosen action', async () => {
            const { save, disabledEvents } = build(
                { ideRulesSyncEnabled: true },
                [
                    { id: 'inherits' },
                    { id: 'own-on', configs: { ideRulesSyncEnabled: true } },
                    { id: 'own-off', configs: { ideRulesSyncEnabled: false } },
                ],
            );

            await save({
                ideRulesSyncEnabled: false,
                ideSyncDisableAction: 'pause',
            });

            expect(disabledEvents()).toEqual([
                expect.objectContaining({
                    repositoryIds: ['inherits'],
                    action: 'pause',
                }),
            ]);
        });

        it('on a repo save, fires the cleanup when the repo inherited "on" from global', async () => {
            const { save, disabledEvents } = build(
                { ideRulesSyncEnabled: true },
                [{ id: 'repo-1' }],
            );

            await save(
                { ideRulesSyncEnabled: false, ideSyncDisableAction: 'delete' },
                { repositoryId: 'repo-1' },
            );

            expect(disabledEvents()).toEqual([
                expect.objectContaining({
                    repositoryIds: ['repo-1'],
                    action: 'delete',
                }),
            ]);
        });

        it('on a repo save, still fires the cleanup for a repo with its own "on"', async () => {
            const { save, disabledEvents } = build({}, [
                { id: 'repo-1', configs: { ideRulesSyncEnabled: true } },
            ]);

            await save(
                { ideRulesSyncEnabled: false },
                { repositoryId: 'repo-1' },
            );

            expect(disabledEvents()).toEqual([
                expect.objectContaining({
                    repositoryIds: ['repo-1'],
                    action: 'keep',
                }),
            ]);
        });

        it('does nothing when the effective value does not change', async () => {
            const { save, disabledEvents } = build({}, [{ id: 'repo-1' }]);

            await save({ ideRulesSyncEnabled: false });
            await save(
                { ideRulesSyncEnabled: false },
                { repositoryId: 'repo-1' },
            );

            expect(disabledEvents()).toEqual([]);
        });

        it('ignores directory-level values', async () => {
            const { save, disabledEvents } = build(
                { ideRulesSyncEnabled: true },
                [{ id: 'repo-1', directories: [{ id: 'dir-1' }] }],
            );

            await save(
                { ideRulesSyncEnabled: false },
                { repositoryId: 'repo-1', directoryId: 'dir-1' },
            );

            expect(disabledEvents()).toEqual([]);
        });
    });

    describe('rule generation turned on', () => {
        it('on a repo save, seeds the repository right away', async () => {
            const { save, generateInitialKodyRulesUseCase } = build(
                { kodyRulesGeneratorEnabled: false },
                [{ id: 'repo-1' }],
            );

            await save(
                { kodyRulesGeneratorEnabled: true },
                { repositoryId: 'repo-1' },
            );

            expect(
                generateInitialKodyRulesUseCase.execute,
            ).toHaveBeenCalledWith({
                organizationAndTeamData: ORG,
                repositoryId: 'repo-1',
            });
        });

        it('on a global save, leaves seeding to the weekly cron', async () => {
            const { save, generateInitialKodyRulesUseCase } = build(
                { kodyRulesGeneratorEnabled: false },
                [{ id: 'repo-1' }, { id: 'repo-2' }],
            );

            await save({ kodyRulesGeneratorEnabled: true });

            expect(
                generateInitialKodyRulesUseCase.execute,
            ).not.toHaveBeenCalled();
        });

        it('does not seed from a directory save', async () => {
            const { save, generateInitialKodyRulesUseCase } = build(
                { kodyRulesGeneratorEnabled: false },
                [{ id: 'repo-1', directories: [{ id: 'dir-1' }] }],
            );

            await save(
                { kodyRulesGeneratorEnabled: true },
                { repositoryId: 'repo-1', directoryId: 'dir-1' },
            );

            expect(
                generateInitialKodyRulesUseCase.execute,
            ).not.toHaveBeenCalled();
        });
    });
});

describe('UpdateOrCreateCodeReviewParameterUseCase — generator seed trigger', () => {
    it('does not seed on a repo save that only touches another setting', async () => {
        const { save, generateInitialKodyRulesUseCase } = build({}, [
            { id: 'repo-1' },
        ]);

        await save({ runOnDraft: true }, { repositoryId: 'repo-1' });

        expect(generateInitialKodyRulesUseCase.execute).not.toHaveBeenCalled();
    });
});

describe('UpdateOrCreateCodeReviewParameterUseCase — first save for a team without a config row', () => {
    const buildWithoutConfig = () => {
        const createOrUpdateParametersUseCase = {
            execute: jest.fn().mockResolvedValue(true),
        };
        const useCase = new UpdateOrCreateCodeReviewParameterUseCase(
            { findByKey: jest.fn().mockResolvedValue(null) } as any,
            createOrUpdateParametersUseCase as any,
            {
                findIntegrationConfigFormatted: jest.fn().mockResolvedValue([]),
            } as any,
            { emit: jest.fn() } as any,
            { ensure: jest.fn() } as any,
            { detectAndSaveReferences: jest.fn() } as any,
            { buildConfigKey: jest.fn().mockReturnValue('config-key') } as any,
            {
                getCentralizedRepositoryIfEnabled: jest
                    .fn()
                    .mockResolvedValue(null),
                getScopedKodusConfigFileContent: jest
                    .fn()
                    .mockResolvedValue(null),
                createMutationPullRequestIfEnabled: jest
                    .fn()
                    .mockResolvedValue({ mode: 'direct' }),
            } as any,
            { find: jest.fn().mockResolvedValue([]) } as any,
            {
                getBYOKConfig: jest.fn(),
                getSubscriptionStatus: jest.fn(),
            } as any,
            { execute: jest.fn().mockResolvedValue(undefined) } as any,
            {
                validateOrganizationLicense: jest.fn().mockResolvedValue({
                    valid: true,
                    subscriptionStatus: 'active',
                    planType: 'teams_byok',
                }),
            } as any,
            { codeReviewSettingsUpdated: jest.fn() } as any,
        );

        const savedGlobalConfigs = () =>
            createOrUpdateParametersUseCase.execute.mock.calls[0][1].configs;

        return { useCase, savedGlobalConfigs };
    };

    const save = (
        useCase: UpdateOrCreateCodeReviewParameterUseCase,
        configValue: object,
    ) =>
        useCase.execute({
            configValue,
            organizationAndTeamData: { ...ORG },
            skipAuthorization: true,
        } as any);

    // Such a team predates the row created at team creation, so it keeps the
    // shipped default instead of the new-team "off".
    it('leaves learning at the default when the save does not set it', async () => {
        const { useCase, savedGlobalConfigs } = buildWithoutConfig();

        await save(useCase, { runOnDraft: false });

        expect(savedGlobalConfigs()).not.toHaveProperty(
            'kodyRulesGeneratorEnabled',
        );
    });

    it('stores "off" when the save turns learning off', async () => {
        const { useCase, savedGlobalConfigs } = buildWithoutConfig();

        await save(useCase, { kodyRulesGeneratorEnabled: false });

        expect(savedGlobalConfigs()).toEqual(
            expect.objectContaining({ kodyRulesGeneratorEnabled: false }),
        );
    });
});
