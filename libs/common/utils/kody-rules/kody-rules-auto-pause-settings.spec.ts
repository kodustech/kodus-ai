import { CodeReviewParameter } from '@libs/core/infrastructure/config/types/general/codeReviewConfig.type';

import { createKodyRulesAutoPauseResolver } from './kody-rules-auto-pause-settings';

const buildConfig = (
    globalConfigs: Record<string, unknown>,
    repositories: Array<{
        id: string;
        configs?: Record<string, unknown>;
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
            configs: {},
            ...repo,
            directories: repo.directories?.map((dir) => ({
                name: dir.id,
                isSelected: true,
                folders: [],
                ...dir,
            })),
        })),
    }) as unknown as CodeReviewParameter;

const ON = { kodyRulesAutoPauseEnabled: true };
const OFF = { kodyRulesAutoPauseEnabled: false };

describe('createKodyRulesAutoPauseResolver', () => {
    it('is off by default', () => {
        const resolve = createKodyRulesAutoPauseResolver([
            buildConfig({}, [{ id: 'repo-1' }]),
        ]);

        expect(resolve({ repositoryId: 'global' })).toBe(false);
        expect(resolve({ repositoryId: 'repo-1' })).toBe(false);
    });

    it('a global rule follows the global level', () => {
        const resolve = createKodyRulesAutoPauseResolver([buildConfig(ON)]);

        expect(resolve({ repositoryId: 'global' })).toBe(true);
        expect(resolve({ repositoryId: undefined })).toBe(true);
    });

    it('a repository rule follows its repository, which overrides global', () => {
        const resolve = createKodyRulesAutoPauseResolver([
            buildConfig(ON, [
                { id: 'repo-on' },
                { id: 'repo-off', configs: OFF },
            ]),
        ]);

        expect(resolve({ repositoryId: 'repo-on' })).toBe(true);
        expect(resolve({ repositoryId: 'repo-off' })).toBe(false);
    });

    it('a directory rule follows its directory, which overrides the repository', () => {
        const resolve = createKodyRulesAutoPauseResolver([
            buildConfig(OFF, [
                {
                    id: 'repo-1',
                    configs: ON,
                    directories: [
                        { id: 'dir-off', configs: OFF },
                        { id: 'dir-inherits', configs: {} },
                    ],
                },
                {
                    id: 'repo-2',
                    directories: [{ id: 'dir-on', configs: ON }],
                },
            ]),
        ]);

        expect(
            resolve({ repositoryId: 'repo-1', directoryId: 'dir-off' }),
        ).toBe(false);
        expect(
            resolve({ repositoryId: 'repo-1', directoryId: 'dir-inherits' }),
        ).toBe(true);
        expect(resolve({ repositoryId: 'repo-2', directoryId: 'dir-on' })).toBe(
            true,
        );
    });

    it('a repository rule uses the team that configures the repository', () => {
        const resolve = createKodyRulesAutoPauseResolver([
            buildConfig(OFF, [{ id: 'repo-a' }]),
            buildConfig(ON, [{ id: 'repo-b' }]),
        ]);

        expect(resolve({ repositoryId: 'repo-a' })).toBe(false);
        expect(resolve({ repositoryId: 'repo-b' })).toBe(true);
    });

    it('a global rule, or a repository no team configures, needs every team on', () => {
        const mixed = createKodyRulesAutoPauseResolver([
            buildConfig(ON),
            buildConfig(OFF),
        ]);
        expect(mixed({ repositoryId: 'global' })).toBe(false);
        expect(mixed({ repositoryId: 'unknown-repo' })).toBe(false);

        const allOn = createKodyRulesAutoPauseResolver([
            buildConfig(ON),
            buildConfig(ON),
        ]);
        expect(allOn({ repositoryId: 'global' })).toBe(true);
        expect(allOn({ repositoryId: 'unknown-repo' })).toBe(true);
    });

    it('is off when no team has a code review config', () => {
        const resolve = createKodyRulesAutoPauseResolver([]);

        expect(resolve({ repositoryId: 'global' })).toBe(false);
    });
});
