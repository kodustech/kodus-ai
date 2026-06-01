import {
    BYOKProviderService,
    LLMProviderService,
    PromptRunnerService,
} from '@kodus/kodus-common/llm';
import {
    ISandboxProvider,
    SANDBOX_PROVIDER_TOKEN,
} from '@libs/sandbox/domain/contracts/sandbox.provider';
import {
    DOCUMENTATION_LLM_PLANNER_SERVICE_TOKEN,
    DocumentationLLMPlannerService,
} from '@libs/code-review/infrastructure/adapters/services/documentation-llm-planner.service';
import {
    DOCUMENTATION_PACKAGE_DISCOVERY_SERVICE_TOKEN,
    DocumentationPackageDiscoveryService,
} from '@libs/code-review/infrastructure/adapters/services/documentation-package-discovery.service';
import {
    DOCUMENTATION_SEARCH_EXA_SERVICE_TOKEN,
    DocumentationSearchExaService,
} from '@libs/code-review/infrastructure/adapters/services/documentation-search-exa.service';
import { CodeReviewPipelineContext } from '@libs/code-review/pipeline/context/code-review-pipeline.context';
import { GatherDocumentationContextStage } from '@libs/code-review/pipeline/stages/gather-documentation-context.stage';
import posthog from '@libs/common/utils/posthog';
import { FileChange } from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { CloneParamsResolverService } from '@libs/code-review/pipeline/services/clone-params-resolver.service';

jest.mock('@libs/common/utils/posthog', () => ({
    __esModule: true,
    FEATURE_FLAGS: {
        documentationContext: 'documentation-context',
    },
    default: {
        isFeatureEnabled: jest.fn().mockResolvedValue(true),
    },
}));

describe('GatherDocumentationContextStage', () => {
    let stage: GatherDocumentationContextStage;
    let discoveryService: jest.Mocked<DocumentationPackageDiscoveryService>;
    let plannerService: jest.Mocked<DocumentationLLMPlannerService>;
    let searchService: jest.Mocked<DocumentationSearchExaService>;
    let sandboxProvider: jest.Mocked<ISandboxProvider>;
    let codeManagementService: jest.Mocked<CodeManagementService>;
    let configService: jest.Mocked<ConfigService>;

    const baseContext = {
        pullRequest: { number: 7 },
        repository: { id: 'r1', name: 'repo' },
        organizationAndTeamData: { organizationId: 'o1', teamId: 't1' },
        // `sandboxHandle.remoteCommands` present so the stage proceeds to
        // discoverPackages instead of short-circuiting on the no-sandbox
        // guard added after the 2026-05-13 rate-limit incident. Tests
        // exercising the discovery flow assume a sandbox is available.
        sandboxHandle: {
            remoteCommands: { grep: jest.fn() },
        },
        changedFiles: [
            {
                filename: 'src/a.ts',
                patch: '@@ -1,1 +1,1 @@',
                fileContent: 'import { Controller } from "@nestjs/common";',
            },
        ],
    } as unknown as CodeReviewPipelineContext;

    type FixtureInput = {
        pullRequestNumber?: number;
        repositoryId?: string;
        repositoryName?: string;
        organizationId?: string;
        teamId?: string;
        changedFiles: Array<
            Pick<
                FileChange,
                'filename' | 'patch' | 'patchWithLinesStr' | 'fileContent'
            >
        >;
    };

    const _independentFixture: FixtureInput = {
        pullRequestNumber: 123,
        repositoryId: 'tmp-repo-id',
        repositoryName: 'kodus-ai',
        organizationId: '00000000-0000-0000-0000-000000000000',
        teamId: '00000000-0000-0000-0000-000000000000',
        changedFiles: [
            {
                filename: 'package.json',
                fileContent: JSON.stringify(
                    {
                        dependencies: {
                            '@nestjs/common': '^11.1.14',
                            'typeorm': '^0.3.28',
                        },
                    },
                    null,
                    2,
                ),
                patch: '@@ -1,1 +1,1 @@',
            },
            {
                filename: 'apps/api/src/example.controller.ts',
                fileContent:
                    "import { Controller, Get } from '@nestjs/common';\n\n@Controller('example')\nexport class ExampleController {\n  @Get()\n  findAll() {\n    return [];\n  }\n}\n",
                patch: '@@ -0,0 +1,9 @@',
            },
        ],
    };

    function _buildIndependentContext(
        fixtureInput: FixtureInput,
    ): CodeReviewPipelineContext {
        return {
            pullRequest: {
                number: fixtureInput.pullRequestNumber ?? 123,
            },
            repository: {
                id: fixtureInput.repositoryId ?? 'repo-id',
                name: fixtureInput.repositoryName ?? 'repo-name',
            },
            organizationAndTeamData: {
                organizationId:
                    fixtureInput.organizationId ??
                    '00000000-0000-0000-0000-000000000000',
                teamId:
                    fixtureInput.teamId ??
                    '00000000-0000-0000-0000-000000000000',
            },
            changedFiles: fixtureInput.changedFiles.map((file) => ({
                filename: file.filename,
                patch: file.patch || '',
                patchWithLinesStr: file.patchWithLinesStr || file.patch || '',
                fileContent: file.fileContent || '',
            })),
            codeReviewConfig: {},
        } as unknown as CodeReviewPipelineContext;
    }

    function _buildPromptRunnerServiceMock(): PromptRunnerService {
        const service = {
            builder: jest.fn(() => {
                const state: { payload?: any } = {};

                return {
                    setProviders: jest.fn().mockReturnThis(),
                    setBYOKConfig: jest.fn().mockReturnThis(),
                    setBYOKFallbackConfig: jest.fn().mockReturnThis(),
                    setParser: jest.fn().mockReturnThis(),
                    setLLMJsonMode: jest.fn().mockReturnThis(),
                    setPayload: jest.fn(function (payload: any) {
                        state.payload = payload;
                        return this;
                    }),
                    addPrompt: jest.fn().mockReturnThis(),
                    setTemperature: jest.fn().mockReturnThis(),
                    setRunName: jest.fn().mockReturnThis(),
                    execute: jest.fn(async () => {
                        const filePath = state.payload?.file?.filePath || '';
                        const isNestFile =
                            filePath.endsWith('.ts') ||
                            String(
                                state.payload?.file?.fileContent || '',
                            ).includes('@nestjs/common');

                        return {
                            filePath,
                            queryTasks: isNestFile
                                ? [
                                      {
                                          packageName: '@nestjs/common',
                                          query: 'NestJS official controller and route handler documentation',
                                      },
                                      {
                                          packageName: 'typeorm',
                                          query: 'TypeORM official docs for entity and repository usage with NestJS',
                                      },
                                  ]
                                : [
                                      {
                                          packageName: 'typeorm',
                                          query: 'TypeORM official docs for configuration',
                                      },
                                  ],
                        };
                    }),
                };
            }),
        };

        return service as unknown as PromptRunnerService;
    }

    function _buildRealPromptRunnerService(): PromptRunnerService {
        const logger = new Logger('DocumentationPromptIntegrationTest');
        const byokProviderService = new BYOKProviderService();
        const llmProviderService = new LLMProviderService(
            logger,
            byokProviderService,
        );

        return new PromptRunnerService(logger, llmProviderService);
    }

    beforeEach(async () => {
        (posthog.isFeatureEnabled as jest.Mock).mockResolvedValue(true);

        discoveryService = {
            discoverPackages: jest.fn(),
        } as unknown as jest.Mocked<DocumentationPackageDiscoveryService>;

        plannerService = {
            planDocumentationByFile: jest.fn(),
        } as unknown as jest.Mocked<DocumentationLLMPlannerService>;

        searchService = {
            searchByFilePlan: jest.fn(),
        } as unknown as jest.Mocked<DocumentationSearchExaService>;

        sandboxProvider = {
            isAvailable: jest.fn().mockReturnValue(false),
            createSandboxWithRepo: jest.fn(),
        } as unknown as jest.Mocked<ISandboxProvider>;

        codeManagementService = {
            getCloneParams: jest.fn(),
        } as unknown as jest.Mocked<CodeManagementService>;

        configService = {
            get: jest.fn((key: string) =>
                key === 'API_EXA_KEY' ? 'test-exa-key' : undefined,
            ),
        } as unknown as jest.Mocked<ConfigService>;

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                GatherDocumentationContextStage,
                {
                    provide: DOCUMENTATION_PACKAGE_DISCOVERY_SERVICE_TOKEN,
                    useValue: discoveryService,
                },
                {
                    provide: ConfigService,
                    useValue: configService,
                },
                {
                    provide: DOCUMENTATION_LLM_PLANNER_SERVICE_TOKEN,
                    useValue: plannerService,
                },
                {
                    provide: DOCUMENTATION_SEARCH_EXA_SERVICE_TOKEN,
                    useValue: searchService,
                },
                {
                    provide: SANDBOX_PROVIDER_TOKEN,
                    useValue: sandboxProvider,
                },
                {
                    provide: CloneParamsResolverService,
                    useValue: { resolve: jest.fn() },
                },
                {
                    provide: CodeManagementService,
                    useValue: codeManagementService,
                },
            ],
        }).compile();

        stage = module.get<GatherDocumentationContextStage>(
            GatherDocumentationContextStage,
        );
    });

    it('should skip when there are no changed files', async () => {
        const context = {
            ...baseContext,
            changedFiles: [],
        } as unknown as CodeReviewPipelineContext;

        const result = await stage.execute(context);

        expect(result).toBe(context);
        expect(discoveryService.discoverPackages).not.toHaveBeenCalled();
    });

    it('should skip discovery when sandbox is unavailable (avoids manifest-fan-out fallback)', async () => {
        // Reproduce the 2026-05-13 condition: legacy engine runs without
        // a sandbox handle, so falling into the discovery service would
        // trigger `buildManifestCandidatesForFile` and burn ~100 GitHub
        // requests per PR on manifests that don't exist. The stage must
        // short-circuit to an empty result instead.
        const context = {
            ...baseContext,
            sandboxHandle: undefined,
        } as unknown as CodeReviewPipelineContext;

        const result = await stage.execute(context);

        expect(result.discoveredPackages).toEqual([]);
        expect(result.documentationQueryPlanByFile).toEqual({});
        expect(result.documentationByFile).toEqual({});
        expect(discoveryService.discoverPackages).not.toHaveBeenCalled();
        expect(plannerService.planDocumentationByFile).not.toHaveBeenCalled();
        expect(searchService.searchByFilePlan).not.toHaveBeenCalled();
    });

    it('should skip when API_EXA_KEY is not configured', async () => {
        configService.get.mockImplementationOnce((key: string) =>
            key === 'API_EXA_KEY' ? undefined : undefined,
        );

        const result = await stage.execute(baseContext);

        expect(result.discoveredPackages).toEqual([]);
        expect(result.documentationQueryPlanByFile).toEqual({});
        expect(result.documentationByFile).toEqual({});
        expect(discoveryService.discoverPackages).not.toHaveBeenCalled();
        expect(plannerService.planDocumentationByFile).not.toHaveBeenCalled();
        expect(searchService.searchByFilePlan).not.toHaveBeenCalled();
    });

    it('should skip documentation gathering when there are no supported code files', async () => {
        const context = {
            ...baseContext,
            changedFiles: [
                {
                    filename: 'README.md',
                    patch: '@@ -1,1 +1,1 @@',
                    fileContent: '# docs',
                },
            ],
        } as unknown as CodeReviewPipelineContext;

        const result = await stage.execute(context);

        expect(result.documentationQueryPlanByFile).toEqual({});
        expect(result.documentationByFile).toEqual({});
        expect(discoveryService.discoverPackages).not.toHaveBeenCalled();
        expect(plannerService.planDocumentationByFile).not.toHaveBeenCalled();
        expect(searchService.searchByFilePlan).not.toHaveBeenCalled();
    });

    it('should store empty documentation context when no packages are discovered', async () => {
        discoveryService.discoverPackages.mockResolvedValue({
            packages: [],
            manifestFiles: [],
        });

        const result = await stage.execute(baseContext);

        expect(result.discoveredPackages).toEqual([]);
        expect(result.documentationQueryPlanByFile).toEqual({});
        expect(result.documentationByFile).toEqual({});
        expect(plannerService.planDocumentationByFile).not.toHaveBeenCalled();
    });

    it('should orchestrate package discovery, planning and search', async () => {
        discoveryService.discoverPackages.mockResolvedValue({
            packages: [
                {
                    name: '@nestjs/common',
                    ecosystem: 'npm',
                    sourceFile: 'package.json',
                },
            ],
            manifestFiles: ['package.json'],
        });

        plannerService.planDocumentationByFile.mockResolvedValue({
            'src/a.ts': {
                queryTasks: [
                    {
                        packageName: '@nestjs/common',
                        query: 'find documentation about nestjs controllers',
                    },
                ],
            },
        });

        searchService.searchByFilePlan.mockResolvedValue({
            'src/a.ts': [
                {
                    query: 'find documentation about nestjs controllers',
                    title: 'NestJS docs',
                    url: 'https://docs.nestjs.com/controllers',
                    snippet: 'Controller docs',
                    source: 'exa-search',
                },
            ],
        });

        const result = await stage.execute(baseContext);

        expect(result.discoveredPackages).toHaveLength(1);
        expect(
            result.documentationQueryPlanByFile?.['src/a.ts']?.queryTasks,
        ).toEqual([
            {
                packageName: '@nestjs/common',
                query: 'find documentation about nestjs controllers',
            },
        ]);
        expect(result.documentationByFile?.['src/a.ts']).toHaveLength(1);
    });

    it('should only send code files to the planner', async () => {
        const context = {
            ...baseContext,
            changedFiles: [
                {
                    filename: 'README.md',
                    patch: '@@ -1,1 +1,1 @@',
                    fileContent: '# docs',
                },
                {
                    filename: 'src/a.ts',
                    patch: '@@ -1,1 +1,1 @@',
                    fileContent: 'const a = 1;',
                },
            ],
        } as unknown as CodeReviewPipelineContext;

        discoveryService.discoverPackages.mockResolvedValue({
            packages: [
                {
                    name: '@nestjs/common',
                    ecosystem: 'npm',
                    sourceFile: 'package.json',
                },
            ],
            manifestFiles: ['package.json'],
        });

        plannerService.planDocumentationByFile.mockResolvedValue({
            'src/a.ts': {
                queryTasks: [
                    {
                        packageName: '@nestjs/common',
                        query: 'find docs',
                    },
                ],
            },
        });

        searchService.searchByFilePlan.mockResolvedValue({
            'src/a.ts': [
                {
                    query: 'find docs',
                    title: 'doc',
                    url: 'https://example.com',
                    snippet: 'snippet',
                    source: 'exa-search',
                },
            ],
        });

        await stage.execute(context);

        expect(plannerService.planDocumentationByFile).toHaveBeenCalledTimes(1);
        expect(plannerService.planDocumentationByFile).toHaveBeenCalledWith(
            expect.objectContaining({
                changedFiles: [
                    expect.objectContaining({
                        filename: 'src/a.ts',
                    }),
                ],
            }),
        );
    });

    it('should fail open when an internal service throws', async () => {
        discoveryService.discoverPackages.mockRejectedValue(new Error('boom'));

        const result = await stage.execute(baseContext);

        expect(result).toBe(baseContext);
    });

    it('should skip documentation retrieval when planner returns no queries', async () => {
        discoveryService.discoverPackages.mockResolvedValue({
            packages: [
                {
                    name: '@nestjs/common',
                    ecosystem: 'npm',
                    sourceFile: 'package.json',
                },
            ],
            manifestFiles: ['package.json'],
        });

        plannerService.planDocumentationByFile.mockResolvedValue({
            'src/a.ts': {
                queryTasks: [],
            },
        });

        const result = await stage.execute(baseContext);

        expect(searchService.searchByFilePlan).not.toHaveBeenCalled();
        expect(result.documentationQueryPlanByFile).toEqual({
            'src/a.ts': {
                queryTasks: [],
            },
        });
        expect(result.documentationByFile).toEqual({});
    });
});
