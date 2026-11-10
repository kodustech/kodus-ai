import { UpdateOrCreateCodeReviewParameterUseCase } from '../update-or-create-code-review-parameter-use-case';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { resolveReviewSettings } from '@libs/code-review/domain/approval/migrate-review-settings';
import { getDefaultKodusConfigFile } from '@libs/common/utils/validateCodeReviewConfigFile';

function setup(approvalActive: boolean, provider = PlatformType.GITHUB) {
    const stored = {
        id: 'global',
        name: 'Global',
        isSelected: true,
        configs: {
            pullRequestApprovalActive: approvalActive,
            approvalRiskActive: true,
        },
        repositories: [
            {
                id: 'repo',
                name: 'api',
                isSelected: true,
                configs: {},
                directories: [
                    {
                        id: 'dir',
                        name: 'Source',
                        isSelected: true,
                        folders: [{ id: 'src', name: 'src', path: 'src' }],
                        configs: { approvalAuthors: ['build-bot'] },
                    },
                ],
            },
        ],
    };
    const save = jest.fn().mockResolvedValue(true);
    const authorization = { ensure: jest.fn().mockResolvedValue(undefined) };
    const code = { getTypeIntegration: jest.fn().mockResolvedValue(provider) };
    const useCase = new UpdateOrCreateCodeReviewParameterUseCase(
        {
            findByKey: jest.fn().mockResolvedValue({ configValue: stored }),
        } as any,
        { execute: save } as any,
        {
            findIntegrationConfigFormatted: async () => [
                {
                    id: 'repo',
                    name: 'api',
                    directories: stored.repositories[0].directories,
                },
            ],
        } as any,
        { emit: jest.fn() } as any,
        authorization as any,
        { detectAndSaveReferences: jest.fn() } as any,
        { buildConfigKey: () => 'key' } as any,
        { getCentralizedRepositoryIfEnabled: async () => null } as any,
        { find: async () => [] } as any,
        { getBYOKConfig: jest.fn(), getSubscriptionStatus: jest.fn() } as any,
        { execute: jest.fn() } as any,
        {
            validateOrganizationLicense: async () => ({
                valid: true,
                subscriptionStatus: 'active',
                planType: 'teams_byok',
            }),
        } as any,
        { codeReviewSettingsUpdated: jest.fn() } as any,
        code as any,
    );
    const run = (configValue: object, scope: object = {}) =>
        useCase.execute({
            ...scope,
            organizationAndTeamData: { organizationId: 'org', teamId: 'team' },
            configValue,
            actor: { source: 'web', userId: 'user' },
            requestUser: { uuid: 'user' },
        } as any);
    return { run, save, stored, authorization, code };
}

it.each([true, false])(
    'keeps the engine state independent when changing legacy approval from %p',
    async (active) => {
        const { run, save } = setup(active);
        await run({ pullRequestApprovalActive: !active });
        const config = save.mock.calls[0][1].configs;
        expect(config.pullRequestApprovalActive ?? false).toBe(!active);
        expect(config.riskAssessmentActive).toBe(active);
    },
);

it('does not write inherited policy arrays into untouched directory scopes on another settings save', async () => {
    const { run, save } = setup(true);
    await run({ runOnDraft: false });
    const dir = save.mock.calls[0][1].repositories[0].directories[0];
    expect(dir.configs).toEqual({ approvalAuthors: ['build-bot'] });
    expect(dir.configs).not.toHaveProperty('approvalPolicies');
});

it.each([
    {},
    { repositoryId: 'repo' },
    { repositoryId: 'repo', directoryId: 'dir' },
])(
    'keeps explicit legacy resets after save, resolve and an unrelated save at %j',
    async (scope) => {
        const { run, save, stored } = setup(true);
        (stored.configs as any).approvalRiskInstructions =
            'Check account isolation.';
        stored.repositories[0].directories[0].configs = {} as any;
        save.mockImplementation(async (_org, value) => {
            Object.assign(stored, structuredClone(value));
            return true;
        });
        const read = () =>
            resolveReviewSettings(
                getDefaultKodusConfigFile(),
                stored.configs,
                ...('repositoryId' in scope
                    ? [stored.repositories[0].configs]
                    : []),
                ...('directoryId' in scope
                    ? [stored.repositories[0].directories[0].configs]
                    : []),
            );
        await run(
            {
                approvalPolicies: [],
                riskAssessmentActive: false,
                riskCriteria: [],
            },
            scope,
        );
        expect(read()).toMatchObject({
            approvalPolicies: [],
            riskAssessmentActive: false,
            riskCriteria: [],
        });
        await run(
            {
                runOnDraft: false,
                riskAssessmentActive: undefined,
                approvalPolicies: undefined,
                riskCriteria: undefined,
            },
            scope,
        );
        expect(read()).toMatchObject({
            approvalPolicies: [],
            riskAssessmentActive: false,
            riskCriteria: [],
        });
    },
);

it('refuses a parent policy change that would leave legacy child restrictions ambiguous', async () => {
    const { run, save } = setup(true);
    await expect(
        run({
            approvalPolicies: [{ id: 'docs', name: 'Docs', enabled: false }],
        }),
    ).rejects.toThrow('Legacy approval filters cannot scope named policies');
    expect(save).not.toHaveBeenCalled();
});

it.each([
    { repositoryId: 'repo' },
    { repositoryId: 'repo', directoryId: 'dir' },
])(
    'restores inheritance without pinning false or empty review settings at %j',
    async (scope) => {
        const { run, save, stored } = setup(true);
        Object.assign(stored.configs, {
            riskAssessmentActive: false,
            riskCriteria: [],
            approvalPolicies: [],
        });
        stored.repositories[0].directories[0].configs = {} as any;
        const own = {
            riskAssessmentActive: true,
            approvalRiskActive: true,
            riskCriteria: [
                {
                    id: 'old',
                    name: 'Old',
                    enabled: true,
                    instructions: 'Old risk.',
                },
            ],
            approvalRiskInstructions: 'Old risk.',
            approvalPolicies: [{ id: 'old', name: 'Old', enabled: true }],
            approvalAuthors: ['old-bot'],
        };
        if ('directoryId' in scope)
            stored.repositories[0].directories[0].configs = own as any;
        else stored.repositories[0].configs = own;
        save.mockImplementation(async (_org, value) => {
            Object.assign(stored, structuredClone(value));
            return true;
        });
        const target = () =>
            'directoryId' in scope
                ? stored.repositories[0].directories[0].configs
                : stored.repositories[0].configs;
        await run(
            {
                riskAssessmentActive: false,
                riskCriteria: [],
                approvalPolicies: [],
            },
            {
                ...scope,
                inheritFields: [
                    'riskAssessmentActive',
                    'riskCriteria',
                    'approvalPolicies',
                ],
            },
        );
        for (const key of [...Object.keys(own)])
            expect(target()).not.toHaveProperty(key);
        await run({ runOnDraft: false }, scope);
        const parent = {
            riskAssessmentActive: true,
            riskCriteria: [
                {
                    id: 'new',
                    name: 'New',
                    enabled: true,
                    instructions: 'New risk.',
                },
            ],
            approvalPolicies: [{ id: 'new', name: 'New', enabled: true }],
        };
        await run(parent);
        const resolved = resolveReviewSettings(
            getDefaultKodusConfigFile(),
            stored.configs,
            stored.repositories[0].configs,
            ...('directoryId' in scope
                ? [stored.repositories[0].directories[0].configs]
                : []),
        );
        expect(resolved).toMatchObject(parent);
    },
);

it('clears the old model-name alias when the canonical scope override is cleared', async () => {
    const { run, save, stored } = setup(true);
    (stored.repositories[0].configs as any).byokModel = 'old-scope-model';
    await run({ byokModelId: '' }, { repositoryId: 'repo' });
    expect(save.mock.calls[0][1].repositories[0].configs).not.toHaveProperty(
        'byokModel',
    );
    expect(save.mock.calls[0][1].repositories[0].configs).not.toHaveProperty(
        'byokModelId',
    );
});

it.each([PlatformType.BITBUCKET, PlatformType.FORGEJO])(
    'rejects unsupported team selectors at the authorized save entry point: %s',
    async (provider) => {
        const { run, save, authorization, code } = setup(true, provider);
        await expect(
            run({
                approvalPolicies: [
                    {
                        id: 'team',
                        name: 'Team',
                        enabled: false,
                        authorTeams: ['backend'],
                    },
                ],
            }),
        ).rejects.toThrow('team conditions are unavailable');
        expect(authorization.ensure).toHaveBeenCalled();
        expect(code.getTypeIntegration).toHaveBeenCalled();
        expect(save).not.toHaveBeenCalled();
    },
);
