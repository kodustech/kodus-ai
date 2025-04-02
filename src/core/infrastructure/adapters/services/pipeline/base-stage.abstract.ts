import { produce } from 'immer';
import { PipelineContext } from './interfaces/pipeline-context.interface';
import { PipelineExecutor } from './pipeline-executor.service';
import { PipelineStage } from './interfaces/pipeline.interface';

export abstract class BasePipelineStage<TContext extends PipelineContext>
    implements PipelineStage<TContext> {
    abstract stageName: string;

    async execute(context: TContext): Promise<TContext> {
        try {
            return await this.executeStage(context);
        } catch (error) {
            throw error;
        }
    }

    protected abstract executeStage(context: TContext): Promise<TContext>;

    protected updateContext(
        context: TContext,
        updater: (draft: TContext) => void,
    ): TContext {
        return produce(context, updater);
    }

    protected async executeSubPipeline<TSubContext extends PipelineContext>(
        subContext: TSubContext,
        stages: PipelineStage<TSubContext>[],
        pipelineName: string,
        pipelineExecutor: PipelineExecutor<TSubContext>,
    ): Promise<TSubContext> {
        try {
            return await pipelineExecutor.execute(
                subContext,
                stages,
                pipelineName,
                subContext.pipelineMetadata?.parentPipelineId,
                subContext.pipelineMetadata?.rootPipelineId,
            );
        } catch (error) {
            subContext?.errors?.push({
                pipelineId: subContext?.pipelineMetadata?.pipelineId,
                stage: this.stageName,
                substage: pipelineName,
                error,
            });
            throw error;
        }
    }
}
