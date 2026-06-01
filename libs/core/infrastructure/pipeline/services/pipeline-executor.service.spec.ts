import { AutomationStatus } from '@libs/automation/domain/automation/enum/automation-status';
import { PipelineContext } from '../interfaces/pipeline-context.interface';
import { IPipelineObserver } from '../interfaces/pipeline-observer.interface';
import { PipelineStage } from '../interfaces/pipeline.interface';
import { PipelineExecutor } from './pipeline-executor.service';

describe('PipelineExecutor', () => {
    let executor: PipelineExecutor<PipelineContext>;
    let mockObserver: jest.Mocked<IPipelineObserver>;
    let mockStage: jest.Mocked<PipelineStage<PipelineContext>>;

    beforeEach(() => {
        executor = new PipelineExecutor();
        mockObserver = {
            onStageStart: jest.fn().mockResolvedValue(undefined),
            onStageFinish: jest.fn().mockResolvedValue(undefined),
            onStageError: jest.fn().mockResolvedValue(undefined),
            onStageSkipped: jest.fn().mockResolvedValue(undefined),
            onPipelineFinish: jest.fn().mockResolvedValue(undefined),
            onPipelineStart: jest.fn().mockResolvedValue(undefined),
        };
        mockStage = {
            stageName: 'TestStage',
            execute: jest.fn(),
        } as any;
    });

    it('should notify observer on stage start and finish', async () => {
        const context: PipelineContext = {
            statusInfo: { status: AutomationStatus.IN_PROGRESS },
            errors: [],
        } as any;

        mockStage.execute.mockResolvedValue(context);

        await executor.execute(
            context,
            [mockStage],
            'TestPipeline',
            undefined,
            undefined,
            [mockObserver],
        );

        expect(mockObserver.onStageStart).toHaveBeenCalledWith(
            'TestStage',
            expect.anything(),
            expect.anything(),
            expect.anything(),
        );
        expect(mockObserver.onStageFinish).toHaveBeenCalledWith(
            'TestStage',
            expect.anything(),
            expect.anything(),
            expect.anything(),
        );
    });

    it('should notify observer on stage error', async () => {
        const context: PipelineContext = {
            statusInfo: { status: AutomationStatus.IN_PROGRESS },
            errors: [],
        } as any;

        const error = new Error('Stage Failed');
        mockStage.execute.mockRejectedValue(error);

        const result = await executor.execute(
            context,
            [mockStage],
            'TestPipeline',
            undefined,
            undefined,
            [mockObserver],
        );

        expect(mockObserver.onStageStart).toHaveBeenCalled();
        expect(mockObserver.onStageError).toHaveBeenCalledWith(
            'TestStage',
            error,
            expect.anything(),
            expect.anything(),
            expect.anything(),
        );
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]).toEqual(
            expect.objectContaining({
                stage: 'TestStage',
                substage: 'StageExecution',
                error,
            }),
        );
    });

    it('should notify observer on stage skipped', async () => {
        const context: PipelineContext = {
            statusInfo: {
                status: AutomationStatus.SKIPPED,
                jumpToStage: 'AnotherStage',
            },
            errors: [],
        } as any;

        mockStage.stageName = 'TestStage'; // Not the target
        // execute should not be called

        await executor.execute(
            context,
            [mockStage],
            'TestPipeline',
            undefined,
            undefined,
            [mockObserver],
        );

        expect(mockObserver.onStageSkipped).not.toHaveBeenCalled();
    });

    describe('skipStages list (skip by name)', () => {
        function makeStage(
            name: string,
        ): jest.Mocked<PipelineStage<PipelineContext>> {
            return {
                stageName: name,
                execute: jest.fn(async (ctx) => ctx),
            } as any;
        }

        it('bypasses stages whose names are in statusInfo.skipStages', async () => {
            const context: PipelineContext = {
                statusInfo: {
                    status: AutomationStatus.IN_PROGRESS,
                    skipStages: ['StageB'],
                },
                errors: [],
            } as any;
            const stageA = makeStage('StageA');
            const stageB = makeStage('StageB');
            const stageC = makeStage('StageC');

            await executor.execute(context, [stageA, stageB, stageC]);

            expect(stageA.execute).toHaveBeenCalledTimes(1);
            expect(stageB.execute).not.toHaveBeenCalled();
            expect(stageC.execute).toHaveBeenCalledTimes(1);
        });

        it('keeps the pipeline IN_PROGRESS — skipStages is independent of SKIPPED status', async () => {
            const context: PipelineContext = {
                statusInfo: {
                    status: AutomationStatus.IN_PROGRESS,
                    skipStages: ['StageB'],
                },
                errors: [],
            } as any;
            const stageA = makeStage('StageA');
            const stageB = makeStage('StageB');
            const stageC = makeStage('StageC');

            const result = await executor.execute(
                context,
                [stageA, stageB, stageC],
            );

            expect(result.statusInfo.status).toBe(
                AutomationStatus.IN_PROGRESS,
            );
        });

        it('bypasses multiple named stages in one run', async () => {
            const context: PipelineContext = {
                statusInfo: {
                    status: AutomationStatus.IN_PROGRESS,
                    skipStages: ['StageA', 'StageC'],
                },
                errors: [],
            } as any;
            const stageA = makeStage('StageA');
            const stageB = makeStage('StageB');
            const stageC = makeStage('StageC');

            await executor.execute(context, [stageA, stageB, stageC]);

            expect(stageA.execute).not.toHaveBeenCalled();
            expect(stageB.execute).toHaveBeenCalledTimes(1);
            expect(stageC.execute).not.toHaveBeenCalled();
        });

        it('honors entries added to skipStages by an earlier stage at runtime', async () => {
            const context: PipelineContext = {
                statusInfo: { status: AutomationStatus.IN_PROGRESS },
                errors: [],
            } as any;
            const stageA = makeStage('StageA');
            stageA.execute.mockImplementation(async (ctx) => ({
                ...ctx,
                statusInfo: {
                    ...ctx.statusInfo,
                    skipStages: ['StageC'],
                },
            }));
            const stageB = makeStage('StageB');
            const stageC = makeStage('StageC');
            const stageD = makeStage('StageD');

            await executor.execute(context, [stageA, stageB, stageC, stageD]);

            expect(stageA.execute).toHaveBeenCalled();
            expect(stageB.execute).toHaveBeenCalled();
            expect(stageC.execute).not.toHaveBeenCalled();
            expect(stageD.execute).toHaveBeenCalled();
        });

        it('does not notify observers for bypassed stages (matches existing fast-forward convention)', async () => {
            const context: PipelineContext = {
                statusInfo: {
                    status: AutomationStatus.IN_PROGRESS,
                    skipStages: ['StageB'],
                },
                errors: [],
            } as any;
            const stageA = makeStage('StageA');
            const stageB = makeStage('StageB');

            await executor.execute(
                context,
                [stageA, stageB],
                'TestPipeline',
                undefined,
                undefined,
                [mockObserver],
            );

            expect(mockObserver.onStageStart).toHaveBeenCalledTimes(1);
            expect(mockObserver.onStageStart).not.toHaveBeenCalledWith(
                'StageB',
                expect.anything(),
                expect.anything(),
                expect.anything(),
            );
            expect(mockObserver.onStageSkipped).not.toHaveBeenCalled();
        });
    });

    describe('silent stages (UI-invisible internal stages)', () => {
        function makeStage(
            name: string,
            silent: boolean,
        ): jest.Mocked<PipelineStage<PipelineContext>> {
            return {
                stageName: name,
                silent,
                execute: jest.fn(async (ctx) => ctx),
            } as any;
        }

        it('runs the silent stage but skips onStageStart/onStageFinish', async () => {
            const context: PipelineContext = {
                statusInfo: { status: AutomationStatus.IN_PROGRESS },
                errors: [],
            } as any;
            const silent = makeStage('SilentStage', true);

            await executor.execute(
                context,
                [silent],
                'TestPipeline',
                undefined,
                undefined,
                [mockObserver],
            );

            expect(silent.execute).toHaveBeenCalledTimes(1);
            expect(mockObserver.onStageStart).not.toHaveBeenCalled();
            expect(mockObserver.onStageFinish).not.toHaveBeenCalled();
        });

        it('skips onStageError for a silent stage that throws (but still records the error in context)', async () => {
            const context: PipelineContext = {
                statusInfo: { status: AutomationStatus.IN_PROGRESS },
                errors: [],
            } as any;
            const silent = makeStage('SilentStage', true);
            const boom = new Error('boom');
            silent.execute.mockRejectedValue(boom);

            const result = await executor.execute(
                context,
                [silent],
                'TestPipeline',
                undefined,
                undefined,
                [mockObserver],
            );

            expect(mockObserver.onStageError).not.toHaveBeenCalled();
            expect(result.errors).toHaveLength(1);
            expect(result.errors[0]).toEqual(
                expect.objectContaining({ stage: 'SilentStage', error: boom }),
            );
        });

        it('skips onStageSkipped for a silent stage that self-marks SKIPPED', async () => {
            const context: PipelineContext = {
                statusInfo: { status: AutomationStatus.IN_PROGRESS },
                errors: [],
            } as any;
            const silent = makeStage('SilentStage', true);
            silent.execute.mockImplementation(async (ctx) => ({
                ...ctx,
                statusInfo: { status: AutomationStatus.SKIPPED },
            }));

            await executor.execute(
                context,
                [silent],
                'TestPipeline',
                undefined,
                undefined,
                [mockObserver],
            );

            expect(mockObserver.onStageSkipped).not.toHaveBeenCalled();
            expect(mockObserver.onStageFinish).not.toHaveBeenCalled();
        });

        it('still fires pipeline-level events (onPipelineStart / onPipelineFinish) even when all stages are silent', async () => {
            const context: PipelineContext = {
                statusInfo: { status: AutomationStatus.IN_PROGRESS },
                errors: [],
            } as any;
            const silent = makeStage('SilentStage', true);

            await executor.execute(
                context,
                [silent],
                'TestPipeline',
                undefined,
                undefined,
                [mockObserver],
            );

            expect(mockObserver.onPipelineStart).toHaveBeenCalledTimes(1);
            expect(mockObserver.onPipelineFinish).toHaveBeenCalledTimes(1);
        });

        it('default (silent omitted) behaves as before — observer events fire', async () => {
            const context: PipelineContext = {
                statusInfo: { status: AutomationStatus.IN_PROGRESS },
                errors: [],
            } as any;
            // silent flag omitted → falsy → observer should be called
            const ordinary: jest.Mocked<PipelineStage<PipelineContext>> = {
                stageName: 'OrdinaryStage',
                execute: jest.fn(async (ctx) => ctx),
            } as any;

            await executor.execute(
                context,
                [ordinary],
                'TestPipeline',
                undefined,
                undefined,
                [mockObserver],
            );

            expect(mockObserver.onStageStart).toHaveBeenCalledTimes(1);
            expect(mockObserver.onStageFinish).toHaveBeenCalledTimes(1);
        });
    });
});
