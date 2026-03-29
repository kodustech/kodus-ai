/**
 * @license
 * © Kodus Tech. All rights reserved.
 */
import { Provider } from '@nestjs/common';
import {
    FILE_REVIEW_CONTEXT_PREPARATION_TOKEN,
    IFileReviewContextPreparation,
} from '@libs/core/domain/interfaces/file-review-context-preparation.interface';
import { FileReviewContextPreparation as CoreFileReviewContextPreparation } from '@libs/code-review/infrastructure/adapters/services/code-analysis/file/noop-file-review.service';
import { FileReviewContextPreparation } from '@libs/ee/codeReview/fileReviewContextPreparation/file-review-context-preparation.service';
import { LLM_ANALYSIS_SERVICE_TOKEN } from '@libs/code-review/infrastructure/adapters/services/llmAnalysis.service';
import { IAIAnalysisService } from '@libs/code-review/domain/contracts/AIAnalysisService.contract';

export const FILE_REVIEW_CONTEXT_PREPARATION_PROVIDER: Provider = {
    provide: FILE_REVIEW_CONTEXT_PREPARATION_TOKEN,
    useFactory: (
        corePreparation: CoreFileReviewContextPreparation,
        aiAnalysisService: IAIAnalysisService,
    ): IFileReviewContextPreparation => {
        // Always use EE implementation — self-hosted uses BYOK keys for LLM calls
        return new FileReviewContextPreparation(aiAnalysisService);
    },
    inject: [CoreFileReviewContextPreparation, LLM_ANALYSIS_SERVICE_TOKEN],
};
