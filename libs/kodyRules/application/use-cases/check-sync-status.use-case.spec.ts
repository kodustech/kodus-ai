import { KodyRulesOrigin } from '@libs/kodyRules/domain/interfaces/kodyRules.interface';
import { ONBOARDING_IMPORT_REMOVED_REASON } from '@libs/core/infrastructure/database/mongo/kody-rules/freeze-agent-file-rules';

import { CheckSyncStatusUseCase } from './check-sync-status.use-case';

function build(opts: {
    repoConfig?: unknown;
    rules?: unknown[];
    orgRules?: unknown[] | Error;
}) {
    const parametersService = {
        findByKey: jest.fn().mockResolvedValue({
            configValue: {
                repositories: opts.repoConfig ? [opts.repoConfig] : [],
            },
        }),
    } as any;
    const findRules = {
        execute: jest.fn().mockResolvedValue(opts.rules ?? []),
    } as any;
    const request = {
        user: { organization: { uuid: 'org-1' } },
    } as any;
    const kodyRulesService = {
        findByOrganizationId:
            opts.orgRules instanceof Error
                ? jest.fn().mockRejectedValue(opts.orgRules)
                : jest
                      .fn()
                      .mockResolvedValue({ rules: opts.orgRules ?? [] }),
    } as any;

    return {
        useCase: new CheckSyncStatusUseCase(
            {} as any,
            {} as any,
            parametersService,
            findRules,
            kodyRulesService,
            request,
        ),
        findRules,
    };
}

const repo = (configs: Record<string, unknown>) => ({
    id: 'repo-1',
    configs,
});

describe('CheckSyncStatusUseCase — kodyRulesGeneratorEnabledFirstTime', () => {
    it('is true when the repo has no past-review rules yet, regardless of the toggle', async () => {
        const { useCase } = build({
            repoConfig: repo({
                repoInstructionsEnabled: true,
                kodyRulesGeneratorEnabled: true,
            }),
            rules: [],
        });

        const res = await useCase.execute('team-1', 'repo-1');

        expect(res.kodyRulesGeneratorEnabledFirstTime).toBe(true);
    });

    it('is false once the repo already has past-review rules', async () => {
        const { useCase } = build({
            repoConfig: repo({
                repoInstructionsEnabled: true,
                kodyRulesGeneratorEnabled: false,
            }),
            rules: [{ rules: [{ origin: KodyRulesOrigin.PAST_REVIEWS }] }],
        });

        const res = await useCase.execute('team-1', 'repo-1');

        expect(res.kodyRulesGeneratorEnabledFirstTime).toBe(false);
    });

    it('stays true when the only existing rules are non-past-review (e.g. IDE files)', async () => {
        const { useCase } = build({
            repoConfig: repo({
                repoInstructionsEnabled: true,
                kodyRulesGeneratorEnabled: false,
            }),
            rules: [{ rules: [{ origin: KodyRulesOrigin.REPO_FILE_SYNC }] }],
        });

        const res = await useCase.execute('team-1', 'repo-1');

        expect(res.kodyRulesGeneratorEnabledFirstTime).toBe(true);
    });

    it('defaults to first-time true when the repo is not present in the config', async () => {
        const { useCase, findRules } = build({
            repoConfig: undefined,
            rules: [],
        });

        const res = await useCase.execute('team-1', 'repo-1');

        expect(res.kodyRulesGeneratorEnabledFirstTime).toBe(true);
        expect(findRules.execute).not.toHaveBeenCalled();
    });

    it('no longer reports a first-time flag for coding-agent files, which import nothing', async () => {
        const { useCase } = build({
            repoConfig: repo({ repoInstructionsEnabled: false }),
            rules: [],
        });

        const res = await useCase.execute('team-1', 'repo-1');

        expect(res).not.toHaveProperty('ideRulesSyncEnabledFirstTime');
    });
});

describe('CheckSyncStatusUseCase — removedOnboardingImports', () => {
    const removed = (over: Record<string, unknown> = {}) => ({
        status: 'deleted',
        reason: ONBOARDING_IMPORT_REMOVED_REASON,
        ...over,
    });

    it('counts the onboarding imports the migration removed, for any scope', async () => {
        const { useCase } = build({
            orgRules: [
                removed(),
                removed(),
                removed({ status: 'active' }),
                { status: 'deleted', reason: 'user deleted it' },
                { status: 'active' },
            ],
        });

        const res = await useCase.execute('team-1', 'global');

        expect(res.removedOnboardingImports).toBe(2);
    });

    it('is 0 when the rules cannot be read', async () => {
        const { useCase } = build({ orgRules: new Error('mongo down') });

        const res = await useCase.execute('team-1', 'repo-1');

        expect(res.removedOnboardingImports).toBe(0);
    });
});
