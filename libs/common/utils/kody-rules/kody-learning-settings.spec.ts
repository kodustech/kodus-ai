import { CodeReviewParameter } from '@libs/core/infrastructure/config/types/general/codeReviewConfig.type';

import { getDefaultKodusConfigFile } from '@libs/common/utils/validateCodeReviewConfigFile';

import {
    createKodyLearningSettingsResolver,
    resolveKodyLearningSettings,
} from './kody-learning-settings';

jest.mock('@libs/common/utils/validateCodeReviewConfigFile', () => {
    const actual = jest.requireActual(
        '@libs/common/utils/validateCodeReviewConfigFile',
    );
    return {
        ...actual,
        getDefaultKodusConfigFile: jest.fn(actual.getDefaultKodusConfigFile),
    };
});

const buildConfig = (
    globalConfigs: Record<string, unknown>,
    repositories: Array<{
        id: string;
        configs: Record<string, unknown>;
        directories?: Array<{ id: string; configs: Record<string, unknown> }>;
    }> = [],
): CodeReviewParameter =>
    ({
        id: 'global',
        name: 'Global',
        isSelected: true,
        configs: globalConfigs,
        repositories: repositories.map((repo) => ({
            name: repo.id,
            isSelected: true,
            ...repo,
            directories: repo.directories?.map((dir) => ({
                name: dir.id,
                isSelected: true,
                folders: [],
                ...dir,
            })),
        })),
    }) as unknown as CodeReviewParameter;

describe('resolveKodyLearningSettings', () => {
    it('falls back to the defaults when nothing is configured', () => {
        expect(resolveKodyLearningSettings(undefined, 'repo-1')).toEqual({
            repoInstructionsEnabled: false,
            kodyRulesGeneratorEnabled: true,
            kodyLearningExcludedReviewers: [],
        });
    });

    it('makes a repository without its own value follow the global value', () => {
        const config = buildConfig(
            { repoInstructionsEnabled: true, kodyRulesGeneratorEnabled: false },
            [{ id: 'repo-1', configs: {} }],
        );

        expect(resolveKodyLearningSettings(config, 'repo-1')).toMatchObject({
            repoInstructionsEnabled: true,
            kodyRulesGeneratorEnabled: false,
        });
    });

    it('lets a repository override win over the global value', () => {
        const config = buildConfig(
            { repoInstructionsEnabled: true, kodyRulesGeneratorEnabled: false },
            [
                {
                    id: 'repo-1',
                    configs: {
                        repoInstructionsEnabled: false,
                        kodyRulesGeneratorEnabled: true,
                    },
                },
            ],
        );

        expect(resolveKodyLearningSettings(config, 'repo-1')).toMatchObject({
            repoInstructionsEnabled: false,
            kodyRulesGeneratorEnabled: true,
        });
    });

    it('replaces the excluded reviewers list instead of merging it', () => {
        const config = buildConfig(
            { kodyLearningExcludedReviewers: ['a', 'b'] },
            [
                {
                    id: 'repo-1',
                    configs: { kodyLearningExcludedReviewers: ['c'] },
                },
            ],
        );

        expect(
            resolveKodyLearningSettings(config, 'repo-1')
                .kodyLearningExcludedReviewers,
        ).toEqual(['c']);
    });

    it('ignores directory-level values, since both behaviors are repo-scoped', () => {
        const config = buildConfig({ kodyRulesGeneratorEnabled: true }, [
            {
                id: 'repo-1',
                configs: {},
                directories: [
                    {
                        id: 'dir-1',
                        configs: {
                            repoInstructionsEnabled: true,
                            kodyRulesGeneratorEnabled: false,
                        },
                    },
                ],
            },
        ]);

        expect(resolveKodyLearningSettings(config, 'repo-1')).toMatchObject({
            repoInstructionsEnabled: false,
            kodyRulesGeneratorEnabled: true,
        });
    });

    it('follows the global value for a repository missing from the config', () => {
        const config = buildConfig({ repoInstructionsEnabled: true });

        expect(
            resolveKodyLearningSettings(config, 'unknown').repoInstructionsEnabled,
        ).toBe(true);
    });

    it('matches numeric repository ids stored as numbers', () => {
        const config = buildConfig({}, [
            {
                id: 123 as unknown as string,
                configs: { repoInstructionsEnabled: true },
            },
        ]);

        expect(
            resolveKodyLearningSettings(config, '123').repoInstructionsEnabled,
        ).toBe(true);
    });
});

describe('createKodyLearningSettingsResolver', () => {
    const config = buildConfig(
        { repoInstructionsEnabled: true, kodyLearningExcludedReviewers: ['bot'] },
        [
            { id: 'inherits', configs: {} },
            {
                id: 'own',
                configs: {
                    repoInstructionsEnabled: false,
                    kodyRulesGeneratorEnabled: false,
                },
            },
        ],
    );

    it('resolves every repository the same way as resolveKodyLearningSettings', () => {
        const resolve = createKodyLearningSettingsResolver(config);

        for (const id of ['inherits', 'own', 'unknown']) {
            expect(resolve(id)).toEqual(
                resolveKodyLearningSettings(config, id),
            );
        }
    });

    it('reads the default config once, however many repositories it resolves', () => {
        const getDefaults = jest.mocked(getDefaultKodusConfigFile);
        getDefaults.mockClear();

        const resolve = createKodyLearningSettingsResolver(config);
        ['inherits', 'own', 'unknown', 'inherits'].forEach((id) => resolve(id));

        expect(getDefaults).toHaveBeenCalledTimes(1);
    });
});
