import { AuditLogEvents } from '@libs/ee/codeReviewSettingsLog/events/audit-log.events';
import { UpdateCodeReviewParameterRepositoriesUseCase } from '../update-code-review-parameter-repositories-use-case';

describe('UpdateCodeReviewParameterRepositoriesUseCase', () => {
    it('updates repositories even when request.user is not available', async () => {
        const createOrUpdateParametersUseCase = {
            execute: jest.fn().mockResolvedValue({ ok: true }),
        };

        const useCase = new UpdateCodeReviewParameterRepositoriesUseCase(
            {
                findByKey: jest.fn().mockResolvedValue({
                    configValue: {
                        repositories: [
                            {
                                id: 'repo-1',
                                name: 'alpha',
                                isSelected: true,
                                configs: {},
                                directories: [],
                            },
                        ],
                    },
                }),
            } as any,
            createOrUpdateParametersUseCase as any,
            {
                findIntegrationConfigFormatted: jest.fn().mockResolvedValue([
                    {
                        id: 'repo-1',
                        name: 'alpha',
                    },
                    {
                        id: 'repo-2',
                        name: 'beta',
                    },
                ]),
            } as any,
            {
                registerRepositoriesLog: jest.fn(),
            } as any,
            {} as any,
        );
        const loggerErrorSpy = jest.spyOn(useCase['logger'], 'error');

        const result = await useCase.execute({
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
        });

        expect(createOrUpdateParametersUseCase.execute).toHaveBeenCalledWith(
            'code_review_config',
            {
                repositories: [
                    {
                        id: 'repo-1',
                        name: 'alpha',
                        isSelected: true,
                        configs: {},
                        directories: [],
                    },
                    {
                        id: 'repo-2',
                        name: 'beta',
                        isSelected: true,
                        configs: {},
                        directories: [],
                    },
                ],
            },
            {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
        );
        expect(loggerErrorSpy).not.toHaveBeenCalled();
        expect(result).toEqual({ ok: true });
    });

    it('emits an audit log with a CLI actor when invoked from the CLI flow', async () => {
        const createOrUpdateParametersUseCase = {
            execute: jest.fn().mockResolvedValue({ ok: true }),
        };
        const eventEmitter = {
            emit: jest.fn(),
        };

        const useCase = new UpdateCodeReviewParameterRepositoriesUseCase(
            {
                findByKey: jest.fn().mockResolvedValue({
                    configValue: {
                        repositories: [
                            {
                                id: 'repo-1',
                                name: 'alpha',
                                isSelected: true,
                                configs: {},
                                directories: [],
                            },
                        ],
                    },
                }),
            } as any,
            createOrUpdateParametersUseCase as any,
            {
                findIntegrationConfigFormatted: jest.fn().mockResolvedValue([
                    {
                        id: 'repo-1',
                        name: 'alpha',
                    },
                    {
                        id: 'repo-2',
                        name: 'beta',
                    },
                ]),
            } as any,
            eventEmitter as any,
            undefined as any,
        );

        await expect(
            useCase.execute({
                actor: {
                    source: 'cli',
                    organizationId: 'org-1',
                },
                organizationAndTeamData: {
                    organizationId: 'org-1',
                    teamId: 'team-1',
                },
            }),
        ).resolves.toEqual({ ok: true });

        expect(eventEmitter.emit).toHaveBeenCalledWith(
            AuditLogEvents.REPOSITORIES,
            expect.objectContaining({
                organizationAndTeamData: {
                    organizationId: 'org-1',
                    teamId: 'team-1',
                },
                userInfo: {
                    userId: 'cli-key',
                    userEmail: 'CLI key',
                },
                addedRepositories: [
                    {
                        id: 'repo-2',
                        name: 'beta',
                        isSelected: true,
                        configs: {},
                        directories: [],
                    },
                ],
                removedRepositories: [],
                configLevel: 'global',
            }),
        );
    });
});
