import { forwardRef, Module } from '@nestjs/common';

import { CodebaseModule } from '@libs/code-review/modules/codebase.module';
import { FILE_REVIEW_CONTEXT_PREPARATION_PROVIDER } from '@libs/core/providers/file-analyzer.provider.ee';
import { FILE_REVIEW_CONTEXT_PREPARATION_TOKEN } from '@libs/core/domain/interfaces/file-review-context-preparation.interface';
import { FileReviewContextPreparation } from './file-review-context-preparation.service';
import { FileReviewContextPreparation as CoreFileReviewContextPreparation } from '@libs/code-review/infrastructure/adapters/services/code-analysis/file/noop-file-review.service';

@Module({
    imports: [
        forwardRef(() => CodebaseModule),
    ],
    providers: [
        FileReviewContextPreparation, // Core implementation
        CoreFileReviewContextPreparation,
        FILE_REVIEW_CONTEXT_PREPARATION_PROVIDER,
    ],
    exports: [
        FILE_REVIEW_CONTEXT_PREPARATION_TOKEN,
        FileReviewContextPreparation,
    ],
})
export class FileReviewModule {}
