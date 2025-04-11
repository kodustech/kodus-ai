import { forwardRef, Module } from '@nestjs/common';
import { FileReviewContextPreparation } from '@/core/infrastructure/adapters/services/fileReviewContextPreparation/file-review-context-preparation.service';
import { FILE_REVIEW_CONTEXT_PREPARATION_TOKEN } from '@/shared/interfaces/file-review-context-preparation.interface';
import { FILE_REVIEW_CONTEXT_PREPARATION_PROVIDER } from '@/core/infrastructure/providers/file-analyzer.provider.ee';
import { CodebaseModule } from '@/modules/codeBase.module';
import { LogModule } from '@/modules/log.module';

@Module({
    imports: [forwardRef(() => CodebaseModule), LogModule],
    providers: [
        FileReviewContextPreparation, // Core implementation
        FILE_REVIEW_CONTEXT_PREPARATION_PROVIDER,
    ],
    exports: [
        FILE_REVIEW_CONTEXT_PREPARATION_TOKEN,
        FileReviewContextPreparation,
    ],
})
export class FileReviewModule {}
