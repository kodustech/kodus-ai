import { Test, TestingModule } from '@nestjs/testing';
import { ImplementationVerificationProcessor } from '@/code-review/workflow/implementation-verification.processor';
import { WORKFLOW_JOB_REPOSITORY_TOKEN } from '@/core/workflow/domain/contracts/workflow-job.repository.contract';
import { SUGGESTION_SERVICE_TOKEN } from '@/code-review/domain/contracts/SuggestionService.contract';
import { PULL_REQUESTS_SERVICE_TOKEN } from '@/platformData/domain/pullRequests/contracts/pullRequests.service.contracts';
import { PULL_REQUEST_MANAGER_SERVICE_TOKEN } from '@/code-review/domain/contracts/PullRequestManagerService.contract';
import { AUTOMATION_EXECUTION_SERVICE_TOKEN } from '@/automation/domain/automationExecution/contracts/automation-execution.service';
import { TEAM_AUTOMATION_SERVICE_TOKEN } from '@/automation/domain/teamAutomation/contracts/team-automation.service';
import { WorkflowType } from '@/core/workflow/domain/enums/workflow-type.enum';
import { JobStatus } from '@/core/workflow/domain/enums/job-status.enum';
import { ErrorClassification } from '@/core/workflow/domain/enums/error-classification.enum';
import { DeliveryStatus } from '@/platformData/domain/pullRequests/enums/deliveryStatus.enum';
import { ImplementationStatus } from '@/platformData/domain/pullRequests/enums/implementationStatus.enum';
import { AutomationType } from '@/automation/domain/automation/enum/automation-type';
import { PlatformType } from '@/core/domain/enums/platform-type.enum';

// Mock logger to silence logs during tests
jest.mock('@kodus/flow', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    }),
}));

describe('ImplementationVerificationProcessor', () => {
    let processor: ImplementationVerificationProcessor;

    // Mock services
    const mockJobRepository = {
        findOne: jest.fn(),
        update: jest.fn(),
    };

    const mockSuggestionService = {
        validateImplementedSuggestions: jest.fn(),
        resolveImplementedSuggestionsOnPlatform: jest.fn(),
    };

    const mockPullRequestsService = {
        findOne: jest.fn(),
    };

    const mockPullRequestManagerService = {
        getPullRequestDetails: jest.fn(),
        getChangedFiles: jest.fn(),
    };

    const mockAutomationExecutionService = {
        findLatestExecutionByFilters: jest.fn(),
    };

    const mockTeamAutomationService = {
        find: jest.fn(),
    };

    // Test data factories
    const createMockJob = (overrides = {}) => ({
        id: 'job-123',
        workflowType: WorkflowType.CHECK_SUGGESTION_IMPLEMENTATION,
        status: JobStatus.PENDING,
        payload: {
            organizationAndTeamData: {
                organizationId: 'org-123',
                teamId: 'team-456',
            },
            repository: { id: 'repo-1', name: 'test-repo' },
            pullRequestNumber: 42,
            commitSha: 'abc123',
            trigger: 'synchronize',
            platformType: PlatformType.GITHUB,
        },
        ...overrides,
    });

    const createMockSuggestion = (overrides = {}) => ({
        id: 'suggestion-1',
        relevantFile: 'src/index.ts',
        language: 'typescript',
        existingCode: 'const x = 1;',
        improvedCode: 'const x: number = 1;',
        label: 'code_style',
        severity: 'medium',
        deliveryStatus: DeliveryStatus.SENT,
        implementationStatus: ImplementationStatus.NOT_IMPLEMENTED,
        ...overrides,
    });

    const createMockPR = (overrides = {}) => ({
        number: 42,
        repository: { id: 'repo-1', name: 'test-repo' },
        files: [
            {
                filename: 'src/index.ts',
                suggestions: [createMockSuggestion()],
            },
        ],
        ...overrides,
    });

    const createMockChangedFile = (overrides = {}) => ({
        filename: 'src/index.ts',
        patch: '@@ -1,1 +1,1 @@\n-const x = 1;\n+const x: number = 1;',
        ...overrides,
    });

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                ImplementationVerificationProcessor,
                {
                    provide: WORKFLOW_JOB_REPOSITORY_TOKEN,
                    useValue: mockJobRepository,
                },
                {
                    provide: SUGGESTION_SERVICE_TOKEN,
                    useValue: mockSuggestionService,
                },
                {
                    provide: PULL_REQUESTS_SERVICE_TOKEN,
                    useValue: mockPullRequestsService,
                },
                {
                    provide: PULL_REQUEST_MANAGER_SERVICE_TOKEN,
                    useValue: mockPullRequestManagerService,
                },
                {
                    provide: AUTOMATION_EXECUTION_SERVICE_TOKEN,
                    useValue: mockAutomationExecutionService,
                },
                {
                    provide: TEAM_AUTOMATION_SERVICE_TOKEN,
                    useValue: mockTeamAutomationService,
                },
            ],
        }).compile();

        processor = module.get<ImplementationVerificationProcessor>(
            ImplementationVerificationProcessor,
        );
        jest.clearAllMocks();
    });

    describe('process', () => {
        describe('validation errors', () => {
            it('should throw error when job is not found', async () => {
                mockJobRepository.findOne.mockResolvedValue(null);

                await expect(
                    processor.process('non-existent-job'),
                ).rejects.toThrow('Job non-existent-job not found');

                expect(mockJobRepository.findOne).toHaveBeenCalledWith(
                    'non-existent-job',
                );
            });

            it('should throw error when workflow type is invalid', async () => {
                const invalidJob = createMockJob({
                    workflowType: 'AUTOMATION_EXECUTION' as any,
                });
                mockJobRepository.findOne.mockResolvedValue(invalidJob);

                await expect(processor.process('job-123')).rejects.toThrow(
                    `Invalid workflow type ${'AUTOMATION_EXECUTION' as any}`,
                );
            });
        });

        describe('early exit scenarios', () => {
            it('should complete with PR_NOT_FOUND when PR does not exist in database', async () => {
                const job = createMockJob();
                mockJobRepository.findOne.mockResolvedValue(job);
                mockPullRequestsService.findOne.mockResolvedValue(null);

                await processor.process('job-123');

                expect(mockJobRepository.update).toHaveBeenCalledWith(
                    'job-123',
                    {
                        status: JobStatus.COMPLETED,
                        completedAt: expect.any(Date),
                        result: { reason: 'PR_NOT_FOUND' },
                    },
                );
                expect(
                    mockSuggestionService.validateImplementedSuggestions,
                ).not.toHaveBeenCalled();
            });

            it.each([
                {
                    scenario: 'PR has no suggestions',
                    files: [{ filename: 'src/index.ts', suggestions: [] }],
                },
                {
                    scenario: 'all suggestions already implemented',
                    files: [
                        {
                            filename: 'src/index.ts',
                            suggestions: [
                                createMockSuggestion({
                                    implementationStatus:
                                        ImplementationStatus.IMPLEMENTED,
                                }),
                            ],
                        },
                    ],
                },
                {
                    scenario: 'suggestions not SENT',
                    files: [
                        {
                            filename: 'src/index.ts',
                            suggestions: [
                                createMockSuggestion({
                                    deliveryStatus: DeliveryStatus.NOT_SENT,
                                }),
                            ],
                        },
                    ],
                },
                {
                    scenario: 'suggestions SENT but FAILED delivery',
                    files: [
                        {
                            filename: 'src/index.ts',
                            suggestions: [
                                createMockSuggestion({
                                    deliveryStatus: DeliveryStatus.FAILED,
                                }),
                            ],
                        },
                    ],
                },
            ])(
                'should complete with NO_SUGGESTIONS when $scenario',
                async ({ files }) => {
                    const job = createMockJob();
                    const pr = createMockPR({ files });

                    mockJobRepository.findOne.mockResolvedValue(job);
                    mockPullRequestsService.findOne.mockResolvedValue(pr);

                    await processor.process('job-123');

                    expect(mockJobRepository.update).toHaveBeenCalledWith(
                        'job-123',
                        {
                            status: JobStatus.COMPLETED,
                            completedAt: expect.any(Date),
                            result: { reason: 'NO_SUGGESTIONS' },
                        },
                    );
                    expect(
                        mockSuggestionService.validateImplementedSuggestions,
                    ).not.toHaveBeenCalled();
                },
            );

            it('should include PARTIALLY_IMPLEMENTED suggestions in verification', async () => {
                const job = createMockJob();
                const pr = createMockPR({
                    files: [
                        {
                            filename: 'src/index.ts',
                            suggestions: [
                                createMockSuggestion({
                                    id: 'partial-suggestion',
                                    implementationStatus:
                                        ImplementationStatus.PARTIALLY_IMPLEMENTED,
                                    deliveryStatus: DeliveryStatus.SENT,
                                }),
                            ],
                        },
                    ],
                });

                mockJobRepository.findOne.mockResolvedValue(job);
                mockPullRequestsService.findOne.mockResolvedValue(pr);
                mockTeamAutomationService.find.mockResolvedValue([]);
                mockAutomationExecutionService.findLatestExecutionByFilters.mockResolvedValue(
                    null,
                );
                mockPullRequestManagerService.getPullRequestDetails.mockResolvedValue(
                    {
                        number: 42,
                        repository: {},
                    },
                );
                mockPullRequestManagerService.getChangedFiles.mockResolvedValue(
                    [createMockChangedFile()],
                );
                mockSuggestionService.validateImplementedSuggestions.mockResolvedValue(
                    [],
                );
                mockSuggestionService.resolveImplementedSuggestionsOnPlatform.mockResolvedValue(
                    undefined,
                );

                await processor.process('job-123');

                // PARTIALLY_IMPLEMENTED should be included in validation (not filtered out)
                expect(
                    mockSuggestionService.validateImplementedSuggestions,
                ).toHaveBeenCalled();
                const passedSuggestions =
                    mockSuggestionService.validateImplementedSuggestions.mock
                        .calls[0][2];
                expect(passedSuggestions).toHaveLength(1);
                expect(passedSuggestions[0].id).toBe('partial-suggestion');
            });

            it('should complete with NO_RELEVANT_CHANGES when changed files do not match suggestions', async () => {
                const job = createMockJob();
                const pr = createMockPR();

                mockJobRepository.findOne.mockResolvedValue(job);
                mockPullRequestsService.findOne.mockResolvedValue(pr);
                mockTeamAutomationService.find.mockResolvedValue([
                    {
                        uuid: 'automation-1',
                        automation: {
                            automationType:
                                AutomationType.AUTOMATION_CODE_REVIEW,
                        },
                    },
                ]);
                mockAutomationExecutionService.findLatestExecutionByFilters.mockResolvedValue(
                    {
                        dataExecution: { lastAnalyzedCommit: 'prev-commit' },
                    },
                );
                mockPullRequestManagerService.getPullRequestDetails.mockResolvedValue(
                    {
                        number: 42,
                        repository: {},
                    },
                );
                mockPullRequestManagerService.getChangedFiles.mockResolvedValue(
                    [
                        createMockChangedFile({
                            filename: 'src/other-file.ts',
                        }), // Different file
                    ],
                );

                await processor.process('job-123');

                expect(mockJobRepository.update).toHaveBeenCalledWith(
                    'job-123',
                    {
                        status: JobStatus.COMPLETED,
                        completedAt: expect.any(Date),
                        result: { reason: 'NO_RELEVANT_CHANGES' },
                    },
                );
            });

            it('should complete with NO_PATCH when changed files have no patch content', async () => {
                const job = createMockJob();
                const pr = createMockPR();

                mockJobRepository.findOne.mockResolvedValue(job);
                mockPullRequestsService.findOne.mockResolvedValue(pr);
                mockTeamAutomationService.find.mockResolvedValue([
                    {
                        uuid: 'automation-1',
                        automation: {
                            automationType:
                                AutomationType.AUTOMATION_CODE_REVIEW,
                        },
                    },
                ]);
                mockAutomationExecutionService.findLatestExecutionByFilters.mockResolvedValue(
                    null,
                );
                mockPullRequestManagerService.getPullRequestDetails.mockResolvedValue(
                    {
                        number: 42,
                        repository: {},
                    },
                );
                mockPullRequestManagerService.getChangedFiles.mockResolvedValue(
                    [
                        createMockChangedFile({ patch: null }), // No patch
                    ],
                );

                await processor.process('job-123');

                expect(mockJobRepository.update).toHaveBeenCalledWith(
                    'job-123',
                    {
                        status: JobStatus.COMPLETED,
                        completedAt: expect.any(Date),
                        result: { reason: 'NO_PATCH' },
                    },
                );
            });
        });

        describe('successful verification flow', () => {
            it('should validate implemented suggestions and complete job successfully', async () => {
                const job = createMockJob();
                const pr = createMockPR();
                const changedFile = createMockChangedFile();

                mockJobRepository.findOne.mockResolvedValue(job);
                mockPullRequestsService.findOne.mockResolvedValue(pr);
                mockTeamAutomationService.find.mockResolvedValue([
                    {
                        uuid: 'automation-1',
                        automation: {
                            automationType:
                                AutomationType.AUTOMATION_CODE_REVIEW,
                        },
                    },
                ]);
                mockAutomationExecutionService.findLatestExecutionByFilters.mockResolvedValue(
                    {
                        dataExecution: { lastAnalyzedCommit: 'prev-commit' },
                    },
                );
                mockPullRequestManagerService.getPullRequestDetails.mockResolvedValue(
                    {
                        number: 42,
                        repository: {},
                    },
                );
                mockPullRequestManagerService.getChangedFiles.mockResolvedValue(
                    [changedFile],
                );
                mockSuggestionService.validateImplementedSuggestions.mockResolvedValue(
                    [
                        {
                            id: 'suggestion-1',
                            implementationStatus:
                                ImplementationStatus.IMPLEMENTED,
                        },
                    ],
                );
                mockSuggestionService.resolveImplementedSuggestionsOnPlatform.mockResolvedValue(
                    undefined,
                );

                await processor.process('job-123');

                // Verify validateImplementedSuggestions was called with correct params
                expect(
                    mockSuggestionService.validateImplementedSuggestions,
                ).toHaveBeenCalledWith(
                    job.payload.organizationAndTeamData,
                    expect.stringContaining('File: src/index.ts'), // codePatch
                    expect.arrayContaining([
                        expect.objectContaining({
                            id: 'suggestion-1',
                            relevantFile: 'src/index.ts',
                        }),
                    ]),
                    42, // prNumber
                );

                // Verify resolveImplementedSuggestionsOnPlatform was called
                expect(
                    mockSuggestionService.resolveImplementedSuggestionsOnPlatform,
                ).toHaveBeenCalledWith({
                    organizationAndTeamData:
                        job.payload.organizationAndTeamData,
                    repository: { id: 'repo-1', name: 'test-repo' },
                    prNumber: 42,
                    platformType: PlatformType.GITHUB,
                });

                // Verify job was marked as completed
                expect(mockJobRepository.update).toHaveBeenCalledWith(
                    'job-123',
                    {
                        status: JobStatus.COMPLETED,
                        completedAt: expect.any(Date),
                        result: { checkedCount: 1 },
                    },
                );
            });

            it('should process validation results and always call resolveImplementedSuggestionsOnPlatform', async () => {
                const job = createMockJob();
                const pr = createMockPR({
                    files: [
                        {
                            filename: 'src/index.ts',
                            suggestions: [
                                createMockSuggestion({ id: 'sug-1' }),
                                createMockSuggestion({ id: 'sug-2' }),
                                createMockSuggestion({ id: 'sug-3' }),
                            ],
                        },
                    ],
                });

                mockJobRepository.findOne.mockResolvedValue(job);
                mockPullRequestsService.findOne.mockResolvedValue(pr);
                mockTeamAutomationService.find.mockResolvedValue([]);
                mockAutomationExecutionService.findLatestExecutionByFilters.mockResolvedValue(
                    null,
                );
                mockPullRequestManagerService.getPullRequestDetails.mockResolvedValue(
                    {
                        number: 42,
                        repository: {},
                    },
                );
                mockPullRequestManagerService.getChangedFiles.mockResolvedValue(
                    [createMockChangedFile()],
                );

                // LLM returns that 2 out of 3 suggestions were implemented
                mockSuggestionService.validateImplementedSuggestions.mockResolvedValue(
                    [
                        {
                            id: 'sug-1',
                            implementationStatus:
                                ImplementationStatus.IMPLEMENTED,
                        },
                        {
                            id: 'sug-3',
                            implementationStatus:
                                ImplementationStatus.PARTIALLY_IMPLEMENTED,
                        },
                    ],
                );
                mockSuggestionService.resolveImplementedSuggestionsOnPlatform.mockResolvedValue(
                    undefined,
                );

                await processor.process('job-123');

                // Should call validateImplementedSuggestions with all 3 suggestions
                const passedSuggestions =
                    mockSuggestionService.validateImplementedSuggestions.mock
                        .calls[0][2];
                expect(passedSuggestions).toHaveLength(3);

                // Should call resolveImplementedSuggestionsOnPlatform to mark comments as resolved
                expect(
                    mockSuggestionService.resolveImplementedSuggestionsOnPlatform,
                ).toHaveBeenCalledWith({
                    organizationAndTeamData:
                        job.payload.organizationAndTeamData,
                    repository: { id: 'repo-1', name: 'test-repo' },
                    prNumber: 42,
                    platformType: PlatformType.GITHUB,
                });

                // Job should complete with count of checked suggestions (not implemented count)
                expect(mockJobRepository.update).toHaveBeenCalledWith(
                    'job-123',
                    {
                        status: JobStatus.COMPLETED,
                        completedAt: expect.any(Date),
                        result: { checkedCount: 3 },
                    },
                );
            });

            it('should filter suggestions to only include those from changed files', async () => {
                const job = createMockJob();
                const pr = createMockPR({
                    files: [
                        {
                            filename: 'src/index.ts',
                            suggestions: [
                                createMockSuggestion({
                                    id: 'suggestion-1',
                                    relevantFile: 'src/index.ts',
                                }),
                            ],
                        },
                        {
                            filename: 'src/other.ts',
                            suggestions: [
                                createMockSuggestion({
                                    id: 'suggestion-2',
                                    relevantFile: 'src/other.ts',
                                }),
                            ],
                        },
                    ],
                });

                mockJobRepository.findOne.mockResolvedValue(job);
                mockPullRequestsService.findOne.mockResolvedValue(pr);
                mockTeamAutomationService.find.mockResolvedValue([]);
                mockAutomationExecutionService.findLatestExecutionByFilters.mockResolvedValue(
                    null,
                );
                mockPullRequestManagerService.getPullRequestDetails.mockResolvedValue(
                    {
                        number: 42,
                        repository: {},
                    },
                );
                // Only src/index.ts changed
                mockPullRequestManagerService.getChangedFiles.mockResolvedValue(
                    [createMockChangedFile({ filename: 'src/index.ts' })],
                );
                mockSuggestionService.validateImplementedSuggestions.mockResolvedValue(
                    [],
                );
                mockSuggestionService.resolveImplementedSuggestionsOnPlatform.mockResolvedValue(
                    undefined,
                );

                await processor.process('job-123');

                // Should only pass suggestion-1 (from changed file)
                expect(
                    mockSuggestionService.validateImplementedSuggestions,
                ).toHaveBeenCalledWith(
                    expect.anything(),
                    expect.anything(),
                    expect.arrayContaining([
                        expect.objectContaining({ id: 'suggestion-1' }),
                    ]),
                    expect.anything(),
                );

                // Verify suggestion-2 was NOT passed
                const passedSuggestions =
                    mockSuggestionService.validateImplementedSuggestions.mock
                        .calls[0][2];
                expect(
                    passedSuggestions.find((s) => s.id === 'suggestion-2'),
                ).toBeUndefined();
            });

            it('should construct codePatch correctly from multiple changed files', async () => {
                const job = createMockJob();
                const pr = createMockPR({
                    files: [
                        {
                            filename: 'src/index.ts',
                            suggestions: [
                                createMockSuggestion({
                                    relevantFile: 'src/index.ts',
                                }),
                            ],
                        },
                        {
                            filename: 'src/utils.ts',
                            suggestions: [
                                createMockSuggestion({
                                    id: 'suggestion-2',
                                    relevantFile: 'src/utils.ts',
                                }),
                            ],
                        },
                    ],
                });

                mockJobRepository.findOne.mockResolvedValue(job);
                mockPullRequestsService.findOne.mockResolvedValue(pr);
                mockTeamAutomationService.find.mockResolvedValue([]);
                mockAutomationExecutionService.findLatestExecutionByFilters.mockResolvedValue(
                    null,
                );
                mockPullRequestManagerService.getPullRequestDetails.mockResolvedValue(
                    {
                        number: 42,
                        repository: {},
                    },
                );
                mockPullRequestManagerService.getChangedFiles.mockResolvedValue(
                    [
                        createMockChangedFile({
                            filename: 'src/index.ts',
                            patch: 'patch1',
                        }),
                        createMockChangedFile({
                            filename: 'src/utils.ts',
                            patch: 'patch2',
                        }),
                    ],
                );
                mockSuggestionService.validateImplementedSuggestions.mockResolvedValue(
                    [],
                );
                mockSuggestionService.resolveImplementedSuggestionsOnPlatform.mockResolvedValue(
                    undefined,
                );

                await processor.process('job-123');

                const codePatch =
                    mockSuggestionService.validateImplementedSuggestions.mock
                        .calls[0][1];
                expect(codePatch).toContain('File: src/index.ts');
                expect(codePatch).toContain('patch1');
                expect(codePatch).toContain('File: src/utils.ts');
                expect(codePatch).toContain('patch2');
            });

            it('should use pull_request from payload and pass project.id to getChangedFiles', async () => {
                const mockPullRequestFromPayload = {
                    number: 99, // Different number initially, but gets overwritten
                    title: 'Test PR',
                    repository: { project: { id: 'project-xyz' } },
                };

                const job = createMockJob({
                    payload: {
                        ...createMockJob().payload,
                        payload: { pull_request: mockPullRequestFromPayload },
                    },
                });
                const pr = createMockPR();

                mockJobRepository.findOne.mockResolvedValue(job);
                mockPullRequestsService.findOne.mockResolvedValue(pr);
                mockTeamAutomationService.find.mockResolvedValue([]);
                mockAutomationExecutionService.findLatestExecutionByFilters.mockResolvedValue(
                    null,
                );
                mockPullRequestManagerService.getChangedFiles.mockResolvedValue(
                    [createMockChangedFile()],
                );
                mockSuggestionService.validateImplementedSuggestions.mockResolvedValue(
                    [],
                );
                mockSuggestionService.resolveImplementedSuggestionsOnPlatform.mockResolvedValue(
                    undefined,
                );

                await processor.process('job-123');

                // Should NOT call getPullRequestDetails since we have pull_request in payload
                expect(
                    mockPullRequestManagerService.getPullRequestDetails,
                ).not.toHaveBeenCalled();

                // Should pass project.id from payload's pull_request.repository to getChangedFiles
                const getChangedFilesCall =
                    mockPullRequestManagerService.getChangedFiles.mock.calls[0];
                const repositoryArg = getChangedFilesCall[1];
                const platformPrArg = getChangedFilesCall[2];

                // Verify project.id was extracted from payload's pull_request
                expect(repositoryArg.project).toEqual({ id: 'project-xyz' });
                // Verify the platformPr contains data from the payload
                expect(platformPrArg.title).toBe('Test PR');
                expect(platformPrArg.number).toBe(42); // Overwritten by payload.pullRequestNumber
            });

            it('should fetch PR details when not in payload', async () => {
                const job = createMockJob();
                const pr = createMockPR();

                mockJobRepository.findOne.mockResolvedValue(job);
                mockPullRequestsService.findOne.mockResolvedValue(pr);
                mockTeamAutomationService.find.mockResolvedValue([]);
                mockAutomationExecutionService.findLatestExecutionByFilters.mockResolvedValue(
                    null,
                );
                mockPullRequestManagerService.getPullRequestDetails.mockResolvedValue(
                    {
                        number: 42,
                        repository: {},
                    },
                );
                mockPullRequestManagerService.getChangedFiles.mockResolvedValue(
                    [createMockChangedFile()],
                );
                mockSuggestionService.validateImplementedSuggestions.mockResolvedValue(
                    [],
                );
                mockSuggestionService.resolveImplementedSuggestionsOnPlatform.mockResolvedValue(
                    undefined,
                );

                await processor.process('job-123');

                expect(
                    mockPullRequestManagerService.getPullRequestDetails,
                ).toHaveBeenCalledWith(
                    job.payload.organizationAndTeamData,
                    { name: 'test-repo', id: 'repo-1' },
                    42,
                );
            });

            it('should use resource from payload for Azure DevOps', async () => {
                const mockResourceFromPayload = {
                    pullRequestId: 42,
                    title: 'Azure PR',
                    repository: { project: { id: 'azure-project-id' } },
                };

                const job = createMockJob({
                    payload: {
                        ...createMockJob().payload,
                        payload: { resource: mockResourceFromPayload },
                        platformType: PlatformType.AZURE_REPOS,
                    },
                });
                const pr = createMockPR();

                mockJobRepository.findOne.mockResolvedValue(job);
                mockPullRequestsService.findOne.mockResolvedValue(pr);
                mockTeamAutomationService.find.mockResolvedValue([]);
                mockAutomationExecutionService.findLatestExecutionByFilters.mockResolvedValue(
                    null,
                );
                mockPullRequestManagerService.getChangedFiles.mockResolvedValue(
                    [createMockChangedFile()],
                );
                mockSuggestionService.validateImplementedSuggestions.mockResolvedValue(
                    [],
                );
                mockSuggestionService.resolveImplementedSuggestionsOnPlatform.mockResolvedValue(
                    undefined,
                );

                await processor.process('job-123');

                // Should NOT call getPullRequestDetails since we have resource in payload
                expect(
                    mockPullRequestManagerService.getPullRequestDetails,
                ).not.toHaveBeenCalled();

                // Should use resource data
                const getChangedFilesCall =
                    mockPullRequestManagerService.getChangedFiles.mock.calls[0];
                const repositoryArg = getChangedFilesCall[1];

                expect(repositoryArg.project).toEqual({
                    id: 'azure-project-id',
                });
            });
        });

        describe('error handling', () => {
            it('should mark job as failed when an error occurs during processing', async () => {
                const job = createMockJob();
                const pr = createMockPR();
                const testError = new Error('Test error during validation');

                mockJobRepository.findOne.mockResolvedValue(job);
                mockPullRequestsService.findOne.mockResolvedValue(pr);
                mockTeamAutomationService.find.mockResolvedValue([]);
                mockAutomationExecutionService.findLatestExecutionByFilters.mockResolvedValue(
                    null,
                );
                mockPullRequestManagerService.getPullRequestDetails.mockResolvedValue(
                    {
                        number: 42,
                        repository: {},
                    },
                );
                mockPullRequestManagerService.getChangedFiles.mockResolvedValue(
                    [createMockChangedFile()],
                );
                mockSuggestionService.validateImplementedSuggestions.mockRejectedValue(
                    testError,
                );

                await expect(processor.process('job-123')).rejects.toThrow(
                    'Test error during validation',
                );

                expect(mockJobRepository.update).toHaveBeenCalledWith(
                    'job-123',
                    {
                        status: JobStatus.FAILED,
                        errorClassification: ErrorClassification.PERMANENT,
                        lastError: 'Test error during validation',
                        failedAt: expect.any(Date),
                    },
                );
            });

            it('should handle errors from getPullRequestDetails', async () => {
                const job = createMockJob();
                const pr = createMockPR();

                mockJobRepository.findOne.mockResolvedValue(job);
                mockPullRequestsService.findOne.mockResolvedValue(pr);
                mockTeamAutomationService.find.mockResolvedValue([]);
                mockAutomationExecutionService.findLatestExecutionByFilters.mockResolvedValue(
                    null,
                );
                mockPullRequestManagerService.getPullRequestDetails.mockRejectedValue(
                    new Error('Platform API error'),
                );

                await expect(processor.process('job-123')).rejects.toThrow(
                    'Platform API error',
                );

                expect(mockJobRepository.update).toHaveBeenCalledWith(
                    'job-123',
                    {
                        status: JobStatus.FAILED,
                        errorClassification: ErrorClassification.PERMANENT,
                        lastError: 'Platform API error',
                        failedAt: expect.any(Date),
                    },
                );
            });
        });

        describe('suggestion filtering logic', () => {
            it('should only pass required properties and strip extra data from suggestions', async () => {
                const job = createMockJob();
                const suggestion = createMockSuggestion({
                    id: 'suggestion-1',
                    relevantFile: 'src/index.ts',
                    language: 'typescript',
                    existingCode: 'const x = 1;',
                    improvedCode: 'const x: number = 1;',
                    label: 'code_style',
                    severity: 'medium',
                    // Extra properties that should NOT be passed to LLM
                    suggestionContent: 'Add type annotation',
                    comment: { id: 123, pullRequestReviewId: 456 },
                    rankScore: 100,
                    priorityStatus: 'PRIORITIZED',
                });

                const pr = createMockPR({
                    files: [
                        { filename: 'src/index.ts', suggestions: [suggestion] },
                    ],
                });

                mockJobRepository.findOne.mockResolvedValue(job);
                mockPullRequestsService.findOne.mockResolvedValue(pr);
                mockTeamAutomationService.find.mockResolvedValue([]);
                mockAutomationExecutionService.findLatestExecutionByFilters.mockResolvedValue(
                    null,
                );
                mockPullRequestManagerService.getPullRequestDetails.mockResolvedValue(
                    {
                        number: 42,
                        repository: {},
                    },
                );
                mockPullRequestManagerService.getChangedFiles.mockResolvedValue(
                    [createMockChangedFile()],
                );
                mockSuggestionService.validateImplementedSuggestions.mockResolvedValue(
                    [],
                );
                mockSuggestionService.resolveImplementedSuggestionsOnPlatform.mockResolvedValue(
                    undefined,
                );

                await processor.process('job-123');

                const passedSuggestions =
                    mockSuggestionService.validateImplementedSuggestions.mock
                        .calls[0][2];
                const passedSuggestion = passedSuggestions[0];

                // Should include only these properties (what the LLM needs)
                expect(Object.keys(passedSuggestion).sort()).toEqual(
                    [
                        'existingCode',
                        'id',
                        'improvedCode',
                        'label',
                        'language',
                        'relevantFile',
                        'severity',
                    ].sort(),
                );

                // Verify values
                expect(passedSuggestion).toEqual({
                    id: 'suggestion-1',
                    relevantFile: 'src/index.ts',
                    language: 'typescript',
                    existingCode: 'const x = 1;',
                    improvedCode: 'const x: number = 1;',
                    label: 'code_style',
                    severity: 'medium',
                });

                // Explicitly verify extra props were stripped (defensive check)
                expect(passedSuggestion).not.toHaveProperty(
                    'suggestionContent',
                );
                expect(passedSuggestion).not.toHaveProperty('comment');
                expect(passedSuggestion).not.toHaveProperty('rankScore');
                expect(passedSuggestion).not.toHaveProperty('priorityStatus');
            });

            it('should handle PR with files array being null', async () => {
                const job = createMockJob();
                const pr = createMockPR({ files: null });

                mockJobRepository.findOne.mockResolvedValue(job);
                mockPullRequestsService.findOne.mockResolvedValue(pr);

                await processor.process('job-123');

                expect(mockJobRepository.update).toHaveBeenCalledWith(
                    'job-123',
                    {
                        status: JobStatus.COMPLETED,
                        completedAt: expect.any(Date),
                        result: { reason: 'NO_SUGGESTIONS' },
                    },
                );
            });

            it('should handle file with suggestions array being null', async () => {
                const job = createMockJob();
                const pr = createMockPR({
                    files: [{ filename: 'src/index.ts', suggestions: null }],
                });

                mockJobRepository.findOne.mockResolvedValue(job);
                mockPullRequestsService.findOne.mockResolvedValue(pr);

                await processor.process('job-123');

                expect(mockJobRepository.update).toHaveBeenCalledWith(
                    'job-123',
                    {
                        status: JobStatus.COMPLETED,
                        completedAt: expect.any(Date),
                        result: { reason: 'NO_SUGGESTIONS' },
                    },
                );
            });
        });

        describe('team automation and execution context', () => {
            it('should use lastAnalyzedCommit from latest successful execution', async () => {
                const job = createMockJob();
                const pr = createMockPR();
                const lastCommit = 'abc123-previous-commit';

                mockJobRepository.findOne.mockResolvedValue(job);
                mockPullRequestsService.findOne.mockResolvedValue(pr);
                mockTeamAutomationService.find.mockResolvedValue([
                    {
                        uuid: 'automation-1',
                        automation: {
                            automationType:
                                AutomationType.AUTOMATION_CODE_REVIEW,
                        },
                    },
                ]);
                mockAutomationExecutionService.findLatestExecutionByFilters.mockResolvedValue(
                    {
                        dataExecution: { lastAnalyzedCommit: lastCommit },
                    },
                );
                mockPullRequestManagerService.getPullRequestDetails.mockResolvedValue(
                    {
                        number: 42,
                        repository: {},
                    },
                );
                mockPullRequestManagerService.getChangedFiles.mockResolvedValue(
                    [createMockChangedFile()],
                );
                mockSuggestionService.validateImplementedSuggestions.mockResolvedValue(
                    [],
                );
                mockSuggestionService.resolveImplementedSuggestionsOnPlatform.mockResolvedValue(
                    undefined,
                );

                await processor.process('job-123');

                // Verify getChangedFiles was called with lastAnalyzedCommit
                expect(
                    mockPullRequestManagerService.getChangedFiles,
                ).toHaveBeenCalledWith(
                    job.payload.organizationAndTeamData,
                    expect.any(Object),
                    expect.any(Object),
                    [],
                    lastCommit,
                );
            });

            it('should handle missing team automation gracefully', async () => {
                const job = createMockJob();
                const pr = createMockPR();

                mockJobRepository.findOne.mockResolvedValue(job);
                mockPullRequestsService.findOne.mockResolvedValue(pr);
                mockTeamAutomationService.find.mockResolvedValue(null);
                mockAutomationExecutionService.findLatestExecutionByFilters.mockResolvedValue(
                    null,
                );
                mockPullRequestManagerService.getPullRequestDetails.mockResolvedValue(
                    {
                        number: 42,
                        repository: {},
                    },
                );
                mockPullRequestManagerService.getChangedFiles.mockResolvedValue(
                    [createMockChangedFile()],
                );
                mockSuggestionService.validateImplementedSuggestions.mockResolvedValue(
                    [],
                );
                mockSuggestionService.resolveImplementedSuggestionsOnPlatform.mockResolvedValue(
                    undefined,
                );

                await processor.process('job-123');

                expect(mockJobRepository.update).toHaveBeenCalledWith(
                    'job-123',
                    {
                        status: JobStatus.COMPLETED,
                        completedAt: expect.any(Date),
                        result: { checkedCount: 1 },
                    },
                );
            });
        });
    });

    describe('handleFailure', () => {
        it('should update job with failed status and error details', async () => {
            const error = new Error('Processing failed');

            await processor.handleFailure('job-123', error);

            expect(mockJobRepository.update).toHaveBeenCalledWith('job-123', {
                status: JobStatus.FAILED,
                errorClassification: ErrorClassification.PERMANENT,
                lastError: 'Processing failed',
                failedAt: expect.any(Date),
            });
        });
    });

    describe('markCompleted', () => {
        it('should update job with completed status and result', async () => {
            const result = { checkedCount: 5, implementedCount: 3 };

            await processor.markCompleted('job-123', result);

            expect(mockJobRepository.update).toHaveBeenCalledWith('job-123', {
                status: JobStatus.COMPLETED,
                completedAt: expect.any(Date),
                result: result,
            });
        });

        it('should update job with completed status without result', async () => {
            await processor.markCompleted('job-123');

            expect(mockJobRepository.update).toHaveBeenCalledWith('job-123', {
                status: JobStatus.COMPLETED,
                completedAt: expect.any(Date),
                result: undefined,
            });
        });
    });
});
