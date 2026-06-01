import { ParametersKey } from '@libs/core/domain/enums';
import { ConfigLevel } from '@libs/core/infrastructure/config/types/general/pullRequestMessages.type';
import { CreateOrUpdatePullRequestMessagesUseCase } from '../create-or-update-pull-request-messages.use-case';
import * as yaml from 'js-yaml';

describe('CreateOrUpdatePullRequestMessagesUseCase', () => {
    const userInfo = {
        uuid: 'user-1',
        email: 'user@test.dev',
        organization: { uuid: 'org-1' },
    };

    const pullRequestMessages = {
        configLevel: ConfigLevel.GLOBAL,
        startReviewMessage: {
            content: 'start message',
            status: 'active',
        },
        endReviewMessage: {
            content: 'end message',
            status: 'active',
        },
        globalSettings: {
            hideComments: false,
            suggestionCopyPrompt: true,
        },
    };

    const buildUseCase = () => {
        const pullRequestMessagesService = {
            findOne: jest.fn().mockResolvedValue(null),
            create: jest.fn().mockResolvedValue(undefined),
            update: jest.fn().mockResolvedValue(undefined),
            deleteByFilter: jest.fn().mockResolvedValue(true),
        };

        const eventEmitter = {
            emit: jest.fn(),
        };

        const contextResolutionService = {
            getDirectoryPathByOrganizationAndRepository: jest
                .fn()
                .mockResolvedValue(''),
            getTeamIdByOrganizationAndRepository: jest
                .fn()
                .mockResolvedValue('team-from-context'),
        };

        const parametersService = {
            findByKey: jest.fn().mockResolvedValue({
                configValue: {
                    configs: {},
                    repositories: [],
                },
            }),
        };

        const authorizationService = {
            ensure: jest.fn(),
        };

        const centralizedConfigPrService = {
            createMutationPullRequestIfEnabled: jest.fn().mockResolvedValue({
                mode: 'centralized-pr',
                prUrl: 'https://example.test/pr/1',
            }),
            buildCentralizedPath: jest
                .fn()
                .mockImplementation(({ repositoryFolder, relativePath }) =>
                    repositoryFolder === 'global'
                        ? relativePath
                        : `${repositoryFolder}/${relativePath}`,
                ),
        };

        const useCase = new CreateOrUpdatePullRequestMessagesUseCase(
            pullRequestMessagesService as any,
            eventEmitter as any,
            contextResolutionService as any,
            parametersService as any,
            authorizationService as any,
            centralizedConfigPrService as any,
        );

        return {
            useCase,
            pullRequestMessagesService,
            contextResolutionService,
            parametersService,
            centralizedConfigPrService,
        };
    };

    it('routes global custom messages to centralized PR when teamId is provided', async () => {
        const {
            useCase,
            pullRequestMessagesService,
            parametersService,
            centralizedConfigPrService,
        } = buildUseCase();

        const result = await useCase.execute(
            userInfo as any,
            {
                configLevel: ConfigLevel.GLOBAL,
                startReviewMessage: {
                    content: 'changed-start-message',
                    status: 'active',
                },
            } as any,
            {
                skipAuthorization: true,
                teamId: 'team-1',
            },
        );

        expect(parametersService.findByKey).toHaveBeenCalledWith(
            ParametersKey.CODE_REVIEW_CONFIG,
            {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
        );
        expect(
            centralizedConfigPrService.createMutationPullRequestIfEnabled,
        ).toHaveBeenCalled();

        const mutationRequest =
            centralizedConfigPrService.createMutationPullRequestIfEnabled.mock
                .calls[0][0];
        const files = mutationRequest.files({ repositoryFolder: 'global' });
        const parsedFile = yaml.load(files[0]?.content) as Record<string, any>;

        expect(parsedFile.customMessages).toEqual(
            expect.objectContaining({
                startReviewMessage: {
                    content: 'changed-start-message',
                    status: 'active',
                },
            }),
        );
        expect(parsedFile.customMessages.endReviewMessage).toBeUndefined();
        expect(parsedFile.customMessages.globalSettings).toBeUndefined();

        expect(pullRequestMessagesService.create).not.toHaveBeenCalled();
        expect(result).toEqual(
            expect.objectContaining({
                mode: 'centralized-pr',
                prUrl: 'https://example.test/pr/1',
            }),
        );
    });

    it('skips centralized PR routing when skipCentralizedPr option is true', async () => {
        const {
            useCase,
            pullRequestMessagesService,
            centralizedConfigPrService,
        } = buildUseCase();

        await useCase.execute(
            userInfo as any,
            { ...pullRequestMessages } as any,
            {
                skipAuthorization: true,
                teamId: 'team-1',
                skipCentralizedPr: true,
            },
        );

        expect(
            centralizedConfigPrService.createMutationPullRequestIfEnabled,
        ).not.toHaveBeenCalled();
        expect(pullRequestMessagesService.create).toHaveBeenCalledWith(
            expect.objectContaining({
                repositoryId: 'global',
            }),
        );
    });
});
