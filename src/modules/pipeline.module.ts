/**
 * @license
 * Kodus Tech. All rights reserved.
 */
import { Module } from '@nestjs/common';
import { PipelineFactory } from '@/core/infrastructure/adapters/services/pipeline/pipeline-factory.service';
import { pipelineProvider } from '@/core/infrastructure/providers/pipeline.provider.ee';
import { codeReviewPipelineProvider } from '@/core/infrastructure/providers/code-review-pipeline.provider.ee';
import { CodeReviewPipelineModule } from './codeReviewPipeline.module';

@Module({
    imports: [
        CodeReviewPipelineModule,
    ],
    providers: [
        PipelineFactory,
        pipelineProvider,
        codeReviewPipelineProvider,
    ],
    exports: [
        pipelineProvider,
    ],
})
export class PipelineModule {}
