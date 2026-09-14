jest.mock('@libs/core/log/logger', () => {
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

// v2-native: verifyWithPromptOnly runs the single span via runStructuredReviewCall
// (the legacy runLLMInSpan wrapper was dropped — REQ-NOLC-01 / Q4). Mock it there.
const mockRunStructuredReviewCall = jest.fn();
jest.mock('@libs/llm/structured-review-call', () => ({
    runStructuredReviewCall: (...args: unknown[]) =>
        mockRunStructuredReviewCall(...args),
}));

import { DocumentationSearchExaService } from '@/code-review/infrastructure/adapters/services/documentation-search-exa.service';
import { SafeguardPipelineService } from '@/code-review/infrastructure/adapters/services/safeguardPipeline.service';
import { ObservabilityService } from '@/core/log/observability.service';
import { ISandboxLeaseManager } from '@libs/sandbox/domain/contracts/sandbox-lease-manager.contract';
// __mockLogger is provided by the jest.mock factory above; pull it via
// requireMock so tsc doesn't flag it as a missing export on the real module.
const mockLogger = (
    jest.requireMock('@libs/core/log/logger') as { __mockLogger: any }
).__mockLogger;

describe('SafeguardPipelineService', () => {
    let service: SafeguardPipelineService;

    const mockObservabilityService = {
        runLLMInSpan: jest.fn(),
    } as unknown as ObservabilityService;
    const mockLeaseManager = {
        acquire: jest.fn(),
        release: jest.fn(),
        invalidate: jest.fn(),
    } as unknown as ISandboxLeaseManager;

    const mockDocumentationSearchExaService = {
        searchByFilePlan: jest.fn(),
    } as unknown as DocumentationSearchExaService;

    beforeEach(() => {
        service = new SafeguardPipelineService(
            mockObservabilityService,
            mockLeaseManager,
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

        // This session found the production bug this pins: sandbox renewal
        // used to call the raw provider directly, so a worker crash between
        // renewal and its own cleanup left an untracked, permanently-paused
        // E2B sandbox no reaper cron could ever find. The fix routes renewal
        // through the lease manager with a renewal-unique prKey (so it never
        // joins the PR's own active review lease), same crash-safety as the
        // rest of the sandbox stack.
        it('renews a dead sandbox through the lease manager with a renewal-unique prKey', async () => {
            jest.spyOn(service as any, 'extractFeatures').mockResolvedValue({
                codeSuggestions: [
                    {
                        id: 'suggestion-1',
                        features: {
                            has_resource_leak: true,
                            has_inconsistent_contract: false,
                            has_wrong_algorithm: false,
                            has_data_exposure: false,
                            has_missing_error_handling: false,
                            has_redundant_work_in_loop: false,
                            has_unsafe_data_flow: false,
                            requires_assumed_input: true,
                            requires_assumed_workload: false,
                            is_quality_opinion: false,
                            is_anti_pattern_only: false,
                            targets_unchanged_code: false,
                            improvedCode_is_correct: true,
                        },
                    },
                ],
            });

            const renewedSandbox = {
                remoteCommands: { grep: jest.fn() },
                cleanup: jest.fn().mockResolvedValue(undefined),
            };
            (mockLeaseManager.acquire as jest.Mock).mockResolvedValue({
                sandbox: renewedSandbox,
                leaseId: 'renew-lease-1',
                sandboxId: 'sbx-renew-1',
                wasCreated: true,
            });

            const verifyWithAgentSpy = jest
                .spyOn(service as any, 'verifyWithAgent')
                .mockRejectedValueOnce(new Error('sandbox unreachable'))
                .mockResolvedValueOnce({
                    action: 'no_changes',
                    evidence: 'confirmed real defect',
                    turnsUsed: 1,
                });

            await service.execute({
                organizationAndTeamData: {
                    organizationId: 'org-1',
                    teamId: 'team-1',
                } as any,
                prNumber: 999,
                file: { filename: 'src/a.ts' },
                relevantContent: '',
                codeDiff: '@@',
                suggestions: [
                    {
                        id: 'suggestion-1',
                        label: 'bug',
                        severity: 'critical',
                        filePath: 'src/a.ts',
                    },
                ],
                languageResultPrompt: 'en-US',
                reviewMode: undefined as any,
                byokConfig: {} as any,
                remoteCommands: { grep: jest.fn() } as any,
                getFreshCloneParams: jest.fn().mockResolvedValue({
                    cloneUrl: 'https://x/r.git',
                } as any),
            });

            expect(verifyWithAgentSpy).toHaveBeenCalledTimes(2);
            expect(mockLeaseManager.acquire).toHaveBeenCalledTimes(1);

            const [prKey, consumer] = (mockLeaseManager.acquire as jest.Mock)
                .mock.calls[0];
            expect(prKey).toMatch(/^org-1:safeguard-renew:999:.+$/);
            expect(consumer).toBe('safeguard-renewal');
            expect(renewedSandbox.cleanup).toHaveBeenCalledTimes(1);
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
            mockRunStructuredReviewCall.mockResolvedValue({
                verdict: false,
                evidence: 'not enough evidence',
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

            expect(mockRunStructuredReviewCall).toHaveBeenCalledWith(
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
