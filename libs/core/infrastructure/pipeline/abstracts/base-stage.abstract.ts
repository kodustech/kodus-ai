import { produce } from 'immer';
import { AutomationStatus } from '@libs/automation/domain/automation/enum/automation-status';
import {
    PipelineContext,
    PipelineErrorSeverity,
} from '../interfaces/pipeline-context.interface';
import { PipelineStage } from '../interfaces/pipeline.interface';
import { PipelineExecutor } from '../services/pipeline-executor.service';
import { StageVisibility } from '../enums/stage-visibility.enum';

export abstract class BasePipelineStage<
    TContext extends PipelineContext,
> implements PipelineStage<TContext> {
    abstract stageName: string;
    label?: string;
    visibility: StageVisibility = StageVisibility.SECONDARY;

    /**
     * When true, the executor runs the stage but does NOT fire per-stage
     * observer events — the stage is invisible in the UI/timeline.
     * Use for internal decision-making stages (engine selection, etc.).
     */
    silent: boolean = false;

    /**
     * How a thrown error in this stage contributes to the pipeline's final
     * conclusion. Default 'critical' preserves historical behavior. Stages
     * whose failure should not red-flag the whole review should override to
     * 'partial' (e.g. business-logic validation, summary, PR-level comments).
     * See PipelineErrorSeverity for the semantics.
     */
    errorSeverity: PipelineErrorSeverity = 'critical';

    async execute(context: TContext): Promise<TContext> {
        return await this.executeStage(context);
    }

    protected abstract executeStage(context: TContext): Promise<TContext>;

    protected updateContext(
        context: TContext,
        updater: (draft: TContext) => void,
    ): TContext {
        return produce(context, updater);
    }

    /**
     * Signals the executor to fast-forward past intermediate stages and
     * resume at `targetStageName`. Stages between this one and the target
     * are bypassed; the named target then runs normally.
     */
    protected skipToStage(
        context: TContext,
        targetStageName: string,
        message?: string,
    ): TContext {
        return produce(context, (draft) => {
            draft.statusInfo.status = AutomationStatus.SKIPPED;
            draft.statusInfo.jumpToStage = targetStageName;
            if (message !== undefined) {
                draft.statusInfo.message = message;
            }
        });
    }

    /**
     * Adds one or more stage names to `statusInfo.skipStages` so the
     * executor bypasses those specific stages when reached. The rest of
     * the pipeline runs normally — status stays IN_PROGRESS. Existing
     * entries are preserved; duplicates are de-duped.
     */
    protected skipStages(
        context: TContext,
        names: string | readonly string[],
        message?: string,
    ): TContext {
        const incoming: readonly string[] =
            typeof names === 'string' ? [names] : names;
        return produce(context, (draft) => {
            const mergedSet = new Set(draft.statusInfo.skipStages ?? []);
            for (const name of incoming) {
                mergedSet.add(name);
            }
            draft.statusInfo.skipStages = Array.from(mergedSet);
            if (message !== undefined) {
                draft.statusInfo.message = message;
            }
        });
    }

    /**
     * Signals the executor to abort the pipeline — no further stages run.
     * Clears any prior `jumpToStage` so a stale target cannot be picked up.
     */
    protected stopPipeline(context: TContext, message?: string): TContext {
        return produce(context, (draft) => {
            draft.statusInfo.status = AutomationStatus.SKIPPED;
            draft.statusInfo.jumpToStage = undefined;
            if (message !== undefined) {
                draft.statusInfo.message = message;
            }
        });
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
