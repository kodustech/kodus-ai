/**
 * @license
 * Kodus Tech. All rights reserved.
 */
import { Provider } from '@nestjs/common';
import { PipelineFactory } from '../adapters/services/pipeline/pipeline-factory.service';
import { IPipeline } from '../adapters/services/pipeline/interfaces/pipeline.interface';
import { PipelineContext } from '../adapters/services/pipeline/interfaces/pipeline-context.interface';
import { CODE_REVIEW_PIPELINE_TOKEN } from './code-review-pipeline.provider.ee';
import { CodeReviewPipelineContext } from '../adapters/services/codeBase/codeReviewPipeline/context/code-review-pipeline.context';
import { PinoLoggerService } from '../adapters/services/logger/pino.service';

export const PIPELINE_PROVIDER_TOKEN = 'PIPELINE_PROVIDER';

export const pipelineProvider: Provider = {
    provide: PIPELINE_PROVIDER_TOKEN,
    useFactory: (
        codeReviewPipeline: IPipeline<CodeReviewPipelineContext>,
        logger: PinoLoggerService,
    ): PipelineFactory<PipelineContext> => {
        const factory = new PipelineFactory<PipelineContext>([codeReviewPipeline]);
        return factory;
    },
    inject: [
        CODE_REVIEW_PIPELINE_TOKEN,
        PinoLoggerService,
    ],
};
