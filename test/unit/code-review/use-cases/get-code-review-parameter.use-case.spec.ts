import { Test, TestingModule } from '@nestjs/testing';
import { GetCodeReviewParameterUseCase } from '@libs/code-review/application/use-cases/configuration/get-code-review-parameter.use-case';
import { PARAMETERS_SERVICE_TOKEN } from '@libs/organization/domain/parameters/contracts/parameters.service.contract';
import { CODE_BASE_CONFIG_SERVICE_TOKEN } from '@libs/code-review/domain/contracts/CodeBaseConfigService.contract';
import { AuthorizationService } from '@libs/identity/infrastructure/adapters/services/permissions/authorization.service';
import { PROMPT_EXTERNAL_REFERENCE_MANAGER_SERVICE_TOKEN } from '@libs/ai-engine/domain/prompt/contracts/promptExternalReferenceManager.contract';

describe('GetCodeReviewParameterUseCase', () => {
    let useCase: GetCodeReviewParameterUseCase;
    let mockParametersService: any;
    let mockCodeBaseConfigService: any;
    let mockAuthorizationService: any;
    let mockPromptReferenceManager: any;

    beforeEach(async () => {
        mockParametersService = {
            findByKey: jest.fn(),
        };

        mockCodeBaseConfigService = {
            getKodusConfigFile: jest.fn(),
        };

        mockAuthorizationService = {
            check: jest.fn().mockResolvedValue(true),
        };

        mockPromptReferenceManager = {
            buildConfigKey: jest.fn().mockReturnValue('config-key'),
            getReference: jest.fn().mockResolvedValue(null),
            getMultipleReferences: jest.fn().mockResolvedValue(new Map()),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                GetCodeReviewParameterUseCase,
                {
                    provide: PARAMETERS_SERVICE_TOKEN,
                    useValue: mockParametersService,
                },
                {
                    provide: CODE_BASE_CONFIG_SERVICE_TOKEN,
                    useValue: mockCodeBaseConfigService,
                },
                {
                    provide: AuthorizationService,
                    useValue: mockAuthorizationService,
                },
                {
                    provide: PROMPT_EXTERNAL_REFERENCE_MANAGER_SERVICE_TOKEN,
                    useValue: mockPromptReferenceManager,
                },
            ],
        }).compile();

        useCase = module.get<GetCodeReviewParameterUseCase>(
            GetCodeReviewParameterUseCase,
        );
    });

    it('should keep repository and skip only failing directory', async () => {
        mockParametersService.findByKey.mockResolvedValue({
            toObject: () => ({
                createdAt: new Date('2025-09-10T00:00:00.000Z'),
                configValue: {
                    configs: {},
                    repositories: [
                        {
                            id: 'repo-1',
                            name: 'repo-1',
                            configs: {},
                            directories: [
                                {
                                    id: 'dir-broken',
                                    path: 'broken/path',
                                    configs: {},
                                },
                                {
                                    id: 'dir-ok',
                                    path: 'ok/path',
                                    configs: {},
                                },
                            ],
                        },
                    ],
                },
            }),
        });

        mockCodeBaseConfigService.getKodusConfigFile.mockImplementation(
            async ({ directoryPath }: { directoryPath?: string }) => {
                if (directoryPath === 'broken/path') {
                    throw new Error('directory config failed');
                }
                return {};
            },
        );

        const result = await useCase.execute(
            { organization: { uuid: 'org-1' } } as any,
            'team-1',
        );

        expect(result.configValue.repositories).toHaveLength(1);
        expect(result.configValue.repositories[0].id).toBe('repo-1');
        expect(result.configValue.repositories[0].directories).toHaveLength(1);
        expect(result.configValue.repositories[0].directories[0].id).toBe(
            'dir-ok',
        );
    });
});
