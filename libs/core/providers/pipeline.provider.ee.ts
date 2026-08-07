/**
 * @license
 * Kodus Tech. All rights reserved.
 */
import { CodeReviewPipelineContext } from '@libs/code-review/pipeline/context/code-review-pipeline.context';
import { PipelineContext } from '@libs/core/infrastructure/pipeline/interfaces/pipeline-context.interface';
import { IPipeline } from '@libs/core/infrastructure/pipeline/interfaces/pipeline.interface';
import { Provider } from '@nestjs/common';
import { CODE_REVIEW_PIPELINE_TOKEN } from './code-review-pipeline.provider.ee';
import { PipelineFactory } from '../infrastructure/pipeline/services/pipeline-factory.service';

export const PIPELINE_PROVIDER_TOKEN = 'PIPELINE_PROVIDER';

export const pipelineProvider: Provider = {
    provide: PIPELINE_PROVIDER_TOKEN,
    useFactory: (
        codeReviewPipeline: IPipeline<CodeReviewPipelineContext>,
    ): PipelineFactory<PipelineContext> => {
        const factory = new PipelineFactory<PipelineContext>([
            codeReviewPipeline,
        ]);
        return factory;
    },
    inject: [CODE_REVIEW_PIPELINE_TOKEN],
};
