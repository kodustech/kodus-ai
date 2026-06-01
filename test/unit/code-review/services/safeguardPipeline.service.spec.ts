jest.mock('@kodus/flow', () => {
    const mockLogger = {
        log: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    };

    return {
        createLogger: () => mockLogger,
        __mockLogger: mockLogger,
    };
});

import { DocumentationSearchExaService } from '@/code-review/infrastructure/adapters/services/documentation-search-exa.service';
import { SafeguardPipelineService } from '@/code-review/infrastructure/adapters/services/safeguardPipeline.service';
import { ObservabilityService } from '@/core/log/observability.service';
import { PromptRunnerService } from '@kodus/kodus-common/llm';
import { ISandboxProvider } from '@libs/sandbox/domain/contracts/sandbox.provider';
import { __mockLogger as mockLogger } from '@kodus/flow';

describe('SafeguardPipelineService', () => {
    let service: SafeguardPipelineService;

    const mockPromptRunnerService = {} as PromptRunnerService;
    const mockObservabilityService = {
        runLLMInSpan: jest.fn(),
    } as unknown as ObservabilityService;
    const mockSandboxProvider = {
        isAvailable: jest.fn(),
        createSandboxWithRepo: jest.fn(),
    } as unknown as ISandboxProvider;

    const mockDocumentationSearchExaService = {
        searchByFilePlan: jest.fn(),
    } as unknown as DocumentationSearchExaService;

    beforeEach(() => {
        service = new SafeguardPipelineService(
            mockPromptRunnerService,
            mockObservabilityService,
            mockSandboxProvider,
            mockDocumentationSearchExaService,
        );

        jest.clearAllMocks();
    });

    describe('execute', () => {
        it('should log a structured prompt-only safeguard decision when no remote commands are available', async () => {
            jest.spyOn(service as any, 'extractFeatures').mockResolvedValue({
                codeSuggestions: [
                    {
                        id: 'suggestion-1',
                        features: {
                            has_resource_leak: false,
                            has_inconsistent_contract: false,
                            has_wrong_algorithm: false,
                            has_data_exposure: false,
                            has_missing_error_handling: true,
                            has_redundant_work_in_loop: false,
                            has_unsafe_data_flow: false,
                            requires_assumed_input: false,
                            requires_assumed_workload: false,
                            is_quality_opinion: false,
                            is_anti_pattern_only: false,
                            targets_unchanged_code: false,
                            improvedCode_is_correct: true,
                        },
                    },
                ],
            });
            jest.spyOn(
                service as any,
                'verifyWithPromptOnly',
            ).mockResolvedValue({
                keep: false,
                evidence: 'discarded',
            });

            await service.execute({
                organizationAndTeamData: {
                    organizationId: 'org-1',
                    teamId: 'team-1',
                } as any,
                prNumber: 14282,
                file: {
                    filename:
                        'apps/quintoandar_app/lib/app/tenants_app/tenants_app.dart',
                },
                relevantContent: '',
                codeDiff: '@@',
                suggestions: [
                    {
                        id: 'suggestion-1',
                        label: 'bug',
                        severity: 'critical',
                        filePath:
                            'apps/quintoandar_app/lib/app/tenants_app/tenants_app.dart',
                    },
                ],
                languageResultPrompt: 'en-US',
                reviewMode: undefined as any,
                byokConfig: {} as any,
            });

            expect(mockLogger.log).toHaveBeenCalledWith(
                expect.objectContaining({
                    context: SafeguardPipelineService.name,
                    metadata: expect.objectContaining({
                        safeguardMode: 'prompt_only',
                        sandboxAvailable: false,
                        safeguardReason: 'no_remote_commands',
                        prNumber: 14282,
                        hasFreshCloneParams: false,
                        toVerifyCount: 1,
                    }),
                }),
            );
        });
    });

    describe('getDocumentationToolResult', () => {
        it('should return preloaded documentation context when available', async () => {
            const result = await (service as any).getDocumentationToolResult(
                'nestjs',
                'dependency injection tokens',
                [
                    {
                        title: 'NestJS Providers',
                        url: 'https://docs.nestjs.com/providers',
                        query: 'dependency injection tokens',
                        snippet: 'Use custom providers and tokens for DI.',
                        source: 'exa-search',
                    },
                ],
            );

            expect(result).toContain('Documentation (preloaded)');
            expect(result).toContain('NestJS Providers');
            expect(
                mockDocumentationSearchExaService.searchByFilePlan,
            ).not.toHaveBeenCalled();
        });

        it('should fallback to exa search when preloaded context is missing', async () => {
            mockDocumentationSearchExaService.searchByFilePlan = jest
                .fn()
                .mockResolvedValue({
                    safeguard: [
                        {
                            title: 'Mongoose Indexes',
                            url: 'https://mongoosejs.com/docs/guide.html#indexes',
                            query: 'ttl index expiresAt',
                            snippet:
                                'Define TTL indexes with expireAfterSeconds.',
                            source: 'exa-search',
                        },
                    ],
                });

            const result = await (service as any).getDocumentationToolResult(
                'mongoose',
                'ttl index expiresAt',
                [],
            );

            expect(result).toContain('Documentation:');
            expect(result).toContain('Mongoose Indexes');
            expect(
                mockDocumentationSearchExaService.searchByFilePlan,
            ).toHaveBeenCalledTimes(1);
        });

        it('should return validation message when query is empty', async () => {
            const result = await (service as any).getDocumentationToolResult(
                'nestjs',
                '   ',
                [],
            );

            expect(result).toContain('query is required');
            expect(
                mockDocumentationSearchExaService.searchByFilePlan,
            ).not.toHaveBeenCalled();
        });
    });

    describe('verifyWithPromptOnly', () => {
        it('should attach sandbox fallback attrs to the prompt-only verification span', async () => {
            (
                mockObservabilityService.runLLMInSpan as jest.Mock
            ).mockResolvedValue({
                result: {
                    verdict: false,
                    evidence: 'not enough evidence',
                },
            });

            const result = await (service as any).verifyWithPromptOnly(
                {
                    id: 'suggestion-1',
                    filePath:
                        'packages/favorites/lib/src/features/favorite_button/favorite_button_build.dart',
                    suggestionContent: 'example',
                    existingCode: 'const x = 1;',
                },
                {
                    has_resource_leak: false,
                    has_inconsistent_contract: false,
                    has_wrong_algorithm: false,
                    has_data_exposure: false,
                    has_missing_error_handling: true,
                    has_redundant_work_in_loop: false,
                    has_unsafe_data_flow: false,
                    requires_assumed_input: false,
                    requires_assumed_workload: false,
                    is_quality_opinion: false,
                    is_anti_pattern_only: false,
                    targets_unchanged_code: false,
                    improvedCode_is_correct: true,
                },
                {
                    organizationAndTeamData: {
                        organizationId: 'org-1',
                        teamId: 'team-1',
                    },
                    prNumber: 14282,
                    file: {
                        filename:
                            'packages/favorites/lib/src/features/favorite_button/favorite_button_build.dart',
                        fileContent: 'const x = 1;',
                    },
                    relevantContent: '',
                    codeDiff: '@@',
                    suggestions: [],
                    languageResultPrompt: 'en-US',
                    reviewMode: undefined,
                    byokConfig: {},
                },
                {} as any,
            );

            expect(mockObservabilityService.runLLMInSpan).toHaveBeenCalledWith(
                expect.objectContaining({
                    runName: 'safeguardPromptOnlyVerification',
                    attrs: expect.objectContaining({
                        organizationId: 'org-1',
                        prNumber: 14282,
                        suggestionId: 'suggestion-1',
                        safeguardMode: 'prompt_only',
                        sandboxAvailable: false,
                        sandboxReason: 'no_remote_commands',
                    }),
                }),
            );
            expect(result).toEqual({
                keep: false,
                evidence: 'not enough evidence',
            });
        });
    });
});
