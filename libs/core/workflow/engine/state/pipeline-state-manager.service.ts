import { createLogger } from '@libs/core/log/logger';
import { Injectable, Inject } from '@nestjs/common';
import { PipelineContext } from '@libs/core/infrastructure/pipeline/interfaces/pipeline-context.interface';
import {
    WORKFLOW_JOB_REPOSITORY_TOKEN,
    IWorkflowJobRepository,
} from '../../domain/contracts/workflow-job.repository.contract';

/**
 * Generic PipelineStateManager
 * Manages state persistence for any pipeline type
 */
@Injectable()
export class PipelineStateManager {
    private readonly logger = createLogger(PipelineStateManager.name);

    constructor(
        @Inject(WORKFLOW_JOB_REPOSITORY_TOKEN)
        private readonly jobRepository: IWorkflowJobRepository,
    ) {}

    /**
     * Save pipeline state to database
     */
    async saveState<T extends PipelineContext>(
        workflowJobId: string,
        context: T,
        currentStage: string,
    ): Promise<void> {
        try {
            await this.jobRepository.update(workflowJobId, {
                pipelineState: {
                    context,
                    currentStage,
                    updatedAt: new Date(),
                },
            });

            this.logger.debug({
                message: `Pipeline state saved for job ${workflowJobId}`,
                context: PipelineStateManager.name,
                metadata: {
                    workflowJobId,
                    currentStage,
                },
            });
        } catch (error) {
            this.logger.error({
                message: `Failed to save pipeline state for job ${workflowJobId}`,
                context: PipelineStateManager.name,
                error: error instanceof Error ? error : undefined,
                metadata: {
                    workflowJobId,
                    currentStage,
                },
            });
            throw error;
        }
    }

    /**
     * Load pipeline state from database
     */
    async loadState<T extends PipelineContext>(
        workflowJobId: string,
    ): Promise<{ context: T; currentStage: string } | null> {
        const job = await this.jobRepository.findOne(workflowJobId);

        if (!job || !job.pipelineState) {
            return null;
        }

        return {
            context: job.pipelineState.context as T,
            currentStage: job.pipelineState.currentStage,
        };
    }

    /**
     * Clear pipeline state (on completion)
     */
    async clearState(workflowJobId: string): Promise<void> {
        await this.jobRepository.update(workflowJobId, {
            pipelineState: null,
        });
    }
}
