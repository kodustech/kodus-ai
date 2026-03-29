import { GetCliRepositorySettingsUseCase } from '../get-cli-repository-settings.use-case';

describe('GetCliRepositorySettingsUseCase', () => {
    it('returns the effective repository settings from the formatted team config', async () => {
        const useCase = new GetCliRepositorySettingsUseCase(
            {
                execute: jest.fn(),
            } as any,
            {
                execute: jest.fn().mockResolvedValue({
                    configValue: {
                        configs: {
                            automatedReviewActive: {
                                value: false,
                                level: 'global',
                                overriddenLevel: 'default',
                            },
                            pullRequestApprovalActive: {
                                value: false,
                                level: 'global',
                                overriddenLevel: 'default',
                            },
                            ignorePaths: {
                                value: ['yarn.lock'],
                                level: 'global',
                                overriddenLevel: 'default',
                            },
                            baseBranches: {
                                value: ['main'],
                                level: 'global',
                                overriddenLevel: 'default',
                            },
                            ignoredTitleKeywords: {
                                value: ['wip*'],
                                level: 'global',
                                overriddenLevel: 'default',
                            },
                            suggestionControl: {
                                severityLevelFilter: {
                                    value: 'low',
                                    level: 'global',
                                    overriddenLevel: 'default',
                                },
                            },
                        },
                        repositories: [
                            {
                                id: 'repo-1',
                                name: 'alpha',
                                isSelected: true,
                                directories: [],
                                configs: {
                                    automatedReviewActive: {
                                        value: true,
                                        level: 'repository',
                                        overriddenLevel: 'global',
                                    },
                                    pullRequestApprovalActive: {
                                        value: false,
                                        level: 'repository',
                                        overriddenLevel: 'global',
                                    },
                                    ignorePaths: {
                                        value: [
                                            'yarn.lock',
                                            'package-lock.json',
                                        ],
                                        level: 'repository',
                                        overriddenLevel: 'global',
                                    },
                                    baseBranches: {
                                        value: ['main', 'release/*'],
                                        level: 'repository',
                                        overriddenLevel: 'global',
                                    },
                                    ignoredTitleKeywords: {
                                        value: ['wip*', 'draft*'],
                                        level: 'repository',
                                        overriddenLevel: 'global',
                                    },
                                    suggestionControl: {
                                        severityLevelFilter: {
                                            value: 'medium',
                                            level: 'repository',
                                            overriddenLevel: 'global',
                                        },
                                    },
                                },
                            },
                        ],
                    },
                }),
            } as any,
        );

        const result = await useCase.execute({
            repositoryId: 'repo-1',
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
        });

        expect(result).toEqual({
            reviewEnabled: true,
            autoApproveEnabled: false,
            requestChangesMinSeverity: 'medium',
            ignoredFilePatterns: ['yarn.lock', 'package-lock.json'],
            baseBranchPatterns: ['main', 'release/*'],
            ignoredTitlePatterns: ['wip*', 'draft*'],
            sources: {
                reviewEnabled: {
                    level: 'repository',
                    overriddenLevel: 'global',
                },
                autoApproveEnabled: {
                    level: 'repository',
                    overriddenLevel: 'global',
                },
                requestChangesMinSeverity: {
                    level: 'repository',
                    overriddenLevel: 'global',
                },
                ignoredFilePatterns: {
                    level: 'repository',
                    overriddenLevel: 'global',
                },
                baseBranchPatterns: {
                    level: 'repository',
                    overriddenLevel: 'global',
                },
                ignoredTitlePatterns: {
                    level: 'repository',
                    overriddenLevel: 'global',
                },
            },
        });
    });
});
