import * as yaml from 'js-yaml';

import { GenerateKodusConfigFileUseCase } from '../generate-kodus-config-file.use-case';

describe('GenerateKodusConfigFileUseCase', () => {
    const teamId = 'team-1';
    const repositoryId = 'repo-1';
    const directoryId = 'dir-1';

    const makeUseCase = () => {
        const parametersService = {
            findByKey: jest.fn().mockResolvedValue({
                configValue: {
                    configs: {
                        automatedReviewActive: false,
                    },
                    repositories: [
                        {
                            id: repositoryId,
                            configs: {
                                automatedReviewActive: false,
                                enableCommittableSuggestions: false,
                            },
                            directories: [
                                {
                                    id: directoryId,
                                    path: '/src/config',
                                    configs: {
                                        path: '/src/config',
                                        reviewOptions: {
                                            performance: false,
                                            business_logic: false,
                                        },
                                        suggestionControl: {
                                            limitationType: 'file',
                                        },
                                        automatedReviewActive: true,
                                        isRequestChangesActive: false,
                                        enableCommittableSuggestions: true,
                                        crossFileDependenciesAnalysis: true,
                                    },
                                },
                            ],
                        },
                    ],
                },
            }),
        };

        const request = {
            user: {
                uuid: 'user-1',
                organization: {
                    uuid: 'org-1',
                },
            },
        };

        const authorizationService = {
            ensure: jest.fn().mockResolvedValue(undefined),
        };

        const useCase = new GenerateKodusConfigFileUseCase(
            parametersService as any,
            {} as any,
            request as any,
            authorizationService as any,
        );

        return {
            useCase,
            parametersService,
            authorizationService,
        };
    };

    it('returns directory config when repositoryId and directoryId are provided', async () => {
        const { useCase, authorizationService } = makeUseCase();

        const result = await useCase.execute(teamId, repositoryId, directoryId);
        const parsed = yaml.load(result.yamlString || '') as Record<
            string,
            any
        >;

        expect(authorizationService.ensure).toHaveBeenCalledWith(
            expect.objectContaining({
                repoIds: [repositoryId],
            }),
        );

        expect(parsed.path).toBe('/src/config');
        expect(parsed.suggestionControl.limitationType).toBe('file');
        expect(parsed.automatedReviewActive).toBe(true);
        expect(parsed.enableCommittableSuggestions).toBe(true);
        expect(parsed.crossFileDependenciesAnalysis).toBe(true);
    });

    it('returns repository config when only repositoryId is provided', async () => {
        const { useCase } = makeUseCase();

        const result = await useCase.execute(teamId, repositoryId);
        const parsed = yaml.load(result.yamlString || '') as Record<
            string,
            any
        >;

        expect(parsed.automatedReviewActive).toBe(false);
        expect(parsed.enableCommittableSuggestions).toBe(false);
        expect(parsed.path).toBeUndefined();
    });
});
