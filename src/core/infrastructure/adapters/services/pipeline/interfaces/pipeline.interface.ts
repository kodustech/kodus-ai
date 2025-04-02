import { PipelineContext } from './pipeline-context.interface';

export interface PipelineStage<TContext extends PipelineContext> {
    stageName: string;
    execute(context: TContext): Promise<TContext>;
}

export interface IPipeline<TContext extends PipelineContext> {
    pipeLineName: string;
    execute(context: TContext): Promise<TContext>;
}
