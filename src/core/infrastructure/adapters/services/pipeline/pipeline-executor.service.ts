import { v4 as uuid } from 'uuid';
import { LoggerService } from '@nestjs/common';
import {
    PipelineContext,
    PipelineError,
    PipelineStatus,
} from './interfaces/pipeline-context.interface';
import { IPipeline, PipelineStage } from './interfaces/pipeline.interface';

export class PipelineExecutor<TContext extends PipelineContext> {
    constructor(private readonly logger: LoggerService) {}

    async execute(
        context: TContext,
        stages: PipelineStage<TContext>[],
        pipelineName = 'UnnamedPipeline',
        parentPipelineId?: string,
        rootPipelineId?: string,
    ): Promise<TContext> {
        const pipelineId = uuid();

        context.pipelineMetadata = {
            ...(context.pipelineMetadata || {}),
            pipelineId,
            parentPipelineId,
            rootPipelineId: rootPipelineId || pipelineId,
            pipelineName,
        };

        this.logger.log(
            `🚀 Starting pipeline: ${pipelineName} (ID: ${pipelineId})`,
        );

        for (const stage of stages) {
            if (context.status === PipelineStatus.SKIP) {
                break;
            }

            const start = Date.now();

            try {
                context = await stage.execute(context);
                this.logger.log(
                    `✅ Stage '${stage.stageName}' completed in ${Date.now() - start}ms`,
                );
            } catch (error) {
                this.logger.error(
                    `❌ Stage '${stage.stageName}' failed: ${error.message}`,
                    { error },
                );

                // Não relançamos o erro para permitir que o pipeline continue
                // mesmo quando um estágio falha
                this.logger.warn(
                    `⚠️ Pipeline '${pipelineName}' continuing despite error in stage '${stage.stageName}'`,
                );
            }
        }

        this.logger.log(
            `🏁 Finished pipeline: ${pipelineName} (ID: ${pipelineId})`,
        );

        return context;
    }
}
