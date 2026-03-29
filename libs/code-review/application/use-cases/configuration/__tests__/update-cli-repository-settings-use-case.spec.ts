import { UpdateCliRepositorySettingsUseCase } from '../update-cli-repository-settings.use-case';

describe('UpdateCliRepositorySettingsUseCase', () => {
    it('preserves medium severity when mapping CLI settings into the web payload', async () => {
        const updateOrCreateCodeReviewParameterUseCase = {
            execute: jest.fn().mockResolvedValue(true),
        };

        const useCase = new UpdateCliRepositorySettingsUseCase(
            {
                findByKey: jest.fn().mockResolvedValue({
                    configValue: {
                        repositories: [
                            {
                                id: 'repo-1',
                                name: 'alpha',
                                configs: {
                                    suggestionControl: {
                                        groupingMode: 'full',
                                    },
                                },
                            },
                        ],
                    },
                }),
            } as any,
            updateOrCreateCodeReviewParameterUseCase as any,
        );

        const result = await useCase.execute({
            repositoryId: 'repo-1',
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
            settings: {
                reviewEnabled: false,
                autoApproveEnabled: true,
                requestChangesMinSeverity: 'medium',
                ignoredFilePatterns: ['dist/**'],
                baseBranchPatterns: ['main'],
                ignoredTitlePatterns: ['draft*'],
            },
        });

        expect(
            updateOrCreateCodeReviewParameterUseCase.execute,
        ).toHaveBeenCalledWith({
            actor: {
                source: 'cli',
            },
            configValue: {
                automatedReviewActive: false,
                pullRequestApprovalActive: true,
                ignorePaths: ['dist/**'],
                baseBranches: ['main'],
                ignoredTitleKeywords: ['draft*'],
                suggestionControl: {
                    groupingMode: 'full',
                    severityLevelFilter: 'medium',
                },
            },
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
            repositoryId: 'repo-1',
            skipAuthorization: true,
        });
        expect(result.requestChangesMinSeverity).toBe('medium');
    });
});
