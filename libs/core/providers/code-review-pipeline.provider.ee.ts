/**
 * @license
 * Kodus Tech. All rights reserved.
 */
import { CodeReviewPipelineContext } from '@libs/code-review/pipeline/context/code-review-pipeline.context';
import { CodeReviewPipelineObserver } from '@libs/code-review/infrastructure/observers/code-review-pipeline.observer';
import { CodeReviewPipelineStrategy } from '@libs/code-review/pipeline/strategy/code-review-pipeline.strategy';
import { IPipeline } from '@libs/core/infrastructure/pipeline/interfaces/pipeline.interface';
import { PipelineExecutor } from '@libs/core/infrastructure/pipeline/services/pipeline-executor.service';
import { Provider } from '@nestjs/common';
import { createLogger } from '@libs/core/log/logger';

export const CODE_REVIEW_PIPELINE_TOKEN = 'CODE_REVIEW_PIPELINE';

const logger = createLogger('codeReviewPipelineProvider');

/**
 * Provider for the code review pipeline. The agent engine is the only engine
 * now (the former agent-vs-EE selection gate was removed), so this provider
 * simply executes the single strategy.
 */
export const codeReviewPipelineProvider: Provider = {
    provide: CODE_REVIEW_PIPELINE_TOKEN,
    useFactory: (
        strategy: CodeReviewPipelineStrategy,
        observer: CodeReviewPipelineObserver,
    ): IPipeline<CodeReviewPipelineContext> => {
        logger.log({
            message:
                'Pipeline provider initialized with unified CodeReviewPipeline strategy',
            context: 'CodeReviewPipelineProvider',
        });

        return {
            pipeLineName: 'CodeReviewPipeline',
            execute: async (
                context: CodeReviewPipelineContext,
            ): Promise<CodeReviewPipelineContext> => {
                const stages = strategy.configureStages();
                const executor = new PipelineExecutor();
                return (await executor.execute(
                    context,
                    stages,
                    strategy.getPipelineName(),
                    undefined,
                    undefined,
                    [observer],
                )) as CodeReviewPipelineContext;
            },
        };
    },
    inject: [CodeReviewPipelineStrategy, CodeReviewPipelineObserver],
};
