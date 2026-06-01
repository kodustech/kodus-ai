import { Test, TestingModule } from '@nestjs/testing';
import { ModuleRef } from '@nestjs/core';

import { GenerateKodyRulesUseCase } from '@libs/kodyRules/application/use-cases/generate-kody-rules.use-case';
import {
    IIntegrationService,
    INTEGRATION_SERVICE_TOKEN,
} from '@libs/integrations/domain/integrations/contracts/integration.service.contracts';
import {
    IIntegrationConfigService,
    INTEGRATION_CONFIG_SERVICE_TOKEN,
} from '@libs/integrations/domain/integrationConfigs/contracts/integration-config.service.contracts';
import {
    IParametersService,
    PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/parameters/contracts/parameters.service.contract';
import { CreateOrUpdateParametersUseCase } from '@libs/organization/application/use-cases/parameters/create-or-update-use-case';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import { CommentAnalysisService } from '@libs/code-review/infrastructure/adapters/services/commentAnalysis.service';
import { SendRulesNotificationUseCase } from '@libs/kodyRules/application/use-cases/send-rules-notification.use-case';
import { FindRulesInOrganizationByRuleFilterKodyRulesUseCase } from '@libs/kodyRules/application/use-cases/find-rules-in-organization-by-filter.use-case';
import { CreateOrUpdateKodyRulesUseCase } from '@libs/kodyRules/application/use-cases/create-or-update.use-case';
import { ParametersKey } from '@libs/core/domain/enums';
import { KodyRulesStatus } from '@libs/kodyRules/domain/interfaces/kodyRules.interface';

jest.mock('@kodus/flow', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
    }),
}));

describe('GenerateKodyRulesUseCase', () => {
    let useCase: GenerateKodyRulesUseCase;

    const integrationServiceMock = {} as jest.Mocked<IIntegrationService>;
    const integrationConfigServiceMock =
        {} as jest.Mocked<IIntegrationConfigService>;
    const parametersServiceMock = {
        findByKey: jest.fn(),
    } as unknown as jest.Mocked<IParametersService>;
    const createOrUpdateParametersUseCaseMock = {
        execute: jest.fn(),
    };
    const codeManagementServiceMock = {
        getPullRequestsByRepository: jest.fn(),
        getAllCommentsInPullRequest: jest.fn(),
        getPullRequestReviewComment: jest.fn(),
        getFilesByPullRequestId: jest.fn(),
    };
    const commentAnalysisServiceMock = {
        processComments: jest.fn(),
        generateKodyRules: jest.fn(),
    };
    const sendRulesNotificationUseCaseMock = {
        execute: jest.fn(),
    };

    const findRulesUseCaseMock = {
        execute: jest.fn(),
    };

    const createOrUpdateRuleUseCaseMock = {
        execute: jest.fn(),
    };

    const moduleRefMock = {
        resolve: jest.fn(),
    } as unknown as ModuleRef;

    beforeEach(async () => {
        jest.clearAllMocks();

        codeManagementServiceMock.getPullRequestsByRepository.mockResolvedValue(
            [{ pull_number: 10 }],
        );
        codeManagementServiceMock.getAllCommentsInPullRequest.mockResolvedValue(
            [{ id: 'comment-1' }],
        );
        codeManagementServiceMock.getPullRequestReviewComment.mockResolvedValue(
            [{ id: 'review-comment-1' }],
        );
        codeManagementServiceMock.getFilesByPullRequestId.mockResolvedValue([
            { filename: 'src/a.ts' },
        ]);
        commentAnalysisServiceMock.processComments.mockReturnValue([
            { id: 'processed-1' },
        ]);
        commentAnalysisServiceMock.generateKodyRules.mockResolvedValue([
            {
                title: 'Avoid console.log',
                rule: 'Do not use console.log in production code',
                severity: 'medium',
                origin: 'generated',
                examples: [],
            },
        ]);

        sendRulesNotificationUseCaseMock.execute.mockResolvedValue(undefined);
        createOrUpdateParametersUseCaseMock.execute.mockResolvedValue(
            undefined,
        );

        moduleRefMock.resolve = jest.fn((token: any) => {
            if (token === FindRulesInOrganizationByRuleFilterKodyRulesUseCase) {
                return Promise.resolve(findRulesUseCaseMock);
            }

            if (token === CreateOrUpdateKodyRulesUseCase) {
                return Promise.resolve(createOrUpdateRuleUseCaseMock);
            }

            return Promise.resolve(undefined);
        });

        findRulesUseCaseMock.execute.mockResolvedValue([]);

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                GenerateKodyRulesUseCase,
                {
                    provide: INTEGRATION_SERVICE_TOKEN,
                    useValue: integrationServiceMock,
                },
                {
                    provide: INTEGRATION_CONFIG_SERVICE_TOKEN,
                    useValue: integrationConfigServiceMock,
                },
                {
                    provide: PARAMETERS_SERVICE_TOKEN,
                    useValue: parametersServiceMock,
                },
                {
                    provide: CreateOrUpdateParametersUseCase,
                    useValue: createOrUpdateParametersUseCaseMock,
                },
                {
                    provide: CodeManagementService,
                    useValue: codeManagementServiceMock,
                },
                {
                    provide: CommentAnalysisService,
                    useValue: commentAnalysisServiceMock,
                },
                {
                    provide: ModuleRef,
                    useValue: moduleRefMock,
                },
                {
                    provide: SendRulesNotificationUseCase,
                    useValue: sendRulesNotificationUseCaseMock,
                },
            ],
        }).compile();

        useCase = module.get(GenerateKodyRulesUseCase);
    });

    it('persists generated rules through centralized-aware create-or-update flow when centralized config is enabled', async () => {
        parametersServiceMock.findByKey.mockImplementation((key: any) => {
            if (key === ParametersKey.CODE_REVIEW_CONFIG) {
                return Promise.resolve({
                    configValue: {
                        repositories: [
                            {
                                id: 'repo-1',
                                name: 'repo-one',
                                isSelected: true,
                                directories: [],
                            },
                        ],
                    },
                });
            }

            if (key === ParametersKey.PLATFORM_CONFIGS) {
                return Promise.resolve({
                    configValue: {
                        kodyLearningStatus: 'disabled',
                    },
                });
            }

            return Promise.resolve(null);
        });

        createOrUpdateRuleUseCaseMock.execute.mockResolvedValue({
            mode: 'centralized-pr',
            prUrl: 'https://example.com/pr/1',
            message:
                'Centralized config is enabled. Change proposed through pull request instead of direct persistence.',
        });

        await useCase.execute(
            {
                teamId: 'team-1',
                days: 7,
            } as any,
            'org-1',
        );

        expect(createOrUpdateRuleUseCaseMock.execute).toHaveBeenCalledTimes(1);
        expect(createOrUpdateRuleUseCaseMock.execute).toHaveBeenCalledWith(
            expect.objectContaining({
                status: KodyRulesStatus.PENDING,
                repositoryId: 'repo-1',
            }),
            'org-1',
            expect.objectContaining({ userId: 'kody-system-rules-generator' }),
        );
    });

    it('works in direct mode when centralized config is disabled', async () => {
        parametersServiceMock.findByKey.mockImplementation((key: any) => {
            if (key === ParametersKey.CODE_REVIEW_CONFIG) {
                return Promise.resolve({
                    configValue: {
                        repositories: [
                            {
                                id: 'repo-1',
                                name: 'repo-one',
                                isSelected: true,
                                directories: [],
                            },
                        ],
                    },
                });
            }

            if (key === ParametersKey.PLATFORM_CONFIGS) {
                return Promise.resolve({
                    configValue: {
                        kodyLearningStatus: 'disabled',
                    },
                });
            }

            return Promise.resolve(null);
        });

        createOrUpdateRuleUseCaseMock.execute.mockResolvedValue({
            uuid: 'rule-uuid-1',
        });

        await useCase.execute(
            {
                teamId: 'team-1',
                days: 7,
            } as any,
            'org-1',
        );

        expect(createOrUpdateRuleUseCaseMock.execute).toHaveBeenCalledTimes(1);
    });
});
