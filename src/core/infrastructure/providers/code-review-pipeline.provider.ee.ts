/**
 * @license
 * Kodus Tech. All rights reserved.
 */
import { Provider } from '@nestjs/common';
import { IPipeline } from '../adapters/services/pipeline/interfaces/pipeline.interface';
import { CodeReviewPipelineStrategy } from '../adapters/services/codeBase/codeReviewPipeline/strategies/code-review-pipeline.strategy';
import { CodeReviewPipelineStrategyEE } from '@/ee/codeReview/strategies/code-review-pipeline.strategy.ee';
import { CodeReviewPipelineContext } from '../adapters/services/codeBase/codeReviewPipeline/context/code-review-pipeline.context';
import { PipelineExecutor } from '../adapters/services/pipeline/pipeline-executor.service';
import { PinoLoggerService } from '../adapters/services/logger/pino.service';
import { environment } from '@/ee/configs/environment';

export const CODE_REVIEW_PIPELINE_TOKEN = 'CODE_REVIEW_PIPELINE';

export const codeReviewPipelineProvider: Provider = {
    provide: CODE_REVIEW_PIPELINE_TOKEN,
    useFactory: (
        ceStrategy: CodeReviewPipelineStrategy,
        eeStrategy: CodeReviewPipelineStrategyEE,
        logger: PinoLoggerService,
    ): IPipeline<CodeReviewPipelineContext> => {
        const isCloud = environment.API_CLOUD_MODE;
        const strategy = isCloud ? eeStrategy : ceStrategy;

        logger.log({
            message: `🔁 Modo de execução: ${isCloud ? 'Cloud (EE)' : 'Self-Hosted (CE)'}`,
            context: 'CodeReviewPipelineProvider',
            metadata: {
                mode: isCloud ? 'cloud' : 'selfhosted',
            },
        });

        return {
            pipeLineName: 'CodeReviewPipeline',
            execute: async (
                context: CodeReviewPipelineContext,
            ): Promise<CodeReviewPipelineContext> => {
                const stages = strategy.configureStages();
                const executor = new PipelineExecutor(logger);
                return (await executor.execute(
                    context,
                    stages,
                    strategy.getPipelineName(),
                )) as CodeReviewPipelineContext;
            },
        };
    },
    inject: [
        CodeReviewPipelineStrategy,
        CodeReviewPipelineStrategyEE,
        PinoLoggerService,
    ],
};
