import { createLogger } from '@libs/core/log/logger';
import { PlatformType } from '@libs/core/domain/enums';
import { Test, TestingModule } from '@nestjs/testing';
import {
    CheckConclusion,
    CheckStatus,
    IChecksAdapter,
} from '../interfaces/checks-adapter.interface';
import { ChecksAdapterFactory } from './checks-adapter.factory';
import {
    KODY_CHECK_RUN_NAME,
    PipelineChecksService,
    checkStageMap,
} from './pipeline-checks.service';

jest.mock('@libs/core/log/logger', () => ({
    createLogger: jest.fn().mockReturnValue({
        warn: jest.fn(),
        error: jest.fn(),
        info: jest.fn(),
    }),
}));

describe('PipelineChecksService', () => {
    let service: PipelineChecksService;
    let checksAdapterFactory: jest.Mocked<ChecksAdapterFactory>;
    let checksAdapter: jest.Mocked<IChecksAdapter>;
    let loggerMock: any;

    const mockObserverContext: any = {
        checkRunId: undefined,
    };

    const mockContext: any = {
        organizationAndTeamData: { org: 'test-org' },
        repository: { fullName: 'owner/repo' },
        pullRequest: { head: { sha: 'test-sha' } },
        platformType: PlatformType.GITHUB,
    };

    beforeEach(async () => {
        checksAdapter = {
            createCheckRun: jest.fn(),
            updateCheckRun: jest.fn(),
            findCheckRun: jest.fn().mockResolvedValue(null),
        } as any;

        checksAdapterFactory = {
            getAdapter: jest.fn().mockReturnValue(checksAdapter),
        } as any;

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                PipelineChecksService,
                {
                    provide: ChecksAdapterFactory,
                    useValue: checksAdapterFactory,
                },
            ],
        }).compile();

        service = module.get<PipelineChecksService>(PipelineChecksService);
        loggerMock = (createLogger as jest.Mock)();

        // Reset state
        mockObserverContext.checkRunId = undefined;
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    describe('startCheck', () => {
        it('should create a check run and set checkRunId on success', async () => {
            const stageName = '_pipelineStart';
            checksAdapter.createCheckRun.mockResolvedValue('new-check-id');

            await service.startCheck(
                mockObserverContext,
                mockContext,
                stageName,
            );

            expect(checksAdapter.createCheckRun).toHaveBeenCalledWith({
                organizationAndTeamData: mockContext.organizationAndTeamData,
                repository: { owner: 'owner', name: 'repo' },
                headSha: 'test-sha',
                status: CheckStatus.IN_PROGRESS,
                name: KODY_CHECK_RUN_NAME,
                output: {
                    title: checkStageMap[stageName].title,
                    summary: checkStageMap[stageName].summary,
                },
            });
            expect(mockObserverContext.checkRunId).toBe('new-check-id');
        });

        it('should reuse an existing check run for the same commit instead of creating a new one', async () => {
            const stageName = '_pipelineStart';
            checksAdapter.findCheckRun.mockResolvedValue('existing-check-id');
            checksAdapter.updateCheckRun.mockResolvedValue(true);

            await service.startCheck(
                mockObserverContext,
                mockContext,
                stageName,
            );

            expect(checksAdapter.findCheckRun).toHaveBeenCalledWith({
                organizationAndTeamData: mockContext.organizationAndTeamData,
                repository: { owner: 'owner', name: 'repo' },
                headSha: 'test-sha',
                name: KODY_CHECK_RUN_NAME,
            });
            expect(checksAdapter.updateCheckRun).toHaveBeenCalledWith({
                checkRunId: 'existing-check-id',
                organizationAndTeamData: mockContext.organizationAndTeamData,
                repository: { owner: 'owner', name: 'repo' },
                status: CheckStatus.IN_PROGRESS,
                output: {
                    title: checkStageMap[stageName].title,
                    summary: checkStageMap[stageName].summary,
                },
            });
            expect(checksAdapter.createCheckRun).not.toHaveBeenCalled();
            expect(mockObserverContext.checkRunId).toBe('existing-check-id');
        });

        it('should fall back to creating a check run when reusing fails', async () => {
            checksAdapter.findCheckRun.mockResolvedValue('existing-check-id');
            checksAdapter.updateCheckRun.mockResolvedValue(false);
            checksAdapter.createCheckRun.mockResolvedValue('new-check-id');

            await service.startCheck(
                mockObserverContext,
                mockContext,
                '_pipelineStart',
            );

            expect(checksAdapter.createCheckRun).toHaveBeenCalled();
            expect(mockObserverContext.checkRunId).toBe('new-check-id');
        });

        it('should log warning if missing head SHA', async () => {
            const invalidContext = {
                ...mockContext,
                pullRequest: { head: {} },
            };
            await service.startCheck(
                mockObserverContext,
                invalidContext,
                '_pipelineStart',
            );

            expect(loggerMock.warn).toHaveBeenCalledWith(
                expect.objectContaining({
                    message: 'No head SHA found in pull request context',
                }),
            );
            expect(checksAdapter.createCheckRun).not.toHaveBeenCalled();
        });

        it('should log warning if invalid repo format', async () => {
            const invalidContext = {
                ...mockContext,
                repository: { fullName: 'invalid' },
            };
            await service.startCheck(
                mockObserverContext,
                invalidContext,
                '_pipelineStart',
            );

            expect(loggerMock.warn).toHaveBeenCalledWith(
                expect.objectContaining({
                    message: 'Invalid repository full name format',
                }),
            );
            expect(checksAdapter.createCheckRun).not.toHaveBeenCalled();
        });

        it('should log warning if missing adapter', async () => {
            checksAdapterFactory.getAdapter.mockReturnValue(null as any);
            await service.startCheck(
                mockObserverContext,
                mockContext,
                '_pipelineStart',
            );

            expect(loggerMock.warn).toHaveBeenCalledWith(
                expect.objectContaining({
                    message: expect.stringContaining('No checks adapter found'),
                }),
            );
        });

        it('should log error if adapter throws', async () => {
            checksAdapter.createCheckRun.mockRejectedValue(
                new Error('Adapter error'),
            );
            await service.startCheck(
                mockObserverContext,
                mockContext,
                '_pipelineStart',
            );

            expect(loggerMock.error).toHaveBeenCalledWith(
                expect.objectContaining({
                    message: 'Failed to start check',
                }),
            );
        });

        it('should finalize existing check if checkRunId exists', async () => {
            mockObserverContext.checkRunId = 'existing-id';
            const finalizeSpy = jest
                .spyOn(service, 'finalizeCheck')
                .mockResolvedValue(undefined);
            checksAdapter.createCheckRun.mockResolvedValue('new-id');

            await service.startCheck(
                mockObserverContext,
                mockContext,
                '_pipelineStart',
            );

            expect(finalizeSpy).toHaveBeenCalledWith(
                mockObserverContext,
                mockContext,
                CheckConclusion.SUCCESS,
            );
            expect(checksAdapter.createCheckRun).toHaveBeenCalled();
            expect(mockObserverContext.checkRunId).toBe('new-id');
        });
    });

    describe('updateCheck', () => {
        beforeEach(() => {
            mockObserverContext.checkRunId = '123';
        });

        it('should call updateCheckRun on success', async () => {
            const stageName = '_pipelineStart';
            await service.updateCheck(
                mockObserverContext,
                mockContext,
                stageName,
                CheckStatus.IN_PROGRESS,
            );

            expect(checksAdapter.updateCheckRun).toHaveBeenCalledWith({
                checkRunId: '123',
                organizationAndTeamData: mockContext.organizationAndTeamData,
                repository: { owner: 'owner', name: 'repo' },
                status: CheckStatus.IN_PROGRESS,
                output: {
                    title: checkStageMap[stageName].title,
                    summary: checkStageMap[stageName].summary,
                },
                conclusion: undefined,
            });
        });

        it('should log warning if missing checkRunId', async () => {
            mockObserverContext.checkRunId = undefined;
            await service.updateCheck(
                mockObserverContext,
                mockContext,
                '_pipelineStart',
                CheckStatus.IN_PROGRESS,
            );

            expect(loggerMock.warn).toHaveBeenCalledWith(
                expect.objectContaining({
                    message: 'No checkRunId found in context for updateCheck',
                }),
            );
            expect(checksAdapter.updateCheckRun).not.toHaveBeenCalled();
        });

        it('should log warning if missing adapter', async () => {
            checksAdapterFactory.getAdapter.mockReturnValue(null as any);
            await service.updateCheck(
                mockObserverContext,
                mockContext,
                '_pipelineStart',
                CheckStatus.IN_PROGRESS,
            );

            expect(loggerMock.warn).toHaveBeenCalledWith(
                expect.objectContaining({
                    message: expect.stringContaining('No checks adapter found'),
                }),
            );
        });

        it('should do nothing if invalid stage', async () => {
            await service.updateCheck(
                mockObserverContext,
                mockContext,
                'INVALID_STAGE',
                CheckStatus.IN_PROGRESS,
            );
            expect(checksAdapter.updateCheckRun).not.toHaveBeenCalled();
        });

        it('should log error if adapter throws', async () => {
            checksAdapter.updateCheckRun.mockRejectedValue(
                new Error('Update error'),
            );
            await service.updateCheck(
                mockObserverContext,
                mockContext,
                '_pipelineStart',
                CheckStatus.IN_PROGRESS,
            );

            expect(loggerMock.error).toHaveBeenCalledWith(
                expect.objectContaining({
                    message: 'Failed to update check',
                }),
            );
        });
    });

    describe('finalizeCheck', () => {
        beforeEach(() => {
            mockObserverContext.checkRunId = '123';
        });

        it('should include failure details from pipeline errors when finishing with _pipelineEndFailure', async () => {
            const contextWithFailureDetails = {
                ...mockContext,
                statusInfo: {
                    status: 'ERROR',
                    message: 'Code review failed',
                },
                errors: [
                    {
                        stage: 'FileAnalysisStage',
                        substage: 'src/app/service.ts',
                        error: new Error(
                            'MODEL_NOT_FOUND: hf:zai-org/GLM-4.6 is no longer supported',
                        ),
                    },
                ],
            };

            await service.finalizeCheck(
                mockObserverContext,
                contextWithFailureDetails,
                CheckConclusion.FAILURE,
                '_pipelineEndFailure',
            );

            expect(checksAdapter.updateCheckRun).toHaveBeenCalledWith(
                expect.objectContaining({
                    checkRunId: '123',
                    status: CheckStatus.COMPLETED,
                    conclusion: CheckConclusion.FAILURE,
                    output: expect.objectContaining({
                        title: 'Code Review Failed',
                        summary: expect.stringContaining(
                            'MODEL_NOT_FOUND: hf:zai-org/GLM-4.6 is no longer supported',
                        ),
                    }),
                }),
            );
        });

        it('should replace generic failure reason with context-derived details', async () => {
            const contextWithFailureDetails = {
                ...mockContext,
                statusInfo: {
                    status: 'ERROR',
                    message: 'Code review failed',
                },
                errors: [
                    {
                        stage: 'FileAnalysisStage',
                        substage: 'src/app/service.ts',
                        error: new Error('400 status code (no body)'),
                    },
                ],
            };

            await service.finalizeCheck(
                mockObserverContext,
                contextWithFailureDetails,
                CheckConclusion.FAILURE,
                '_pipelineEndFailure',
                'An error occurred during the review. Please check the logs for details.',
            );

            expect(checksAdapter.updateCheckRun).toHaveBeenCalledWith(
                expect.objectContaining({
                    checkRunId: '123',
                    status: CheckStatus.COMPLETED,
                    conclusion: CheckConclusion.FAILURE,
                    output: expect.objectContaining({
                        title: 'Code Review Failed',
                        summary: expect.stringContaining(
                            '400 status code (no body)',
                        ),
                    }),
                }),
            );
        });

        it('should call updateCheckRun with COMPLETED status and clear checkRunId', async () => {
            await service.finalizeCheck(
                mockObserverContext,
                mockContext,
                CheckConclusion.SUCCESS,
            );

            expect(checksAdapter.updateCheckRun).toHaveBeenCalledWith(
                expect.objectContaining({
                    checkRunId: '123',
                    status: CheckStatus.COMPLETED,
                    conclusion: CheckConclusion.SUCCESS,
                }),
            );
            expect(mockObserverContext.checkRunId).toBeUndefined();
        });

        it('should log warning if missing checkRunId', async () => {
            mockObserverContext.checkRunId = undefined;
            await service.finalizeCheck(
                mockObserverContext,
                mockContext,
                CheckConclusion.SUCCESS,
            );

            expect(loggerMock.warn).toHaveBeenCalledWith(
                expect.objectContaining({
                    message: 'No checkRunId found in context for finalizeCheck',
                }),
            );
        });

        it('should log warning if missing adapter', async () => {
            checksAdapterFactory.getAdapter.mockReturnValue(null as any);
            await service.finalizeCheck(
                mockObserverContext,
                mockContext,
                CheckConclusion.SUCCESS,
            );

            expect(loggerMock.warn).toHaveBeenCalledWith(
                expect.objectContaining({
                    message: expect.stringContaining('No checks adapter found'),
                }),
            );
        });

        it('should log error if adapter throws', async () => {
            checksAdapter.updateCheckRun.mockRejectedValue(
                new Error('Finalize error'),
            );
            await service.finalizeCheck(
                mockObserverContext,
                mockContext,
                CheckConclusion.SUCCESS,
            );

            expect(loggerMock.error).toHaveBeenCalledWith(
                expect.objectContaining({
                    message: 'Failed to finalize check',
                }),
            );
        });
    });
});
