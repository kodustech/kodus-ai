import { PipelineContext } from './pipeline-context.interface';
import { StageVisibility } from '../enums/stage-visibility.enum';

export interface PipelineStage<TContext extends PipelineContext> {
    stageName: string;
    label?: string;
    visibility: StageVisibility;
    /**
     * When true, the executor runs the stage but does NOT fire per-stage
     * observer events (onStageStart / onStageFinish / onStageSkipped /
     * onStageError). Used for internal decision-making stages that
     * should be invisible in the UI/timeline. Pipeline-level events
     * (onPipelineStart / onPipelineFinish) still fire.
     */
    silent?: boolean;
    execute(context: TContext): Promise<TContext>;
}

export interface IPipeline<TContext extends PipelineContext> {
    pipeLineName: string;
    execute(context: TContext): Promise<TContext>;
}
