import { AutomationStatus } from '@libs/automation/domain/automation/enum/automation-status';
import { IAutomationExecutionService } from '@libs/automation/domain/automationExecution/contracts/automation-execution.service';
import { CodeReviewPipelineContext } from '@libs/code-review/pipeline/context/code-review-pipeline.context';
import { StageVisibility } from '@libs/core/infrastructure/pipeline/enums/stage-visibility.enum';
import {
    CheckConclusion,
    CheckStatus,
} from '@libs/core/infrastructure/pipeline/interfaces/checks-adapter.interface';
import { IPipelineChecksService } from '@libs/core/infrastructure/pipeline/interfaces/pipeline-checks-service.interface';
import { PipelineObserverContext } from '@libs/core/infrastructure/pipeline/interfaces/pipeline-observer.interface';
import { CheckStageNames } from '@libs/core/infrastructure/pipeline/services/pipeline-checks.service';
import { CodeReviewPipelineObserver } from './code-review-pipeline.observer';

describe('CodeReviewPipelineObserver', () => {
    let observer: CodeReviewPipelineObserver;
    let mockAutomationExecutionService: jest.Mocked<IAutomationExecutionService>;
    let mockPipelineCheckService: jest.Mocked<IPipelineChecksService>;
    let context: Partial<CodeReviewPipelineContext>;
    let observersContext: Partial<PipelineObserverContext>;

    beforeEach(() => {
        const stageLogs = new Map<string, any>();

        mockAutomationExecutionService = {
            updateCodeReview: jest
                .fn()
                .mockImplementation(
                    async (filter, data, message, stageName) => {
                        const result = {
                            execution: { uuid: 'exec-uuid' },
                            stageLog: { uuid: 'stage-log-uuid' },
                        };
                        if (stageName) {
                            stageLogs.set(stageName, result.stageLog);
                        }
                        return result;
                    },
                ),
            updateStageLog: jest.fn().mockResolvedValue(undefined),
            findLatestExecutionByFilters: jest.fn(),
            findLatestStageLog: jest
                .fn()
                .mockImplementation(async (uuid, stageName) => {
                    return stageLogs.get(stageName);
                }),
        } as any;

        mockPipelineCheckService = {
            startCheck: jest.fn().mockResolvedValue(undefined),
            updateCheck: jest.fn().mockResolvedValue(undefined),
            finalizeCheck: jest.fn().mockResolvedValue(undefined),
        };

        observer = new CodeReviewPipelineObserver(
            mockAutomationExecutionService,
            mockPipelineCheckService,
        );

        context = {
            pipelineMetadata: { lastExecution: { uuid: 'exec-1' } } as any,
            pullRequest: { number: 123 } as any,
            repository: { id: 'repo-1' } as any,
            organizationAndTeamData: { organizationId: 'org-1' } as any,
            correlationId: 'exec-1',
        };

        observersContext = {};
    });

    it('should start pipeline check on pipeline start', async () => {
        await observer.onPipelineStart(
            context as CodeReviewPipelineContext,
            observersContext,
        );

        expect(mockPipelineCheckService.startCheck).toHaveBeenCalledWith(
            observersContext,
            context,
            '_pipelineStart',
        );
    });

    it('should finalize pipeline check on pipeline finish (success)', async () => {
        context.statusInfo = { status: AutomationStatus.SUCCESS } as any;
        context.errors = [];

        await observer.onPipelineFinish(
            context as CodeReviewPipelineContext,
            observersContext,
        );

        expect(mockPipelineCheckService.finalizeCheck).toHaveBeenCalledWith(
            observersContext,
            context,
            CheckConclusion.SUCCESS,
            CheckStageNames._pipelineEndSuccess,
        );
    });

    it('should finalize pipeline check on pipeline finish (failure)', async () => {
        context.statusInfo = { status: AutomationStatus.ERROR } as any;
        context.errors = [
            {
                stage: 'FileAnalysisStage',
                substage: 'src/app.ts',
                error: new Error(
                    'MODEL_NOT_FOUND: hf:zai-org/GLM-4.6 is no longer supported',
                ),
            } as any,
        ];

        await observer.onPipelineFinish(
            context as CodeReviewPipelineContext,
            observersContext,
        );

        expect(mockPipelineCheckService.finalizeCheck).toHaveBeenCalledWith(
            observersContext,
            context,
            CheckConclusion.FAILURE,
            CheckStageNames._pipelineEndFailure,
            expect.stringContaining(
                'MODEL_NOT_FOUND: hf:zai-org/GLM-4.6 is no longer supported',
            ),
        );
    });

    it('should finalize pipeline check on pipeline finish (skipped)', async () => {
        context.statusInfo = {
            status: AutomationStatus.SKIPPED,
            message: 'Skipped reason',
        } as any;

        await observer.onPipelineFinish(
            context as CodeReviewPipelineContext,
            observersContext,
        );

        expect(mockPipelineCheckService.finalizeCheck).toHaveBeenCalledWith(
            observersContext,
            context,
            CheckConclusion.SKIPPED,
            CheckStageNames._pipelineEndSkipped,
            'Skipped reason',
        );
    });

    it('should log stage start and store log ID in map', async () => {
        await observer.onStageStart(
            'TestStage',
            context as CodeReviewPipelineContext,
            observersContext,
        );

        expect(mockPipelineCheckService.updateCheck).toHaveBeenCalledWith(
            observersContext,
            context,
            'TestStage',
            CheckStatus.IN_PROGRESS,
        );

        expect(
            mockAutomationExecutionService.updateCodeReview,
        ).toHaveBeenCalledWith(
            expect.objectContaining({
                uuid: 'exec-1',
            }),
            expect.objectContaining({ status: AutomationStatus.IN_PROGRESS }),
            'Starting...',
            'TestStage',
            undefined,
        );
    });

    it('should update stage log on finish using ID from map', async () => {
        // First, start the stage to populate the map
        await observer.onStageStart(
            'TestStage',
            context as CodeReviewPipelineContext,
            observersContext,
        );

        // Then finish the stage
        await observer.onStageFinish(
            'TestStage',
            context as CodeReviewPipelineContext,
            observersContext,
        );

        expect(mockPipelineCheckService.updateCheck).toHaveBeenCalledWith(
            observersContext,
            context,
            'TestStage',
            expect.anything(),
        );

        expect(
            mockAutomationExecutionService.updateStageLog,
        ).toHaveBeenCalledWith(
            'stage-log-uuid',
            expect.objectContaining({
                status: AutomationStatus.SUCCESS,
                message: '',
                finishedAt: expect.any(Date),
            }),
        );
    });

    it('should fallback to creating new log on finish if log ID missing in map', async () => {
        // We do NOT call onStageStart, so the map is empty

        await observer.onStageFinish(
            'TestStage',
            context as CodeReviewPipelineContext,
            observersContext,
        );

        expect(
            mockAutomationExecutionService.updateCodeReview,
        ).toHaveBeenCalledWith(
            expect.objectContaining({
                uuid: 'exec-1',
            }),
            expect.objectContaining({ status: AutomationStatus.SUCCESS }),
            '',
            'TestStage',
            undefined,
        );
        expect(
            mockAutomationExecutionService.updateStageLog,
        ).not.toHaveBeenCalled();
    });

    it('should update stage log on error using ID from map', async () => {
        // Start to populate map
        await observer.onStageStart(
            'TestStage',
            context as CodeReviewPipelineContext,
            observersContext,
        );

        await observer.onStageError(
            'TestStage',
            new Error('Boom'),
            context as CodeReviewPipelineContext,
            observersContext,
        );

        expect(
            mockAutomationExecutionService.updateStageLog,
        ).toHaveBeenCalledWith(
            'stage-log-uuid',
            expect.objectContaining({
                status: AutomationStatus.ERROR,
                message: 'Boom',
                finishedAt: expect.any(Date),
            }),
        );
    });

    it('should update stage log on skipped using ID from map', async () => {
        // Start to populate map
        await observer.onStageStart(
            'TestStage',
            context as CodeReviewPipelineContext,
            observersContext,
        );

        await observer.onStageSkipped(
            'TestStage',
            'Some reason',
            context as CodeReviewPipelineContext,
            observersContext,
        );

        expect(
            mockAutomationExecutionService.updateStageLog,
        ).toHaveBeenCalledWith(
            'stage-log-uuid',
            expect.objectContaining({
                status: AutomationStatus.SKIPPED,
                message: 'Some reason',
                finishedAt: expect.any(Date),
            }),
        );
    });

    it('should handle multiple stages sequentially', async () => {
        const stage1Mock = {
            execution: { uuid: 'exec-uuid' },
            stageLog: { uuid: 'stage-log-1' },
        };
        const stage2Mock = {
            execution: { uuid: 'exec-uuid' },
            stageLog: { uuid: 'stage-log-2' },
        };

        mockAutomationExecutionService.updateCodeReview
            .mockResolvedValueOnce(stage1Mock as any)
            .mockResolvedValueOnce(stage2Mock as any);

        mockAutomationExecutionService.findLatestStageLog
            .mockResolvedValueOnce(stage1Mock.stageLog as any)
            .mockResolvedValueOnce(stage2Mock.stageLog as any);

        // Stage 1 Start
        await observer.onStageStart(
            'Stage1',
            context as CodeReviewPipelineContext,
            observersContext,
        );

        // Stage 1 Finish
        await observer.onStageFinish(
            'Stage1',
            context as CodeReviewPipelineContext,
            observersContext,
        );

        expect(
            mockAutomationExecutionService.updateStageLog,
        ).toHaveBeenLastCalledWith(
            'stage-log-1',
            expect.objectContaining({ message: '' }),
        );

        // Stage 2 Start
        await observer.onStageStart(
            'Stage2',
            context as CodeReviewPipelineContext,
            observersContext,
        );

        // Stage 2 Finish
        await observer.onStageFinish(
            'Stage2',
            context as CodeReviewPipelineContext,
            observersContext,
        );

        expect(
            mockAutomationExecutionService.updateStageLog,
        ).toHaveBeenLastCalledWith(
            'stage-log-2',
            expect.objectContaining({ message: '' }),
        );
    });

    it('should attempt to recover execution UUID if missing on stage finish', async () => {
        context.pipelineMetadata!.lastExecution = undefined;
        context.correlationId = undefined as any;
        // Mock recovery success
        mockAutomationExecutionService.findLatestExecutionByFilters.mockResolvedValue(
            {
                uuid: 'recovered-exec-uuid',
            } as any,
        );

        // Mock stage log found
        mockAutomationExecutionService.findLatestStageLog.mockResolvedValue({
            uuid: 'recovered-stage-log-uuid',
        } as any);

        await observer.onStageFinish(
            'TestStage',
            context as CodeReviewPipelineContext,
            observersContext,
        );

        // Verify recovery attempt
        expect(
            mockAutomationExecutionService.findLatestExecutionByFilters,
        ).toHaveBeenCalledWith({
            pullRequestNumber: 123,
            repositoryId: 'repo-1',
            status: AutomationStatus.IN_PROGRESS,
        });

        // Verify it used the recovered UUID to find the stage log
        expect(
            mockAutomationExecutionService.findLatestStageLog,
        ).toHaveBeenCalledWith('recovered-exec-uuid', 'TestStage');

        // Verify it updated the stage log
        expect(
            mockAutomationExecutionService.updateStageLog,
        ).toHaveBeenCalledWith(
            'recovered-stage-log-uuid',
            expect.objectContaining({
                status: AutomationStatus.SUCCESS,
                message: '',
            }),
        );
    });

    it('should fallback to default behavior if recovery fails', async () => {
        context.pipelineMetadata!.lastExecution = undefined;
        context.correlationId = undefined as any;
        // Mock recovery failure
        mockAutomationExecutionService.findLatestExecutionByFilters.mockResolvedValue(
            null,
        );

        await observer.onStageFinish(
            'TestStage',
            context as CodeReviewPipelineContext,
            observersContext,
        );

        // Verify recovery attempt
        expect(
            mockAutomationExecutionService.findLatestExecutionByFilters,
        ).toHaveBeenCalled();

        // Verify it did NOT try to find stage log (since no UUID recovered)
        expect(
            mockAutomationExecutionService.findLatestStageLog,
        ).not.toHaveBeenCalled();

        // Verify fallback to updateCodeReview
        expect(
            mockAutomationExecutionService.updateCodeReview,
        ).toHaveBeenCalledWith(
            expect.objectContaining({
                pullRequestNumber: 123,
                repositoryId: 'repo-1',
            }),
            expect.objectContaining({ status: AutomationStatus.SUCCESS }),
            '',
            'TestStage',
            undefined,
        );
    });

    it('should use correlationId as executionUuid when it is a valid UUID', async () => {
        // The observer only falls back to correlationId when it looks like
        // a real UUID — the CLI generates `corr_xxxx` strings that would
        // otherwise break uuid-typed DB queries.
        context.pipelineMetadata!.lastExecution = undefined;
        context.correlationId = 'a1b2c3d4-e5f6-7890-abcd-ef0123456789';

        await observer.onStageStart(
            'TestStage',
            context as CodeReviewPipelineContext,
            observersContext,
        );

        expect(
            mockAutomationExecutionService.updateCodeReview,
        ).toHaveBeenCalledWith(
            expect.objectContaining({
                uuid: 'a1b2c3d4-e5f6-7890-abcd-ef0123456789',
            }),
            expect.objectContaining({ status: AutomationStatus.IN_PROGRESS }),
            'Starting...',
            'TestStage',
            undefined,
        );
    });

    it('should fall back to pullRequestNumber/repositoryId when correlationId is not a UUID', async () => {
        // CLI-generated correlation ids like `corr_xxxx` must NOT be used as
        // executionUuid — they break uuid-typed DB queries. The observer
        // should fall back to the pr/repo composite filter instead.
        context.pipelineMetadata!.lastExecution = undefined;
        context.correlationId = 'corr_blrboR3jgLQ5_mnumj6d9';

        await observer.onStageStart(
            'TestStage',
            context as CodeReviewPipelineContext,
            observersContext,
        );

        expect(
            mockAutomationExecutionService.updateCodeReview,
        ).toHaveBeenCalledWith(
            expect.objectContaining({
                pullRequestNumber: 123,
                repositoryId: 'repo-1',
            }),
            expect.objectContaining({ status: AutomationStatus.IN_PROGRESS }),
            'Starting...',
            'TestStage',
            undefined,
        );
    });

    it('should log stage as PARTIAL_ERROR if context has errors with severity=partial for the stage', async () => {
        // severity is required to disambiguate partial-vs-critical at the
        // stage level — matches deriveFinalStatus in automationCodeReview.ts
        // so the per-stage badge and the automation rollup agree. Without
        // explicit severity, the default is 'critical' (per PipelineErrorSeverity)
        // and the stage maps to ERROR.
        context.errors = [
            {
                stage: 'TestStage',
                error: new Error('Partial error'),
                severity: 'partial',
            } as any,
        ];

        // Start stage to populate map
        await observer.onStageStart(
            'TestStage',
            context as CodeReviewPipelineContext,
            observersContext,
        );

        // Finish stage
        await observer.onStageFinish(
            'TestStage',
            context as CodeReviewPipelineContext,
            observersContext,
        );

        expect(
            mockAutomationExecutionService.updateStageLog,
        ).toHaveBeenCalledWith(
            'stage-log-uuid',
            expect.objectContaining({
                status: AutomationStatus.PARTIAL_ERROR,
                message: 'Partial error',
                finishedAt: expect.any(Date),
                metadata: expect.objectContaining({
                    partialErrors: expect.arrayContaining([
                        expect.objectContaining({
                            message: 'Partial error',
                        }),
                    ]),
                }),
            }),
        );
    });

    describe('error message propagation to code_review_execution', () => {
        it('should save actual error message for FileAnalysisStage (e.g. LLM rate limit)', async () => {
            const llmError =
                '429 Insufficient balance or no resource package. Please recharge.';
            context.errors = [
                {
                    stage: 'FileAnalysisStage',
                    substage: 'src/app.ts',
                    error: new Error(llmError),
                    metadata: { filename: 'src/app.ts' },
                },
            ];
            context.changedFiles = [{ filename: 'src/app.ts' }] as any;

            await observer.onStageStart(
                'FileAnalysisStage',
                context as CodeReviewPipelineContext,
                observersContext,
            );

            await observer.onStageFinish(
                'FileAnalysisStage',
                context as CodeReviewPipelineContext,
                observersContext,
            );

            expect(
                mockAutomationExecutionService.updateStageLog,
            ).toHaveBeenCalledWith(
                'stage-log-uuid',
                expect.objectContaining({
                    status: AutomationStatus.ERROR,
                    message: llmError,
                }),
            );
        });

        it('should save actual error message for ProcessFilesPrLevelReviewStage', async () => {
            context.errors = [
                {
                    stage: 'ProcessFilesPrLevelReviewStage',
                    substage: 'kody-rules',
                    error: new Error('Timeout waiting for LLM response'),
                    // kody-rules failure is auxiliary — the main review
                    // still has value, so the stage degrades partially.
                    severity: 'partial',
                },
            ];

            await observer.onStageStart(
                'ProcessFilesPrLevelReviewStage',
                context as CodeReviewPipelineContext,
                observersContext,
            );

            await observer.onStageFinish(
                'ProcessFilesPrLevelReviewStage',
                context as CodeReviewPipelineContext,
                observersContext,
            );

            expect(
                mockAutomationExecutionService.updateStageLog,
            ).toHaveBeenCalledWith(
                'stage-log-uuid',
                expect.objectContaining({
                    status: AutomationStatus.PARTIAL_ERROR,
                    message: 'Timeout waiting for LLM response',
                }),
            );
        });

        it('should save actual error message for FinishCommentsStage', async () => {
            context.errors = [
                {
                    stage: 'FinishCommentsStage',
                    substage: 'resolve-comment',
                    error: new Error('GitHub API rate limit exceeded'),
                    // Posting comments fails but the review itself
                    // completed — partial degradation, not a critical
                    // failure of the review.
                    severity: 'partial',
                },
            ];

            await observer.onStageStart(
                'FinishCommentsStage',
                context as CodeReviewPipelineContext,
                observersContext,
            );

            await observer.onStageFinish(
                'FinishCommentsStage',
                context as CodeReviewPipelineContext,
                observersContext,
            );

            expect(
                mockAutomationExecutionService.updateStageLog,
            ).toHaveBeenCalledWith(
                'stage-log-uuid',
                expect.objectContaining({
                    status: AutomationStatus.PARTIAL_ERROR,
                    message: 'GitHub API rate limit exceeded',
                }),
            );
        });

        it('should deduplicate repeated errors and show unique messages only', async () => {
            const repeatedError =
                '429 Insufficient balance or no resource package. Please recharge.';
            context.errors = [
                {
                    stage: 'FileAnalysisStage',
                    substage: 'src/file1.ts',
                    error: new Error(repeatedError),
                    metadata: { filename: 'src/file1.ts' },
                },
                {
                    stage: 'FileAnalysisStage',
                    substage: 'src/file2.ts',
                    error: new Error(repeatedError),
                    metadata: { filename: 'src/file2.ts' },
                },
                {
                    stage: 'FileAnalysisStage',
                    substage: 'src/file3.ts',
                    error: new Error(repeatedError),
                    metadata: { filename: 'src/file3.ts' },
                },
            ];
            context.changedFiles = [
                { filename: 'src/file1.ts' },
                { filename: 'src/file2.ts' },
                { filename: 'src/file3.ts' },
            ] as any;

            await observer.onStageStart(
                'FileAnalysisStage',
                context as CodeReviewPipelineContext,
                observersContext,
            );

            await observer.onStageFinish(
                'FileAnalysisStage',
                context as CodeReviewPipelineContext,
                observersContext,
            );

            expect(
                mockAutomationExecutionService.updateStageLog,
            ).toHaveBeenCalledWith(
                'stage-log-uuid',
                expect.objectContaining({
                    message: `${repeatedError}`,
                }),
            );
        });

        it('should show up to 3 unique errors separated by pipe and indicate remaining count', async () => {
            context.errors = [
                {
                    stage: 'FileAnalysisStage',
                    substage: 'src/a.ts',
                    error: new Error('Error type A'),
                    metadata: { filename: 'src/a.ts' },
                },
                {
                    stage: 'FileAnalysisStage',
                    substage: 'src/b.ts',
                    error: new Error('Error type B'),
                    metadata: { filename: 'src/b.ts' },
                },
                {
                    stage: 'FileAnalysisStage',
                    substage: 'src/c.ts',
                    error: new Error('Error type C'),
                    metadata: { filename: 'src/c.ts' },
                },
                {
                    stage: 'FileAnalysisStage',
                    substage: 'src/d.ts',
                    error: new Error('Error type D'),
                    metadata: { filename: 'src/d.ts' },
                },
                {
                    stage: 'FileAnalysisStage',
                    substage: 'src/e.ts',
                    error: new Error('Error type E'),
                    metadata: { filename: 'src/e.ts' },
                },
            ];
            context.changedFiles = [
                { filename: 'src/a.ts' },
                { filename: 'src/b.ts' },
                { filename: 'src/c.ts' },
                { filename: 'src/d.ts' },
                { filename: 'src/e.ts' },
            ] as any;

            await observer.onStageStart(
                'FileAnalysisStage',
                context as CodeReviewPipelineContext,
                observersContext,
            );

            await observer.onStageFinish(
                'FileAnalysisStage',
                context as CodeReviewPipelineContext,
                observersContext,
            );

            expect(
                mockAutomationExecutionService.updateStageLog,
            ).toHaveBeenCalledWith(
                'stage-log-uuid',
                expect.objectContaining({
                    message:
                        'Error type A\nError type B\nError type C\n(+2 more)',
                }),
            );
        });

        it('should keep message empty when stage finishes without errors', async () => {
            context.errors = [];

            await observer.onStageStart(
                'FileAnalysisStage',
                context as CodeReviewPipelineContext,
                observersContext,
            );

            await observer.onStageFinish(
                'FileAnalysisStage',
                context as CodeReviewPipelineContext,
                observersContext,
            );

            expect(
                mockAutomationExecutionService.updateStageLog,
            ).toHaveBeenCalledWith(
                'stage-log-uuid',
                expect.objectContaining({
                    status: AutomationStatus.SUCCESS,
                    message: '',
                }),
            );
        });
    });

    it('should include visibility in metadata on stage finish', async () => {
        await observer.onStageStart(
            'TestStage',
            context as CodeReviewPipelineContext,
            observersContext,
        );

        await observer.onStageFinish(
            'TestStage',
            context as CodeReviewPipelineContext,
            observersContext,
            { visibility: StageVisibility.PRIMARY },
        );

        expect(
            mockAutomationExecutionService.updateStageLog,
        ).toHaveBeenCalledWith(
            'stage-log-uuid',
            expect.objectContaining({
                metadata: expect.objectContaining({
                    visibility: StageVisibility.PRIMARY,
                }),
            }),
        );
    });

    it('should include visibility in metadata on stage error', async () => {
        await observer.onStageStart(
            'TestStage',
            context as CodeReviewPipelineContext,
            observersContext,
        );

        await observer.onStageError(
            'TestStage',
            new Error('Boom'),
            context as CodeReviewPipelineContext,
            observersContext,
            { visibility: StageVisibility.INTERNAL },
        );

        expect(
            mockAutomationExecutionService.updateStageLog,
        ).toHaveBeenCalledWith(
            'stage-log-uuid',
            expect.objectContaining({
                metadata: expect.objectContaining({
                    visibility: StageVisibility.INTERNAL,
                }),
            }),
        );
    });

    it('should include visibility in metadata on stage skipped', async () => {
        await observer.onStageStart(
            'TestStage',
            context as CodeReviewPipelineContext,
            observersContext,
        );

        await observer.onStageSkipped(
            'TestStage',
            'Reason',
            context as CodeReviewPipelineContext,
            observersContext,
            { visibility: StageVisibility.PRIMARY },
        );

        expect(
            mockAutomationExecutionService.updateStageLog,
        ).toHaveBeenCalledWith(
            'stage-log-uuid',
            expect.objectContaining({
                metadata: expect.objectContaining({
                    visibility: StageVisibility.PRIMARY,
                }),
            }),
        );
    });

    it('should include ignoredFiles in metadata on stage finish if present in context', async () => {
        context.ignoredFiles = Array.from(
            { length: 60 },
            (_, i) => `file-${i}.ts`,
        );

        await observer.onStageStart(
            'FetchChangedFilesStage',
            context as CodeReviewPipelineContext,
            observersContext,
        );

        await observer.onStageFinish(
            'FetchChangedFilesStage',
            context as CodeReviewPipelineContext,
            observersContext,
        );

        expect(
            mockAutomationExecutionService.updateStageLog,
        ).toHaveBeenCalledWith(
            'stage-log-uuid',
            expect.objectContaining({
                metadata: expect.objectContaining({
                    ignoredFiles: expect.arrayContaining([
                        'file-0.ts',
                        'file-49.ts',
                    ]),
                }),
            }),
        );

        // Verify truncation
        const callArgs =
            mockAutomationExecutionService.updateStageLog.mock.calls[0];
        const metadata = callArgs[1].metadata;
        expect(metadata.ignoredFiles).toHaveLength(50);
        expect(metadata.ignoredFiles).not.toContain('file-50.ts');
    });

    it('should include ignoredFiles in metadata on stage skipped if present in context', async () => {
        context.ignoredFiles = ['ignored-file.ts'];

        await observer.onStageStart(
            'FetchChangedFilesStage',
            context as CodeReviewPipelineContext,
            observersContext,
        );

        await observer.onStageSkipped(
            'FetchChangedFilesStage',
            'All files ignored',
            context as CodeReviewPipelineContext,
            observersContext,
        );

        expect(
            mockAutomationExecutionService.updateStageLog,
        ).toHaveBeenCalledWith(
            'stage-log-uuid',
            expect.objectContaining({
                status: AutomationStatus.SKIPPED,
                metadata: expect.objectContaining({
                    ignoredFiles: ['ignored-file.ts'],
                }),
            }),
        );
    });
});
