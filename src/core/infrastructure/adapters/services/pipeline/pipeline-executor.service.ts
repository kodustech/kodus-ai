import { v4 as uuid } from 'uuid';
import {
    PipelineContext,
    PipelineStatus,
} from './interfaces/pipeline-context.interface';
import { PipelineStage } from './interfaces/pipeline.interface';
import { PinoLoggerService } from '../logger/pino.service';

export class PipelineExecutor<TContext extends PipelineContext> {
    constructor(private readonly logger: PinoLoggerService) {}

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

        this.logger.log({
            message: `Starting pipeline: ${pipelineName} (ID: ${pipelineId})`,
            context: PipelineExecutor.name,
            metadata: {
                pipelineId,
                pipelineName,
            },
        });

        for (const stage of stages) {
            if (context.status === PipelineStatus.SKIP) {
                this.logger.log({
                    message: `Pipeline '${pipelineName}' skipped due to SKIP status ${pipelineId}`,
                    context: PipelineExecutor.name,
                    metadata: {
                        pipelineId,
                        pipelineName,
                    },
                });
                break;
            }

            const start = Date.now();

            try {
                context = await stage.execute(context);

                this.logger.log({
                    message: `Stage '${stage.stageName}' completed in ${Date.now() - start}ms: ${pipelineId}`,
                    context: PipelineExecutor.name,
                    metadata: {
                        pipelineId,
                        pipelineName,
                    },
                });
            } catch (error) {
                this.logger.error({
                    message: `Stage '${stage.stageName}' failed: ${error.message}`,
                    context: PipelineExecutor.name,
                    error: error,
                    metadata: {
                        pipelineId,
                        pipelineName,
                    },
                });

                this.logger.warn({
                    message: `Pipeline '${pipelineName}:${pipelineId}' continuing despite error in stage '${stage.stageName}'`,
                    context: PipelineExecutor.name,
                    metadata: {
                        pipelineId,
                        pipelineName,
                    },
                });
            }
        }

        this.logger.log({
            message: `Finished pipeline: ${pipelineName} (ID: ${pipelineId})`,
            context: PipelineExecutor.name,
            metadata: {
                pipelineId,
                pipelineName,
            },
        });

        return context;
    }
}
