import { buildPerRepositorySidebarItems } from '../../../apps/web/src/app/(app)/settings/_components/per-repository/sidebar-state';

const buildConfig = () => ({
    repositories: [
        {
            id: 'repo-1',
            name: 'repo-1',
            isSelected: true,
            configs: {
                automatedReviewActive: {
                    value: false,
                    level: 'repository',
                    overriddenValue: true,
                    overriddenLevel: 'global',
                },
            },
            directories: [
                {
                    id: 'dir-1',
                    name: 'src',
                    folders: [{ id: 'f-1', name: 'src', path: '/src' }],
                    configs: {
                        automatedReviewActive: {
                            value: true,
                            level: 'directory',
                            overriddenValue: false,
                            overriddenLevel: 'repository',
                        },
                    },
                },
            ],
        },
        {
            id: 'repo-2',
            name: 'repo-2',
            isSelected: false,
            configs: {},
            directories: [],
        },
        {
            id: 'repo-3',
            name: 'repo-3',
            isSelected: false,
            configs: {},
            directories: [
                {
                    id: 'dir-3',
                    name: 'packages',
                    folders: [{ id: 'f-3', name: 'packages', path: '/packages' }],
                    configs: {},
                },
            ],
        },
    ],
});

describe('buildPerRepositorySidebarItems', () => {
    it('filters hidden repositories and computes repository and directory overrides', () => {
        expect(buildPerRepositorySidebarItems(buildConfig() as any)).toEqual([
            {
                id: 'repo-1',
                name: 'repo-1',
                isSelected: true,
                overrideCount: 1,
                directories: [
                    {
                        id: 'dir-1',
                        name: 'src',
                        path: '/src',
                        overrideCount: 1,
                        configs: expect.objectContaining({
                            automatedReviewActive: {
                                value: true,
                                level: 'directory',
                                overriddenValue: false,
                                overriddenLevel: 'repository',
                            },
                        }),
                    },
                ],
            },
            {
                id: 'repo-3',
                name: 'repo-3',
                isSelected: false,
                overrideCount: 0,
                directories: [
                    {
                        id: 'dir-3',
                        name: 'packages',
                        path: '/packages',
                        overrideCount: 0,
                        configs: {},
                    },
                ],
            },
        ]);
    });
});
