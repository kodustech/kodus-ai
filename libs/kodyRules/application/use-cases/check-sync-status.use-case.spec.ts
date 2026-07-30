import { KodyRulesOrigin } from '@libs/kodyRules/domain/interfaces/kodyRules.interface';

import { CheckSyncStatusUseCase } from './check-sync-status.use-case';

function build(opts: { repoConfig?: unknown; rules?: unknown[] }) {
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

    return {
        useCase: new CheckSyncStatusUseCase(
            {} as any,
            {} as any,
            parametersService,
            findRules,
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
                ideRulesSyncEnabled: true,
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
                ideRulesSyncEnabled: true,
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
                ideRulesSyncEnabled: true,
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
});
