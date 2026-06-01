import { AutomationStatus } from '@libs/automation/domain/automation/enum/automation-status';
import { PipelineContext } from '../interfaces/pipeline-context.interface';
import { BasePipelineStage } from './base-stage.abstract';

class TestStage extends BasePipelineStage<PipelineContext> {
    stageName = 'TestStage';

    protected async executeStage(
        context: PipelineContext,
    ): Promise<PipelineContext> {
        return context;
    }

    callSkipToStage(
        context: PipelineContext,
        stageName: string,
        message?: string,
    ): PipelineContext {
        return this.skipToStage(context, stageName, message);
    }

    callStopPipeline(
        context: PipelineContext,
        message?: string,
    ): PipelineContext {
        return this.stopPipeline(context, message);
    }

    callSkipStages(
        context: PipelineContext,
        names: string | string[],
        message?: string,
    ): PipelineContext {
        return this.skipStages(context, names, message);
    }
}

const baseContext = (): PipelineContext =>
    ({
        statusInfo: { status: AutomationStatus.IN_PROGRESS },
        pipelineVersion: '1.0',
        errors: [],
    }) as PipelineContext;

describe('BasePipelineStage helpers', () => {
    let stage: TestStage;

    beforeEach(() => {
        stage = new TestStage();
    });

    describe('skipToStage', () => {
        it('sets status SKIPPED and jumpToStage so the executor fast-forwards', () => {
            const result = stage.callSkipToStage(
                baseContext(),
                'AggregateResultsStage',
            );

            expect(result.statusInfo.status).toBe(AutomationStatus.SKIPPED);
            expect(result.statusInfo.jumpToStage).toBe('AggregateResultsStage');
        });

        it('attaches the optional message when provided', () => {
            const result = stage.callSkipToStage(
                baseContext(),
                'AggregateResultsStage',
                'directory disabled review',
            );

            expect(result.statusInfo.message).toBe('directory disabled review');
        });

        it('returns a new object (immutable update) without mutating the input', () => {
            const ctx = baseContext();
            const result = stage.callSkipToStage(ctx, 'Target');

            expect(result).not.toBe(ctx);
            expect(ctx.statusInfo.status).toBe(AutomationStatus.IN_PROGRESS);
            expect(ctx.statusInfo.jumpToStage).toBeUndefined();
        });

        it('preserves unrelated context fields', () => {
            const ctx = baseContext();
            ctx.errors = [
                { stage: 'Other', error: new Error('prior') },
            ];
            ctx.workflowJobId = 'job-1';

            const result = stage.callSkipToStage(ctx, 'Target');

            expect(result.errors).toHaveLength(1);
            expect(result.workflowJobId).toBe('job-1');
        });
    });

    describe('stopPipeline', () => {
        it('sets status SKIPPED without jumpToStage so the executor aborts', () => {
            const result = stage.callStopPipeline(baseContext());

            expect(result.statusInfo.status).toBe(AutomationStatus.SKIPPED);
            expect(result.statusInfo.jumpToStage).toBeUndefined();
        });

        it('attaches the optional message when provided', () => {
            const result = stage.callStopPipeline(baseContext(), 'no files');

            expect(result.statusInfo.message).toBe('no files');
        });

        it('clears any prior jumpToStage so a later stage cannot resume', () => {
            const ctx = baseContext();
            ctx.statusInfo.jumpToStage = 'SomeLeftoverTarget';

            const result = stage.callStopPipeline(ctx);

            expect(result.statusInfo.jumpToStage).toBeUndefined();
        });

        it('returns a new object (immutable update)', () => {
            const ctx = baseContext();
            const result = stage.callStopPipeline(ctx);

            expect(result).not.toBe(ctx);
            expect(ctx.statusInfo.status).toBe(AutomationStatus.IN_PROGRESS);
        });
    });

    describe('skipStages', () => {
        it('adds a single stage name to statusInfo.skipStages', () => {
            const result = stage.callSkipStages(baseContext(), 'StageB');

            expect(result.statusInfo.skipStages).toEqual(['StageB']);
        });

        it('adds multiple stage names from an array', () => {
            const result = stage.callSkipStages(baseContext(), [
                'StageB',
                'StageC',
            ]);

            expect(result.statusInfo.skipStages).toEqual(['StageB', 'StageC']);
        });

        it('keeps pipeline status IN_PROGRESS — bypass is independent of SKIPPED', () => {
            const result = stage.callSkipStages(baseContext(), 'StageB');

            expect(result.statusInfo.status).toBe(
                AutomationStatus.IN_PROGRESS,
            );
        });

        it('accumulates onto an existing list without duplicating entries', () => {
            const ctx = baseContext();
            ctx.statusInfo.skipStages = ['StageB'];

            const result = stage.callSkipStages(ctx, ['StageB', 'StageC']);

            expect(result.statusInfo.skipStages).toEqual(['StageB', 'StageC']);
        });

        it('attaches the optional message when provided', () => {
            const result = stage.callSkipStages(
                baseContext(),
                'StageB',
                'directory opts out of this stage',
            );

            expect(result.statusInfo.message).toBe(
                'directory opts out of this stage',
            );
        });

        it('returns a new object without mutating the input', () => {
            const ctx = baseContext();
            const result = stage.callSkipStages(ctx, 'StageB');

            expect(result).not.toBe(ctx);
            expect(ctx.statusInfo.skipStages).toBeUndefined();
        });
    });
});
